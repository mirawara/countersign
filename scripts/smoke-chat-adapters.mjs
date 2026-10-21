// Manual smoke test for the product adapters. Requires --live; no CI inference.
import { spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

if (!process.argv.includes("--live")) throw new Error("Pass --live to authorize one short turn per provider.");
const require = createRequire(import.meta.url);
const { runClaudeTurn, inspectClaude } = require("../dist/chat/claudeAdapter.js");
const { runCodexTurn, inspectCodex, CodexAppServer } = require("../dist/chat/codexAdapter.js");
const cwd = await mkdtemp(join(tmpdir(), "countersign-chat-adapters-"));
const git = spawnSync("git", ["init", "--quiet", cwd], { timeout: 10_000 });
if (git.status !== 0) throw new Error("Temporary Git repository could not be created.");
await writeFile(join(cwd, "README.md"), "Temporary adapter smoke test.\n");

let claudeSession;
let codexSession;
try {
  const claude = await inspectClaude("claude", cwd);
  const codex = await inspectCodex("codex", cwd);
  if (!claude.version.startsWith("2.1.109") || !codex.version.includes("0.163.0")) {
    throw new Error("Provider version changed; no inference sent.");
  }
  let claudeDeltas = 0;
  const first = await runClaudeTurn({ cwd, executable: "claude", prompt: "Reply with only OK. Do not use tools.",
    model: claude.models[0].value, effort: "low", signal: new AbortController().signal,
    onText: () => claudeDeltas++, onActivity: () => {}, askPermission: async () => false });
  claudeSession = first.sessionId;
  let codexDeltas = 0;
  const second = await runCodexTurn({ cwd, executable: "codex", prompt: "Reply with only OK. Do not use tools.",
    model: codex.models[0].value, signal: new AbortController().signal,
    onText: () => codexDeltas++, onActivity: () => {}, askPermission: async () => false });
  codexSession = second.sessionId;
  console.log(JSON.stringify({ phase: "product-adapters", claudeDeltas, codexDeltas,
    claudeSession: Boolean(first.sessionId), codexSession: Boolean(second.sessionId),
    claudeModel: first.model, claudeUsage: Boolean(first.usage) }));
  if (!claudeDeltas || !codexDeltas || !first.sessionId || !second.sessionId) process.exitCode = 1;
} finally {
  if (claudeSession) {
    const sdk = await import("@anthropic-ai/claude-agent-sdk");
    await sdk.deleteSession(claudeSession, { dir: cwd }).catch(() => {});
  }
  if (codexSession) {
    const server = new CodexAppServer("codex", cwd);
    try { await server.initialize(); await server.request("thread/delete", { threadId: codexSession }).catch(() => {}); }
    finally { server.close(); }
  }
  await rm(cwd, { recursive: true, force: true });
}
