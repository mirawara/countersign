import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createStrictWorkspaceChanges, StrictWorkspace } from "../src/context/strictWorkspace";
import { StrictClock } from "../src/orchestrator/strictBudget";
import {
  runStrictImplementationPhase, StrictImplementationPhaseResult, StrictLifecycleMarker, StrictPauseGate,
} from "../src/orchestrator/strictImplementationPhase";
import {
  StrictFinalApprovalRequest, StrictImplementationProvider, StrictImplementationRequest, StrictPhaseBReply,
  StrictProviderError, StrictReviewProvider, StrictReviewRequest, StrictSessionCapability, StrictSessionKind,
} from "../src/orchestrator/strictProviders";
import { canonicalizeStrictPlan } from "../src/orchestrator/strictPlanHash";
import {
  STRICT_PLAN_SCHEMA_VERSION, STRICT_RESPONSE_SCHEMA_VERSION, StrictHumanApproval, StrictPlan, StrictPlanRecord,
} from "../src/shared/strict";
import { resolveStrictLimits, StrictLimitOverrides } from "../src/shared/strictLimits";
import { CheckResult, LocalCheck, StrictWorkflowEvent } from "../src/shared/types";

const folders: string[] = [];
// Each harness pins its root with an open directory descriptor. Closing the workspace is
// the product's own release path; without it Node reports the handles as collected late.
const workspaces: { close: () => Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((workspace) => workspace.close().catch(() => undefined)));
  await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })));
});

const PLAN: StrictPlan = {
  schemaVersion: STRICT_PLAN_SCHEMA_VERSION,
  objective: "Add the parser",
  constraints: ["No new dependency"],
  acceptanceCriteria: ["Unit tests pass"],
  expectedFiles: ["src.ts"],
  expectedFilesComplete: true,
  risks: ["Wide rewrite"],
  checks: ["lint"],
  questions: [],
};

function planRecord(plan: StrictPlan = PLAN): StrictPlanRecord {
  const canonical = canonicalizeStrictPlan(plan);
  return {
    hash: canonical.hash, schemaVersion: 1, canonicalBytes: canonical.bytes, revision: 1,
    source: "initial", createdAt: "2026-10-22T09:10:00.000Z", plan: canonical.plan,
  };
}

const APPROVAL: StrictHumanApproval = {
  approved: true, planHash: planRecord().hash, decidedAt: "2026-10-22T09:15:00.000Z",
  executionPermission: "askBeforeChange",
};

function implementJson(summary: string, decisions: { findingId: string; decision: "fixed" | "disputed"; rationale: string }[] = []): StrictPhaseBReply {
  return {
    raw: JSON.stringify({
      schemaVersion: STRICT_RESPONSE_SCHEMA_VERSION, provider: "claude", summary, findingDecisions: decisions,
    }),
    metrics: { inputTokens: 10, outputTokens: 20 },
  };
}

function reviewJson(
  provider: "codex" | "claude",
  digest: string,
  decision: "approve" | "reject" | "revise",
  findings: { id: string; file: string; blocking: boolean }[] = [],
  summary = `${decision} from the fake ${provider}`,
): StrictPhaseBReply {
  return {
    raw: JSON.stringify({
      schemaVersion: STRICT_RESPONSE_SCHEMA_VERSION,
      provider,
      snapshotDigest: digest,
      decision,
      findings: findings.map((finding) => ({
        id: finding.id, severity: "High", file: finding.file, line: 1,
        evidence: "line 1 of the diff", summary: "Problem found", blocking: finding.blocking,
      })),
      summary,
    }),
    metrics: { inputTokens: 5, outputTokens: 5 },
  };
}

type ImplementScript = (request: StrictImplementationRequest, call: number) => Promise<StrictPhaseBReply> | StrictPhaseBReply;
type ApproveScript = (request: StrictFinalApprovalRequest, call: number) => Promise<StrictPhaseBReply> | StrictPhaseBReply;
type ReviewScript = (request: StrictReviewRequest, call: number) => Promise<StrictPhaseBReply> | StrictPhaseBReply;

