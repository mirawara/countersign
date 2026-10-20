import { realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { ProcessFailure, runExecutable } from "../shared/process";

export type GitPreflightErrorKind = "not_a_repository" | "workspace_mismatch" | "dirty_repository" | "git_unavailable";

export class GitPreflightError extends Error {
  constructor(readonly kind: GitPreflightErrorKind, message: string) {
    super(message);
    this.name = "GitPreflightError";
  }
}

export interface GitPreflightResult {
  repository: string;
  dirtyEntries: string[];
}

export async function preflightGit(workspacePath: string): Promise<GitPreflightResult> {
  let workspaceRealPath: string;
  try {
    workspaceRealPath = await realpath(workspacePath);
  } catch {
    throw new GitPreflightError("not_a_repository", "The workspace folder is not available on disk.");
  }

  let topLevel: string;
  try {
    const top = await runExecutable("git", ["-c", "core.fsmonitor=false", "rev-parse", "--show-toplevel"], {
      cwd: workspaceRealPath,
      timeoutMs: 10_000,
    });
    if (top.exitCode !== 0) {
      throw new GitPreflightError("not_a_repository", "The workspace is not inside a Git repository.");
    }
    topLevel = await realpath(top.stdout.trim());
  } catch (error) {
    if (error instanceof GitPreflightError) throw error;
    if (error instanceof ProcessFailure) {
      if (error.kind === "spawn_error") {
        throw new GitPreflightError("git_unavailable", "Git could not be started.");
      }
      throw new GitPreflightError("not_a_repository", "Git could not inspect the workspace.");
    }
    throw new GitPreflightError("not_a_repository", "The workspace is not inside a Git repository.");
  }

  if (!samePath(workspaceRealPath, topLevel)) {
    throw new GitPreflightError(
      "workspace_mismatch",
      "Open the repository root as the VS Code workspace before starting a task.",
    );
  }

  try {
    const dirtyEntries = await readGitStatus(topLevel);
    if (dirtyEntries.length > 0) {
      throw new GitPreflightError(
        "dirty_repository",
        `The repository has ${dirtyEntries.length} tracked or untracked change(s). Commit or move them before starting.`,
      );
    }
    return { repository: topLevel, dirtyEntries };
  } catch (error) {
    if (error instanceof GitPreflightError) throw error;
    if (error instanceof ProcessFailure && error.kind === "spawn_error") {
      throw new GitPreflightError("git_unavailable", "Git could not be started.");
    }
    throw new GitPreflightError("not_a_repository", "Git status could not be read.");
  }
}

export async function readGitStatus(repository: string): Promise<string[]> {
  try {
    const status = await runExecutable(
      "git",
      ["-c", "core.fsmonitor=false", "--no-optional-locks", "status", "--porcelain=v1", "--untracked-files=all"],
      { cwd: repository, timeoutMs: 10_000 },
    );
    if (status.exitCode !== 0) {
      throw new GitPreflightError("not_a_repository", "Git status could not be read.");
    }
    return status.stdout.split(/\r?\n/).filter(Boolean);
  } catch (error) {
    if (error instanceof GitPreflightError) throw error;
    if (error instanceof ProcessFailure && error.kind === "spawn_error") {
      throw new GitPreflightError("git_unavailable", "Git could not be started.");
    }
    throw new GitPreflightError("not_a_repository", "Git status could not be read.");
  }
}

function samePath(left: string, right: string): boolean {
  const normalize = (value: string): string => {
    const resolved = resolve(value).replace(/[\\/]+$/, "");
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}
