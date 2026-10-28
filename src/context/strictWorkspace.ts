import { createHash } from "node:crypto";
import { Dirent, constants as fsConstants } from "node:fs";
import { FileHandle, lstat, open, readdir, readlink, realpath } from "node:fs/promises";
import {
  StrictBaselineIdentity, StrictContentRetention, StrictEntryKind, StrictPolicyExclusion,
  StrictReasonCode, StrictSnapshotEntry, StrictSnapshotRecord, StrictUnreviewableReason, StrictUnsupportedPath,
  StrictUnsupportedPathReason, STRICT_SNAPSHOT_FORMAT_VERSION,
} from "../shared/strict";
import { STRICT_SCAN_CAPS, StrictLimitBreach, StrictLimits } from "../shared/strictLimits";
import { strictBaselineDigest, strictSnapshotDigest } from "../orchestrator/strictSnapshot";
import { ProcessFailure } from "../shared/process";
import { readStrictGit, readStrictGitBaselineFile, StrictGitReading } from "./strictGit";
import { classifyStrictDirectory, classifyStrictPath } from "./pathPolicy";
import { buildFilePatch } from "./workspaceChanges";
import { GitChangeError } from "./gitChanges";

/**
 * The Strict perimeter capture. Unlike Balanced it never takes a Git fast path and never
 * asks Git which files exist: it always walks the filesystem, so a change under internal/
 * is seen even when Git ignores it. Git may supply repository identity and the initial
 * HEAD, nothing more.
 */
export interface StrictWorkspaceFailure {
  code: StrictReasonCode;
  message: string;
  limit?: StrictLimitBreach;
}

export interface StrictWorkspaceSnapshot {
  record: StrictSnapshotRecord;
  /** Unified diff of the reviewable changes only. */
  diff: string;
  policyExclusions: StrictPolicyExclusion[];
  unsupportedPaths: StrictUnsupportedPath[];
  /** Unsupported paths that changed since the baseline; these block a clean completion. */
  changedUnsupportedPaths: StrictUnsupportedPath[];
  /** How much file content the two compared scans kept in memory, and what they dropped. */
  contentRetention: StrictContentRetention;
}

export interface StrictWorkspace {
  readonly root: string;
  /**
   * The root reached through its open descriptor. Git and every provider process use it
   * as their working directory, so the boundary holds even if the path is replaced
   * between a check and a spawn.
   */
  readonly pinnedRoot: string;
  readonly identity: StrictBaselineIdentity;
  /**
   * What Git reported about this workspace when the baseline was taken: the work already
   * present, or why there is no such list. Read through the pinned root.
   */
  readonly startingGit: StrictGitReading;
  /** Exact partial changes verified against the approved baseline before a new provider turn. */
  readonly resumedChanges: readonly { path: string; status: StrictSnapshotEntry["status"] }[];
  /** The partial snapshot observed when the approved baseline was reconstructed. */
  readonly resumedSnapshotDigest?: string;
  /** Releases the pinned root descriptor; the workspace cannot be captured afterwards. */
  close(): Promise<void>;
  capture(signal?: AbortSignal): Promise<StrictCaptureResult>;
}

export type StrictCaptureResult =
  | { ok: true; snapshot: StrictWorkspaceSnapshot }
  | { ok: false; failure: StrictWorkspaceFailure };

export type StrictWorkspaceCreation =
  | { ok: true; workspace: StrictWorkspace }
  | { ok: false; failure: StrictWorkspaceFailure };

/** Why a file that was hashed in full has no bytes kept for diffing. */
type StrictContentOmission = Extract<
  StrictUnreviewableReason,
  "over_file_size_limit" | "binary_without_supported_review" | "content_not_retained"
>;

interface StrictFileState {
  kind: StrictEntryKind;
  size: number;
  mtimeMs: number;
  mode: string;
  hash?: string;
  content?: Buffer;
  /** Set exactly when `content` is absent, so the two cases are never confused. */
  contentOmitted?: StrictContentOmission;
}

