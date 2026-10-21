// Manual vNext probe: two live Claude turns in a disposable repository.
// Prints derived facts only and never displays prompts, responses, or account data.
import { spawn, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { access, mkdir, mkdtemp, readdir, rm, unlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

if (!process.argv.includes("--live")) throw new Error("Pass --live to authorize the two Claude requests.");
const auth = spawnSync("claude", ["auth", "status", "--json"], { encoding: "utf8", timeout: 10_000 });
const versionResult = spawnSync("claude", ["--version"], { encoding: "utf8", timeout: 10_000 });
let status;
try { status = JSON.parse(auth.stdout); } catch { throw new Error("Claude authentication status could not be parsed."); }
if (auth.status !== 0 || status.loggedIn !== true || status.authMethod !== "claude.ai") {
  throw new Error("Claude is not confirmed as signed in with claude.ai; no inference was sent.");
}
if (["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN"].some((name) => process.env[name])) {
  throw new Error("API credential environment variable is present; no inference was sent.");
}

const directory = await mkdtemp(join(tmpdir(), "countersign-claude-spike-"));
const sessionId = randomUUID();
const marker = join(directory, "hook-fired");
const git = spawnSync("git", ["init", "--quiet", directory], { encoding: "utf8", timeout: 10_000 });
if (git.status !== 0) throw new Error("Temporary Git repository could not be created.");
const claudeDir = join(directory, ".claude");
await mkdir(claudeDir);
const hookScript = join(directory, "mark-hook.cjs");
await writeFile(hookScript, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "fired");\n`, { mode: 0o600 });
const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`;
await writeFile(join(claudeDir, "settings.json"), JSON.stringify({
  hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: `${quote(process.execPath)} ${quote(hookScript)}` }] }] },
}), { mode: 0o600 });

async function exists(path) {
  try { await access(path); return true; } catch { return false; }
}

async function sessionFile() {
  const root = join(process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"), "projects");
  async function find(directory, depth) {
    if (depth > 3) return null;
    let entries;
    try { entries = await readdir(directory, { withFileTypes: true }); } catch { return null; }
    for (const entry of entries) {
      const path = join(directory, entry.name);
      if (entry.isFile() && entry.name === `${sessionId}.jsonl`) return path;
      if (entry.isDirectory()) {
        const result = await find(path, depth + 1);
        if (result) return result;
      }
    }
    return null;
  }
  return find(root, 0);
}

async function turn(prompt, extraArgs) {
  const args = ["--print", "--verbose", "--output-format", "stream-json", "--include-partial-messages",
    "--strict-mcp-config", "--disable-slash-commands", "--permission-mode", "default",
    "--tools", "", "--allowedTools", "", "--setting-sources", ...extraArgs];
  const child = spawn("claude", args, {
    cwd: directory, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32",
    env: Object.fromEntries(Object.entries(process.env).filter(([key]) => !/^(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|OPENAI_API_KEY|CODEX_API_KEY)$/.test(key))),
  });
  const events = [];
  let stderrBytes = 0;
  let stderr = "";
  child.stderr.on("data", (chunk) => { stderrBytes += chunk.length; stderr += chunk.toString("utf8").slice(0, 4_000); });
  createInterface({ input: child.stdout }).on("line", (line) => {
    try { events.push(JSON.parse(line)); } catch { /* malformed line is counted by missing result */ }
  });
  child.stdin.end(prompt);
  const exitCode = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try { process.kill(process.platform === "win32" ? child.pid : -child.pid, "SIGTERM"); } catch { /* exited */ }
      reject(new Error("Claude turn timed out and was terminated."));
    }, 120_000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code) => { clearTimeout(timer); resolve(code); });
  });
  const result = events.findLast((event) => event.type === "result");
  const chunks = events.flatMap((event) => event.type === "stream_event" && event.event?.type === "content_block_delta"
    ? [event.event.delta?.text ?? ""] : []);
  const text = chunks.join("") || (typeof result?.result === "string" ? result.result : "");
  return { exitCode, eventTypes: [...new Set(events.map((event) => event.type))], chunkCount: chunks.length,
    sessionId: result?.session_id, isError: result?.is_error, textLength: text.length, text, stderrBytes,
    safeDiagnostic: stderr.split(/\r?\n/).find((line) => line.length < 200 &&
      !/[/\\@]|token|key|secret|credential|sk-|[a-f0-9]{16}/i.test(line))?.slice(0, 200) ?? "withheld",
    failureClass: /session.?id/i.test(stderr) ? "session_id" : /permission/i.test(stderr) ? "permission" :
      /authentication|login|unauthorized/i.test(stderr) ? "authentication" :
      /argument|option|unknown/i.test(stderr) ? "arguments" : stderrBytes > 0 ? "other_stderr" : "none" };
}

try {
  const first = await turn("Remember marker AMBER-73. Reply with only OK. Do not use tools.", ["project", "--session-id", sessionId]);
  const hookFired = await exists(marker);
  if (hookFired) await unlink(marker);
  const storedAfterFirst = await sessionFile();
  const second = await turn("What marker did I ask you to remember? Reply with only that marker. Do not use tools.", ["", "--resume", sessionId]);
  const hookSuppressed = !(await exists(marker));
  const storedAfterSecond = await sessionFile();
  const sessionIdStable = first.sessionId === sessionId && second.sessionId === sessionId;
  const resumed = /AMBER-73/.test(second.text);
  console.log(JSON.stringify({ provider: "Claude CLI", version: versionResult.status === 0 ? versionResult.stdout.trim() : "unknown", authMethod: status.authMethod,
    firstExit: first.exitCode, firstError: first.isError, firstFailure: first.failureClass,
    ...(first.exitCode === 0 ? {} : { firstDiagnostic: first.safeDiagnostic }),
    secondExit: second.exitCode, secondError: second.isError, secondFailure: second.failureClass,
    ...(second.exitCode === 0 ? {} : { secondDiagnostic: second.safeDiagnostic }),
    firstEvents: first.eventTypes, secondEvents: second.eventTypes,
    firstChunks: first.chunkCount, secondChunks: second.chunkCount,
    sessionIdStable, resumed, hookFired, hookSuppressed,
    sessionStoredInClaudeProjects: Boolean(storedAfterFirst && storedAfterSecond) }));
  if (!storedAfterFirst || !storedAfterSecond || !hookFired || !hookSuppressed || !sessionIdStable || !resumed ||
      first.chunkCount < 1 || second.chunkCount < 1 || first.exitCode !== 0 || second.exitCode !== 0) process.exitCode = 1;
  if (storedAfterSecond) await unlink(storedAfterSecond);
} finally {
  await rm(directory, { recursive: true, force: true });
}
