import * as vscode from "vscode";
import { validateConfiguration } from "./configuration/config";
import { preflightGit, GitPreflightError } from "./context/gitPreflight";
import { runWorkflow } from "./orchestrator/workflow";
import { summarizeWorkflow } from "./orchestrator/report";
import { CodexCliProvider } from "./providers/codexCliProvider";
import { ClaudeCliProvider } from "./providers/claudeCliProvider";
import { verifyClaudeSettingsGate } from "./providers/claudeGate";
import { clearClaudeGateRecord, loadClaudeGateRecord, saveClaudeGateRecord } from "./providers/claudeGateStore";
import { MockProvider } from "./providers/mockProvider";
import { WorkflowEvent, WorkflowResult, WorkflowState } from "./shared/types";

class ExtensionRuntime {
  private readonly output = vscode.window.createOutputChannel("Countersign");
  private currentState: WorkflowState = "idle";
  private activeController: AbortController | undefined;
  private latestResult: WorkflowResult | undefined;

  constructor(private readonly context: vscode.ExtensionContext) {}

  register(): void {
    this.context.subscriptions.push(
      this.output,
      vscode.commands.registerCommand("countersign.startWorkflow", () => this.startWorkflow()),
      vscode.commands.registerCommand("countersign.cancelWorkflow", () => this.cancelWorkflow()),
      vscode.commands.registerCommand("countersign.showStatus", () => this.showStatus()),
      vscode.commands.registerCommand("countersign.showDiagnostics", () => this.showDiagnostics()),
      vscode.commands.registerCommand("countersign.verifyClaudeGate", () => this.verifyClaudeGate()),
      vscode.commands.registerCommand("countersign.showDiff", () => this.showDiff()),
      vscode.commands.registerCommand("countersign.showReview", () => this.showReview()),
      vscode.commands.registerCommand("countersign.showCheckResults", () => this.showCheckResults()),
    );
  }

  dispose(): void {
    this.activeController?.abort();
  }

