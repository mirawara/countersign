import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { validateConfiguration } from "../src/configuration/config";
import { verifyClaudeSettingsGate } from "../src/providers/claudeGate";
import { ProcessResult } from "../src/shared/process";

const config = validateConfiguration({ provider: "claude", codexProvider: "real" });
const HELP = "--print --output-format --json-schema --setting-sources --strict-mcp-config --disable-slash-commands --tools --allowedTools --permission-mode --no-session-persistence";

describe("Claude settings-source gate", () => {
  it("records a version only when the control hook fires and the empty source suppresses it", async () => {
    const record = await verifyClaudeSettingsGate(config, new AbortController().signal, async (_executable, args, options) => {
      if (args[0] === "--version") return result("2.1.109 (Claude Code)\n");
      if (args[0] === "--help") return result(HELP);
      if (!args.includes("--setting-sources")) await writeFile(join(options.cwd, "hook-fired"), "fired");
      return result('{"is_error":false,"result":"OK"}');
    });
    expect(record.version).toBe("2.1.109 (Claude Code)");
    expect(record.passed).toBe(true);
  });

  it("keeps the gate closed if the control hook does not fire", async () => {
    await expect(verifyClaudeSettingsGate(config, new AbortController().signal, async (_executable, args) => {
      if (args[0] === "--version") return result("2.1.109 (Claude Code)\n");
      if (args[0] === "--help") return result(HELP);
      return result('{"is_error":false,"result":"OK"}');
    })).rejects.toThrow(/Control run/);
  });
});

function result(stdout: string): ProcessResult { return { exitCode: 0, stdout, stderr: "" }; }
