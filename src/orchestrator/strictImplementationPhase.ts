import {
  StrictCheckRound, StrictConsensus, StrictContentRetention, StrictFinding, StrictHumanApproval,
  StrictOutcomeReason, StrictPauseRecord,
  StrictReasonCode,
  StrictPhaseBudget, StrictPlanRecord, StrictPolicyExclusion, StrictProviderApproval,
  StrictSessionRecord, StrictSnapshotRecord, StrictTerminalState, StrictUnsupportedPath, StrictValidationError,
} from "../shared/strict";
import { StrictLimits } from "../shared/strictLimits";
import { CheckResult, LocalCheck, ProviderMetric, StrictWorkflowEvent, StrictWorkflowState } from "../shared/types";
import { classifyStrictPath } from "../context/pathPolicy";
import { StrictWorkspace, StrictWorkspaceSnapshot } from "../context/strictWorkspace";
import { assertWorkflowTransition } from "./stateMachine";
import { StrictBudgetTracker, StrictClock, StrictLimitReachedError, systemStrictClock } from "./strictBudget";
import { withDeadline } from "./strictDeadline";
import {
  StrictImplementationProvider, StrictProviderError, StrictReviewProvider, StrictSessionCapability, StrictSessionKind,
} from "./strictProviders";
import {
  parseStrictImplementationResponse, parseStrictReviewResponse, StrictReportedFinding,
} from "./strictResponses";

/**
 * How many times a round of checks may move the perimeter before Strict calls the checks
 * themselves the problem. This is a liveness guard, not a budget: no configurable ceiling
 * bounds this loop, so without it a check that writes a changing value never settles.
 */
const MAX_CHECK_STABILISATION_ROUNDS = 5;

export interface StrictPauseInfo {
  reason: "stall";
  fromState: StrictWorkflowState;
  cyclesWithoutProgress: number;
  snapshotDigest?: string;
}

/**
 * A pause lives only in the memory of the extension host that owns the task: this gate
 * is the awaited promise that keeps it alive. Nothing is written to disk, so a restart
 * cannot resume it.
 */
export interface StrictPauseGate {
  onPause(info: StrictPauseInfo, signal: AbortSignal): Promise<"resume" | "stop">;
}

export interface StrictLifecycleMarker {
  markActive(taskId: string): Promise<void>;
  markFinished(taskId: string): Promise<boolean>;
  markInterrupted(taskId: string): Promise<boolean>;
}

export interface StrictImplementationPhaseInput {
  taskId: string;
  repository: string;
  /** Working directory for provider processes and local checks: the pinned root. */
  workingDirectory: string;
  task: string;
  approvedPlan: StrictPlanRecord;
  humanApproval: StrictHumanApproval;
  /** Frozen at human approval; technical scanner limits still apply independently. */
  limits: StrictLimits;
  localChecks: LocalCheck[];
  /** Generated outputs declared before the run; each must be policy-excluded. */
  declaredGeneratedOutputs: string[];
  workspace: StrictWorkspace;
  /** Exact partial changes verified against the approved baseline before the first turn. */
  resumedChanges?: readonly { path: string; status: StrictSnapshotRecord["entries"][number]["status"] }[];
  resumedSnapshotDigest?: string;
  claude: StrictImplementationProvider;
  codex: StrictReviewProvider;
  /** Runs the configured checks; the working directory is the pinned root. */
  runChecks: (checks: LocalCheck[], signal: AbortSignal, workingDirectory: string) => Promise<CheckResult[]>;
  preExistingEntries: string[];
  pause: StrictPauseGate;
  marker?: StrictLifecycleMarker;
  signal: AbortSignal;
  onEvent: (event: StrictWorkflowEvent) => void;
  clock?: StrictClock;
}

export interface StrictImplementationPhaseRecord {
  snapshots: StrictSnapshotRecord[];
  findings: StrictFinding[];
  checkRounds: StrictCheckRound[];
  sessions: StrictSessionRecord[];
  budget: StrictPhaseBudget;
  events: StrictWorkflowEvent[];
  metrics: ProviderMetric[];
  pauses: StrictPauseRecord[];
  policyExclusions: StrictPolicyExclusion[];
  unsupportedPaths: StrictUnsupportedPath[];
  contentRetention?: StrictContentRetention;
  finalConsensus?: StrictConsensus;
  implementationSummary?: string;
  diff?: string;
}

export type StrictImplementationFailureState = Exclude<StrictTerminalState, "completed_clean" | "blocked_untrusted_workspace">;

