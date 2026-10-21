export type MockScenario = "clean" | "finding" | "noChanges" | "error";
export type ProviderKind = "claude" | "codex";
export type FindingSeverity = "Critical" | "High" | "Medium" | "Low" | "Info";

export type WorkflowState =
  | "idle"
  | "preflight"
  | "awaiting_confirmation"
  | "awaiting_input"
  | "implementing"
  | "running_checks"
  | "reviewing"
  | "correcting"
  | "completed_clean"
  | "completed_with_findings"
  | "no_changes"
  | "validation_failed"
  | "blocked_dirty_repository"
  | "blocked_untrusted_workspace"
  | "blocked_provider"
  | "blocked_permissions"
  | "blocked_auth_or_quota"
  | "review_failed"
  | "cancelled"
  | "timed_out"
  | "failed";

export type WorkflowPhase = Extract<
  WorkflowState,
  "preflight" | "awaiting_confirmation" | "awaiting_input" | "implementing" | "running_checks" | "reviewing" | "correcting"
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
  signal: AbortSignal;
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

export interface WorkflowEvent {
  taskId: string;
  state: WorkflowState;
  message: string;
  timestamp: string;
}

export interface WorkflowResult {
  taskId: string;
  state: WorkflowState;
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
  message: string;
  plan?: string;
  implementationSummary?: string;
  correctionSummary?: string;
  clarifications?: { phase: string; question: string; answer: string }[];
  selectedModels?: { claudeModel: string; claudeEffort: string; codexModel: string; codexEffort: string };
  configuredChecks?: LocalCheck[];
  events?: WorkflowEvent[];
  mock: boolean;
  implementationProvider: "mock" | "claude";
  reviewProvider: "mock" | "real";
  executionPermission?: "askBeforeChange" | "fullAccess";
  metrics: { provider: string; estimatedCostUsd?: number; inputTokens?: number; outputTokens?: number }[];
}

export interface ClaudeGateRecord {
  version: string;
  passedAt: string;
  passed: true;
}
