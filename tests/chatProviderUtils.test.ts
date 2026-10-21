import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fileToolWithinWorkspace } from "../src/chat/providerUtils";

describe("Claude chat file permission boundary", () => {
  it("allows workspace paths and denies traversal and symlink escapes", async () => {
    const base = await mkdtemp(join(tmpdir(), "countersign-tool-path-"));
    const root = join(base, "workspace");
    const outside = join(base, "outside");
    try {
      await mkdir(root);
      await mkdir(outside);
      await writeFile(join(root, "inside.txt"), "safe");
      await writeFile(join(outside, "private.txt"), "outside");
      await symlink(outside, join(root, "link"));
      await symlink(join(outside, "private.txt"), join(root, "linked-file.txt"));
      expect(await fileToolWithinWorkspace(root, "Read", { file_path: join(root, "inside.txt") })).toBe(true);
      expect(await fileToolWithinWorkspace(root, "Write", { file_path: join(root, "new.txt") })).toBe(true);
      expect(await fileToolWithinWorkspace(root, "Read", { file_path: join(root, "link", "private.txt") })).toBe(false);
      expect(await fileToolWithinWorkspace(root, "Write", { file_path: join(root, "link", "new.txt") })).toBe(false);
      expect(await fileToolWithinWorkspace(root, "Write", { file_path: join(root, "linked-file.txt") })).toBe(false);
      expect(await fileToolWithinWorkspace(root, "Glob", { pattern: "../outside/*" })).toBe(false);
    } finally { await rm(base, { recursive: true, force: true }); }
  });
});
