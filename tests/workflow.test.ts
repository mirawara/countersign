import { afterEach, describe, expect, it } from "vitest";
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { validateConfiguration } from "../src/configuration/config";
import { runMockWorkflow, eligibleFindings } from "../src/orchestrator/workflow";
import { assertWorkflowTransition, isTerminalState } from "../src/orchestrator/stateMachine";
import { CodexProviderError } from "../src/providers/codexCliProvider";
import { MockProvider } from "../src/providers/mockProvider";
import { AgentRequest, AgentResult, AIProvider, Finding, ProviderStatus, WorkflowEvent, WorkflowState } from "../src/shared/types";
import { createCleanGitRepository, removeRepository } from "./helpers/git";

const repositories: string[] = [];

afterEach(async () => {
  await Promise.all(repositories.splice(0).map(removeRepository));
});

describe("mock BALANCED workflow", () => {
  it("completes the clean scenario without findings", async () => {
    const result = await runScenario("clean");
    expect(result.state).toBe("completed_clean");
    expect(result.findings).toEqual([]);
    expect(result.reviewSummary).toBe("Mock Codex returned a clean review.");
    expect(result.mock).toBe(true);
  });

  it("completes the single-correction scenario through its terminal transition", async () => {
    const events: WorkflowEvent[] = [];
    const result = await runScenario("finding", undefined, events);
    expect(events.map((event) => event.state)).toEqual([
      "implementing",
      "running_checks",
      "reviewing",
      "correcting",
      "running_checks",
      "completed_clean",
    ]);
    expect(result.state).toBe("completed_clean");
    expect(result.findings).toEqual([]);
  });

  it("retains a reported finding outside the changed paths", async () => {
    const outsideFinding = finding({ severity: "Critical", file: "secrets/credential.ts" });
    const result = await runScenario("clean", new FixedReviewProvider([outsideFinding]));
    expect(result.state).toBe("completed_with_findings");
    expect(result.findings).toEqual([outsideFinding]);
  });

  it("keeps ineligible findings when another finding is corrected", async () => {
    const outsideFinding = finding({ severity: "Critical", file: "secrets/credential.ts" });
    const insideFinding = finding({ severity: "High", file: "src/example.ts" });
    const result = await runScenario("clean", new FixedReviewProvider([insideFinding, outsideFinding]));
    expect(result.state).toBe("completed_with_findings");
    expect(result.findings).toEqual([outsideFinding]);
  });

  it("returns no_changes when the mock implementation is unchanged", async () => {
    const result = await runScenario("noChanges", undefined, [], "real");
    expect(result.state).toBe("no_changes");
    expect(result.mock).toBe(true);
  });

  it("returns failed when the mock implementation errors", async () => {
    expect((await runScenario("error")).state).toBe("failed");
  });

  it("maps Codex authentication failure to blocked_auth_or_quota", async () => {
    const result = await runScenario("clean", new AuthenticationErrorProvider(), [], "real");
    expect(result.state).toBe("blocked_auth_or_quota");
    expect(result.mock).toBe(false);
  });

  it("keeps real Codex review read-only and reports findings without mock correction", async () => {
    const implementation = new RecordingImplementationProvider();
    const findingFromReview = finding({ severity: "Critical" });
    const result = await runScenario(
      "clean",
      new FixedReviewProvider([findingFromReview]),
      [],
      "real",
      implementation,
    );

    expect(result.state).toBe("completed_with_findings");
    expect(result.findings).toEqual([findingFromReview]);
    expect(result.mock).toBe(false);
    expect(implementation.modes).toEqual(["implement"]);
  });

  it("records repository changes made by an explicitly configured local check", async () => {
    const repository = await createCleanGitRepository();
    repositories.push(repository);
    const config = validateConfiguration({
      localChecks: [{
        id: "write-output",
        executable: process.execPath,
        args: ["-e", "require('node:fs').writeFileSync('check-output.txt','ok')"],
      }],
    });
    const controller = new AbortController();
    const result = await runMockWorkflow({
      repository,
      task: "verify check status recording",
      config,
      claude: new MockProvider("implementation", "clean"),
      codex: new MockProvider("review", "clean"),
      signal: controller.signal,
      onEvent: () => undefined,
    });
    expect(result.workingTreeEntries).toContain("?? check-output.txt");
    expect(result.state).toBe("validation_failed");
  });

  it("reviews the actual diff, including files written by local checks", async () => {
    const repository = await createCleanGitRepository();
    repositories.push(repository);
    const config = validateConfiguration({
      provider: "claude", codexProvider: "real",
      localChecks: [{ id: "generate", executable: process.execPath, args: ["-e", "require('node:fs').writeFileSync('generated.txt','generated\\n')"] }],
    });
    let reviewedDiff = "";
    const result = await runMockWorkflow({
      repository, task: "write a feature", config,
      claude: new DiskImplementationProvider(),
      codex: new CapturingReviewProvider((diff) => { reviewedDiff = diff; }),
      signal: new AbortController().signal,
      onEvent: () => undefined,
      askPermission: async (tool) => tool === "Local check: generate",
    });
    expect(result.state).toBe("completed_clean");
    expect(reviewedDiff).toContain("+export const feature = true;");
    expect(reviewedDiff).toContain("+generated");
    expect(result.diff).toBe(reviewedDiff);
  });

  it("does not run a local check declined in Ask before change", async () => {
    const repository = await createCleanGitRepository();
    repositories.push(repository);
    const config = validateConfiguration({ provider: "claude", codexProvider: "real",
      localChecks: [{ id: "generate", executable: process.execPath,
        args: ["-e", "require('node:fs').writeFileSync('generated.txt','generated')"] }] });
    const result = await runMockWorkflow({ repository, task: "write a feature", config,
      claude: new DiskImplementationProvider(), codex: new CapturingReviewProvider(() => undefined),
      signal: new AbortController().signal, onEvent: () => undefined,
      askPermission: async () => false });
    expect(result.state).toBe("blocked_permissions");
    await expect(readFile(join(repository, "generated.txt"), "utf8")).rejects.toThrow();
  });

  it("re-runs checks even when findings remain after a correction", async () => {
    const repository = await createCleanGitRepository();
    repositories.push(repository);
    const counter = join(repository, ".git", "check-count");
    const config = validateConfiguration({
      localChecks: [{
        id: "count", executable: process.execPath,
        args: ["-e", `const f=${JSON.stringify(counter)};const fs=require('node:fs');fs.writeFileSync(f,String(Number(fs.existsSync(f)?fs.readFileSync(f,'utf8'):0)+1))`],
      }],
    });
    const result = await runMockWorkflow({
      repository, task: "exercise correction", config,
      claude: new RemainingFindingProvider(),
      codex: new FixedReviewProvider([finding()]),
      signal: new AbortController().signal,
      onEvent: () => undefined,
    });
    expect(result.state).toBe("completed_with_findings");
    expect(result.checks).toHaveLength(2);
    expect(await readFile(counter, "utf8")).toBe("2");
  });

  it("pauses for an implementation question and resumes with the answer before editing", async () => {
    const repository = await createCleanGitRepository();
    repositories.push(repository);
    const events: WorkflowState[] = [];
    let calls = 0;
    const claude: AIProvider = {
      id: "questioning-claude",
      checkAvailability: async () => ({ available: true }),
      execute: async (request) => {
        calls += 1;
        if (calls === 1) return { changed: false, findings: [], message: "Need a decision.", question: "Which format?" };
        expect(request.clarifications).toEqual([{ question: "Which format?", answer: "JSON" }]);
        await writeFile(join(repository, "feature.ts"), "export const format = 'JSON';\n");
        return { changed: true, changedPaths: ["feature.ts"], findings: [], message: "Implemented JSON format." };
      },
      cancel: async () => undefined,
    };
    const result = await runMockWorkflow({ repository, task: "Add a format", plan: "Use the selected format.",
      config: validateConfiguration({ provider: "claude", codexProvider: "real" }), claude,
      codex: new CapturingReviewProvider(() => undefined), signal: new AbortController().signal,
      onEvent: (event) => events.push(event.state),
      askQuestion: async (phase, question) => {
        expect(phase).toBe("implementing");
        expect(question).toBe("Which format?");
        await expect(readFile(join(repository, "feature.ts"), "utf8")).rejects.toThrow();
        return "JSON";
      },
    });
    expect(result.state).toBe("completed_clean");
    expect(events).toContain("awaiting_input");
    expect(result.implementationSummary).toBe("Implemented JSON format.");
    expect(result.clarifications).toEqual([{ phase: "implementing", question: "Which format?", answer: "JSON" }]);
  });

  it("keeps partial edits across a question and passes their diff to the next Claude turn", async () => {
    const repository = await createCleanGitRepository();
    repositories.push(repository);
    let calls = 0;
    const claude: AIProvider = {
      id: "partial-edit-claude",
      checkAvailability: async () => ({ available: true }),
      execute: async (request) => {
        calls += 1;
        if (calls === 1) {
          await writeFile(join(repository, "feature.ts"), "export const state = 'partial';\n");
          return { changed: true, findings: [], message: "Started implementation.", question: "Which suffix?" };
        }
        expect(request.diff).toContain("partial");
        expect(request.clarifications?.[0].answer).toBe("complete");
        await writeFile(join(repository, "feature.ts"), "export const state = 'complete';\n");
        return { changed: true, findings: [], message: "Completed implementation." };
      },
      cancel: async () => undefined,
    };
    const result = await runMockWorkflow({ repository, task: "Implement a feature",
      config: validateConfiguration({ provider: "claude", codexProvider: "real" }), claude,
      codex: new CapturingReviewProvider(() => undefined), signal: new AbortController().signal,
      onEvent: () => undefined, askQuestion: async () => "complete" });
    expect(result.state).toBe("completed_clean");
    expect(result.diff).toContain("complete");
    expect(calls).toBe(2);
  });

  it("filters runtime finding severities against the configured threshold", () => {
    const findings = [
      finding({ severity: "Critical" }),
      finding({ severity: "High", line: 2 }),
      finding({ severity: "Medium", line: 3 }),
      finding({ severity: "Low", line: 4 }),
    ];
    expect(eligibleFindings(findings, ["src/example.ts"], "High").map((item) => item.severity))
      .toEqual(["Critical", "High"]);
    expect(eligibleFindings(findings, ["src/example.ts"], "Medium").map((item) => item.severity))
      .toEqual(["Critical", "High", "Medium"]);
  });

  it("allows the correction path to end cleanly after checks", () => {
    expect(() => assertWorkflowTransition("running_checks", "completed_clean")).not.toThrow();
    expect(() => assertWorkflowTransition("running_checks", "completed_with_findings")).not.toThrow();
  });

  it("marks all declared final outcomes as terminal", () => {
    const terminalStates: WorkflowState[] = [
      "completed_clean", "completed_with_findings", "no_changes", "validation_failed",
      "blocked_untrusted_workspace", "blocked_provider",
      "blocked_permissions", "blocked_auth_or_quota", "review_failed", "cancelled", "timed_out", "failed",
    ];
    for (const state of terminalStates) expect(isTerminalState(state), state).toBe(true);
  });
});

