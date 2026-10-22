import { mkdtemp, mkdir, readFile, rm, writeFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
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

  it("represents an EOF newline change in the diff", async () => {
    const root = await mkdtemp(join(tmpdir(), "countersign-snapshot-")); folders.push(root);
    await writeFile(join(root, "file.txt"), "same");
    const tracker = await createWorkspaceChanges(root);
    await writeFile(join(root, "file.txt"), "same\n");
    const changes = await tracker.read();
    expect(changes.diff).toContain("-same\n\\ No newline at end of file\n+same");
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

describe("dirty Git workspace snapshots", () => {
  it("sends only post-baseline edits when an agent changes a pre-existing file", async () => {
    const root = await mkdtemp(join(tmpdir(), "countersign-git-snapshot-")); folders.push(root);
    const git = (args: string[]): void => { execFileSync("git", args, { cwd: root, stdio: "ignore" }); };
    git(["init", "-q"]);
    git(["config", "user.name", "Countersign tests"]);
    git(["config", "user.email", "countersign-tests@example.invalid"]);
    const original = [
      "function add(a, b) {",
      "  return a + b;",
      "}",
      "",
      "module.exports = { add };",
      "",
    ].join("\n");
    await writeFile(join(root, "calc.js"), original);
    git(["add", "calc.js"]);
    git(["commit", "-q", "-m", "baseline"]);

    const preExisting = original.replace("module.exports = { add };", [
      "function multiply(a, b) {",
      "  return a * b;",
      "}",
      "",
      "module.exports = { add, multiply };",
    ].join("\n"));
    await writeFile(join(root, "calc.js"), preExisting);
    await writeFile(join(root, "user-wip.md"), "keep this pre-existing note\n");

    const tracker = await createWorkspaceChanges(root);
    expect(tracker.source).toBe("git-snapshot");
    expect(tracker.startingEntries).toEqual([" M calc.js", "?? user-wip.md"]);

    const implemented = preExisting.replace("module.exports = { add, multiply };", [
      "function subtract(a, b) {",
      "  return a - b;",
      "}",
      "",
      "module.exports = { add, multiply, subtract };",
    ].join("\n"));
    await writeFile(join(root, "calc.js"), implemented);
    const changes = await tracker.read();

    expect(changes.paths).toEqual(["calc.js"]);
    expect(changes.entries).toEqual([" M calc.js"]);
    expect(changes.diff).toContain("+function subtract(a, b) {");
    expect(changes.diff).not.toContain("+function multiply(a, b) {");
    expect(changes.diff).not.toContain("-function multiply(a, b) {");
    expect(changes.diff).not.toContain("keep this pre-existing note");
    expect(await readFile(join(root, "user-wip.md"), "utf8")).toBe("keep this pre-existing note\n");

    const patchFile = join(root, "snapshot.patch");
    const patchRoot = await mkdtemp(join(tmpdir(), "countersign-patch-check-")); folders.push(patchRoot);
    execFileSync("git", ["init", "-q"], { cwd: patchRoot, stdio: "pipe" });
    await writeFile(patchFile, changes.diff);
    await writeFile(join(patchRoot, "calc.js"), preExisting);
    execFileSync("git", ["apply", "--check", patchFile], { cwd: patchRoot, stdio: "pipe" });
    execFileSync("git", ["apply", patchFile], { cwd: patchRoot, stdio: "pipe" });
    expect(await readFile(join(patchRoot, "calc.js"), "utf8")).toBe(implemented);
  });

  it("produces an applicable patch when files are created, deleted or left unterminated", async () => {
    const root = await mkdtemp(join(tmpdir(), "countersign-snapshot-shapes-")); folders.push(root);
    await writeFile(join(root, "kept.txt"), "one\ntwo\nthree\n");
    await writeFile(join(root, "removed.txt"), "obsolete\n");
    const tracker = await createWorkspaceChanges(root);

    await writeFile(join(root, "kept.txt"), "one\nTWO\nthree\n");
    await writeFile(join(root, "added.txt"), "fresh line");
    await rm(join(root, "removed.txt"));
    const changes = await tracker.read();
    expect(changes.paths).toEqual(["added.txt", "kept.txt", "removed.txt"]);
    expect(changes.diff).toContain("new file mode");
    expect(changes.diff).toContain("deleted file mode");
    expect(changes.diff).toContain("\\ No newline at end of file");

    // git apply strips one path component, so a creation or deletion without its mode header
    // fails with "dev/null: No such file or directory" instead of applying.
    const patchRoot = await mkdtemp(join(tmpdir(), "countersign-shapes-apply-")); folders.push(patchRoot);
    execFileSync("git", ["init", "-q"], { cwd: patchRoot, stdio: "pipe" });
    await writeFile(join(patchRoot, "kept.txt"), "one\ntwo\nthree\n");
    await writeFile(join(patchRoot, "removed.txt"), "obsolete\n");
    const patchFile = join(root, "shapes.patch");
    await writeFile(patchFile, changes.diff);
    execFileSync("git", ["apply", "--check", patchFile], { cwd: patchRoot, stdio: "pipe" });
    execFileSync("git", ["apply", patchFile], { cwd: patchRoot, stdio: "pipe" });
    expect(await readFile(join(patchRoot, "kept.txt"), "utf8")).toBe("one\nTWO\nthree\n");
    expect(await readFile(join(patchRoot, "added.txt"), "utf8")).toBe("fresh line");
    await expect(readFile(join(patchRoot, "removed.txt"), "utf8")).rejects.toThrow();
  });
});
