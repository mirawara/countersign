import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { query as queryType, deleteSession as deleteSessionType } from "@anthropic-ai/claude-agent-sdk";
import { inspectClaude } from "./claudeAdapter";
import { subscriptionEnvironment } from "./providerUtils";

type Sdk = { query: typeof queryType; deleteSession: typeof deleteSessionType };
const importSdk = (): Promise<Sdk> => Function("name", "return import(name)")("@anthropic-ai/claude-agent-sdk") as Promise<Sdk>;
export const VERIFIED_CLAUDE_CHAT_CLI = "2.1.109 (Claude Code)";
export const VERIFIED_CLAUDE_CHAT_SDK = "0.3.306";

export interface ClaudeChatGateRecord { sdkVersion: string; cliVersion: string; passedAt: string }

export async function sdkVersion(): Promise<string> {
  const entry = require.resolve("@anthropic-ai/claude-agent-sdk");
  const pkg = JSON.parse(await readFile(join(dirname(entry), "package.json"), "utf8")) as { version?: string };
  if (!pkg.version) throw new Error("Claude SDK version is unavailable.");
  return pkg.version;
}

export function chatGateMatches(record: unknown, cliVersion: string, sdk: string): boolean {
  return typeof record === "object" && record !== null && "cliVersion" in record && "sdkVersion" in record &&
    record.cliVersion === cliVersion && record.sdkVersion === sdk;
}

export async function verifyClaudeChatGate(executable: string, configDir?: string): Promise<ClaudeChatGateRecord> {
  if (process.platform !== "linux") throw new Error("The Claude chat gate is verified on Linux only.");
  const env = subscriptionEnvironment(configDir ? { CLAUDE_CONFIG_DIR: configDir } : undefined);
  const resolved = executable.includes("/") ? resolve(executable) : spawnSync("which", [executable], { encoding: "utf8", env }).stdout.trim();
  if (!resolved) throw new Error("Claude CLI is unavailable.");
  const version = await inspectClaude(resolved, tmpdir(), configDir);
  const currentSdk = await sdkVersion();
  if (version.version !== VERIFIED_CLAUDE_CHAT_CLI || currentSdk !== VERIFIED_CLAUDE_CHAT_SDK) {
    throw new Error("Claude CLI or SDK version changed; the chat adapter needs a new compatibility check before live verification.");
  }
  const directory = await mkdtemp(join(tmpdir(), "countersign-chat-gate-"));
  const sessionId = randomUUID();
  const marker = join(directory, "hook-fired");
  const root = join(env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects");
  const { query, deleteSession } = await importSdk();
  const exists = async (path: string): Promise<boolean> => { try { await access(path); return true; } catch { return false; } };
  const sessionFile = async (path: string, depth = 0): Promise<boolean> => {
    if (depth > 3) return false;
    let entries;
    try { entries = await readdir(path, { withFileTypes: true }); } catch { return false; }
    for (const entry of entries) {
      if (entry.isFile() && entry.name === `${sessionId}.jsonl`) return true;
      if (entry.isDirectory() && await sessionFile(join(path, entry.name), depth + 1)) return true;
    }
    return false;
  };
  async function turn(prompt: string, sources: Array<"project">, resume: boolean): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 90_000);
    const active = query({ prompt, options: {
      cwd: directory, pathToClaudeCodeExecutable: resolved, env,
      ...(resume ? { resume: sessionId } : { sessionId }),
      settingSources: sources, strictMcpConfig: true, mcpServers: {}, tools: [], allowedTools: [],
      permissionMode: "default", canUseTool: async () => ({ behavior: "deny", message: "Gate tools disabled." }),
      effort: "low", maxTurns: 1, includePartialMessages: true, abortController: controller,
    } });
    let output = "";
    let success = false;
    let authConfirmed = false;
    try {
      for await (const message of active) {
        if (message.type === "system" && message.subtype === "init") {
          authConfirmed = message.apiKeySource === "none" && message.session_id === sessionId;
        }
        if (message.type === "stream_event" && message.event.type === "content_block_delta" &&
            message.event.delta.type === "text_delta") output += message.event.delta.text;
        if (message.type === "result") {
          success = message.subtype === "success" && !message.is_error && message.session_id === sessionId;
          if (!output && message.subtype === "success") output = message.result;
        }
      }
      if (!authConfirmed || !success) throw new Error("Claude gate turn was inconclusive.");
      return output;
    } finally { clearTimeout(timer); active.close(); }
  }
  try {
    const git = spawnSync("git", ["init", "--quiet", directory], { timeout: 10_000, env });
    if (git.status !== 0) throw new Error("Temporary gate repository could not be created.");
    await mkdir(join(directory, ".claude"));
    await writeFile(join(directory, "README.md"), "Temporary Countersign chat isolation gate.\n");
    const hookScript = join(directory, "hook.cjs");
    await writeFile(hookScript, `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'fired');\n`, { mode: 0o600 });
    const quote = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;
    await writeFile(join(directory, ".claude", "settings.json"), JSON.stringify({
      hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: `${quote(process.execPath)} ${quote(hookScript)}` }] }] },
    }), { mode: 0o600 });
    await turn("Remember marker COPPER-18. Reply only OK. Do not use tools.", ["project"], false);
    if (!(await exists(marker)) || !(await sessionFile(root))) throw new Error("Claude gate control did not establish the expected session and hook.");
    await rm(marker, { force: true });
    const second = await turn("What marker did I ask you to remember? Reply only with the marker. Do not use tools.", [], true);
    if (await exists(marker) || !(await sessionFile(root)) || !second.includes("COPPER-18")) {
      throw new Error("Claude gate did not prove resume with project settings suppressed.");
    }
    return { sdkVersion: currentSdk, cliVersion: version.version, passedAt: new Date().toISOString() };
  } finally {
    await deleteSession(sessionId, { dir: directory }).catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
}
