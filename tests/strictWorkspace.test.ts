import { execFileSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { chmod, mkdir, mkdtemp, open, rename, rm, stat, symlink, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { classifyStrictPath, isBalancedExcludedPath, SKIP_DIRS } from "../src/context/pathPolicy";
import { createStrictWorkspaceChanges, StrictWorkspace } from "../src/context/strictWorkspace";
import { createWorkspaceChanges } from "../src/context/workspaceChanges";
import { resolveStrictLimits, StrictLimitOverrides } from "../src/shared/strictLimits";

const folders: string[] = [];
// Every workspace pins its root with an open directory descriptor until it is closed.
// close() is idempotent, so a test that already closes its own workspace stays correct.
const workspaces: { close: () => Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(workspaces.splice(0).map((workspace) => workspace.close().catch(() => undefined)));
  await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true })));
});

async function openWorkspace(
  options: Parameters<typeof createStrictWorkspaceChanges>[0],
): Promise<Awaited<ReturnType<typeof createStrictWorkspaceChanges>>> {
  const created = await createStrictWorkspaceChanges(options);
  if (created.ok) workspaces.push(created.workspace);
  return created;
}

async function workspace(options: { git?: "clean" | "dirty" | "none"; limits?: StrictLimitOverrides } = {}): Promise<{ root: string; strict: StrictWorkspace }> {
  const root = await mkdtemp(join(tmpdir(), "countersign-strict-"));
  folders.push(root);
  await mkdir(join(root, "internal"), { recursive: true });
  await writeFile(join(root, "internal", "notes.md"), "before\n");
  await writeFile(join(root, "src.ts"), "export const value = 1;\n");
  if (options.git && options.git !== "none") {
    const git = (...args: string[]): void => void execFileSync("git", args, { cwd: root, stdio: "ignore" });
    git("init", "-q");
    git("config", "user.name", "Countersign tests");
    git("config", "user.email", "countersign-tests@example.invalid");
    // internal/ is Git-ignored on purpose: Strict must still review it.
    await writeFile(join(root, ".gitignore"), "internal/\n");
    git("add", "-A");
    git("commit", "-qm", "baseline");
    if (options.git === "dirty") await writeFile(join(root, "src.ts"), "export const value = 2;\n");
  }
  const created = await openWorkspace({ folder: root, limits: resolveStrictLimits(options.limits) });
  if (!created.ok) throw new Error(`baseline failed: ${created.failure.message}`);
  return { root, strict: created.workspace };
}

