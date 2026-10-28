import { describe, expect, it } from "vitest";
import { detailedWorkflowReport, summarizeWorkflow } from "../src/orchestrator/report";
import {
  STRICT_PLAN_SCHEMA_VERSION, STRICT_RESPONSE_SCHEMA_VERSION, STRICT_SNAPSHOT_FORMAT_VERSION,
  StrictPlanResponse, StrictResultCore, StrictWorkflowResult,
} from "../src/shared/strict";
import { resolveStrictLimits } from "../src/shared/strictLimits";
import { BalancedWorkflowResult } from "../src/shared/types";

const PLAN_HASH = "a".repeat(64);
const FINAL_DIGEST = "b".repeat(64);
const BASELINE_DIGEST = "c".repeat(64);

function core(): StrictResultCore {
  return {
    mode: "strict",
    taskId: "strict-task-id",
    repository: "/repo",
    task: "SECRET_TASK_PROMPT",
    startedAt: "2026-10-22T09:00:00.000Z",
    finishedAt: "2026-10-22T09:40:00.000Z",
    message: "SECRET_PROVIDER_MESSAGE",
    implementationSummary: "Added the parser entry point in src/a.ts and wired it into the existing loader.",
    limits: resolveStrictLimits({ }),
    limitBreaches: [],
    budget: {
      plan: { providerRequests: 4, activeMs: 600_000, wallClockMs: 1_800_000 },
      implementation: { providerRequests: 9, activeMs: 1_200_000, wallClockMs: 1_500_000, reviewCycles: 2 },
    },
    plans: [{
      hash: PLAN_HASH,
      schemaVersion: STRICT_PLAN_SCHEMA_VERSION,
      canonicalBytes: 1_024,
      revision: 1,
      source: "initial",
      createdAt: "2026-10-22T09:05:00.000Z",
      plan: {
        schemaVersion: STRICT_PLAN_SCHEMA_VERSION,
        objective: "Add the parser",
        constraints: ["No new dependency"],
        acceptanceCriteria: ["Unit tests pass"],
        expectedFiles: ["src/a.ts", "src/b.ts"],
        expectedFilesComplete: true,
        risks: ["Parser rewrite is wide"],
        checks: ["lint"],
        questions: [{ id: "q1", question: "Which format?", answer: "JSON" }],
      },
    }],
    planConsensus: {
      subject: "plan",
      hash: PLAN_HASH,
      reachedAt: "2026-10-22T09:12:00.000Z",
      approvals: [
        { provider: "claude", subject: "plan", hash: PLAN_HASH, decision: "approve", decidedAt: "2026-10-22T09:10:00.000Z", providerVersion: "2.1.109" },
        { provider: "codex", subject: "plan", hash: PLAN_HASH, decision: "approve", decidedAt: "2026-10-22T09:12:00.000Z", providerVersion: "0.163.0" },
      ],
      openObjections: [],
    },
    humanApproval: {
      approved: true,
      planHash: PLAN_HASH,
      decidedAt: "2026-10-22T09:15:00.000Z",
      executionPermission: "askBeforeChange",
    },
    baseline: {
      root: "/repo",
      source: "filesystem_scan",
      capturedAt: "2026-10-22T09:00:30.000Z",
      digest: BASELINE_DIGEST,
      entryCount: 320,
      git: { repository: "/repo", head: "deadbeef" },
    },
    snapshots: [{
      formatVersion: STRICT_SNAPSHOT_FORMAT_VERSION,
      digest: FINAL_DIGEST,
      baselineDigest: BASELINE_DIGEST,
      capturedAt: "2026-10-22T09:30:00.000Z",
      entries: [{ path: "src/a.ts", kind: "file", status: "modified", reviewable: true, afterHash: "d".repeat(64) }],
      changedFileCount: 1,
      reviewable: true,
    }],
    finalConsensus: {
      subject: "snapshot",
      hash: FINAL_DIGEST,
      reachedAt: "2026-10-22T09:38:00.000Z",
      approvals: [
        { provider: "codex", subject: "snapshot", hash: FINAL_DIGEST, decision: "approve", decidedAt: "2026-10-22T09:36:00.000Z" },
        { provider: "claude", subject: "snapshot", hash: FINAL_DIGEST, decision: "approve", decidedAt: "2026-10-22T09:38:00.000Z" },
      ],
      openObjections: [],
    },
    sessions: [
      { role: "plan_claude", provider: "claude", providerVersion: "2.1.109", sessionId: "session-1", isolation: "verified_new_context", startedAt: "2026-10-22T09:05:00.000Z" },
      { role: "review_codex", provider: "codex", providerVersion: "0.163.0", sessionId: "thread-9", isolation: "verified_new_context", startedAt: "2026-10-22T09:28:00.000Z" },
    ],
    findings: [
      { id: "f1", severity: "High", file: "src/a.ts", line: 12, evidence: "SECRET_EVIDENCE", summary: "Off-by-one", blocking: true, status: "resolved", reportedOnDigest: FINAL_DIGEST, resolution: { by: "claude", decidedAt: "2026-10-22T09:34:00.000Z", rationale: "Fixed the bound", snapshotDigest: FINAL_DIGEST } },
      { id: "f2", severity: "Low", file: "src/b.ts", line: 3, evidence: "Style only", summary: "Naming", blocking: false, status: "disputed", reportedOnDigest: FINAL_DIGEST },
    ],
    checkRounds: [{
      round: 1,
      trigger: "after_implementation",
      snapshotDigest: FINAL_DIGEST,
      configured: true,
      results: [{ id: "lint", passed: true, exitCode: 0, output: "SECRET_CHECK_OUTPUT", timedOut: false }],
    }],
    preExistingEntries: [" M docs/chat-guide.md"],
    policyExclusions: [{ rule: "generated-output", root: "dist/", entryCount: 12 }],
    unsupportedPaths: [{ path: "tmp/link", reason: "symlink" }],
    contentRetention: {
      maxBytes: 64 * 1024 * 1024,
      retainedBytes: 4_096,
      filesWithoutContent: 2,
      filesDroppedForBudget: 0,
      baselineFilesDroppedForBudget: 0,
    },
    pauses: [{ reason: "stall", fromState: "reviewing", startedAt: "2026-10-22T09:33:00.000Z", resumedAt: "2026-10-22T09:35:00.000Z", resumable: true }],
    marker: { status: "owned", outcome: "finished", timestamp: "2026-10-22T09:39:00.000Z", clearedByCommand: false },
    events: [{ mode: "strict", taskId: "strict-task-id", state: "planning", phase: "plan", message: "Planning started.", timestamp: "2026-10-22T09:05:00.000Z" }],
    metrics: [
      { provider: "claude", inputTokens: 100, cacheReadInputTokens: 700, cacheCreationInputTokens: 200,
        outputTokens: 200, estimatedCostUsd: 0.4 },
      { provider: "codex", inputTokens: 50, outputTokens: 60 },
    ],
    selectedModels: { claudeModel: "opus", claudeEffort: "high", codexModel: "gpt", codexEffort: "medium" },
    executionPermission: "askBeforeChange",
  };
}

