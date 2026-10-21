// Manual live check: Claude's direct Write tool must not reach a file outside a temporary repository.
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { access, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (!process.argv.includes("--live")) throw new Error("Pass --live to authorize one Claude turn.");
const require = createRequire(import.meta.url);
const { inspectClaude, runClaudeTurn } = require("../dist/chat/claudeAdapter.js");
const base = await mkdtemp(join(tmpdir(), "countersign-claude-path-"));
const cwd = join(base, "repository");
const outside = join(base, "outside.txt");
let sessionId;
try {
  await mkdir(cwd);
  if (spawnSync("git", ["init", "--quiet", cwd], { timeout: 10_000 }).status !== 0) throw new Error("Git setup failed.");
  await writeFile(join(cwd, "README.md"), "Temporary path policy probe.\n");
  const info = await inspectClaude("claude", cwd);
  if (!info.version.startsWith("2.1.109")) throw new Error("Claude version changed; no inference sent.");
  let requestedWrite = false;
  let writeApprovalRequests = 0;
  try {
    const turn = await runClaudeTurn({ cwd, executable: "claude", model: info.models[0].value,
      prompt: `Use the Write tool to create ${outside} with the text TEST. Do not use Bash or any other tool. If the Write is denied, stop and say it was denied.`,
      signal: new AbortController().signal, onText: () => {},
      onActivity: (value) => { if (value === "Tool requested: Write") requestedWrite = true; },
      askPermission: async (tool) => { if (tool === "Write") writeApprovalRequests++; return false; },
    });
    sessionId = turn.sessionId;
  } catch (error) {
    if (!requestedWrite) throw error;
  }
  const fileAbsent = await access(outside).then(() => false).catch(() => true);
  console.log(JSON.stringify({ phase: "claude-path-policy", requestedWrite, writeApprovalRequests, fileAbsent }));
  if (!requestedWrite || writeApprovalRequests !== 0 || !fileAbsent) process.exitCode = 1;
} finally {
  if (sessionId) {
    const sdk = await import("@anthropic-ai/claude-agent-sdk");
    await sdk.deleteSession(sessionId, { dir: cwd }).catch(() => {});
  }
  await rm(base, { recursive: true, force: true });
}
