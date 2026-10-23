export type ChatProvider = "mock" | "claude" | "codex";
export type ChatRole = "user" | "assistant" | "system";
export type ChatStatus = "running" | "completed" | "failed" | "cancelled" | "interrupted";

export interface ChatUsage {
  inputTokens?: number;
  outputTokens?: number;
  estimatedCostUsd?: number;
}

export interface ChatQuota {
  status: "allowed" | "allowed_warning" | "rejected";
  type?: string;
  utilization?: number;
}

export interface ChatMessage {
  id: string;
  role: ChatRole;
  text: string;
  createdAt: string;
  provider?: ChatProvider;
  accountLabel?: string;
  model?: string;
  requestedModel?: string;
  requestedEffort?: string;
  effectiveEffort?: string;
  status?: ChatStatus;
  activity?: string[];
  fileRefs?: string[];
  usage?: ChatUsage;
  quota?: ChatQuota;
  diffArtifact?: string;
  modeLabel?: string;
}

export interface ChatThread {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: ChatMessage[];
}

export interface ChatState {
  version: 1;
  activeThreadId: string;
  threads: ChatThread[];
}

/** An effort or reasoning level exactly as the provider's catalogue reports it. */
export interface ChatEffortOption {
  value: string;
  /** The catalogue's own label, when it provides one. */
  label?: string;
}

export interface ChatModelOption {
  value: string;
  label: string;
  /** The levels this model supports, as its catalogue lists them. Never filtered locally. */
  effortLevels: ChatEffortOption[];
}

/** Account quota snapshot reported by the provider, not a prediction of the next turn. */
export interface ChatAccountUsage {
  checkedAt: string;
  windows: { label: string; usedPercent: number; resetsAt?: string }[];
  /** Only Codex currently reports whether ordinary included usage is allowed. */
  access?: "allowed" | "blocked";
}

export interface ChatCapability {
  provider: ChatProvider;
  available: boolean;
  accountLabel: string;
  /** Email reported by the selected CLI login, when the provider exposes it. */
  accountEmail?: string;
  usage?: ChatAccountUsage;
  models: ChatModelOption[];
  reason?: string;
  version?: string;
  quotaLabel?: string;
}

export interface ChatApproval {
  id: string;
  provider: Exclude<ChatProvider, "mock">;
  kind: "command" | "fileChange" | "tool";
  summary: string;
  detail?: string;
}