const cleanResult: StrictWorkflowResult = { ...core(), state: "completed_clean" };

describe("Strict report contract", () => {
  it("keeps task text, evidence, check output and provider prose out of the Output Channel summary", () => {
    const summary = summarizeWorkflow(cleanResult);
    expect(summary).toContain("--- Strict workflow summary ---");
    expect(summary).toContain("Mode: strict");
    expect(summary).toContain("State: completed_clean");
    expect(summary).toContain(`agreed plan hash: ${PLAN_HASH}`);
    expect(summary).toContain(`final digest: ${FINAL_DIGEST}`);
    expect(summary).toContain("Strict marker: owned (finished)");
    for (const secret of [
      "SECRET_TASK_PROMPT", "SECRET_EVIDENCE", "SECRET_CHECK_OUTPUT", "SECRET_PROVIDER_MESSAGE",
      "Add the parser", "Off-by-one",
    ]) {
      expect(summary, secret).not.toContain(secret);
    }
  });

  it("reports every contract section in the chat report", () => {
    const report = detailedWorkflowReport(cleanResult);
    for (const fragment of [
      "# Strict workflow report",
      "Mode: strict",
      "Status: completed_clean",
      "Reason: completed_clean. Every Strict condition below was met.",
      "SECRET_TASK_PROMPT",
      `Schema version ${STRICT_PLAN_SCHEMA_VERSION}; canonical size 1024 bytes; hash ${PLAN_HASH}`,
      `- claude: approve on ${PLAN_HASH}`,
      `- codex: approve on ${PLAN_HASH}`,
      "Approved at 2026-10-22T09:15:00.000Z on plan hash",
      "permission askBeforeChange.",
      `digest ${BASELINE_DIGEST}`,
      "Git supplied identity only and did not define the file set.",
      `digest ${FINAL_DIGEST} against baseline ${BASELINE_DIGEST}`,
      `Every final approval below is bound to digest ${FINAL_DIGEST}`,
      "plan_claude: claude 2.1.109; session session-1; context verified as new",
      "review_codex: codex 0.163.0",
      "[resolved, blocking] High — src/a.ts:12",
      "[disputed] Low — src/b.ts:3",
      "SECRET_EVIDENCE",
      "Round 1 (after_implementation)",
      "lint: passed",
      "SECRET_CHECK_OUTPUT",
      "-  M docs/chat-guide.md",
      "Policy rule generated-output under dist/: 12 entry/entries excluded without reading contents.",
      "Unsupported path tmp/link (symlink)",
      "stall pause from reviewing",
      "Status: owned; outcome finished; written 2026-10-22T09:39:00.000Z.",
      "Countersign: Clear Strict interruption marker deletes only that metadata",
      // Cache reads and writes are most of the input on an expensive turn; a single
      // "input tokens" figure that left them out understated it.
      "claude: 1000 total input tokens (100 uncached, 700 cache read, 200 cache write); 200 output tokens",
      "codex: 50 input tokens; 60 output tokens; unavailable USD API price estimate",
      "No automatic phase request, active-time, review-cycle or per-provider-request timeout is configured.",
      "- No ceiling was reached.",
      "Active time stops while the task waits for a human approval",
      "Changes confined to the policy-excluded paths listed above are expected and block nothing",
    ]) {
      expect(report, fragment).toContain(fragment);
    }
  });

  it("opens with the work before the provenance, and keeps the audit material after it", () => {
    const report = detailedWorkflowReport(cleanResult);
    for (const fragment of [
      "## What was implemented",
      "Added the parser entry point in src/a.ts and wired it into the existing loader.",
      "## Files changed",
      "- modified: src/a.ts",
      "## Review",
      "0 open, 1 resolved, 1 disputed.",
      "## Checks",
      "## Run details",
    ]) {
      expect(report, fragment).toContain(fragment);
    }
    const at = (heading: string): number => report.indexOf(heading);
    expect(at("## What was implemented")).toBeLessThan(at("## Files changed"));
    expect(at("## Checks")).toBeLessThan(at("## Run details"));
    expect(at("## Run details")).toBeLessThan(at("## Plan history"));
    expect(at("## Plan history")).toBeLessThan(at("## Provider usage"));
    // Started, finished and the model choice are provenance: they belong after the answer.
    expect(at("## What was implemented")).toBeLessThan(report.indexOf("Started: "));
  });

  it("says so plainly when phase B returned no account of the work", () => {
    const silent = { ...cleanResult, implementationSummary: undefined };
    expect(detailedWorkflowReport(silent)).toContain("No implementation summary was returned.");
  });

  it("states the reason, the next action and the limit reached for a failed outcome", () => {
    const stalled: StrictWorkflowResult = {
      ...core(),
      state: "consensus_not_reached",
      reason: {
        code: "limit_reached",
        message: "Phase B reached its review cycle ceiling with one blocking finding open.",
        nextAction: "Narrow the task or raise the review cycle limit for a new task.",
        limit: { limit: "implementationPhase.maxReviewCycles", phase: "implementation", configured: 6, observed: 6, unit: "cycles" },
      },
      limitBreaches: [{ limit: "implementationPhase.maxReviewCycles", phase: "implementation", configured: 6, observed: 6, unit: "cycles" }],
    };
    const report = detailedWorkflowReport(stalled);
    expect(report).toContain("Status: consensus_not_reached");
    expect(report).toContain("Reason: limit_reached — Phase B reached its review cycle ceiling");
    expect(report).toContain("Next action: Narrow the task or raise the review cycle limit for a new task.");
    expect(report).toContain("Limit reached: implementationPhase.maxReviewCycles (6 of 6 cycles, phase implementation)");
    expect(report).toContain("- Reached: implementationPhase.maxReviewCycles — 6 of 6 cycles in phase implementation");
    expect(summarizeWorkflow(stalled)).toContain("Outcome reason: limit_reached");
    expect(summarizeWorkflow(stalled)).toContain("Limits reached: implementationPhase.maxReviewCycles");
  });

  it("does not present no_changes as a clean completion and declares unrun checks", () => {
    const empty: StrictWorkflowResult = {
      ...core(),
      state: "no_changes",
      reason: {
        code: "no_changes",
        message: "The implementation produced no reviewable change.",
        nextAction: "Start a new task with a narrower objective.",
      },
      snapshots: [],
      finalConsensus: undefined,
      findings: [],
      checkRounds: [{ round: 1, trigger: "after_implementation", snapshotDigest: FINAL_DIGEST, configured: false, results: [] }],
    };
    const report = detailedWorkflowReport(empty);
    expect(report).toContain("No reviewable change was produced, so no final review and no final approval happened. This is not a clean completion.");
    expect(report).toContain("Phase B did not reach a final approval.");
    expect(report).toContain("No local check is configured. No test was run and none is reported as passing.");
    expect(report).not.toContain("Status: completed_clean");
  });

  it("says what the diff-content pool cost, and never calls a full pool a breach", () => {
    const full: StrictWorkflowResult = {
      ...cleanResult,
      contentRetention: {
        maxBytes: 64 * 1024 * 1024,
        retainedBytes: 67_108_860,
        filesWithoutContent: 940,
        filesDroppedForBudget: 912,
        baselineFilesDroppedForBudget: 908,
      },
    };
    const report = detailedWorkflowReport(full);
    expect(report).toContain("the 64 MiB diff-content pool filled, so 1820 file(s) were hashed in full without keeping their bytes");
    expect(report).toContain("reported as content_not_retained, which is unreviewable and blocks a clean completion");
    expect(report).toContain("The scan itself was never stopped by the size of the workspace.");
    // A full pool is a memory bound, never a ceiling a task reached.
    expect(report).toContain("- No ceiling was reached.");
    expect(summarizeWorkflow(full)).toContain("files hashed without kept contents: 940");

    const roomy = detailedWorkflowReport(cleanResult);
    expect(roomy).toContain("every reviewable file fitted in the 64 MiB diff-content pool");
  });

  it("answers a preflight stop briefly instead of filling the contract report with empty sections", () => {
    const stopped: StrictWorkflowResult = {
      ...core(),
      state: "failed",
      message: "The workspace folder is unavailable on disk.",
      reason: {
        code: "baseline_unavailable",
        message: "The workspace folder is unavailable on disk.",
        nextAction: "Fix the workspace problem above, then start a new Strict task.",
      },
      budget: {
        plan: { providerRequests: 0, activeMs: 0, wallClockMs: 0 },
        implementation: { providerRequests: 0, activeMs: 0, wallClockMs: 0 },
      },
      plans: [],
      planConsensus: undefined,
      humanApproval: undefined,
      baseline: undefined,
      snapshots: [],
      finalConsensus: undefined,
      sessions: [],
      findings: [],
      checkRounds: [],
      metrics: [],
      policyExclusions: [],
      unsupportedPaths: [],
      contentRetention: undefined,
      pauses: [],
    };
    const report = detailedWorkflowReport(stopped);

    expect(report).toContain("# Strict preflight report");
    expect(report).toContain("Status: failed, before phase A started.");
    expect(report).toContain("## What failed");
    expect(report).toContain("baseline_unavailable — The workspace folder is unavailable on disk.");
    expect(report).toContain("- Phase A (plan agreement): not started.");
    expect(report).toContain("- Provider requests: none. Neither Claude nor Codex was contacted.");
    expect(report).toContain("- Workspace changes by Strict: none.");
    expect(report).toContain("## Next step");
    expect(report).toContain("Fix the workspace problem above, then start a new Strict task.");
    // None of the contract sections that would only say "none" over and over.
    for (const absent of [
      "## Plan history", "## Plan consensus", "## Human approval", "## Reviewed snapshots",
      "## Final consensus", "## Sessions", "## Findings", "## Local checks per round",
      "## Changes already present before this task", "## Exclusions", "## Pauses and interruptions",
      "## Provider usage", "## Budget", "## Limits in force",
    ]) {
      expect(report, absent).not.toContain(absent);
    }
    expect(report.split("\n").length).toBeLessThan(25);
  });

  it("keeps the full contract report once a baseline exists", () => {
    // A stop after the baseline still has a perimeter, a plan attempt and sessions to
    // account for, so it must not be shortened into the preflight form.
    const afterBaseline: StrictWorkflowResult = {
      ...core(),
      state: "consensus_not_reached",
      reason: {
        code: "plan_consensus_not_reached",
        message: "Claude and Codex never approved the same plan hash.",
        nextAction: "Start a new Strict task with a narrower objective.",
      },
      snapshots: [],
      finalConsensus: undefined,
    };
    const report = detailedWorkflowReport(afterBaseline);
    expect(report).toContain("# Strict workflow report");
    expect(report).toContain("## Baseline");
    expect(report).not.toContain("# Strict preflight report");
  });

  it("keeps the Balanced and Strict results separate at the type level", () => {
    const balanced: BalancedWorkflowResult = {
      mode: "balanced", taskId: "balanced-id", state: "completed_clean", repository: "/repo", task: "t",
      startedAt: "now", finishedAt: "later", findings: [], checks: [], workingTreeEntries: [], message: "done",
      mock: false, implementationProvider: "claude", reviewProvider: "real", metrics: [],
    };
    expect(summarizeWorkflow(balanced)).toContain("--- Workflow summary ---");
    // @ts-expect-error a Balanced result cannot carry Strict fields.
    const mixed: BalancedWorkflowResult = { ...balanced, plans: [] };
    expect(mixed.mode).toBe("balanced");
    // @ts-expect-error every Strict outcome other than completed_clean must state its reason.
    const unexplained: StrictWorkflowResult = { ...core(), state: "consensus_not_reached" };
    expect(unexplained.state).toBe("consensus_not_reached");
    const response: StrictPlanResponse = {
      schemaVersion: STRICT_RESPONSE_SCHEMA_VERSION, provider: "codex", planHash: PLAN_HASH,
      decision: "revise", objections: [{ id: "o1", target: "expected_file", reference: "src/b.ts", summary: "Out of scope", rationale: "Not in the objective", blocking: true }],
      summary: "Needs a narrower file list",
    };
    expect(response.decision).toBe("revise");
  });
});
