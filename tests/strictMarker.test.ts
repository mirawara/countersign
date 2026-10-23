import { describe, expect, it } from "vitest";
import {
  describeStrictMarkerStatus, parseStrictMarker, STRICT_INTERRUPTION_MARKER_KEY, StrictMarkerStorage, StrictMarkerStore,
} from "../src/shared/strictMarker";

class MemoryStorage implements StrictMarkerStorage {
  private readonly data = new Map<string, unknown>();

  get<T>(key: string): T | undefined {
    return this.data.get(key) as T | undefined;
  }

  async update(key: string, value: unknown): Promise<void> {
    if (value === undefined) this.data.delete(key);
    else this.data.set(key, structuredClone(value));
  }

  raw(): unknown {
    return this.data.get(STRICT_INTERRUPTION_MARKER_KEY);
  }
}

describe("Strict interruption marker", () => {
  it("stores lifecycle metadata and nothing that could resume a task", async () => {
    const storage = new MemoryStorage();
    const host = new StrictMarkerStore(storage, "host-a");
    await host.markActive("task-1");

    const stored = storage.raw() as Record<string, unknown>;
    expect(Object.keys(stored).sort()).toEqual(["hostId", "id", "mode", "outcome", "timestamp"]);
    expect(stored).toMatchObject({ id: "task-1", hostId: "host-a", mode: "strict", outcome: "active" });
    const serialized = JSON.stringify(stored);
    for (const forbidden of ["plan", "hash", "baseline", "diff", "session", "permission", "nextAction", "metric"]) {
      expect(serialized, forbidden).not.toContain(forbidden);
    }
  });

  it("rejects a malformed marker instead of trusting it", () => {
    const valid = { id: "t", hostId: "h", mode: "strict", timestamp: new Date().toISOString(), outcome: "active" };
    expect(parseStrictMarker(valid)).toMatchObject({ id: "t", outcome: "active" });
    for (const broken of [
      { ...valid, outcome: "paused" },
      { ...valid, mode: "balanced" },
      { ...valid, timestamp: "not-a-date" },
      { ...valid, extra: true },
      { id: "t", hostId: "h", mode: "strict", timestamp: valid.timestamp },
      "marker",
      null,
    ]) {
      expect(parseStrictMarker(broken), JSON.stringify(broken)).toBeUndefined();
    }
    const storage = new MemoryStorage();
    void storage.update(STRICT_INTERRUPTION_MARKER_KEY, { id: "t", hostId: "h", mode: "balanced", timestamp: valid.timestamp, outcome: "active" });
    const store = new StrictMarkerStore(storage, "host-a");
    expect(store.status().kind).toBe("malformed");
    // An unreadable marker is not evidence that no task is running.
    expect(store.blocksNewTask()).toMatchObject({ kind: "malformed" });
  });

  it("allows automatic transitions only to the owning host and task", async () => {
    const storage = new MemoryStorage();
    const hostA = new StrictMarkerStore(storage, "host-a");
    await hostA.markActive("task-1");

    const hostB = new StrictMarkerStore(storage, "host-b");
    expect(await hostB.markInterrupted("task-1")).toBe(false);
    expect(await hostB.markFinished("task-1")).toBe(false);
    expect(await hostA.markFinished("other-task")).toBe(false);
    expect(storage.raw()).toMatchObject({ hostId: "host-a", outcome: "active" });
  });

  it("shows another host's active marker as not determinable and leaves it untouched", async () => {
    const storage = new MemoryStorage();
    await new StrictMarkerStore(storage, "host-a").markActive("task-1");

    const hostB = new StrictMarkerStore(storage, "host-b");
    const status = hostB.status();
    expect(status.kind).toBe("undeterminable");
    expect(describeStrictMarkerStatus(status)).toContain("cannot be determined");
    expect(describeStrictMarkerStatus(status)).not.toContain("interrupted the task");
    expect(hostB.blocksNewTask()).toMatchObject({ kind: "undeterminable", marker: { hostId: "host-a", outcome: "active" } });
    expect(storage.raw()).toMatchObject({ hostId: "host-a", outcome: "active" });
  });

  it("survives a restart with the previous host's marker intact", async () => {
    const storage = new MemoryStorage();
    await new StrictMarkerStore(storage, "host-a").markActive("task-1");

    // A new extension host instance generates a new in-memory identity.
    const afterRestart = new StrictMarkerStore(storage, "host-b");
    expect(afterRestart.status().kind).toBe("undeterminable");
    expect(afterRestart.ownsActiveTask()).toBe(false);
    expect(storage.raw()).toMatchObject({ hostId: "host-a" });
  });

  it("keeps an interrupted marker visible without blocking the next task", async () => {
    const storage = new MemoryStorage();
    const hostA = new StrictMarkerStore(storage, "host-a");
    await hostA.markActive("task-1");
    expect(await hostA.markInterrupted("task-1")).toBe(true);
    expect(storage.raw()).toMatchObject({ outcome: "interrupted" });

    const hostB = new StrictMarkerStore(storage, "host-b");
    expect(hostB.status().kind).toBe("foreign");
    expect(hostB.blocksNewTask()).toBeUndefined();
    expect(await hostB.clear()).toBe(true);
    expect(storage.raw()).toBeUndefined();
    expect(hostB.blocksNewTask()).toBeUndefined();
  });

  it("removes its own marker on a normal end", async () => {
    const storage = new MemoryStorage();
    const host = new StrictMarkerStore(storage, "host-a");
    await host.markActive("task-1");
    expect(await host.markFinished("task-1")).toBe(true);
    expect(storage.raw()).toBeUndefined();
    expect(host.ownsActiveTask()).toBe(false);
    expect(await host.clear()).toBe(false);
  });
});
