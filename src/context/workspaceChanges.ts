import { createHash } from "node:crypto";
import { lstat, readFile, readdir, realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";
import { GitChangeError, GitChanges, readGitChanges, validateReviewPath } from "./gitChanges";
import { SKIP_DIRS } from "./pathPolicy";
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
// Bound the bytes kept for patches, not the amount of workspace we may inspect.
// Files outside this pool are still hashed and compared; if one changes, Balanced
// reports that it cannot build a safe patch instead of claiming the tree is clean.
const MAX_RETAINED_SNAPSHOT_BYTES = 64 * 1024 * 1024;
const MAX_SNAPSHOT_FILE_BYTES = 1024 * 1024;
const MAX_DIFF_EDIT_DISTANCE = 2_048;

interface DiffOperation { kind: "equal" | "delete" | "insert"; line: string }

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
  let retainedBytes = 0;
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
        const canonical = await realpath(absolute);
        if (!canonical.startsWith(`${root}${sep}`)) throw new GitChangeError(`File ${path} resolves outside the workspace.`);
        const content = await readFile(absolute);
        state.hash = createHash("sha256").update(content).digest("hex");
        if (retainContents && retainedBytes + content.length <= MAX_RETAINED_SNAPSHOT_BYTES) {
          state.content = content;
          retainedBytes += content.length;
        }
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
      if (!state.content) throw new GitChangeError(`Changed path ${path} has no retained content for a patch. Narrow the changed files or use Git.`);
    }
    if (!old && current && current.size > MAX_NEW_FILE_BYTES) {
      throw new GitChangeError(`New file ${path} exceeds ${MAX_NEW_FILE_BYTES} bytes.`);
    }
    parts.push(buildFilePatch(path, old?.content, current?.content));
  }
  const diff = parts.join("\n");
  if (Buffer.byteLength(diff) > MAX_DIFF_BYTES) throw new GitChangeError(`Diff exceeds ${MAX_DIFF_BYTES} bytes. Narrow the task before review.`);
  return { paths, entries: paths.map((path) => `${before.has(path) ? after.has(path) ? " M" : " D" : "??"} ${path}`), diff };
}

/**
 * One unified patch for one path. Shared with the Strict scanner so both produce the
 * same patch text. git apply strips one leading path component, so a creation or a
 * deletion needs its mode header; without it the "/dev/null" side is read as the
 * literal path "dev/null".
 */
export function buildFilePatch(path: string, before: Buffer | undefined, after: Buffer | undefined): string {
  const operations = diffLines(lines(decode(before, path)), lines(decode(after, path)), path);
  return [`diff --git a/${path} b/${path}`,
    ...(before ? [] : ["new file mode 100644"]), ...(after ? [] : ["deleted file mode 100644"]),
    `--- ${before ? `a/${path}` : "/dev/null"}`, `+++ ${after ? `b/${path}` : "/dev/null"}`,
    ...formatHunks(operations)].join("\n") + "\n";
}

function decode(content: Buffer | undefined, path: string): string {
  if (!content) return "";
  if (content.includes(0)) throw new GitChangeError(`Changed file ${path} is not UTF-8 text.`);
  try { return new TextDecoder("utf-8", { fatal: true }).decode(content); }
  catch { throw new GitChangeError(`Changed file ${path} is not UTF-8 text.`); }
}

function lines(value: string): string[] {
  if (!value) return [];
  const result = value.split("\n");
  if (value.endsWith("\n")) result.pop();
  else result[result.length - 1] += "\0";
  return result;
}

