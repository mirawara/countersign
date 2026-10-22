import { WorkflowResult } from "../shared/types";

export function summarizeWorkflow(result: WorkflowResult): string {
  return [
    "--- Workflow summary ---",
    `Task ID: ${result.taskId}`,
    `State: ${result.state}`,
    `Workspace: ${result.repository} (${result.changeSource === "git" ? "Git" : "file snapshot"})`,
    `Started: ${result.startedAt}`,
    `Finished: ${result.finishedAt}`,
    `Mode: ${result.implementationProvider} implementation + ${result.reviewProvider} review${result.mock ? " (no AI request)" : ""}`,
    "Result details: available with Countersign: Show Workflow Status",
    `Review summary: ${result.reviewSummary ? "available with Countersign: Show Review Details" : "none"}`,
    `Configured check results: ${result.checks.length === 0 ? "none" : result.checks.map((check) => `${check.id}=${check.passed ? "passed" : "failed"}${check.timedOut ? " (timed out)" : ""}`).join(", ")}`,
    `Findings: ${result.findings.length}`,
    `Working tree before execution: ${result.startingWorkingTreeEntries?.length ?? 0} change(s).`,
    `Working tree after checks: ${result.workingTreeEntries.length === 0 ? "no reviewable changes" : `${result.workingTreeEntries.length} change(s)`}. ${result.changeSource === "git" ? "Git-ignored files are not covered." : "Generated directories are excluded."}`,
    `Diff: ${result.diff || result.simulatedDiff ? "available with Countersign: Show Workflow Diff" : "none"}`,
    `Review evidence: ${result.findings.length > 0 ? "available with Countersign: Show Review Details" : "none"}`,
    `Check output: ${result.checks.length > 0 ? "available with Countersign: Show Check Results" : "none"}`,
    `Provider metrics: ${result.metrics.length === 0 ? "not reported" : result.metrics.map((entry) => `${entry.provider}: estimated cost ${entry.estimatedCostUsd ?? "unavailable"} USD, input tokens ${entry.inputTokens ?? "unavailable"}, output tokens ${entry.outputTokens ?? "unavailable"}`).join("; ")}`,
  ].join("\n");
}

/** Stored in the user's workspace chat history; never written to the Output Channel. */
export function detailedWorkflowReport(result: WorkflowResult): string {
  const lines = [
    `# Balanced workflow report`,
    `Status: ${result.state}`,
    `Outcome: ${result.message}`,
    `Task: ${result.task}`,
    `Started: ${result.startedAt}`,
    `Finished: ${result.finishedAt}`,
    `Workspace: ${result.repository} (${result.changeSource === "git" ? "Git" : "file snapshot"})`,
    `Agents: ${result.implementationProvider} implementation, ${result.reviewProvider} review`,
    `After plan approval: ${result.executionPermission === "fullAccess" ? "Full access" : "Ask before change"}`,
    result.selectedModels ? `Requested models: Claude ${result.selectedModels.claudeModel || "CLI default"} (effort ${result.selectedModels.claudeEffort || "CLI default"}); Codex ${result.selectedModels.codexModel || "CLI default"} (reasoning ${result.selectedModels.codexEffort || "CLI default"}). The workflow CLIs do not report an effective model back to this report.` : "",
    "",
    "## Timeline",
    ...(result.events?.length ? result.events.map((event) => `- ${event.timestamp} — ${event.state}: ${event.message}`)
      : ["No stage events were recorded."]),
    "",
    "## Approved plan",
    result.plan || "No AI plan was recorded.",
    "",
    "## Decisions and answers",
    ...(result.clarifications?.length ? result.clarifications.flatMap((item, index) => [
      `${index + 1}. ${item.phase}: ${item.question}`,
      `   Answer: ${item.answer}`,
    ]) : ["No clarification questions were needed."]),
    "",
    "## Implementation",
    result.implementationSummary || "No implementation summary was returned.",
    "",
    "## Changes already present before this workflow",
    ...(result.startingWorkingTreeEntries?.length
      ? result.startingWorkingTreeEntries.map((entry) => `- ${entry}`)
      : [result.changeSource === "snapshot" ? "No version-control status is available for the initial files." : "None recorded."]),
    "",
    "## Final working tree",
    result.changeSource === "git"
      ? "The final diff is against HEAD. The initial Git status above was clean."
      : result.changeSource === "git-snapshot"
      ? "The final diff compares reviewable workspace files with the snapshot taken before this workflow. Earlier Git entries are listed above and are excluded from this diff."
      : "The final diff compares reviewable workspace files with the snapshot taken before this workflow. No Git repository root is open for this folder, so earlier work cannot be listed as changed or reverted by Countersign.",
    ...(result.workingTreeEntries.length ? result.workingTreeEntries.slice(0, 100).map((entry) => `- ${entry}`)
      : ["No working tree changes recorded."]),
    ...(result.workingTreeEntries.length > 100 ? [`…and ${result.workingTreeEntries.length - 100} more entries. Use Show Workflow Diff for the full diff.`] : []),
    result.diff || result.simulatedDiff ? "Open **Show diff** on this report to inspect the saved patch." : "No diff is available.",
    "",
    "## Local checks",
    ...(result.checks.length ? result.checks.map((check) => {
      const configured = result.configuredChecks?.find((item) => item.id === check.id);
      const command = configured ? `; command: ${configured.executable} ${configured.args.join(" ")}` : "";
      return `- ${check.id}: ${check.passed ? "passed" : "failed"}; exit ${check.exitCode ?? "unavailable"}${check.timedOut ? "; timed out" : ""}${command}${check.output ? `; output: ${check.output.slice(0, 600).replace(/\s+/g, " ")}${check.output.length > 600 ? "…" : ""}` : ""}`;
    })
      : ["No local checks were configured."]),
    "",
    "## Codex review",
    result.reviewSummary || "No review summary was returned.",
    ...(result.findings.length ? result.findings.slice(0, 50).flatMap((finding, index) => [
      `${index + 1}. ${finding.severity} — ${finding.file}:${finding.line} — ${finding.summary.slice(0, 500)}`,
      `   Evidence: ${finding.evidence.slice(0, 1_000)}${finding.evidence.length > 1_000 ? "…" : ""}`,
    ]) : ["No findings reported."]),
    ...(result.findings.length > 50 ? [`…and ${result.findings.length - 50} more findings. Use Show Review Details.`] : []),
    "",
    "## Correction",
    result.correctionSummary || "No correction pass was run.",
    result.correctionSummary ? "The Balanced workflow does not run a second Codex review after correction." : "",
    "",
    "## Provider usage",
    ...(result.metrics.length ? result.metrics.map((item) => `- ${item.provider}: ${item.inputTokens ?? "?"} input tokens, ${item.outputTokens ?? "?"} output tokens; ${item.estimatedCostUsd ?? "unavailable"} USD API price estimate`)
      : ["Usage was not reported."]),
    "",
    `${result.changeSource === "git" ? "The Git diff" : "The file snapshot"} covers reviewable changes in this workspace only. ${result.changeSource === "git" ? "Git-ignored files" : "Generated directories"}, external files, commands and network actions are not independently audited by this report. USD figures are provider estimates, not subscription charges.`,
  ];
  return lines.filter((line) => line !== undefined).join("\n").slice(0, 98_000);
}
