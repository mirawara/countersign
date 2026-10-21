// Two opt-in SDK turns to verify session persistence, resume, and settings isolation.
// Only derived facts are printed; test sessions and repositories are removed.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { access, mkdir, mkdtemp, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { deleteSession, query } from "@anthropic-ai/claude-agent-sdk";

if (!process.argv.includes("--live")) throw new Error("Pass --live to authorize two Claude requests.");
if (process.platform !== "linux" || process.arch !== "x64") {
  throw new Error("This spike is pinned to the tested Linux x64 SDK binary.");
}
const require = createRequire(import.meta.url);
const installedCli = process.argv.includes("--installed-cli");
const cli = installedCli
  ? spawnSync("which", ["claude"], { encoding: "utf8", timeout: 5_000 }).stdout.trim()
  : join(dirname(require.resolve("@anthropic-ai/claude-agent-sdk-linux-x64/package.json")), "claude");
if (!cli) throw new Error("Claude executable was not found.");
const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !/^(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|OPENAI_API_KEY|CODEX_API_KEY)$/.test(key)));
if (["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"].some((name) => process.env[name])) {
  throw new Error("API credential environment variable is present; no inference was sent.");
}
const auth = spawnSync(cli, ["auth", "status", "--json"], { encoding: "utf8", timeout: 10_000, env });
const version = spawnSync(cli, ["--version"], { encoding: "utf8", timeout: 10_000, env });
let status;
try { status = JSON.parse(auth.stdout); } catch { throw new Error("Claude authentication status could not be parsed."); }
if (auth.status !== 0 || status.loggedIn !== true || status.authMethod !== "claude.ai") {
  throw new Error("The SDK binary is not signed in with claude.ai; no inference was sent.");
}

const directory = await mkdtemp(join(tmpdir(), "countersign-claude-sdk-resume-"));
const sessionId = randomUUID();
const marker = join(directory, "hook-fired");
const exists = async (path) => { try { await access(path); return true; } catch { return false; } };
const sessionRoot = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects");
async function sessionFile(root, depth = 0) {
  if (depth > 3) return null;
  let entries;
  try { entries = await readdir(root, { withFileTypes: true }); } catch { return null; }
  for (const entry of entries) {
    const path = join(root, entry.name);
    if (entry.isFile() && entry.name === `${sessionId}.jsonl`) return path;
    if (entry.isDirectory()) {
      const found = await sessionFile(path, depth + 1);
      if (found) return found;
    }
  }
  return null;
}

async function turn(prompt, options) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 90_000);
  const active = query({ prompt, options: {
    cwd: directory, pathToClaudeCodeExecutable: cli, env,
    strictMcpConfig: true, mcpServers: {}, tools: [], allowedTools: [],
    permissionMode: "default", canUseTool: async () => ({ behavior: "deny", message: "No tools in this probe." }),
    effort: "low", maxTurns: 1, maxBudgetUsd: 0.3, includePartialMessages: true,
    abortController: controller, ...options,
  } });
  let initSessionId = null;
  let resultSessionId = null;
  let resultSubtype = null;
  let resultError = null;
  let model = null;
  let effort = null;
  let apiKeySource = null;
  let usagePresent = false;
  let rateLimitEvent = false;
  let deltaCount = 0;
  const chunks = [];
  try {
    for await (const message of active) {
      if (message.type === "system" && message.subtype === "init") {
        initSessionId = message.session_id;
        model = message.model ?? null;
        effort = message.effort ?? null;
        apiKeySource = message.apiKeySource ?? null;
      }
      if (message.type === "stream_event" && message.event?.type === "content_block_delta") {
        deltaCount++;
        chunks.push(message.event.delta?.text ?? "");
      }
      if (message.type === "rate_limit_event") rateLimitEvent = true;
      if (message.type === "result") {
        resultSessionId = message.session_id;
        resultSubtype = message.subtype;
        resultError = message.is_error === true;
        usagePresent = Boolean(message.modelUsage && Object.keys(message.modelUsage).length > 0);
        if (chunks.length === 0 && typeof message.result === "string") chunks.push(message.result);
      }
    }
  } finally {
    clearTimeout(timer);
    active.close();
  }
  return { initSessionId, resultSessionId, resultSubtype, resultError, model, effort, apiKeySource,
    usagePresent, rateLimitEvent, streamed: deltaCount > 0, text: chunks.join("") };
}

let stored = null;
try {
  const git = spawnSync("git", ["init", "--quiet", directory], { encoding: "utf8", timeout: 10_000 });
  if (git.status !== 0) throw new Error("Temporary Git repository could not be created.");
  await writeFile(join(directory, "README.md"), "Temporary Countersign SDK resume probe.\n");
  await mkdir(join(directory, ".claude"));
  const hookScript = join(directory, "mark-hook.cjs");
  await writeFile(hookScript, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "fired");\n`, { mode: 0o600 });
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  await writeFile(join(directory, ".claude", "settings.json"), JSON.stringify({
    hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: `${quote(process.execPath)} ${quote(hookScript)}` }] }] },
  }), { mode: 0o600 });

  const first = await turn("Remember marker COPPER-18. Reply with only OK. Do not use tools.", {
    sessionId, settingSources: ["project"],
  });
  const hookFired = await exists(marker);
  stored = await sessionFile(sessionRoot);
  if (hookFired) await unlink(marker);
  if (first.resultSubtype !== "success" || first.resultError || first.resultSessionId !== sessionId || !hookFired || !stored) {
    throw new Error("First SDK turn did not establish a resumable control session.");
  }
  const second = await turn("What marker did I ask you to remember? Reply with only that marker. Do not use tools.", {
    resume: sessionId, settingSources: [],
  });
  const hookSuppressed = !(await exists(marker));
  const storedAfterResume = Boolean(await sessionFile(sessionRoot));
  const resumed = /COPPER-18/.test(second.text);
  const sessionIdStable = [first.initSessionId, first.resultSessionId, second.initSessionId, second.resultSessionId]
    .every((value) => value === sessionId);
  console.log(JSON.stringify({ phase: "sdk-resume", cliVersion: version.status === 0 ? version.stdout.trim() : "unknown",
    cliSource: installedCli ? "installed" : "sdk-bundled",
    authMethod: status.authMethod, apiKeySource: second.apiKeySource,
    firstStatus: first.resultSubtype, secondStatus: second.resultSubtype,
    firstModel: first.model, secondModel: second.model, firstEffort: first.effort, secondEffort: second.effort,
    firstStreamed: first.streamed, secondStreamed: second.streamed,
    usagePresent: first.usagePresent && second.usagePresent,
    rateLimitEventObserved: first.rateLimitEvent || second.rateLimitEvent,
    sessionIdStable, resumed, hookFired, hookSuppressed, storedAfterFirst: Boolean(stored), storedAfterResume }));
  if (second.resultSubtype !== "success" || second.resultError || second.apiKeySource !== "none" ||
      !first.streamed || !second.streamed ||
      !hookSuppressed || !storedAfterResume || !sessionIdStable || !resumed) process.exitCode = 1;
} finally {
  await deleteSession(sessionId, { dir: directory }).catch(() => {});
  const leftover = await sessionFile(sessionRoot);
  if (leftover) await unlink(leftover).catch(() => {});
  await rm(directory, { recursive: true, force: true });
}
