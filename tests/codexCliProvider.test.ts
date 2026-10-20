import { access, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { describe, expect, it } from "vitest";
import { CodexCliProvider, CodexProviderError } from "../src/providers/codexCliProvider";
import { ProcessOptions, ProcessResult } from "../src/shared/process";
import { AgentRequest } from "../src/shared/types";

const HELP = `
Usage: codex exec [OPTIONS] [PROMPT]
Arguments:
  [PROMPT]
          Initial instructions. If not provided as an argument (or if \`-\` is used), instructions are read from stdin.
Options:
      --sandbox <SANDBOX_MODE>
          Select the sandbox policy.
          [possible values: read-only, workspace-write, danger-full-access]
      --ignore-user-config
          Do not load user config.
      --ignore-rules
          Do not load user or project execpolicy rules.
      --ephemeral
          Do not persist session files.
      --output-schema <FILE>
          JSON schema for the final response.
      --output-last-message <FILE>
          Write the last message to a file.
      --json
          Print events to stdout as JSONL.
`;

const REVIEW = {
  summary: "Review complete.",
  findings: [{
    severity: "Critical",
    file: "src/example.ts",
    line: 4,
    evidence: "The simulated branch leaves this value unchecked.",
    summary: "Validate the value before use.",
  }],
};

describe("CodexCliProvider", () => {
  it("checks the installed CLI version and required read-only capabilities without a provider request", async () => {
    const calls: string[][] = [];
    const provider = new CodexCliProvider({
      executable: "codex-test",
      timeoutMs: 60_000,
      gracePeriodMs: 1_000,
      runner: async (_executable, args) => {
        calls.push(args);
        return args[0] === "--version"
          ? result(0, "codex-cli 0.163.0\n")
          : result(0, HELP);
      },
    });

    await expect(provider.checkAvailability()).resolves.toEqual({ available: true, version: "codex-cli 0.163.0" });
    expect(calls).toEqual([["--version"], ["exec", "--help"]]);
  });

  it("blocks CLI versions that lack a required capability", async () => {
    const helpWithoutReadOnly = HELP.replace("read-only, workspace-write, danger-full-access", "workspace-write, danger-full-access");
    const provider = new CodexCliProvider({
      executable: "codex-test",
      timeoutMs: 60_000,
      gracePeriodMs: 1_000,
      runner: async (_executable, args) => args[0] === "--version"
        ? result(0, "codex-cli 0.1.0")
        : result(0, helpWithoutReadOnly),
    });

    const status = await provider.checkAvailability();
    expect(status.available).toBe(false);
    expect(status.reason).toContain("--sandbox read-only");
  });

  it("blocks a CLI whose help only declares a different rules flag", async () => {
    const helpWithoutRules = HELP.replace("--ignore-rules", "--ignore-rules-extra");
    const provider = new CodexCliProvider({
      executable: "codex-test",
      timeoutMs: 60_000,
      gracePeriodMs: 1_000,
      runner: async (_executable, args) => args[0] === "--version"
        ? result(0, "codex-cli 0.1.0")
        : result(0, helpWithoutRules),
    });

    const status = await provider.checkAvailability();
    expect(status.available).toBe(false);
    expect(status.reason).toContain("--ignore-rules");
  });

  it("passes the prompt by stdin, enforces read-only flags, and parses JSONL separately from stderr", async () => {
    let executedArgs: string[] = [];
    let executedOptions: ProcessOptions | undefined;
    let schema: unknown;
    let temporaryDirectory = "";
    const provider = new CodexCliProvider({
      executable: "codex-test",
      timeoutMs: 90_000,
      gracePeriodMs: 750,
      runner: async (_executable, args, options) => {
        if (args[0] !== "exec") return result(0, "codex-cli 0.163.0");
        executedArgs = args;
        executedOptions = options;
        const schemaPath = optionValue(args, "--output-schema");
        const messagePath = optionValue(args, "--output-last-message");
        temporaryDirectory = dirname(schemaPath);
        schema = JSON.parse(await readFile(schemaPath, "utf8"));
        await writeFile(messagePath, JSON.stringify(REVIEW), { mode: 0o600 });
        return result(0, 'banner\n{"type":"thread.started","thread_id":"example"}\nwarning\n{"type":"turn.completed"}\n', "non-JSON diagnostic\n");
      },
    });

    const review = await provider.execute(request());

    expect(review).toEqual({ changed: false, findings: REVIEW.findings, message: REVIEW.summary });
    expect(executedOptions?.cwd).toBe("/repo");
    expect(executedOptions?.stdin).toContain("Task:\nReview the simulated change");
    expect(executedOptions?.stdin).toContain("+const simulated = true;");
    expect(executedOptions?.timeoutMs).toBe(90_000);
    expect(executedOptions?.gracePeriodMs).toBe(750);
    expect(executedArgs.slice(0, 3)).toEqual(["exec", "--sandbox", "read-only"]);
    expect(executedArgs).toContain("--ignore-user-config");
    expect(executedArgs).toContain("--ignore-rules");
    expect(executedArgs).toContain("--ephemeral");
    expect(executedArgs).toContain("--json");
    expect(executedArgs.at(-1)).toBe("-");
    expect(executedArgs).not.toContain("--dangerously-bypass-approvals-and-sandbox");
    expect(schema).toMatchObject({ type: "object", additionalProperties: false });
    await expect(access(temporaryDirectory)).rejects.toThrow();
  });

  it("rejects output with no parseable JSONL event", async () => {
    const provider = new CodexCliProvider({
      executable: "codex-test",
      timeoutMs: 60_000,
      gracePeriodMs: 1_000,
      runner: async (_executable, args, _options) => {
        if (args[0] !== "exec") return result(0, "codex-cli 0.163.0");
        await writeFile(optionValue(args, "--output-last-message"), JSON.stringify({ summary: "ok", findings: [] }));
        return { exitCode: 0, stdout: "not-json\n", stderr: "a diagnostic that must not be parsed" };
      },
    });

    await expect(provider.execute(request())).rejects.toMatchObject({ kind: "invalid_output" });
  });

  it("maps account authentication failures to a typed provider error", async () => {
    const provider = new CodexCliProvider({
      executable: "codex-test",
      timeoutMs: 60_000,
      gracePeriodMs: 1_000,
      runner: async (_executable, args) => args[0] === "exec"
        ? { exitCode: 1, stdout: "", stderr: "Authentication required: please log in" }
        : result(0, "codex-cli 0.163.0"),
    });

    await expect(provider.execute(request())).rejects.toMatchObject({
      name: "CodexProviderError",
      kind: "authentication",
    } satisfies Partial<CodexProviderError>);
  });
});

function result(exitCode: number, stdout: string, stderr = ""): ProcessResult {
  return { exitCode, stdout, stderr };
}

function optionValue(args: string[], option: string): string {
  const index = args.indexOf(option);
  if (index < 0 || !args[index + 1]) throw new Error(`Missing ${option} argument.`);
  return args[index + 1];
}

function request(): AgentRequest {
  return {
    taskId: "test-task",
    mode: "review",
    repository: "/repo",
    task: "Review the simulated change",
    simulatedDiff: "+++ b/src/example.ts\n+const simulated = true;",
    signal: new AbortController().signal,
  };
}