describe("Strict perimeter capture", () => {
  it("sees a Git-ignored change under internal/ with a clean, a dirty and a non-Git workspace", async () => {
    for (const git of ["clean", "dirty", "none"] as const) {
      const { root, strict } = await workspace({ git });
      expect(strict.identity.source, git).toBe("filesystem_scan");
      const unchanged = await strict.capture();
      expect(unchanged.ok && unchanged.snapshot.record.changedFileCount, git).toBe(0);

      await writeFile(join(root, "internal", "notes.md"), "after\n");
      const captured = await strict.capture();
      expect(captured.ok, git).toBe(true);
      if (!captured.ok) continue;
      expect(captured.snapshot.record.entries.map((entry) => entry.path), git).toEqual(["internal/notes.md"]);
      expect(captured.snapshot.record.entries[0].status, git).toBe("modified");
      expect(captured.snapshot.record.reviewable, git).toBe(true);
      expect(captured.snapshot.diff, git).toContain("+after");
      expect(captured.snapshot.record.digest, git).toMatch(/^[0-9a-f]{64}$/);
      expect(captured.snapshot.record.baselineDigest, git).toBe(strict.identity.digest);
    }
  });

  it("records the Git repository and HEAD as identity only", async () => {
    const clean = await workspace({ git: "clean" });
    expect(clean.strict.identity.git?.repository).toBeTruthy();
    expect(clean.strict.identity.git?.head).toMatch(/^[0-9a-f]{7,40}$/);
    const none = await workspace({ git: "none" });
    expect(none.strict.identity.git).toBeUndefined();
  });

  it("gives a different digest to LF and CRLF, because the snapshot keeps raw bytes", async () => {
    const { root, strict } = await workspace();
    await writeFile(join(root, "src.ts"), "export const value = 2;\n");
    const lf = await strict.capture();
    await writeFile(join(root, "src.ts"), "export const value = 2;\r\n");
    const crlf = await strict.capture();
    expect(lf.ok && crlf.ok && lf.snapshot.record.digest).not.toBe(crlf.ok && crlf.snapshot.record.digest);
  });

  it("excludes policy paths from the digest without reading them", async () => {
    const { root, strict } = await workspace();
    const before = await strict.capture();
    await mkdir(join(root, "dist"), { recursive: true });
    await writeFile(join(root, "dist", "bundle.js"), "generated\n");
    await writeFile(join(root, "countersign-0.1.0.vsix"), "package\n");
    const captured = await strict.capture();
    expect(captured.ok && before.ok).toBe(true);
    if (!captured.ok || !before.ok) return;
    // A change only in policy-excluded paths leaves the digest untouched, so it cannot
    // invalidate an approval or restart a review cycle.
    expect(captured.snapshot.record.changedFileCount).toBe(0);
    expect(captured.snapshot.record.digest).toBe(before.snapshot.record.digest);
    expect(captured.snapshot.policyExclusions.map((exclusion) => exclusion.rule))
      .toEqual(expect.arrayContaining(["dependency-and-build-output", "tooling-output-files"]));
  });

  it("scans credential paths as ordinary reviewable files", async () => {
    const { root, strict } = await workspace();
    await writeFile(join(root, ".env"), "TOKEN=first\n");
    await mkdir(join(root, ".ssh"), { recursive: true });
    await writeFile(join(root, ".ssh", "id_rsa"), "PRIVATE\n");
    const created = await openWorkspace({ folder: root, limits: resolveStrictLimits() });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    await writeFile(join(root, ".env"), "TOKEN=second-value-that-is-longer\n");
    await writeFile(join(root, ".ssh", "id_rsa"), "PRIVATE-KEY-UPDATED\n");
    const changed = await created.workspace.capture();
    expect(changed.ok).toBe(true);
    if (!changed.ok) return;
    expect(changed.snapshot.record.entries.map((entry) => entry.path)).toEqual([".env", ".ssh/id_rsa"]);
    expect(changed.snapshot.diff).toContain("TOKEN=second-value-that-is-longer");
    expect(changed.snapshot.diff).toContain("PRIVATE-KEY-UPDATED");
    expect(strict.root).toBeTruthy();
  });

  it("detects a credential rewrite that preserves size and mtime by hashing content", async () => {
    const root = await mkdtemp(join(tmpdir(), "countersign-strict-"));
    folders.push(root);
    await writeFile(join(root, "src.ts"), "export const value = 1;\n");
    await writeFile(join(root, ".env"), "TOKEN=aaaa\n");
    const fixed = new Date("2026-10-20T08:00:00.000Z");
    await utimes(join(root, ".env"), fixed, fixed);
    const created = await openWorkspace({ folder: root, limits: resolveStrictLimits() });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    // Same length and restored mtime still produce a different content digest.
    await writeFile(join(root, ".env"), "TOKEN=bbbb\n");
    await utimes(join(root, ".env"), fixed, fixed);
    expect((await stat(join(root, ".env"))).mtimeMs).toBe(fixed.getTime());
    const captured = await created.workspace.capture();
    expect(captured.ok).toBe(true);
    if (!captured.ok) return;
    expect(captured.snapshot.record.entries.map((entry) => entry.path)).toEqual([".env"]);
    expect(captured.snapshot.diff).toContain("TOKEN=bbbb");
    expect(captured.snapshot.record.changedFileCount).toBe(1);
  });

  it("marks a symlink and a binary file as unreviewable, and keeps a large new text file", async () => {
    const { root, strict } = await workspace();
    await writeFile(join(root, "picture.bin"), Buffer.from([0, 1, 2, 3, 0]));
    await writeFile(join(root, "huge.txt"), "x".repeat(17_000));
    await symlink(join(root, "src.ts"), join(root, "link.ts"));
    const captured = await strict.capture();
    expect(captured.ok).toBe(true);
    if (!captured.ok) return;
    const reasons = new Map(captured.snapshot.record.entries.map((entry) => [entry.path, entry.unreviewableReason]));
    expect(reasons.get("picture.bin")).toBe("binary_without_supported_review");
    // Strict no longer refuses a new file on its size alone; readable text stays reviewable.
    expect(reasons.get("huge.txt")).toBeUndefined();
    expect(captured.snapshot.changedUnsupportedPaths).toEqual([{ path: "link.ts", reason: "symlink" }]);
    expect(captured.snapshot.record.reviewable).toBe(false);
    expect(captured.snapshot.diff).not.toContain("picture.bin");
  });

  it("detects a change in a file above the snapshot size limit, metadata or not", async () => {
    const root = await mkdtemp(join(tmpdir(), "countersign-strict-"));
    folders.push(root);
    const big = join(root, "big.txt");
    const fixed = new Date("2026-10-20T08:00:00.000Z");
    await writeFile(big, `${"a".repeat(1024 * 1024)}x`);
    await utimes(big, fixed, fixed);
    const created = await openWorkspace({ folder: root, limits: resolveStrictLimits() });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect((await created.workspace.capture()).ok).toBe(true);

    // Same length, same timestamps: only a content hash can see this, and Strict hashes
    // every included file, large ones without keeping their bytes.
    await writeFile(big, `${"b".repeat(1024 * 1024)}x`);
    await utimes(big, fixed, fixed);
    const captured = await created.workspace.capture();
    expect(captured.ok).toBe(true);
    if (!captured.ok) return;
    expect(captured.snapshot.record.entries.map((entry) => entry.path)).toEqual(["big.txt"]);
    // It is seen, and it still cannot be reviewed, so it blocks a clean completion.
    expect(captured.snapshot.record.entries[0].unreviewableReason).toBe("over_file_size_limit");
    expect(captured.snapshot.record.reviewable).toBe(false);
    expect(captured.snapshot.diff).toBe("");
  });

  it("never reads through a symlink that replaces a scanned file", async () => {
    const outside = await mkdtemp(join(tmpdir(), "countersign-outside-"));
    folders.push(outside);
    await writeFile(join(outside, "secret.txt"), "OUTSIDE_SECRET\n");
    const { root, strict } = await workspace();
    await rm(join(root, "src.ts"));
    await symlink(join(outside, "secret.txt"), join(root, "src.ts"));

    const captured = await strict.capture();
    expect(captured.ok).toBe(true);
    if (!captured.ok) return;
    expect(captured.snapshot.changedUnsupportedPaths).toEqual([{ path: "src.ts", reason: "symlink" }]);
    expect(captured.snapshot.record.reviewable).toBe(false);
    expect(JSON.stringify(captured.snapshot)).not.toContain("OUTSIDE_SECRET");
  });

  it("sees a symlink retargeted to another path of the same length with the timestamp restored", async () => {
    const root = await mkdtemp(join(tmpdir(), "countersign-strict-"));
    folders.push(root);
    await writeFile(join(root, "aaa.txt"), "one\n");
    await writeFile(join(root, "bbb.txt"), "two\n");
    const link = join(root, "link.txt");
    const fixed = new Date("2026-10-20T08:00:00.000Z");
    await symlink(join(root, "aaa.txt"), link);
    await utimes(root, fixed, fixed);
    const created = await openWorkspace({ folder: root, limits: resolveStrictLimits() });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const before = await created.workspace.capture();
    expect(before.ok && before.snapshot.changedUnsupportedPaths).toEqual([]);

    // Same target length, same link metadata: only the target itself changed.
    await rm(link);
    await symlink(join(root, "bbb.txt"), link);
    const captured = await created.workspace.capture();
    expect(captured.ok).toBe(true);
    if (!captured.ok) return;
    expect(captured.snapshot.changedUnsupportedPaths).toEqual([{ path: "link.txt", reason: "symlink" }]);
    expect(captured.snapshot.record.reviewable).toBe(false);
  });

  it("does not descend into a directory replaced by a symlink", async () => {
    const outside = await mkdtemp(join(tmpdir(), "countersign-outside-"));
    folders.push(outside);
    await writeFile(join(outside, "secret.txt"), "OUTSIDE_SECRET\n");
    const root = await mkdtemp(join(tmpdir(), "countersign-strict-"));
    folders.push(root);
    await mkdir(join(root, "pkg"), { recursive: true });
    await writeFile(join(root, "pkg", "a.ts"), "export const a = 1;\n");
    const created = await openWorkspace({ folder: root, limits: resolveStrictLimits() });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    await rm(join(root, "pkg"), { recursive: true, force: true });
    await symlink(outside, join(root, "pkg"));
    const captured = await created.workspace.capture();
    expect(captured.ok).toBe(true);
    if (!captured.ok) return;
    expect(captured.snapshot.changedUnsupportedPaths.some((entry) => entry.path === "pkg")).toBe(true);
    expect(captured.snapshot.record.reviewable).toBe(false);
    expect(JSON.stringify(captured.snapshot)).not.toContain("OUTSIDE_SECRET");
    expect(captured.snapshot.record.entries.some((entry) => entry.path.includes("secret"))).toBe(false);
  });

  it("completes a baseline over a perimeter larger than 64 MiB", async () => {
    const root = await mkdtemp(join(tmpdir(), "countersign-strict-"));
    folders.push(root);
    // 80 MiB in total, well past the aggregate ceiling Strict used to fail on. Each file
    // is above the 1 MiB snapshot limit, so none of them occupies the diff-content pool.
    for (let index = 0; index < 20; index++) {
      await writeFile(join(root, `blob-${index}.bin`), Buffer.alloc(4 * 1024 * 1024, index));
    }
    await writeFile(join(root, "src.ts"), "export const value = 1;\n");
    const created = await openWorkspace({ folder: root, limits: resolveStrictLimits() });

    expect(created.ok).toBe(true);
    if (!created.ok) return;
    try {
      // The baseline exists and every included file is in it, hashed.
      expect(created.workspace.identity.entryCount).toBe(21);
      const clean = await created.workspace.capture();
      expect(clean.ok).toBe(true);
      if (!clean.ok) return;
      expect(clean.snapshot.record.entries).toEqual([]);
      expect(clean.snapshot.contentRetention.maxBytes).toBe(64 * 1024 * 1024);
      // Nothing was retained, so the 80 MiB perimeter never sat in memory.
      expect(clean.snapshot.contentRetention.retainedBytes).toBeLessThanOrEqual(1024 * 1024);
      expect(clean.snapshot.contentRetention.filesWithoutContent).toBe(20);
      // Those 20 were skipped on their own size, not because the pool ran out.
      expect(clean.snapshot.contentRetention.filesDroppedForBudget).toBe(0);

      // A change inside one of them is still seen, through its hash alone.
      await writeFile(join(root, "blob-7.bin"), Buffer.alloc(4 * 1024 * 1024, 99));
      const changed = await created.workspace.capture();
      expect(changed.ok).toBe(true);
      if (!changed.ok) return;
      expect(changed.snapshot.record.entries.map((entry) => entry.path)).toEqual(["blob-7.bin"]);
      expect(changed.snapshot.record.entries[0].unreviewableReason).toBe("over_file_size_limit");
      expect(changed.snapshot.record.reviewable).toBe(false);
    } finally {
      await created.workspace.close();
    }
  }, 60_000);

  it("keeps the diff-content pool bounded and still detects every change", async () => {
    const root = await mkdtemp(join(tmpdir(), "countersign-strict-"));
    folders.push(root);
    for (let index = 0; index < 6; index++) {
      await writeFile(join(root, `file-${index}.ts`), `export const value${index} = ${"x".repeat(200)};\n`);
    }
    // A pool far smaller than the text in the perimeter: some files cannot be kept.
    const created = await openWorkspace({
      folder: root, limits: resolveStrictLimits(), contentBudgetBytes: 400,
    });

    expect(created.ok).toBe(true);
    if (!created.ok) return;
    try {
      const captured = await created.workspace.capture();
      expect(captured.ok).toBe(true);
      if (!captured.ok) return;
      // The baseline completed, nothing changed, and memory stayed inside the pool.
      expect(captured.snapshot.record.entries).toEqual([]);
      expect(captured.snapshot.contentRetention.retainedBytes).toBeLessThanOrEqual(400);
      expect(captured.snapshot.contentRetention.filesDroppedForBudget).toBeGreaterThan(0);
      expect(captured.snapshot.contentRetention.baselineFilesDroppedForBudget).toBeGreaterThan(0);
    } finally {
      await created.workspace.close();
    }
  });

  it("reports a change it cannot diff as content_not_retained, never as unchanged", async () => {
    const root = await mkdtemp(join(tmpdir(), "countersign-strict-"));
    folders.push(root);
    await writeFile(join(root, "src.ts"), "export const value = 1;\n");
    // A pool of zero keeps nothing at all, which is the exhausted state made deterministic.
    const created = await openWorkspace({
      folder: root, limits: resolveStrictLimits(), contentBudgetBytes: 0,
    });

    expect(created.ok).toBe(true);
    if (!created.ok) return;
    try {
      await writeFile(join(root, "src.ts"), "export const value = 2;\n");
      const captured = await created.workspace.capture();
      expect(captured.ok).toBe(true);
      if (!captured.ok) return;
      const [entry] = captured.snapshot.record.entries;
      // Seen, because hashing never depends on the pool.
      expect(entry.path).toBe("src.ts");
      expect(entry.status).toBe("modified");
      expect(entry.beforeHash).not.toBe(entry.afterHash);
      // Reported for what it is: not reviewable, and not the per-file size limit either.
      expect(entry.reviewable).toBe(false);
      expect(entry.unreviewableReason).toBe("content_not_retained");
      expect(captured.snapshot.record.reviewable).toBe(false);
      expect(captured.snapshot.diff).toBe("");
    } finally {
      await created.workspace.close();
    }
  });

  it("separates a file too large on its own from one the pool could not keep", async () => {
    const root = await mkdtemp(join(tmpdir(), "countersign-strict-"));
    folders.push(root);
    await writeFile(join(root, "big.txt"), "a".repeat(1024 * 1024 + 1));
    await writeFile(join(root, "small.txt"), "a\n");
    const created = await openWorkspace({
      folder: root, limits: resolveStrictLimits(), contentBudgetBytes: 0,
    });

    expect(created.ok).toBe(true);
    if (!created.ok) return;
    try {
      await writeFile(join(root, "big.txt"), "b".repeat(1024 * 1024 + 1));
      await writeFile(join(root, "small.txt"), "b\n");
      const captured = await created.workspace.capture();
      expect(captured.ok).toBe(true);
      if (!captured.ok) return;
      const reasons = new Map(captured.snapshot.record.entries.map((entry) => [entry.path, entry.unreviewableReason]));
      expect(reasons.get("big.txt")).toBe("over_file_size_limit");
      expect(reasons.get("small.txt")).toBe("content_not_retained");
      // The pool never counted the oversized file, which was skipped on its own size.
      expect(captured.snapshot.contentRetention.filesDroppedForBudget).toBe(1);
    } finally {
      await created.workspace.close();
    }
  });

  it("names the file a patch cannot be built for instead of blaming the workspace", async () => {
    const root = await mkdtemp(join(tmpdir(), "countersign-strict-"));
    folders.push(root);
    await writeFile(join(root, "a.txt"), `${"a".repeat(150_000)}\n`);
    await writeFile(join(root, "z.txt"), Array.from({ length: 1_100 }, (_, i) => `old-${i}`).join("\n"));
    const created = await openWorkspace({ folder: root, limits: resolveStrictLimits() });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    try {
      await writeFile(join(root, "a.txt"), `${"b".repeat(150_000)}\n`);
      // Diffing this file fails on its edit-distance limit. That is an unreviewable
      // change with a file name and a next step, not an unreadable perimeter.
      await writeFile(join(root, "z.txt"), Array.from({ length: 1_100 }, (_, i) => `new-${i}`).join("\n"));
      const captured = await created.workspace.capture();
      expect(captured.ok).toBe(false);
      if (captured.ok) return;
      expect(captured.failure.code).toBe("unreviewable_change");
      expect(captured.failure.message).toContain("z.txt");
      expect(captured.failure.message).toContain("too many line edits");
      expect(captured.failure.message).not.toContain("perimeter could not be compared");
    } finally {
      await created.workspace.close();
    }
  });

  it("cannot be redirected by a directory swapped and restored during the scan", async () => {
    const outside = await mkdtemp(join(tmpdir(), "countersign-outside-"));
    folders.push(outside);
    await writeFile(join(outside, "stolen.ts"), "OUTSIDE_SECRET\n");
    const root = await mkdtemp(join(tmpdir(), "countersign-strict-"));
    folders.push(root);
    await mkdir(join(root, "pkg"), { recursive: true });
    // Enough files that the capture spends time inside pkg/ while the swap lands.
    for (let index = 0; index < 400; index++) {
      await writeFile(join(root, "pkg", `file-${index}.ts`), `export const value${index} = ${index};\n`);
    }
    const created = await openWorkspace({ folder: root, limits: resolveStrictLimits() });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    let completedSwaps = 0;
    const swaps: Promise<void>[] = [];
    for (let attempt = 0; attempt < 30; attempt++) {
      swaps.push(new Promise((resolve) => setTimeout(resolve, attempt)).then(async () => {
        // Move the real directory aside, put a link to an outside folder in its place and
        // restore it: exactly the swap-and-restore window an identity check cannot see.
        const moved = join(root, "pkg-aside");
        try {
          await rename(join(root, "pkg"), moved);
          await symlink(outside, join(root, "pkg"));
          await rm(join(root, "pkg"));
          await rename(moved, join(root, "pkg"));
          completedSwaps += 1;
        } catch { /* Losing the race is fine; the assertion is about what was read. */ }
      }));
    }
    const captured = await created.workspace.capture().catch(() => undefined);
    await Promise.all(swaps);
    expect(completedSwaps).toBeGreaterThan(0);

    // Either the capture failed, or it succeeded without a single byte from outside.
    if (captured?.ok) {
      expect(JSON.stringify(captured.snapshot)).not.toContain("OUTSIDE_SECRET");
      expect(captured.snapshot.record.entries.some((entry) => entry.path.includes("stolen"))).toBe(false);
    }
  });

  it("never reports a file as unchanged when it is rewritten at the same length while being read", async () => {
    const root = await mkdtemp(join(tmpdir(), "countersign-strict-"));
    folders.push(root);
    const target = join(root, "big.bin");
    await writeFile(target, Buffer.alloc(24 * 1024 * 1024, 1));
    const created = await openWorkspace({ folder: root, limits: resolveStrictLimits() });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    const rewrite = new Promise((resolve) => setTimeout(resolve, 2)).then(async () => {
      const handle = await open(target, "r+");
      try {
        // Same length, different bytes, written while the capture streams the file.
        await handle.write(Buffer.alloc(1024 * 1024, 2), 0, 1024 * 1024, 8 * 1024 * 1024);
      } finally {
        await handle.close();
      }
    });
    const captured = await created.workspace.capture();
    await rewrite;

    if (!captured.ok) {
      expect(captured.failure.code).toBe("workspace_changed");
      return;
    }
    // If the write landed outside the read window, the next capture must still see it.
    const after = await created.workspace.capture();
    expect(after.ok).toBe(true);
    if (!after.ok) return;
    expect(after.snapshot.record.entries.map((entry) => entry.path)).toEqual(["big.bin"]);
  });

  it("cannot be anchored to an outside tree by a parent swapped while the baseline is taken", async () => {
    // The workspace sits under a parent that is swapped for a link to an outside copy
    // holding a sentinel, repeatedly, while createStrictWorkspaceChanges runs.
    const stage = await mkdtemp(join(tmpdir(), "countersign-stage-"));
    folders.push(stage);
    const parent = join(stage, "parent");
    const decoyParent = join(stage, "decoy");
    await mkdir(join(parent, "repo"), { recursive: true });
    await writeFile(join(parent, "repo", "src.ts"), "export const value = 1;\n");
    await mkdir(join(decoyParent, "repo"), { recursive: true });
    await writeFile(join(decoyParent, "repo", "planted.ts"), "OUTSIDE_SENTINEL\n");
    const folder = join(parent, "repo");

    let swaps = 0;
    const aside = join(stage, "parent-aside");
    const interference = Promise.all(Array.from({ length: 25 }, (_item, attempt) =>
      new Promise((resolve) => setTimeout(resolve, attempt)).then(async () => {
        try {
          await rename(parent, aside);
          await symlink(decoyParent, parent);
          await rm(parent);
          await rename(aside, parent);
          swaps += 1;
        } catch { /* Losing the race is fine; the assertion is about what was recorded. */ }
      })));
    const created = await openWorkspace({ folder, limits: resolveStrictLimits() });
    await interference;
    expect(swaps).toBeGreaterThan(0);

    if (!created.ok) {
      expect(["workspace_changed", "baseline_unavailable"]).toContain(created.failure.code);
      return;
    }
    const captured = await created.workspace.capture();
    await created.workspace.close();
    if (captured.ok) {
      expect(JSON.stringify(captured.snapshot)).not.toContain("OUTSIDE_SENTINEL");
      expect(captured.snapshot.record.entries.some((entry) => entry.path.includes("planted"))).toBe(false);
    }
  });

  it("anchors the baseline to the directory the call resolved", async () => {
    const outside = await mkdtemp(join(tmpdir(), "countersign-outside-"));
    folders.push(outside);
    await writeFile(join(outside, "planted.ts"), "OUTSIDE_SENTINEL\n");
    const root = await mkdtemp(join(tmpdir(), "countersign-strict-"));
    folders.push(root);
    await writeFile(join(root, "src.ts"), "export const value = 1;\n");

    // The root is swapped repeatedly while the baseline is being taken: the baseline must
    // either fail or describe the directory the call resolved, never the planted one.
    let swaps = 0;
    const aside = `${root}-aside`;
    folders.push(aside);
    const interference = Promise.all(Array.from({ length: 20 }, (_item, attempt) =>
      new Promise((resolve) => setTimeout(resolve, attempt)).then(async () => {
        try {
          await rename(root, aside);
          await symlink(outside, root);
          await rm(root);
          await rename(aside, root);
          swaps += 1;
        } catch { /* Losing the race is fine; the assertion is about what was recorded. */ }
      })));
    const created = await openWorkspace({ folder: root, limits: resolveStrictLimits() });
    await interference;
    expect(swaps).toBeGreaterThan(0);

    if (!created.ok) {
      expect(["workspace_changed", "baseline_unavailable"]).toContain(created.failure.code);
      return;
    }
    const captured = await created.workspace.capture();
    if (captured.ok) {
      expect(JSON.stringify(captured.snapshot)).not.toContain("OUTSIDE_SENTINEL");
    }
  });

  it("refuses to capture when the workspace root itself was replaced", async () => {
    const root = await mkdtemp(join(tmpdir(), "countersign-strict-"));
    folders.push(root);
    await writeFile(join(root, "src.ts"), "export const value = 1;\n");
    const created = await openWorkspace({ folder: root, limits: resolveStrictLimits() });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    // Another directory takes the same path: pinning the descendants of an open root says
    // nothing about whether the opened root is still the one the baseline scanned.
    const aside = `${root}-aside`;
    folders.push(aside);
    await rename(root, aside);
    await mkdir(root, { recursive: true });
    await writeFile(join(root, "planted.ts"), "OUTSIDE_SENTINEL\n");

    const captured = await created.workspace.capture();
    expect(captured.ok).toBe(false);
    if (captured.ok) return;
    expect(captured.failure.code).toBe("workspace_changed");
    expect(JSON.stringify(captured.failure)).not.toContain("OUTSIDE_SENTINEL");
  });

  it("records the permission bits of the file it actually opened", async () => {
    const { root, strict } = await workspace();
    await chmod(join(root, "src.ts"), 0o755);
    const captured = await strict.capture();
    expect(captured.ok).toBe(true);
    if (!captured.ok) return;
    expect(captured.snapshot.record.entries[0]).toMatchObject({
      path: "src.ts", beforeMode: "100644", afterMode: "100755",
    });
  });

  it("classifies a FIFO as unsupported without waiting for a writer", async () => {
    const root = await mkdtemp(join(tmpdir(), "countersign-strict-"));
    folders.push(root);
    await writeFile(join(root, "src.ts"), "export const value = 1;\n");
    execFileSync("mkfifo", [join(root, "pipe")]);
    const created = await openWorkspace({ folder: root, limits: resolveStrictLimits() });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    const captured = await created.workspace.capture();
    expect(captured.ok).toBe(true);
    if (!captured.ok) return;
    expect(captured.snapshot.unsupportedPaths).toEqual([{ path: "pipe", reason: "special_file" }]);
  }, 10_000);

  it("has no per-task ceiling on how many files may change", async () => {
    const { root, strict } = await workspace();
    for (let index = 0; index < 60; index++) await writeFile(join(root, `file-${index}.ts`), "content\n");
    const captured = await strict.capture();

    // Only the scan and diff ceilings apply; the per-task ceiling is gone.
    expect(captured.ok).toBe(true);
    if (!captured.ok) return;
    expect(captured.snapshot.record.changedFileCount).toBe(60);
    expect(captured.snapshot.record.reviewable).toBe(true);
  });

  it("represents a rename as a deletion plus an addition", async () => {
    const { root, strict } = await workspace();
    await rm(join(root, "src.ts"));
    await writeFile(join(root, "renamed.ts"), "export const value = 1;\n");
    const captured = await strict.capture();
    expect(captured.ok).toBe(true);
    if (!captured.ok) return;
    expect(captured.snapshot.record.entries.map((entry) => `${entry.path}:${entry.status}`))
      .toEqual(["renamed.ts:added", "src.ts:deleted"]);
  });
});