export type StrictImplementationPhaseResult =
  | (StrictImplementationPhaseRecord & { ok: true; state: "completed_clean"; finalConsensus: StrictConsensus })
  | (StrictImplementationPhaseRecord & { ok: false; state: StrictImplementationFailureState; reason: StrictOutcomeReason });

class StrictInvalidResponseError extends Error {
  constructor(readonly errors: StrictValidationError[]) {
    super("A provider returned an invalid structured response after every allowed retry.");
    this.name = "StrictInvalidResponseError";
  }
}

class StrictPhaseFailure extends Error {
  /**
   * `reason.message` goes to the user, in chat and in the report. `eventMessage` is what
   * the event stream carries, and the Output Channel logs events: it must never name a
   * workspace path or repeat a raw filesystem error.
   */
  constructor(
    readonly state: StrictImplementationFailureState,
    readonly reason: StrictOutcomeReason,
    readonly eventMessage?: string,
  ) {
    super(reason.message);
    this.name = "StrictPhaseFailure";
  }
}

/**
 * Phase B. A fresh implementation context writes, fresh read-only review contexts examine
 * each snapshot, and a separate Claude context approves the final digest against the plan.
 * Every approval is bound to one digest: any reviewable in-perimeter change invalidates
 * both final approvals and restarts the checks and the review.
 */
