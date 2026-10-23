import {
  BALANCED_WORKFLOW_STATES, BalancedWorkflowState, STRICT_WORKFLOW_STATES, StrictWorkflowState,
  WorkflowMode, WorkflowState,
} from "../shared/types";

/**
 * The single authority on transitions. Every WorkflowState has one row, and each row
 * declares its allowed targets per mode. Balanced and Strict never share an edge: a
 * Strict-only state is unreachable from a Balanced state and the reverse, and a state
 * that does not exist in a mode has an empty set there.
 */
interface WorkflowTransitionRow {
  readonly balanced: ReadonlySet<BalancedWorkflowState>;
  readonly strict: ReadonlySet<StrictWorkflowState>;
}

const NO_BALANCED: ReadonlySet<BalancedWorkflowState> = new Set();
const NO_STRICT: ReadonlySet<StrictWorkflowState> = new Set();
const TERMINAL_ROW: WorkflowTransitionRow = { balanced: NO_BALANCED, strict: NO_STRICT };

const STRICT_ABORTS = ["cancelled", "timed_out", "failed"] as const;
const STRICT_BLOCKS = ["blocked_provider", "blocked_permissions", "blocked_auth_or_quota"] as const;

function strictSet(...states: StrictWorkflowState[]): ReadonlySet<StrictWorkflowState> {
  return new Set(states);
}

const TRANSITIONS: Readonly<Record<WorkflowState, WorkflowTransitionRow>> = {
  idle: {
    balanced: new Set(["preflight"]),
    strict: strictSet("preflight"),
  },
  preflight: {
    balanced: new Set(["awaiting_confirmation", "blocked_untrusted_workspace", "blocked_provider", "failed", "cancelled"]),
    // Strict preflight captures the baseline and runs provider isolation and sandbox
    // checks, all before any provider request.
    strict: strictSet("planning", "blocked_untrusted_workspace", ...STRICT_BLOCKS, ...STRICT_ABORTS),
  },
  awaiting_confirmation: {
    balanced: new Set(["implementing", "blocked_provider", "failed", "cancelled", "timed_out"]),
    strict: NO_STRICT,
  },
  awaiting_input: {
    balanced: new Set(["implementing", "reviewing", "correcting", "failed", "cancelled", "timed_out"]),
    strict: strictSet("planning", "implementing", "reviewing", "correcting", "consensus_not_reached", ...STRICT_ABORTS),
  },
  implementing: {
    balanced: new Set(["awaiting_input", "running_checks", "no_changes", "failed", "cancelled", "timed_out", "blocked_provider", "blocked_permissions", "blocked_auth_or_quota"]),
    // A ceiling or an unexecutable plan can end phase B before its first review.
    // An unreviewable change is detected at whatever checkpoint rebuilds the perimeter,
    // not only in front of a review.
    strict: strictSet("running_checks", "awaiting_input", "no_changes", "paused", "consensus_not_reached",
      "review_failed", ...STRICT_BLOCKS, ...STRICT_ABORTS),
  },
  running_checks: {
    balanced: new Set(["reviewing", "no_changes", "completed_clean", "completed_with_findings", "validation_failed", "failed", "cancelled", "timed_out"]),
    // A failed check goes back to Claude; Strict never completes straight out of checks.
    strict: strictSet("reviewing", "correcting", "no_changes", "validation_failed", "paused",
      "consensus_not_reached", "review_failed", ...STRICT_ABORTS),
  },
  reviewing: {
    balanced: new Set([
      "awaiting_input", "correcting", "completed_clean", "completed_with_findings", "blocked_provider",
      "blocked_permissions", "blocked_auth_or_quota", "review_failed", "failed", "cancelled", "timed_out",
    ]),
    strict: strictSet("correcting", "awaiting_final_consensus", "awaiting_input", "review_failed",
      "consensus_not_reached", "paused", ...STRICT_BLOCKS, ...STRICT_ABORTS),
  },
  correcting: {
    balanced: new Set(["awaiting_input", "running_checks", "completed_with_findings", "failed", "cancelled", "timed_out", "blocked_provider", "blocked_permissions", "blocked_auth_or_quota"]),
    strict: strictSet("running_checks", "awaiting_input", "consensus_not_reached", "review_failed", "paused",
      ...STRICT_BLOCKS, ...STRICT_ABORTS),
  },
  planning: {
    balanced: NO_BALANCED,
    strict: strictSet("awaiting_consensus", "awaiting_input", "consensus_not_reached", "paused", ...STRICT_BLOCKS, ...STRICT_ABORTS),
  },
  awaiting_consensus: {
    balanced: NO_BALANCED,
    // A revision or a human answer produces a new hash and sends the plan back to planning.
    strict: strictSet("planning", "awaiting_human_approval", "awaiting_input", "consensus_not_reached", "paused",
      ...STRICT_BLOCKS, ...STRICT_ABORTS),
  },
  awaiting_human_approval: {
    balanced: NO_BALANCED,
    // A human edit reopens phase A on the new hash; a human refusal ends without execution.
    strict: strictSet("implementing", "planning", ...STRICT_ABORTS),
  },
  awaiting_final_consensus: {
    balanced: NO_BALANCED,
    strict: strictSet("completed_clean", "reviewing", "correcting", "consensus_not_reached", "review_failed",
      "paused", ...STRICT_BLOCKS, ...STRICT_ABORTS),
  },
  paused: {
    balanced: NO_BALANCED,
    // Resumable only while the same extension host still holds the task in memory.
    strict: strictSet("planning", "awaiting_consensus", "implementing", "running_checks", "reviewing",
      "correcting", "awaiting_final_consensus", "consensus_not_reached", ...STRICT_ABORTS),
  },
  completed_clean: TERMINAL_ROW,
  completed_with_findings: TERMINAL_ROW,
  no_changes: TERMINAL_ROW,
  consensus_not_reached: TERMINAL_ROW,
  validation_failed: TERMINAL_ROW,
  blocked_untrusted_workspace: TERMINAL_ROW,
  blocked_provider: TERMINAL_ROW,
  blocked_permissions: TERMINAL_ROW,
  blocked_auth_or_quota: TERMINAL_ROW,
  review_failed: TERMINAL_ROW,
  cancelled: TERMINAL_ROW,
  timed_out: TERMINAL_ROW,
  failed: TERMINAL_ROW,
};