/**
 * The scan's diff-content pool. It bounds memory only: reading and hashing are never
 * limited by it, and exhausting it cannot fail a scan.
 */
interface StrictContentPool {
  max: number;
  perFileMax: number;
  retained: number;
  filesWithoutContent: number;
  filesDroppedForBudget: number;
}

interface StrictUnsupportedState {
  reason: StrictUnsupportedPathReason;
  size: number;
  mtimeMs: number;
  /** Inode identity: a path swapped for another node is a change even with equal metadata. */
  ino: number;
  dev: number;
  /** SHA-256 of a symlink's target string, read without following it. */
  targetHash?: string;
}

interface StrictScan {
  /** Inode identity of the scanned root, so later captures can prove it is the same tree. */
  rootIdentity: { ino: number; dev: number };
  included: Map<string, StrictFileState>;
  unsupported: Map<string, StrictUnsupportedState>;
  policy: Map<string, { roots: Set<string>; count: number }>;
  pool: StrictContentPool;
}

class StrictScanError extends Error {
  constructor(readonly failure: StrictWorkspaceFailure) {
    super(failure.message);
    this.name = "StrictScanError";
  }
}

export async function createStrictWorkspaceChanges(options: {
  folder: string;
  limits: StrictLimits;
  signal?: AbortSignal;
  resume?: { baselineDigest: string; baselineHead?: string; preExistingEntries: readonly string[] };
  /**
   * Overrides the per-scan diff-content pool. It exists so the exhaustion path can be
   * exercised without writing the real ceiling to disk; nothing in the product sets it,
   * and no value of it can end a task.
   */
  contentBudgetBytes?: number;
}): Promise<StrictWorkspaceCreation> {
  let root: string;
  let rootHandle: FileHandle;
  let rootIdentity: { ino: number; dev: number };
  try {
    root = await realpath(options.folder);
    // The root is opened once, without following links, and everything afterwards — the
    // baseline, every capture and every descendant — is reached through that descriptor.
    // There is no second resolution of the root path to race against: the only window
    // left is between realpath and this open, and after it no swap can redirect a read.
    rootHandle = await open(root, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
    const pinned = await rootHandle.stat();
    if (!pinned.isDirectory()) throw new Error("not a folder");
    rootIdentity = { ino: pinned.ino, dev: pinned.dev };
  } catch {
    return {
      ok: false,
      failure: { code: "baseline_unavailable", message: "The workspace folder is unavailable on disk." },
    };
  }

  // "/." so the final component is the directory itself: /proc/self/fd/<fd> is a symlink,
  // and O_NOFOLLOW would refuse it while still resolving the parents, which is what the
  // descriptor is for.
  // "/." so the final component is the directory itself: /proc/self/fd/<fd> is a symlink,
  // and O_NOFOLLOW would refuse it while still resolving the parents, which is what the
  // descriptor is for. Everything bound to the root — the scan, Git and the provider
  // processes — uses this path, so a root replaced afterwards cannot redirect any of them.
  const pinnedRoot = `/proc/self/fd/${rootHandle.fd}/.`;
  let closed = false;
  const close = async (): Promise<void> => {
    closed = true;
    await rootHandle.close().catch(() => undefined);
  };

  /**
   * The root is scanned through its own descriptor, so a path swapped afterwards cannot
   * redirect the scan. The path is still compared with the pinned identity, so a root
   * replaced between captures is reported instead of being scanned from the old inode.
   */
  const scanPinnedRoot = async (signal?: AbortSignal, legacyPythonBytecode = false): Promise<StrictScan> => {
    const current = await lstat(root).catch(() => undefined);
    if (!current || current.ino !== rootIdentity.ino || current.dev !== rootIdentity.dev) {
      throw new StrictScanError({
        code: "workspace_changed",
        message: "The workspace root is no longer the directory the baseline was taken from.",
      });
    }
    return scanStrictWorkspace(pinnedRoot, rootIdentity, signal, options.contentBudgetBytes, legacyPythonBytecode);
  };

  // The descriptor belongs to this function until a workspace is handed back; every other
  // exit, including a cancellation raised while Git is read, closes it.
  let owned = true;
  try {
    const current = await scanPinnedRoot(options.signal, Boolean(options.resume));
    if (options.signal?.aborted) return { ok: false, failure: cancelledScanFailure() };
    const git = await readStrictGit(pinnedRoot, rootIdentity, options.signal);
    if (options.signal?.aborted) return { ok: false, failure: cancelledScanFailure() };
    const resumedChanges: { path: string; status: StrictSnapshotEntry["status"] }[] = [];
    const baseline: StrictScan = options.resume
      ? { ...current, included: new Map(current.included), unsupported: new Map(current.unsupported) }
      : current;
    if (options.resume) {
      if (git.kind !== "repository" || !options.resume.baselineHead || git.head !== options.resume.baselineHead) throw new StrictScanError({
        code: "workspace_changed", message: "Git HEAD no longer matches the approved baseline; partial work cannot be identified safely.",
      });
      const previous = new Set(options.resume.preExistingEntries);
      for (const entry of git.dirtyEntries) {
        if (previous.has(entry)) continue;
        const path = entry.slice(3);
        if (entry.length < 4 || !path || path.includes(" -> ") || baseline.unsupported.has(path)) throw new StrictScanError({
          code: "workspace_changed", message: "A partial path cannot be reviewed safely.",
        });
        if (entry.startsWith("?? ")) {
          if (!baseline.included.has(path)) throw new StrictScanError({
            code: "workspace_changed", message: "An untracked partial path is not in the Strict scan.",
          });
          baseline.included.delete(path);
          resumedChanges.push({ path, status: "added" });
          continue;
        }
        const original = await readStrictGitBaselineFile(pinnedRoot, options.resume.baselineHead, path, options.signal);
        if (!original) {
          if (!baseline.included.has(path)) throw new StrictScanError({
            code: "workspace_changed", message: "A newly tracked partial path is not in the Strict scan.",
          });
          baseline.included.delete(path);
          resumedChanges.push({ path, status: "added" });
          continue;
        }
        const originalContent = original.content;
        const originalSize = originalContent.byteLength;
        baseline.included.set(path, {
          kind: "file", size: originalSize, mtimeMs: 0, mode: original.mode,
          hash: createHash("sha256").update(originalContent).digest("hex"),
          ...(originalSize <= STRICT_SCAN_CAPS.maxFileBytes && !originalContent.includes(0)
            ? { content: originalContent } : { contentOmitted: "over_file_size_limit" as const }),
        });
        resumedChanges.push({ path, status: current.included.has(path) ? "modified" : "deleted" });
      }
      // Older approved baselines included Python bytecode. New bytecode generated
      // beneath a newly added source directory did not exist in that baseline and
      // does not appear in Git status. Remove only those candidates, then require
      // the entire reconstructed digest to match the saved approval.
      const newDirectories = new Set(resumedChanges.filter((change) => change.status === "added")
        .map((change) => change.path.slice(0, change.path.lastIndexOf("/") + 1)));
      for (const path of current.included.keys()) {
        if (isPythonBytecodePath(path) && [...newDirectories].some((directory) => path.startsWith(directory))) {
          baseline.included.delete(path);
        }
      }
      if (baselineDigestOf(baseline) !== options.resume.baselineDigest) throw new StrictScanError({
        code: "workspace_changed",
        message: "The workspace differs from the approved baseline beyond the identified partial changes. Inspect the changes before resuming.",
      });
    }
    const identity: StrictBaselineIdentity = {
      root,
      source: "filesystem_scan",
      capturedAt: new Date().toISOString(),
      digest: baselineDigestOf(baseline),
      entryCount: baseline.included.size + baseline.unsupported.size,
      ...(git.kind === "repository" ? { git: { repository: git.repository, ...(git.head ? { head: git.head } : {}) } } : {}),
    };
    // Snapshot review uses the new generated-output policy. The old policy is used
    // only above to prove the historical approved digest before anything is omitted.
    const reviewBaseline = options.resume ? withoutPythonBytecode(baseline) : baseline;
    const resumedSnapshotDigest = options.resume
      ? compareStrict(identity, reviewBaseline, withoutPythonBytecode(current)).record.digest : undefined;
    owned = false;
    return {
      ok: true,
      workspace: {
        root,
        // The path every root-bound process must use as its working directory.
        pinnedRoot,
        identity,
        // Read once, at baseline time, which is exactly when "already present" is defined.
        startingGit: git,
        resumedChanges,
        resumedSnapshotDigest,
        capture: async (signal?: AbortSignal): Promise<StrictCaptureResult> => {
          // The descriptor number can be reused once it is closed, so the pinned path
          // would point at whatever took it. A closed workspace captures nothing.
          if (closed) {
            return {
              ok: false,
              failure: { code: "baseline_unavailable", message: "This Strict workspace was closed and cannot be captured." },
            };
          }
          try {
            const current = await scanPinnedRoot(signal ?? options.signal);
            return { ok: true, snapshot: compareStrict(identity, reviewBaseline, current) };
          } catch (error) {
            return { ok: false, failure: toFailure(error) };
          }
        },
        close,
      },
    };
  } catch (error) {
    // The descriptor is released by the finally below on this path too.
    if (options.signal?.aborted) return { ok: false, failure: cancelledScanFailure() };
    return { ok: false, failure: toFailure(error) };
  } finally {
    if (owned) await close();
  }
}

async function scanStrictWorkspace(
  root: string,
  expectedRoot?: { ino: number; dev: number },
  signal?: AbortSignal,
  contentBudgetBytes = STRICT_SCAN_CAPS.maxRetainedContentBytes,
  legacyPythonBytecode = false,
): Promise<StrictScan> {
  // Every included file is read and hashed in full. The pool below limits only how many of
  // those bytes stay in memory for diffing, so the perimeter's total size never stops a scan.
  const pool: StrictContentPool = {
    max: Math.max(0, contentBudgetBytes),
    perFileMax: STRICT_SCAN_CAPS.maxFileBytes,
    retained: 0,
    filesWithoutContent: 0,
    filesDroppedForBudget: 0,
  };
  const scan: StrictScan = {
    rootIdentity: { ino: 0, dev: 0 },
    included: new Map(), unsupported: new Map(), policy: new Map(), pool,
  };
  let scannedFiles = 0;
  const ensureActive = (): void => {
    if (signal?.aborted) throw new StrictScanError(cancelledScanFailure());
  };

  const countPolicy = (rule: string, path: string): void => {
    const entry = scan.policy.get(rule) ?? { roots: new Set<string>(), count: 0 };
    entry.roots.add(path);
    entry.count += 1;
    scan.policy.set(rule, entry);
  };

  const childPath = (parent: string, name: string): string => parent ? `${parent}/${name}` : name;

  /** Opens a directory without following links and returns a path pinned to its descriptor. */
  const openDirectory = async <T>(
    openPath: string,
    reportPath: string,
    body: (entries: Dirent[], pinned: string) => Promise<T>,
    isRoot = false,
  ): Promise<T> => {
    ensureActive();
    let handle: FileHandle | undefined;
    try {
      handle = await open(openPath, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code === "ELOOP" || code === "ENOTDIR") {
        throw new StrictScanError({
          code: "workspace_changed",
          message: `${reportPath || "The workspace root"} is not a directory any more. Inspect the workspace and start again.`,
        });
      }
      throw error;
    }
    const pinned = `/proc/self/fd/${handle.fd}`;
    try {
      if (isRoot) {
        const opened = await handle.stat();
        scan.rootIdentity = { ino: opened.ino, dev: opened.dev };
        if (expectedRoot && (opened.ino !== expectedRoot.ino || opened.dev !== expectedRoot.dev)) {
          throw new StrictScanError({
            code: "workspace_changed",
            message: "The workspace root was replaced since the baseline was taken. Nothing read from it is used.",
          });
        }
      }
      let entries: Dirent[];
      try {
        entries = await readdir(pinned, { withFileTypes: true });
        ensureActive();
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          throw new StrictScanError({
            code: "baseline_unavailable",
            message: "Strict needs /proc to read directories through open descriptors. This environment does not provide it.",
          });
        }
        throw error;
      }
      return await body(entries, pinned);
    } finally {
      await handle.close().catch(() => undefined);
    }
  };

  const visit = async (openPath: string, directoryPath: string, isRoot = false): Promise<void> =>
    openDirectory(openPath, directoryPath, async (entries, pinned) => {
      for (const entry of entries) {
        ensureActive();
        const path = childPath(directoryPath, entry.name);
        // Resolved through the pinned descriptor, never through the directory's own name.
        const entryPath = `${pinned}/${entry.name}`;
        if (entry.isDirectory()) {
          const directoryPolicy = classifyStrictDirectory(path, entry.name, legacyPythonBytecode);
          if (directoryPolicy.action === "exclude_without_reading") {
            countPolicy(directoryPolicy.rule, path);
            continue;
          }
          if (directoryPolicy.action === "reject_unreviewable") {
            scan.unsupported.set(path, await unsupportedState(entryPath, reasonFor(path)));
            continue;
          }
          await visit(entryPath, path);
          continue;
        }

        const policy = classifyStrictPath(path, legacyPythonBytecode);
        if (policy.action === "exclude_without_reading") {
          countPolicy(policy.rule, path);
          continue;
        }
        const info = await lstat(entryPath);
        if (policy.action === "reject_unreviewable" || !info.isFile()) {
          scan.unsupported.set(path, await unsupportedState(entryPath,
            info.isSymbolicLink() ? "symlink" : info.isFile() ? reasonFor(path) : "special_file", info));
          continue;
        }

        scannedFiles += 1;
        if (scannedFiles > STRICT_SCAN_CAPS.maxScannedFiles) {
          throw new StrictScanError({
            code: "limit_reached",
            message: `The Strict perimeter exceeds ${STRICT_SCAN_CAPS.maxScannedFiles} scanned files. Open a smaller folder.`,
            limit: {
              limit: "scan.maxScannedFiles", phase: "implementation", unit: "files",
              configured: STRICT_SCAN_CAPS.maxScannedFiles, observed: scannedFiles,
            },
          });
        }
        // Every included file is hashed, whatever its size and whatever the perimeter
        // weighs: size and mtime are not proof of content. Only the bytes kept for diffing
        // are capped, and a file whose bytes are not kept records why.
        const read = await readRegularFile(entryPath, info, pool, signal);
        if (!read) {
          scan.unsupported.set(path, await unsupportedState(entryPath, "symlink", info));
          continue;
        }
        scan.included.set(path, {
          kind: "file",
          size: info.size,
          mtimeMs: info.mtimeMs,
          mode: (read.mode & 0o111) === 0 ? "100644" : "100755",
          hash: read.hash,
          ...(read.content ? { content: read.content } : { contentOmitted: read.contentOmitted }),
        });
      }
    }, isRoot);

  try {
    await visit(root, "", true);
  } catch (error) {
    if (error instanceof StrictScanError) throw error;
    throw new StrictScanError({
      code: "baseline_unavailable",
      message: `The Strict perimeter could not be read: ${error instanceof Error ? error.message : "unknown error"}`,
    });
  }
  return scan;
}