export async function runStrictImplementationPhase(
  input: StrictImplementationPhaseInput,
): Promise<StrictImplementationPhaseResult> {
  const clock = input.clock ?? systemStrictClock;
  const budget = new StrictBudgetTracker("implementation", input.limits, clock);
  const events: StrictWorkflowEvent[] = [];
  const sessions: StrictSessionRecord[] = [];
  const metrics: ProviderMetric[] = [];
  const snapshots: StrictSnapshotRecord[] = [];
  const checkRounds: StrictCheckRound[] = [];
  const pauses: StrictPauseRecord[] = [];
  const findings = new Map<string, StrictFinding>();
  let state = "awaiting_human_approval" as StrictWorkflowState;
  let latest: StrictWorkspaceSnapshot | undefined;
  let implementationSummary: string | undefined;
  let finalConsensus: StrictConsensus | undefined;

  const timestamp = (): string => new Date(clock.calendarMs()).toISOString();

  const push = (next: StrictWorkflowState, message: string): void => {
    const event: StrictWorkflowEvent = {
      mode: "strict", taskId: input.taskId, state: next, phase: "implementation", message, timestamp: timestamp(),
    };
    events.push(event);
    input.onEvent(event);
  };

  const emit = (next: StrictWorkflowState, message: string): void => {
    assertWorkflowTransition("strict", state, next);
    state = next;
    push(next, message);
  };

  const note = (message: string): void => push(state, message);

  const record = (): StrictImplementationPhaseRecord => ({
    snapshots: [...snapshots],
    findings: [...findings.values()],
    checkRounds: [...checkRounds],
    sessions: [...sessions],
    budget: budget.snapshot(),
    events: [...events],
    metrics: [...metrics],
    pauses: [...pauses],
    policyExclusions: latest?.policyExclusions ?? [],
    unsupportedPaths: latest?.unsupportedPaths ?? [],
    contentRetention: latest?.contentRetention,
    finalConsensus,
    implementationSummary,
    diff: latest?.diff,
  });

  const ensureActive = (): void => {
    if (input.signal.aborted) throw new StrictProviderError("cancelled", "The task was cancelled.");
  };

  const rememberSession = (
    role: StrictSessionRecord["role"],
    provider: StrictSessionRecord["provider"],
    capability: StrictSessionCapability,
  ): void => {
    sessions.push({
      role, provider,
      providerVersion: capability.providerVersion,
      sessionId: capability.sessionId,
      isolation: capability.freshContext ? "verified_new_context" : "unverifiable",
      startedAt: timestamp(),
    });
  };

  const exchange = async <T>(
    providerId: string,
    send: (signal: AbortSignal, timeoutMs: number, retryErrors: StrictValidationError[] | undefined) => Promise<{
      raw: string; sessionId?: string; providerVersion?: string; metrics?: Omit<ProviderMetric, "provider">;
    }>,
    validate: (raw: string) => { ok: true; value: T } | { ok: false; errors: StrictValidationError[] },
  ): Promise<T> => {
    let retryErrors: StrictValidationError[] | undefined;
    for (let attempt = 0; attempt <= input.limits.maxStructuredRetries; attempt++) {
      ensureActive();
      budget.countProviderRequest();
      const timeoutMs = budget.requestTimeoutMs();
      let reply;
      try {
        reply = await withDeadline((signal) => send(signal, timeoutMs, retryErrors), timeoutMs, input.signal);
      } catch (error) {
        if (error instanceof StrictProviderError && error.kind === "timed_out" &&
            timeoutMs < input.limits.providerRequestTimeoutMinutes * 60_000 && !input.signal.aborted) {
          throw budget.phaseActiveLimitError();
        }
        throw error;
      }
      if (reply.metrics) metrics.push({ provider: providerId, ...reply.metrics });
      const validation = validate(reply.raw);
      if (validation.ok) return validation.value;
      retryErrors = validation.errors;
      // The error code is safe; the message can quote the provider's own payload.
      note(`${providerId} returned an invalid structured response (${validation.errors[0]?.code ?? "invalid"}).`);
    }
    throw new StrictInvalidResponseError(retryErrors ?? []);
  };

  /** Rebuilds the perimeter digest; a scan failure ends the phase with its own reason. */
  const capture = async (): Promise<StrictWorkspaceSnapshot> => {
    const captured = await input.workspace.capture(input.signal);
    if (!captured.ok) {
      // A technical scanner limit ends without consensus; an unreadable perimeter is a failure.
      throw new StrictPhaseFailure(captured.failure.limit ? "consensus_not_reached" : "failed", {
        code: captured.failure.code,
        message: captured.failure.message,
        nextAction: captured.failure.limit
          ? "Reduce the task or workspace to fit Strict's technical scan limits, then start a new task."
          : "Inspect the workspace, then start a new Strict task against a fresh baseline.",
        ...(captured.failure.limit ? { limit: captured.failure.limit } : {}),
      },
      // Filesystem errors can quote workspace paths; keep them out of the event stream.
      `The Strict perimeter could not be captured (${captured.failure.code}). The details are in the chat report.`);
    }
    latest = captured.snapshot;
    // Checked at every checkpoint, not only before a review: an unsupported path or a file
    // that cannot be reviewed may appear after the approvals, and it does not move the
    // digest, which covers reviewable changes only.
    if (!captured.snapshot.record.reviewable) {
      throw new StrictPhaseFailure("review_failed", {
        code: "unreviewable_change",
        message: `The perimeter contains a change that cannot be reviewed: ${describeUnreviewable(captured.snapshot)}.`,
        nextAction: "Remove or revert that change, then start a new Strict task.",
      });
    }
    return captured.snapshot;
  };

  try {
    emit("implementing", "Strict phase B started: checking the approved plan against the path policy.");
    // Nothing below may run before the plan and the declared outputs are checked against
    // the path policy: these failures must happen before any provider request.
    for (const file of input.approvedPlan.plan.expectedFiles) {
      const policy = classifyStrictPath(file);
      if (policy.category === "policy") {
        throw new StrictPhaseFailure("consensus_not_reached", {
          code: "policy_path_in_plan",
          message: `The approved plan expects a change to ${file}, which rule ${policy.rule} excludes from review.`,
          nextAction: "Rewrite the plan without that path and start a new Strict task.",
        });
      }
      if (policy.category === "unsupported") {
        throw new StrictPhaseFailure("consensus_not_reached", {
          code: "unreviewable_change",
          message: `The approved plan expects a change to ${file}, which cannot be represented or reviewed safely.`,
          nextAction: "Rewrite the plan with a reviewable path.",
        });
      }
    }
    for (const output of input.declaredGeneratedOutputs) {
      if (classifyStrictPath(output).category !== "policy") {
        throw new StrictPhaseFailure("failed", {
          code: "declared_output_not_excluded",
          message: `The declared generated output ${output} is inside the reviewed perimeter, so a local check writing there would invalidate the review.`,
          nextAction: "Point the check at an excluded output directory, or remove the declaration.",
        });
      }
    }

    const gates: { kind: StrictSessionKind; role: StrictSessionRecord["role"]; provider: StrictSessionRecord["provider"]; readOnly: boolean }[] = [
      { kind: "implementation", role: "implementation_claude", provider: "claude", readOnly: false },
      { kind: "review", role: "review_codex", provider: "codex", readOnly: true },
      { kind: "final_approval", role: "final_approval_claude", provider: "claude", readOnly: true },
    ];
    for (const gate of gates) {
      ensureActive();
      const capability = gate.provider === "claude"
        ? await input.claude.checkSessionCapability(gate.kind, input.signal)
        : await input.codex.checkSessionCapability(gate.kind, input.signal);
      rememberSession(gate.role, gate.provider, capability);
      if (!capability.available) {
        throw new StrictPhaseFailure("blocked_provider", {
          code: "provider_unavailable",
          message: capability.reason ?? `${gate.provider} is not available for the ${gate.kind} session.`,
          nextAction: "Check the provider CLI, then start a new Strict task.",
        });
      }
      if (!capability.freshContext) {
        throw new StrictPhaseFailure("blocked_provider", {
          code: "session_isolation_unverifiable",
          message: capability.reason ?? `${gate.provider} cannot prove a new context for the ${gate.kind} session.`,
          nextAction: "Install a provider version whose fresh-context behaviour can be verified.",
        });
      }
      if (gate.readOnly && !capability.readOnlySandbox) {
        throw new StrictPhaseFailure("blocked_permissions", {
          code: "review_sandbox_not_read_only",
          message: capability.reason ?? `${gate.provider} cannot enforce a read-only sandbox for the ${gate.kind} session.`,
          nextAction: "Strict needs the provider itself to enforce read-only review. A prompt instruction is not enough.",
        });
      }
    }

    await input.marker?.markActive(input.taskId);
    // Nothing has been written yet: the perimeter must still match the baseline the plan
    // was agreed against, including anything that moved while the approval was open.
    const entry = await capture();
    const resumedPaths = new Map((input.resumedChanges ?? []).map((change) => [change.path, change.status]));
    const onlyResumedChanges = entry.record.entries.length === resumedPaths.size &&
      entry.record.entries.every((change) => resumedPaths.get(change.path) === change.status);
    if (!onlyResumedChanges || entry.changedUnsupportedPaths.length > 0 ||
        (input.resumedSnapshotDigest && entry.record.digest !== input.resumedSnapshotDigest)) {
      throw new StrictPhaseFailure("failed", {
        code: "workspace_changed",
        message: `The workspace changed between the plan approval and the first write (${entry.record.changedFileCount} reviewable change(s)). The approved plan no longer describes what is on disk.`,
        nextAction: "Inspect those changes, then start a new Strict task against a fresh baseline.",
      }, "The workspace changed between the plan approval and the first write.");
    }
    if (resumedPaths.size > 0) note(`Resuming with ${resumedPaths.size} partial change(s) verified against the approved baseline.`);
    note("A fresh Claude context is implementing the approved plan.");
    budget.resume();

    let cycle = 0;
    let cyclesWithoutProgress = 0;
    let failedChecks: CheckResult[] = [];
    let previousDigest: string | undefined;
    let previousFailedCount: number | undefined;
    let previousOpenFindings = 0;

    while (true) {
      ensureActive();
      budget.assertActiveTimeRemaining();
      const correcting = cycle > 0;
      if (correcting) {
        const message = `Claude is answering ${openFindings(findings).length} open finding(s) and ${failedChecks.length} failed check(s).`;
        if (state === "correcting") note(message);
        else emit("correcting", message);
      }

      const openForTurn = openFindings(findings);
      const implementation = await exchange(
        input.claude.id,
        (signal, timeoutMs, retryErrors) => input.claude.implement({
          kind: correcting ? "correct" : "implement",
          taskId: input.taskId,
          repository: input.repository,
          workingDirectory: input.workingDirectory,
          task: input.task,
          plan: input.approvedPlan.plan,
          planHash: input.approvedPlan.hash,
          acceptanceCriteria: input.approvedPlan.plan.acceptanceCriteria,
          answeredQuestions: input.approvedPlan.plan.questions,
          authorizedChecks: input.approvedPlan.plan.checks,
          baseline: input.workspace.identity,
          preExistingEntries: input.preExistingEntries,
          executionPermission: input.humanApproval.executionPermission,
          ...(latest ? { snapshotDigest: latest.record.digest, diff: latest.diff } : {}),
          ...(openForTurn.length ? { findings: openForTurn } : {}),
          ...(failedChecks.length ? { failedChecks: failedChecks.map((check) => ({ id: check.id, output: check.output })) } : {}),
          signal,
          timeoutMs,
          maxResponseBytes: input.limits.maxStructuredResponseBytes,
          retryErrors,
        }),
        (raw) => parseStrictImplementationResponse(raw, {
          maxResponseBytes: input.limits.maxStructuredResponseBytes,
          openFindingIds: openForTurn.map((finding) => finding.id),
        }),
      );
      implementationSummary = implementation.summary;
      for (const answer of implementation.findingDecisions) {
        const finding = findings.get(answer.findingId);
        if (!finding) continue;
        finding.status = answer.decision === "fixed" ? "resolved" : "disputed";
        finding.resolution = {
          by: "claude", decidedAt: timestamp(), rationale: answer.rationale,
          snapshotDigest: latest?.record.digest ?? "",
        };
      }

      // Digest rebuilt after every provider response.
      let snapshot = await capture();
      if (snapshot.record.changedFileCount === 0) {
        if (!correcting) {
          emit("no_changes", "The implementation produced no reviewable change.");
          await input.marker?.markFinished(input.taskId);
          return {
            ...record(), ok: false, state: "no_changes",
            reason: {
              code: "no_changes",
              message: "No reviewable change was produced, so no review and no final approval happened.",
              nextAction: "Start a new Strict task with a narrower or clearer request.",
            },
          };
        }
      }

      emit("running_checks", input.localChecks.length > 0
        ? `Running ${input.localChecks.length} configured local check(s) on digest ${snapshot.record.digest}.`
        : "No local check is configured, so none is reported as passing.");
      // A check that writes inside the perimeter changes what has to be reviewed, so its
      // own result no longer describes the snapshot that would be approved. The round is
      // repeated on the new state until the checks leave the digest where they found it.
      let results: CheckResult[] = [];
      let checkedDigest = "";
      let stable = false;
      const checkedDigests = new Set<string>();
      while (!stable) {
        checkedDigest = snapshot.record.digest;
        if (checkedDigests.has(checkedDigest)) {
          throw new StrictPhaseFailure("consensus_not_reached", {
            code: "checks_failed",
            message: "Configured checks returned to a previously checked digest without stabilizing.",
            nextAction: "Make the checks leave the reviewed files unchanged, then resume in a new task.",
          });
        }
        // A check that stamps a counter or a timestamp into the perimeter reaches a new
        // digest every time, so the repeated-digest guard above never fires. Without a
        // count the round would repeat for as long as the task is left running.
        if (checkedDigests.size >= MAX_CHECK_STABILISATION_ROUNDS) {
          throw new StrictPhaseFailure("consensus_not_reached", {
            code: "checks_failed",
            message: `Configured checks changed the reviewed files on ${MAX_CHECK_STABILISATION_ROUNDS} consecutive rounds, reaching a different digest each time.`,
            nextAction: "Make the checks leave the reviewed files unchanged, then resume in a new task.",
          });
        }
        checkedDigests.add(checkedDigest);
        results = input.localChecks.length > 0
          ? await input.runChecks(input.localChecks, input.signal, input.workingDirectory)
          : [];
        ensureActive();
        snapshot = await capture();
        stable = snapshot.record.digest === checkedDigest;
        checkRounds.push({
          round: checkRounds.length + 1,
          trigger: correcting ? "after_correction" : "after_implementation",
          // The digest the checks actually ran against, not the one they produced.
          snapshotDigest: checkedDigest,
          configured: input.localChecks.length > 0,
          results,
        });
        if (!stable) {
          note(`A configured check changed files inside the perimeter: digest ${checkedDigest} became ${snapshot.record.digest}. The checks run again on the new state.`);
        }
      }
      failedChecks = results.filter((result) => !result.passed);

      const progress = madeProgress(
        { digest: snapshot.record.digest, failedChecks: failedChecks.length, openFindings: openFindings(findings).length },
        { digest: previousDigest, failedChecks: previousFailedCount, openFindings: previousOpenFindings },
      );
      previousDigest = snapshot.record.digest;
      previousFailedCount = failedChecks.length;
      previousOpenFindings = openFindings(findings).length;
      cyclesWithoutProgress = progress ? 0 : cyclesWithoutProgress + 1;

      if (cyclesWithoutProgress >= input.limits.implementationPhase.stallCycles) {
        budget.suspend();
        emit("paused", `Phase B made no verifiable progress for ${cyclesWithoutProgress} cycles and is paused in this window only.`);
        const pauseRecord: StrictPauseRecord = {
          reason: "stall", fromState: "paused", startedAt: timestamp(), resumable: true,
        };
        pauses.push(pauseRecord);
        const choice = await input.pause.onPause({
          reason: "stall", fromState: "paused", cyclesWithoutProgress, snapshotDigest: snapshot.record.digest,
        }, input.signal);
        ensureActive();
        if (choice === "stop") {
          throw new StrictPhaseFailure("consensus_not_reached", {
            code: "stall",
            message: `Phase B stopped after ${cyclesWithoutProgress} cycles without verifiable progress.`,
            nextAction: "Inspect the current diff, then start a new Strict task with a narrower plan.",
          });
        }
        pauseRecord.resumedAt = timestamp();
        cyclesWithoutProgress = 0;
        budget.resume();
        emit("correcting", "The task resumed in the same window; the active-time budget continues from where it stopped.");
        cycle += 1;
        continue;
      }

      if (failedChecks.length > 0) {
        emit("correcting", `${failedChecks.length} configured check(s) failed; their output goes back to Claude.`);
        cycle += 1;
        if (overCycleLimit(cycle, input.limits)) throw cycleLimitFailure(cycle, input.limits);
        continue;
      }

      budget.countReviewCycle();
      emit("reviewing", `A new read-only Codex context is reviewing digest ${snapshot.record.digest}.`);
      snapshots.push(snapshot.record);
      const reviewedDigest = snapshot.record.digest;
      const review = await exchange(
        input.codex.id,
        (signal, timeoutMs, retryErrors) => input.codex.review({
          taskId: input.taskId,
          repository: input.repository,
          workingDirectory: input.workingDirectory,
          task: input.task,
          plan: input.approvedPlan.plan,
          planHash: input.approvedPlan.hash,
          snapshotDigest: reviewedDigest,
          diff: snapshot.diff,
          preExistingEntries: input.preExistingEntries,
          checkResults: results.map((result) => ({ id: result.id, passed: result.passed })),
          implementationSummary: implementationSummary ?? "",
          signal,
          timeoutMs,
          maxResponseBytes: input.limits.maxStructuredResponseBytes,
          retryErrors,
        }),
        (raw) => parseStrictReviewResponse(raw, {
          provider: "codex",
          snapshotDigest: reviewedDigest,
          reviewedPaths: snapshot.record.entries.map((entry) => entry.path),
          maxResponseBytes: input.limits.maxStructuredResponseBytes,
          allowRevise: true,
        }),
      );
      recordFindings(findings, review.findings, reviewedDigest);

      snapshot = await capture();
      if (snapshot.record.digest !== reviewedDigest) {
        note(`The perimeter changed while Codex was reviewing (${reviewedDigest} became ${snapshot.record.digest}); the review is void and the cycle restarts.`);
        cycle += 1;
        if (overCycleLimit(cycle, input.limits)) throw cycleLimitFailure(cycle, input.limits);
        continue;
      }

      if (review.decision !== "approve" || openFindings(findings).some((finding) => finding.blocking)) {
        // The summary itself is provider prose: it belongs to the chat report, not to the
        // event stream the Output Channel logs.
        emit("correcting", `Codex did not approve digest ${reviewedDigest} (${review.decision}); its reasons are in the chat report.`);
        cycle += 1;
        if (overCycleLimit(cycle, input.limits)) throw cycleLimitFailure(cycle, input.limits);
        continue;
      }

      const codexApproval: StrictProviderApproval = {
        provider: "codex", subject: "snapshot", hash: reviewedDigest, decision: "approve", decidedAt: timestamp(),
        ...approvalSession(sessions, "review_codex"),
      };
      emit("awaiting_final_consensus", `Codex approved digest ${reviewedDigest}; Claude now approves or rejects the same digest without write tools.`);

      // Rebuilt between the two final approvals.
      snapshot = await capture();
      if (snapshot.record.digest !== reviewedDigest) {
        note(`The perimeter changed between the final approvals (${reviewedDigest} became ${snapshot.record.digest}); both approvals are void.`);
        emit("reviewing", "The new digest needs its own checks and review.");
        emit("correcting", "Restarting the cycle on the new digest.");
        cycle += 1;
        if (overCycleLimit(cycle, input.limits)) throw cycleLimitFailure(cycle, input.limits);
        continue;
      }

      const finalApproval = await exchange(
        input.claude.id,
        (signal, timeoutMs, retryErrors) => input.claude.approveSnapshot({
          taskId: input.taskId,
          repository: input.repository,
          workingDirectory: input.workingDirectory,
          task: input.task,
          plan: input.approvedPlan.plan,
          planHash: input.approvedPlan.hash,
          snapshotDigest: reviewedDigest,
          diff: snapshot.diff,
          findings: [...findings.values()],
          checkResults: results.map((result) => ({ id: result.id, passed: result.passed })),
          signal,
          timeoutMs,
          maxResponseBytes: input.limits.maxStructuredResponseBytes,
          retryErrors,
        }),
        (raw) => parseStrictReviewResponse(raw, {
          provider: "claude",
          snapshotDigest: reviewedDigest,
          reviewedPaths: snapshot.record.entries.map((entry) => entry.path),
          maxResponseBytes: input.limits.maxStructuredResponseBytes,
          allowRevise: false,
        }),
      );
      recordFindings(findings, finalApproval.findings, reviewedDigest);

      if (finalApproval.decision !== "approve") {
        emit("correcting", `Claude rejected digest ${reviewedDigest} against the plan; its reasons are in the chat report.`);
        cycle += 1;
        if (overCycleLimit(cycle, input.limits)) throw cycleLimitFailure(cycle, input.limits);
        continue;
      }

      // Rebuilt once more before closing.
      snapshot = await capture();
      if (snapshot.record.digest !== reviewedDigest) {
        note(`The perimeter changed after the final approvals (${reviewedDigest} became ${snapshot.record.digest}); they are void.`);
        emit("correcting", "Restarting checks and review on the new digest.");
        cycle += 1;
        if (overCycleLimit(cycle, input.limits)) throw cycleLimitFailure(cycle, input.limits);
        continue;
      }

      const open = openFindings(findings).filter((finding) => finding.blocking);
      if (open.length > 0) {
        throw new StrictPhaseFailure("consensus_not_reached", {
          code: "blocking_findings_open",
          message: `${open.length} blocking finding(s) are still open on digest ${reviewedDigest}.`,
          nextAction: "Resolve or contest those findings in a new Strict task.",
        });
      }

      finalConsensus = {
        subject: "snapshot",
        hash: reviewedDigest,
        approvals: [codexApproval, {
          provider: "claude", subject: "snapshot", hash: reviewedDigest, decision: "approve", decidedAt: timestamp(),
          ...approvalSession(sessions, "final_approval_claude"),
        }],
        openObjections: [],
        reachedAt: timestamp(),
      };
      budget.suspend();
      emit("completed_clean", input.localChecks.length > 0
        ? `Codex and Claude approved digest ${reviewedDigest}; the configured checks passed on it.`
        : `Codex and Claude approved digest ${reviewedDigest}. No local check is configured, so none was run.`);
      await input.marker?.markFinished(input.taskId);
      return { ...record(), ok: true, state: "completed_clean", finalConsensus };
    }
  } catch (error) {
    budget.suspend();
    const [failureState, reason] = failureFor(error, state);
    // Default to a message that cannot carry a path: the Output Channel logs events, and
    // only a message written as safe may go there. The full reason reaches the chat report.
    const eventMessage = error instanceof StrictPhaseFailure && error.eventMessage
      ? error.eventMessage
      : safeEventMessage(reason.code);
    if (state !== failureState) emit(failureState, eventMessage);
    if (failureState === "cancelled" || failureState === "timed_out") await input.marker?.markInterrupted(input.taskId);
    else await input.marker?.markFinished(input.taskId);
    return { ...record(), ok: false, state: failureState, reason };
  } finally {
    budget.suspend();
  }
}

