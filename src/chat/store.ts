import { randomUUID } from "node:crypto";
import { ChatMessage, ChatState, ChatThread } from "./types";
import { canonicalizeStrictPlan, validateStrictPlan } from "../orchestrator/strictPlanHash";

export interface ChatStorage {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): PromiseLike<void>;
}

const KEY = "countersign.chat.v1";
const MAX_THREADS = 20;
const MAX_MESSAGES = 200;
const MAX_TEXT = 100_000;

export class ChatStore {
  private state: ChatState;
  private pendingSave: Promise<void> = Promise.resolve();
  private changeRevision = 0;

  constructor(private readonly storage: ChatStorage) {
    this.state = restore(storage.get<unknown>(KEY));
    // A restored message has no AbortController or provider session in this host.
    // Preserve its partial output but stop presenting it as live work.
    if (interruptRestoredRuns(this.state)) void this.save().catch(() => {});
  }

  snapshot(): ChatState {
    return structuredClone(this.state);
  }

  get revision(): number { return this.changeRevision; }

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

  private requireThread(id: string): ChatThread {
    const thread = this.state.threads.find((entry) => entry.id === id);
    if (!thread) throw new Error("Chat thread does not exist.");
    return thread;
  }

  private save(): Promise<void> {
    this.changeRevision++;
    const state = structuredClone(this.state);
    this.pendingSave = this.pendingSave.catch(() => {}).then(() => this.storage.update(KEY, state));
    return this.pendingSave;
  }
}

function freshThread(): ChatThread {
  const now = new Date().toISOString();
  return { id: randomUUID(), title: "New chat", createdAt: now, updatedAt: now, messages: [] };
}

function cleanMessage(message: ChatMessage): ChatMessage {
  const strictContinuation = cleanStrictContinuation(message.strictContinuation);
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
    status: ["running", "completed", "failed", "cancelled", "interrupted"].includes(String(message.status)) ? message.status : undefined,
    activity: Array.isArray(message.activity) ? message.activity.filter((entry): entry is string => typeof entry === "string")
      .slice(-100).map((entry) => entry.slice(0, 2_000)) : undefined,
    fileRefs: Array.isArray(message.fileRefs) ? message.fileRefs.filter((entry): entry is string => typeof entry === "string")
      .slice(0, 20).map((entry) => entry.slice(0, 1_000)) : undefined,
    diffArtifact: typeof message.diffArtifact === "string" && /^[0-9a-f-]{36}\.diff$/.test(message.diffArtifact)
      ? message.diffArtifact : undefined,
    modeLabel: typeof message.modeLabel === "string" ? message.modeLabel.slice(0, 50) : undefined,
    usage, quota, strictContinuation,
  };
}

function cleanStrictContinuation(value: unknown): ChatMessage["strictContinuation"] {
  if (!isRecord(value) || typeof value.repository !== "string" || !value.repository.startsWith("/") ||
      value.repository.length > 4_096 || typeof value.task !== "string" || value.task.length > MAX_TEXT ||
      typeof value.planHash !== "string" || !/^[0-9a-f]{64}$/.test(value.planHash) ||
      !isRecord(value.plan) || !Array.isArray(value.plan.checks)) return undefined;
  const authorizedChecks = value.plan.checks.filter((check): check is string => typeof check === "string");
  if (authorizedChecks.length !== value.plan.checks.length) return undefined;
  const validated = validateStrictPlan(value.plan, { authorizedChecks });
  if (!validated.ok) return undefined;
  const canonical = canonicalizeStrictPlan(validated.value);
  if (canonical.bytes > 65_536 || canonical.hash !== value.planHash) return undefined;
  const baselineDigest = typeof value.baselineDigest === "string" && /^[0-9a-f]{64}$/.test(value.baselineDigest)
    ? value.baselineDigest : undefined;
  const baselineHead = typeof value.baselineHead === "string" && /^[0-9a-f]{40,64}$/.test(value.baselineHead)
    ? value.baselineHead : undefined;
  return { repository: value.repository, task: value.task, planHash: canonical.hash,
    plan: canonical.plan, ...(baselineDigest ? { baselineDigest } : {}),
    ...(baselineHead ? { baselineHead } : {}),
    ...(Array.isArray(value.preExistingEntries) && value.preExistingEntries.length <= 100 &&
      value.preExistingEntries.every((entry: unknown) => typeof entry === "string" && entry.length <= 4_096)
      ? { preExistingEntries: value.preExistingEntries as string[] } : {}),
    ...(baselineDigest ? { approved: cleanApprovedContinuation(value.approved, canonical.hash) } : {}) };
}

