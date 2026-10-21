import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { GitPreflightError, preflightGit, readGitStatus } from "../src/context/gitPreflight";
import { createCleanGitRepository, removeRepository } from "./helpers/git";

const repositories: string[] = [];

afterEach(async () => {
  await Promise.all(repositories.splice(0).map(removeRepository));
});

describe("Git preflight", () => {
  it("accepts an exact, clean repository root", async () => {
    const repository = await createCleanGitRepository();
    repositories.push(repository);
    await expect(preflightGit(repository)).resolves.toEqual({ repository, dirtyEntries: [] });
  });

  it("blocks tracked and untracked working tree changes", async () => {
    const repository = await createCleanGitRepository();
    repositories.push(repository);
    await writeFile(join(repository, "new-file.txt"), "untracked");
    await expect(preflightGit(repository)).rejects.toMatchObject({ kind: "dirty_repository" });
    await expect(preflightGit(repository, { allowDirty: true })).resolves.toEqual({
      repository, dirtyEntries: ["?? new-file.txt"],
    });
    expect(await readGitStatus(repository)).toHaveLength(1);
  });

  it("requires the repository root as the workspace", async () => {
    const repository = await createCleanGitRepository();
    repositories.push(repository);
    const nested = join(repository, "nested");
    await mkdir(nested);
    await expect(preflightGit(nested)).rejects.toMatchObject({ kind: "workspace_mismatch" });
  });

  it("identifies a folder outside Git", async () => {
    const folder = await mkdtemp(join(tmpdir(), "countersign-not-git-"));
    repositories.push(folder);
    try {
      await preflightGit(folder);
      throw new Error("Expected Git preflight to fail.");
    } catch (error) {
      expect(error).toBeInstanceOf(GitPreflightError);
      expect((error as GitPreflightError).kind).toBe("not_a_repository");
    }
  });
});
