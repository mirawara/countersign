import { randomUUID } from "node:crypto";
import { OrchestratorConfig } from "../configuration/config";
import { GitChanges } from "../context/gitChanges";
import { createWorkspaceChanges, WorkspaceChanges } from "../context/workspaceChanges";
import { ProcessFailure } from "../shared/process";
import { AgentResult, AIProvider, CheckResult, Finding, FindingSeverity, WorkflowEvent, WorkflowResult, WorkflowState } from "../shared/types";
import { runLocalChecks } from "./localChecks";
import { assertWorkflowTransition } from "./stateMachine";
import { isFindingSeverity } from "../configuration/config";
import { CodexProviderError } from "../providers/codexCliProvider";
import { ClaudeProviderError } from "../providers/claudeCliProvider";

export interface WorkflowInput {
  repository: string;
  task: string;
  config: OrchestratorConfig;
  claude: AIProvider;
  codex: AIProvider;
  signal: AbortSignal;
  onEvent: (event: WorkflowEvent) => void;
  plan?: string;
  clarifications?: WorkflowResult["clarifications"];
  selectedModels?: WorkflowResult["selectedModels"];
  initialMetrics?: WorkflowResult["metrics"];
  startingChanges?: GitChanges;
  startingEntries?: string[];
  tracker?: WorkspaceChanges;
  askQuestion?: (phase: "implementing" | "reviewing" | "correcting", question: string,
    signal: AbortSignal) => Promise<string | undefined>;
  askPermission?: (tool: string, detail: string, signal: AbortSignal) => Promise<boolean>;
}

