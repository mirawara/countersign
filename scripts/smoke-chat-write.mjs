// Manual product-adapter write and resume check, confined to a temporary Git repository.
import { spawnSync } from "node:child_process";
import { access, mkdtemp, rm, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

if (!process.argv.includes("--live")) throw new Error("Pass --live to authorize two Claude turns.");
const require = createRequire(import.meta.url);
const { inspectClaude, runClaudeTurn } = require("../dist/chat/claudeAdapter.js");
const { readGitChanges } = require("../dist/context/gitChanges.js");
const cwd = await mkdtemp(join(tmpdir(), "countersign-chat-write-"));
let sessionId;
try {
  for (const args of [["init", "--quiet", cwd]]) {
    if (spawnSync("git", args, { timeout: 10_000 }).status !== 0) throw new Error("Git setup failed.");
  }
  await writeFile(join(cwd, "README.md"), "Temporary product adapter test.\n");
  for (const args of [["add", "README.md"], ["-c", "user.name=Smoke", "-c", "user.email=smoke@example.invalid",
    "commit", "--quiet", "-m", "baseline"]]) {
    if (spawnSync("git", args, { cwd, timeout: 10_000 }).status !== 0) throw new Error("Git baseline failed.");
  }
  const info = await inspectClaude("claude", cwd);
  if (!info.version.startsWith("2.1.109")) throw new Error("Claude version changed; no inference sent.");
  let permissionCount = 0;
  let streamCount = 0;
  const activities = [];
  const requested = [];
  const paths = [];
  const first = await runClaudeTurn({ cwd, executable: "claude", model: info.models[0].value, effort: "low",
    prompt: "Create a file named marker.txt containing exactly COPPER-18 followed by a newline. Use the Write tool. Then reply briefly.",
    signal: new AbortController().signal, onText: () => streamCount++, onActivity: (item) => activities.push(item),
    askPermission: async (tool, detail) => {
      requested.push(tool);
      try { paths.push(JSON.parse(detail).file_path); } catch { paths.push("unavailable"); }
      if (tool === "Write") permissionCount++;
      return tool === "Write";
    },
  });
  sessionId = first.sessionId;
  let created = false;
  try { created = (await readFile(join(cwd, "marker.txt"), "utf8")).trim() === "COPPER-18"; } catch { /* recorded below */ }
  if (!created) {
    console.log(JSON.stringify({ phase: "product-write-resume", permissionCount, created, requested, paths,
      activities, streamCount, firstModel: first.model }));
    throw new Error("The product adapter did not create the requested temporary file.");
  }
  const diff = await readGitChanges(cwd);
  let resumedStream = 0;
  const second = await runClaudeTurn({ cwd, executable: "claude", sessionId, model: info.models[0].value,
    prompt: "What marker did I ask you to write? Reply only with that marker. Do not use tools.",
    signal: new AbortController().signal, onText: (delta) => { resumedStream += delta.length; }, onActivity: () => {},
    askPermission: async () => false,
  });
  console.log(JSON.stringify({ phase: "product-write-resume", permissionCount, created,
    diffIncludesFile: diff.paths.includes("marker.txt"), streamCount, resumedStream,
    stableSession: second.sessionId === sessionId }));
  if (!permissionCount || !created || !diff.paths.includes("marker.txt") || !streamCount || !resumedStream || second.sessionId !== sessionId) {
    process.exitCode = 1;
  }
} finally {
  if (sessionId) {
    const sdk = await import("@anthropic-ai/claude-agent-sdk");
    await sdk.deleteSession(sessionId, { dir: cwd }).catch(() => {});
  }
  await access(cwd).then(() => rm(cwd, { recursive: true, force: true })).catch(() => {});
}
