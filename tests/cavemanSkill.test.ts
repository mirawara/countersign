import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { cavemanCoversAnswer, claudeCavemanPrompt, claudeCliCavemanPrompt, codexCavemanPrompt, codexCliCavemanPrompt, prepareClaudeCavemanSkill }
  from "../src/shared/cavemanSkill";

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

describe("installed Caveman skill", () => {
  it("uses the current installed skill and leaves its plugin hooks behind", async () => {
    const root = await mkdtemp(join(tmpdir(), "countersign-skill-test-"));
    directories.push(root);
    const installed = join(root, "installed-plugin");
    const skillDir = join(installed, "skills", "caveman");
    await mkdir(skillDir, { recursive: true });
    await mkdir(join(root, "plugins"));
    await writeFile(join(installed, "hook.js"), "hook should not run");
    await writeFile(join(root, "plugins", "installed_plugins.json"), JSON.stringify({
      plugins: { "caveman@caveman": [{ installPath: installed }] },
    }));

    await writeFile(join(skillDir, "SKILL.md"), "---\nname: caveman\n---\nversion one\n");
    const first = await prepareClaudeCavemanSkill(root);
    expect(first).toBeDefined();
    directories.push(first!.path);
    expect(claudeCavemanPrompt("Task", first!.path, "always", [])).toMatch(/^\/countersign-caveman:caveman ultra/);
    expect(await readFile(join(first!.path, "skills", "caveman", "SKILL.md"), "utf8")).toContain("version one");
    expect(JSON.parse(await readFile(join(first!.path, ".claude-plugin", "plugin.json"), "utf8")))
      .toMatchObject({ name: "countersign-caveman" });
    const reused = await prepareClaudeCavemanSkill(root);
    expect(reused?.path).toBe(first?.path);
    await reused?.dispose();

    await writeFile(join(skillDir, "SKILL.md"), "---\nname: caveman\n---\nversion two\n");
    const second = await prepareClaudeCavemanSkill(root);
    expect(second).toBeDefined();
    directories.push(second!.path);
    expect(await readFile(join(second!.path, "skills", "caveman", "SKILL.md"), "utf8")).toContain("version two");
    expect(second!.path).not.toBe(first!.path);
    const references = join(skillDir, "references");
    await mkdir(references);
    await writeFile(join(references, "guide.md"), "reference one\n");
    const withReference = await prepareClaudeCavemanSkill(root);
    expect(withReference?.path).not.toBe(second!.path);
    directories.push(withReference!.path);
    await writeFile(join(references, "guide.md"), "reference two\n");
    const updatedReference = await prepareClaudeCavemanSkill(root);
    expect(updatedReference?.path).not.toBe(withReference!.path);
    expect(await readFile(join(updatedReference!.path, "skills", "caveman", "references", "guide.md"), "utf8"))
      .toContain("reference two");
    directories.push(updatedReference!.path);
    await first?.dispose();
    await second?.dispose();
    await withReference?.dispose();
    await updatedReference?.dispose();
  });

  it("keeps a compact fallback when no skill is installed", async () => {
    const root = await mkdtemp(join(tmpdir(), "countersign-skill-empty-"));
    directories.push(root);
    expect(await prepareClaudeCavemanSkill(root)).toBeUndefined();
    expect(claudeCavemanPrompt("Task", undefined, "always", [])).toContain("Caveman Ultra for your prose");
    expect(await claudeCliCavemanPrompt("Task", root, "always", [])).toContain("Caveman Ultra for your prose");
    expect(codexCavemanPrompt("Task", undefined, "always", [])).toContain("$caveman:caveman");
  });

  it("refreshes Codex CLI style from its installed plugin while user config stays ignored", async () => {
    const root = await mkdtemp(join(tmpdir(), "countersign-codex-skill-"));
    directories.push(root);
    const skillDir = join(root, "plugins", "cache", "caveman-repo", "caveman", "0.1.0", "skills", "caveman");
    await mkdir(skillDir, { recursive: true });
    const source = join(skillDir, "SKILL.md");
    await writeFile(source, "Malformed skill\n");
    expect(await codexCliCavemanPrompt("Review", root, "always", [])).toContain("Use concise prose");
    await writeFile(source, "Drop: filler one\n| **ultra** | short one |\nDrop caveman for: warnings\n");
    expect(await codexCliCavemanPrompt("Review", root, "always", [])).toContain("short one");
    await writeFile(source, "Drop: filler two\n| **ultra** | short two |\nDrop caveman for: warnings\n");
    const updated = await codexCliCavemanPrompt("Review", root, "always", []);
    expect(updated).toContain("short two");
    expect(updated).not.toContain("short one");
  });
  it("stops the terse style before the answer unless the profile already chose it", async () => {
    const installed = await mkdtemp(join(tmpdir(), "countersign-answer-on-"));
    const empty = await mkdtemp(join(tmpdir(), "countersign-answer-off-"));
    directories.push(installed, empty);
    const skillDir = join(installed, "skills", "caveman");
    await mkdir(skillDir, { recursive: true });
    await writeFile(join(skillDir, "SKILL.md"),
      "Drop: filler\n| **ultra** | shorter |\nDrop caveman for: warnings\n");

    expect(cavemanCoversAnswer("auto", true)).toBe(true);
    expect(cavemanCoversAnswer("auto", false)).toBe(false);
    expect(cavemanCoversAnswer("always", false)).toBe(true);
    expect(cavemanCoversAnswer("internalOnly", true)).toBe(false);

    const clause = "in full, ordinary sentences";
    expect(await claudeCliCavemanPrompt("Task", installed, "auto", ["summary"])).not.toContain(clause);
    const plain = await claudeCliCavemanPrompt("Task", empty, "auto", ["summary"]);
    expect(plain).toContain("Caveman Ultra for your prose");
    expect(plain).toContain("Write summary in full, ordinary sentences");
    expect(await claudeCliCavemanPrompt("Task", installed, "internalOnly", ["summary", "question"]))
      .toContain("Write summary and question in full, ordinary sentences");
    expect(claudeCavemanPrompt("Task", undefined, "always", ["summary"])).not.toContain(clause);
  });
});
