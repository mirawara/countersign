import { describe, expect, it } from "vitest";
import { randomUUID } from "node:crypto";
import { ChatStore, ChatStorage } from "../src/chat/store";
import { ChatMessage } from "../src/chat/types";

class MemoryStorage implements ChatStorage {
  private readonly data = new Map<string, unknown>();
  get<T>(key: string): T | undefined { return this.data.get(key) as T | undefined; }
  async update(key: string, value: unknown): Promise<void> { this.data.set(key, structuredClone(value)); }
}

const message = (text: string): ChatMessage => ({ id: randomUUID(), role: "user", text,
  createdAt: new Date().toISOString() });

describe("chat workspace history", () => {
  it("persists threads, selection, rename and native session IDs across store recreation", async () => {
    const storage = new MemoryStorage();
    const first = new ChatStore(storage);
    const older = first.activeThread().id;
    await first.append(older, message("Original conversation"));
    await first.setSession(older, "claude", "session-123", "Claude subscription login", "default");
    await first.append(older, { id: randomUUID(), role: "assistant", text: "Done", createdAt: new Date().toISOString(),
      provider: "claude", requestedModel: "default", model: "claude-sonnet-4-6", status: "completed" });
    const newer = await first.createThread();
    await first.append(newer.id, message("New task"));
    await first.renameThread(newer.id, "Renamed task");
    await first.selectThread(older);

    const restored = new ChatStore(storage);
    expect(restored.activeThread().id).toBe(older);
    expect(restored.activeThread().sessions.claude).toBe("session-123");
    expect(restored.activeThread().sessionModels?.claude).toBe("default");
    expect(restored.activeThread().messages.at(-1)).toMatchObject({ requestedModel: "default", model: "claude-sonnet-4-6" });
    expect(restored.resumableSession(older, "claude", "Claude subscription login", "default")).toBe("session-123");
    expect(restored.resumableSession(older, "claude", "Claude subscription login", "claude-sonnet-4-6")).toBeUndefined();
    expect(restored.resumableSession(older, "claude", "Different login", "default")).toBeUndefined();
    expect(restored.snapshot().threads.find((thread) => thread.id === newer.id)?.title).toBe("Renamed task");
    await restored.deleteThread(older);
    expect(new ChatStore(storage).activeThread().id).toBe(newer.id);
    await restored.clear();
    expect(new ChatStore(storage).snapshot().threads).toHaveLength(1);
    expect(new ChatStore(storage).activeThread().messages).toHaveLength(0);
  });

  it("drops malformed stored records and bounds message text", async () => {
    const storage = new MemoryStorage();
    await storage.update("countersign.chat.v1", { version: 1, activeThreadId: "bad", threads: [
      { id: "valid", title: "Valid", createdAt: "now", updatedAt: "now", sessions: { claude: 42 },
        messages: [{ id: "x", role: "user", text: "a".repeat(120_000), createdAt: "now" },
          { id: "invalid", role: "admin", text: "bad", createdAt: "now" }] },
      { nope: true },
    ] });
    const store = new ChatStore(storage);
    expect(store.snapshot().threads).toHaveLength(1);
    expect(store.activeThread().messages).toHaveLength(1);
    expect(store.activeThread().messages[0].text).toHaveLength(100_000);
    expect(store.activeThread().sessions.claude).toBeUndefined();
  });

  it("keeps custom mode definitions when chat history is cleared", async () => {
    const storage = new MemoryStorage();
    const store = new ChatStore(storage);
    const mode = await store.createMode("Focused review", "Report only verified findings.", 5);
    await store.append(store.activeThread().id, message("Review this file"));
    await store.clear();
    const restored = new ChatStore(storage);
    expect(restored.snapshot().modes.find((entry) => entry.id === mode.id)?.timeoutMinutes).toBe(5);
    expect(restored.activeThread().messages).toHaveLength(0);
    await restored.deleteMode(mode.id);
    expect(new ChatStore(storage).snapshot().modes.map((entry) => entry.id)).toEqual(["chat", "balanced"]);
  });
});
