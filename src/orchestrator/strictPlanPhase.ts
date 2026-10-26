import { ExecutionPermission } from "../configuration/config";
import {
  StrictConsensus, StrictHumanApproval, StrictObjection, StrictOutcomeReason, StrictPhaseBudget, StrictPlan,
  StrictPlanQuestion, StrictPlanRecord, StrictPlanRevisionSource, StrictProviderApproval, StrictSessionRecord,
  StrictTerminalState, StrictValidationError,
} from "../shared/strict";
import { StrictLimits } from "../shared/strictLimits";
import { ProviderKind, ProviderMetric, StrictWorkflowEvent, StrictWorkflowState } from "../shared/types";
import { assertWorkflowTransition } from "./stateMachine";
import { StrictBudgetTracker, StrictClock, StrictLimitReachedError, systemStrictClock } from "./strictBudget";
import { answerStrictPlanQuestion, canonicalizeStrictPlan, validateStrictPlan } from "./strictPlanHash";
import { StrictBaselineError, StrictBaselineGuard, StrictPlanningProvider, StrictProviderError } from "./strictProviders";
import { parseStrictPlanProposal, parseStrictPlanResponse } from "./strictResponses";
import { withDeadline } from "./strictDeadline";


export interface StrictPlanApprovalRequest {
  plan: StrictPlan;
  planHash: string;
  canonicalPlan: string;
  consensus: StrictConsensus;
  /** Absent when the plan declares its file list incomplete or not estimable. */
  expectedFileCount?: number;
  expectedFilesComplete: boolean;
  limits: StrictLimits;
  /** Set when the previous answer at this gate could not be accepted. */
}

export type StrictPlanApprovalDecision =
  | { kind: "approve"; executionPermission: ExecutionPermission; note?: string }
  | { kind: "refuse"; note?: string }
  | { kind: "revise"; plan: StrictPlan; note?: string };

export interface StrictPlanHumanGate {
  askQuestion(question: StrictPlanQuestion, signal: AbortSignal): Promise<string | undefined>;
  requestApproval(request: StrictPlanApprovalRequest, signal: AbortSignal): Promise<StrictPlanApprovalDecision>;
}

export interface StrictPlanPhaseInput {
  taskId: string;
  repository: string;
  /** Working directory for provider processes and local checks: the pinned root. */
  workingDirectory: string;
  task: string;
  /** Earlier draft to re-evaluate. No provider or human decision is carried over. */
  continuedPlan?: StrictPlan;
  /** Check ids the task authorised; a plan may name only these. */
  authorizedChecks: string[];
  /** Frozen when the task started; the approval gate does not change them. */
  limits: StrictLimits;
  claude: StrictPlanningProvider;
  codex: StrictPlanningProvider;
  baseline: StrictBaselineGuard;
  human: StrictPlanHumanGate;
  signal: AbortSignal;
  onEvent: (event: StrictWorkflowEvent) => void;
  clock?: StrictClock;
}

interface StrictPlanPhaseRecord {
  plans: StrictPlanRecord[];
  sessions: StrictSessionRecord[];
  events: StrictWorkflowEvent[];
  metrics: ProviderMetric[];
  budget: StrictPhaseBudget;
  consensus?: StrictConsensus;
}

export interface StrictPlanPhaseSuccess extends StrictPlanPhaseRecord {
  ok: true;
  approvedPlan: StrictPlanRecord;
  consensus: StrictConsensus;
  humanApproval: StrictHumanApproval;
  /** The frozen limits phase B must use. */
  limits: StrictLimits;
  /** Phase B starts here; this phase does not perform that transition. */
  nextState: "implementing";
}

export type StrictPlanPhaseFailureState = Exclude<
  StrictTerminalState,
  "completed_clean" | "no_changes" | "validation_failed" | "review_failed" | "blocked_untrusted_workspace"
>;

export interface StrictPlanPhaseFailure extends StrictPlanPhaseRecord {
  ok: false;
  state: StrictPlanPhaseFailureState;
  reason: StrictOutcomeReason;
  limits: StrictLimits;
  humanApproval?: StrictHumanApproval;
}

export type StrictPlanPhaseResult = StrictPlanPhaseSuccess | StrictPlanPhaseFailure;

