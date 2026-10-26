import { StrictWorkflowResult } from "../shared/strict";
import { strictLimitUnit } from "../shared/strictLimits";
import { BalancedWorkflowResult, WorkflowResult } from "../shared/types";

const SNAPSHOT_EXCLUDED_DIRS = "node_modules, dist, build, coverage, .cache, .venv and target";

export function summarizeWorkflow(result: WorkflowResult): string {
  return result.mode === "strict" ? summarizeStrictWorkflow(result) : summarizeBalancedWorkflow(result);
}

/** Stored in the user's workspace chat history; never written to the Output Channel. */
export function detailedWorkflowReport(result: WorkflowResult): string {
  return result.mode === "strict" ? detailedStrictReport(result) : detailedBalancedReport(result);
}

function summarizeBalancedWorkflow(result: BalancedWorkflowResult): string {
  return [
    "--- Workflow summary ---",
    `Task ID: ${result.taskId}`,
    `State: ${result.state}`,
    `Workspace: ${result.repository} (${changeSourceLabel(result.changeSource)})`,
    `Started: ${result.startedAt}`,
    `Finished: ${result.finishedAt}`,
    `Mode: ${result.implementationProvider} implementation + ${result.reviewProvider} review${result.mock ? " (no AI request)" : ""}`,
    "Result details: available with Countersign: Show Workflow Status",
    `Review summary: ${result.reviewSummary ? "available with Countersign: Show Review Details" : "none"}`,
    `Configured check results: ${result.checks.length === 0 ? "none" : result.checks.map((check) => `${check.id}=${check.passed ? "passed" : "failed"}${check.timedOut ? " (timed out)" : ""}`).join(", ")}`,
    `Findings: ${result.findings.length}`,
    `Working tree before execution: ${result.startingWorkingTreeEntries?.length ?? 0} change(s).`,
    `Working tree after checks: ${result.workingTreeEntries.length === 0 ? "no reviewable changes" : `${result.workingTreeEntries.length} change(s)`}. ${result.changeSource === "git" ? "Git-ignored untracked paths are omitted." : `Snapshot exclusions (${SNAPSHOT_EXCLUDED_DIRS}) stay out of review even when other files changed.`}`,
    `Diff: ${result.diff || result.simulatedDiff ? "available with Countersign: Show Workflow Diff" : "none"}`,
    `Review evidence: ${result.findings.length > 0 ? "available with Countersign: Show Review Details" : "none"}`,
    `Check output: ${result.checks.length > 0 ? "available with Countersign: Show Check Results" : "none"}`,
    `Provider metrics: ${result.metrics.length === 0 ? "not reported" : result.metrics.map((entry) => `${entry.provider}: estimated cost ${entry.estimatedCostUsd ?? "unavailable"} USD, input tokens ${entry.inputTokens ?? "unavailable"}, output tokens ${entry.outputTokens ?? "unavailable"}`).join("; ")}`,
  ].join("\n");
}

function detailedBalancedReport(result: BalancedWorkflowResult): string {
  const lines = [
    `# Balanced workflow report`,
    `Status: ${result.state}`,
    `Outcome: ${result.message}`,
    `Task: ${result.task}`,
    `Started: ${result.startedAt}`,
    `Finished: ${result.finishedAt}`,
    `Workspace: ${result.repository} (${changeSourceLabel(result.changeSource)})`,
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
    "## Review scope and exclusions",
    result.changeSource === "git"
      ? "The Git diff includes tracked generated paths and omits Git-ignored untracked paths."
      : `Snapshot mode excludes ${SNAPSHOT_EXCLUDED_DIRS}. Changes there are omitted from review and reporting even when other files are included in the diff.`,
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
    `${result.changeSource === "git" ? "The Git diff" : "The file snapshot"} covers reviewable changes in this workspace only. External files, commands and network actions are not independently audited by this report. USD figures are provider estimates, not subscription charges.`,
  ];
  return lines.filter((line) => line !== undefined).join("\n").slice(0, 98_000);
}

function changeSourceLabel(source: BalancedWorkflowResult["changeSource"]): string {
  if (source === "git") return "Git diff against HEAD";
  if (source === "git-snapshot") return "Git snapshot against workflow start";
  if (source === "snapshot") return "file snapshot without Git";
  return "change source unavailable";
}