  private async startWorkflow(): Promise<void> {
    if (this.activeController) {
      void vscode.window.showInformationMessage("A workflow is already running.");
      return;
    }
    const controller = new AbortController();
    this.activeController = controller;
    try {
      this.currentState = "preflight";

      if (!vscode.workspace.isTrusted) {
        this.currentState = "blocked_untrusted_workspace";
        void vscode.window.showWarningMessage("Trust this workspace in VS Code before starting a task.");
        return;
      }

      if (process.platform === "win32") {
        this.currentState = "blocked_provider";
        void vscode.window.showWarningMessage("Windows workflow execution is blocked until process-tree cancellation is implemented and verified.");
        return;
      }

      const folders = vscode.workspace.workspaceFolders;
      if (!folders || folders.length !== 1) {
        this.currentState = "failed";
        void vscode.window.showErrorMessage("Open exactly one Git repository folder as the VS Code workspace.");
        return;
      }

      let config;
      try {
        config = validateConfiguration(readConfiguration());
      } catch (error) {
        this.currentState = "failed";
        void vscode.window.showErrorMessage(errorMessage(error));
        return;
      }
      if (config.provider === "claude") {
        const status = await new ClaudeCliProvider({
          config,
          gateRecord: await loadClaudeGateRecord(),
        }).checkAvailability();
        if (!status.available) {
          this.currentState = "blocked_provider";
          void vscode.window.showWarningMessage(`${status.reason ?? "Claude CLI is unavailable."} Run Verify Claude Settings Isolation if needed.`);
          return;
        }
      }
      if (controller.signal.aborted) {
        this.currentState = "cancelled";
        return;
      }

      let repository: string;
      try {
        const preflight = await preflightGit(folders[0].uri.fsPath);
        repository = preflight.repository;
      } catch (error) {
        if (error instanceof GitPreflightError) {
          this.currentState = mapPreflightState(error.kind);
          this.logState(this.currentState, error.message);
          void vscode.window.showErrorMessage(error.message);
        } else {
          this.currentState = "failed";
          void vscode.window.showErrorMessage(errorMessage(error));
        }
        return;
      }
      if (controller.signal.aborted) {
        this.currentState = "cancelled";
        return;
      }

      const task = await vscode.window.showInputBox({
        title: "Countersign",
        prompt: "Describe the development task",
        placeHolder: "What should change?",
        ignoreFocusOut: true,
        validateInput: (value) => value.trim().length === 0 ? "Enter a task description." : undefined,
      });
      if (task === undefined) {
        this.currentState = "cancelled";
        return;
      }
      if (controller.signal.aborted) {
        this.currentState = "cancelled";
        return;
      }

      this.currentState = "awaiting_confirmation";
      const checksSummary = config.localChecks.length === 0
        ? "none"
        : config.localChecks.map((check) => `${check.id}: ${check.executable} ${check.args.join(" ")}`.trim()).join("\n");
      const details = [
        `Repository: ${repository}`,
        `Task: ${task.trim()}`,
        `Claude tools (${config.provider === "mock" ? "mock uses none" : "pre-authorized for this task"}): ${config.claudeAllowedTools.join(", ") || "none"}. Bash and MCP are excluded.`,
        config.provider === "mock" ? `Mock scenario: ${config.mockScenario}` : "No mock scenario is used in the real workflow.",
        `Configured local checks (these will run):\n${checksSummary}`,
        "Configured check processes may modify files. Real workflows include their changes in the Git diff; mock workflows fail validation if they change the repository.",
        `Finding threshold for the correction path: ${config.findingThreshold}`,
        config.provider === "mock"
          ? "Implementation: mock only. Changes are simulated in memory; the mock does not edit files."
          : `Implementation: real Claude CLI (${config.claudeExecutable}) may edit repository files and consume account quota. The estimated budget guard is ${config.budgetGuardUsd} USD per invocation; it is not a billing cap.`,
        config.codexProvider === "real"
          ? `Review: real Codex CLI (${config.codexExecutable}) in a read-only sandbox. It receives the task and ${config.provider === "mock" ? "simulated" : "actual"} diff, can inspect repository files as context, and may consume account quota. The invocation ignores Codex config.toml and user/project execpolicy rules; CODEX_HOME authentication remains available.`
          : "Review: mock Codex; no AI provider request is made.",
      ].join("\n\n");
      const confirmationLabel = config.provider === "claude" ? "Start Real Workflow" : config.codexProvider === "real" ? "Start Mock + Codex Review" : "Start Mock Workflow";
      const confirm = await vscode.window.showWarningMessage(
        config.provider === "claude" ? "Start Claude implementation and Codex review?" : config.codexProvider === "real" ? "Send a review request to Codex?" : "Start the mock workflow?",
        { modal: true, detail: details },
        confirmationLabel,
      );
      if (confirm !== confirmationLabel) {
        this.currentState = "cancelled";
        return;
      }
      if (controller.signal.aborted) {
        this.currentState = "cancelled";
        return;
      }

      if (!vscode.workspace.isTrusted) {
        this.currentState = "blocked_untrusted_workspace";
        void vscode.window.showWarningMessage("Workspace trust changed before the task started. No workflow was run.");
        return;
      }

      const currentFolders = vscode.workspace.workspaceFolders;
      if (!currentFolders || currentFolders.length !== 1 || currentFolders[0].uri.fsPath !== folders[0].uri.fsPath) {
        this.currentState = "failed";
        void vscode.window.showErrorMessage("The workspace changed while confirmation was open. Start again from the intended repository.");
        return;
      }

      let currentConfig;
      try {
        currentConfig = validateConfiguration(readConfiguration());
      } catch (error) {
        this.currentState = "failed";
        void vscode.window.showErrorMessage(errorMessage(error));
        return;
      }
      if (JSON.stringify(currentConfig) !== JSON.stringify(config)) {
        this.currentState = "blocked_provider";
        void vscode.window.showWarningMessage("The workflow configuration changed after it was shown. Review the settings and start again.");
        return;
      }

      try {
        await preflightGit(currentFolders[0].uri.fsPath);
      } catch (error) {
        if (error instanceof GitPreflightError) {
          this.currentState = mapPreflightState(error.kind);
          this.logState(this.currentState, error.message);
          void vscode.window.showErrorMessage(`Preflight changed before start: ${error.message}`);
        } else {
          this.currentState = "failed";
          void vscode.window.showErrorMessage(errorMessage(error));
        }
        return;
      }
      if (controller.signal.aborted) {
        this.currentState = "cancelled";
        return;
      }

      this.output.show(true);
      this.output.appendLine("--- Countersign workflow ---");
      this.output.appendLine(`Repository: ${repository}`);
      this.output.appendLine(`Mode: ${config.provider} implementation + ${config.codexProvider} review.`);

      try {
        const claude = config.provider === "claude"
          ? new ClaudeCliProvider({ config, gateRecord: await loadClaudeGateRecord() })
          : new MockProvider("implementation", config.mockScenario);
        const codex = config.codexProvider === "real"
          ? new CodexCliProvider({
              executable: config.codexExecutable,
              timeoutMs: config.providerTimeoutMinutes * 60_000,
              gracePeriodMs: config.terminationGracePeriodMs,
            })
          : new MockProvider("review", config.mockScenario);
        const result = await runWorkflow({
          repository,
          task: task.trim(),
          config,
          claude,
          codex,
          signal: controller.signal,
          onEvent: (event) => this.onEvent(event),
        });
        this.currentState = result.state;
        this.latestResult = result;
        this.writeSummary(result);
        void vscode.window.showInformationMessage(`Countersign: ${result.state}. Open the output or result commands for details.`);
      } catch (error) {
        this.currentState = "failed";
        this.output.appendLine(`Workflow failed: ${errorMessage(error)}`);
        void vscode.window.showErrorMessage(`Workflow failed: ${errorMessage(error)}`);
      }
    } finally {
      if (this.activeController === controller) this.activeController = undefined;
    }
  }

