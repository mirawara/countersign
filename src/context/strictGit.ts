import { lstat } from "node:fs/promises";
import { ProcessFailure, runExecutable } from "../shared/process";

/**
 * The Git reads Strict is allowed to make. Every command runs with its working directory
 * set to the root reached through its open descriptor, and no path produced by realpath
 * or by Git's own output ever becomes the working directory of the next command: a root
 * replaced between two commands cannot move them into another repository.
 *
 * Balanced keeps using preflightGit and readGitStatus unchanged.
 */
export type StrictGitReading =
  | { kind: "repository"; repository: string; head?: string; dirtyEntries: string[] }
  /** No repository whose top level is the scanned root. */
  | { kind: "none" }
  /** Git exists but could not answer; this is not evidence of a clean tree. */
  | { kind: "unavailable" };

// Git is a local read bound to the task's cancellation signal, not a timed request.
const GIT_TIMEOUT_MS = 0;

export async function readStrictGit(
  pinnedRoot: string,
  rootIdentity: { ino: number; dev: number },
  signal?: AbortSignal,
): Promise<StrictGitReading> {
  const topLevel = await git(pinnedRoot, ["rev-parse", "--show-toplevel"], signal);
  if (topLevel === undefined) return { kind: "unavailable" };
  if (topLevel.exitCode !== 0) return { kind: "none" };
  const repository = topLevel.stdout.trim();
  if (!repository) return { kind: "none" };

  // Identity only, never a working directory: the reported top level has to be the very
  // directory the scan pinned, or Strict does not treat this workspace as a repository.
  const reported = await lstat(repository).catch(() => undefined);
  if (!reported || reported.ino !== rootIdentity.ino || reported.dev !== rootIdentity.dev) {
    return { kind: "none" };
  }

  const status = await git(pinnedRoot, ["status", "--porcelain=v1", "--untracked-files=all"], signal);
  if (status === undefined) return { kind: "unavailable" };
  if (status.exitCode !== 0) return { kind: "unavailable" };

  const head = await git(pinnedRoot, ["rev-parse", "HEAD"], signal);
  if (head === undefined) return { kind: "unavailable" };
  const revision = head.exitCode === 0 ? head.stdout.trim() : undefined;

  return {
    kind: "repository",
    repository,
    ...(revision ? { head: revision } : {}),
    dirtyEntries: status.stdout.split(/\r?\n/).filter(Boolean),
  };
}

/** Immutable HEAD blob used only to reconstruct an approved baseline after interruption. */
export async function readStrictGitBaselineFile(
  pinnedRoot: string, head: string, path: string, signal?: AbortSignal,
): Promise<{ content: Buffer; mode: string } | undefined> {
  if (!/^[0-9a-f]{40,64}$/.test(head) || !path || path.startsWith("/") ||
      path.split("/").includes("..") || /[\r\n\0]/.test(path)) {
    throw new Error("Invalid Git baseline file identity.");
  }
  const tree = await runExecutable("git", ["-c", "core.fsmonitor=false", "ls-tree", head, "--", path], {
    cwd: pinnedRoot, timeoutMs: GIT_TIMEOUT_MS, maxOutputBytes: 4_096, signal,
  });
  if (tree.exitCode !== 0) throw new Error("Git could not read the approved baseline tree.");
  if (!tree.stdout.trim()) return undefined;
  const match = tree.stdout.match(/^([0-7]{6}) blob [0-9a-f]+\t(.+)\n?$/);
  if (!match || match[2] !== path) throw new Error("The approved baseline path is not a regular Git blob.");
  const blob = await runExecutable("git", ["-c", "core.fsmonitor=false", "show", `${head}:${path}`], {
    cwd: pinnedRoot, timeoutMs: GIT_TIMEOUT_MS, maxOutputBytes: 2 * 1024 * 1024, signal,
  });
  if (blob.exitCode !== 0) throw new Error("Git could not read the approved baseline file.");
  return { content: Buffer.from(blob.stdout, "utf8"), mode: match[1] };
}

/** Returns undefined when Git could not run; a cancellation is rethrown to the task. */
async function git(
  pinnedRoot: string,
  args: string[],
  signal?: AbortSignal,
): Promise<{ exitCode: number | null; stdout: string } | undefined> {
  try {
    const result = await runExecutable("git", ["-c", "core.fsmonitor=false", "--no-optional-locks", ...args], {
      cwd: pinnedRoot,
      timeoutMs: GIT_TIMEOUT_MS,
      maxOutputBytes: 1_048_576,
      signal,
    });
    return { exitCode: result.exitCode, stdout: result.stdout };
  } catch (error) {
    if (error instanceof ProcessFailure && error.kind === "cancelled") throw error;
    return undefined;
  }
}