/**
 * Strict Output Channel summary. It carries no task text, no plan text, no diff, no
 * finding evidence or provider message: hashes, counts and state only.
 */
function summarizeStrictWorkflow(result: StrictWorkflowResult): string {
  return [
    "--- Strict workflow summary ---",
    `Task ID: ${result.taskId}`,
    `Mode: strict`,
    `State: ${result.state}`,
    `Outcome reason: ${result.reason?.code ?? "none (completed_clean)"}`,
    `Workspace: ${result.repository}`,
    `Started: ${result.startedAt}`,
    `Finished: ${result.finishedAt}`,
    `Phase A: ${result.budget.plan.providerRequests} provider request(s); active ${formatMinutes(result.budget.plan.activeMs)}; calendar ${formatMinutes(result.budget.plan.wallClockMs)}`,
    `Phase B: ${result.budget.implementation.providerRequests} provider request(s); ${result.budget.implementation.reviewCycles ?? 0} review cycle(s); active ${formatMinutes(result.budget.implementation.activeMs)}; calendar ${formatMinutes(result.budget.implementation.wallClockMs)}`,
    `Plan revisions: ${result.plans.length}; agreed plan hash: ${result.planConsensus?.reachedAt ? result.planConsensus.hash : "none"}`,
    `Human approval: ${result.humanApproval ? (result.humanApproval.approved ? `approved (${result.humanApproval.executionPermission})` : "refused") : "not requested"}`,
    `Reviewed snapshots: ${result.snapshots.length}; final digest: ${result.snapshots.at(-1)?.digest ?? "none"}`,
    `Final consensus: ${result.finalConsensus?.reachedAt ? `reached on ${result.finalConsensus.hash}` : "not reached"}`,
    `Findings: ${countFindings(result, "open")} open, ${countFindings(result, "resolved")} resolved, ${countFindings(result, "disputed")} disputed`,
    `Check rounds: ${result.checkRounds.length === 0 ? "none" : result.checkRounds.map((round) => `${round.round}=${round.configured ? (round.results.every((check) => check.passed) ? "passed" : "failed") : "no check configured"}`).join(", ")}`,
    `Limits reached: ${result.limitBreaches.length === 0 ? "none" : result.limitBreaches.map((breach) => breach.limit).join(", ")}`,
    `Sessions: ${result.sessions.length === 0 ? "none recorded" : result.sessions.map((session) => `${session.role}=${session.isolation}`).join(", ")}`,
    `Policy exclusions: ${result.policyExclusions.length} rule(s); unsupported paths: ${result.unsupportedPaths.length}; files hashed without kept contents: ${result.contentRetention?.filesWithoutContent ?? "not recorded"}`,
    `Pauses: ${result.pauses.length}`,
    `Strict marker: ${result.marker ? `${result.marker.status}${result.marker.outcome ? ` (${result.marker.outcome})` : ""}${result.marker.clearedByCommand ? ", removed with the command" : ""}` : "not recorded"}`,
    "Result details: available in the Countersign chat report",
    `Provider metrics: ${result.metrics.length === 0 ? "not reported" : result.metrics.map((entry) => strictProviderUsageLine(entry).slice(2)).join("; ")}`,
  ].join("\n");
}

