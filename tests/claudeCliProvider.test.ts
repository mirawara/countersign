import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { validateConfiguration } from "../src/configuration/config";
import { ClaudeCliProvider } from "../src/providers/claudeCliProvider";
import { ProcessOptions, ProcessResult } from "../src/shared/process";
import { AgentRequest } from "../src/shared/types";
import { createCleanGitRepository, removeRepository } from "./helpers/git";

const repositories: string[] = [];
const temporaryDirs: string[] = [];
afterEach(async () => {
  await Promise.all(repositories.splice(0).map(removeRepository));
  await Promise.all(temporaryDirs.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
const HELP = "--print --output-format --json-schema --setting-sources --strict-mcp-config --plugin-dir --disable-slash-commands --tools --allowedTools --permission-mode --no-session-persistence";
const config = validateConfiguration({ provider: "claude", codexProvider: "real", executionPermission: "fullAccess" });
const gateRecord = { version: "2.1.109 (Claude Code)", passedAt: "2026-10-19T00:00:00.000Z",
  passed: true as const, policyRevision: 4 };

describe("ClaudeCliProvider", () => {
  it("blocks a changed CLI version before a model request", async () => {
    const calls: string[][] = [];
    const provider = new ClaudeCliProvider({
      config, gateRecord,
      runner: async (_executable, args) => {
        calls.push(args);
        return result(0, "2.1.110 (Claude Code)\n");
      },
    });
    expect((await provider.checkAvailability()).available).toBe(false);
    await expect(provider.execute(request("/tmp/repository"))).rejects.toMatchObject({ kind: "gate_missing" });
    expect(calls).toEqual([["--version"], ["--version"]]);
  });

  it("uses the confirmed tool list, stdin, isolation flags, and actual Git changes", async () => {
    const repository = await createCleanGitRepository();
    repositories.push(repository);
    let invocation: { args: string[]; options: ProcessOptions } | undefined;
    const provider = new ClaudeCliProvider({
      config, gateRecord,
      runner: async (_executable, args, options) => {
        if (args[0] === "--version") return result(0, `${gateRecord.version}\n`);
        if (args[0] === "--help") return result(0, HELP);
        invocation = { args, options };
        await writeFile(`${repository}/feature.ts`, "export const feature = true;\n");
        return result(0, JSON.stringify({
          is_error: false,
          structured_output: { summary: "Implemented feature.", question: "", confirmed: [], fixed: [], remaining: [] },
          total_cost_usd: 0.01,
          usage: { input_tokens: 10, output_tokens: 20 },
        }));
      },
    });
    expect((await provider.checkAvailability()).available).toBe(true);
    const outcome = await provider.execute(request(repository));
    expect(outcome.changedPaths).toEqual(["feature.ts"]);
    expect(outcome.metrics).toEqual({ estimatedCostUsd: 0.01, inputTokens: 10, outputTokens: 20 });
    expect(invocation?.options.stdin).toContain("Implement a feature");
    const args = invocation?.args ?? [];
    expect(args.slice(args.indexOf("--setting-sources"), args.indexOf("--setting-sources") + 2)).toEqual(["--setting-sources", ""]);
    expect(args[args.indexOf("--tools") + 1]).toBe("default");
    expect(args).not.toContain("--allowedTools");
    expect(args).toContain("--dangerously-skip-permissions");
    expect(args).toContain("--disable-slash-commands");
  });

  it("passes the selected model and effort to the Claude implementation", async () => {
    const selected = validateConfiguration({ provider: "claude", codexProvider: "real", executionPermission: "fullAccess",
      claudeModel: "sonnet", claudeEffort: "high" });
    let args: string[] = [];
    const provider = new ClaudeCliProvider({ config: selected, gateRecord, runner: async (_executable, invocation) => {
      if (invocation[0] === "--version") return result(0, `${gateRecord.version}\n`);
      args = invocation;
      return result(0, JSON.stringify({ is_error: false,
        structured_output: { summary: "Done.", question: "", confirmed: [], fixed: [], remaining: [] } }));
    } });
    const repository = await createCleanGitRepository();
    repositories.push(repository);
    await provider.execute(request(repository));
    expect(args.slice(args.indexOf("--model"), args.indexOf("--model") + 2)).toEqual(["--model", "sonnet"]);
    expect(args.slice(args.indexOf("--effort"), args.indexOf("--effort") + 2)).toEqual(["--effort", "high"]);
  });

  it("explains when managed Claude settings refuse Full access", async () => {
    const repository = await createCleanGitRepository();
    repositories.push(repository);
    const provider = new ClaudeCliProvider({ config, gateRecord, runner: async (_executable, args) =>
      args[0] === "--version" ? result(0, `${gateRecord.version}\n`) : {
        exitCode: 1, stdout: "", stderr: "bypassPermissions mode is disabled by managed policy",
      } });
    await expect(provider.execute(request(repository))).rejects.toMatchObject({
      kind: "permissions", message: expect.stringContaining("Select Ask before change"),
    });
  });

  it("routes Ask before change through SDK permission prompts after plan approval", async () => {
    const repository = await createCleanGitRepository();
    repositories.push(repository);
    let sdkCalled = false;
    const provider = new ClaudeCliProvider({
      config: validateConfiguration({ provider: "claude", codexProvider: "real", executionPermission: "askBeforeChange" }),
      gateRecord,
      runner: async (_executable, args) => {
        if (args[0] === "--version") return result(0, `${gateRecord.version}\n`);
        throw new Error("CLI execution should not start in Ask before change.");
      },
      askPermission: async () => true,
      sdkExecution: async (_config, _request, prompt, _schema, ask) => {
        sdkCalled = true;
        expect(prompt).toContain("Ask for approval before changes");
        expect(await ask("Write", "feature.ts", new AbortController().signal)).toBe(true);
        await writeFile(`${repository}/feature.ts`, "export const feature = true;\n");
        return JSON.stringify({ is_error: false, structured_output: {
          summary: "Created feature.ts.", question: "", confirmed: [], fixed: [], remaining: [],
        } });
      },
    });
    const outcome = await provider.execute(request(repository));
    expect(sdkCalled).toBe(true);
    expect(outcome.changedPaths).toEqual(["feature.ts"]);
  });

  it("plans with read-only tools and carries user answers into the next proposal", async () => {
    const repository = await createCleanGitRepository();
    repositories.push(repository);
    let invocation: { args: string[]; options: ProcessOptions } | undefined;
    const provider = new ClaudeCliProvider({ config, gateRecord, runner: async (_executable, args, options) => {
      if (args[0] === "--version") return result(0, `${gateRecord.version}\n`);
      invocation = { args, options };
      return result(0, JSON.stringify({ is_error: false,
        structured_output: { plan: "1. Edit feature.ts. 2. Run tests.", questions: [] } }));
    } });
    const proposal = await provider.proposePlan(repository, "Add a feature",
      [{ question: "Which API?", answer: "The local API" }], new AbortController().signal);
    expect(proposal.plan).toContain("Edit feature.ts");
    const args = invocation?.args ?? [];
    expect(args.slice(args.indexOf("--tools"), args.indexOf("--tools") + 2))
      .toEqual(["--tools", "Read,Glob,Grep"]);
    expect(args.slice(args.indexOf("--permission-mode"), args.indexOf("--permission-mode") + 2))
      .toEqual(["--permission-mode", "dontAsk"]);
    expect(args).not.toContain("Edit");
    expect(invocation?.options.stdin).toContain("Q: Which API?\nA: The local API");
  });

  it("reads updated Caveman style from the installed skill while keeping CLI skills disabled", async () => {
    const repository = await createCleanGitRepository();
    repositories.push(repository);
    const configDir = await mkdtemp(join(tmpdir(), "countersign-claude-profile-"));
    temporaryDirs.push(configDir);
    const skillDir = join(configDir, "skills", "caveman");
    await mkdir(skillDir, { recursive: true });
    const source = join(skillDir, "SKILL.md");
    await writeFile(source, "Drop: filler one\n| **ultra** | short one |\nDrop caveman for: warnings\n");
    let invocation: { args: string[]; options: ProcessOptions } | undefined;
    const provider = new ClaudeCliProvider({ config, gateRecord, accountDir: configDir,
      runner: async (_executable, args, options) => {
        if (args[0] === "--version") return result(0, `${gateRecord.version}\n`);
        invocation = { args, options };
        return result(0, JSON.stringify({ is_error: false,
          structured_output: { plan: "1. Edit feature.ts. 2. Run tests.", questions: [] } }));
      },
    });
    await provider.proposePlan(repository, "Add a feature", [], new AbortController().signal);
    expect(invocation?.args).toContain("--disable-slash-commands");
    expect(invocation?.args).not.toContain("--plugin-dir");
    expect(invocation?.options.stdin).toContain("short one");
    await writeFile(source, "Drop: filler two\n| **ultra** | short two |\nDrop caveman for: warnings\n");
    await provider.proposePlan(repository, "Add a feature", [], new AbortController().signal);
    expect(invocation?.options.stdin).toContain("short two");
    expect(invocation?.options.stdin).not.toContain("short one");
  });
});

function request(repository: string): AgentRequest {
  return { taskId: "test", mode: "implement", repository, task: "Implement a feature", signal: new AbortController().signal };
}
function result(exitCode: number, stdout: string): ProcessResult {
  return { exitCode, stdout, stderr: "" };
}