function cleanApprovedContinuation(value: unknown, hash: string):
  NonNullable<NonNullable<ChatMessage["strictContinuation"]>["approved"]> | undefined {
  if (!isRecord(value) || !isRecord(value.consensus) || !isRecord(value.humanApproval)) return undefined;
  const consensus = value.consensus;
  const human = value.humanApproval;
  if (consensus.subject !== "plan" || consensus.hash !== hash ||
      typeof consensus.reachedAt !== "string" || !Array.isArray(consensus.approvals) ||
      !Array.isArray(consensus.openObjections) || consensus.openObjections.some((item) =>
        !isRecord(item) || item.blocking === true) ||
      human.approved !== true || human.planHash !== hash || typeof human.decidedAt !== "string" ||
      !["askBeforeChange", "fullAccess"].includes(String(human.executionPermission))) return undefined;
  const rawApprovals = consensus.approvals as unknown[];
  const approvals = ["claude", "codex"].map((provider) => rawApprovals.find((item: unknown) =>
    isRecord(item) && item.provider === provider && item.subject === "plan" &&
    item.hash === hash && item.decision === "approve" && typeof item.decidedAt === "string"));
  if (approvals.some((item) => !isRecord(item))) return undefined;
  return {
    consensus: { subject: "plan", hash, reachedAt: consensus.reachedAt,
      approvals: approvals.map((item) => ({ provider: (item as Record<string, unknown>).provider as "claude" | "codex",
        subject: "plan" as const, hash, decision: "approve" as const,
        decidedAt: (item as Record<string, unknown>).decidedAt as string })), openObjections: [] },
    humanApproval: { approved: true, planHash: hash, decidedAt: human.decidedAt,
      executionPermission: human.executionPermission as "askBeforeChange" | "fullAccess" },
  };
}

function finiteNonnegative(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function restore(raw: unknown): ChatState {
  if (!isRecord(raw) || raw.version !== 1 || !Array.isArray(raw.threads)) {
    const thread = freshThread();
    return { version: 1, activeThreadId: thread.id, threads: [thread] };
  }
  const threads: ChatThread[] = raw.threads.slice(0, MAX_THREADS).filter(isThread).map((thread) => ({
    id: thread.id, title: thread.title, createdAt: thread.createdAt, updatedAt: thread.updatedAt,
    messages: thread.messages.slice(-MAX_MESSAGES).filter(isMessage).map(cleanMessage),
  }));
  if (threads.length === 0) threads.push(freshThread());
  const activeThreadId = typeof raw.activeThreadId === "string" && threads.some((thread) => thread.id === raw.activeThreadId)
    ? raw.activeThreadId : threads[0].id;
  return { version: 1, activeThreadId, threads };
}

function interruptRestoredRuns(state: ChatState): boolean {
  let changed = false;
  const now = new Date().toISOString();
  for (const thread of state.threads) {
    for (const message of thread.messages) {
      if (message.role !== "assistant" || message.status !== "running") continue;
      const note = message.modeLabel === "Strict"
        ? "The VS Code extension host restarted while this Strict task was running. Countersign cannot resume it. Inspect the workspace before starting again. If a Strict marker blocks the next task, clear it with the Countersign command only after checking that no old task is active."
        : "The VS Code extension host restarted while this task was running. Countersign cannot resume it. Inspect the workspace before starting again.";
      message.status = "interrupted";
      message.text = message.text ? `${message.text.slice(0, MAX_TEXT - note.length - 2)}\n\n${note}` : note;
      message.activity = [...(message.activity ?? []), note].slice(-100);
      thread.updatedAt = now;
      changed = true;
    }
  }
  return changed;
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
