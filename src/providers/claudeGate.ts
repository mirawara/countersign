import { access, mkdir, mkdtemp, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { OrchestratorConfig } from "../configuration/config";
import { ProcessOptions, ProcessResult, runExecutable } from "../shared/process";
import { ClaudeGateRecord } from "../shared/types";
import { requiredCapabilities } from "./claudeCliProvider";

type Runner = (executable: string, args: string[], options: ProcessOptions) => Promise<ProcessResult>;

export class ClaudeGateError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ClaudeGateError";
  }
}

export async function verifyClaudeSettingsGate(
  config: OrchestratorConfig,
  signal: AbortSignal,
  runner: Runner = runExecutable,
): Promise<ClaudeGateRecord> {
  const version = await readVersion(config, runner);
  if (!version) throw new ClaudeGateError("Claude CLI version could not be read.");
  const help = await runner(config.claudeExecutable, ["--help"], processOptions(process.cwd(), config, signal));
  if (help.exitCode !== 0 || requiredCapabilities(help.stdout).length > 0) {
    throw new ClaudeGateError("Claude CLI does not declare every required isolation and output flag.");
  }

  const directory = await mkdtemp(join(tmpdir(), "countersign-claude-gate-"));
  const marker = join(directory, "hook-fired");
  try {
    const claudeDir = join(directory, ".claude");
    await mkdir(claudeDir);
    const script = join(directory, "mark-hook.cjs");
    await writeFile(script, `require("node:fs").writeFileSync(${JSON.stringify(marker)}, "fired");\n`, { mode: 0o600 });
    const settings = {
      hooks: { UserPromptSubmit: [{ hooks: [{ type: "command", command: `${shellQuote(process.execPath)} ${shellQuote(script)}` }] }] },
    };
    await writeFile(join(claudeDir, "settings.json"), JSON.stringify(settings), { mode: 0o600 });

    const common = [
      "--print", "--output-format", "json", "--max-budget-usd", String(config.budgetGuardUsd),
      "--strict-mcp-config", "--disable-slash-commands", "--permission-mode", "default",
      "--no-session-persistence", "--tools", "", "--allowedTools", "",
    ];
    const control = await runner(config.claudeExecutable, common, {
      ...processOptions(directory, config, signal), stdin: "Reply with exactly OK.",
    });
    if (!validResponse(control) || !(await exists(marker))) {
      throw new ClaudeGateError("Control run did not complete with the project hook firing; the gate remains closed.");
    }
    await unlink(marker);
    const isolated = await runner(config.claudeExecutable, [...common, "--setting-sources", ""], {
      ...processOptions(directory, config, signal), stdin: "Reply with exactly OK.",
    });
    if (!validResponse(isolated) || await exists(marker)) {
      throw new ClaudeGateError("The isolated run failed or a project hook still fired; the gate remains closed.");
    }
    if (await readVersion(config, runner) !== version) {
      throw new ClaudeGateError("Claude CLI version changed during the gate test.");
    }
    return { version, passedAt: new Date().toISOString(), passed: true };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function processOptions(cwd: string, config: OrchestratorConfig, signal: AbortSignal): ProcessOptions {
  return {
    cwd,
    timeoutMs: Math.min(config.providerTimeoutMinutes * 60_000, 120_000),
    gracePeriodMs: config.terminationGracePeriodMs,
    maxOutputBytes: 1_048_576,
    signal,
  };
}

async function readVersion(config: OrchestratorConfig, runner: Runner): Promise<string | undefined> {
  const result = await runner(config.claudeExecutable, ["--version"], {
    cwd: process.cwd(), timeoutMs: 10_000, maxOutputBytes: 32_768,
    gracePeriodMs: config.terminationGracePeriodMs,
  });
  return result.exitCode === 0 ? result.stdout.trim().split(/\r?\n/, 1)[0] : undefined;
}

function validResponse(result: ProcessResult): boolean {
  if (result.exitCode !== 0) return false;
  try {
    const response: unknown = JSON.parse(result.stdout);
    return typeof response === "object" && response !== null && "is_error" in response && response.is_error === false;
  } catch {
    return false;
  }
}

async function exists(path: string): Promise<boolean> {
  try { await access(path); return true; } catch { return false; }
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}
