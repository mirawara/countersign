import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import * as vscode from "vscode";
import {
  assert,
  assertExcludes,
  assertIncludes,
  countOccurrences,
  installRecorder,
  Recorder,
  waitFor,
} from "../harness";

/** Marker printed by a configured check, used to prove raw check output stays out of the channel. */
const CHECK_MARKER = "AIDO_CHECK_MARKER_7391";
/** A fragment of the Claude prompt built in claudeCliProvider, which must never reach the channel. */
const PROMPT_FRAGMENT = "Work only inside this repository";
/** A fragment of the mock simulated diff body, which must never reach the channel. */
const DIFF_FRAGMENT = "Simulated implementation output";

type CaseReport = Record<string, unknown>;

function repositoryPath(): string {
  const folders = vscode.workspace.workspaceFolders;
  assert(folders !== undefined && folders.length === 1, "The test workspace must be exactly one folder.");
  return folders[0].uri.fsPath;
}

function git(repository: string, args: string[]): string {
  return execFileSync("git", args, { cwd: repository, encoding: "utf8" });
}

function statusPorcelain(repository: string): string[] {
  return git(repository, ["status", "--porcelain=v1", "--untracked-files=all"]).split("\n").filter(Boolean);
}

function pidsMatching(pattern: string): number[] {
  try {
    return execFileSync("pgrep", ["-f", pattern], { encoding: "utf8" })
      .split("\n").filter(Boolean).map(Number).filter((pid) => Number.isInteger(pid) && pid !== process.pid);
  } catch {
    return [];
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/** Reads the state the status command reports, which is the same string the user sees. */
async function readState(recorder: Recorder): Promise<string> {
  const before = recorder.information.length;
  await vscode.commands.executeCommand("aiDevOrchestrator.showStatus");
  const message = recorder.information[before] ?? "";
  return (/State: ([a-z_]+)/.exec(message)?.[1]) ?? "unknown";
}

async function startAndWait(recorder: Recorder): Promise<string> {
  await vscode.commands.executeCommand("aiDevOrchestrator.startWorkflow");
  return readState(recorder);
}

function channelText(recorder: Recorder): string {
  return recorder.outputLines.join("\n");
}

/** Asserts the confidentiality rules the plan requires of the Output Channel. */
function assertChannelIsClean(recorder: Recorder): void {
  const text = channelText(recorder);
  assertExcludes(text, CHECK_MARKER, "Output Channel must not contain raw check output");
  assertExcludes(text, PROMPT_FRAGMENT, "Output Channel must not contain the provider prompt");
  assertExcludes(text, DIFF_FRAGMENT, "Output Channel must not contain the full diff");
}

async function mockClean(): Promise<CaseReport> {
  const repository = repositoryPath();
  const recorder = installRecorder({ task: "Document the add helper in sample.js", confirm: true });
  try {
    const state = await startAndWait(recorder);
    assert(state === "completed_clean", `Expected completed_clean, got ${state}.`);

    assert(recorder.modals.length === 1, `Expected exactly one confirmation modal, got ${recorder.modals.length}.`);
    const modal = recorder.modals[0];
    assertIncludes(modal.detail, `Repository: ${repository}`, "Confirmation detail");
    assertIncludes(modal.detail, "Document the add helper in sample.js", "Confirmation detail");
    assertIncludes(modal.detail, "Mock scenario: clean", "Confirmation detail");
    assertIncludes(modal.detail, "marker:", "Confirmation detail must list the configured checks");
    assertIncludes(modal.items.join(","), "Start Mock Workflow", "Confirmation action");

    const text = channelText(recorder);
    assertIncludes(text, "State: completed_clean", "Workflow summary");
    assertIncludes(text, "Configured check results: marker=passed", "Workflow summary");
    assertChannelIsClean(recorder);

    // Result commands must surface the detail the channel withholds.
    const documentsBefore = recorder.documents.length;
    await vscode.commands.executeCommand("aiDevOrchestrator.showDiff");
    await vscode.commands.executeCommand("aiDevOrchestrator.showCheckResults");
    await vscode.commands.executeCommand("aiDevOrchestrator.showReview");
    const [diffDocument, checkDocument, reviewDocument] = recorder.documents.slice(documentsBefore);
    assert(diffDocument !== undefined, "Show Workflow Diff opened no document.");
    assertIncludes(diffDocument.content, DIFF_FRAGMENT, "Diff document");
    assert(checkDocument !== undefined, "Show Check Results opened no document.");
    assertIncludes(checkDocument.content, CHECK_MARKER, "Check results document");
    assertIncludes(checkDocument.content, "marker: passed", "Check results document");
    assert(reviewDocument !== undefined, "Show Review Details opened no document.");
    assertIncludes(reviewDocument.content, "Review summary:", "Review document");

    await vscode.commands.executeCommand("aiDevOrchestrator.showDiagnostics");
    const diagnostics = channelText(recorder);
    assertIncludes(diagnostics, "AI Dev Orchestrator diagnostics", "Diagnostics");
    assertIncludes(diagnostics, "Workspace trusted: yes", "Diagnostics");

    const dirty = statusPorcelain(repository);
    assert(dirty.length === 0, `Mock workflow must not change the repository, saw: ${dirty.join(", ")}`);

    return { state, modalDetail: modal.detail, checkDocument: checkDocument.content.trim(), dirty };
  } finally {
    recorder.restore();
  }
}

async function mockFinding(): Promise<CaseReport> {
  const recorder = installRecorder({ task: "Exercise the single correction path", confirm: true });
  try {
    const state = await startAndWait(recorder);
    const corrections = countOccurrences(recorder.outputLines, "correcting:");
    const checkRuns = countOccurrences(recorder.outputLines, "running_checks:");
    assert(corrections === 1, `The correction pass must run at most once, it ran ${corrections} time(s).`);
    assert(checkRuns === 2, `Checks must re-run after the correction; saw ${checkRuns} check phase(s).`);
    assert(state === "completed_clean", `Expected completed_clean after a corrected finding, got ${state}.`);
    assertIncludes(channelText(recorder), "Findings: 0", "Workflow summary after correction");
    assertChannelIsClean(recorder);
    return { state, corrections, checkRuns };
  } finally {
    recorder.restore();
  }
}

async function mockDismiss(): Promise<CaseReport> {
  const recorder = installRecorder({ task: "This confirmation is dismissed", confirm: false });
  try {
    const state = await startAndWait(recorder);
    assert(state === "cancelled", `Dismissing the confirmation must cancel, got ${state}.`);
    assert(recorder.modals.length === 1, "The confirmation modal must still be shown before cancelling.");
    const text = channelText(recorder);
    assertExcludes(text, "--- AI Dev Orchestrator workflow ---", "A dismissed confirmation must not start the workflow");
    return { state, modalShown: recorder.modals.length };
  } finally {
    recorder.restore();
  }
}

async function mockValidationFailed(): Promise<CaseReport> {
  const repository = repositoryPath();
  const recorder = installRecorder({ task: "Trigger a failing local check", confirm: true });
  try {
    const state = await startAndWait(recorder);
    assert(state === "validation_failed", `Expected validation_failed, got ${state}.`);
    assertIncludes(channelText(recorder), "validation_failed:", "Workflow events");
    const dirty = statusPorcelain(repository);
    assert(dirty.length === 0, `A failed check must leave the repository unchanged, saw: ${dirty.join(", ")}`);
    return { state, dirty };
  } finally {
    recorder.restore();
  }
}

async function cancelDuringCheck(): Promise<CaseReport> {
  const recorder = installRecorder({ task: "Cancel while a local check is running", confirm: true });
  try {
    const running = vscode.commands.executeCommand("aiDevOrchestrator.startWorkflow");
    await waitFor(
      () => countOccurrences(recorder.outputLines, "running_checks:") > 0,
      60_000,
      "the configured local check to start",
    );
    await waitFor(() => pidsMatching("slow-check.js").length > 0, 60_000, "the check process to appear");
    const checkPids = pidsMatching("slow-check.js");
    const childPids = pidsMatching("setTimeout");
    assert(checkPids.length > 0, "No check process was observed before cancelling.");
    assert(childPids.length > 0, "The check spawned no child process to terminate.");

    await vscode.commands.executeCommand("aiDevOrchestrator.cancelWorkflow");
    await running;

    const state = await readState(recorder);
    assert(state === "cancelled", `Expected cancelled, got ${state}.`);
    await waitFor(
      () => [...checkPids, ...childPids].every((pid) => !alive(pid)),
      30_000,
      "the check process group to terminate",
    );
    const survivors = [...checkPids, ...childPids].filter(alive);
    assert(survivors.length === 0, `Processes survived cancellation: ${survivors.join(", ")}`);
    assertIncludes(channelText(recorder), "Cancellation requested.", "Output Channel");
    return { state, checkPids, childPids, survivors };
  } finally {
    recorder.restore();
  }
}

async function realWorkflow(): Promise<CaseReport> {
  const repository = repositoryPath();
  const baseline = git(repository, ["rev-parse", "HEAD"]).trim();
  const recorder = installRecorder({
    task: "In calc.js add an exported subtract(a, b) function that returns a - b, and add a matching node:test case to calc.test.js. Change nothing else.",
    confirm: true,
  });
  try {
    const state = await startAndWait(recorder);
    const text = channelText(recorder);
    const diff = git(repository, ["diff"]);
    const status = statusPorcelain(repository);

    const documentsBefore = recorder.documents.length;
    await vscode.commands.executeCommand("aiDevOrchestrator.showDiff");
    await vscode.commands.executeCommand("aiDevOrchestrator.showCheckResults");
    await vscode.commands.executeCommand("aiDevOrchestrator.showReview");
    const [diffDocument, checkDocument, reviewDocument] = recorder.documents.slice(documentsBefore);

    assertChannelIsClean(recorder);
    assertIncludes(text, "Mode: claude implementation + real review", "Workflow summary");

    return {
      state,
      baseline,
      summary: text,
      gitDiff: diff,
      gitStatus: status,
      diffDocument: diffDocument?.content ?? "",
      checkDocument: checkDocument?.content ?? "",
      reviewDocument: reviewDocument?.content ?? "",
      information: recorder.information,
      errors: recorder.errors,
      modalDetail: recorder.modals[0]?.detail ?? "",
    };
  } finally {
    recorder.restore();
  }
}

const CASES: Record<string, () => Promise<CaseReport>> = {
  "mock-clean": mockClean,
  "mock-finding": mockFinding,
  "mock-dismiss": mockDismiss,
  "mock-validation-failed": mockValidationFailed,
  "cancel-during-check": cancelDuringCheck,
  "real-workflow": realWorkflow,
};

export async function run(): Promise<void> {
  const name = process.env.AIDO_CASE ?? "";
  const resultFile = process.env.AIDO_RESULT_FILE;
  const scenario = CASES[name];
  if (!scenario) throw new Error(`Unknown integration case: ${JSON.stringify(name)}.`);

  // Activation is lazy; the recorder must be installed before the first command runs.
  const started = Date.now();
  try {
    const report = await scenario();
    if (resultFile) writeFileSync(resultFile, JSON.stringify({ case: name, passed: true, durationMs: Date.now() - started, report }, null, 2));
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (resultFile) writeFileSync(resultFile, JSON.stringify({ case: name, passed: false, durationMs: Date.now() - started, error: message }, null, 2));
    throw error;
  }
}
