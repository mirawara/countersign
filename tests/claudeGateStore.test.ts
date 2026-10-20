import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clearClaudeGateRecord, loadClaudeGateRecord, saveClaudeGateRecord } from "../src/providers/claudeGateStore";

const folders: string[] = [];
afterEach(async () => { await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true }))); });

describe("Claude gate record", () => {
  it("persists a strict version record with owner-only file permissions", async () => {
    const folder = await mkdtemp(join(tmpdir(), "ai-dev-orchestrator-gate-store-test-"));
    folders.push(folder);
    const path = join(folder, "nested", "gate.json");
    const record = { passed: true as const, version: "2.1.109 (Claude Code)", passedAt: "2026-10-19T15:20:46.931Z" };
    await saveClaudeGateRecord(record, path);
    expect(await loadClaudeGateRecord(path)).toEqual(record);
    if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
    await clearClaudeGateRecord(path);
    expect(await loadClaudeGateRecord(path)).toBeUndefined();
  });

  it("ignores malformed or unpassed records", async () => {
    const folder = await mkdtemp(join(tmpdir(), "ai-dev-orchestrator-gate-store-test-"));
    folders.push(folder);
    const path = join(folder, "gate.json");
    await writeFile(path, '{"passed":false,"version":"2.1.109 (Claude Code)","passedAt":"now"}');
    expect(await loadClaudeGateRecord(path)).toBeUndefined();
  });
});
