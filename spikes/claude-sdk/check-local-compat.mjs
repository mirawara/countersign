// SDK/installed-CLI handshake only. No prompt or model request.
import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startup } from "@anthropic-ai/claude-agent-sdk";

const env = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
  !/^(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|OPENAI_API_KEY|CODEX_API_KEY)$/.test(key)));
if (["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"].some((name) => process.env[name])) {
  throw new Error("API credential environment variable is present; no probe was started.");
}
const which = spawnSync("which", ["claude"], { encoding: "utf8", timeout: 5_000, env });
const cli = which.status === 0 ? which.stdout.trim() : "";
if (!cli) throw new Error("Installed Claude executable was not found.");
const version = spawnSync(cli, ["--version"], { encoding: "utf8", timeout: 10_000, env });
const auth = spawnSync(cli, ["auth", "status", "--json"], { encoding: "utf8", timeout: 10_000, env });
let account;
try { account = JSON.parse(auth.stdout); } catch { throw new Error("Claude authentication status could not be parsed."); }
if (auth.status !== 0 || account.loggedIn !== true || account.authMethod !== "claude.ai") {
  throw new Error("Installed Claude is not signed in with claude.ai.");
}
const directory = await mkdtemp(join(tmpdir(), "countersign-sdk-handshake-"));
let warm;
let compatible = false;
let failureClass = "none";
try {
  warm = await startup({ options: {
    cwd: directory, pathToClaudeCodeExecutable: cli, env,
    settingSources: [], strictMcpConfig: true, mcpServers: {}, tools: [],
    persistSession: false, permissionMode: "default",
  }, initializeTimeoutMs: 15_000 });
  compatible = true;
} catch (error) {
  failureClass = /timeout/i.test(String(error)) ? "timeout" :
    /version|protocol|control/i.test(String(error)) ? "protocol" :
    /auth|login|unauthorized/i.test(String(error)) ? "authentication" : "other";
} finally {
  warm?.close();
  await rm(directory, { recursive: true, force: true });
}
console.log(JSON.stringify({ installedCliVersion: version.status === 0 ? version.stdout.trim() : "unknown",
  authMethod: account.authMethod, compatible, failureClass, inferenceRequests: 0 }));
if (!compatible) process.exitCode = 1;