export async function runWorkflow(input: WorkflowInput): Promise<WorkflowResult> {
  const taskId = randomUUID();
  const startedAt = new Date().toISOString();
  const checks: CheckResult[] = [];
  const metrics: WorkflowResult["metrics"] = [...(input.initialMetrics ?? [])];
  const events: WorkflowEvent[] = [];
  let workingTreeEntries: string[] = [];
  let startingChanges: GitChanges | undefined = input.startingChanges;
  let tracker: WorkspaceChanges | undefined = input.tracker;
  const readChanges = async (): Promise<GitChanges> => {
    tracker ??= await createWorkspaceChanges(input.repository);
    return tracker.read();
  };
  let state: WorkflowState = "awaiting_confirmation";
  let simulatedDiff: string | undefined;
  let diff: string | undefined;
  let changedPaths: string[];
  let reviewSummary: string | undefined;
  let implementationSummary: string | undefined;
  let correctionSummary: string | undefined;
  const clarifications = [...(input.clarifications ?? [])];
  let finalFindings: Finding[] = [];
  let providerRequestAttempted = false;
  let timedOut = false;
  const realImplementation = input.config.provider === "claude" && input.claude.id !== "implementation-mock";
  const realReview = input.config.codexProvider === "real" && input.codex.id !== "review-mock";
  const workflowController = new AbortController();
  const onExternalAbort = (): void => workflowController.abort();
  if (input.signal.aborted) onExternalAbort();
  else input.signal.addEventListener("abort", onExternalAbort, { once: true });
  const timeout = setTimeout(() => {
    timedOut = true;
    workflowController.abort();
  }, input.config.taskTimeoutMinutes * 60_000);
  timeout.unref();

  const emit = (next: WorkflowState, message: string): void => {
    assertWorkflowTransition(state, next);
    state = next;
    const event = { taskId, state, message, timestamp: new Date().toISOString() };
    events.push(event);
    input.onEvent(event);
  };

  const makeResult = (message: string): WorkflowResult => ({
    taskId,
    state,
    repository: input.repository,
    task: input.task,
    startedAt,
    finishedAt: new Date().toISOString(),
    simulatedDiff,
    diff,
    reviewSummary,
    plan: input.plan,
    implementationSummary,
    correctionSummary,
    clarifications,
    selectedModels: input.selectedModels,
    configuredChecks: input.config.localChecks,
    events,
    findings: finalFindings,
    checks,
    workingTreeEntries,
    startingWorkingTreeEntries: input.startingEntries ?? tracker?.startingEntries ?? startingChanges?.entries ?? [],
    changeSource: tracker?.source,
    message,
    mock: !providerRequestAttempted,
    implementationProvider: realImplementation ? "claude" : "mock",
    reviewProvider: realReview ? "real" : "mock",
    executionPermission: input.config.executionPermission,
    metrics,
  });

  const abortFailure = (): ProcessFailure => new ProcessFailure(
    timedOut ? "timed_out" : "cancelled",
    timedOut ? "Workflow exceeded the configured task timeout." : "Workflow cancelled.",
  );

  const ensureActive = (): void => {
    if (workflowController.signal.aborted) throw abortFailure();
  };

  const askQuestion = async (phase: "implementing" | "reviewing" | "correcting", question: string,
    prior: { question: string; answer: string }[]): Promise<void> => {
    if (!input.askQuestion || prior.length >= 3) {
      throw new Error(`${phase} needs another user decision. The workflow stopped after three questions in this phase.`);
    }
    emit("awaiting_input", `${phase}: waiting for a user answer.`);
    const answer = await awaitAbortable(input.askQuestion(phase, question, workflowController.signal),
      workflowController.signal, abortFailure);
    ensureActive();
    if (!answer?.trim() || answer.length > 20_000) throw new ProcessFailure("cancelled", "Question was not answered.");
    prior.push({ question, answer: answer.trim() });
    clarifications.push({ phase, question, answer: answer.trim() });
    emit(phase, `User answered a ${phase} question; the agent is continuing.`);
  };

  const executionTask = [input.task,
    input.clarifications?.length ? `Planning decisions:\n${input.clarifications.map(({ question, answer }) => `Q: ${question}\nA: ${answer}`).join("\n")}` : "",
    input.plan ? `Approved plan (follow this; ask before materially changing it):\n${input.plan}` : "",
  ].filter(Boolean).join("\n\n");

  const approveChecks = async (): Promise<boolean> => {
    if (!realImplementation || input.config.executionPermission !== "askBeforeChange" ||
      input.config.localChecks.length === 0) return true;
    if (!input.askPermission) return false;
    for (const check of input.config.localChecks) {
      const before = await readChanges();
      const approved = await awaitAbortable(input.askPermission(`Local check: ${check.id}`,
        `${check.executable} ${check.args.join(" ")}`.trim(), workflowController.signal),
      workflowController.signal, abortFailure);
      ensureActive();
      const after = await readChanges();
      if (JSON.stringify(after) !== JSON.stringify(before)) {
        throw new Error("The workspace changed while waiting for local check approval. Inspect the diff before continuing.");
      }
      if (!approved) return false;
    }
    return true;
  };

  try {
    ensureActive();
    tracker ??= await createWorkspaceChanges(input.repository);
    ensureActive();
    const currentStart = await readChanges();
    if (startingChanges && JSON.stringify(currentStart) !== JSON.stringify(startingChanges)) {
      throw new Error("The working tree changed after plan approval. Inspect its changes before starting again.");
    }
    startingChanges = currentStart;
    const availability = await awaitAbortable(Promise.all([
      input.claude.checkAvailability(),
      input.codex.checkAvailability(),
    ]), workflowController.signal, abortFailure);
    ensureActive();
    const [claudeStatus, codexStatus] = availability;
    if (!claudeStatus.available || !codexStatus.available) {
      emit("blocked_provider", claudeStatus.reason ?? codexStatus.reason ?? "A configured provider is unavailable.");
      return makeResult("A configured provider is unavailable.");
    }

    emit("implementing", realImplementation
      ? "Claude CLI is implementing the task with the confirmed tools."
      : "Mock Claude is simulating implementation; no files will be changed.");
    providerRequestAttempted = realImplementation;
    const implementationAnswers: { question: string; answer: string }[] = [];
    let partialImplementationDiff: string | undefined;
    let implementation: AgentResult;
    while (true) {
      implementation = await awaitAbortable(input.claude.execute({
        taskId, mode: "implement", repository: input.repository, task: executionTask,
        clarifications: implementationAnswers, diff: partialImplementationDiff, signal: workflowController.signal,
        readChanges, changeSource: tracker.source,
      }), workflowController.signal, abortFailure);
      ensureActive();
      if (!implementation.question) break;
      const changes = await readChanges();
      const snapshot = JSON.stringify({ diff: changes.diff, entries: changes.entries });
      partialImplementationDiff = changes.diff;
      await askQuestion("implementing", changes.paths.length
        ? `${implementation.question}\n\nThe working tree currently has ${changes.paths.length} changed file(s), including any changes from before this workflow. They will be kept while you answer.`
        : implementation.question, implementationAnswers);
      const current = await readChanges();
      if (JSON.stringify({ diff: current.diff, entries: current.entries }) !== snapshot) {
        throw new Error("The workspace changed while waiting for an implementation answer. Inspect the diff before continuing.");
      }
    }
    ensureActive();
    implementationSummary = implementation.message;
    if (implementation.metrics) metrics.push({ provider: input.claude.id, ...implementation.metrics });
    if (realImplementation) {
      const changes = await readChanges();
      workingTreeEntries = changes.entries;
      diff = changes.diff;
      changedPaths = changes.paths;
    } else {
      simulatedDiff = implementation.simulatedDiff;
      changedPaths = implementation.changedPaths ?? [];
    }
    if (realImplementation ? JSON.stringify(await readChanges()) === JSON.stringify(startingChanges) : !implementation.changed) {
      const message = noReviewableChangesMessage(tracker?.source, "Implementation produced no reviewable changes.");
      emit("no_changes", message);
      return makeResult(message);
    }

    if (!(await approveChecks())) {
      emit("blocked_permissions", "A configured local check was not approved.");
      return makeResult("A configured local check was not approved.");
    }
    emit("running_checks", input.config.localChecks.length > 0
      ? `Running ${input.config.localChecks.length} explicitly configured local check(s).`
      : "No local checks are configured.");
    const initialChecks = await runLocalChecks(
      input.config.localChecks,
      input.repository,
      input.config.checkTimeoutMinutes * 60_000,
      input.config.terminationGracePeriodMs,
      workflowController.signal,
    );
    checks.push(...initialChecks);
    if (realImplementation) {
      const changes = await readChanges();
      workingTreeEntries = changes.entries;
      diff = changes.diff;
      changedPaths = changes.paths;
    } else {
      workingTreeEntries = await (await readChanges()).entries;
    }
    ensureActive();
    if (initialChecks.some((check) => !check.passed)) {
      emit("validation_failed", "One or more configured local checks failed.");
      return makeResult(`Validation failed after the ${realImplementation ? "implementation" : "simulated implementation"}.`);
    }
    if (!realImplementation && JSON.stringify(await readChanges()) !== JSON.stringify(startingChanges)) {
      emit("validation_failed", "A local check modified the workspace during a mock workflow.");
      return makeResult("Local checks changed workspace files; the mock diff cannot review those changes.");
    }
    if (realImplementation && changedPaths.length === 0) {
      const message = noReviewableChangesMessage(tracker?.source, "No reviewable changes remain after local checks.");
      emit("no_changes", message);
      return makeResult(message);
    }

    emit("reviewing", realReview
      ? `Codex CLI is reviewing the ${realImplementation ? "actual workflow diff" : "in-memory simulated change"} in its read-only sandbox.`
      : "Mock Codex is reviewing the in-memory simulated change.");
    let review: AgentResult;
    const reviewAnswers: { question: string; answer: string }[] = [];
    try {
      providerRequestAttempted ||= realReview;
      while (true) {
        review = await awaitAbortable(input.codex.execute({
          taskId, mode: "review", repository: input.repository, task: executionTask,
          diff, simulatedDiff, clarifications: reviewAnswers, signal: workflowController.signal,
          changeSource: tracker.source,
          implementationSummary, preExistingPaths: input.startingEntries ?? startingChanges?.paths,
        }), workflowController.signal, abortFailure);
        ensureActive();
        if (!review.question) break;
        const beforeAnswer = realImplementation ? await readChanges() : undefined;
        await askQuestion("reviewing", review.question, reviewAnswers);
        if (beforeAnswer) {
          const afterAnswer = await readChanges();
          if (JSON.stringify(afterAnswer) !== JSON.stringify(beforeAnswer)) {
            throw new Error("The workspace changed while waiting for a review answer. Inspect the diff before continuing.");
          }
        }
      }
    } catch (error) {
      if (workflowController.signal.aborted) throw abortFailure();
      if (error instanceof CodexProviderError) {
        if (error.kind === "timed_out") {
          emit("timed_out", error.message);
          return makeResult("Codex review timed out.");
        }
        if (error.kind === "cancelled") throw abortFailure();
        if (error.kind === "unavailable" || error.kind === "capability_missing") {
          emit("blocked_provider", error.message);
          return makeResult("Codex review is blocked because the provider is unavailable.");
        }
        if (error.kind === "authentication" || error.kind === "quota") {
          emit("blocked_auth_or_quota", error.message);
          return makeResult("Codex review is blocked by authentication or account quota.");
        }
        if (error.kind === "permissions") {
          emit("blocked_permissions", error.message);
          return makeResult("Codex review is blocked by the read-only sandbox policy.");
        }
      }
      emit("review_failed", errorMessage(error));
      return makeResult("Review failed.");
    }
    ensureActive();
    reviewSummary = review.message.slice(0, 4_000);
    if (review.metrics) metrics.push({ provider: input.codex.id, ...review.metrics });

    if (realReview && !realImplementation) {
      finalFindings = review.findings;
      if (finalFindings.length > 0) {
        emit("completed_with_findings", `Codex review reported ${finalFindings.length} finding(s).`);
        return makeResult("Codex read-only review completed with findings. No correction was attempted.");
      }
      emit("completed_clean", "Codex read-only review completed without findings.");
      return makeResult("Codex read-only review completed without findings. No workspace changes were made.");
    }

    const candidates = eligibleFindings(
      review.findings,
      changedPaths,
      input.config.findingThreshold,
    );
    const eligibleSet = new Set(candidates);
    const uncorrectableFindings = review.findings.filter((finding) => !eligibleSet.has(finding));
    if (candidates.length === 0) {
      finalFindings = review.findings;
      if (finalFindings.length > 0) {
        emit("completed_with_findings", `${finalFindings.length} reported finding(s) were not eligible for correction.`);
        return makeResult("Review completed with findings that could not be corrected under the configured rules.");
      }
      emit("completed_clean", `${realImplementation ? "Codex" : "Mock"} review completed without findings.`);
      return makeResult(realImplementation
        ? "Workflow completed. The actual diff and configured checks passed review."
        : "Mock workflow completed. The simulated diff exists only in memory.");
    }

    emit("correcting", `${realImplementation ? "Claude CLI" : "Mock Claude"} is evaluating ${candidates.length} eligible finding(s) for one correction pass.`);
    const correctionAnswers: { question: string; answer: string }[] = [];
    let partialCorrectionDiff = diff;
    let correction: AgentResult;
    while (true) {
      correction = await awaitAbortable(input.claude.execute({
        taskId, mode: "correct", repository: input.repository, task: executionTask,
        diff: partialCorrectionDiff, simulatedDiff, findings: candidates, clarifications: correctionAnswers,
        signal: workflowController.signal, readChanges, changeSource: tracker.source,
      }), workflowController.signal, abortFailure);
      ensureActive();
      if (!correction.question) break;
      const changes = await readChanges();
      const snapshot = JSON.stringify({ diff: changes.diff, entries: changes.entries });
      partialCorrectionDiff = changes.diff;
      await askQuestion("correcting", changes.diff !== diff
        ? `${correction.question}\n\nClaude has already changed files during correction. Those changes will be kept while you answer.`
        : correction.question, correctionAnswers);
      const current = await readChanges();
      if (JSON.stringify({ diff: current.diff, entries: current.entries }) !== snapshot) {
        throw new Error("The workspace changed while waiting for a correction answer. Inspect the diff before continuing.");
      }
    }
    ensureActive();
    correctionSummary = correction.message;
    if (correction.metrics) metrics.push({ provider: input.claude.id, ...correction.metrics });
    if (!realImplementation && correction.simulatedDiff) {
      simulatedDiff = `${simulatedDiff ?? ""}\n\n${correction.simulatedDiff}`.trim();
    }
    const remaining = correction.correction?.remaining ?? candidates;
    const unconfirmed = correction.correction
      ? candidates.filter((finding) => !correction.correction?.confirmed.includes(finding))
      : [];
    finalFindings = [...uncorrectableFindings, ...unconfirmed, ...remaining];
    if (!(await approveChecks())) {
      emit("blocked_permissions", "A configured local check was not approved after correction.");
      return makeResult("A configured local check was not approved after correction.");
    }
    emit("running_checks", `Re-running configured local checks after the ${realImplementation ? "actual" : "simulated"} correction.`);
    const correctionChecks = await runLocalChecks(
      input.config.localChecks,
      input.repository,
      input.config.checkTimeoutMinutes * 60_000,
      input.config.terminationGracePeriodMs,
      workflowController.signal,
    );
    checks.push(...correctionChecks);
    if (realImplementation) {
      const changes = await readChanges();
      workingTreeEntries = changes.entries;
      diff = changes.diff;
      changedPaths = changes.paths;
    } else {
      workingTreeEntries = await (await readChanges()).entries;
    }
    ensureActive();
    if (correctionChecks.some((check) => !check.passed)) {
      emit("validation_failed", "One or more configured local checks failed after correction.");
      return makeResult(`Validation failed after the ${realImplementation ? "correction" : "simulated correction"}.`);
    }
    if (!realImplementation && JSON.stringify(await readChanges()) !== JSON.stringify(startingChanges)) {
      emit("validation_failed", "A local check modified the workspace during a mock workflow.");
      return makeResult("Local checks changed workspace files; the mock diff cannot review those changes.");
    }

    if (finalFindings.length > 0) {
      emit("completed_with_findings", `${finalFindings.length} reported finding(s) remain after correction.`);
      return makeResult(`${realImplementation ? "Claude" : "Mock"} correction completed, with reported findings that were not corrected.`);
    }
    emit("completed_clean", "The correction addressed eligible findings and configured checks passed.");
    return makeResult(realImplementation
      ? "Workflow completed. The final diff includes the correction and local-check changes; no second Codex review was run."
      : "Mock workflow completed. All changes remain simulated in memory.");
  } catch (error) {
    if (realImplementation) {
      try {
        const changes = await readChanges();
        workingTreeEntries = changes.entries;
        diff = changes.diff;
      } catch {
        try { workingTreeEntries = await (await readChanges()).entries; } catch { /* Preserve the original failure. */ }
      }
    }
    if (timedOut || (error instanceof ProcessFailure && error.kind === "timed_out")) {
      if ((state as WorkflowState) !== "timed_out") emit("timed_out", "Workflow timed out.");
      return makeResult("Workflow exceeded the configured timeout.");
    }
    if (workflowController.signal.aborted || (error instanceof ProcessFailure && error.kind === "cancelled")) {
      if ((state as WorkflowState) !== "cancelled") emit("cancelled", "Workflow cancelled.");
      return makeResult("Workflow cancelled.");
    }
    if (error instanceof ClaudeProviderError) {
      if (error.kind === "timed_out") emit("timed_out", error.message);
      else if (error.kind === "cancelled") emit("cancelled", error.message);
      else if (error.kind === "authentication" || error.kind === "quota") emit("blocked_auth_or_quota", error.message);
      else if (error.kind === "permissions") emit("blocked_permissions", error.message);
      else if (error.kind === "gate_missing" || error.kind === "capability_missing" || error.kind === "unavailable") emit("blocked_provider", error.message);
      else emit("failed", error.message);
      return makeResult(error.message);
    }
    if ((state as WorkflowState) === "reviewing") {
      emit("review_failed", errorMessage(error));
      return makeResult("Mock review failed.");
    }
    emit("failed", errorMessage(error));
    return makeResult(errorMessage(error));
  } finally {
    clearTimeout(timeout);
    input.signal.removeEventListener("abort", onExternalAbort);
  }
}

