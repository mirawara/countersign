import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { GitChangeError, GitChanges, readGitChanges, validateReviewPath } from "./gitChanges";
import { GitPreflightError, preflightGit } from "./gitPreflight";

export interface WorkspaceChanges {
  readonly root: string;
  readonly source: "git" | "git-snapshot" | "snapshot";
  readonly startingEntries: string[];
  read(): Promise<GitChanges>;
}

type FileState = { kind: "file" | "other"; content?: Buffer; hash?: string; size: number; modified: number };
const MAX_FILES = 40;
const MAX_DIFF_BYTES = 262_144;
const MAX_NEW_FILE_BYTES = 16_384;
const MAX_SNAPSHOT_FILES = 20_000;
const MAX_SNAPSHOT_BYTES = 64 * 1024 * 1024;
const MAX_SNAPSHOT_FILE_BYTES = 1024 * 1024;
const SKIP_DIRS = new Set([".git", "node_modules", "dist", "build", "coverage", ".cache", ".venv", "target"]);

export async function createWorkspaceChanges(folder: string): Promise<WorkspaceChanges> {
  let root: string;
  try {
    root = await realpath(folder);
    if (!(await lstat(root)).isDirectory()) throw new Error("The workspace path is not a folder.");
  } catch {
    throw new Error("The workspace folder is unavailable on disk.");
  }
  try {
    const git = await preflightGit(root);
    if (git.dirtyEntries.length === 0) {
      return { root: git.repository, source: "git", startingEntries: [], read: () => readGitChanges(git.repository) };
    }
    const baseline = await scan(root);
    await assertSnapshotStable(root, baseline);
    const verifiedGit = await preflightGit(root);
    if (JSON.stringify(verifiedGit.dirtyEntries) !== JSON.stringify(git.dirtyEntries)) {
      throw new Error("Git status changed while the initial workspace snapshot was captured. Start again.");
    }
    return { root: git.repository, source: "git-snapshot", startingEntries: git.dirtyEntries,
      read: async () => compare(baseline, await scan(root)) };
  } catch (error) {
    if (!(error instanceof GitPreflightError)) throw error;
    // A nested Git directory is treated as the exact workspace folder. Its own
    // snapshot excludes .git, so no parent repository is silently included.
  }
  const baseline = await scan(root);
  await assertSnapshotStable(root, baseline);
  return { root, source: "snapshot", startingEntries: [], read: async () => compare(baseline, await scan(root)) };
}

async function assertSnapshotStable(root: string, baseline: Map<string, FileState>): Promise<void> {
  const verification = await scan(root, false);
  if (!sameSnapshot(baseline, verification)) {
    throw new Error("The workspace changed while the initial file snapshot was captured. Start again.");
  }
}

async function scan(root: string, retainContents = true): Promise<Map<string, FileState>> {
  const files = new Map<string, FileState>();
  let totalBytes = 0;
  async function visit(directory: string): Promise<void> {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const absolute = resolve(directory, entry.name);
      const path = relative(root, absolute).split(sep).join("/");
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) await visit(absolute);
        continue;
      }
      if (files.size >= MAX_SNAPSHOT_FILES) throw new GitChangeError(`Workspace snapshot exceeds ${MAX_SNAPSHOT_FILES} files. Open a smaller folder.`);
      const info = await lstat(absolute);
      const state: FileState = { kind: info.isFile() ? "file" : "other", size: info.size, modified: info.mtimeMs };
      if (info.isFile() && info.size <= MAX_SNAPSHOT_FILE_BYTES) {
        // Excluded filenames are never read into the report or snapshot.
        try { validateReviewPath(path); } catch { files.set(path, state); continue; }
        totalBytes += info.size;
        if (totalBytes > MAX_SNAPSHOT_BYTES) throw new GitChangeError(`Workspace snapshot exceeds ${MAX_SNAPSHOT_BYTES} bytes. Open a smaller folder.`);
        const canonical = await realpath(absolute);
        if (!canonical.startsWith(`${root}${sep}`)) throw new GitChangeError(`File ${path} resolves outside the workspace.`);
        const content = await readFile(absolute);
        state.hash = createHash("sha256").update(content).digest("hex");
        if (retainContents) state.content = content;
      }
      files.set(path, state);
    }
  }
  await visit(root);
  return files;
}