/** Stored in the user's workspace chat history; never written to the Output Channel. */
function detailedStrictReport(result: StrictWorkflowResult): string {
  if (isPreflightStop(result)) return detailedStrictPreflightReport(result);
  const finalDigest = result.snapshots.at(-1)?.digest;
  const lines = [
    "# Strict workflow report",
    `Mode: strict (this label belongs to this task, not to the chat thread)`,
    `Status: ${result.state}`,
    `Outcome: ${result.message}`,
    result.reason
      ? `Reason: ${result.reason.code} — ${result.reason.message}\nNext action: ${result.reason.nextAction}${result.reason.limit ? `\nLimit reached: ${result.reason.limit.limit} (${result.reason.limit.observed} of ${result.reason.limit.configured} ${result.reason.limit.unit}, phase ${result.reason.limit.phase})` : ""}`
      : "Reason: completed_clean. Every Strict condition below was met.",
    `Task: ${result.task}`,
    `Workspace: ${result.repository}`,
    `Started: ${result.startedAt}`,
    `Finished: ${result.finishedAt}`,
    result.selectedModels
      ? `Requested models: Claude ${result.selectedModels.claudeModel || "CLI default"} (effort ${result.selectedModels.claudeEffort || "CLI default"}); Codex ${result.selectedModels.codexModel || "CLI default"} (reasoning ${result.selectedModels.codexEffort || "CLI default"}).`
      : "Requested models: not recorded.",
    result.executionPermission
      ? `After plan approval: ${result.executionPermission === "fullAccess" ? "Full access" : "Ask before change"}. Codex stays read-only in every phase.`
      : "After plan approval: not reached. No execution permission was confirmed for this task.",
    result.humanApproval?.approved && result.budget.plan.providerRequests === 0 &&
      result.plans.some((plan) => plan.source === "continued")
      ? "Continuation: the previously approved plan was reused after the original baseline was verified. New partial files, if any, are included in the reviewed diff. Phase A made no new provider request."
      : "",
    "",
    "## Limits in force",
    "No automatic phase request, active-time, review-cycle or per-provider-request timeout is configured. Cancellation and provider failures still stop a task.",
    `- No-progress pause after ${result.limits.implementationPhase.stallCycles} cycle(s); invalid structured response retries: ${result.limits.maxStructuredRetries}`,
    `- Canonical plan: ${result.limits.maxCanonicalPlanBytes} bytes; structured response: ${result.limits.maxStructuredResponseBytes} bytes`,
    ...(result.limitBreaches.length
      ? result.limitBreaches.map((breach) => `- Reached: ${breach.limit} — ${breach.observed} of ${breach.configured} ${strictLimitUnit(breach.limit)} in phase ${breach.phase}`)
      : ["- No ceiling was reached."]),
    "",
    "## Budget",
    `- Phase A: ${result.budget.plan.providerRequests} provider request(s); ${formatMinutes(result.budget.plan.activeMs)} active; ${formatMinutes(result.budget.plan.wallClockMs)} calendar`,
    `- Phase B: ${result.budget.implementation.providerRequests} provider request(s); ${result.budget.implementation.reviewCycles ?? 0} review cycle(s); ${formatMinutes(result.budget.implementation.activeMs)} active; ${formatMinutes(result.budget.implementation.wallClockMs)} calendar`,
    "Active time stops while the task waits for a human approval, waits for an answer to a question, or is paused. Calendar time keeps running and is reported but never exhausts the budget.",
    "",
    "## Plan history",
    ...(result.plans.length
      ? result.plans.flatMap((record) => [
        `${record.revision}. ${record.source} at ${record.createdAt}`,
        `   Schema version ${record.schemaVersion}; canonical size ${record.canonicalBytes} bytes; hash ${record.hash}`,
        `   Objective: ${record.plan.objective}`,
        `   Expected files (${record.plan.expectedFilesComplete ? "complete list" : "incomplete or not estimable"}): ${record.plan.expectedFiles.length === 0 ? "none listed" : record.plan.expectedFiles.join(", ")}`,
      ])
      : ["No plan was produced."]),
    "",
    "## Plan consensus",
    result.planConsensus
      ? `Hash under evaluation: ${result.planConsensus.hash}. ${result.planConsensus.reachedAt ? `Both providers approved this exact hash at ${result.planConsensus.reachedAt}.` : "No agreement was reached on this hash."}`
      : "Phase A did not reach a provider evaluation.",
    ...(result.planConsensus?.approvals.length
      ? result.planConsensus.approvals.map((approval) => `- ${approval.provider}: ${approval.decision} on ${approval.hash} at ${approval.decidedAt}${approval.providerVersion ? ` (version ${approval.providerVersion})` : ""}`)
      : ["- No provider decision was recorded."]),
    ...(result.planConsensus?.openObjections.length
      ? result.planConsensus.openObjections.map((objection) => `- Open objection (${objection.blocking ? "blocking" : "non-blocking"}) on ${objection.target}${objection.reference ? ` ${objection.reference}` : ""}: ${objection.summary} — ${objection.rationale}`)
      : ["- No objection stayed open."]),
    "",
    "## Human approval",
    result.humanApproval
      ? `${result.humanApproval.approved ? "Approved" : "Refused"} at ${result.humanApproval.decidedAt} on plan hash ${result.humanApproval.planHash}; permission ${result.humanApproval.executionPermission}.${result.humanApproval.note ? ` Note: ${result.humanApproval.note}` : ""}`
      : "No plan reached the human approval gate, so phase B never started.",
    "",
    "## Baseline",
    result.baseline
      ? `Root ${result.baseline.root}; full filesystem scan of the declared perimeter; captured ${result.baseline.capturedAt}; ${result.baseline.entryCount} entries; digest ${result.baseline.digest}.${result.baseline.git ? ` Git repository ${result.baseline.git.repository}${result.baseline.git.head ? ` at HEAD ${result.baseline.git.head}` : ""}; Git supplied identity only and did not define the file set.` : " No Git repository root is open for this folder, so Countersign cannot revert these changes."}`
      : "No baseline was captured.",
    "",
    "## Reviewed snapshots",
    ...(result.snapshots.length
      ? result.snapshots.map((snapshot) => `- ${snapshot.capturedAt}: digest ${snapshot.digest} against baseline ${snapshot.baselineDigest}; ${snapshot.changedFileCount} reviewable change(s); ${snapshot.reviewable ? "fully reviewable" : "contains a change that could not be reviewed"}`)
      : ["No snapshot was reviewed."]),
    result.state === "no_changes"
      ? "No reviewable change was produced, so no final review and no final approval happened. This is not a clean completion."
      : finalDigest
      ? `Every final approval below is bound to digest ${finalDigest}. Any in-perimeter change after it invalidates both approvals and restarts checks and review.`
      : "No final digest exists for this task.",
    "",
    "## Final consensus",
    result.finalConsensus
      ? `Digest under evaluation: ${result.finalConsensus.hash}. ${result.finalConsensus.reachedAt ? `Codex and Claude approved this exact digest at ${result.finalConsensus.reachedAt}.` : "No final agreement was reached on this digest."}`
      : "Phase B did not reach a final approval.",
    ...(result.finalConsensus?.approvals.length
      ? result.finalConsensus.approvals.map((approval) => `- ${approval.provider}: ${approval.decision} on ${approval.hash} at ${approval.decidedAt}`)
      : ["- No final provider decision was recorded."]),
    "",
    "## Sessions",
    ...(result.sessions.length
      ? result.sessions.map((session) => `- ${session.role}: ${session.provider}${session.providerVersion ? ` ${session.providerVersion}` : ""}; session ${session.sessionId ?? "identifier not reported"}; context ${session.isolation === "verified_new_context" ? "verified as new" : "not verifiable, which blocks Strict"}; started ${session.startedAt}`)
      : ["No provider session was opened."]),
    "",
    "## Findings",
    ...(result.findings.length
      ? result.findings.slice(0, 50).flatMap((finding, index) => [
        `${index + 1}. [${finding.status}${finding.blocking ? ", blocking" : ""}] ${finding.severity} — ${finding.file}:${finding.line} — ${finding.summary.slice(0, 500)}`,
        `   Reported on digest ${finding.reportedOnDigest}`,
        `   Evidence: ${finding.evidence.slice(0, 1_000)}${finding.evidence.length > 1_000 ? "…" : ""}`,
        ...(finding.resolution ? [`   ${finding.resolution.by} at ${finding.resolution.decidedAt} on digest ${finding.resolution.snapshotDigest}: ${finding.resolution.rationale}`] : []),
      ])
      : ["No finding was reported. A review without findings still needed an explicit snapshot approval."]),
    ...(result.findings.length > 50 ? [`…and ${result.findings.length - 50} more findings.`] : []),
    "",
    "## Local checks per round",
    ...(result.checkRounds.length
      ? result.checkRounds.flatMap((round) => [
        `Round ${round.round} (${round.trigger}) on digest ${round.snapshotDigest}:`,
        ...(round.configured
          ? round.results.map((check) => `- ${check.id}: ${check.passed ? "passed" : "failed"}; exit ${check.exitCode ?? "unavailable"}${check.timedOut ? "; timed out" : ""}${check.output ? `; output: ${check.output.slice(0, 600).replace(/\s+/g, " ")}${check.output.length > 600 ? "…" : ""}` : ""}`)
          : ["- No local check is configured. No test was run and none is reported as passing."]),
      ])
      : ["No check round was run."]),
    "",
    "## Changes already present before this task",
    ...(result.preExistingEntries.length
      ? result.preExistingEntries.slice(0, 100).map((entry) => `- ${entry}`)
      : [preExistingNone(result.preExistingStatus)]),
    ...(result.preExistingEntries.length > 100 ? [`…and ${result.preExistingEntries.length - 100} more entries.`] : []),
    "They were preserved; the snapshot digest covers only the delta introduced during this task.",
    "",
    "## Exclusions",
    ...(result.policyExclusions.length
      ? result.policyExclusions.map((exclusion) => `- Policy rule ${exclusion.rule} under ${exclusion.root}: ${exclusion.entryCount} entry/entries excluded without reading contents. Changes there do not enter the digest, do not invalidate approvals and do not block completion.`)
      : ["- No policy exclusion applied."]),
    ...(result.unsupportedPaths.length
      ? result.unsupportedPaths.map((entry) => `- Unsupported path ${entry.path} (${entry.reason}): not followed, not read, classified as unreviewable. It blocks a clean completion while it changes.`)
      : ["- No unsupported path was found."]),
    contentRetentionLine(result),
    "",
    "## Pauses and interruptions",
    ...(result.pauses.length
      ? result.pauses.map((pause) => `- ${pause.reason} pause from ${pause.fromState} at ${pause.startedAt}${pause.resumedAt ? `, resumed ${pause.resumedAt}` : ", not resumed"}. ${pause.resumable ? "It was resumable only while this extension host held the task in memory." : "It was no longer resumable."}`)
      : ["No pause was recorded."]),
    "A pause lives only in the extension host that owns the task. After a restart, a crash or a window close the task is not resumed: start a new task against a new baseline.",
    "",
    "## Strict interruption marker",
    result.marker
      ? [
        `Status: ${result.marker.status}${result.marker.outcome ? `; outcome ${result.marker.outcome}` : ""}${result.marker.timestamp ? `; written ${result.marker.timestamp}` : ""}.`,
        result.marker.clearedByCommand ? "It was removed with Countersign: Clear Strict interruption marker." : "",
        result.marker.status === "undeterminable"
          ? "A marker from another window was active: the task may be running there or may have been interrupted, and its state cannot be determined from here."
          : "",
        "The marker is lifecycle metadata, not a checkpoint and not a cross-window lock. Countersign: Clear Strict interruption marker deletes only that metadata: it does not interrupt a task that may still be running in another window, and it resumes nothing.",
      ].filter(Boolean).join(" ")
      : "No Strict marker state was recorded for this task.",
    "",
    "## Timeline",
    ...(result.events.length
      ? result.events.map((event) => `- ${event.timestamp} — ${event.state} (phase ${event.phase === "plan" ? "A" : "B"}): ${event.message}`)
      : ["No stage events were recorded."]),
    "",
    "## Provider usage",
    ...(result.metrics.length
      ? result.metrics.map(strictProviderUsageLine)
      : ["Usage was not reported."]),
    "",
    "A clean Strict completion requires all of: provider agreement on one plan hash, human approval, configured checks passing on the last snapshot, no open blocking finding, explicit Codex and Claude approvals of the same final digest, a stable baseline, and no unreviewable change. Changes confined to the policy-excluded paths listed above are expected and block nothing; they never enter the digest. USD figures are provider estimates, not subscription charges.",
  ];
  return lines.filter((line) => line !== undefined).join("\n").slice(0, 98_000);
}

