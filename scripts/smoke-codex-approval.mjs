// Manual Codex approval test. Only touches a temporary repository after --live.
import { spawnSync } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire } from "node:module";

if (!process.argv.includes("--live")) throw new Error("Pass --live to authorize one Codex turn.");
const require = createRequire(import.meta.url);
const { inspectCodex, runCodexTurn, CodexAppServer } = require("../dist/chat/codexAdapter.js");
const cwd = await mkdtemp(join(tmpdir(), "countersign-codex-approval-"));
let sessionId;
try {
  if (spawnSync("git", ["init", "--quiet", cwd], { timeout: 10_000 }).status !== 0) throw new Error("Git setup failed.");
  await writeFile(join(cwd, "README.md"), "Temporary Codex approval test.\n");
  const info = await inspectCodex("codex", cwd);
  if (!info.version.includes("0.163.0")) throw new Error("Codex version changed; no inference sent.");
  let approvals = 0;
  const kinds = [];
  const result = await runCodexTurn({ cwd, executable: "codex", model: info.models[0].value,
    prompt: "Create a file named marker.txt in this temporary repository containing COPPER-18 and a newline. Request approval if required, then reply briefly.",
    signal: new AbortController().signal, onText: () => {}, onActivity: () => {},
    askPermission: async (kind) => { approvals++; kinds.push(kind); return true; },
  });
  sessionId = result.sessionId;
  let created = false;
  try { created = (await readFile(join(cwd, "marker.txt"), "utf8")).trim() === "COPPER-18"; } catch { /* recorded */ }
  console.log(JSON.stringify({ phase: "codex-approval", approvals, kinds, created, session: Boolean(sessionId) }));
  if (!approvals || !created) process.exitCode = 1;
} finally {
  if (sessionId) {
    const server = new CodexAppServer("codex", cwd);
    try { await server.initialize(); await server.request("thread/delete", { threadId: sessionId }).catch(() => {}); }
    finally { server.close(); }
  }
  await rm(cwd, { recursive: true, force: true });
}
