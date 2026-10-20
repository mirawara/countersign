import { mkdir, rename, writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { readGitChanges } from "../src/context/gitChanges";
import { runExecutable } from "../src/shared/process";
import { createCleanGitRepository, removeRepository } from "./helpers/git";

const repositories: string[] = [];
afterEach(async () => Promise.all(repositories.splice(0).map(removeRepository)));

describe("Git change collection", () => {
  it("builds a real patch for new text files without requiring an existing commit", async () => {
    const repository = await createCleanGitRepository();
    repositories.push(repository);
    await mkdir(`${repository}/src`);
    await writeFile(`${repository}/src/feature.ts`, "export const feature = true;\n");
    const changes = await readGitChanges(repository);
    expect(changes.paths).toEqual(["src/feature.ts"]);
    expect(changes.diff).toContain("+export const feature = true;");
  });

  it("blocks new secret files before building an AI review prompt", async () => {
    const repository = await createCleanGitRepository();
    repositories.push(repository);
    await writeFile(`${repository}/credentials.json`, "{\"token\":\"example\"}\n");
    await expect(readGitChanges(repository)).rejects.toThrow(/excluded from AI review/);
  });

  it("includes staged files in a repository without a commit", async () => {
    const repository = await createCleanGitRepository();
    repositories.push(repository);
    await writeFile(`${repository}/new.ts`, "export const answer = 42;\n");
    await git(repository, "add", "new.ts");

    const changes = await readGitChanges(repository);
    expect(changes.paths).toEqual(["new.ts"]);
    expect(changes.diff).toContain("+export const answer = 42;");
  });

  it("represents both sides of a staged rename", async () => {
    const repository = await createCleanGitRepository();
    repositories.push(repository);
    await writeFile(`${repository}/old.ts`, "export const answer = 42;\n");
    await git(repository, "add", "old.ts");
    await git(repository, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "baseline");
    await rename(`${repository}/old.ts`, `${repository}/new.ts`);
    await git(repository, "add", "-A");

    const changes = await readGitChanges(repository);
    expect(changes.paths).toEqual(["new.ts", "old.ts"]);
    expect(changes.diff).toContain("+++ b/new.ts");
    expect(changes.diff).toContain("--- a/old.ts");
  });
});

async function git(repository: string, ...args: string[]): Promise<void> {
  const result = await runExecutable("git", args, { cwd: repository, timeoutMs: 10_000 });
  if (result.exitCode !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr}`);
}
