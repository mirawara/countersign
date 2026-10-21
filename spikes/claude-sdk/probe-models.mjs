// One opt-in request to compare the SDK model catalog with the actual turn.
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { query } from "@anthropic-ai/claude-agent-sdk";

if (!process.argv.includes("--live")) throw new Error("Pass --live to authorize one Claude request.");
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !/^(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|OPENAI_API_KEY|CODEX_API_KEY)$/.test(key)));
if (["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"].some((name) => process.env[name])) {
  throw new Error("API credential environment variable is present; no inference was sent.");
}
const which = spawnSync("which", ["claude"], { encoding: "utf8", timeout: 5_000, env });
const cli = which.status === 0 ? which.stdout.trim() : "";
if (!cli) throw new Error("Installed Claude executable was not found.");
const auth = spawnSync(cli, ["auth", "status", "--json"], { encoding: "utf8", timeout: 10_000, env });
let status;
try { status = JSON.parse(auth.stdout); } catch { throw new Error("Claude authentication status could not be parsed."); }
if (auth.status !== 0 || status.loggedIn !== true || status.authMethod !== "claude.ai") {
  throw new Error("Installed Claude is not signed in with claude.ai; no inference was sent.");
}
const directory = await mkdtemp(join(tmpdir(), "countersign-claude-models-"));
let active;
try {
  active = query({ prompt: "Reply with only OK. Do not use tools.", options: {
    cwd: directory, pathToClaudeCodeExecutable: cli, env, settingSources: [],
    strictMcpConfig: true, mcpServers: {}, tools: [], allowedTools: [],
    permissionMode: "default", persistSession: false,
    effort: "low", maxTurns: 1, maxBudgetUsd: 0.2,
  } });
  const models = await active.supportedModels();
  let actualModel = null;
  let effectiveEffort = null;
  let resultSubtype = null;
  let apiKeySource = null;
  for await (const message of active) {
    if (message.type === "system" && message.subtype === "init") {
      actualModel = message.model ?? null;
      effectiveEffort = message.effort ?? null;
      apiKeySource = message.apiKeySource ?? null;
    }
    if (message.type === "result") resultSubtype = message.subtype;
  }
  console.log(JSON.stringify({ phase: "sdk-models", authMethod: status.authMethod, apiKeySource,
    models: models.map((model) => ({ value: model.value, resolvedModel: model.resolvedModel ?? null,
      supportsEffort: model.supportsEffort ?? null, effortLevels: model.supportedEffortLevels ?? [] })),
    actualModel, requestedEffort: "low", effectiveEffort, resultSubtype }));
  if (resultSubtype !== "success" || apiKeySource !== "none" || models.length === 0) process.exitCode = 1;
} finally {
  active?.close();
  await rm(directory, { recursive: true, force: true });
}
