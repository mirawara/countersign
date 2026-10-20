import { WorkflowResult } from "../shared/types";

export function summarizeWorkflow(result: WorkflowResult): string {
  return [
    "--- Workflow summary ---",
    `Task ID: ${result.taskId}`,
    `State: ${result.state}`,
    `Repository: ${result.repository}`,
    `Started: ${result.startedAt}`,
    `Finished: ${result.finishedAt}`,
    `Mode: ${result.implementationProvider} implementation + ${result.reviewProvider} review${result.mock ? " (no AI request)" : ""}`,
    "Result details: available with AI Dev Orchestrator: Show Workflow Status",
    `Review summary: ${result.reviewSummary ? "available with AI Dev Orchestrator: Show Review Details" : "none"}`,
    `Configured check results: ${result.checks.length === 0 ? "none" : result.checks.map((check) => `${check.id}=${check.passed ? "passed" : "failed"}${check.timedOut ? " (timed out)" : ""}`).join(", ")}`,
    `Findings: ${result.findings.length}`,
    `Working tree after checks: ${result.workingTreeEntries.length === 0 ? "no tracked or untracked changes" : `${result.workingTreeEntries.length} change(s)`}. Git-ignored files are not covered.`,
    `Diff: ${result.diff || result.simulatedDiff ? "available with AI Dev Orchestrator: Show Workflow Diff" : "none"}`,
    `Review evidence: ${result.findings.length > 0 ? "available with AI Dev Orchestrator: Show Review Details" : "none"}`,
    `Check output: ${result.checks.length > 0 ? "available with AI Dev Orchestrator: Show Check Results" : "none"}`,
    `Provider metrics: ${result.metrics.length === 0 ? "not reported" : result.metrics.map((entry) => `${entry.provider}: estimated cost ${entry.estimatedCostUsd ?? "unavailable"} USD, input tokens ${entry.inputTokens ?? "unavailable"}, output tokens ${entry.outputTokens ?? "unavailable"}`).join("; ")}`,
  ].join("\n");
}