function diffLines(before: string[], after: string[], path: string): DiffOperation[] {
  const maxDistance = Math.min(before.length + after.length, MAX_DIFF_EDIT_DISTANCE);
  const offset = maxDistance + 1;
  const frontier = new Int32Array(maxDistance * 2 + 3);
  frontier.fill(-1);
  frontier[offset + 1] = 0;
  const trace: Int32Array[] = [];

  for (let distance = 0; distance <= maxDistance; distance++) {
    trace.push(frontier.slice(offset - distance - 1, offset + distance + 2));
    for (let diagonal = -distance; diagonal <= distance; diagonal += 2) {
      const index = offset + diagonal;
      let x = diagonal === -distance || (diagonal !== distance && frontier[index - 1] < frontier[index + 1])
        ? frontier[index + 1]
        : frontier[index - 1] + 1;
      let y = x - diagonal;
      while (x < before.length && y < after.length && before[x] === after[y]) { x++; y++; }
      frontier[index] = x;
      if (x >= before.length && y >= after.length) return backtrack(before, after, trace, distance);
    }
  }

  throw new GitChangeError(`File ${path} has too many line edits for a safe snapshot review. Split the task before review.`);
}

function backtrack(before: string[], after: string[], trace: Int32Array[], distance: number): DiffOperation[] {
  let x = before.length;
  let y = after.length;
  const reversed: DiffOperation[] = [];
  for (let step = distance; step > 0; step--) {
    const previous = trace[step];
    const diagonal = x - y;
    const left = previous[diagonal - 1 + step + 1];
    const right = previous[diagonal + 1 + step + 1];
    const previousDiagonal = diagonal === -step || (diagonal !== step && left < right)
      ? diagonal + 1
      : diagonal - 1;
    const previousX = previous[previousDiagonal + step + 1];
    const previousY = previousX - previousDiagonal;
    while (x > previousX && y > previousY) {
      reversed.push({ kind: "equal", line: before[x - 1] });
      x--; y--;
    }
    if (x === previousX) {
      reversed.push({ kind: "insert", line: after[y - 1] });
      y--;
    } else {
      reversed.push({ kind: "delete", line: before[x - 1] });
      x--;
    }
  }
  while (x > 0 && y > 0) {
    reversed.push({ kind: "equal", line: before[x - 1] });
    x--; y--;
  }
  while (x > 0) reversed.push({ kind: "delete", line: before[--x] });
  while (y > 0) reversed.push({ kind: "insert", line: after[--y] });
  return reversed.reverse();
}

function formatHunks(operations: DiffOperation[]): string[] {
  const changed: number[] = [];
  for (let index = 0; index < operations.length; index++) {
    if (operations[index].kind !== "equal") changed.push(index);
  }
  if (changed.length === 0) return [];

  const ranges: { start: number; end: number }[] = [];
  for (const index of changed) {
    const start = Math.max(0, index - 3);
    const end = Math.min(operations.length, index + 4);
    const previous = ranges.at(-1);
    if (previous && start <= previous.end) previous.end = Math.max(previous.end, end);
    else ranges.push({ start, end });
  }

  const oldLinesBefore = new Uint32Array(operations.length + 1);
  const newLinesBefore = new Uint32Array(operations.length + 1);
  for (let index = 0; index < operations.length; index++) {
    const kind = operations[index].kind;
    oldLinesBefore[index + 1] = oldLinesBefore[index] + (kind === "insert" ? 0 : 1);
    newLinesBefore[index + 1] = newLinesBefore[index] + (kind === "delete" ? 0 : 1);
  }

  return ranges.map(({ start, end }) => {
    const oldCount = oldLinesBefore[end] - oldLinesBefore[start];
    const newCount = newLinesBefore[end] - newLinesBefore[start];
    const oldStart = oldCount === 0 ? oldLinesBefore[start] : oldLinesBefore[start] + 1;
    const newStart = newCount === 0 ? newLinesBefore[start] : newLinesBefore[start] + 1;
    const lines = [`@@ -${oldStart},${oldCount} +${newStart},${newCount} @@`];
    for (let index = start; index < end; index++) {
      const operation = operations[index];
      const prefix = operation.kind === "equal" ? " " : operation.kind === "delete" ? "-" : "+";
      const unterminated = operation.line.endsWith("\0");
      lines.push(`${prefix}${unterminated ? operation.line.slice(0, -1) : operation.line}`);
      if (unterminated) lines.push("\\ No newline at end of file");
    }
    return lines.join("\n");
  });
}