  private cancelWorkflow(): void {
    if (!this.activeController) {
      void vscode.window.showInformationMessage("No workflow is running.");
      return;
    }
    this.activeController.abort();
    this.output.appendLine("Cancellation requested.");
  }

  private showStatus(): void {
    const active = this.activeController ? "yes" : "no";
    const latest = this.latestResult
      ? `${this.latestResult.state} at ${this.latestResult.finishedAt}`
      : "none";
    const lines = [`State: ${this.currentState}`, `Active: ${active}`, `Latest result: ${latest}`];
    if (this.latestResult?.message) lines.push(`Message: ${this.latestResult.message}`);
    void vscode.window.showInformationMessage(lines.join(" · "));
  }

  private async showDiagnostics(): Promise<void> {
    const config = vscode.workspace.getConfiguration("countersign");
    const lines = [
      "Countersign diagnostics",
      `VS Code: ${vscode.version}`,
      `Extension host Node.js: ${process.versions.node}`,
      `Workspace trusted: ${vscode.workspace.isTrusted ? "yes" : "no"}`,
      `Provider setting: ${String(config.get("provider", "mock"))}`,
      `Codex review provider: ${String(config.get("codexProvider", "mock"))}`,
      `Current state: ${this.currentState}`,
      `Latest workflow: ${this.latestResult?.state ?? "none"}`,
      `Claude settings-source gate: ${(await loadClaudeGateRecord())?.version ?? "not verified"}`,
      "Claude CLI adapter: available only after the exact-version settings-source gate passes.",
      "Codex CLI adapter: read-only review of actual or simulated diffs when explicitly enabled.",
      "Credentials and environment variables are not inspected.",
    ];
    this.output.show(true);
    this.output.appendLine(lines.join("\n"));
  }

  private onEvent(event: WorkflowEvent): void {
    this.currentState = event.state;
    this.logState(event.state, event.message);
  }

  private logState(state: WorkflowState, message: string): void {
    this.output.appendLine(`[${new Date().toLocaleTimeString()}] ${state}: ${message}`);
  }

  private writeSummary(result: WorkflowResult): void {
    this.output.appendLine(summarizeWorkflow(result));
  }

  private async showDiff(): Promise<void> {
    const content = this.latestResult?.diff ?? this.latestResult?.simulatedDiff;
    if (!content) return void vscode.window.showInformationMessage("No workflow diff is available.");
    await this.openResultDocument(content, "diff");
  }

  private async showReview(): Promise<void> {
    if (!this.latestResult) return void vscode.window.showInformationMessage("No workflow result is available.");
    const content = [
      `Review summary: ${this.latestResult.reviewSummary ?? "unavailable"}`,
      ...this.latestResult.findings.map((finding, index) => [
        `${index + 1}. ${finding.severity} ${finding.file}:${finding.line}`,
        finding.summary,
        `Evidence: ${finding.evidence}`,
      ].join("\n")),
    ].join("\n\n");
    await this.openResultDocument(content, "plaintext");
  }

