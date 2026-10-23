import { describe, expect, it } from "vitest";
import { StrictClock } from "../src/orchestrator/strictBudget";
import { canonicalizeStrictPlan } from "../src/orchestrator/strictPlanHash";
import {
  runStrictPlanPhase, StrictPlanApprovalDecision, StrictPlanApprovalRequest, StrictPlanHumanGate, StrictPlanPhaseInput,
  StrictPlanPhaseResult,
} from "../src/orchestrator/strictPlanPhase";
import {
  StrictBaselineError, StrictBaselineGuard, StrictPlanningCapability, StrictPlanningProvider, StrictPlanProviderReply,
  StrictPlanRequest, StrictProviderError,
} from "../src/orchestrator/strictProviders";
import {
  STRICT_PLAN_SCHEMA_VERSION, STRICT_RESPONSE_SCHEMA_VERSION, StrictBaselineIdentity, StrictPlan,
} from "../src/shared/strict";
import { resolveStrictLimits, StrictLimitOverrides, StrictLimits } from "../src/shared/strictLimits";
import { ProviderKind, StrictWorkflowEvent } from "../src/shared/types";

const MINUTE = 60_000;

function plan(overrides: Partial<StrictPlan> = {}): StrictPlan {
  return {
    schemaVersion: STRICT_PLAN_SCHEMA_VERSION,
    objective: "Add the parser",
    constraints: ["No new dependency"],
    acceptanceCriteria: ["Unit tests pass"],
    expectedFiles: ["src/a.ts", "src/b.ts"],
    expectedFilesComplete: true,
    risks: ["Wide rewrite"],
    checks: ["lint"],
    questions: [],
    ...overrides,
  };
}

function decision(kind: "approve" | "reject" | "revise", request: StrictPlanRequest, extra: Record<string, unknown> = {}): StrictPlanProviderReply {
  if (request.kind !== "evaluate") throw new Error("decision() needs an evaluation request");
  return {
    raw: JSON.stringify({
      schemaVersion: STRICT_RESPONSE_SCHEMA_VERSION,
      provider: extra.provider ?? requestProvider.get(request),
      planHash: extra.planHash ?? request.planHash,
      decision: kind,
      objections: extra.objections ?? [],
      ...(extra.revisedPlan ? { revisedPlan: extra.revisedPlan } : {}),
      summary: `${kind} from the fake provider`,
    }),
    metrics: { inputTokens: 10, outputTokens: 5 },
  };
}

/** Lets decision() declare the provider that actually received the request. */
const requestProvider = new WeakMap<StrictPlanRequest, ProviderKind>();

type Script = (request: StrictPlanRequest, call: number) => StrictPlanProviderReply | Promise<StrictPlanProviderReply>;

class FakeProvider implements StrictPlanningProvider {
  readonly id: string;
  readonly calls: StrictPlanRequest[] = [];

  constructor(
    readonly kind: ProviderKind,
    private readonly script: Script,
    private readonly capability: Partial<StrictPlanningCapability> = {},
  ) {
    this.id = `${kind}-fake`;
  }

  async checkPlanningCapability(): Promise<StrictPlanningCapability> {
    return {
      available: true, readOnlyToolsEnforced: true, freshContext: true,
      providerVersion: `${this.kind}-1.0`, sessionId: `${this.kind}-session`,
      ...this.capability,
    };
  }

  async request(request: StrictPlanRequest): Promise<StrictPlanProviderReply> {
    this.calls.push(request);
    requestProvider.set(request, this.kind);
    return this.script(request, this.calls.length);
  }

  async cancel(): Promise<void> {}
}

class FakeBaseline implements StrictBaselineGuard {
  changed = false;
  checks = 0;

  identity(): StrictBaselineIdentity {
    return {
      root: "/repo", source: "filesystem_scan", capturedAt: "2026-10-22T09:00:00.000Z",
      digest: "c".repeat(64), entryCount: 10,
    };
  }

  async assertUnchanged(): Promise<void> {
    this.checks += 1;
    if (this.changed) throw new StrictBaselineError("changed", "The workspace changed during planning.");
  }
}

class FakeHuman implements StrictPlanHumanGate {
  readonly approvalRequests: StrictPlanApprovalRequest[] = [];
  readonly questions: string[] = [];