async function runScenario(
  scenario: "clean" | "finding" | "noChanges" | "error",
  codex?: AIProvider,
  events: WorkflowEvent[] = [],
  codexProvider: "mock" | "real" = "mock",
  claude?: AIProvider,
): Promise<Awaited<ReturnType<typeof runMockWorkflow>>> {
  const repository = await createCleanGitRepository();
  repositories.push(repository);
  const config = validateConfiguration({ provider: "mock", mockScenario: scenario, codexProvider });
  const controller = new AbortController();
  return runMockWorkflow({
    repository,
    task: "exercise mock workflow",
    config,
    claude: claude ?? new MockProvider("implementation", scenario),
    codex: codex ?? new MockProvider("review", scenario),
    signal: controller.signal,
    onEvent: (event) => events.push(event),
  });
}

class AuthenticationErrorProvider implements AIProvider {
  readonly id = "codex-cli-test";

  async checkAvailability(): Promise<ProviderStatus> {
    return { available: true };
  }

  async execute(_request: AgentRequest): Promise<AgentResult> {
    throw new CodexProviderError("authentication", "Codex authentication is unavailable.");
  }

  async cancel(_taskId: string): Promise<void> {}
}

class RecordingImplementationProvider implements AIProvider {
  readonly id = "recording-implementation";
  readonly modes: string[] = [];
  private readonly provider = new MockProvider("implementation", "clean");

