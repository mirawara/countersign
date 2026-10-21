export type ChatProvider = "mock" | "claude" | "codex";
export type ChatRole = "user" | "assistant" | "system";
export type ChatStatus = "running" | "completed" | "failed" | "cancelled";

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
  sessions: { claude?: string; codex?: string };
  sessionModels?: { claude?: string; codex?: string };
  sessionAccounts?: { claude?: string; codex?: string };
  repositoryDigest?: string;
}

export interface ChatState {
  version: 1;
  activeThreadId: string;
  threads: ChatThread[];
  modes: ChatMode[];
}

export interface ChatMode {
  id: string;
  label: string;
  protocol: "chat" | "balanced";
  instruction?: string;
  timeoutMinutes?: number;
}

export interface ChatModelOption {
  value: string;
  label: string;
  effortLevels: string[];
}

export interface ChatCapability {
  provider: ChatProvider;
  available: boolean;
  accountLabel: string;
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