  private async showCheckResults(): Promise<void> {
    if (!this.latestResult) return void vscode.window.showInformationMessage("No workflow result is available.");
    const content = this.latestResult.checks.map((check) => [
      `${check.id}: ${check.passed ? "passed" : "failed"}, exit code ${check.exitCode ?? "unavailable"}${check.timedOut ? ", timed out" : ""}`,
      check.output || "(no output)",
    ].join("\n")).join("\n\n");
    await this.openResultDocument(content || "No local checks were configured.", "plaintext");
  }

  private async openResultDocument(content: string, language: string): Promise<void> {
    const document = await vscode.workspace.openTextDocument({ content, language });
    await vscode.window.showTextDocument(document, { preview: true });
  }

  private async verifyClaudeGate(): Promise<void> {
    if (this.activeController) return void vscode.window.showWarningMessage("A workflow or gate test is already running.");
    const controller = new AbortController();
    this.activeController = controller;
    try {
      if (!vscode.workspace.isTrusted) return void vscode.window.showWarningMessage("Trust this workspace before testing Claude CLI settings isolation.");
      if (process.platform === "win32") return void vscode.window.showWarningMessage("Windows process-tree cancellation is not supported.");
      let config;
      try { config = validateConfiguration(readConfiguration()); }
      catch (error) { return void vscode.window.showErrorMessage(errorMessage(error)); }
      const label = "Run Two Claude Requests";
      const confirmed = await vscode.window.showWarningMessage(
        "Verify Claude CLI settings-source isolation?",
        {
          modal: true,
          detail: "This controlled test starts two real Claude CLI requests in a temporary project. The first must trigger a temporary project hook; the second must suppress it with --setting-sources \"\". Existing user hooks may also run in the control request. Both requests may consume account quota. No credential or existing settings file is changed or copied. The gate remains closed if either result is inconclusive.",
        },
        label,
      );
      if (confirmed !== label) return;
      if (controller.signal.aborted) return;
      await clearClaudeGateRecord();
      try {
        const record = await verifyClaudeSettingsGate(config, controller.signal);
        await saveClaudeGateRecord(record);
        this.output.appendLine(`Claude settings-source gate passed for ${record.version} at ${record.passedAt}.`);
        void vscode.window.showInformationMessage(`Claude settings-source gate passed for ${record.version}.`);
      } catch (error) {
        this.output.appendLine(`Claude settings-source gate did not pass: ${errorMessage(error)}`);
        void vscode.window.showErrorMessage(`Claude settings-source gate did not pass: ${errorMessage(error)}`);
      }
    } finally {
      if (this.activeController === controller) this.activeController = undefined;
    }
  }
}

function readConfiguration(): Record<string, unknown> {
  const config = vscode.workspace.getConfiguration("countersign");
  return {
    provider: config.get<unknown>("provider", "mock"),
    claudeExecutable: config.get<unknown>("claudeExecutable", "claude"),
    codexProvider: config.get<unknown>("codexProvider", "mock"),
    codexExecutable: config.get<unknown>("codexExecutable", "codex"),
    mockScenario: config.get<unknown>("mockScenario", "clean"),
    claudeAllowedTools: config.get<unknown>("claudeAllowedTools", ["Read", "Glob", "Grep", "Edit", "Write"]),
    localChecks: config.get<unknown>("localChecks", []),
    budgetGuardUsd: config.get<unknown>("budgetGuardUsd", 1),
    taskTimeoutMinutes: config.get<unknown>("taskTimeoutMinutes", 30),
    providerTimeoutMinutes: config.get<unknown>("providerTimeoutMinutes", 15),
    checkTimeoutMinutes: config.get<unknown>("checkTimeoutMinutes", 5),
    findingThreshold: config.get<unknown>("findingThreshold", "High"),
    terminationGracePeriodMs: config.get<unknown>("terminationGracePeriodMs", 1000),
  };
}

function mapPreflightState(kind: GitPreflightError["kind"]): WorkflowState {
  if (kind === "dirty_repository") return "blocked_dirty_repository";
  if (kind === "git_unavailable") return "blocked_provider";
  if (kind === "workspace_mismatch") return "failed";
  return "failed";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error.";
}

let runtime: ExtensionRuntime | undefined;

export function activate(context: vscode.ExtensionContext): void {
  runtime = new ExtensionRuntime(context);
  runtime.register();
}

export function deactivate(): void {
  runtime?.dispose();
  runtime = undefined;
}
