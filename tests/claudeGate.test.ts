import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { validateConfiguration } from "../src/configuration/config";
import { verifyClaudeSettingsGate } from "../src/providers/claudeGate";
import { ProcessResult } from "../src/shared/process";

const config = validateConfiguration({ provider: "claude", codexProvider: "real" });
const HELP = "--print --output-format --json-schema --setting-sources --strict-mcp-config --plugin-dir --disable-slash-commands --tools --allowedTools --permission-mode --no-session-persistence";

describe("Claude settings-source gate", () => {
  it("records a version only when the control hook fires and the empty source suppresses it", async () => {
    const turns: string[][] = [];
    const record = await verifyClaudeSettingsGate(config, new AbortController().signal, async (_executable, args, options) => {
      if (args[0] === "--version") return result("2.1.109 (Claude Code)\n");
      if (args[0] === "--help") return result(HELP);
      turns.push(args);
      if (!args.includes("--setting-sources")) await writeFile(join(options.cwd, "hook-fired"), "fired");
      return result(JSON.stringify({ is_error: false,
        result: args.includes("--disable-slash-commands")
          ? "Unknown command: /countersign-gate:countersign-gate (skills disabled)" : "CAVEMAN_GATE_OK" }));
    });
    expect(record.version).toBe("2.1.109 (Claude Code)");
    expect(record.passed).toBe(true);
    expect(record.policyRevision).toBe(4);
    expect(turns).toHaveLength(2);
    for (const args of turns) {
      expect(args).toContain("--plugin-dir");
    }
    expect(turns[0]).not.toContain("--disable-slash-commands");
    expect(turns[1]).toContain("--disable-slash-commands");
  });

  it("keeps the gate closed if the control hook does not fire", async () => {
    await expect(verifyClaudeSettingsGate(config, new AbortController().signal, async (_executable, args) => {
      if (args[0] === "--version") return result("2.1.109 (Claude Code)\n");
      if (args[0] === "--help") return result(HELP);
      return result('{"is_error":false,"result":"OK"}');
    })).rejects.toThrow(/Control run/);
  });

  it("keeps the gate closed when the CLI accepts a plugin directory but never loads its skill", async () => {
    await expect(verifyClaudeSettingsGate(config, new AbortController().signal, async (_executable, args, options) => {
      if (args[0] === "--version") return result("2.1.109 (Claude Code)\n");
      if (args[0] === "--help") return result(HELP);
      await writeFile(join(options.cwd, "hook-fired"), "fired");
      return result('{"is_error":false,"result":"Unknown command: /countersign-gate:countersign-gate"}');
    })).rejects.toThrow(/did not load the probe skill/);
  });

  it("keeps the gate closed when skills remain callable in the isolated turn", async () => {
    await expect(verifyClaudeSettingsGate(config, new AbortController().signal, async (_executable, args, options) => {
      if (args[0] === "--version") return result("2.1.109 (Claude Code)\n");
      if (args[0] === "--help") return result(HELP);
      if (!args.includes("--setting-sources")) await writeFile(join(options.cwd, "hook-fired"), "fired");
      return result('{"is_error":false,"result":"CAVEMAN_GATE_OK"}');
    })).rejects.toThrow(/did not disable skills/);
  });
});

function result(stdout: string): ProcessResult { return { exitCode: 0, stdout, stderr: "" }; }