function openFindings(findings: Map<string, StrictFinding>): StrictFinding[] {
  return [...findings.values()].filter((finding) => finding.status === "open");
}

function recordFindings(findings: Map<string, StrictFinding>, reported: StrictReportedFinding[], digest: string): void {
  for (const finding of reported) {
    // A finding reported again is open again, whatever was claimed about it before, and it
    // carries the details of this report: file, line, severity, evidence and blocking may
    // all have moved with the code. The earlier resolution no longer describes it.
    findings.set(finding.id, { ...finding, status: "open", reportedOnDigest: digest });
  }
}

/** Event text for a failure that has no message written to be safe for the Output Channel. */
function safeEventMessage(code: StrictReasonCode): string {
  return `Strict stopped: ${code}. The reason and the next action are in the Countersign chat report.`;
}

/** Progress is a new digest, a finding answered, or a better check outcome. */
function madeProgress(
  current: { digest: string; failedChecks: number; openFindings: number },
  previous: { digest?: string; failedChecks?: number; openFindings: number },
): boolean {
  if (previous.digest === undefined) return true;
  if (current.digest !== previous.digest) return true;
  if (previous.failedChecks !== undefined && current.failedChecks < previous.failedChecks) return true;
  return current.openFindings < previous.openFindings;
}

function overCycleLimit(cycle: number, limits: StrictLimits): boolean {
  return limits.implementationPhase.maxReviewCycles > 0 && cycle >= limits.implementationPhase.maxReviewCycles;
}