class StrictInvalidResponseError extends Error {
  constructor(readonly provider: ProviderKind, readonly errors: StrictValidationError[]) {
    super(`${provider} returned an invalid structured response after every allowed retry.`);
    this.name = "StrictInvalidResponseError";
  }
}

class StrictPlanSizeError extends Error {
  constructor(bytes: number, limit: number) {
    super(`The canonical plan is ${bytes} bytes, above the ${limit}-byte limit.`);
    this.name = "StrictPlanSizeError";
  }
}

const SAFE_VALIDATION_PATH = /^\$(?:\[(?:0|[1-9]\d*)\]|\.(?:schemaVersion|provider|planHash|decision|objections|revisedPlan|summary|id|target|reference|rationale|blocking|objective|constraints|acceptanceCriteria|expectedFiles|expectedFilesComplete|risks|checks|questions|question|answer))*$/;

function safeValidationPath(path: string | undefined): string {
  return path && path.length <= 120 && SAFE_VALIDATION_PATH.test(path) ? path : "$";
}

/**
 * Phase A. Claude drafts the canonical plan, Claude and Codex evaluate the same hash in
 * turn, and the user approves that exact hash before anything is implemented. A plan
 * revision or a human answer produces a new hash and voids both provider approvals.
 * A rejection, an unanswered question, a stall or a ceiling cannot end in agreement.
 */
