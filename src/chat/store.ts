import { randomUUID } from "node:crypto";
import { ChatMessage, ChatMode, ChatProvider, ChatState, ChatThread } from "./types";

export interface ChatStorage {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): PromiseLike<void>;
}

const KEY = "countersign.chat.v1";
const MAX_THREADS = 20;
const MAX_MESSAGES = 200;
const MAX_TEXT = 100_000;
const BASE_MODES: ChatMode[] = [
  { id: "chat", label: "Chat (one provider)", protocol: "chat", timeoutMinutes: 10 },
  { id: "balanced", label: "Claude + Codex (Balanced)", protocol: "balanced" },
];

export class ChatStore {
  private state: ChatState;
  private pendingSave: Promise<void> = Promise.resolve();

  constructor(private readonly storage: ChatStorage) {
    this.state = restore(storage.get<unknown>(KEY));
  }

  snapshot(): ChatState {
    return structuredClone(this.state);
  }

  activeThread(): ChatThread {
    return this.state.threads.find((thread) => thread.id === this.state.activeThreadId) ?? this.state.threads[0];
  }

  async createThread(): Promise<ChatThread> {
    if (this.state.threads.length >= MAX_THREADS) throw new Error("Delete an older conversation before creating another.");
    const thread = freshThread();
    this.state.threads.unshift(thread);
    this.state.activeThreadId = thread.id;
    await this.save();
    return thread;
  }

  async selectThread(id: string): Promise<boolean> {
    if (!this.state.threads.some((thread) => thread.id === id)) return false;
    this.state.activeThreadId = id;
    await this.save();
    return true;
  }

  async renameThread(id: string, title: string): Promise<void> {
    const thread = this.requireThread(id);
    const cleaned = title.trim().replace(/\s+/g, " ").slice(0, 80);
    if (!cleaned) throw new Error("Conversation title cannot be empty.");
    thread.title = cleaned;
    thread.updatedAt = new Date().toISOString();
    await this.save();
  }

  async deleteThread(id: string): Promise<void> {
    this.state.threads = this.state.threads.filter((thread) => thread.id !== id);
    if (this.state.threads.length === 0) this.state.threads = [freshThread()];
    if (!this.state.threads.some((thread) => thread.id === this.state.activeThreadId)) {
      this.state.activeThreadId = this.state.threads[0].id;
    }
    await this.save();
  }

  async clear(): Promise<void> {
    const thread = freshThread();
    this.state = { ...this.state, activeThreadId: thread.id, threads: [thread] };
    await this.save();
  }

  async createMode(label: string, instruction: string, timeoutMinutes: number): Promise<ChatMode> {
    if (this.state.modes.length >= 12) throw new Error("At most ten custom modes are supported.");
    const cleanLabel = label.trim().replace(/\s+/g, " ").slice(0, 50);
    const cleanInstruction = instruction.trim().slice(0, 2_000);
    if (!cleanLabel || !cleanInstruction || !Number.isInteger(timeoutMinutes) || timeoutMinutes < 1 || timeoutMinutes > 60) {
      throw new Error("A mode needs a name, instruction and timeout from 1 to 60 minutes.");
    }
    const mode: ChatMode = { id: `custom-${randomUUID()}`, label: cleanLabel, protocol: "chat",
      instruction: cleanInstruction, timeoutMinutes };
    this.state.modes.push(mode);
    await this.save();
    return mode;
  }

  async deleteMode(id: string): Promise<void> {
    if (!id.startsWith("custom-")) throw new Error("Built-in modes cannot be deleted.");
    this.state.modes = this.state.modes.filter((mode) => mode.id !== id);
    await this.save();
  }

  async append(threadId: string, message: ChatMessage): Promise<ChatMessage | undefined> {
    const thread = this.requireThread(threadId);
    thread.messages.push(cleanMessage(message));
    const evicted = thread.messages.length > MAX_MESSAGES ? thread.messages.shift() : undefined;
    if (message.role === "user" && thread.title === "New chat") thread.title = message.text.trim().slice(0, 60) || "New chat";
    thread.updatedAt = new Date().toISOString();
    await this.save();
    return evicted;
  }

