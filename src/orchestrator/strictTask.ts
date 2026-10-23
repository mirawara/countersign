import { randomUUID } from "node:crypto";
import { createStrictWorkspaceChanges, StrictWorkspace } from "../context/strictWorkspace";
import { ProcessFailure } from "../shared/process";
import {
  StrictBudgetReport, StrictMarkerReport, StrictOutcomeReason, StrictPhaseBudget, StrictPlanRecord,
  StrictResultCore, StrictWorkflowResult,
} from "../shared/strict";
import { StrictLimitOverrides, StrictLimits, resolveStrictLimits } from "../shared/strictLimits";
import { StrictMarkerStore } from "../shared/strictMarker";
import { CheckResult, LocalCheck, StrictWorkflowEvent } from "../shared/types";
import { WorkflowModelSelection } from "../configuration/config";
import { acquireRepositoryLock } from "../shared/repositoryLock";
import { StrictClock, systemStrictClock } from "./strictBudget";
import {
  runStrictImplementationPhase, StrictLifecycleMarker, StrictPauseGate,
} from "./strictImplementationPhase";
import { runStrictPlanPhase, StrictPlanHumanGate } from "./strictPlanPhase";
import {
  StrictBaselineError, StrictBaselineGuard, StrictImplementationProvider, StrictPlanningProvider, StrictReviewProvider,
} from "./strictProviders";

export interface StrictTaskInput {
  repository: string;
  task: string;
  localChecks: LocalCheck[];
  declaredGeneratedOutputs?: string[];
  limitOverrides?: StrictLimitOverrides;
  planningClaude: StrictPlanningProvider;
  planningCodex: StrictPlanningProvider;
  implementationClaude: StrictImplementationProvider;
  reviewCodex: StrictReviewProvider;
  human: StrictPlanHumanGate;
  pause: StrictPauseGate;
  /** Runs the configured checks; the working directory is the pinned root. */
  runChecks: (checks: LocalCheck[], signal: AbortSignal, workingDirectory: string) => Promise<CheckResult[]>;
  markers?: StrictMarkerStore;
  selectedModels?: WorkflowModelSelection;
  signal: AbortSignal;
  onEvent: (event: StrictWorkflowEvent) => void;
  clock?: StrictClock;
}

const EMPTY_PHASE_BUDGET: StrictPhaseBudget = { providerRequests: 0, activeMs: 0, wallClockMs: 0 };

/**
 * One Strict task: phase A, then phase B, then one report. The repository lock and the
 * lifecycle marker are held around both phases. Nothing here persists resumable state:
 * after a restart the task is gone and the user starts a new one against a new baseline.
 */
