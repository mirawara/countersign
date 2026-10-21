import { WorkflowState } from "../shared/types";

const TERMINAL = new Set<WorkflowState>([
  "completed_clean",
  "completed_with_findings",
  "no_changes",
  "validation_failed",
  "blocked_dirty_repository",
  "blocked_untrusted_workspace",
  "blocked_provider",
  "blocked_permissions",
  "blocked_auth_or_quota",
  "review_failed",
  "cancelled",
  "timed_out",
  "failed",
]);

const ALLOWED: Record<WorkflowState, ReadonlySet<WorkflowState>> = {
  idle: new Set(["preflight"]),
  preflight: new Set(["awaiting_confirmation", "blocked_dirty_repository", "blocked_untrusted_workspace", "blocked_provider", "failed", "cancelled"]),
  awaiting_confirmation: new Set(["implementing", "blocked_dirty_repository", "blocked_provider", "failed", "cancelled", "timed_out"]),
  awaiting_input: new Set(["implementing", "reviewing", "correcting", "failed", "cancelled", "timed_out"]),
  implementing: new Set(["awaiting_input", "running_checks", "no_changes", "failed", "cancelled", "timed_out", "blocked_provider", "blocked_permissions", "blocked_auth_or_quota"]),
  running_checks: new Set(["reviewing", "no_changes", "completed_clean", "completed_with_findings", "validation_failed", "failed", "cancelled", "timed_out"]),
  reviewing: new Set([
    "awaiting_input", "correcting", "completed_clean", "completed_with_findings", "blocked_provider",
    "blocked_permissions", "blocked_auth_or_quota", "review_failed", "failed", "cancelled", "timed_out",
  ]),
  correcting: new Set(["awaiting_input", "running_checks", "completed_with_findings", "failed", "cancelled", "timed_out", "blocked_provider", "blocked_permissions", "blocked_auth_or_quota"]),
  completed_clean: new Set(),
  completed_with_findings: new Set(),
  no_changes: new Set(),
  validation_failed: new Set(),
  blocked_dirty_repository: new Set(),
  blocked_untrusted_workspace: new Set(),
  blocked_provider: new Set(),
  blocked_permissions: new Set(),
  blocked_auth_or_quota: new Set(),
  review_failed: new Set(),
  cancelled: new Set(),
  timed_out: new Set(),
  failed: new Set(),
};

export function assertWorkflowTransition(from: WorkflowState, to: WorkflowState): void {
  if (!ALLOWED[from].has(to)) {
    throw new Error(`Invalid workflow transition: ${from} -> ${to}.`);
  }
}

export function isTerminalState(state: WorkflowState): boolean {
  return TERMINAL.has(state);
}