function cycleLimitFailure(cycle: number, limits: StrictLimits): StrictPhaseFailure {
  return new StrictPhaseFailure("consensus_not_reached", {
    code: "limit_reached",
    message: `Phase B reached its ceiling of ${limits.implementationPhase.maxReviewCycles} review cycles without agreement.`,
    nextAction: "Inspect the current diff, then start a new Strict task with a narrower plan.",
    limit: {
      limit: "implementationPhase.maxReviewCycles", phase: "implementation", unit: "cycles",
      configured: limits.implementationPhase.maxReviewCycles, observed: cycle,
    },
  });
}

function describeUnreviewable(snapshot: StrictWorkspaceSnapshot): string {
  const entry = snapshot.record.entries.find((item) => !item.reviewable);
  if (entry) return `${entry.path} (${entry.unreviewableReason})`;
  const unsupported = snapshot.changedUnsupportedPaths[0];
  return unsupported ? `${unsupported.path} (${unsupported.reason})` : "an unsupported change";
}

function approvalSession(sessions: StrictSessionRecord[], role: StrictSessionRecord["role"]): { sessionId?: string; providerVersion?: string } {
  const session = sessions.find((entry) => entry.role === role);
  return {
    ...(session?.sessionId ? { sessionId: session.sessionId } : {}),
    ...(session?.providerVersion ? { providerVersion: session.providerVersion } : {}),
  };
}