export async function runStrictTask(input: StrictTaskInput): Promise<StrictWorkflowResult> {
  const clock = input.clock ?? systemStrictClock;
  const taskId = randomUUID();
  const startedAt = new Date(clock.calendarMs()).toISOString();
  const events: StrictWorkflowEvent[] = [];
  const onEvent = (event: StrictWorkflowEvent): void => {
    events.push(event);
    input.onEvent(event);
  };

  const finish = (
    state: StrictWorkflowResult["state"],
    message: string,
    reason: StrictOutcomeReason | undefined,
    parts: Partial<StrictWorkflowResult>,
  ): StrictWorkflowResult => {
    const core: StrictResultCore = {
    mode: "strict",
    taskId,
    repository: input.repository,
    task: input.task,
    startedAt,
    finishedAt: new Date(clock.calendarMs()).toISOString(),
    message,
    limits: parts.limits ?? resolveStrictLimits(input.limitOverrides),
    limitBreaches: reason?.limit ? [reason.limit] : [],
    budget: parts.budget ?? { plan: EMPTY_PHASE_BUDGET, implementation: EMPTY_PHASE_BUDGET },
    plans: parts.plans ?? [],
    planConsensus: parts.planConsensus,
    humanApproval: parts.humanApproval,
    baseline: parts.baseline,
    snapshots: parts.snapshots ?? [],
    finalConsensus: parts.finalConsensus,
    sessions: parts.sessions ?? [],
    findings: parts.findings ?? [],
    checkRounds: parts.checkRounds ?? [],
    preExistingEntries: parts.preExistingEntries ?? [],
    preExistingStatus: parts.preExistingStatus,
    policyExclusions: parts.policyExclusions ?? [],
    unsupportedPaths: parts.unsupportedPaths ?? [],
    contentRetention: parts.contentRetention,
    pauses: parts.pauses ?? [],
    marker: markerReport(input.markers),
    events,
    metrics: parts.metrics ?? [],
    selectedModels: input.selectedModels,
    executionPermission: parts.humanApproval?.executionPermission,
    };
    // Built in two branches on purpose: only completed_clean may omit the reason, and a
    // blanket cast would let a result ship without its state or its reason.
    return state === "completed_clean"
      ? { ...core, state }
      : { ...core, state, reason: reason ?? internalReason(message) };
  };

  const blocking = input.markers?.blocksNewTask();
  if (blocking) {
    return finish("failed", "An earlier Strict task still has an active or unreadable marker.", {
      code: "marker_conflict",
      message: blocking.kind === "malformed"
        ? "A stored Strict marker does not match the expected schema, so this window cannot tell whether a task is running or was interrupted."
        : `A Strict marker written by another window (${blocking.marker.outcome}) is still stored, so this window cannot tell whether that task is running or was interrupted.`,
      nextAction: "Use Countersign: Clear Strict interruption marker once you know that task is not running, then start again.",
    }, {});
  }

  let releaseLock: (() => void) | undefined;
  let workspace: StrictWorkspace | undefined;
  try {
    releaseLock = acquireRepositoryLock(input.repository);
  } catch (error) {
    return finish("failed", "The repository is already busy.", {
      code: "internal_error",
      message: error instanceof Error ? error.message : "A Countersign task is already active in this repository.",
      nextAction: "Wait for the active task to finish, then start again.",
    }, {});
  }

  try {
    const limits = resolveStrictLimits(input.limitOverrides);
    const created = await createStrictWorkspaceChanges({ folder: input.repository, limits, signal: input.signal });
    if (!created.ok) {
      const state = created.failure.code === "cancelled" ? "cancelled" : "failed";
      // The perimeter's total size is never a reason to stop: the only scan ceiling that
      // can end a task here is the file count.
      const nextAction = created.failure.limit?.limit === "scan.maxScannedFiles"
        ? "Open a smaller workspace with fewer included files, then start a new Strict task."
        : created.failure.code === "cancelled"
        ? "Start a new Strict task when ready."
        : created.failure.code === "workspace_changed"
        ? "Let the workspace settle — a build or a sync was writing into it — then start a new Strict task."
        : "Fix the workspace problem above, then start a new Strict task.";
      return finish(state, created.failure.message, {
        code: created.failure.code,
        message: created.failure.message,
        nextAction,
        ...(created.failure.limit ? { limit: created.failure.limit } : {}),
      }, { limits });
    }
    workspace = created.workspace;
    const starting = startingWork(workspace);
    const preExistingEntries = starting.kind === "git" ? starting.entries : [];
    const preExistingStatus = starting.kind;
    if (input.signal.aborted) {
      return finish("cancelled", "The Strict task was cancelled.", {
        code: "cancelled",
        message: "The Strict task was cancelled before phase A started.",
        nextAction: "Start a new task when ready.",
      }, { limits, baseline: workspace.identity, preExistingEntries, preExistingStatus });
    }
    // Written before the first provider request of the task, which is a phase A request.
    await input.markers?.markActive(taskId);

    const planPhase = await runStrictPlanPhase({
      taskId,
      repository: input.repository,
      workingDirectory: workspace.pinnedRoot,
      task: input.task,
      authorizedChecks: input.localChecks.map((check) => check.id),
      limits,
      claude: input.planningClaude,
      codex: input.planningCodex,
      baseline: planningGuard(workspace, input.signal),
      human: input.human,
      signal: input.signal,
      onEvent,
      clock,
    });

    if (!planPhase.ok) {
      if (planPhase.state === "cancelled" || planPhase.state === "timed_out") {
        await input.markers?.markInterrupted(taskId);
      } else {
        await input.markers?.markFinished(taskId);
      }
      return finish(planPhase.state, planPhase.reason.message, planPhase.reason, {
        limits: planPhase.limits,
        budget: { plan: planPhase.budget, implementation: EMPTY_PHASE_BUDGET },
        plans: planPhase.plans,
        planConsensus: planPhase.consensus,
        baseline: workspace.identity,
        sessions: planPhase.sessions,
        metrics: planPhase.metrics,
        preExistingEntries,
        preExistingStatus,
      });
    }

    const implementationPhase = await runStrictImplementationPhase({
      taskId,
      repository: input.repository,
      workingDirectory: workspace.pinnedRoot,
      task: input.task,
      approvedPlan: planPhase.approvedPlan,
      humanApproval: planPhase.humanApproval,
      limits: planPhase.limits,
      localChecks: input.localChecks,
      declaredGeneratedOutputs: input.declaredGeneratedOutputs ?? [],
      workspace,
      claude: input.implementationClaude,
      codex: input.reviewCodex,
      runChecks: input.runChecks,
      preExistingEntries,
      pause: input.pause,
      marker: lifecycleMarker(input.markers, taskId),
      signal: input.signal,
      onEvent,
      clock,
    });

    const shared: Partial<StrictWorkflowResult> = {
      limits: planPhase.limits,
      budget: { plan: planPhase.budget, implementation: implementationPhase.budget },
      plans: planPhase.plans,
      planConsensus: planPhase.consensus,
      humanApproval: planPhase.humanApproval,
      baseline: workspace.identity,
      snapshots: implementationPhase.snapshots,
      finalConsensus: implementationPhase.finalConsensus,
      sessions: [...planPhase.sessions, ...implementationPhase.sessions],
      findings: implementationPhase.findings,
      checkRounds: implementationPhase.checkRounds,
      preExistingEntries,
      preExistingStatus,
      policyExclusions: implementationPhase.policyExclusions,
      unsupportedPaths: implementationPhase.unsupportedPaths,
      contentRetention: implementationPhase.contentRetention,
      pauses: implementationPhase.pauses,
      metrics: [...planPhase.metrics, ...implementationPhase.metrics],
    };

    if (!implementationPhase.ok) {
      return finish(implementationPhase.state, implementationPhase.reason.message, implementationPhase.reason, shared);
    }
    return finish("completed_clean",
      successMessage(planPhase.approvedPlan, implementationPhase.finalConsensus.hash, input.localChecks.length > 0),
      undefined, shared);
  } catch (error) {
    await input.markers?.markInterrupted(taskId).catch(() => undefined);
    // A cancellation thrown on the way — reading Git, for instance — is a cancelled task,
    // not an internal error.
    if (input.signal.aborted || (error instanceof ProcessFailure && error.kind === "cancelled")) {
      return finish("cancelled", "The Strict task was cancelled.", {
        code: "cancelled",
        message: "The Strict task was cancelled before it could finish.",
        nextAction: "Start a new task when ready.",
      }, {});
    }
    // Both phases report their failures as results; reaching here means something threw
    // where nothing should. The marker must not be left claiming an active task.
    return finish("failed", "The Strict task ended with an unexpected error.", {
      code: "internal_error",
      message: error instanceof Error ? error.message : "Unknown Strict task error.",
      nextAction: "Report the failure with the Countersign report; the workspace was not reverted.",
    }, {});
  } finally {
    await workspace?.close().catch(() => undefined);
    releaseLock?.();
  }
}

