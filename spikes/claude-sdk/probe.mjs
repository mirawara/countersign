// One opt-in model turn in a disposable repository. Prints derived facts only.
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { deleteSession, query } from "@anthropic-ai/claude-agent-sdk";

if (!process.argv.includes("--live")) throw new Error("Pass --live to authorize one Claude request.");
if (process.platform !== "linux" || process.arch !== "x64") {
  throw new Error("This spike is pinned to the tested Linux x64 SDK binary.");
}
const require = createRequire(import.meta.url);
const sdkPackage = JSON.parse(await readFile(join(dirname(require.resolve("@anthropic-ai/claude-agent-sdk")), "package.json"), "utf8"));
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

const directory = await mkdtemp(join(tmpdir(), "countersign-claude-sdk-spike-"));
const sessionId = randomUUID();
const hookMarker = join(directory, "project-hook-fired");
const attemptedFile = join(directory, "must-not-exist-after-denial");
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 90_000);
let sessionStarted = false;
let activeQuery;
let permissionCount = 0;
let resultSubtype = null;
let streamed = false;
let actualModel = null;
let apiKeySource = null;
let failureClass = "none";
const exists = async (path) => { try { await access(path); return true; } catch { return false; } };
try {
  const git = spawnSync("git", ["init", "--quiet", directory], { encoding: "utf8", timeout: 10_000 });
  if (git.status !== 0) throw new Error("Temporary Git repository could not be created.");
  await writeFile(join(directory, "README.md"), "Temporary Countersign permission probe.\n");
  await mkdir(join(directory, ".claude"));
  const hookScript = join(directory, "mark-hook.cjs");
  await writeFile(hookScript, `require("node:fs").writeFileSync(${JSON.stringify(hookMarker)}, "fired");\n`, { mode: 0o600 });
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
  await writeFile(join(directory, ".claude", "settings.json"), JSON.stringify({
    hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: `${quote(process.execPath)} ${quote(hookScript)}` }] }] },
  }), { mode: 0o600 });

  activeQuery = query({
    prompt: "Create a file named must-not-exist-after-denial containing TEST in this temporary repository. Use the Write tool and wait for approval if requested. After a refusal, reply briefly.",
    options: {
      cwd: directory, pathToClaudeCodeExecutable: cli, env, sessionId,
      settingSources: [], tools: ["Write"], allowedTools: [], strictMcpConfig: true,
      permissionMode: "default", canUseTool: async () => {
        permissionCount++;
        return { behavior: "deny", message: "The user denied this test write." };
      },
      effort: "low", maxTurns: 2, maxBudgetUsd: 0.3, includePartialMessages: true,
      abortController: controller,
    },
  });
  for await (const message of activeQuery) {
    if (message.type === "system" && message.subtype === "init") {
      sessionStarted = message.session_id === sessionId;
      actualModel = message.model ?? null;
      apiKeySource = message.apiKeySource ?? null;
    }
    if (message.type === "stream_event" && message.event?.type === "content_block_delta") streamed = true;
    if (message.type === "result") resultSubtype = message.subtype;
  }
} catch (error) {
  failureClass = controller.signal.aborted ? "timeout" :
    /auth|login|unauthorized/i.test(String(error)) ? "authentication" :
    /version|protocol|control/i.test(String(error)) ? "protocol" : "other";
} finally {
  clearTimeout(timer);
  activeQuery?.close();
  const hookSuppressed = !(await exists(hookMarker));
  const fileAbsent = !(await exists(attemptedFile));
  console.log(JSON.stringify({ phase: "sdk-permission", sdkVersion: sdkPackage.version,
    cliSource: installedCli ? "installed" : "sdk-bundled",
    cliVersion: version.status === 0 ? version.stdout.trim() : "unknown",
    authMethod: status.authMethod, apiKeySource, sessionStarted, actualModel,
    permissionCount, resultSubtype, streamed, hookSuppressed, fileAbsent, failureClass }));
  if (!sessionStarted || apiKeySource !== "none" || permissionCount < 1 || !hookSuppressed ||
      !fileAbsent || failureClass !== "none" || !resultSubtype) process.exitCode = 1;
  if (sessionStarted) await deleteSession(sessionId, { dir: directory }).catch(() => {});
  await rm(directory, { recursive: true, force: true });
}
