import { lstat, readFile, realpath } from "node:fs/promises";
import { resolve, sep } from "node:path";
import { ProcessFailure, runExecutable } from "../shared/process";
import { isBalancedExcludedPath } from "./pathPolicy";
import { readGitStatus } from "./gitPreflight";

export interface GitChanges {
  entries: string[];
  paths: string[];
  diff: string;
}

export class GitChangeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GitChangeError";
  }
}

const MAX_FILES = 40;
const MAX_DIFF_BYTES = 262_144;
const MAX_NEW_FILE_BYTES = 16_384;

export async function readGitChanges(repository: string): Promise<GitChanges> {
  const entries = await readGitStatus(repository);
  if (entries.length === 0) return { entries, paths: [], diff: "" };

  const hasHead = (await git(repository, ["rev-parse", "--verify", "HEAD"], 1024)).exitCode === 0;
  const tracked = hasHead
    ? splitNames((await git(repository, ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--name-only", "-z", "HEAD"], MAX_DIFF_BYTES)).stdout)
    : splitNames((await git(repository, ["ls-files", "--cached", "-z"], MAX_DIFF_BYTES)).stdout);
  const untracked = splitNames((await git(repository, ["ls-files", "--others", "--exclude-standard", "-z"], MAX_DIFF_BYTES)).stdout);
  const paths = [...new Set([...tracked, ...untracked])].sort();
  if (paths.length === 0 && entries.length > 0) {
    throw new GitChangeError("Git reported changes but no reviewable file paths were found.");
  }
  if (paths.length > MAX_FILES) throw new GitChangeError(`More than ${MAX_FILES} files changed. Narrow the task before review.`);
  for (const path of paths) validateReviewPath(path);

  const newFiles = new Set(hasHead ? untracked : paths);
  const parts: string[] = [];
  let bytes = 0;
  for (const path of paths) {
    let patch: string;
    if (newFiles.has(path)) {
      const absolute = resolve(repository, path);
      const info = await lstat(absolute);
      if (!info.isFile() || info.size > MAX_NEW_FILE_BYTES) {
        throw new GitChangeError(`New file ${path} is not a reviewable text file under ${MAX_NEW_FILE_BYTES} bytes.`);
      }
      const canonical = await realpath(absolute);
      if (!canonical.startsWith(`${repository}${sep}`)) {
        throw new GitChangeError(`New file ${path} resolves outside the repository.`);
      }
      const content = await readFile(absolute);
      let text: string;
      try {
        text = new TextDecoder("utf-8", { fatal: true }).decode(content);
      } catch {
        throw new GitChangeError(`New file ${path} is not UTF-8 text.`);
      }
      if (content.includes(0)) {
        throw new GitChangeError(`New file ${path} is not UTF-8 text.`);
      }
      const lines = text.length === 0 ? [] : text.replace(/\n$/, "").split("\n");
      patch = [`diff --git a/${path} b/${path}`, `--- /dev/null`, `+++ b/${path}`, `@@ -0,0 +1,${lines.length} @@`, ...lines.map((line) => `+${line}`)].join("\n") + "\n";
    } else {
      const result = await git(repository, ["diff", "--no-ext-diff", "--no-textconv", "--no-renames", "--no-color", "HEAD", "--", path], MAX_DIFF_BYTES + 1);
      if (result.exitCode !== 0 || !result.stdout) throw new GitChangeError(`Could not produce a diff for ${path}.`);
      if (/^Binary files .* differ$/m.test(result.stdout) || /^GIT binary patch$/m.test(result.stdout)) {
        throw new GitChangeError(`Binary file ${path} cannot be reviewed in this workflow.`);
      }
      patch = result.stdout;
    }
    bytes += Buffer.byteLength(patch, "utf8");
    if (bytes > MAX_DIFF_BYTES) throw new GitChangeError(`Diff exceeds ${MAX_DIFF_BYTES} bytes. Narrow the task before review.`);
    parts.push(patch);
  }
  return { entries, paths, diff: parts.join("\n") };
}

/** Derived from the shared path policy table; the rules and their semantics are unchanged. */
export function validateReviewPath(path: string): void {
  if (isBalancedExcludedPath(path)) {
    throw new GitChangeError(`Changed path ${JSON.stringify(path)} is excluded from AI review.`);
  }
}

function splitNames(value: string): string[] {
  return value.split("\0").filter(Boolean);
}

async function git(repository: string, args: string[], maxOutputBytes: number): Promise<{ exitCode: number | null; stdout: string }> {
  try {
    const result = await runExecutable("git", ["-c", "core.fsmonitor=false", "--no-optional-locks", ...args], {
      cwd: repository,
      timeoutMs: 10_000,
      maxOutputBytes,
    });
    return { exitCode: result.exitCode, stdout: result.stdout };
  } catch (error) {
    if (error instanceof ProcessFailure && error.kind === "output_limit") {
      throw new GitChangeError("Git change list or diff exceeds the configured review limit.");
    }
    throw new GitChangeError("Git could not inspect repository changes.");
  }
}
