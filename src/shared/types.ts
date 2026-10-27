import type { ExecutionPermission, WorkflowModelSelection } from "../configuration/config";
import type { StrictPhase, StrictWorkflowResult } from "./strict";

export type MockScenario = "clean" | "finding" | "noChanges" | "error";
export type ProviderKind = "claude" | "codex";
export type FindingSeverity = "Critical" | "High" | "Medium" | "Low" | "Info";

/** A mode belongs to a single task and its result, never to the chat thread. */
export type WorkflowMode = "balanced" | "strict";

export const BALANCED_WORKFLOW_STATES = [
  "idle",
  "preflight",
  "awaiting_confirmation",
  "awaiting_input",
  "implementing",
  "running_checks",
  "reviewing",
  "correcting",
  "completed_clean",
  "completed_with_findings",
  "no_changes",
  "validation_failed",
  "blocked_untrusted_workspace",
  "blocked_provider",
  "blocked_permissions",
  "blocked_auth_or_quota",
  "review_failed",
  "cancelled",
  "timed_out",
  "failed",
] as const;

/**
 * Strict adds the plan agreement, the human gate, the final digest consensus and the
 * in-memory pause. It has no completed_with_findings: an open blocking finding ends in
 * consensus_not_reached, and it has no awaiting_confirmation, because its gate is the
 * explicit human plan approval.
 */
export const STRICT_WORKFLOW_STATES = [
  "idle",
  "preflight",
  "planning",
  "awaiting_consensus",
  "awaiting_human_approval",
  "awaiting_input",
  "implementing",
  "running_checks",
  "reviewing",
  "correcting",
  "awaiting_final_consensus",
  "paused",
  "completed_clean",
  "no_changes",
  "consensus_not_reached",
  "validation_failed",
  "review_failed",
  "blocked_untrusted_workspace",
  "blocked_provider",
  "blocked_permissions",
  "blocked_auth_or_quota",
  "cancelled",
  "timed_out",
  "failed",
] as const;

export type BalancedWorkflowState = typeof BALANCED_WORKFLOW_STATES[number];
export type StrictWorkflowState = typeof STRICT_WORKFLOW_STATES[number];
export type WorkflowState = BalancedWorkflowState | StrictWorkflowState;

export type WorkflowPhase = Extract<
  BalancedWorkflowState,
  "preflight" | "awaiting_confirmation" | "awaiting_input" | "implementing" | "running_checks" | "reviewing" | "correcting"
>;

export type StrictActiveState = Extract<
  StrictWorkflowState,
  "planning" | "awaiting_consensus" | "implementing" | "running_checks" | "reviewing" | "correcting" | "awaiting_final_consensus"
>;

export interface ProviderStatus {
  available: boolean;
  version?: string;
  reason?: string;
}

export interface Finding {
  severity: FindingSeverity;
  file: string;
  line: number;
  evidence: string;
  summary: string;
}

export interface AgentRequest {
  taskId: string;
  mode: "implement" | "review" | "correct";
  repository: string;
  task: string;
  diff?: string;
  simulatedDiff?: string;
  findings?: Finding[];
  clarifications?: { question: string; answer: string }[];
  implementationSummary?: string;
  preExistingPaths?: string[];
  signal: AbortSignal;
  readChanges?: () => Promise<import("../context/gitChanges").GitChanges>;
  changeSource?: "git" | "git-snapshot" | "snapshot";
}

export interface AgentResult {
  changed: boolean;
  changedPaths?: string[];
  simulatedDiff?: string;
  findings: Finding[];
  correction?: {
    confirmed: Finding[];
    fixed: Finding[];
    remaining: Finding[];
  };
  message: string;
  question?: string;
  metrics?: { estimatedCostUsd?: number; inputTokens?: number; outputTokens?: number };
}

export interface AIProvider {
  readonly id: string;
  checkAvailability(): Promise<ProviderStatus>;
  execute(request: AgentRequest): Promise<AgentResult>;
  cancel(taskId: string): Promise<void>;
}

export interface LocalCheck {
  id: string;
  executable: string;
  args: string[];
}

export interface CheckResult {
  id: string;
  passed: boolean;
  exitCode: number | null;
  output: string;
  timedOut: boolean;
}

export interface ProviderMetric {
  provider: string;
  estimatedCostUsd?: number;
  /** Claude's input_tokens excludes both kinds of cached input. */
  inputTokens?: number;
  cacheReadInputTokens?: number;
  cacheCreationInputTokens?: number;
  outputTokens?: number;
}

/** Each event carries the mode of its own run, so a thread can mix Balanced and Strict tasks. */
export interface BalancedWorkflowEvent {
  mode: "balanced";
  taskId: string;
  state: BalancedWorkflowState;
  message: string;
  timestamp: string;
}

export interface StrictWorkflowEvent {
  mode: "strict";
  taskId: string;
  state: StrictWorkflowState;
  phase: StrictPhase;
  message: string;
  timestamp: string;
}

export type WorkflowEvent = BalancedWorkflowEvent | StrictWorkflowEvent;

export interface BalancedWorkflowResult {
  mode: "balanced";
  taskId: string;
  state: BalancedWorkflowState;
  repository: string;
  task: string;
  startedAt: string;
  finishedAt: string;
  simulatedDiff?: string;
  diff?: string;
  reviewSummary?: string;
  findings: Finding[];
  checks: CheckResult[];
  workingTreeEntries: string[];
  startingWorkingTreeEntries?: string[];
  changeSource?: "git" | "git-snapshot" | "snapshot";
  message: string;
  plan?: string;
  implementationSummary?: string;
  correctionSummary?: string;
  clarifications?: { phase: string; question: string; answer: string }[];
  selectedModels?: WorkflowModelSelection;
  configuredChecks?: LocalCheck[];
  events?: BalancedWorkflowEvent[];
  mock: boolean;
  implementationProvider: "mock" | "claude";
  reviewProvider: "mock" | "real";
  executionPermission?: ExecutionPermission;
  metrics: ProviderMetric[];
}

/** Discriminated on the result's own mode: a Balanced result carries no Strict fields. */
export type WorkflowResult = BalancedWorkflowResult | StrictWorkflowResult;

export const CLAUDE_GATE_POLICY_REVISION = 4;

export interface ClaudeGateRecord {
  version: string;
  passedAt: string;
  passed: true;
  policyRevision: number;
}