function strictProviderUsageLine(item: StrictWorkflowResult["metrics"][number]): string {
  const totalInput = item.inputTokens !== undefined && item.cacheReadInputTokens !== undefined &&
    item.cacheCreationInputTokens !== undefined
    ? item.inputTokens + item.cacheReadInputTokens + item.cacheCreationInputTokens : undefined;
  const input = item.provider.startsWith("claude")
    ? `${totalInput ?? "?"} total input tokens (${item.inputTokens ?? "?"} uncached, ${item.cacheReadInputTokens ?? "?"} cache read, ${item.cacheCreationInputTokens ?? "?"} cache write)`
    : `${item.inputTokens ?? "?"} input tokens`;
  return `- ${item.provider}: ${input}; ${item.outputTokens ?? "?"} output tokens; ${item.estimatedCostUsd ?? "unavailable"} USD API price estimate`;
}

/**
 * True when the task stopped before phase A could begin: nothing was planned, no provider
 * was contacted and no perimeter was compared. Such a result has no plan, no review and no
 * approval to report, so the full contract report would be page after page of "none".
 */
function isPreflightStop(result: StrictWorkflowResult): boolean {
  return result.state !== "completed_clean"
    && !result.baseline
    && result.plans.length === 0
    && result.snapshots.length === 0
    && result.sessions.length === 0
    && result.metrics.length === 0;
}

