import { AgentRequest, AgentResult, AIProvider, Finding, MockScenario, ProviderStatus } from "../shared/types";

type MockRole = "implementation" | "review";

export class MockProvider implements AIProvider {
  readonly id: string;

  constructor(private readonly role: MockRole, private readonly scenario: MockScenario) {
    this.id = `${role}-mock`;
  }

  async checkAvailability(): Promise<ProviderStatus> {
    return { available: true, version: "mock" };
  }

  async execute(request: AgentRequest): Promise<AgentResult> {
    await waitBriefly(request.signal);
    if (request.signal.aborted) {
      throw new Error("Mock workflow cancelled.");
    }

    if (this.scenario === "error" && request.mode === "implement") {
      throw new Error("Configured mock scenario returned an implementation error.");
    }

    if (this.role === "implementation") {
      return this.implement(request);
    }
    return this.review(request);
  }

  async cancel(_taskId: string): Promise<void> {
    // Cancellation is propagated through the request's AbortSignal.
  }

  private implement(request: AgentRequest): AgentResult {
    if (request.mode === "implement" && this.scenario === "noChanges") {
      return {
        changed: false,
        findings: [],
        message: "The mock implementation produced no changes.",
      };
    }

    if (request.mode === "correct") {
      const candidates = request.findings ?? [];
      return {
        changed: candidates.length > 0,
        changedPaths: candidates.map((finding) => finding.file),
        simulatedDiff: "Mock correction applied in memory; no repository file was changed.",
        findings: [],
        correction: {
          confirmed: candidates,
          fixed: candidates,
          remaining: [],
        },
        message: `Mock Claude confirmed and simulated a correction for ${candidates.length} finding(s).`,
      };
    }

    return {
      changed: true,
      changedPaths: ["src/example.ts"],
      simulatedDiff: [
        "--- a/src/example.ts",
        "+++ b/src/example.ts",
        "@@ mock-only @@",
        "+// Simulated implementation output. This is not written to disk.",
      ].join("\n"),
      findings: [],
      message: `Mock Claude simulated an implementation for: ${request.task}`,
    };
  }

  private review(request: AgentRequest): AgentResult {
    if (request.mode !== "review") {
      throw new Error("Mock Codex received an unsupported workflow mode.");
    }

    const findings: Finding[] = this.scenario === "finding"
      ? [{
          severity: "High",
          file: "src/example.ts",
          line: 1,
          evidence: "Synthetic evidence from the configured finding scenario.",
          summary: "Example simulated finding for exercising the one-correction path.",
        }]
      : [];

    return {
      changed: false,
      findings,
      message: findings.length === 0
        ? "Mock Codex returned a clean review."
        : `Mock Codex returned ${findings.length} synthetic finding(s).`,
    };
  }
}

function waitBriefly(signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error("Mock workflow cancelled."));
      return;
    }
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, 120);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      reject(new Error("Mock workflow cancelled."));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}
