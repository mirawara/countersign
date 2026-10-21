import { describe, expect, it } from "vitest";
import { detailedWorkflowReport, summarizeWorkflow } from "../src/orchestrator/report";
import { WorkflowResult } from "../src/shared/types";

describe("workflow summary privacy", () => {
  it("keeps task text, diff, review evidence and check output out of the Output Channel summary", () => {
    const result: WorkflowResult = {
      taskId: "test-id", state: "completed_with_findings", repository: "/repo",
      task: "SECRET_TASK_PROMPT", startedAt: "now", finishedAt: "later",
      diff: "SECRET_DIFF_CONTENT", reviewSummary: "SECRET_REVIEW_SUMMARY",
      findings: [{ severity: "High", file: "src/a.ts", line: 1, evidence: "SECRET_EVIDENCE", summary: "Bug" }],
      checks: [{ id: "lint", passed: false, exitCode: 1, output: "SECRET_CHECK_OUTPUT", timedOut: false }],
      workingTreeEntries: [" M src/a.ts"], message: "SECRET_PROVIDER_MESSAGE",
      mock: false, implementationProvider: "claude", reviewProvider: "real", metrics: [],
    };
    const summary = summarizeWorkflow(result);
    expect(summary).toContain("Findings: 1");
    for (const secret of ["SECRET_TASK_PROMPT", "SECRET_DIFF_CONTENT", "SECRET_REVIEW_SUMMARY", "SECRET_EVIDENCE", "SECRET_CHECK_OUTPUT", "SECRET_PROVIDER_MESSAGE"]) {
      expect(summary).not.toContain(secret);
    }
    const inChat = detailedWorkflowReport({ ...result, plan: "Approved plan", implementationSummary: "Edited src/a.ts",
      clarifications: [{ phase: "planning", question: "Which API?", answer: "Local" }] });
    expect(inChat).toContain("Approved plan");
    expect(inChat).toContain("SECRET_TASK_PROMPT");
    expect(inChat).toContain("SECRET_REVIEW_SUMMARY");
    expect(inChat).toContain("SECRET_EVIDENCE");
    expect(inChat).toContain("SECRET_CHECK_OUTPUT");
    expect(inChat).toContain("Which API?");
    expect(inChat).not.toContain("SECRET_DIFF_CONTENT");
  });
});