  async updateMessage(threadId: string, messageId: string, patch: Partial<ChatMessage>): Promise<void> {
    const thread = this.requireThread(threadId);
    const message = thread.messages.find((entry) => entry.id === messageId);
    if (!message) return;
    Object.assign(message, cleanMessage({ ...message, ...patch, id: message.id, role: message.role }));
    thread.updatedAt = new Date().toISOString();
    await this.save();
  }

  async setSession(threadId: string, provider: Exclude<ChatProvider, "mock">, sessionId: string,
    accountLabel: string, requestedModel: string): Promise<void> {
    const thread = this.requireThread(threadId);
    thread.sessions[provider] = sessionId;
    thread.sessionAccounts ??= {};
    thread.sessionAccounts[provider] = accountLabel;
    thread.sessionModels ??= {};
    thread.sessionModels[provider] = requestedModel;
    await this.save();
  }

  resumableSession(threadId: string, provider: Exclude<ChatProvider, "mock">,
    accountLabel: string, requestedModel: string): string | undefined {
    const thread = this.requireThread(threadId);
    return thread.sessionAccounts?.[provider] === accountLabel && thread.sessionModels?.[provider] === requestedModel
      ? thread.sessions[provider] : undefined;
  }

  async setRepositoryDigest(threadId: string, digest: string): Promise<void> {
    if (!/^[0-9a-f]{64}$/.test(digest)) throw new Error("Invalid repository digest.");
    this.requireThread(threadId).repositoryDigest = digest;
    await this.save();
  }

  private requireThread(id: string): ChatThread {
    const thread = this.state.threads.find((entry) => entry.id === id);
    if (!thread) throw new Error("Chat thread does not exist.");
    return thread;
  }

  private save(): Promise<void> {
    const state = structuredClone(this.state);
    this.pendingSave = this.pendingSave.catch(() => {}).then(() => this.storage.update(KEY, state));
    return this.pendingSave;
  }
}

function freshThread(): ChatThread {
  const now = new Date().toISOString();
  return { id: randomUUID(), title: "New chat", createdAt: now, updatedAt: now, messages: [], sessions: {} };
}

function cleanMessage(message: ChatMessage): ChatMessage {
  const usage = isRecord(message.usage) ? {
    ...(finiteNonnegative(message.usage.inputTokens) ? { inputTokens: message.usage.inputTokens } : {}),
    ...(finiteNonnegative(message.usage.outputTokens) ? { outputTokens: message.usage.outputTokens } : {}),
    ...(finiteNonnegative(message.usage.estimatedCostUsd) ? { estimatedCostUsd: message.usage.estimatedCostUsd } : {}),
  } : undefined;
  const quota = isRecord(message.quota) && ["allowed", "allowed_warning", "rejected"].includes(String(message.quota.status))
    ? { status: message.quota.status as "allowed" | "allowed_warning" | "rejected",
      ...(typeof message.quota.type === "string" ? { type: message.quota.type.slice(0, 60) } : {}),
      ...(finiteNonnegative(message.quota.utilization) ? { utilization: message.quota.utilization } : {}) }
    : undefined;
  return {
    id: message.id.slice(0, 100), role: message.role, text: message.text.slice(0, MAX_TEXT),
    createdAt: message.createdAt.slice(0, 100),
    provider: ["mock", "claude", "codex"].includes(String(message.provider)) ? message.provider : undefined,
    accountLabel: typeof message.accountLabel === "string" ? message.accountLabel.slice(0, 200) : undefined,
    model: typeof message.model === "string" ? message.model.slice(0, 100) : undefined,
    requestedModel: typeof message.requestedModel === "string" ? message.requestedModel.slice(0, 100) : undefined,
    requestedEffort: typeof message.requestedEffort === "string" ? message.requestedEffort.slice(0, 20) : undefined,
    effectiveEffort: typeof message.effectiveEffort === "string" ? message.effectiveEffort.slice(0, 20) : undefined,
    status: ["running", "completed", "failed", "cancelled"].includes(String(message.status)) ? message.status : undefined,
    activity: Array.isArray(message.activity) ? message.activity.filter((entry): entry is string => typeof entry === "string")
      .slice(-100).map((entry) => entry.slice(0, 2_000)) : undefined,
    fileRefs: Array.isArray(message.fileRefs) ? message.fileRefs.filter((entry): entry is string => typeof entry === "string")
      .slice(0, 20).map((entry) => entry.slice(0, 1_000)) : undefined,
    diffArtifact: typeof message.diffArtifact === "string" && /^[0-9a-f-]{36}\.diff$/.test(message.diffArtifact)
      ? message.diffArtifact : undefined,
    modeLabel: typeof message.modeLabel === "string" ? message.modeLabel.slice(0, 50) : undefined,
    usage, quota,
  };
}

function finiteNonnegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function restore(raw: unknown): ChatState {
  if (!isRecord(raw) || raw.version !== 1 || !Array.isArray(raw.threads)) {
    const thread = freshThread();
    return { version: 1, activeThreadId: thread.id, threads: [thread], modes: structuredClone(BASE_MODES) };
  }
  const threads: ChatThread[] = raw.threads.slice(0, MAX_THREADS).filter(isThread).map((thread) => ({
    ...thread,
    messages: thread.messages.slice(-MAX_MESSAGES).filter(isMessage).map(cleanMessage),
    sessions: isRecord(thread.sessions) ? {
      ...(typeof thread.sessions.claude === "string" ? { claude: thread.sessions.claude } : {}),
      ...(typeof thread.sessions.codex === "string" ? { codex: thread.sessions.codex } : {}),
    } : {},
    sessionModels: isRecord(thread.sessionModels) ? {
      ...(typeof thread.sessionModels.claude === "string" ? { claude: thread.sessionModels.claude.slice(0, 100) } : {}),
      ...(typeof thread.sessionModels.codex === "string" ? { codex: thread.sessionModels.codex.slice(0, 100) } : {}),
    } : {},
    sessionAccounts: isRecord(thread.sessionAccounts) ? {
      ...(typeof thread.sessionAccounts.claude === "string" ? { claude: thread.sessionAccounts.claude.slice(0, 200) } : {}),
      ...(typeof thread.sessionAccounts.codex === "string" ? { codex: thread.sessionAccounts.codex.slice(0, 200) } : {}),
    } : {},
    repositoryDigest: typeof thread.repositoryDigest === "string" && /^[0-9a-f]{64}$/.test(thread.repositoryDigest)
      ? thread.repositoryDigest : undefined,
  }));
  if (threads.length === 0) threads.push(freshThread());
  const activeThreadId = typeof raw.activeThreadId === "string" && threads.some((thread) => thread.id === raw.activeThreadId)
    ? raw.activeThreadId : threads[0].id;
  const modes = [...structuredClone(BASE_MODES), ...(Array.isArray(raw.modes) ? raw.modes.filter(isCustomMode).slice(0, 10) : [])];
  return { version: 1, activeThreadId, threads, modes };
}

function isCustomMode(value: unknown): value is ChatMode {
  return isRecord(value) && typeof value.id === "string" && /^custom-[0-9a-f-]{36}$/.test(value.id) &&
    typeof value.label === "string" && value.label.length > 0 && value.label.length <= 50 &&
    value.protocol === "chat" && typeof value.instruction === "string" && value.instruction.length > 0 &&
    value.instruction.length <= 2_000 && typeof value.timeoutMinutes === "number" &&
    Number.isInteger(value.timeoutMinutes) && value.timeoutMinutes >= 1 && value.timeoutMinutes <= 60;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isThread(value: unknown): value is ChatThread {
  return isRecord(value) && typeof value.id === "string" && typeof value.title === "string" &&
    typeof value.createdAt === "string" && typeof value.updatedAt === "string" && Array.isArray(value.messages);
}

function isMessage(value: unknown): value is ChatMessage {
  return isRecord(value) && typeof value.id === "string" && typeof value.text === "string" &&
    typeof value.createdAt === "string" && ["user", "assistant", "system"].includes(String(value.role));
}