class FakeClaude implements StrictImplementationProvider {
  readonly id = "claude-fake";
  readonly kind = "claude" as const;
  readonly implementCalls: StrictImplementationRequest[] = [];
  readonly approveCalls: StrictFinalApprovalRequest[] = [];

  constructor(
    private readonly implementScript: ImplementScript,
    private readonly approveScript: ApproveScript,
    private readonly capability: Partial<StrictSessionCapability> = {},
  ) {}

  async checkSessionCapability(kind: StrictSessionKind): Promise<StrictSessionCapability> {
    return {
      available: true, freshContext: true, readOnlySandbox: kind !== "implementation",
      providerVersion: "claude-1.0", sessionId: `claude-${kind}`, ...this.capability,
    };
  }

  async implement(request: StrictImplementationRequest): Promise<StrictPhaseBReply> {
    this.implementCalls.push(request);
    return this.implementScript(request, this.implementCalls.length);
  }

  async approveSnapshot(request: StrictFinalApprovalRequest): Promise<StrictPhaseBReply> {
    this.approveCalls.push(request);
    return this.approveScript(request, this.approveCalls.length);
  }

  async cancel(): Promise<void> {}
}

class FakeCodex implements StrictReviewProvider {
  readonly id = "codex-fake";
  readonly kind = "codex" as const;
  readonly calls: StrictReviewRequest[] = [];

  constructor(private readonly script: ReviewScript, private readonly capability: Partial<StrictSessionCapability> = {}) {}

  async checkSessionCapability(kind: StrictSessionKind): Promise<StrictSessionCapability> {
    return {
      available: true, freshContext: true, readOnlySandbox: true,
      providerVersion: "codex-1.0", sessionId: `codex-${kind}`, ...this.capability,
    };
  }

  async review(request: StrictReviewRequest): Promise<StrictPhaseBReply> {
    this.calls.push(request);
    return this.script(request, this.calls.length);
  }

  async cancel(): Promise<void> {}
}

class FakeMarker implements StrictLifecycleMarker {
  readonly events: string[] = [];

  async markActive(taskId: string): Promise<void> {
    this.events.push(`active:${taskId}`);
  }

  async markFinished(taskId: string): Promise<boolean> {
    this.events.push(`finished:${taskId}`);
    return true;
  }

  async markInterrupted(taskId: string): Promise<boolean> {
    this.events.push(`interrupted:${taskId}`);
    return true;
  }
}

class FakeClock implements StrictClock {
  private monotonic = 0;
  private calendar = Date.parse("2026-10-22T09:20:00.000Z");

  monotonicMs(): number {
    return this.monotonic;
  }

  calendarMs(): number {
    return this.calendar;
  }

  advance(ms: number): void {
    this.monotonic += ms;
    this.calendar += ms;
  }
}

interface Harness {
  root: string;
  workspace: StrictWorkspace;
  claude: FakeClaude;
  codex: FakeCodex;
  marker: FakeMarker;
  events: StrictWorkflowEvent[];
  pauseCalls: number;
  run(): Promise<StrictImplementationPhaseResult>;
}