function successMessage(plan: StrictPlanRecord, digest: string, checksConfigured: boolean): string {
  // Never claim a check that was not configured: an unrun check is not a passed check.
  const checks = checksConfigured
    ? "the configured checks passed"
    : "no local check was configured, so none was run";
  return `Claude and Codex agreed on plan ${plan.hash.slice(0, 12)}…, you approved it, ${checks}, and both approved snapshot ${digest.slice(0, 12)}….`;
}

function internalReason(message: string): StrictOutcomeReason {
  return { code: "internal_error", message, nextAction: "Start a new Strict task." };
}

export type StartingWork =
  | { kind: "git"; entries: string[] }
  | { kind: "no_repository" }
  | { kind: "unavailable" };

/**
 * What was already in the workspace when the task started. Comparing the baseline with
 * itself always returns nothing, which would report a dirty repository as clean: the
 * Strict baseline *contains* that work. Git answers instead, read once with the baseline
 * through the pinned root, and the answer keeps its provenance — a folder without a
 * repository and a Git that could not answer are not the same thing as a clean tree.
 */
export function startingWork(workspace: StrictWorkspace): StartingWork {
  const git = workspace.startingGit;
  if (git.kind === "repository") return { kind: "git", entries: git.dirtyEntries };
  return git.kind === "none" ? { kind: "no_repository" } : { kind: "unavailable" };
}

/**
 * Phase A must not change files. The guard re-reads the perimeter and refuses to continue
 * when its digest moved under the plan.
 */
function planningGuard(workspace: StrictWorkspace, signal: AbortSignal): StrictBaselineGuard {
  let expected: string | undefined;
  return {
    identity: () => workspace.identity,
    assertUnchanged: async () => {
      const captured = await workspace.capture(signal);
      if (!captured.ok) {
        throw new StrictBaselineError("unavailable", captured.failure.message);
      }
      expected ??= captured.snapshot.record.digest;
      if (captured.snapshot.record.digest !== expected) {
        throw new StrictBaselineError("changed",
          "The workspace changed while the plan was being agreed. Inspect those changes before starting again.");
      }
    },
  };
}

function lifecycleMarker(store: StrictMarkerStore | undefined, taskId: string): StrictLifecycleMarker | undefined {
  if (!store) return undefined;
  return {
    markActive: () => store.markActive(taskId),
    markFinished: () => store.markFinished(taskId),
    markInterrupted: () => store.markInterrupted(taskId),
  };
}

function markerReport(store: StrictMarkerStore | undefined): StrictMarkerReport | undefined {
  if (!store) return undefined;
  const status = store.status();
  if (status.kind === "none") return { status: "none" };
  if (status.kind === "malformed") return { status: "malformed" };
  return { status: status.kind, outcome: status.marker.outcome, timestamp: status.marker.timestamp };
}

export type { StrictBudgetReport, StrictLimits };
