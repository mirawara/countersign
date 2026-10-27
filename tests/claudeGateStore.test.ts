import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { clearClaudeGateRecord, loadClaudeGateRecord, saveClaudeGateRecord } from "../src/providers/claudeGateStore";

const folders: string[] = [];
afterEach(async () => { await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true }))); });

describe("Claude gate record", () => {
  it("persists a strict version record with owner-only file permissions", async () => {
    const folder = await mkdtemp(join(tmpdir(), "countersign-gate-store-test-"));
    folders.push(folder);
    const path = join(folder, "nested", "gate.json");
    const record = { passed: true as const, version: "2.1.109 (Claude Code)", passedAt: "2026-10-19T15:20:46.931Z", policyRevision: 4 };
    await saveClaudeGateRecord(record, path);
    expect(await loadClaudeGateRecord(path)).toEqual(record);
    if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
    await clearClaudeGateRecord(path);
    expect(await loadClaudeGateRecord(path)).toBeUndefined();
  });

  it("reads a record left at the pre-rename path, so a passed gate survives the rename", async () => {
    const folder = await mkdtemp(join(tmpdir(), "countersign-gate-store-test-"));
    folders.push(folder);
    const path = join(folder, "countersign", "gate.json");
    const legacyPath = join(folder, "legacy", "gate.json");
    const record = { passed: true as const, version: "2.1.109 (Claude Code)", passedAt: "2026-10-19T15:20:46.931Z", policyRevision: 4 };
    await saveClaudeGateRecord(record, legacyPath);
    expect(await loadClaudeGateRecord(path, legacyPath)).toEqual(record);

    // Saving at the current path retires the legacy copy instead of leaving two records.
    await saveClaudeGateRecord(record, path, legacyPath);
    expect(await loadClaudeGateRecord(legacyPath)).toBeUndefined();
  });

  it("clears the pre-rename record too, so a cleared gate cannot come back", async () => {
    const folder = await mkdtemp(join(tmpdir(), "countersign-gate-store-test-"));
    folders.push(folder);
    const path = join(folder, "countersign", "gate.json");
    const legacyPath = join(folder, "legacy", "gate.json");
    const record = { passed: true as const, version: "2.1.109 (Claude Code)", passedAt: "2026-10-19T15:20:46.931Z", policyRevision: 4 };
    await saveClaudeGateRecord(record, legacyPath);
    await clearClaudeGateRecord(path, legacyPath);
    expect(await loadClaudeGateRecord(path, legacyPath)).toBeUndefined();
  });

  it("ignores malformed or unpassed records", async () => {
    const folder = await mkdtemp(join(tmpdir(), "countersign-gate-store-test-"));
    folders.push(folder);
    const path = join(folder, "gate.json");
    await writeFile(path, '{"passed":false,"version":"2.1.109 (Claude Code)","passedAt":"now"}');
    expect(await loadClaudeGateRecord(path)).toBeUndefined();
    await writeFile(path, '{"passed":true,"version":"2.1.109 (Claude Code)","passedAt":"2026-10-19T15:20:46.931Z"}');
    expect(await loadClaudeGateRecord(path)).toBeUndefined();
    await writeFile(path, '{"passed":true,"version":"2.1.109 (Claude Code)","passedAt":"2026-10-19T15:20:46.931Z","policyRevision":3}');
    expect(await loadClaudeGateRecord(path)).toBeUndefined();
  });
});