  constructor(
    private readonly answers: (string | undefined)[] = [],
    private readonly decisions: (StrictPlanApprovalDecision | ((request: StrictPlanApprovalRequest) => StrictPlanApprovalDecision))[] = [],
    private readonly onInteraction?: () => void,
  ) {}

  async askQuestion(question: { question: string }): Promise<string | undefined> {
    this.questions.push(question.question);
    this.onInteraction?.();
    return this.answers.shift();
  }

  async requestApproval(request: StrictPlanApprovalRequest): Promise<StrictPlanApprovalDecision> {
    this.approvalRequests.push(request);
    this.onInteraction?.();
    const next = this.decisions.shift();
    if (!next) throw new Error("The test did not script an approval decision.");
    return typeof next === "function" ? next(request) : next;
  }
}

class FakeClock implements StrictClock {
  private monotonic = 0;
  private calendar = Date.parse("2026-10-22T09:00:00.000Z");

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
  claude: FakeProvider;
  codex: FakeProvider;
  human: FakeHuman;
  baseline: FakeBaseline;
  clock: FakeClock;
  events: StrictWorkflowEvent[];
  limits: StrictLimits;
  run(): Promise<StrictPlanPhaseResult>;
}

function harness(options: {
  claude: Script;
  codex?: Script;
  human?: FakeHuman;
  limits?: StrictLimitOverrides;
  capability?: { claude?: Partial<StrictPlanningCapability>; codex?: Partial<StrictPlanningCapability> };
  controller?: AbortController;
  clock?: FakeClock;
  baseline?: FakeBaseline;
}): Harness {
  const clock = options.clock ?? new FakeClock();
  const claude = new FakeProvider("claude", options.claude, options.capability?.claude);
  const codex = new FakeProvider("codex", options.codex ?? ((request) => decision("approve", request)), options.capability?.codex);
  const human = options.human ?? new FakeHuman([], [{ kind: "approve", executionPermission: "askBeforeChange" }]);
  const baseline = options.baseline ?? new FakeBaseline();
  const events: StrictWorkflowEvent[] = [];
  const limits = resolveStrictLimits(options.limits);
  const input: StrictPlanPhaseInput = {
    taskId: "task-1",
    repository: "/repo",
    workingDirectory: "/repo",
    task: "Add the parser",
    authorizedChecks: ["lint", "test"],
    limits,
    claude,
    codex,
    baseline,
    human,
    signal: (options.controller ?? new AbortController()).signal,
    onEvent: (event) => events.push(event),
    clock,
  };
  return { claude, codex, human, baseline, clock, events, limits, run: () => runStrictPlanPhase(input) };
}

function proposal(value: StrictPlan = plan()): StrictPlanProviderReply {
  return { raw: JSON.stringify(value), metrics: { inputTokens: 20, outputTokens: 40 } };
}