/**
 * The short report for a stop before phase A. It says what failed, how far Strict got and
 * what to do next, and nothing else: no empty plan history, no absent consensus, no review
 * that never happened.
 */
function detailedStrictPreflightReport(result: StrictWorkflowResult): string {
  const breach = result.reason?.limit;
  const requests = result.budget.plan.providerRequests + result.budget.implementation.providerRequests;
  return [
    "# Strict preflight report",
    `Status: ${result.state}, before phase A started.`,
    `Task: ${result.task}`,
    `Workspace: ${result.repository}`,
    `Started: ${result.startedAt}; finished: ${result.finishedAt}`,
    "",
    "## What failed",
    `${result.reason?.code ?? "internal_error"} — ${result.reason?.message ?? result.message}`,
    ...(breach ? [`Ceiling reached: ${breach.limit} — ${breach.observed.toLocaleString()} of ${breach.configured.toLocaleString()} ${strictLimitUnit(breach.limit)}.`] : []),
    "",
    "## How far it got",
    "- Phase A (plan agreement): not started.",
    `- Provider requests: ${requests === 0 ? "none. Neither Claude nor Codex was contacted." : `${requests} made before the stop.`}`,
    "- Workspace changes by Strict: none. The task stopped before phase A.",
    "",
    "## Next step",
    result.reason?.nextAction ?? "Fix the problem above, then start a new Strict task.",
  ].join("\n");
}

