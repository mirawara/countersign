import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { ClaudeGateRecord } from "../shared/types";

const RECORD_PATH = join(homedir(), ".ai-dev-orchestrator", "claude-gate.json");

export async function loadClaudeGateRecord(path = RECORD_PATH): Promise<ClaudeGateRecord | undefined> {
  let text: string;
  try { text = await readFile(path, "utf8"); }
  catch (error) {
    if (isMissing(error)) return undefined;
    throw error;
  }
  let value: unknown;
  try { value = JSON.parse(text); }
  catch { return undefined; }
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  if (record.passed !== true || typeof record.version !== "string" || record.version.length === 0 || record.version.length > 128
    || typeof record.passedAt !== "string" || !Number.isFinite(Date.parse(record.passedAt))) return undefined;
  return { passed: true, version: record.version, passedAt: record.passedAt };
}

export async function saveClaudeGateRecord(record: ClaudeGateRecord, path = RECORD_PATH): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `claude-gate-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
}

export async function clearClaudeGateRecord(path = RECORD_PATH): Promise<void> {
  await rm(path, { force: true });
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
