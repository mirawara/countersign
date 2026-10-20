import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runExecutable } from "../../src/shared/process";

export async function createCleanGitRepository(): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), "ai-dev-orchestrator-test-"));
  const result = await runExecutable("git", ["init", "-q"], { cwd: path, timeoutMs: 10_000 });
  if (result.exitCode !== 0) {
    await rm(path, { recursive: true, force: true });
    throw new Error(`git init failed: ${result.stderr || result.stdout}`);
  }
  return path;
}

export async function removeRepository(path: string): Promise<void> {
  await rm(path, { recursive: true, force: true });
}