/** An empty list means a clean tree only when Git actually answered. */
function preExistingNone(status: StrictWorkflowResult["preExistingStatus"]): string {
  if (status === undefined) {
    return "The task ended before Countersign looked at what was already in the workspace, so nothing is claimed about it.";
  }
  if (status === "no_repository") {
    return "No Git repository root is open for this folder, so Countersign cannot list what was already changed, and cannot revert anything here.";
  }
  if (status === "unavailable") {
    return "Git could not report the status of this workspace, so what was already changed is unknown. Treat the list below as incomplete.";
  }
  return "None: Git reported a clean tree when the task started.";
}

/**
 * The diff-content pool is a memory bound, not a task limit, so this line says what it
 * cost rather than treating it as a failure. It names the consequence that matters: a
 * change in a file whose bytes were dropped cannot be diffed, and so blocks completion.
 */
function contentRetentionLine(result: StrictWorkflowResult): string {
  const retention = result.contentRetention;
  if (!retention) return "- No perimeter scan was compared, so nothing is reported about retained file contents.";
  const dropped = retention.filesDroppedForBudget + retention.baselineFilesDroppedForBudget;
  const pool = `${Math.round(retention.maxBytes / (1024 * 1024))} MiB`;
  if (dropped === 0) {
    return `- Diff contents: every reviewable file fitted in the ${pool} diff-content pool (${retention.retainedBytes.toLocaleString()} bytes kept). Each of the ${retention.filesWithoutContent} file(s) read without keeping its bytes was too large on its own or not text; all of them were still hashed in full.`;
  }
  return `- Diff contents: the ${pool} diff-content pool filled, so ${dropped} file(s) were hashed in full without keeping their bytes (${retention.filesDroppedForBudget} in the last scan, ${retention.baselineFilesDroppedForBudget} in the baseline). A change in any of them is detected and reported as content_not_retained, which is unreviewable and blocks a clean completion. The scan itself was never stopped by the size of the workspace.`;
}

function countFindings(result: StrictWorkflowResult, status: "open" | "resolved" | "disputed"): number {
  return result.findings.filter((finding) => finding.status === status).length;
}

function formatMinutes(milliseconds: number): string {
  return `${Math.round(milliseconds / 60_000)} min`;
}
