import { describe, expect, it } from "vitest";
import { validateConfiguration } from "../src/configuration/config";

describe("configuration", () => {
  it("uses the documented severity and process termination defaults", () => {
    const config = validateConfiguration({});
    expect(config.codexProvider).toBe("mock");
    expect(config.codexExecutable).toBe("codex");
    expect(config.findingThreshold).toBe("High");
    expect(config.terminationGracePeriodMs).toBe(1000);
    expect(config.localChecks).toEqual([]);
  });

  it("accepts a configured finding threshold and grace period", () => {
    const config = validateConfiguration({ findingThreshold: "Critical", terminationGracePeriodMs: 2500 });
    expect(config.findingThreshold).toBe("Critical");
    expect(config.terminationGracePeriodMs).toBe(2500);
  });

  it("accepts the real Codex review setting and rejects an empty executable", () => {
    const config = validateConfiguration({ codexProvider: "real", codexExecutable: "/usr/local/bin/codex" });
    expect(config.codexProvider).toBe("real");
    expect(config.codexExecutable).toBe("/usr/local/bin/codex");
    expect(() => validateConfiguration({ codexExecutable: "  " })).toThrow(/codexExecutable/);
  });

  it("validates independent model and effort selections for Balanced", () => {
    const config = validateConfiguration({ provider: "claude", codexProvider: "real",
      claudeModel: "sonnet", claudeEffort: "high", codexModel: "gpt-5.3-codex", codexEffort: "xhigh" });
    expect([config.claudeModel, config.claudeEffort, config.codexModel, config.codexEffort])
      .toEqual(["sonnet", "high", "gpt-5.3-codex", "xhigh"]);
    expect(() => validateConfiguration({ claudeEffort: "high" })).toThrow(/Choose a Claude model/);
    expect(() => validateConfiguration({ codexModel: "model", codexEffort: "unsupported" })).toThrow(/codexEffort/);
    expect(() => validateConfiguration({ claudeModel: "bad\nmodel" })).toThrow(/claudeModel/);
  });

  it("rejects unsupported finding severities", () => {
    expect(() => validateConfiguration({ findingThreshold: "Urgent" })).toThrow(/findingThreshold/);
  });

  it("rejects Bash and unrecognized Claude tools", () => {
    expect(() => validateConfiguration({ claudeAllowedTools: ["Read", "Bash"] })).toThrow(/allowlist/);
    expect(() => validateConfiguration({ claudeAllowedTools: ["Read", "UnknownTool"] })).toThrow(/allowlist/);
  });

  it("rejects duplicate local check ids and invalid grace periods", () => {
    const checks = [
      { id: "lint", executable: "node", args: ["-v"] },
      { id: "lint", executable: "node", args: ["-v"] },
    ];
    expect(() => validateConfiguration({ localChecks: checks })).toThrow(/Duplicate local check id/);
    expect(() => validateConfiguration({ terminationGracePeriodMs: 50 })).toThrow(/between 100 and 10000/);
  });
});