describe("the pinned root descriptor", () => {
  const openDescriptors = (): number => readdirSync("/proc/self/fd").length;

  /**
   * A signal that stays live through the scan and reports a cancellation once a process
   * has started. The scan touches no process, so `addEventListener` is first called by the
   * first Git command; from then on the signal reads as aborted and the next Git command
   * is refused before it starts. That places the cancellation inside the Git read, which
   * is the window this case is about.
   */
  function signalThatCancelsDuringGit(): { signal: AbortSignal; processesStarted: () => number } {
    let started = 0;
    const signal = {
      get aborted(): boolean {
        return started > 0;
      },
      addEventListener: (): void => { started += 1; },
      removeEventListener: (): void => undefined,
    } as unknown as AbortSignal;
    return { signal, processesStarted: () => started };
  }

  it("returns a cancelled failure and releases the descriptor when Git is cancelled", async () => {
    const root = await mkdtemp(join(tmpdir(), "countersign-strict-"));
    folders.push(root);
    await writeFile(join(root, "src.ts"), "export const value = 1;\n");
    execFileSync("git", ["init", "-q"], { cwd: root });

    const { signal, processesStarted } = signalThatCancelsDuringGit();
    const before = openDescriptors();
    const created = await openWorkspace({ folder: root, limits: resolveStrictLimits(), signal });

    expect(created.ok).toBe(false);
    if (created.ok) return;
    expect(created.failure.code).toBe("cancelled");
    // The scan completed and a Git command ran before the cancellation landed.
    expect(processesStarted()).toBeGreaterThan(0);
    expect(openDescriptors()).toBe(before);
  });

  it("is held by a successful workspace and released by close()", async () => {
    const root = await mkdtemp(join(tmpdir(), "countersign-strict-"));
    folders.push(root);
    await writeFile(join(root, "src.ts"), "export const value = 1;\n");
    const before = openDescriptors();
    const created = await openWorkspace({ folder: root, limits: resolveStrictLimits() });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect(openDescriptors()).toBe(before + 1);
    await created.workspace.close();
    expect(openDescriptors()).toBe(before);
  });

  it("captures nothing once it is closed, because the descriptor number can be reused", async () => {
    const root = await mkdtemp(join(tmpdir(), "countersign-strict-"));
    folders.push(root);
    await writeFile(join(root, "src.ts"), "export const value = 1;\n");
    const created = await openWorkspace({ folder: root, limits: resolveStrictLimits() });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    await created.workspace.close();

    const captured = await created.workspace.capture();
    expect(captured.ok).toBe(false);
    if (captured.ok) return;
    expect(captured.failure.code).toBe("baseline_unavailable");
    expect(captured.failure.message).toContain("closed");
  });

  it("keeps Git and spawned processes in the original tree when the path is replaced", async () => {
    const stage = await mkdtemp(join(tmpdir(), "countersign-boundary-"));
    folders.push(stage);
    const root = join(stage, "repo");
    const decoy = join(stage, "decoy");
    await mkdir(root, { recursive: true });
    await mkdir(decoy, { recursive: true });
    await writeFile(join(root, "inside.txt"), "ORIGINAL\n");
    await writeFile(join(decoy, "inside.txt"), "DECOY\n");
    execFileSync("git", ["init", "-q"], { cwd: root });
    execFileSync("git", ["config", "user.name", "Countersign tests"], { cwd: root });
    execFileSync("git", ["config", "user.email", "countersign-tests@example.invalid"], { cwd: root });
    execFileSync("git", ["add", "-A"], { cwd: root });
    execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@e.invalid", "commit", "-qm", "baseline"], { cwd: root });
    execFileSync("git", ["init", "-q"], { cwd: decoy });

    const created = await openWorkspace({ folder: root, limits: resolveStrictLimits() });
    expect(created.ok).toBe(true);
    if (!created.ok) return;

    // The path now points at the decoy; the descriptor still points at the real tree.
    await rename(root, join(stage, "repo-aside"));
    folders.push(join(stage, "repo-aside"));
    await rename(decoy, root);

    // A process launched with the pinned working directory reads the original tree.
    const read = execFileSync("cat", ["inside.txt"], { cwd: created.workspace.pinnedRoot, encoding: "utf8" });
    expect(read.trim()).toBe("ORIGINAL");
    // Git asked through the pinned root answers for the original repository.
    const topLevel = execFileSync("git", ["rev-parse", "--show-toplevel"], {
      cwd: created.workspace.pinnedRoot, encoding: "utf8",
    }).trim();
    expect(topLevel).toBe(join(stage, "repo-aside"));
    expect(topLevel).not.toBe(root);
    await created.workspace.close();
  });
});

