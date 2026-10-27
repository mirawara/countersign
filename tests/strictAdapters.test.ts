import { readFile, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { validateConfiguration } from "../src/configuration/config";
import { StrictProviderError } from "../src/orchestrator/strictProviders";
import { StrictClaudeProvider } from "../src/providers/strictClaudeProvider";
import { StrictCodexProvider } from "../src/providers/strictCodexProvider";
import { ProcessOptions, ProcessResult } from "../src/shared/process";
import { STRICT_PLAN_SCHEMA_VERSION, STRICT_RESPONSE_SCHEMA_VERSION, StrictPlan } from "../src/shared/strict";

const CLAUDE_HELP = [
  "--print", "--output-format", "--json-schema", "--setting-sources",
  "--strict-mcp-config", "--disable-slash-commands", "--tools", "--allowedTools",
  "--permission-mode", "--no-session-persistence", "--dangerously-skip-permissions",
].join(" ");

const CODEX_HELP = [
  "--sandbox <SANDBOX> [possible values: read-only, workspace-write, danger-full-access]",
  "--ignore-user-config --ignore-rules --ephemeral --skip-git-repo-check",
  "--output-schema --output-last-message --json",
].join("\n  ");

const PLAN: StrictPlan = {
  schemaVersion: STRICT_PLAN_SCHEMA_VERSION,
  objective: "Add the parser",
  constraints: [],
  acceptanceCriteria: ["Tests pass"],
  expectedFiles: ["src/a.ts"],
  expectedFilesComplete: true,
  risks: [],
  checks: [],
  questions: [],
};

interface Call {
  executable: string;
  args: string[];
  options: ProcessOptions;
  schema?: unknown;
}

function expectCodexStrictSchema(value: unknown): void {
  if (Array.isArray(value)) {
    value.forEach(expectCodexStrictSchema);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  const schema = value as Record<string, unknown>;
  expect(schema).not.toHaveProperty("minLength");
  expect(schema).not.toHaveProperty("maxLength");
  if (schema.type === "object") {
    const properties = schema.properties as Record<string, unknown>;
    expect(schema.additionalProperties).toBe(false);
    expect(schema.required).toEqual(expect.arrayContaining(Object.keys(properties)));
    expect((schema.required as string[]).length).toBe(Object.keys(properties).length);
  }
  Object.values(schema).forEach(expectCodexStrictSchema);
}

function claudeProvider(options: {
  structured?: unknown;
  help?: string;
  version?: string;
  gateVersion?: string;
  exitCode?: number;
  stderr?: string;
} = {}): { provider: StrictClaudeProvider; calls: Call[] } {
  const calls: Call[] = [];
  const version = options.version ?? "2.1.109";
  const runner = async (executable: string, args: string[], processOptions: ProcessOptions): Promise<ProcessResult> => {
    calls.push({ executable, args, options: processOptions });
    if (args[0] === "--version") return { exitCode: 0, stdout: version, stderr: "" };
    if (args[0] === "--help") return { exitCode: 0, stdout: options.help ?? CLAUDE_HELP, stderr: "" };
    return {
      exitCode: options.exitCode ?? 0,
      stderr: options.stderr ?? "",
      stdout: JSON.stringify({
        is_error: false,
        structured_output: options.structured ?? PLAN,
        total_cost_usd: 0.12,
        usage: { input_tokens: 100, output_tokens: 50 },
        session_id: "claude-session-1",
      }),
    };
  };
  const provider = new StrictClaudeProvider({
    config: validateConfiguration({ provider: "claude", codexProvider: "real" }),
    gateRecord: { version: options.gateVersion ?? version, passedAt: new Date().toISOString(), passed: true, policyRevision: 4 },
    runner,
  });
  return { provider, calls };
}

function codexProvider(options: { help?: string; structured?: unknown; exitCode?: number; stderr?: string } = {}): { provider: StrictCodexProvider; calls: Call[] } {
  const calls: Call[] = [];
  const runner = async (executable: string, args: string[], processOptions: ProcessOptions): Promise<ProcessResult> => {
    if (args[0] === "--version") return { exitCode: 0, stdout: "codex-cli 0.163.0", stderr: "" };
    if (args[0] === "exec" && args[1] === "--help") return { exitCode: 0, stdout: options.help ?? CODEX_HELP, stderr: "" };
    const schemaPath = args[args.indexOf("--output-schema") + 1];
    const schema = schemaPath ? JSON.parse(await readFile(schemaPath, "utf8")) as unknown : undefined;
    calls.push({ executable, args, options: processOptions, schema });
    const messagePath = args[args.indexOf("--output-last-message") + 1];
    if (messagePath) await writeFile(messagePath, JSON.stringify(options.structured ?? { ok: true }), "utf8");
    return {
      exitCode: options.exitCode ?? 0,
      stderr: options.stderr ?? "",
      stdout: `{"type":"completed","usage":{"input_tokens":20,"output_tokens":10}}`,
    };
  };
  const provider = new StrictCodexProvider({ executable: "codex", gracePeriodMs: 1_000, runner });
  return { provider, calls };
}

const planRequest = {
  kind: "evaluate" as const,
  taskId: "t1",
  repository: "/repo",
  workingDirectory: "/repo",
  task: "Add the parser",
  plan: PLAN,
  planHash: "a".repeat(64),
  canonicalPlan: JSON.stringify(PLAN),
  priorObjections: [],
  authorizedChecks: [],
  signal: new AbortController().signal,
  timeoutMs: 60_000,
  maxResponseBytes: 131_072,
};

describe("Strict Claude adapter", () => {
  it("runs planning with a read-only tool set and a new context, never a resumed one", async () => {
    const { provider, calls } = claudeProvider();
    await provider.request({ ...planRequest });
    const turn = calls.at(-1);
    expect(turn?.args).toEqual(expect.arrayContaining([
      "--print", "--output-format", "json", "--json-schema", "--setting-sources", "--strict-mcp-config",
      "--no-session-persistence", "--permission-mode", "dontAsk",
      "--tools", "Read,Glob,Grep", "--allowedTools", "Read,Glob,Grep",
    ]));
    expect(turn?.args).not.toContain("--resume");
    expect(turn?.args).not.toContain("--session-id");
    expect(turn?.args).not.toContain("--dangerously-skip-permissions");
    expect(turn?.options.timeoutMs).toBe(60_000);
  });

  it("repairs a rejected decision without reading the repository again", async () => {
    const { provider, calls } = claudeProvider();
    const previousRaw = JSON.stringify({ provider: "claude", decision: "reject", objections: [{
      target: "expected_file", reference: "src/missing.ts",
    }] });
    await provider.request({ ...planRequest, previousRaw, retryErrors: [{
      path: "$.objections[0].reference", code: "invalid_reference", message: "The file is not listed.",
    }] });
    const turn = calls.at(-1);
    expect(turn?.args.slice(turn.args.indexOf("--tools"), turn.args.indexOf("--tools") + 2)).toEqual(["--tools", ""]);
    expect(turn?.args.slice(turn.args.indexOf("--allowedTools"), turn.args.indexOf("--allowedTools") + 2)).toEqual(["--allowedTools", ""]);
    expect(turn?.options.stdin).toContain(previousRaw);
    expect(turn?.options.stdin).toContain("zero-based index");
    expect(turn?.options.stdin).toContain("$.objections[0].reference");
  });

  it("reports its capabilities from the installed CLI, not from a prompt", async () => {
    const ready = claudeProvider();
    expect(await ready.provider.checkPlanningCapability()).toMatchObject({
      available: true, readOnlyToolsEnforced: true, freshContext: true, providerVersion: "2.1.109",
    });
    expect(await ready.provider.checkSessionCapability("implementation")).toMatchObject({ readOnlySandbox: false });
    expect(await ready.provider.checkSessionCapability("final_approval")).toMatchObject({ readOnlySandbox: true });

    const noFreshContext = claudeProvider({ help: CLAUDE_HELP.replace("--no-session-persistence", "") });
    expect(await noFreshContext.provider.checkSessionCapability("review")).toMatchObject({ available: false, freshContext: false });

    const staleGate = claudeProvider({ gateVersion: "2.1.108" });
    expect(await staleGate.provider.checkPlanningCapability()).toMatchObject({ available: false, freshContext: false });
    expect((await staleGate.provider.checkPlanningCapability()).reason).toContain("isolation gate");
  });

  it("returns the structured payload and the usage, and maps a quota failure", async () => {
    const { provider } = claudeProvider();
    const reply = await provider.request({ ...planRequest });
    expect(JSON.parse(reply.raw)).toMatchObject({ objective: "Add the parser" });
    expect(reply.metrics).toMatchObject({ inputTokens: 100, outputTokens: 50, estimatedCostUsd: 0.12 });
    expect(reply.sessionId).toBe("claude-session-1");

    const limited = claudeProvider({ exitCode: 1, stderr: "Usage limit reached for this account." });
    await expect(limited.provider.request({ ...planRequest })).rejects.toMatchObject({ kind: "quota" });
  });

  it("accepts a structured output delivered as a JSON string", async () => {
    // Some CLI versions put the payload in a string; re-encoding it would hand the
    // validator a quoted document instead of an object.
    const { provider } = claudeProvider({ structured: JSON.stringify(PLAN) });
    const reply = await provider.request({ ...planRequest });
    expect(JSON.parse(reply.raw)).toMatchObject({ objective: "Add the parser" });
  });

  it("reports no usage rather than an empty measurement", async () => {
    const calls: Call[] = [];
    const runner = async (executable: string, args: string[], options: ProcessOptions): Promise<ProcessResult> => {
      calls.push({ executable, args, options });
      if (args[0] === "--version") return { exitCode: 0, stdout: "2.1.109", stderr: "" };
      if (args[0] === "--help") return { exitCode: 0, stdout: CLAUDE_HELP, stderr: "" };
      return { exitCode: 0, stderr: "", stdout: JSON.stringify({ is_error: false, structured_output: PLAN }) };
    };
    const provider = new StrictClaudeProvider({
      config: validateConfiguration({ provider: "claude", codexProvider: "real" }),
      gateRecord: { version: "2.1.109", passedAt: new Date().toISOString(), passed: true, policyRevision: 4 },
      runner,
    });
    const reply = await provider.request({ ...planRequest });
    expect(reply.metrics).toBeUndefined();
  });

  it("forwards the task's cancellation to its capability probes", async () => {
    const controller = new AbortController();
    const seen: (AbortSignal | undefined)[] = [];
    const runner = async (_executable: string, args: string[], options: ProcessOptions): Promise<ProcessResult> => {
      seen.push(options.signal);
      if (args[0] === "--version") return { exitCode: 0, stdout: "2.1.109", stderr: "" };
      return { exitCode: 0, stdout: CLAUDE_HELP, stderr: "" };
    };
    const provider = new StrictClaudeProvider({
      config: validateConfiguration({ provider: "claude", codexProvider: "real" }),
      gateRecord: { version: "2.1.109", passedAt: new Date().toISOString(), passed: true, policyRevision: 4 },
      runner,
    });
    await provider.checkPlanningCapability(controller.signal);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.every((signal) => signal === controller.signal)).toBe(true);
  });

  it("refuses Ask before change without a permission prompt", async () => {
    const { provider } = claudeProvider();
    await expect(provider.implement({
      kind: "implement", taskId: "t1", repository: "/repo", workingDirectory: "/repo", task: "Add the parser", plan: PLAN,
      planHash: "a".repeat(64), acceptanceCriteria: ["Tests pass"], answeredQuestions: [], authorizedChecks: [],
      baseline: { root: "/repo", source: "filesystem_scan", capturedAt: "now", digest: "c".repeat(64), entryCount: 1 },
      preExistingEntries: [], executionPermission: "askBeforeChange",
      signal: new AbortController().signal, timeoutMs: 60_000, maxResponseBytes: 131_072,
    })).rejects.toBeInstanceOf(StrictProviderError);
  });
});

describe("provider working directory", () => {
  it("spawns in the pinned root, not at the path that may have been replaced", async () => {
    const { provider, calls } = claudeProvider();
    await provider.request({
      kind: "propose", taskId: "t1", repository: "/repo", workingDirectory: "/proc/self/fd/9/.",
      task: "Add the parser", authorizedChecks: [], answeredQuestions: [],
      signal: new AbortController().signal, timeoutMs: 60_000, maxResponseBytes: 131_072,
    });
    const turn = calls.at(-1);
    // The human-readable repository stays in the prompt; the process runs in the pinned root.
    expect(turn?.options.cwd).toBe("/proc/self/fd/9/.");
    expect(turn?.options.stdin).toContain("Repository: /repo");

    const codex = codexProvider({
      structured: {
        schemaVersion: STRICT_RESPONSE_SCHEMA_VERSION, provider: "codex", planHash: "a".repeat(64),
        decision: "approve", objections: [], summary: "Fine.",
      },
    });
    await codex.provider.request({ ...planRequest, repository: "/repo", workingDirectory: "/proc/self/fd/9/." });
    expect(codex.calls.at(-1)?.options.cwd).toBe("/proc/self/fd/9/.");
  });
});

describe("Strict Codex adapter", () => {
  it("reviews in a read-only sandbox with a fresh thread and a schema file", async () => {
    const { provider, calls } = codexProvider({
      structured: {
        schemaVersion: STRICT_RESPONSE_SCHEMA_VERSION, provider: "codex", snapshotDigest: "b".repeat(64),
        decision: "approve", findings: [], summary: "The diff matches the plan.",
      },
    });
    const reply = await provider.review({
      taskId: "t1", repository: "/repo", workingDirectory: "/repo", task: "Add the parser", plan: PLAN, planHash: "a".repeat(64),
      snapshotDigest: "b".repeat(64), diff: "diff --git a/src/a.ts b/src/a.ts", preExistingEntries: [],
      checkResults: [{ id: "lint", passed: true }], implementationSummary: "Changed the parser.",
      signal: new AbortController().signal, timeoutMs: 60_000, maxResponseBytes: 131_072,
    });
    const exec = calls.at(-1);
    expect(exec?.args).toEqual(expect.arrayContaining(["exec", "--sandbox", "read-only", "--ignore-user-config", "--ephemeral", "--output-schema", "--json"]));
    expect(exec?.args).not.toContain("resume");
    expect(JSON.parse(reply.raw)).toMatchObject({ decision: "approve", snapshotDigest: "b".repeat(64) });
    expect(reply.metrics).toMatchObject({ inputTokens: 20, outputTokens: 10 });
    expectCodexStrictSchema(exec?.schema);
  });

  it("reports no read-only sandbox when the installed CLI does not offer one", async () => {
    const { provider } = codexProvider({ help: CODEX_HELP.replace("read-only, ", "") });
    const capability = await provider.checkSessionCapability("review");
    expect(capability).toMatchObject({ available: false, readOnlySandbox: false });
    expect(capability.reason).toContain("read-only sandbox");
  });

  it("evaluates plans but never drafts them", async () => {
    const { provider, calls } = codexProvider({
      structured: {
        schemaVersion: STRICT_RESPONSE_SCHEMA_VERSION, provider: "codex", planHash: "a".repeat(64),
        decision: "approve", objections: [], summary: "The plan is implementable.",
      },
    });
    const reply = await provider.request({ ...planRequest });
    expect(JSON.parse(reply.raw)).toMatchObject({ decision: "approve" });
    expectCodexStrictSchema(calls.at(-1)?.schema);
    expect((calls.at(-1)?.schema as { properties: { revisedPlan: unknown } }).properties.revisedPlan).toBeDefined();
    await provider.request({ ...planRequest, previousRaw: reply.raw, retryErrors: [{
      path: "$.objections[0].reference", code: "invalid_reference", message: "The file is not listed.",
    }] });
    expect(calls.at(-1)?.options.stdin).toContain(reply.raw);
    expect(calls.at(-1)?.options.stdin).toContain("zero-based index");
    await expect(provider.request({
      kind: "propose", taskId: "t1", repository: "/repo", workingDirectory: "/repo", task: "x", authorizedChecks: [], answeredQuestions: [],
      signal: new AbortController().signal, timeoutMs: 1_000, maxResponseBytes: 1_000,
    })).rejects.toMatchObject({ kind: "capability_missing" });
  });

  it("identifies a schema rejection as Countersign's protocol error", async () => {
    const { provider } = codexProvider({ exitCode: 1, stderr: "invalid_json_schema: required is missing reference" });
    await expect(provider.request({ ...planRequest })).rejects.toMatchObject({
      kind: "protocol", message: "Codex rejected Countersign's structured output schema.",
    });
  });
});
