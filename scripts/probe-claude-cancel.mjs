// One live request, used only with explicit consent. Prints no prompt or output text.
import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

if (!process.argv.includes("--live")) throw new Error("Pass --live for the authorized cancellation probe.");
const auth = spawnSync("claude", ["auth", "status", "--json"], { encoding: "utf8", timeout: 10_000 });
let status;
try { status = JSON.parse(auth.stdout); } catch { throw new Error("Claude auth status could not be parsed."); }
if (auth.status !== 0 || status.loggedIn !== true || status.authMethod !== "claude.ai" ||
    process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN) {
  throw new Error("Claude subscription login was not confirmed; no inference was sent.");
}
const directory = await mkdtemp(join(tmpdir(), "countersign-claude-cancel-"));
const child = spawn("claude", ["--print", "--verbose", "--output-format", "stream-json",
  "--include-partial-messages", "--no-session-persistence", "--setting-sources", "",
  "--strict-mcp-config", "--disable-slash-commands", "--tools", "", "--allowedTools", ""], {
  cwd: directory, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32",
  env: Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !/^(ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN|OPENAI_API_KEY|CODEX_API_KEY)$/.test(key))),
});
let streamed = false;
let completed = false;
let stderrBytes = 0;
child.stderr.on("data", (chunk) => { stderrBytes += chunk.length; });
createInterface({ input: child.stdout }).on("line", (line) => {
  let event;
  try { event = JSON.parse(line); } catch { return; }
  if (event.type === "result") completed = true;
  if (!streamed && event.type === "stream_event" && event.event?.type === "content_block_delta") {
    streamed = true;
    try { process.kill(process.platform === "win32" ? child.pid : -child.pid, "SIGTERM"); } catch { /* exited */ }
  }
});
child.stdin.end("Write a numbered list of 200 detailed, distinct techniques for improving a small software project. No tools or file changes.");
try {
  const exitCode = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      try { process.kill(process.platform === "win32" ? child.pid : -child.pid, "SIGKILL"); } catch { /* exited */ }
      reject(new Error("Claude process did not stop within 30 seconds."));
    }, 30_000);
    child.once("error", (error) => { clearTimeout(timer); reject(error); });
    child.once("close", (code, signal) => { clearTimeout(timer); resolve({ code, signal }); });
  });
  console.log(JSON.stringify({ streamed, completed, exitCode: exitCode.code, signal: exitCode.signal, stderrBytes }));
  // Claude catches SIGTERM and may exit with the conventional 128 + 15 code.
  if (!streamed || completed || (exitCode.signal !== "SIGTERM" && exitCode.code !== 143)) process.exitCode = 1;
} finally {
  await rm(directory, { recursive: true, force: true });
}