const MODE_STATES: Readonly<Record<WorkflowMode, ReadonlySet<WorkflowState>>> = {
  balanced: new Set<WorkflowState>(BALANCED_WORKFLOW_STATES),
  strict: new Set<WorkflowState>(STRICT_WORKFLOW_STATES),
};

export function assertWorkflowTransition(mode: WorkflowMode, from: WorkflowState, to: WorkflowState): void {
  if (!allowedWorkflowTransitions(mode, from).has(to)) {
    throw new Error(`Invalid ${mode} workflow transition: ${from} -> ${to}.`);
  }
}

export function allowedWorkflowTransitions(mode: WorkflowMode, from: WorkflowState): ReadonlySet<WorkflowState> {
  return TRANSITIONS[from][mode];
}

export function isWorkflowStateInMode(mode: WorkflowMode, state: WorkflowState): boolean {
  return MODE_STATES[mode].has(state);
}

/** A state no mode can leave. */
export function isTerminalState(state: WorkflowState): boolean {
  const row = TRANSITIONS[state];
  return row.balanced.size === 0 && row.strict.size === 0;
}

/** A state that exists in this mode and has no outgoing transition in it. */
export function isTerminalStateFor(mode: WorkflowMode, state: WorkflowState): boolean {
  return isWorkflowStateInMode(mode, state) && TRANSITIONS[state][mode].size === 0;
}