describe("credential-shaped paths in Strict", () => {
  it("scans, hashes and diffs a .env like any other file", async () => {
    const root = await mkdtemp(join(tmpdir(), "countersign-strict-"));
    folders.push(root);
    await writeFile(join(root, "src.ts"), "export const value = 1;\n");
    await writeFile(join(root, ".env"), "TOKEN=first\n");
    await mkdir(join(root, ".ssh"), { recursive: true });
    await writeFile(join(root, ".ssh", "id_rsa"), "PRIVATE-ONE\n");
    const created = await openWorkspace({ folder: root, limits: resolveStrictLimits() });
    expect(created.ok).toBe(true);
    if (!created.ok) return;
    expect((await created.workspace.capture()).ok).toBe(true);

    await writeFile(join(root, ".env"), "TOKEN=second\n");
    await writeFile(join(root, ".ssh", "id_rsa"), "PRIVATE-TWO\n");
    const captured = await created.workspace.capture();
    expect(captured.ok).toBe(true);
    if (!captured.ok) return;

    // By product decision these follow the ordinary flow: real content hashes, a real
    // diff, and no inventory or special casing of any kind.
    expect(captured.snapshot.record.entries.map((entry) => entry.path).sort()).toEqual([".env", ".ssh/id_rsa"]);
    expect(captured.snapshot.record.entries.every((entry) => entry.reviewable && entry.afterHash)).toBe(true);
    expect(captured.snapshot.record.reviewable).toBe(true);
    expect(captured.snapshot.diff).toContain("TOKEN=second");
    expect(captured.snapshot.diff).toContain("PRIVATE-TWO");
    expect(captured.snapshot.policyExclusions.some((exclusion) => exclusion.rule.includes("credential"))).toBe(false);
  });

  it("still refuses those paths in Balanced", async () => {
    const root = await mkdtemp(join(tmpdir(), "countersign-balanced-"));
    folders.push(root);
    await writeFile(join(root, "a.ts"), "1\n");
    const tracker = await createWorkspaceChanges(root);
    await writeFile(join(root, ".env"), "TOKEN=1\n");
    await expect(tracker.read()).rejects.toThrow(/excluded from AI review/);
  });
});