export async function runStrictPlanPhase(input: StrictPlanPhaseInput): Promise<StrictPlanPhaseResult> {
  const clock = input.clock ?? systemStrictClock;
  const budget = new StrictBudgetTracker("plan", input.limits, clock);
  const events: StrictWorkflowEvent[] = [];
  const plans: StrictPlanRecord[] = [];
  const sessions: StrictSessionRecord[] = [];
  const metrics: ProviderMetric[] = [];
  const providers = [input.claude, input.codex];
  // Widened on purpose: emit() reassigns it from a closure, which narrowing does not track.
  let state = "preflight" as StrictWorkflowState;
  let consensus: StrictConsensus | undefined;
  let canonicalPlan = "";

  const timestamp = (): string => new Date(clock.calendarMs()).toISOString();

  const push = (next: StrictWorkflowState, message: string): void => {
    const event: StrictWorkflowEvent = {
      mode: "strict", taskId: input.taskId, state: next, phase: "plan", message, timestamp: timestamp(),
    };
    events.push(event);
    input.onEvent(event);
  };

  const emit = (next: StrictWorkflowState, message: string): void => {
    assertWorkflowTransition("strict", state, next);
    state = next;
    push(next, message);
  };

  /** A message that reports progress inside the current state; never a transition. */
  const note = (message: string): void => push(state, message);

  const phaseRecord = (): StrictPlanPhaseRecord => ({
    plans: [...plans], sessions: [...sessions], events: [...events], metrics: [...metrics],
    budget: budget.snapshot(), consensus,
  });

  /**
   * The Output Channel logs event messages, so an event carries a message written to be
   * safe: no provider prose, no question text, no path. The full reason goes to the chat
   * and the report.
   */
  const fail = (next: StrictPlanPhaseFailureState, reason: StrictOutcomeReason): StrictPlanPhaseFailure => {
    budget.suspend();
    if (state !== next) {
      emit(next, `Strict phase A stopped: ${reason.code}. The reason and the next action are in the Countersign chat report.`);
    }
    return { ...phaseRecord(), ok: false, state: next, reason, limits: input.limits };
  };

  const ensureActive = (): void => {
    if (input.signal.aborted) throw new StrictProviderError("cancelled", "The task was cancelled.");
  };

  const rememberSession = (provider: StrictPlanningProvider, sessionId?: string, providerVersion?: string): void => {
    const existing = sessions.find((session) => session.provider === provider.kind);
    if (!existing) return;
    if (sessionId) existing.sessionId = sessionId;
    if (providerVersion) existing.providerVersion = providerVersion;
  };

  const exchange = async <T>(
    provider: StrictPlanningProvider,
    send: (signal: AbortSignal, timeoutMs: number, retryErrors: StrictValidationError[] | undefined, previousRaw: string | undefined) => Promise<{
      raw: string; sessionId?: string; providerVersion?: string; metrics?: Omit<ProviderMetric, "provider">;
    }>,
    validate: (raw: string) => { ok: true; value: T } | { ok: false; errors: StrictValidationError[] },
  ): Promise<T> => {
    let retryErrors: StrictValidationError[] | undefined;
    let previousRaw: string | undefined;
    // Every attempt, retries included, counts against the phase request ceiling.
    for (let attempt = 0; attempt <= input.limits.maxStructuredRetries; attempt++) {
      ensureActive();
      budget.countProviderRequest();
      const timeoutMs = budget.requestTimeoutMs();
      let reply;
      try {
        reply = await withDeadline((signal) => send(signal, timeoutMs, retryErrors, previousRaw), timeoutMs, input.signal);
      } catch (error) {
        if (error instanceof StrictProviderError && error.kind === "timed_out" &&
            timeoutMs < input.limits.providerRequestTimeoutMinutes * 60_000 && !input.signal.aborted) {
          throw budget.phaseActiveLimitError();
        }
        throw error;
      }
      rememberSession(provider, reply.sessionId, reply.providerVersion);
      if (reply.metrics) metrics.push({ provider: provider.id, ...reply.metrics });
      await input.baseline.assertUnchanged();
      const validation = validate(reply.raw);
      if (validation.ok) return validation.value;
      retryErrors = validation.errors;
      previousRaw = Buffer.byteLength(reply.raw, "utf8") <= input.limits.maxStructuredResponseBytes
        ? reply.raw : undefined;
      // Only known JSON fields and numeric indices may reach the Output Channel.
      note(`${provider.kind} returned an invalid structured response (${validation.errors[0]?.code ?? "invalid"} at ${safeValidationPath(validation.errors[0]?.path)}).`);
    }
    throw new StrictInvalidResponseError(provider.kind, retryErrors ?? []);
  };

  const recordPlan = (plan: StrictPlan, source: StrictPlanRevisionSource): StrictPlanRecord => {
    const canonical = canonicalizeStrictPlan(plan);
    if (canonical.bytes > input.limits.maxCanonicalPlanBytes) {
      throw new StrictPlanSizeError(canonical.bytes, input.limits.maxCanonicalPlanBytes);
    }
    canonicalPlan = canonical.canonical;
    const entry: StrictPlanRecord = {
      hash: canonical.hash,
      schemaVersion: canonical.plan.schemaVersion,
      canonicalBytes: canonical.bytes,
      revision: plans.length + 1,
      source,
      createdAt: timestamp(),
      plan: canonical.plan,
    };
    plans.push(entry);
    return entry;
  };

  try {
    for (const provider of providers) {
      ensureActive();
      const capability = await provider.checkPlanningCapability(input.signal);
      sessions.push({
        role: provider.kind === "claude" ? "plan_claude" : "plan_codex",
        provider: provider.kind,
        providerVersion: capability.providerVersion,
        sessionId: capability.sessionId,
        isolation: capability.freshContext ? "verified_new_context" : "unverifiable",
        startedAt: timestamp(),
      });
      if (!capability.available) {
        return fail("blocked_provider", {
          code: "provider_unavailable",
          message: capability.reason ?? `${provider.kind} is not available for Strict planning.`,
          nextAction: "Check the provider CLI login and version, then start the task again.",
        });
      }
      if (!capability.freshContext) {
        return fail("blocked_provider", {
          code: "session_isolation_unverifiable",
          message: capability.reason ?? `${provider.kind} cannot prove a planning context without inherited history.`,
          nextAction: "Install a provider version whose fresh-context behaviour can be verified, then start again.",
        });
      }
      if (!capability.readOnlyToolsEnforced) {
        return fail("blocked_permissions", {
          code: "planning_tools_not_read_only",
          message: capability.reason ?? `${provider.kind} cannot enforce read-only tools for planning at startup.`,
          nextAction: "Strict planning needs a provider that blocks writes, commands and network where the tools start. A prompt instruction is not enough.",
        });
      }
    }
    await input.baseline.assertUnchanged();

    emit("planning", input.continuedPlan
      ? "Strict phase A started: re-evaluating a saved plan against the current workspace. No earlier approval carries over."
      : "Strict phase A started: Claude is drafting the canonical plan under read-only tools.");
    budget.resume();

    const candidate = input.continuedPlan
      ? validateStrictPlan(input.continuedPlan, { authorizedChecks: input.authorizedChecks })
      : undefined;
    const currentPlan = candidate?.ok ? candidate.value : await exchange(
      input.claude,
      (signal, timeoutMs, retryErrors, previousRaw) => input.claude.request({
        kind: "propose",
        taskId: input.taskId,
        repository: input.repository,
        workingDirectory: input.workingDirectory,
        task: input.task,
        authorizedChecks: input.authorizedChecks,
        answeredQuestions: [],
        signal,
        timeoutMs,
        maxResponseBytes: input.limits.maxStructuredResponseBytes,
        retryErrors,
        previousRaw,
      }),
      (raw) => parseStrictPlanProposal(raw, {
        authorizedChecks: input.authorizedChecks,
        maxResponseBytes: input.limits.maxStructuredResponseBytes,
      }),
    );
    if (input.continuedPlan && !candidate?.ok) {
      note("The saved plan does not match current Strict checks, so Claude drafted a new plan.");
    }
    let current = recordPlan(currentPlan, candidate?.ok ? "continued" : "initial");
    note(`Plan revision ${current.revision} has hash ${current.hash}.`);

    const approvals = new Map<ProviderKind, StrictProviderApproval>();
    const evaluatedHashes = new Set<string>();
    // Phase A has no stall ceiling of its own in the specification, so it reuses the
    // configured one. A revision that returns an already evaluated hash is no progress.
    const stallCeiling = input.limits.implementationPhase.stallCycles;
    let planObjections: StrictObjection[] = [];
    let priorRevisionObjections: StrictObjection[] = [];
    let revisionsWithoutProgress = 0;

    while (true) {
      ensureActive();
      budget.assertActiveTimeRemaining();

      const pending = current.plan.questions.find((question) => (question.answer ?? "").trim().length === 0);
      if (pending) {
        budget.suspend();
        emit("awaiting_input", `The plan needs a human decision before it can be agreed (question ${pending.id}). It is in the chat.`);
        const answer = await input.human.askQuestion(pending, input.signal);
        ensureActive();
        if (!answer || answer.trim().length === 0) {
          return fail("cancelled", {
            code: "plan_question_unanswered",
            message: `The plan question "${pending.question}" was left unanswered, so no agreement exists.`,
            nextAction: "Answer the question, or start a new task with a plan that does not need that decision.",
          });
        }
        await input.baseline.assertUnchanged();
        budget.resume();
        current = recordPlan(answerStrictPlanQuestion(current.plan, pending.id, answer.trim()), "human_revision");
        approvals.clear();
        planObjections = [];
        priorRevisionObjections = [];
        consensus = undefined;
        emit("planning", `The answer is now part of the plan: revision ${current.revision}, hash ${current.hash}. Both provider approvals are void.`);
        continue;
      }

      const nextProvider = providers.find((provider) => approvals.get(provider.kind)?.hash !== current.hash);
      if (nextProvider) {
        const message = `${nextProvider.kind} is evaluating plan hash ${current.hash}.`;
        if (state === "awaiting_consensus") note(message);
        else emit("awaiting_consensus", message);
        const evaluated = current;
        evaluatedHashes.add(evaluated.hash);
        const response = await exchange(
          nextProvider,
          (signal, timeoutMs, retryErrors, previousRaw) => nextProvider.request({
            kind: "evaluate",
            taskId: input.taskId,
            repository: input.repository,
            workingDirectory: input.workingDirectory,
            task: input.task,
            plan: evaluated.plan,
            planHash: evaluated.hash,
            canonicalPlan,
            priorObjections: [...priorRevisionObjections, ...planObjections],
            authorizedChecks: input.authorizedChecks,
            signal,
            timeoutMs,
            maxResponseBytes: input.limits.maxStructuredResponseBytes,
            retryErrors,
            previousRaw,
          }),
          (raw) => parseStrictPlanResponse(raw, {
            provider: nextProvider.kind,
            plan: evaluated.plan,
            planHash: evaluated.hash,
            authorizedChecks: input.authorizedChecks,
            maxResponseBytes: input.limits.maxStructuredResponseBytes,
          }),
        );

        if (response.decision === "reject") {
          planObjections = [...planObjections, ...response.objections];
          consensus = {
            subject: "plan",
            hash: evaluated.hash,
            approvals: [...approvals.values(), providerDecision(nextProvider, evaluated.hash, "reject", timestamp(), sessions)],
            openObjections: planObjections,
          };
          return fail("consensus_not_reached", {
            code: "plan_rejected_by_provider",
            message: `${nextProvider.kind} rejected plan hash ${evaluated.hash}: ${response.summary}`,
            // The provider's own prose stays out of the Output Channel.
            nextAction: "Narrow or rewrite the request and start a new Strict task.",
          });
        }

        if (response.decision === "revise") {
          const revised = recordPlan(response.revisedPlan as StrictPlan, "provider_revision");
          const noProgress = revised.hash === evaluated.hash || evaluatedHashes.has(revised.hash);
          revisionsWithoutProgress = noProgress ? revisionsWithoutProgress + 1 : 0;
          approvals.clear();
          // These objections describe the replaced hash. Pass them as context, but do
          // not report them as open objections on the revised plan after both approve.
          priorRevisionObjections = response.objections;
          planObjections = [];
          consensus = undefined;
          current = revised;
          if (revisionsWithoutProgress >= stallCeiling) {
            return fail("consensus_not_reached", {
              code: "stall",
              message: `Phase A produced ${revisionsWithoutProgress} consecutive revisions without reaching a new plan hash.`,
              nextAction: "Decide the open point yourself and start a new Strict task with a narrower plan.",
            });
          }
          emit("planning", `${nextProvider.kind} proposed revision ${revised.revision}; hash ${revised.hash} replaces ${evaluated.hash} and both approvals are void.`);
          continue;
        }

        approvals.set(nextProvider.kind,
          providerDecision(nextProvider, evaluated.hash, "approve", timestamp(), sessions));
        planObjections = [...planObjections, ...response.objections];
        note(`${nextProvider.kind} approved plan hash ${evaluated.hash}${response.objections.length > 0 ? ` with ${response.objections.length} non-blocking objection(s)` : ""}.`);
        // Objection text is shown in the chat report, never in the event stream.
        continue;
      }

      const blocking = planObjections.filter((objection) => objection.blocking);
      consensus = {
        subject: "plan",
        hash: current.hash,
        approvals: [...approvals.values()],
        openObjections: blocking,
        reachedAt: timestamp(),
      };

      budget.suspend();
      if (state !== "awaiting_human_approval") {
        emit("awaiting_human_approval",
          `Claude and Codex approved plan hash ${current.hash}. Nothing runs until you approve that same hash.`);
      }
      const decision = await input.human.requestApproval({
        plan: current.plan,
        planHash: current.hash,
        canonicalPlan,
        consensus,
        // Shown, never enforced: the plan's own estimate of how wide the change is.
        expectedFileCount: current.plan.expectedFilesComplete ? current.plan.expectedFiles.length : undefined,
        expectedFilesComplete: current.plan.expectedFilesComplete,
        limits: input.limits,
      }, input.signal);
      ensureActive();

      if (decision.kind === "refuse") {
        return fail("cancelled", {
          code: "plan_rejected_by_human",
          message: decision.note ?? "The plan was refused. Nothing was implemented.",
          nextAction: "Start a new Strict task with a different request or plan.",
        });
      }

      if (decision.kind === "revise") {
        const validated = validateStrictPlan(decision.plan, { authorizedChecks: input.authorizedChecks });
        if (!validated.ok) {
          return fail("failed", {
            code: "internal_error",
            message: `The edited plan is not a valid Strict plan: ${validated.errors[0]?.message ?? "unknown error"}`,
            nextAction: "Fix the edited plan and approve again, or start a new task.",
          });
        }
        await input.baseline.assertUnchanged();
        budget.resume();
        current = recordPlan(validated.value, "human_revision");
        approvals.clear();
        planObjections = [];
        priorRevisionObjections = [];
        consensus = undefined;
        emit("planning", `You edited the plan: revision ${current.revision}, hash ${current.hash}. Both provider approvals are void and phase A reopens.`);
        continue;
      }

      // The plan was agreed against this baseline; an approval that comes back to a moved
      // workspace is not an approval of what is on disk.
      await input.baseline.assertUnchanged();
      const humanApproval: StrictHumanApproval = {
        approved: true,
        planHash: current.hash,
        decidedAt: timestamp(),
        executionPermission: decision.executionPermission,
        ...(decision.note ? { note: decision.note } : {}),
      };
      note(`Approved with ${decision.executionPermission}. The scan and diff ceilings are unchanged and remain the only limits on how wide a change may be.`);
      return {
        ...phaseRecord(),
        ok: true,
        approvedPlan: current,
        consensus,
        humanApproval,
        limits: input.limits,
        nextState: "implementing",
      };
    }
  } catch (error) {
    const [failureState, reason] = failureFor(error, state);
    return fail(failureState, reason);
  } finally {
    budget.suspend();
  }
}

