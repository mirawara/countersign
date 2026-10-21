import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { ClaudeChatGateRecord } from "./claudeChatGate";

const PATH = join(homedir(), ".countersign", "claude-chat-gate.json");

export async function loadClaudeChatGate(path = PATH): Promise<ClaudeChatGateRecord | undefined> {
  let text: string;
  try { text = await readFile(path, "utf8"); } catch { return undefined; }
  let value: unknown;
  try { value = JSON.parse(text); } catch { return undefined; }
  if (typeof value !== "object" || value === null || !("sdkVersion" in value) || !("cliVersion" in value) || !("passedAt" in value)) return undefined;
  if (typeof value.sdkVersion !== "string" || typeof value.cliVersion !== "string" ||
      typeof value.passedAt !== "string" || !Number.isFinite(Date.parse(value.passedAt))) return undefined;
  return { sdkVersion: value.sdkVersion, cliVersion: value.cliVersion, passedAt: value.passedAt };
}

export async function saveClaudeChatGate(record: ClaudeChatGateRecord, path = PATH): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = join(dirname(path), `claude-chat-gate-${randomUUID()}.tmp`);
  try {
    await writeFile(temp, `${JSON.stringify(record)}\n`, { flag: "wx", mode: 0o600 });
    await rename(temp, path);
  } finally { await rm(temp, { force: true }); }
}

export async function clearClaudeChatGate(path = PATH): Promise<void> {
  await rm(path, { force: true });
}