/**
 * Streams one regular file: it is always hashed in full, and its bytes are kept only while
 * the scan's pool has room for them. A file read but not kept comes back with the reason,
 * so a later change in it is reported as unreviewable instead of undiffable-but-silent.
 */
async function readRegularFile(
  absolute: string,
  expected: { ino: number; dev: number; size: number },
  pool: StrictContentPool,
  signal?: AbortSignal,
): Promise<{ hash: string; mode: number; content?: Buffer; contentOmitted?: StrictContentOmission } | undefined> {
  let handle: FileHandle | undefined;
  try {
    // O_NONBLOCK so that a regular file swapped for a FIFO cannot park the capture on an
    // open() that waits for a writer: the type is checked after the handle exists, and on
    // a regular file the flag changes nothing.
    handle = await open(absolute, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || Number(opened.ino) !== expected.ino || Number(opened.dev) !== expected.dev) return undefined;
    const changedDuringRead = (): StrictScanError => new StrictScanError({
      code: "workspace_changed",
      message: "A file changed while the Strict perimeter was being read. Nothing read during that scan is used.",
    });
    // A file that grew after lstat must not turn the uncapped stream into an arbitrarily
    // long read. The descriptor's size is the maximum this scan will consume.
    if (opened.size !== BigInt(expected.size)) throw changedDuringRead();
    const digest = createHash("sha256");
    let chunks: Buffer[] = [];
    let reserved = 0;
    let omitted: StrictContentOmission | undefined =
      expected.size > pool.perFileMax ? "over_file_size_limit" : undefined;
    let read = 0;
    for await (const chunk of handle.createReadStream({ autoClose: false })) {
      if (signal?.aborted) throw new StrictScanError(cancelledScanFailure());
      const buffer = chunk as Buffer;
      read += buffer.byteLength;
      if (read > expected.size) throw changedDuringRead();
      digest.update(buffer);
      if (omitted) continue;
      // Three different reasons to stop keeping this file's bytes: it grew past the
      // snapshot limit mid-read, it is not text so it could never be diffed anyway, or
      // the pool is full. Hashing continues in every case.
      const reason: StrictContentOmission | undefined = read > pool.perFileMax
        ? "over_file_size_limit"
        : buffer.includes(0)
        ? "binary_without_supported_review"
        : pool.retained + buffer.byteLength > pool.max
        ? "content_not_retained"
        : undefined;
      if (reason) {
        omitted = reason;
        chunks = [];
        // Hand back what this file had reserved: a later, smaller file may still fit.
        pool.retained -= reserved;
        reserved = 0;
        continue;
      }
      pool.retained += buffer.byteLength;
      reserved += buffer.byteLength;
      chunks.push(buffer);
    }
    const closing = await handle.stat({ bigint: true });
    // A rewrite that keeps the length would leave the byte count intact, so the read is
    // bracketed by the inode's own timestamps. ctime cannot be set from user space: any
    // write during the read moves it, and a restored mtime moves it too.
    if (read !== expected.size
      || closing.size !== opened.size
      || closing.mode !== opened.mode
      || closing.mtimeNs !== opened.mtimeNs
      || closing.ctimeNs !== opened.ctimeNs) {
      pool.retained -= reserved;
      throw changedDuringRead();
    }
    if (omitted) {
      pool.filesWithoutContent += 1;
      if (omitted === "content_not_retained") pool.filesDroppedForBudget += 1;
    }
    // The mode comes from the open file, not from the earlier lstat: a chmod landing in
    // between would otherwise be recorded with the stale permission bits.
    return {
      hash: digest.digest("hex"),
      mode: Number(opened.mode),
      ...(omitted ? { contentOmitted: omitted } : { content: Buffer.concat(chunks) }),
    };
  } catch (error) {
    if (error instanceof StrictScanError) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ELOOP" || code === "ENOENT" || code === "EACCES" || code === "EPERM") return undefined;
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/**
 * Metadata for a path Strict cannot review. A symlink also carries the hash of its target
 * string, read without following it: a target swapped for one of the same length with the
 * timestamp restored is still a change.
 */
async function unsupportedState(
  absolute: string,
  reason: StrictUnsupportedPathReason,
  info?: { size: number; mtimeMs: number; ino: number; dev: number; isSymbolicLink(): boolean },
): Promise<StrictUnsupportedState> {
  const stats = info ?? await lstat(absolute);
  const state: StrictUnsupportedState = {
    reason, size: stats.size, mtimeMs: stats.mtimeMs, ino: stats.ino, dev: stats.dev,
  };
  if (!stats.isSymbolicLink()) return state;
  try {
    const target = await readlink(absolute, { encoding: "buffer" });
    state.targetHash = createHash("sha256").update(target).digest("hex");
  } catch {
    // An unreadable link stays unsupported; its absence of hash blocks a clean completion.
  }
  return state;
}

function compareStrict(
  identity: StrictBaselineIdentity,
  before: StrictScan,
  after: StrictScan,
): StrictWorkspaceSnapshot {
  const entries: StrictSnapshotEntry[] = [];
  const patches: string[] = [];
  const paths = [...new Set([...before.included.keys(), ...after.included.keys()])].sort();

  const changed = paths.filter((path) => differs(before.included.get(path), after.included.get(path)));

  for (const path of changed) {
    const old = before.included.get(path);
    const current = after.included.get(path);
    const status = !old ? "added" : !current ? "deleted" : "modified";
    const reason = unreviewableReason(old, current);
    const entry: StrictSnapshotEntry = {
      path,
      kind: "file",
      status,
      ...(old ? { beforeMode: old.mode, beforeSize: old.size, ...(old.hash ? { beforeHash: old.hash } : {}) } : {}),
      ...(current ? { afterMode: current.mode, afterSize: current.size, ...(current.hash ? { afterHash: current.hash } : {}) } : {}),
      reviewable: reason === undefined,
      ...(reason ? { unreviewableReason: reason } : {}),
    };
    if (reason === "binary_without_supported_review") entry.kind = "binary";
    entries.push(entry);
    if (reason !== undefined) continue;
    // A file the patch builder refuses is an unreviewable change, not an unreadable
    // perimeter: say which file and why, instead of blaming the workspace.
    try {
      patches.push(buildFilePatch(path, old?.content, current?.content));
    } catch (error) {
      if (!(error instanceof GitChangeError)) throw error;
      throw new StrictScanError({ code: "unreviewable_change", message: error.message });
    }
  }

  const diff = patches.join("\n");

  const changedUnsupportedPaths: StrictUnsupportedPath[] = [];
  for (const path of new Set([...before.unsupported.keys(), ...after.unsupported.keys()])) {
    const old = before.unsupported.get(path);
    const current = after.unsupported.get(path);
    if (unsupportedDiffers(old, current)) {
      changedUnsupportedPaths.push({ path, reason: (current ?? old as StrictUnsupportedState).reason });
    }
  }

  return {
    record: {
      formatVersion: STRICT_SNAPSHOT_FORMAT_VERSION,
      digest: strictSnapshotDigest({ baseline: identity, entries }),
      baselineDigest: identity.digest,
      capturedAt: new Date().toISOString(),
      entries,
      changedFileCount: entries.length,
      reviewable: entries.every((entry) => entry.reviewable) && changedUnsupportedPaths.length === 0,
    },
    diff,
    policyExclusions: [...after.policy.entries()].map(([rule, value]) => ({
      rule,
      root: [...value.roots].sort()[0] ?? "",
      entryCount: value.count,
    })),
    unsupportedPaths: [...after.unsupported.entries()].map(([path, value]) => ({ path, reason: value.reason })),
    changedUnsupportedPaths,
    contentRetention: {
      maxBytes: after.pool.max,
      retainedBytes: after.pool.retained,
      filesWithoutContent: after.pool.filesWithoutContent,
      filesDroppedForBudget: after.pool.filesDroppedForBudget,
      baselineFilesDroppedForBudget: before.pool.filesDroppedForBudget,
    },
  };
}

/** A link target, an inode or any metadata moving counts; an unhashable link always counts. */
function unsupportedDiffers(before: StrictUnsupportedState | undefined, after: StrictUnsupportedState | undefined): boolean {
  if (!before || !after) return true;
  if (before.reason !== after.reason || before.ino !== after.ino || before.dev !== after.dev) return true;
  if (before.size !== after.size || before.mtimeMs !== after.mtimeMs) return true;
  if (before.targetHash === undefined || after.targetHash === undefined) {
    return before.targetHash !== after.targetHash || before.reason === "symlink";
  }
  return before.targetHash !== after.targetHash;
}

function differs(before: StrictFileState | undefined, after: StrictFileState | undefined): boolean {
  if (!before || !after) return true;
  if (before.kind !== after.kind || before.size !== after.size || before.mode !== after.mode) return true;
  // Both sides are always hashed; an absent hash means the content could not be read, and
  // that is reported as a change rather than assumed equal.
  if (before.hash && after.hash) return before.hash !== after.hash;
  return true;
}

/**
 * A change can only be reviewed when both sides of it are text the scan still holds. A
 * missing side reports why it is missing: the file was too large on its own, it is not
 * text, or the scan's diff-content pool was full when it was read. The three are distinct
 * because only the first is about the file's own size.
 */
function unreviewableReason(before: StrictFileState | undefined, after: StrictFileState | undefined): StrictUnreviewableReason | undefined {
  for (const state of [before, after]) {
    if (!state) continue;
    if (!state.content) return state.contentOmitted ?? "content_not_retained";
    if (!isUtf8Text(state.content)) return "binary_without_supported_review";
  }
  return undefined;
}

function isUtf8Text(content: Buffer): boolean {
  if (content.includes(0)) return false;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(content);
    return true;
  } catch {
    return false;
  }
}

function isPythonBytecodePath(path: string): boolean {
  return path.split("/").some((part) => part.toLowerCase() === "__pycache__") || /\.(?:pyc|pyo)$/i.test(path);
}

/** Applies the current generated-output policy to a scan made with the old policy. */
function withoutPythonBytecode(scan: StrictScan): StrictScan {
  const included = new Map(scan.included);
  const unsupported = new Map(scan.unsupported);
  const policy = new Map(scan.policy);
  let count = 0;
  let root = "";
  for (const path of new Set([...included.keys(), ...unsupported.keys()])) {
    if (!isPythonBytecodePath(path)) continue;
    included.delete(path);
    unsupported.delete(path);
    count += 1;
    root ||= path;
  }
  if (count > 0) policy.set("python-bytecode-resume", { roots: new Set([root]), count });
  return { ...scan, included, unsupported, policy };
}

function baselineDigestOf(scan: StrictScan): string {
  return strictBaselineDigest([
    ...[...scan.included.entries()].map(([path, state]) => ({
      path, kind: state.kind, size: state.size, hash: state.hash, mtimeMs: state.mtimeMs,
    })),
    ...[...scan.unsupported.entries()].map(([path, state]) => ({
      path, kind: `unsupported:${state.reason}`, size: state.size, mtimeMs: state.mtimeMs,
    })),
  ]);
}

function reasonFor(path: string): StrictUnsupportedPathReason {
  const normalized = path.replaceAll("\\", "/");
  if (normalized.split("/").includes("..")) return "parent_segment";
  if (path.includes("\0") || path.includes("\n")) return "nul_or_newline";
  if (normalized.startsWith("/")) return "absolute_path";
  return "special_file";
}

function cancelledScanFailure(): StrictWorkspaceFailure {
  return { code: "cancelled", message: "The Strict task was cancelled." };
}

function toFailure(error: unknown): StrictWorkspaceFailure {
  if (error instanceof StrictScanError) return error.failure;
  // A cancellation raised by a Git command, or by anything else holding the signal, is a
  // cancelled task rather than an unreadable perimeter.
  if (error instanceof ProcessFailure && error.kind === "cancelled") return cancelledScanFailure();
  return {
    code: "baseline_unavailable",
    message: `The Strict perimeter could not be compared: ${error instanceof Error ? error.message : "unknown error"}`,
  };
}