function failureFor(error: unknown, state: StrictWorkflowState): [StrictImplementationFailureState, StrictOutcomeReason] {
  if (error instanceof StrictPhaseFailure) return [error.state, error.reason];
  if (error instanceof StrictLimitReachedError) {
    return ["consensus_not_reached", {
      code: "limit_reached",
      message: error.message,
      nextAction: "Start a new Strict task with a narrower request or a higher phase B ceiling.",
      limit: error.breach,
    }];
  }
  if (error instanceof StrictInvalidResponseError) {
    return ["consensus_not_reached", {
      code: "invalid_structured_response",
      message: `A provider did not answer the Strict schema. Last error: ${error.errors[0]?.message ?? "none recorded"}`,
      nextAction: "Try again, possibly with another model.",
    }];
  }
  if (error instanceof StrictProviderError) {
    if (error.kind === "local_limit") {
      return ["failed", {
        code: "limit_reached",
        message: error.message,
        nextAction: "Inspect the current diff and the limit reported by Claude or its CLI configuration, then start again.",
      }];
    }
    if (error.kind === "protocol") {
      return ["consensus_not_reached", {
        code: "invalid_structured_response",
        message: error.message,
        nextAction: error.provider === "codex"
          ? "Inspect the current diff, then check the Codex CLI diagnostic and update Countersign if it rejected the output schema."
          : "Inspect the current diff, then try another model or a narrower task.",
      }];
    }
    if (error.kind === "cancelled") {
      return ["cancelled", {
        code: "cancelled",
        message: "The task was cancelled during phase B. Files already changed were kept.",
        nextAction: "Inspect the diff, then start a new task against a fresh baseline.",
      }];
    }
    if (error.kind === "timed_out") {
      return ["timed_out", { code: "timed_out", message: error.message, nextAction: "Inspect the diff, then start again." }];
    }
    if (error.kind === "authentication" || error.kind === "quota") {
      return ["blocked_auth_or_quota", {
        code: error.kind === "quota" ? "quota_exhausted" : "authentication_failed",
        message: error.message,
        nextAction: error.kind === "quota"
          ? "Use Change account and resume on this report, or wait for the quota reset. Strict reuses the approval only if the workspace still matches its baseline."
          : "Check the provider login, then resume only if the workspace still matches its approved baseline.",
      }];
    }
    if (error.kind === "permissions") {
      return ["blocked_permissions", {
        code: "provider_permission_denied",
        message: error.message,
        nextAction: "Check the provider's permission settings for this turn, then retry after inspecting the workspace diff.",
      }];
    }
    return ["blocked_provider", { code: "provider_unavailable", message: error.message, nextAction: "Check the provider CLI, then start again." }];
  }
  return ["failed", {
    code: "internal_error",
    message: error instanceof Error ? error.message : `Unknown phase B error in state ${state}.`,
    nextAction: "Report the failure with the Countersign report; the workspace was not reverted.",
  }];
}