// Kept for existing embedders of the mock-only vertical slice.
export const runMockWorkflow = runWorkflow;

function noReviewableChangesMessage(source: WorkspaceChanges["source"] | undefined, lead: string): string {
  const scope = source === "git"
    ? "The Git diff is empty."
    : "Snapshot mode skips node_modules, dist, build, coverage, .cache, .venv and target; changes only in those directories are outside review and reporting scope.";
  return `${lead} ${scope} Codex was not called.`;
}

export function eligibleFindings(
  findings: Finding[],
  changedPaths: string[],
  threshold: FindingSeverity,
): Finding[] {
  const paths = new Set(changedPaths);
  const seen = new Set<string>();
  const eligible: Finding[] = [];
  for (const finding of findings) {
    if (!isFindingSeverity(finding.severity) || severityRank(finding.severity) < severityRank(threshold)) continue;
    if (typeof finding.file !== "string" || typeof finding.evidence !== "string" || typeof finding.summary !== "string") continue;
    if (!paths.has(finding.file) || !Number.isInteger(finding.line) || finding.line < 1) continue;
    if (finding.evidence.trim().length === 0 || finding.summary.trim().length === 0) continue;
    const key = `${finding.file}:${finding.line}:${finding.summary}`;
    if (seen.has(key)) continue;
    seen.add(key);
    eligible.push(finding);
    if (eligible.length === 10) break;
  }
  return eligible;
}

function severityRank(severity: FindingSeverity): number {
  const ranks: Record<FindingSeverity, number> = {
    Critical: 4,
    High: 3,
    Medium: 2,
    Low: 1,
    Info: 0,
  };
  return ranks[severity];
}

function awaitAbortable<T>(promise: Promise<T>, signal: AbortSignal, abortFailure: () => Error): Promise<T> {
  if (signal.aborted) return Promise.reject(abortFailure());
  return new Promise((resolve, reject) => {
    const onAbort = (): void => {
      cleanup();
      reject(abortFailure());
    };
    const cleanup = (): void => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error: unknown) => {
        cleanup();
        reject(error);
      },
    );
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown workflow error.";
}