function sameSnapshot(before: Map<string, FileState>, after: Map<string, FileState>): boolean {
  if (before.size !== after.size) return false;
  for (const [path, old] of before) {
    const current = after.get(path);
    if (!current || old.kind !== current.kind || old.size !== current.size) return false;
    if (old.hash && current.hash) {
      if (old.hash !== current.hash) return false;
    } else if (old.modified !== current.modified) {
      return false;
    }
  }
  return true;
}

function compare(before: Map<string, FileState>, after: Map<string, FileState>): GitChanges {
  const paths = [...new Set([...before.keys(), ...after.keys()])].filter((path) => {
    const old = before.get(path), current = after.get(path);
    return !old || !current || old.kind !== current.kind || old.size !== current.size ||
      (old.hash && current.hash ? old.hash !== current.hash
        : old.content && current.content ? !old.content.equals(current.content) : old.modified !== current.modified);
  }).sort();
  if (paths.length > MAX_FILES) throw new GitChangeError(`More than ${MAX_FILES} files changed. Narrow the task before review.`);
  const parts: string[] = [];
  for (const path of paths) {
    try { validateReviewPath(path); }
    catch { throw new GitChangeError(`Changed path ${JSON.stringify(path)} is excluded from AI review; its contents were not read.`); }
    const old = before.get(path), current = after.get(path);
    for (const state of [old, current]) {
      if (!state) continue;
      if (state.kind !== "file") throw new GitChangeError(`Changed path ${path} is a symlink or special file; its contents were not read.`);
      if (!state.content && state.size > MAX_SNAPSHOT_FILE_BYTES) {
        throw new GitChangeError(`Changed file ${path} exceeds the ${MAX_SNAPSHOT_FILE_BYTES}-byte snapshot limit; its contents were not read.`);
      }
      if (!state.content) throw new GitChangeError(`Changed path ${path} was excluded from the snapshot; its contents were not read.`);
    }
    if (!old && current && current.size > MAX_NEW_FILE_BYTES) {
      throw new GitChangeError(`New file ${path} exceeds ${MAX_NEW_FILE_BYTES} bytes.`);
    }
    const oldText = decode(old?.content, path), newText = decode(current?.content, path);
    const oldLines = lines(oldText), newLines = lines(newText);
    parts.push([`diff --git a/${path} b/${path}`,
      `--- ${old ? `a/${path}` : "/dev/null"}`, `+++ ${current ? `b/${path}` : "/dev/null"}`,
      `@@ -${oldLines.length ? "1" : "0"},${oldLines.length} +${newLines.length ? "1" : "0"},${newLines.length} @@`,
      ...oldLines.map((line) => `-${line}`), ...newLines.map((line) => `+${line}`)].join("\n") + "\n");
  }
  const diff = parts.join("\n");
  if (Buffer.byteLength(diff) > MAX_DIFF_BYTES) throw new GitChangeError(`Diff exceeds ${MAX_DIFF_BYTES} bytes. Narrow the task before review.`);
  return { paths, entries: paths.map((path) => `${before.has(path) ? after.has(path) ? " M" : " D" : "??"} ${path}`), diff };
}

function decode(content: Buffer | undefined, path: string): string {
  if (!content) return "";
  if (content.includes(0)) throw new GitChangeError(`Changed file ${path} is not UTF-8 text.`);
  try { return new TextDecoder("utf-8", { fatal: true }).decode(content); }
  catch { throw new GitChangeError(`Changed file ${path} is not UTF-8 text.`); }
}

function lines(value: string): string[] { return value ? value.replace(/\n$/, "").split("\n") : []; }