async function harness(options: {
  implement: ImplementScript;
  approve?: ApproveScript;
  review?: ReviewScript;
  checks?: (call: number) => Promise<CheckResult[]> | CheckResult[];
  localChecks?: LocalCheck[];
  limits?: StrictLimitOverrides;
  plan?: StrictPlan;
  declaredGeneratedOutputs?: string[];
  capability?: { claude?: Partial<StrictSessionCapability>; codex?: Partial<StrictSessionCapability> };
  pause?: "resume" | "stop";
  onPause?: () => void;
  controller?: AbortController;
  clock?: FakeClock;
  seed?: (root: string) => Promise<void>;
  contentBudgetBytes?: number;
}): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "countersign-phaseb-"));
  folders.push(root);
  await writeFile(join(root, "src.ts"), "export const value = 1;\n");
  await options.seed?.(root);
  const limits = resolveStrictLimits(options.limits);
  const created = await createStrictWorkspaceChanges({
    folder: root, limits, ...(options.contentBudgetBytes === undefined ? {} : { contentBudgetBytes: options.contentBudgetBytes }),
  });
  if (!created.ok) throw new Error(`baseline failed: ${created.failure.message}`);
  workspaces.push(created.workspace);

  const claude = new FakeClaude(
    options.implement,
    options.approve ?? ((request) => reviewJson("claude", request.snapshotDigest, "approve")),
    options.capability?.claude,
  );
  const codex = new FakeCodex(
    options.review ?? ((request) => reviewJson("codex", request.snapshotDigest, "approve")),
    options.capability?.codex,
  );
  const marker = new FakeMarker();
  const events: StrictWorkflowEvent[] = [];
  const result: Harness = {
    root,
    workspace: created.workspace,
    claude,
    codex,
    marker,
    events,
    pauseCalls: 0,
    run: () => runStrictImplementationPhase({
      taskId: "task-b",
      repository: root,
      workingDirectory: root,
      task: "Add the parser",
      approvedPlan: planRecord(options.plan ?? PLAN),
      humanApproval: APPROVAL,
      limits,
      localChecks: options.localChecks ?? [],
      declaredGeneratedOutputs: options.declaredGeneratedOutputs ?? [],
      workspace: created.workspace,
      claude,
      codex,
      runChecks: (() => {
        let call = 0;
        return async () => {
          call += 1;
          return options.checks ? options.checks(call) : [];
        };
      })(),
      preExistingEntries: [],
      pause: pauseGate(options.pause ?? "stop", () => {
        result.pauseCalls += 1;
        options.onPause?.();
      }),
      marker,
      signal: (options.controller ?? new AbortController()).signal,
      onEvent: (event) => events.push(event),
      clock: options.clock ?? new FakeClock(),
    }),
  };
  return result;
}

function pauseGate(choice: "resume" | "stop", onCall: () => void): StrictPauseGate {
  return {
    onPause: async () => {
      onCall();
      return choice;
    },
  };
}

function check(id: string, passed: boolean): CheckResult {
  return { id, passed, exitCode: passed ? 0 : 1, output: passed ? "" : `${id} failed on line 1`, timedOut: false };
}

