import { mkdtemp, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { fileToolWithinWorkspace } from "../src/chat/providerUtils";
import { claudeToolPolicy } from "../src/chat/claudeToolPolicy";

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
      expect(await fileToolWithinWorkspace(root, "Write", { file_path: "~/.ssh/authorized_keys" })).toBe(false);
      expect(await fileToolWithinWorkspace(root, "Read", { file_path: "~/private.txt" })).toBe(false);
    } finally { await rm(base, { recursive: true, force: true }); }
  });

  it("denies Claude file tools outside the workspace before any approval decision", async () => {
    const base = await mkdtemp(join(tmpdir(), "countersign-tool-hook-"));
    const root = join(base, "workspace");
    const outside = join(base, "outside");
    try {
      await mkdir(root);
      await mkdir(outside);
      await writeFile(join(outside, "private.txt"), "outside");
      await symlink(outside, join(root, "link"));
      const hook = (tool_name: string, tool_input: Record<string, unknown>, ask = true) =>
        claudeToolPolicy(root, { hook_event_name: "PreToolUse", tool_name, tool_input }, ask);
      expect((await hook("Write", { file_path: join(outside, "new.txt") })).hookSpecificOutput?.permissionDecision).toBe("deny");
      expect((await hook("Write", { file_path: "~/.ssh/authorized_keys" })).hookSpecificOutput?.permissionDecision).toBe("deny");
      expect((await hook("Read", { file_path: join(root, "link", "private.txt") }, false)).hookSpecificOutput?.permissionDecision).toBe("deny");
      expect((await hook("Write", { file_path: join(root, "inside.txt") })).hookSpecificOutput?.permissionDecision).toBe("ask");
      expect((await hook("Bash", { command: "pwd" })).hookSpecificOutput?.permissionDecision).toBe("ask");
    } finally { await rm(base, { recursive: true, force: true }); }
  });
});