function providerDecision(
  provider: StrictPlanningProvider,
  hash: string,
  decision: "approve" | "reject",
  decidedAt: string,
  sessions: StrictSessionRecord[],
): StrictProviderApproval {
  const session = sessions.find((entry) => entry.provider === provider.kind);
  return {
    provider: provider.kind,
    subject: "plan",
    hash,
    decision,
    decidedAt,
    ...(session?.sessionId ? { sessionId: session.sessionId } : {}),
    ...(session?.providerVersion ? { providerVersion: session.providerVersion } : {}),
  };
}

function failureFor(error: unknown, state: StrictWorkflowState): [StrictPlanPhaseFailureState, StrictOutcomeReason] {
  if (error instanceof StrictLimitReachedError) {
    return ["consensus_not_reached", {
      code: "limit_reached",
      message: error.message,
      nextAction: "Use the continuation button on this Strict report to re-evaluate its last draft in a new task, or start a narrower Strict task. You can set the phase A request ceiling in Turn settings.",
      limit: error.breach,
    }];
  }
  if (error instanceof StrictInvalidResponseError) {
    return ["consensus_not_reached", {
      code: "invalid_structured_response",
      message: `${error.message} Last error: ${error.errors[0]?.message ?? "none recorded"}`,
      nextAction: "Try again, possibly with another model: the provider did not answer the Strict schema.",
    }];
  }
  if (error instanceof StrictPlanSizeError) {
    return ["consensus_not_reached", {
      code: "plan_too_large",
      message: error.message,
      nextAction: "Split the request into smaller tasks.",
    }];
  }
  if (error instanceof StrictBaselineError) {
    return ["failed", {
      code: error.kind === "changed" ? "workspace_changed" : "baseline_unavailable",
      message: error.message,
      nextAction: "Inspect the workspace changes, then start a new Strict task against a fresh baseline.",
    }];
  }
  if (error instanceof StrictProviderError) {
    if (error.kind === "local_limit") {
      return ["failed", {
        code: "limit_reached",
        message: error.message,
        nextAction: "Check the limit reported by Claude or its CLI configuration, then start again.",
      }];
    }
    if (error.kind === "protocol") {
      return ["consensus_not_reached", {
        code: "invalid_structured_response",
        message: error.message,
        nextAction: error.provider === "codex"
          ? "Codex could not complete the structured turn. Check its CLI diagnostic and update Countersign if it rejected the output schema."
          : "Try a narrower task or another model; Claude did not return the required Strict answer.",
      }];
    }
    if (error.kind === "cancelled") {
      return ["cancelled", {
        code: "cancelled",
        message: "The task was cancelled during phase A.",
        nextAction: "Start the task again when you are ready.",
      }];
    }
    if (error.kind === "timed_out") {
      return ["timed_out", {
        code: "timed_out",
        message: error.message,
        nextAction: "Start again, or raise the per-request timeout for a new task.",
      }];
    }
    if (error.kind === "authentication" || error.kind === "quota") {
      return ["blocked_auth_or_quota", {
        code: error.kind === "quota" ? "quota_exhausted" : "authentication_failed",
        message: error.message,
        nextAction: "Check the provider login or wait for the quota to reset, then start again.",
      }];
    }
    if (error.kind === "permissions") {
      return ["blocked_permissions", {
        code: "provider_permission_denied",
        message: error.message,
        nextAction: "Check which read-only operation the provider denied, then retry the task.",
      }];
    }
    if (error.kind === "unavailable" || error.kind === "capability_missing") {
      return ["blocked_provider", {
        code: "provider_unavailable",
        message: error.message,
        nextAction: "Check the provider CLI, then start again.",
      }];
    }
  }
  return ["failed", {
    code: "internal_error",
    message: error instanceof Error ? error.message : `Unknown phase A error in state ${state}.`,
    nextAction: "Report the failure with the Countersign report; nothing was implemented.",
  }];
}
