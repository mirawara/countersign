import { mkdtemp, mkdir, rm, writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createWorkspaceChanges } from "../src/context/workspaceChanges";

const folders: string[] = [];
afterEach(async () => Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true }))));

describe("workspace snapshots without Git", () => {
  it("captures changed, added and deleted text files relative to the initial folder", async () => {
    const root = await mkdtemp(join(tmpdir(), "countersign-snapshot-")); folders.push(root);
    await writeFile(join(root, "original.txt"), "before\n");
    await writeFile(join(root, "deleted.txt"), "gone\n");
    const tracker = await createWorkspaceChanges(root);
    expect(tracker.source).toBe("snapshot");
    expect(await tracker.read()).toEqual({ entries: [], paths: [], diff: "" });
    await writeFile(join(root, "original.txt"), "after\n");
    await writeFile(join(root, "added.txt"), "new\n");
    await unlink(join(root, "deleted.txt"));
    const changes = await tracker.read();
    expect(changes.paths).toEqual(["added.txt", "deleted.txt", "original.txt"]);
    expect(changes.diff).toContain("+after");
    expect(changes.diff).toContain("-before");
    expect(changes.diff).toContain("--- /dev/null");
  });

  it("refuses changed secret paths and ignores generated directories", async () => {
    const root = await mkdtemp(join(tmpdir(), "countersign-snapshot-")); folders.push(root);
    await mkdir(join(root, "node_modules"));
    await writeFile(join(root, "node_modules", "dep.js"), "old\n");
    const tracker = await createWorkspaceChanges(root);
    await writeFile(join(root, "node_modules", "dep.js"), "new\n");
    expect((await tracker.read()).paths).toEqual([]);
    await writeFile(join(root, "credentials.json"), "{}\n");
    await expect(tracker.read()).rejects.toThrow(/excluded from AI review/);
  });
});