  async checkAvailability(): Promise<ProviderStatus> {
    return this.provider.checkAvailability();
  }

  async execute(request: AgentRequest): Promise<AgentResult> {
    this.modes.push(request.mode);
    return this.provider.execute(request);
  }

  async cancel(taskId: string): Promise<void> {
    await this.provider.cancel(taskId);
  }
}

class FixedReviewProvider implements AIProvider {
  readonly id = "fixed-review";

  constructor(private readonly findings: Finding[]) {}

  async checkAvailability(): Promise<ProviderStatus> {
    return { available: true };
  }

  async execute(_request: AgentRequest): Promise<AgentResult> {
    return { changed: false, findings: this.findings, message: "Fixed review result." };
  }

  async cancel(_taskId: string): Promise<void> {}
}

class DiskImplementationProvider implements AIProvider {
  readonly id = "disk-implementation-test";
  async checkAvailability(): Promise<ProviderStatus> { return { available: true }; }
  async execute(request: AgentRequest): Promise<AgentResult> {
    await writeFile(join(request.repository, "feature.ts"), "export const feature = true;\n");
    return { changed: true, changedPaths: ["feature.ts"], findings: [], message: "Implemented." };
  }
  async cancel(_taskId: string): Promise<void> {}
}

class CapturingReviewProvider implements AIProvider {
  readonly id = "capturing-review-test";
  constructor(private readonly record: (diff: string) => void) {}
  async checkAvailability(): Promise<ProviderStatus> { return { available: true }; }
  async execute(request: AgentRequest): Promise<AgentResult> {
    this.record(request.diff ?? "");
    return { changed: false, findings: [], message: "Reviewed actual changes." };
  }
  async cancel(_taskId: string): Promise<void> {}
}

class RemainingFindingProvider implements AIProvider {
  readonly id = "remaining-finding-test";
  private readonly mock = new MockProvider("implementation", "clean");
  async checkAvailability(): Promise<ProviderStatus> { return { available: true }; }
  async execute(request: AgentRequest): Promise<AgentResult> {
    if (request.mode !== "correct") return this.mock.execute(request);
    const candidates = request.findings ?? [];
    return {
      changed: false, findings: [], message: "Finding remains.",
      correction: { confirmed: candidates, fixed: [], remaining: candidates },
    };
  }
  async cancel(_taskId: string): Promise<void> {}
}

function finding(overrides: Partial<Finding> = {}): Finding {
  return {
    severity: "High",
    file: "src/example.ts",
    line: 1,
    evidence: "Concrete synthetic evidence.",
    summary: "Synthetic finding.",
    ...overrides,
  };
}