describe("Strict phase A: plan consensus", () => {
  it("agrees on one hash and asks the user before anything runs", async () => {
    const test = harness({
      claude: (request, call) => call === 1 ? proposal() : decision("approve", request),
    });
    const result = await test.run();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const hash = canonicalizeStrictPlan(plan()).hash;
    expect(result.approvedPlan.hash).toBe(hash);
    expect(result.consensus.reachedAt).toBeTruthy();
    expect(result.consensus.approvals.map((approval) => `${approval.provider}:${approval.decision}:${approval.hash}`))
      .toEqual([`claude:approve:${hash}`, `codex:approve:${hash}`]);
    expect(result.consensus.openObjections).toEqual([]);
    expect(result.humanApproval).toMatchObject({ approved: true, planHash: hash, executionPermission: "askBeforeChange" });
    expect(result.nextState).toBe("implementing");
    expect(result.budget.providerRequests).toBe(3);
    expect(result.sessions.map((session) => `${session.role}:${session.isolation}`))
      .toEqual(["plan_claude:verified_new_context", "plan_codex:verified_new_context"]);
    expect(result.metrics).toHaveLength(3);
    expect(() => { (result.limits as { maxStructuredRetries: number }).maxStructuredRetries = 99; }).toThrow(TypeError);
    expect(test.events.map((event) => event.state)).toEqual(expect.arrayContaining([
      "planning", "awaiting_consensus", "awaiting_human_approval",
    ]));
    expect(test.events.every((event) => event.mode === "strict" && event.phase === "plan")).toBe(true);
  });

  it("never accepts an approval of another hash", async () => {
    const test = harness({
      claude: (request, call) => call === 1 ? proposal() : decision("approve", request),
      codex: (request) => decision("approve", request, { planHash: "f".repeat(64) }),
    });
    const result = await test.run();

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.state).toBe("consensus_not_reached");
    expect(result.reason.code).toBe("invalid_structured_response");
    // The initial request plus the two allowed retries, all counted against the ceiling.
    expect(test.codex.calls).toHaveLength(3);
    expect(test.human.approvalRequests).toHaveLength(0);
  });

  it("voids both approvals when a provider revises the plan", async () => {
    const revised = plan({ expectedFiles: ["src/a.ts", "src/b.ts", "src/c.ts"] });
    const test = harness({
      claude: (request, call) => call === 1 ? proposal() : decision("approve", request),
      codex: (request, call) => call === 1
        ? decision("revise", request, {
          revisedPlan: revised,
          objections: [{ id: "o1", target: "expected_file", reference: "src/a.ts", summary: "A third file is needed", rationale: "The parser is split in three", blocking: true }],
        })
        : decision("approve", request),
    });
    const result = await test.run();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const revisedHash = canonicalizeStrictPlan(revised).hash;
    expect(result.plans.map((entry) => entry.source)).toEqual(["initial", "provider_revision"]);
    expect(result.approvedPlan.hash).toBe(revisedHash);
    expect(result.consensus.approvals.every((approval) => approval.hash === revisedHash)).toBe(true);
    // Claude had approved the first hash and had to approve the new one again.
    expect(test.claude.calls.map((call) => call.kind)).toEqual(["propose", "evaluate", "evaluate"]);
    expect(test.claude.calls.filter((call): call is Extract<StrictPlanRequest, { kind: "evaluate" }> => call.kind === "evaluate")
      .map((call) => call.planHash)).toEqual([canonicalizeStrictPlan(plan()).hash, revisedHash]);
  });

  it("stops without execution when a provider rejects the plan", async () => {
    const test = harness({
      claude: (request, call) => call === 1 ? proposal() : decision("approve", request),
      codex: (request) => decision("reject", request, {
        objections: [{ id: "o1", target: "objective", summary: "Two tasks in one", rationale: "The objective mixes parsing and formatting", blocking: true }],
      }),
    });
    const result = await test.run();

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.state).toBe("consensus_not_reached");
    expect(result.reason.code).toBe("plan_rejected_by_provider");
    expect(result.consensus?.reachedAt).toBeUndefined();
    expect(test.human.approvalRequests).toHaveLength(0);
  });

  it("cannot succeed while a plan question is unanswered", async () => {
    const test = harness({
      claude: () => proposal(plan({ questions: [{ id: "q1", question: "Which format?" }] })),
      human: new FakeHuman([undefined], []),
    });
    const result = await test.run();

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.state).toBe("cancelled");
    expect(result.reason.code).toBe("plan_question_unanswered");
    expect(test.codex.calls).toHaveLength(0);
    expect(test.human.questions).toEqual(["Which format?"]);
  });

  it("writes a human answer into the plan, which changes the hash both providers evaluate", async () => {
    const asked = plan({ questions: [{ id: "q1", question: "Which format?" }] });
    const answered = plan({ questions: [{ id: "q1", question: "Which format?", answer: "JSON" }] });
    const test = harness({
      claude: (request, call) => call === 1 ? proposal(asked) : decision("approve", request),
      human: new FakeHuman(["JSON"], [{ kind: "approve", executionPermission: "fullAccess" }]),
    });
    const result = await test.run();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const answeredHash = canonicalizeStrictPlan(answered).hash;
    expect(answeredHash).not.toBe(canonicalizeStrictPlan(asked).hash);
    expect(result.plans.map((entry) => entry.source)).toEqual(["initial", "human_revision"]);
    expect(result.approvedPlan.hash).toBe(answeredHash);
    expect(result.consensus.approvals.every((approval) => approval.hash === answeredHash)).toBe(true);
    expect(result.humanApproval.executionPermission).toBe("fullAccess");
  });

  it("retries an invalid structured response within the ceiling and continues after a valid one", async () => {
    const test = harness({
      claude: (request, call) => call === 1 ? proposal() : decision("approve", request),
      codex: (request, call) => call === 1 ? decision("reject", request, { objections: [{
        id: "missing", target: "expected_file", reference: "src/missing.ts",
        summary: "Missing file", rationale: "Add it to the plan.", blocking: true,
      }] }) : decision("approve", request),
    });
    const result = await test.run();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(test.codex.calls).toHaveLength(2);
    expect(test.codex.calls[1].retryErrors?.length).toBeGreaterThan(0);
    expect(test.codex.calls[1].retryErrors?.[0]).toMatchObject({
      path: "$.objections[0].reference", code: "invalid_reference",
    });
    expect(test.codex.calls[1].previousRaw).toContain("src/missing.ts");
    expect(test.events.some((event) => event.message.includes("invalid_reference at $.objections[0].reference"))).toBe(true);
    expect(result.budget.providerRequests).toBe(4);
  });

  it("keeps provider-controlled JSON field names out of validation events", async () => {
    const test = harness({
      claude: (request, call) => call === 1
        ? { raw: JSON.stringify({ ...plan(), TOKEN_FROM_PROVIDER: "untrusted" }) }
        : call === 2 ? proposal() : decision("approve", request),
    });
    const result = await test.run();

    expect(result.ok).toBe(true);
    expect(test.events.some((event) => event.message.includes("unknown_field at $"))).toBe(true);
    expect(test.events.every((event) => !event.message.includes("TOKEN_FROM_PROVIDER"))).toBe(true);
  });

  it("stops at the phase A request ceiling instead of agreeing", async () => {
    const test = harness({
      claude: (request, call) => call === 1 ? proposal() : decision("approve", request),
      limits: { "planPhase.maxProviderRequests": 2 },
    });
    const result = await test.run();

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.state).toBe("consensus_not_reached");
    expect(result.reason.code).toBe("limit_reached");
    expect(result.reason.limit).toMatchObject({ limit: "planPhase.maxProviderRequests", configured: 2, phase: "plan" });
    expect(test.codex.calls).toHaveLength(0);
  });

  it("stops at the phase A active-time ceiling", async () => {
    const clock = new FakeClock();
    const test = harness({
      claude: (request, call) => {
        clock.advance(21 * MINUTE);
        return call === 1 ? proposal() : decision("approve", request);
      },
      clock,
      limits: { "planPhase.maxActiveMinutes": 20 },
    });
    const result = await test.run();

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason.code).toBe("limit_reached");
    expect(result.reason.limit).toMatchObject({ limit: "planPhase.maxActiveMinutes", configured: 20, unit: "minutes" });
  });

  it("stops the active clock while it waits for an answer or an approval", async () => {
    const clock = new FakeClock();
    const human = new FakeHuman(["JSON"], [{ kind: "approve", executionPermission: "askBeforeChange" }],
      () => clock.advance(300 * MINUTE));
    const test = harness({
      claude: (request, call) => {
        clock.advance(MINUTE);
        return call === 1 ? proposal(plan({ questions: [{ id: "q1", question: "Which format?" }] })) : decision("approve", request);
      },
      codex: (request) => {
        clock.advance(MINUTE);
        return decision("approve", request);
      },
      human,
      clock,
      limits: { "planPhase.maxActiveMinutes": 20 },
    });
    const result = await test.run();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.budget.activeMs).toBeLessThanOrEqual(20 * MINUTE);
    expect(result.budget.activeMs).toBe(3 * MINUTE);
    expect(result.budget.wallClockMs).toBe(603 * MINUTE);
  });

  it("never lets one request extend the phase beyond its remaining active time", async () => {
    const clock = new FakeClock();
    const test = harness({
      claude: (request, call) => {
        if (call === 1) {
          clock.advance(16 * MINUTE);
          return proposal();
        }
        return decision("approve", request);
      },
      clock,
      limits: { "planPhase.maxActiveMinutes": 20, providerRequestTimeoutMinutes: 10 },
    });
    const result = await test.run();

    expect(result.ok).toBe(true);
    expect(test.claude.calls[0].timeoutMs).toBe(10 * MINUTE);
    expect(test.claude.calls[1].timeoutMs).toBe(4 * MINUTE);
  });

  it("reports a phase ceiling when it cuts an in-flight request short", async () => {
    const clock = new FakeClock();
    const test = harness({
      claude: (_request, call) => {
        if (call === 1) { clock.advance(16 * MINUTE); return proposal(); }
        throw new StrictProviderError("timed_out", "A provider request exceeded 240 seconds.");
      },
      clock,
      limits: { "planPhase.maxActiveMinutes": 20, providerRequestTimeoutMinutes: 10 },
    });
    const result = await test.run();

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason.code).toBe("limit_reached");
    expect(result.reason.limit).toMatchObject({ limit: "planPhase.maxActiveMinutes", configured: 20 });
  });

  it("stops a revision loop that produces no new hash", async () => {
    const second = plan({ objective: "Add the parser and the formatter" });
    const test = harness({
      claude: (request, call) => {
        if (call === 1) return proposal();
        const target = call % 2 === 0 ? second : plan();
        return decision("revise", request, {
          revisedPlan: target,
          objections: [{ id: `o${call}`, target: "objective", summary: "Still wrong", rationale: "The objective keeps flipping", blocking: true }],
        });
      },
    });
    const result = await test.run();

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.state).toBe("consensus_not_reached");
    expect(result.reason.code).toBe("stall");
    expect(test.codex.calls).toHaveLength(0);
  });

  it("ends as cancelled when the task is aborted during a request", async () => {
    const controller = new AbortController();
    const test = harness({
      claude: () => {
        controller.abort();
        return new Promise<StrictPlanProviderReply>(() => undefined);
      },
      controller,
    });
    const result = await test.run();

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.state).toBe("cancelled");
    expect(result.reason.code).toBe("cancelled");
  });

  it("blocks before any request when planning tools are not read-only or the context is not fresh", async () => {
    const notReadOnly = harness({
      claude: () => proposal(),
      capability: { codex: { readOnlyToolsEnforced: false, reason: "The installed Codex cannot enforce a read-only sandbox." } },
    });
    const first = await notReadOnly.run();
    expect(first.ok).toBe(false);
    if (!first.ok) {
      expect(first.state).toBe("blocked_permissions");
      expect(first.reason.code).toBe("planning_tools_not_read_only");
    }
    expect(notReadOnly.claude.calls).toHaveLength(0);

    const noFreshContext = harness({
      claude: () => proposal(),
      capability: { codex: { freshContext: false } },
    });
    const second = await noFreshContext.run();
    expect(second.ok).toBe(false);
    if (!second.ok) {
      expect(second.state).toBe("blocked_provider");
      expect(second.reason.code).toBe("session_isolation_unverifiable");
    }
    expect(noFreshContext.codex.calls).toHaveLength(0);

    const unavailable = harness({
      claude: () => proposal(),
      capability: { claude: { available: false, reason: "Claude CLI is not logged in." } },
    });
    const third = await unavailable.run();
    expect(third.ok === false && third.state).toBe("blocked_provider");
    expect(third.ok === false && third.reason.code).toBe("provider_unavailable");
  });

  it("stops when the baseline moves under the plan", async () => {
    const baseline = new FakeBaseline();
    const test = harness({
      claude: () => {
        baseline.changed = true;
        return proposal();
      },
      baseline,
    });
    const result = await test.run();

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.state).toBe("failed");
    expect(result.reason.code).toBe("workspace_changed");
  });

  it("re-checks the workspace when the approval comes back", async () => {
    const baseline = new FakeBaseline();
    const test = harness({
      claude: (request, call) => call === 1 ? proposal() : decision("approve", request),
      human: new FakeHuman([], [
        () => {
          // The workspace moved while the plan sat in the approval gate.
          baseline.changed = true;
          return { kind: "approve", executionPermission: "askBeforeChange" };
        },
      ]),
      baseline,
    });
    const result = await test.run();

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.state).toBe("failed");
    expect(result.reason.code).toBe("workspace_changed");
  });

  it("keeps provider prose and question text out of the event stream", async () => {
    const test = harness({
      claude: (request, call) => call === 1
        ? proposal(plan({ questions: [{ id: "q1", question: "SECRET_QUESTION_TEXT?" }] }))
        : decision("approve", request),
      codex: (request) => decision("reject", request, {
        objections: [{ id: "o1", target: "objective", summary: "SECRET_OBJECTION", rationale: "SECRET_RATIONALE", blocking: true }],
      }),
      human: new FakeHuman(["JSON"], []),
    });
    const result = await test.run();

    expect(result.ok).toBe(false);
    const events = test.events.map((event) => event.message).join("\n");
    for (const secret of ["SECRET_QUESTION_TEXT", "SECRET_OBJECTION", "SECRET_RATIONALE"]) {
      expect(events, secret).not.toContain(secret);
    }
    // The chat still gets the question itself through the human gate.
    expect(test.human.questions).toEqual(["SECRET_QUESTION_TEXT?"]);
  });

  it("shows the plan's file estimate without blocking on it", async () => {
    const wide = plan({ expectedFiles: Array.from({ length: 50 }, (_item, index) => `src/file-${index}.ts`) });
    const human = new FakeHuman([], [{ kind: "approve", executionPermission: "askBeforeChange" }]);
    const test = harness({
      claude: (request, call) => call === 1 ? proposal(wide) : decision("approve", request),
      human,
    });
    const result = await test.run();

    // The estimate reaches the gate as information; approval needs no ceiling of any kind.
    expect(human.approvalRequests[0]).toMatchObject({ expectedFileCount: 50, expectedFilesComplete: true });
    expect(human.approvalRequests[0]).not.toHaveProperty("configuredMaxChangedFiles");
    expect(result.ok).toBe(true);
    expect(human.approvalRequests).toHaveLength(1);
  });

  it("approves a plan that cannot estimate its file list", async () => {
    const open = plan({ expectedFiles: [], expectedFilesComplete: false });
    const human = new FakeHuman([], [{ kind: "approve", executionPermission: "askBeforeChange" }]);
    const test = harness({
      claude: (request, call) => call === 1 ? proposal(open) : decision("approve", request),
      human,
    });
    const result = await test.run();

    expect(human.approvalRequests[0].expectedFileCount).toBeUndefined();
    expect(human.approvalRequests[0].expectedFilesComplete).toBe(false);
    expect(result.ok).toBe(true);
  });

  it("ends without execution when the user refuses the plan", async () => {
    const test = harness({
      claude: (request, call) => call === 1 ? proposal() : decision("approve", request),
      human: new FakeHuman([], [{ kind: "refuse", note: "Not this quarter." }]),
    });
    const result = await test.run();

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.state).toBe("cancelled");
    expect(result.reason.code).toBe("plan_rejected_by_human");
    expect(result.reason.message).toContain("Not this quarter.");
  });

  it("reopens phase A on the new hash when the user edits the plan", async () => {
    const edited = plan({ objective: "Add the parser only" });
    const human = new FakeHuman([], [
      { kind: "revise", plan: edited },
      { kind: "approve", executionPermission: "askBeforeChange" },
    ]);
    const test = harness({
      claude: (request, call) => call === 1 ? proposal() : decision("approve", request),
      human,
    });
    const result = await test.run();

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const editedHash = canonicalizeStrictPlan(edited).hash;
    expect(result.plans.map((entry) => entry.source)).toEqual(["initial", "human_revision"]);
    expect(result.approvedPlan.hash).toBe(editedHash);
    expect(result.consensus.approvals.every((approval) => approval.hash === editedHash)).toBe(true);
    expect(test.claude.calls).toHaveLength(3);
    expect(test.codex.calls).toHaveLength(2);
  });

  it("maps a provider quota failure to a blocked outcome", async () => {
    const test = harness({
      claude: (request, call) => call === 1 ? proposal() : decision("approve", request),
      codex: () => {
        throw new StrictProviderError("quota", "The ChatGPT account has no quota left.", "codex");
      },
    });
    const result = await test.run();

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.state).toBe("blocked_auth_or_quota");
    expect(result.reason.code).toBe("quota_exhausted");
  });
});