describe("Strict phase B: implementation, review and final consensus", () => {
  it("completes clean only with both approvals bound to the final digest", async () => {
    const test = await harness({
      implement: async (_request, call) => {
        if (call === 1) await writeFile(join(test.root, "src.ts"), "export const value = 2;\n");
        return implementJson("Changed the value.");
      },
      localChecks: [{ id: "lint", executable: "true", args: [] }],
      checks: () => [check("lint", true)],
    });
    const result = await test.run();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const digest = result.snapshots.at(-1)?.digest;
    expect(result.finalConsensus.hash).toBe(digest);
    expect(result.finalConsensus.approvals.map((approval) => `${approval.provider}:${approval.decision}`))
      .toEqual(["codex:approve", "claude:approve"]);
    expect(result.finalConsensus.reachedAt).toBeTruthy();
    expect(test.codex.calls[0].snapshotDigest).toBe(digest);
    expect(test.claude.approveCalls[0].snapshotDigest).toBe(digest);
    expect(result.checkRounds[0]).toMatchObject({ round: 1, configured: true, trigger: "after_implementation" });
    expect(result.sessions.map((session) => session.role))
      .toEqual(["implementation_claude", "review_codex", "final_approval_claude"]);
    expect(test.marker.events).toEqual(["active:task-b", "finished:task-b"]);
    expect(test.events.map((event) => event.state)).toEqual(expect.arrayContaining([
      "implementing", "running_checks", "reviewing", "awaiting_final_consensus", "completed_clean",
    ]));
    // This run has a configured check, so the completion may say it passed.
    expect(test.events.at(-1)?.message).toContain("the configured checks passed");
  });

  it("never claims a check passed when none is configured", async () => {
    const test = await harness({
      implement: async () => {
        await writeFile(join(test.root, "src.ts"), "export const value = 2;\n");
        return implementJson("Changed the value.");
      },
    });
    const result = await test.run();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.checkRounds[0]).toMatchObject({ configured: false, results: [] });
    const completion = test.events.at(-1)?.message ?? "";
    expect(completion).toContain("No local check is configured");
    expect(completion).not.toContain("checks passed");
  });

  it("sends a failed check back to Claude and reviews only after the checks pass", async () => {
    const test = await harness({
      implement: async (request, call) => {
        await writeFile(join(test.root, "src.ts"), `export const value = ${call + 1};\n`);
        expect(call === 1 ? request.kind : request.kind).toBe(call === 1 ? "implement" : "correct");
        if (call === 2) expect(request.failedChecks?.[0].id).toBe("lint");
        return implementJson(`Pass ${call}.`);
      },
      localChecks: [{ id: "lint", executable: "true", args: [] }],
      checks: (call) => [check("lint", call > 1)],
    });
    const result = await test.run();

    expect(result.ok).toBe(true);
    expect(result.checkRounds.map((round) => `${round.round}:${round.results[0].passed}`)).toEqual(["1:false", "2:true"]);
    expect(test.codex.calls).toHaveLength(1);
    expect(test.claude.implementCalls).toHaveLength(2);
  });

  it("requires an explicit approval even when a review reports no finding", async () => {
    const test = await harness({
      implement: async () => {
        await writeFile(join(test.root, "src.ts"), "export const value = 2;\n");
        return implementJson("Changed the value.");
      },
      review: (request, call) => call === 1
        ? reviewJson("codex", request.snapshotDigest, "revise", [], "No finding, but I am not approving yet.")
        : reviewJson("codex", request.snapshotDigest, "approve"),
      limits: { "implementationPhase.maxReviewCycles": 3 },
    });
    const result = await test.run();

    expect(result.ok).toBe(true);
    expect(test.codex.calls).toHaveLength(2);
  });

  it("carries a blocking finding back to Claude and records how it was answered", async () => {
    const test = await harness({
      implement: async (request, call) => {
        await writeFile(join(test.root, "src.ts"), `export const value = ${call + 1};\n`);
        if (call === 2) {
          expect(request.findings?.map((finding) => finding.id)).toEqual(["f1"]);
          return implementJson("Fixed it.", [{ findingId: "f1", decision: "fixed", rationale: "Bound corrected." }]);
        }
        return implementJson("First pass.");
      },
      review: (request, call) => call === 1
        ? reviewJson("codex", request.snapshotDigest, "reject", [{ id: "f1", file: "src.ts", blocking: true }])
        : reviewJson("codex", request.snapshotDigest, "approve"),
    });
    const result = await test.run();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.findings).toHaveLength(1);
    expect(result.findings[0]).toMatchObject({ id: "f1", status: "resolved", blocking: true });
    expect(result.findings[0].resolution?.rationale).toBe("Bound corrected.");
  });

  it("voids both approvals when the perimeter changes between them", async () => {
    let mutated = false;
    const test = await harness({
      implement: async (_request, call) => {
        if (call === 1) await writeFile(join(test.root, "src.ts"), "export const value = 2;\n");
        return implementJson("Changed the value.");
      },
      approve: async (request, call) => {
        if (call === 1 && !mutated) {
          mutated = true;
          await writeFile(join(test.root, "src.ts"), "export const value = 3;\n");
        }
        return reviewJson("claude", request.snapshotDigest, "approve");
      },
      limits: { "implementationPhase.maxReviewCycles": 4 },
    });
    const result = await test.run();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // The first digest was approved by Codex and Claude, then the files moved: that pair
    // is void and the second digest had to be checked and reviewed again.
    expect(test.codex.calls).toHaveLength(2);
    expect(result.snapshots).toHaveLength(2);
    expect(result.snapshots[0].digest).not.toBe(result.snapshots[1].digest);
    expect(result.finalConsensus.hash).toBe(result.snapshots[1].digest);
    expect(test.events.some((event) => event.message.includes("are void"))).toBe(true);
  });

  it("re-runs the checks when one of them changes a reviewed file", async () => {
    let runs = 0;
    const test = await harness({
      implement: async () => {
        await writeFile(join(test.root, "src.ts"), "export const value = 2;\n");
        return implementJson("Changed the value.");
      },
      localChecks: [{ id: "format", executable: "true", args: [] }],
      checks: async () => {
        runs += 1;
        // The formatter rewrites a reviewed file on its first run only.
        if (runs === 1) await writeFile(join(test.root, "src.ts"), "export const value = 2; // formatted\n");
        return [check("format", true)];
      },
    });
    const result = await test.run();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(runs).toBe(2);
    // The round records the digest the checks ran against, and the reviewed digest is the
    // one the last, stable round checked.
    expect(result.checkRounds).toHaveLength(2);
    expect(result.checkRounds[0].snapshotDigest).not.toBe(result.checkRounds[1].snapshotDigest);
    expect(result.snapshots[0].digest).toBe(result.checkRounds[1].snapshotDigest);
    expect(result.finalConsensus.hash).toBe(result.checkRounds[1].snapshotDigest);
  });

  it("cannot complete when the checks never leave the perimeter where they found it", async () => {
    let runs = 0;
    const test = await harness({
      implement: async () => {
        await writeFile(join(test.root, "src.ts"), "export const value = 2;\n");
        return implementJson("Changed the value.");
      },
      localChecks: [{ id: "format", executable: "true", args: [] }],
      checks: async () => {
        runs += 1;
        await writeFile(join(test.root, "src.ts"), `export const value = 2; // run ${runs}\n`);
        return [check("format", true)];
      },
      limits: { "implementationPhase.maxReviewCycles": 3 },
    });
    const result = await test.run();

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason.code).toBe("checks_failed");
    expect(test.codex.calls).toHaveLength(0);
  });

  it("stops when the workspace moved between the approval and the first write", async () => {
    const test = await harness({ implement: () => implementJson("unused") });
    // A change landing while the approval was open: the approved plan no longer describes
    // what is on disk, and nothing has been written by the task yet.
    await writeFile(join(test.root, "src.ts"), "export const value = 99;\n");
    const result = await test.run();

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.state).toBe("failed");
    expect(result.reason.code).toBe("workspace_changed");
    expect(test.claude.implementCalls).toHaveLength(0);
  });

  it("keeps a re-reported finding's current details, not the first ones", async () => {
    const test = await harness({
      implement: async (request, call) => {
        await writeFile(join(test.root, "src.ts"), `export const value = ${call + 1};\n`);
        return implementJson(`Pass ${call}.`, (request.findings ?? []).map((finding) => ({
          findingId: finding.id, decision: "fixed" as const, rationale: "Corrected.",
        })));
      },
      review: (request, call) => {
        if (call === 1) {
          return reviewJson("codex", request.snapshotDigest, "reject", [{ id: "f1", file: "src.ts", blocking: true }]);
        }
        if (call === 2) {
          // Same id, different line and severity, and no longer blocking.
          return {
            raw: JSON.stringify({
              schemaVersion: STRICT_RESPONSE_SCHEMA_VERSION, provider: "codex",
              snapshotDigest: request.snapshotDigest, decision: "revise",
              findings: [{ id: "f1", severity: "Low", file: "src.ts", line: 42, evidence: "line 42 now",
                summary: "Naming only", blocking: false }],
              summary: "The blocking issue is gone; a minor one remains.",
            }),
          };
        }
        return reviewJson("codex", request.snapshotDigest, "approve");
      },
      limits: { "implementationPhase.maxReviewCycles": 5 },
    });
    const result = await test.run();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const finding = result.findings.find((entry) => entry.id === "f1");
    expect(finding).toMatchObject({ line: 42, severity: "Low", blocking: false, summary: "Naming only" });
    expect(finding?.evidence).toBe("line 42 now");
  });

  it("ignores a check that writes only into a policy-excluded output", async () => {
    const test = await harness({
      implement: async () => {
        await writeFile(join(test.root, "src.ts"), "export const value = 2;\n");
        return implementJson("Changed the value.");
      },
      localChecks: [{ id: "build", executable: "true", args: [] }],
      checks: async () => {
        await mkdir(join(test.root, "dist"), { recursive: true });
        await writeFile(join(test.root, "dist", "bundle.js"), `generated ${Date.now()}\n`);
        return [check("build", true)];
      },
      declaredGeneratedOutputs: ["dist"],
    });
    const result = await test.run();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.snapshots).toHaveLength(1);
    expect(test.codex.calls).toHaveLength(1);
    expect(result.policyExclusions.some((exclusion) => exclusion.rule === "dependency-and-build-output")).toBe(true);
  });

  it("refuses a declared generated output that is inside the reviewed perimeter", async () => {
    const test = await harness({
      implement: () => implementJson("unused"),
      declaredGeneratedOutputs: ["src/generated"],
    });
    const result = await test.run();

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.state).toBe("failed");
    expect(result.reason.code).toBe("declared_output_not_excluded");
    expect(test.claude.implementCalls).toHaveLength(0);
    expect(test.marker.events).toEqual(["finished:task-b"]);
  });

  it("refuses policy-excluded plan paths but reviews credential files normally", async () => {
    const policy = await harness({
      implement: () => implementJson("unused"),
      plan: { ...PLAN, expectedFiles: ["dist/out.js"] },
    });
    const policyResult = await policy.run();
    expect(policyResult.ok === false && policyResult.reason.code).toBe("policy_path_in_plan");
    expect(policy.claude.implementCalls).toHaveLength(0);

    const credential = await harness({
      seed: async (root) => writeFile(join(root, ".env"), "TOKEN=first\n"),
      implement: async () => {
        await writeFile(join(credential.root, ".env"), "TOKEN=second\n");
        await writeFile(join(credential.root, "src.ts"), "export const value = 2;\n");
        return implementJson("Updated configuration and parser.");
      },
      plan: { ...PLAN, expectedFiles: [".env", "src.ts"] },
    });
    const credentialResult = await credential.run();
    expect(credentialResult.ok).toBe(true);
    if (credentialResult.ok) expect(credentialResult.snapshots[0].entries.map((entry) => entry.path)).toContain(".env");
    expect(credential.codex.calls[0]?.diff).toContain("TOKEN=second");
    expect(policy.events.map((event) => event.message).join("\n")).not.toContain("dist/out.js");
  });

  it("cannot complete when a change is not reviewable", async () => {
    const test = await harness({
      implement: async () => {
        await writeFile(join(test.root, "blob.bin"), Buffer.from([0, 1, 2, 0]));
        return implementJson("Added a binary file.");
      },
    });
    const result = await test.run();

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.state).toBe("review_failed");
    expect(result.reason.code).toBe("unreviewable_change");
    expect(test.codex.calls).toHaveLength(0);
  });

  it("cannot complete when the changed file's bytes were never kept for a diff", async () => {
    const test = await harness({
      // A pool of zero is the exhausted state made deterministic: every file is hashed in
      // full and none of it is kept, exactly as in a workspace larger than the pool.
      contentBudgetBytes: 0,
      implement: async () => {
        await writeFile(join(test.root, "src.ts"), "export const value = 2;\n");
        return implementJson("Changed the value.");
      },
    });
    const result = await test.run();

    expect(result.ok).toBe(false);
    if (result.ok) return;
    // The change was seen — the baseline was never abandoned — and it stops the task short
    // of a clean completion instead of passing as unchanged or as a scan failure.
    expect(result.state).toBe("review_failed");
    expect(result.reason.code).toBe("unreviewable_change");
    expect(result.reason.message).toContain("src.ts (content_not_retained)");
    expect(test.codex.calls).toHaveLength(0);
  });

  it("cannot complete when an unsupported path appears after the final approvals", async () => {
    let planted = false;
    const test = await harness({
      implement: async (_request, call) => {
        if (call === 1) await writeFile(join(test.root, "src.ts"), "export const value = 2;\n");
        return implementJson("Changed the value.");
      },
      approve: async (request) => {
        if (!planted) {
          planted = true;
          // A symlink does not move the digest: the digest covers reviewable changes only.
          await symlink(join(test.root, "src.ts"), join(test.root, "late-link.ts"));
        }
        return reviewJson("claude", request.snapshotDigest, "approve");
      },
    });
    const result = await test.run();

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.state).toBe("review_failed");
    expect(result.reason.code).toBe("unreviewable_change");
    expect(result.reason.message).toContain("late-link.ts");
  });

  it("counts the review cycles the report shows", async () => {
    const test = await harness({
      implement: async (request, call) => {
        await writeFile(join(test.root, "src.ts"), `export const value = ${call + 1};\n`);
        return implementJson(`Pass ${call}.`, (request.findings ?? []).map((finding) => ({
          findingId: finding.id, decision: "fixed" as const, rationale: "Corrected.",
        })));
      },
      review: (request, call) => call === 1
        ? reviewJson("codex", request.snapshotDigest, "reject", [{ id: "f1", file: "src.ts", blocking: true }])
        : reviewJson("codex", request.snapshotDigest, "approve"),
    });
    const result = await test.run();

    expect(result.ok).toBe(true);
    expect(result.budget.reviewCycles).toBe(2);
  });

  it("keeps provider prose out of the event stream", async () => {
    const test = await harness({
      implement: async (request, call) => {
        await writeFile(join(test.root, "src.ts"), `export const value = ${call + 1};\n`);
        return implementJson(`Pass ${call}.`, (request.findings ?? []).map((finding) => ({
          findingId: finding.id, decision: "fixed" as const, rationale: "Corrected.",
        })));
      },
      review: (request, call) => call === 1
        ? reviewJson("codex", request.snapshotDigest, "reject",
          [{ id: "f1", file: "src.ts", blocking: true }], "SECRET_REVIEW_PROSE")
        : reviewJson("codex", request.snapshotDigest, "approve"),
      approve: (request, call) => call === 1
        ? reviewJson("claude", request.snapshotDigest, "reject",
          [{ id: "f2", file: "src.ts", blocking: true }], "SECRET_APPROVAL_PROSE")
        : reviewJson("claude", request.snapshotDigest, "approve"),
      limits: { "implementationPhase.maxReviewCycles": 6 },
    });
    const result = await test.run();

    const events = test.events.map((event) => event.message).join("\n");
    expect(events).not.toContain("SECRET_REVIEW_PROSE");
    expect(events).not.toContain("SECRET_APPROVAL_PROSE");
    // The events still say what happened, without quoting the provider.
    expect(events).toContain("its reasons are in the chat report");
    expect(result.findings.length).toBeGreaterThan(0);
  });

  it("stops at the review cycle ceiling without agreeing", async () => {
    const test = await harness({
      implement: async (request, call) => {
        await writeFile(join(test.root, "src.ts"), `export const value = ${call + 1};\n`);
        return implementJson(`Pass ${call}.`, (request.findings ?? []).map((finding) => ({
          findingId: finding.id, decision: "disputed" as const, rationale: "The reviewer misread the bound.",
        })));
      },
      review: (request, call) => reviewJson("codex", request.snapshotDigest, "reject", [{ id: `f${call}`, file: "src.ts", blocking: true }]),
      limits: { "implementationPhase.maxReviewCycles": 2 },
    });
    const result = await test.run();

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.state).toBe("consensus_not_reached");
    expect(result.reason.code).toBe("limit_reached");
    expect(result.reason.limit).toMatchObject({ limit: "implementationPhase.maxReviewCycles", configured: 2 });
  });

  it("pauses on a stall and stops without success when the pause is not resumed", async () => {
    const test = await harness({
      implement: async (_request, call) => {
        if (call === 1) await writeFile(join(test.root, "src.ts"), "export const value = 2;\n");
        return implementJson(`Pass ${call}: nothing else changed.`);
      },
      localChecks: [{ id: "lint", executable: "true", args: [] }],
      checks: () => [check("lint", false)],
      limits: { "implementationPhase.stallCycles": 2, "implementationPhase.maxReviewCycles": 6 },
      pause: "stop",
    });
    const result = await test.run();

    expect(test.pauseCalls).toBe(1);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.state).toBe("consensus_not_reached");
    expect(result.reason.code).toBe("stall");
    expect(result.pauses[0]).toMatchObject({ reason: "stall", resumable: true });
    expect(test.events.some((event) => event.state === "paused")).toBe(true);
  });

  it("stops the active clock while paused and resumes in the same window", async () => {
    const clock = new FakeClock();
    const test = await harness({
      implement: async (_request, call) => {
        clock.advance(60_000);
        if (call === 1) await writeFile(join(test.root, "src.ts"), "export const value = 2;\n");
        if (call >= 4) await writeFile(join(test.root, "src.ts"), `export const value = ${call};\n`);
        return implementJson(`Pass ${call}.`);
      },
      localChecks: [{ id: "lint", executable: "true", args: [] }],
      checks: (call) => [check("lint", call >= 4)],
      limits: { "implementationPhase.stallCycles": 2, "implementationPhase.maxActiveMinutes": 30 },
      pause: "resume",
      // A pause that lasted hours must not consume the active budget.
      onPause: () => clock.advance(300 * 60_000),
      clock,
    });
    const result = await test.run();

    expect(test.pauseCalls).toBeGreaterThanOrEqual(1);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.pauses[0].resumedAt).toBeTruthy();
    expect(result.budget.activeMs).toBeLessThanOrEqual(10 * 60_000);
    expect(result.budget.wallClockMs).toBeGreaterThan(300 * 60_000);
  });

  it("blocks before any request when Codex cannot prove a read-only sandbox or a new context", async () => {
    const sandbox = await harness({
      implement: () => implementJson("unused"),
      capability: { codex: { readOnlySandbox: false, reason: "No read-only sandbox in this Codex build." } },
    });
    const sandboxResult = await sandbox.run();
    expect(sandboxResult.ok).toBe(false);
    if (!sandboxResult.ok) {
      expect(sandboxResult.state).toBe("blocked_permissions");
      expect(sandboxResult.reason.code).toBe("review_sandbox_not_read_only");
    }
    expect(sandbox.claude.implementCalls).toHaveLength(0);
    expect(sandbox.marker.events).toEqual(["finished:task-b"]);

    const context = await harness({
      implement: () => implementJson("unused"),
      capability: { claude: { freshContext: false } },
    });
    const contextResult = await context.run();
    expect(contextResult.ok === false && contextResult.state).toBe("blocked_provider");
    expect(contextResult.ok === false && contextResult.reason.code).toBe("session_isolation_unverifiable");
  });

  it("reports no_changes instead of a clean completion when nothing was changed", async () => {
    const test = await harness({ implement: () => implementJson("Nothing needed changing.") });
    const result = await test.run();

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.state).toBe("no_changes");
    expect(result.reason.message).toContain("no review and no final approval");
    expect(test.codex.calls).toHaveLength(0);
    expect(test.marker.events).toEqual(["active:task-b", "finished:task-b"]);
  });

  it("marks the task interrupted when it is cancelled mid-flight", async () => {
    const controller = new AbortController();
    const test = await harness({
      implement: async () => {
        controller.abort();
        return new Promise<StrictPhaseBReply>(() => undefined);
      },
      controller,
    });
    const result = await test.run();

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.state).toBe("cancelled");
    expect(test.marker.events).toEqual(["active:task-b", "interrupted:task-b"]);
  });

  it("maps a provider quota failure during review to a blocked outcome", async () => {
    const test = await harness({
      implement: async () => {
        await writeFile(join(test.root, "src.ts"), "export const value = 2;\n");
        return implementJson("Changed the value.");
      },
      review: () => {
        throw new StrictProviderError("quota", "The ChatGPT account has no quota left.", "codex");
      },
    });
    const result = await test.run();

    expect(result.ok === false && result.state).toBe("blocked_auth_or_quota");
    expect(result.ok === false && result.reason.code).toBe("quota_exhausted");
  });
});
