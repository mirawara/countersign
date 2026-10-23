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
  it("persists threads, selection, rename and message history across store recreation", async () => {
    const storage = new MemoryStorage();
    const first = new ChatStore(storage);
    const older = first.activeThread().id;
    await first.append(older, message("Original conversation"));
    await first.append(older, { id: randomUUID(), role: "assistant", text: "Done", createdAt: new Date().toISOString(),
      provider: "claude", requestedModel: "default", model: "claude-sonnet-4-6", status: "completed" });
    const newer = await first.createThread();
    await first.append(newer.id, message("New task"));
    await first.renameThread(newer.id, "Renamed task");
    await first.selectThread(older);

    const restored = new ChatStore(storage);
    expect(restored.activeThread().id).toBe(older);
    expect(restored.activeThread().messages.at(-1)).toMatchObject({ requestedModel: "default", model: "claude-sonnet-4-6" });
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
    expect(store.activeThread()).not.toHaveProperty("sessions");
  });

  it("preserves conversation history while ignoring stored legacy chat modes", async () => {
    const storage = new MemoryStorage();
    const store = new ChatStore(storage);
    await store.append(store.activeThread().id, message("Review this file"));
    await storage.update("countersign.chat.v1", { ...store.snapshot(), modes: [
      { id: "chat", label: "Chat (one provider)", protocol: "chat" },
      { id: `custom-${randomUUID()}`, label: "Focused review", protocol: "chat",
        instruction: "Report only verified findings.", timeoutMinutes: 5 },
    ], threads: [{ ...store.activeThread(), sessions: { claude: "old-session" } }] });
    const restored = new ChatStore(storage);
    expect(restored.snapshot()).not.toHaveProperty("modes");
    expect(restored.activeThread()).not.toHaveProperty("sessions");
    expect(restored.activeThread().messages[0].text).toBe("Review this file");
    await restored.clear();
    expect(restored.activeThread().messages).toHaveLength(0);
  });
});
