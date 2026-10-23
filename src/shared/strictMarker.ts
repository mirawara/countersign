import { randomUUID } from "node:crypto";

/**
 * A minimal lifecycle marker, not a checkpoint and not a lock. It holds no plan, hash,
 * baseline, diff, message, account, session id, permission, metric or next action, so it
 * can never be used to resume or repeat a task. Cross-window coordination does not exist
 * until a shared lock exists, and this marker does not provide one.
 */
export const STRICT_INTERRUPTION_MARKER_KEY = "countersign.strict-interruption.v1";

export type StrictMarkerOutcome = "active" | "interrupted" | "finished";

export interface StrictInterruptionMarker {
  /** The task UUID. */
  id: string;
  /** UUID generated in memory when this extension host instance activated. */
  hostId: string;
  mode: "strict";
  /** ISO timestamp of the last update. */
  timestamp: string;
  outcome: StrictMarkerOutcome;
}

export interface StrictMarkerStorage {
  get<T>(key: string): T | undefined;
  update(key: string, value: unknown): PromiseLike<void>;
}

export type StrictMarkerStatus =
  | { kind: "none" }
  /** Written by this host for this task. */
  | { kind: "owned"; marker: StrictInterruptionMarker }
  /**
   * Written by another host instance. An active one proves nothing: the task may be
   * running in another window or may have been interrupted. Never overwritten here.
   */
  | { kind: "undeterminable"; marker: StrictInterruptionMarker }
  | { kind: "foreign"; marker: StrictInterruptionMarker }
  | { kind: "malformed" };

const OUTCOMES: StrictMarkerOutcome[] = ["active", "interrupted", "finished"];
const MARKER_KEYS = ["id", "hostId", "mode", "timestamp", "outcome"];

/** Rejects anything that is not exactly the declared schema; a malformed value is never trusted. */
export function parseStrictMarker(value: unknown): StrictInterruptionMarker | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const raw = value as Record<string, unknown>;
  if (Object.keys(raw).length !== MARKER_KEYS.length) return undefined;
  if (!MARKER_KEYS.every((key) => key in raw)) return undefined;
  if (typeof raw.id !== "string" || raw.id.length === 0) return undefined;
  if (typeof raw.hostId !== "string" || raw.hostId.length === 0) return undefined;
  if (raw.mode !== "strict") return undefined;
  if (typeof raw.timestamp !== "string" || Number.isNaN(Date.parse(raw.timestamp))) return undefined;
  if (!OUTCOMES.includes(raw.outcome as StrictMarkerOutcome)) return undefined;
  return {
    id: raw.id, hostId: raw.hostId, mode: "strict", timestamp: raw.timestamp,
    outcome: raw.outcome as StrictMarkerOutcome,
  };
}

export class StrictMarkerStore {
  /** Identity of this extension host instance; it exists only in memory. */
  readonly hostId: string;
  private activeTaskId: string | undefined;
  private pendingActivation: Promise<void> | undefined;
  private closing = false;

  constructor(private readonly storage: StrictMarkerStorage, hostId: string = randomUUID()) {
    this.hostId = hostId;
  }

  status(): StrictMarkerStatus {
    const raw = this.storage.get<unknown>(STRICT_INTERRUPTION_MARKER_KEY);
    if (raw === undefined) return { kind: "none" };
    const marker = parseStrictMarker(raw);
    if (!marker) return { kind: "malformed" };
    if (marker.hostId === this.hostId) return { kind: "owned", marker };
    return marker.outcome === "active" ? { kind: "undeterminable", marker } : { kind: "foreign", marker };
  }

  /** True while this host holds a Strict task that wrote an active marker. */
  ownsActiveTask(): boolean {
    const status = this.status();
    return status.kind === "owned" && status.marker.outcome === "active" && this.activeTaskId !== undefined;
  }

  /**
   * Only a foreign active or unreadable marker blocks a new task. An interrupted or
   * finished marker explicitly says its task ended and can be replaced by the next task.
   */
  blocksNewTask(): Extract<StrictMarkerStatus, { kind: "undeterminable" | "malformed" }> | undefined {
    const status = this.status();
    return status.kind === "undeterminable" || status.kind === "malformed"
      ? status
      : undefined;
  }

  /** Written before the first provider request of a Strict task. */
  async markActive(taskId: string, now = new Date()): Promise<void> {
    if (this.closing) throw new Error("Strict task cannot start while the extension is deactivating.");
    this.activeTaskId = taskId;
    const writing = Promise.resolve(this.storage.update(STRICT_INTERRUPTION_MARKER_KEY, {
      id: taskId, hostId: this.hostId, mode: "strict", timestamp: now.toISOString(), outcome: "active",
    } satisfies StrictInterruptionMarker));
    this.pendingActivation = writing;
    try { await writing; }
    finally { if (this.pendingActivation === writing) this.pendingActivation = undefined; }
  }

  /** Drain an in-flight marker write and record an orderly VS Code reload as interrupted. */
  async interruptForShutdown(): Promise<void> {
    this.closing = true;
    await this.pendingActivation?.catch(() => undefined);
    if (this.activeTaskId) await this.markInterrupted(this.activeTaskId);
  }

  /** Owner-only transition; a marker owned by another host is never touched automatically. */
  async markInterrupted(taskId: string, now = new Date()): Promise<boolean> {
    if (!this.owns(taskId)) return false;
    await this.storage.update(STRICT_INTERRUPTION_MARKER_KEY, {
      id: taskId, hostId: this.hostId, mode: "strict", timestamp: now.toISOString(), outcome: "interrupted",
    } satisfies StrictInterruptionMarker);
    this.activeTaskId = undefined;
    return true;
  }

  /** On a normal end: write finished, then remove it while still the owner. */
  async markFinished(taskId: string, now = new Date()): Promise<boolean> {
    if (!this.owns(taskId)) return false;
    await this.storage.update(STRICT_INTERRUPTION_MARKER_KEY, {
      id: taskId, hostId: this.hostId, mode: "strict", timestamp: now.toISOString(), outcome: "finished",
    } satisfies StrictInterruptionMarker);
    this.activeTaskId = undefined;
    if (this.owns(taskId, true)) await this.storage.update(STRICT_INTERRUPTION_MARKER_KEY, undefined);
    return true;
  }

  /**
   * The one explicit exception to ownership, reached only from the confirmed command.
   * It deletes metadata: it does not interrupt or resume a task and creates no lock.
   */
  async clear(): Promise<boolean> {
    if (this.status().kind === "none") return false;
    await this.storage.update(STRICT_INTERRUPTION_MARKER_KEY, undefined);
    return true;
  }

  private owns(taskId: string, ignoreActiveTask = false): boolean {
    const status = this.status();
    if (status.kind !== "owned" || status.marker.id !== taskId) return false;
    return ignoreActiveTask || this.activeTaskId === undefined || this.activeTaskId === taskId;
  }
}

/** The sentence shown for a marker this host does not own. */
export function describeStrictMarkerStatus(status: StrictMarkerStatus): string {
  switch (status.kind) {
    case "none":
      return "No Strict interruption marker is stored.";
    case "owned":
      return `This window owns a Strict marker (${status.marker.outcome}) written at ${status.marker.timestamp}.`;
    case "undeterminable":
      return `A Strict marker from another window is active (written at ${status.marker.timestamp}): the task may be running in another window or may have been interrupted. Its state cannot be determined from here.`;
    case "foreign":
      return `A Strict marker from another window is ${status.marker.outcome} (written at ${status.marker.timestamp}). It is left untouched.`;
    case "malformed":
      return "The stored Strict marker does not match the expected schema and is ignored.";
  }
}
