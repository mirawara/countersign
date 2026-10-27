import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { randomUUID } from "node:crypto";
import { CLAUDE_GATE_POLICY_REVISION, ClaudeGateRecord } from "../shared/types";

const RECORD_PATH = join(homedir(), ".countersign", "claude-gate.json");
/** Where the record lived before the extension was renamed; read so a passed gate survives. */
const LEGACY_RECORD_PATH = join(homedir(), ".ai-dev-orchestrator", "claude-gate.json");

/**
 * Resolves the pre-rename record to consult alongside `path`. It applies to the real record by
 * default, and to an explicit path only when the caller names one, so tests never reach the
 * record in the user's home directory.
 */
function legacyFor(path: string, legacyPath?: string): string | undefined {
  if (legacyPath) return legacyPath;
  return path === RECORD_PATH ? LEGACY_RECORD_PATH : undefined;
}

export async function loadClaudeGateRecord(path = RECORD_PATH, legacyPath?: string): Promise<ClaudeGateRecord | undefined> {
  const record = await readRecord(path);
  if (record) return record;
  const legacy = legacyFor(path, legacyPath);
  return legacy ? readRecord(legacy) : undefined;
}

async function readRecord(path: string): Promise<ClaudeGateRecord | undefined> {
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
  if (record.passed !== true || record.policyRevision !== CLAUDE_GATE_POLICY_REVISION ||
    typeof record.version !== "string" || record.version.length === 0 || record.version.length > 128
    || typeof record.passedAt !== "string" || !Number.isFinite(Date.parse(record.passedAt))) return undefined;
  return { passed: true, version: record.version, passedAt: record.passedAt,
    policyRevision: CLAUDE_GATE_POLICY_REVISION };
}

export async function saveClaudeGateRecord(record: ClaudeGateRecord, path = RECORD_PATH, legacyPath?: string): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `claude-gate-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(record)}\n`, { mode: 0o600, flag: "wx" });
    await rename(temporary, path);
  } finally {
    await rm(temporary, { force: true });
  }
  // Drop the pre-rename record so it can never shadow or outlive the current one.
  const legacy = legacyFor(path, legacyPath);
  if (legacy) await rm(legacy, { force: true });
}

export async function clearClaudeGateRecord(path = RECORD_PATH, legacyPath?: string): Promise<void> {
  await rm(path, { force: true });
  // A cleared gate must stay cleared, so the legacy fallback goes with it.
  const legacy = legacyFor(path, legacyPath);
  if (legacy) await rm(legacy, { force: true });
}

function isMissing(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}
