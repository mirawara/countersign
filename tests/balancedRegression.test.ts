import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GitChangeError, validateReviewPath } from "../src/context/gitChanges";
import { createWorkspaceChanges } from "../src/context/workspaceChanges";
import { createStrictWorkspaceChanges } from "../src/context/strictWorkspace";
import { resolveStrictLimits } from "../src/shared/strictLimits";

const folders: string[] = [];
afterEach(async () => Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true }))));

async function folder(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "countersign-balanced-"));
  folders.push(root);
  return root;
}

function git(root: string, ...args: string[]): void {
  execFileSync("git", args, { cwd: root, stdio: "ignore" });
}

/**
 * The path policy table is now shared with Strict. These cases pin the Balanced side of
 * it: same rejections, same error type, same message, same change source per workspace.
 */
describe("Balanced behaviour after the shared path policy table", () => {
  it("keeps validateReviewPath rejecting exactly what it rejected before, with the same error", () => {
    for (const path of ["node_modules/a.js", "dist/a.js", ".git/config", "deep/.ssh/id_rsa", "x/.env.local", "a/app.pem"]) {
      let thrown: unknown;
      try {
        validateReviewPath(path);
      } catch (error) {
        thrown = error;
      }
      expect(thrown, path).toBeInstanceOf(GitChangeError);
      expect((thrown as Error).message, path).toBe(`Changed path ${JSON.stringify(path)} is excluded from AI review.`);
    }
    // Rules that only the Strict scanner applies must not start rejecting paths here.
    for (const path of [".venv/lib/x.py", "target/debug/app", ".vscode-test/a.js", "pack.vsix", "npm-debug.log.1"]) {
      expect(() => validateReviewPath(path), path).not.toThrow();
    }
  });

  it("keeps its change source per workspace: Git, Git plus snapshot, or snapshot", async () => {
    const clean = await folder();
    await writeFile(join(clean, "a.ts"), "1\n");
    git(clean, "init", "-q");
    git(clean, "config", "user.name", "Countersign tests");
    git(clean, "config", "user.email", "countersign-tests@example.invalid");
    git(clean, "add", "-A");
    git(clean, "commit", "-qm", "baseline");
    expect((await createWorkspaceChanges(clean)).source).toBe("git");

    await writeFile(join(clean, "a.ts"), "2\n");
    expect((await createWorkspaceChanges(clean)).source).toBe("git-snapshot");

    const plain = await folder();
    await writeFile(join(plain, "a.ts"), "1\n");
    expect((await createWorkspaceChanges(plain)).source).toBe("snapshot");
  });

  it("still refuses an excluded changed path with GitChangeError in snapshot mode", async () => {
    const root = await folder();
    await writeFile(join(root, "a.ts"), "1\n");
    const tracker = await createWorkspaceChanges(root);
    await writeFile(join(root, ".env"), "TOKEN=1\n");
    await expect(tracker.read()).rejects.toBeInstanceOf(GitChangeError);
  });

  it("is not routed through the Strict scanner: Git-ignored changes stay invisible to Balanced", async () => {
    const root = await folder();
    await mkdir(join(root, "internal"), { recursive: true });
    await writeFile(join(root, "internal", "notes.md"), "before\n");
    await writeFile(join(root, ".gitignore"), "internal/\n");
    await writeFile(join(root, "a.ts"), "1\n");
    git(root, "init", "-q");
    git(root, "config", "user.name", "Countersign tests");
    git(root, "config", "user.email", "countersign-tests@example.invalid");
    git(root, "add", "-A");
    git(root, "commit", "-qm", "baseline");

    const balanced = await createWorkspaceChanges(root);
    expect(balanced.source).toBe("git");
    const strict = await createStrictWorkspaceChanges({ folder: root, limits: resolveStrictLimits() });
    expect(strict.ok).toBe(true);
    if (!strict.ok) return;

    await writeFile(join(root, "internal", "notes.md"), "after\n");
    // Balanced keeps the Git fast path, which excludes Git-ignored files.
    expect((await balanced.read()).paths).toEqual([]);
    // Strict always scans the filesystem, so it sees the same change.
    const captured = await strict.workspace.capture();
    expect(captured.ok && captured.snapshot.record.entries.map((entry) => entry.path)).toEqual(["internal/notes.md"]);
  });
});
