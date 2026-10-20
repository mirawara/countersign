import { writeFile } from "node:fs/promises";
import { afterEach, describe, expect, it } from "vitest";
import { validateConfiguration } from "../src/configuration/config";
import { ClaudeCliProvider } from "../src/providers/claudeCliProvider";
import { ProcessOptions, ProcessResult } from "../src/shared/process";
import { AgentRequest } from "../src/shared/types";
import { createCleanGitRepository, removeRepository } from "./helpers/git";

const repositories: string[] = [];
afterEach(async () => Promise.all(repositories.splice(0).map(removeRepository)));
const HELP = "--print --output-format --json-schema --max-budget-usd --setting-sources --strict-mcp-config --disable-slash-commands --tools --allowedTools --permission-mode --no-session-persistence";
const config = validateConfiguration({ provider: "claude", codexProvider: "real" });
const gateRecord = { version: "2.1.109 (Claude Code)", passedAt: "2026-10-19T00:00:00.000Z", passed: true as const };

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
          structured_output: { summary: "Implemented feature.", confirmed: [], fixed: [], remaining: [] },
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
    expect(args[args.indexOf("--tools") + 1]).toBe(config.claudeAllowedTools.join(","));
    expect(args[args.indexOf("--allowedTools") + 1]).toBe(config.claudeAllowedTools.join(","));
    expect(args).not.toContain("Bash");
    expect(args).not.toContain("--dangerously-skip-permissions");
  });
});

function request(repository: string): AgentRequest {
  return { taskId: "test", mode: "implement", repository, task: "Implement a feature", signal: new AbortController().signal };
}
function result(exitCode: number, stdout: string): ProcessResult {
  return { exitCode, stdout, stderr: "" };
}