describe("shared path policy table", () => {
  it("keeps the Balanced rules exactly as they were", () => {
    expect([...SKIP_DIRS].sort())
      .toEqual([".cache", ".git", ".venv", "build", "coverage", "dist", "node_modules", "target"].sort());
    for (const excluded of [
      "node_modules/pkg/index.js", "dist/out.js", "build/x", "coverage/lcov.info", ".git/config", ".cache/a",
      "home/.ssh/id_rsa", ".aws/credentials", ".gnupg/key", ".env", ".env.local", ".npmrc", ".netrc",
      "id_ed25519", "deploy-secrets.json", "app.pem", "store.p12", "../outside", "/etc/passwd",
    ]) {
      expect(isBalancedExcludedPath(excluded), excluded).toBe(true);
    }
    for (const allowed of [
      "src/a.ts", "internal/notes.md", "environment.ts", "token-bucket/README.md",
      // Balanced never rejected these; only the Strict scanner skips them.
      ".venv/lib/x.py", "target/debug/app", ".vscode-test/x", "countersign.vsix", "npm-debug.log",
    ]) {
      expect(isBalancedExcludedPath(allowed), allowed).toBe(false);
    }
  });

  it("classifies the Strict categories from the same table", () => {
    expect(classifyStrictPath("internal/notes.md")).toMatchObject({ category: "included", action: "scan_and_review" });
    expect(classifyStrictPath("dist/out.js")).toMatchObject({ category: "policy", action: "exclude_without_reading" });
    expect(classifyStrictPath(".vscode-test/runner.js")).toMatchObject({ category: "policy" });
    expect(classifyStrictPath("countersign.vsix")).toMatchObject({ category: "policy" });
    expect(classifyStrictPath(".ssh/id_rsa")).toMatchObject({ category: "included", action: "scan_and_review" });
    expect(classifyStrictPath("config/.env.production")).toMatchObject({ category: "included", action: "scan_and_review" });
    expect(classifyStrictPath("../escape.ts")).toMatchObject({ category: "unsupported", action: "reject_unreviewable" });
  });
});
