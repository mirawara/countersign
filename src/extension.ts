import * as vscode from "vscode";
import { readFile, realpath, stat, unlink } from "node:fs/promises";
import { isAbsolute, join } from "node:path";
import { ChatController } from "./chat/controller";
import { AccountProfiles } from "./chat/accountProfiles";
import { runExecutable } from "./shared/process";
import { OrchestratorConfig, validateConfiguration } from "./configuration/config";
import { inspectClaude } from "./chat/claudeAdapter";
import { inspectCodex } from "./chat/codexAdapter";
import { GitPreflightError } from "./context/gitPreflight";
import { runWorkflow } from "./orchestrator/workflow";
import { GitChanges } from "./context/gitChanges";
import { createWorkspaceChanges, WorkspaceChanges } from "./context/workspaceChanges";
import { summarizeWorkflow } from "./orchestrator/report";
import { CodexCliProvider } from "./providers/codexCliProvider";
import { ClaudeCliProvider } from "./providers/claudeCliProvider";
import { verifyClaudeSettingsGate } from "./providers/claudeGate";
import { clearClaudeGateRecord, loadClaudeGateRecord, saveClaudeGateRecord } from "./providers/claudeGateStore";
import { MockProvider } from "./providers/mockProvider";
import { BalancedWorkflowResult, WorkflowEvent, WorkflowState } from "./shared/types";
import { acquireRepositoryLock } from "./shared/repositoryLock";
import { StrictWorkflowStartRequest, WorkflowAccountSelection, WorkflowStartRequest } from "./shared/workflowInteraction";
import { runStrictTask } from "./orchestrator/strictTask";
import { StrictClaudeProvider } from "./providers/strictClaudeProvider";
import { StrictCodexProvider } from "./providers/strictCodexProvider";
import { runLocalChecks } from "./orchestrator/localChecks";
import { StrictWorkflowResult } from "./shared/strict";
import { canonicalizeStrictPlan } from "./orchestrator/strictPlanHash";
import { preflightGit } from "./context/gitPreflight";
import { describeStrictMarkerStatus, STRICT_INTERRUPTION_MARKER_KEY, StrictMarkerStore } from "./shared/strictMarker";

export class ExtensionRuntime {
  private readonly output = vscode.window.createOutputChannel("Countersign");
  private currentState: WorkflowState = "idle";
  private lastStartIssue: string | undefined;
  private activeController: AbortController | undefined;
  private strictTaskPromise: Promise<StrictWorkflowResult> | undefined;
  private latestResult: BalancedWorkflowResult | undefined;
  private readonly strictMarkers: StrictMarkerStore;

  constructor(private readonly context: vscode.ExtensionContext) {
    this.strictMarkers = new StrictMarkerStore(context.workspaceState);
  }

  /**
   * Consume an explicit, one-time confirmation for a specific stale marker. The request
   * lives outside VS Code's cached workspace memento so a reload cannot restore the old
   * value before workspaceState.update removes it through VS Code itself.
   */
  async recoverConfirmedMarker(): Promise<void> {
    const requestFile = join(this.context.globalStorageUri.fsPath, "confirmed-strict-marker-clear.json");
    let request: unknown;
    try { request = JSON.parse(await readFile(requestFile, "utf8")); }
    catch { return; }
    if (!request || typeof request !== "object" || Array.isArray(request)) return;
    const confirmed = request as Record<string, unknown>;
    const folders = vscode.workspace.workspaceFolders;
    if (folders?.length !== 1 || folders[0].uri.fsPath !== confirmed.workspace) return;
    const age = typeof confirmed.confirmedAt === "string" ? Date.now() - Date.parse(confirmed.confirmedAt) : NaN;
    if (typeof confirmed.markerId !== "string" || !Number.isFinite(age) || age < 0 || age > 86_400_000) return;
    const status = this.strictMarkers.status();
    if (status.kind === "undeterminable" && status.marker.id === confirmed.markerId) {
      await this.strictMarkers.clear();
      this.output.appendLine("Cleared the specifically confirmed, inactive Strict marker on activation.");
    }
    await unlink(requestFile).catch(() => undefined);
  }

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
      vscode.commands.registerCommand("countersign.clearStrictInterruptionMarker", () => this.clearStrictInterruptionMarker()),
    );
    if (process.env.COUNTERSIGN_TEST_MODE === "1") {
      // Test-only: lets the packaged integration case seed and read the lifecycle marker.
      this.context.subscriptions.push(vscode.commands.registerCommand("countersign.strictMarkerState",
        async (marker?: unknown) => {
          if (marker !== undefined) await this.context.workspaceState.update(STRICT_INTERRUPTION_MARKER_KEY, marker);
          return this.context.workspaceState.get<unknown>(STRICT_INTERRUPTION_MARKER_KEY);
        }));
    }
  }

  async dispose(): Promise<void> {
    this.activeController?.abort();
    // VS Code awaits deactivate() on an ordinary Reload Window. Let the cancelled
    // task release its provider process and workspace before a new host may start.
    await this.strictTaskPromise?.catch(() => undefined);
    await this.strictMarkers.interruptForShutdown();
  }

  async startChatWorkflow(request: WorkflowStartRequest): Promise<BalancedWorkflowResult> {
    const result = await this.startWorkflow(request);
    if (result) return result;
    throw new Error(this.lastStartIssue ?? `Workflow stopped before execution (${this.currentState}). Check the Countersign Output Channel.`);
  }

  cancelChatWorkflow(): void {
    this.cancelWorkflow();
  }

  /**
   * One Strict task from the sidebar. The repository lock, the lifecycle marker and the
   * provider sessions all live inside runStrictTask; nothing here survives a restart.
   */
  async startStrictWorkflow(request: StrictWorkflowStartRequest): Promise<StrictWorkflowResult> {
    if (this.activeController) throw new Error("A workflow is already running.");
    const folders = vscode.workspace.workspaceFolders;
    if (!vscode.workspace.isTrusted) throw new Error("Strict needs a trusted workspace.");
    if (process.platform !== "linux") throw new Error("Strict is verified on Linux only.");
    if (!folders || folders.length !== 1) throw new Error("Open exactly one workspace folder for Strict.");
    const repository = folders[0].uri.fsPath;
    const accounts = await resolveAccountSelection(request.accounts);
    let config = validateConfiguration({ ...readConfiguration(), provider: "claude", codexProvider: "real",
      ...request.selection, executionPermission: request.executionPermission });
    const controller = new AbortController();
    this.activeController = controller;
    const onAbort = (): void => controller.abort();
    request.signal.addEventListener("abort", onAbort, { once: true });
    if (request.signal.aborted) controller.abort();
    const ensureActive = (): void => {
      if (controller.signal.aborted) throw new Error("Strict task cancelled.");
    };
    try {
      await vscode.commands.executeCommand("setContext", "countersign.strictTaskActive", true);
      ensureActive();
      const reconciled = await reconcileSelectedModels(config, repository, true, accounts);
      config = { ...config, claudeModel: reconciled.claudeModel, claudeEffort: reconciled.claudeEffort,
        codexModel: reconciled.codexModel, codexEffort: reconciled.codexEffort };
      for (const warning of reconciled.warnings) {
        this.output.appendLine(`[${new Date().toLocaleTimeString()}] selection: ${warning}`);
        void vscode.window.showWarningMessage(warning);
      }
      ensureActive();
      this.output.appendLine("--- Countersign Strict task ---");
      this.output.appendLine(`Workspace: ${repository}`);
      const gateRecord = await loadClaudeGateRecord();
      ensureActive();
      if (gateRecord?.passed !== true) {
        throw new Error("Strict needs the Claude settings-source isolation gate. Run Countersign: Verify Claude Settings Isolation.");
      }
      // Best-effort, for the warning below only. It never decides where a command runs:
      // every Git command Strict issues goes through the pinned root instead.
      let hasGitRoot = true;
      try { await preflightGit(repository, controller.signal); }
      catch {
        ensureActive();
        hasGitRoot = false;
      }
      ensureActive();
      if (!hasGitRoot) {
        void vscode.window.showWarningMessage(
          "This folder has no Git repository root. Countersign cannot revert Strict changes here.");
      }
      const claude = new StrictClaudeProvider({ config, gateRecord, accountDir: accounts.claudeConfigDir,
        askPermission: request.interaction.askPermission });
      const codex = new StrictCodexProvider({ executable: config.codexExecutable, model: config.codexModel,
        effort: config.codexEffort, accountDir: accounts.codexHome, gracePeriodMs: config.terminationGracePeriodMs,
        // Codex runs in the pinned root, which is not a path it can recognise as a
        // repository; its own repo check would refuse the turn for the wrong reason.
        skipGitRepoCheck: true });
      const taskPromise = runStrictTask({
        repository,
        task: request.task,
        localChecks: config.localChecks,
        limitOverrides: {},
        planningClaude: claude,
        planningCodex: codex,
        implementationClaude: claude,
        reviewCodex: codex,
        selectedModels: { claudeModel: config.claudeModel, claudeEffort: config.claudeEffort,
          codexModel: config.codexModel, codexEffort: config.codexEffort },
        human: {
          askQuestion: (question, signal) => request.interaction.askQuestion(question.question, signal),
          requestApproval: async (approval, signal) => {
            const answer = await request.interaction.approvePlan({
              planText: planText(approval.plan),
              planHash: approval.planHash,
              expectedFileCount: approval.expectedFileCount,
              expectedFilesComplete: approval.expectedFilesComplete,
              executionPermission: request.executionPermission,
            }, signal);
            if (!answer?.approved) return { kind: "refuse", note: "The plan was refused in the chat." };
            return { kind: "approve", executionPermission: answer.executionPermission };
          },
        },
        pause: {
          onPause: (info, signal) => request.interaction.onPause(
            `Phase B made no verifiable progress for ${info.cyclesWithoutProgress} cycles. Resume in this window, or stop the task.`,
            signal),
        },
        // The checks run in the pinned root, like the providers: a path replaced before
        // the spawn cannot move them into another tree.
        runChecks: (checks, signal, workingDirectory) => runLocalChecks(checks, workingDirectory,
          config.checkTimeoutMinutes * 60_000, config.terminationGracePeriodMs, signal),
        markers: this.strictMarkers,
        signal: controller.signal,
        onEvent: (event) => {
          this.logState(event.state, event.message);
          request.onEvent?.(event);
        },
      });
      this.strictTaskPromise = taskPromise;
      try { return await taskPromise; }
      finally { if (this.strictTaskPromise === taskPromise) this.strictTaskPromise = undefined; }
    } finally {
      request.signal.removeEventListener("abort", onAbort);
      try { await vscode.commands.executeCommand("setContext", "countersign.strictTaskActive", false); }
      finally { if (this.activeController === controller) this.activeController = undefined; }
    }
  }

  private async startWorkflow(request?: WorkflowStartRequest): Promise<BalancedWorkflowResult | undefined> {
    if (this.activeController) {
      void vscode.window.showInformationMessage("A workflow is already running.");
      if (request?.interaction) throw new Error("A workflow is already running.");
      return;
    }
    this.lastStartIssue = undefined;
    const controller = new AbortController();
    this.activeController = controller;
    let releaseLock: (() => void) | undefined;
    try {
      this.currentState = "preflight";

      if (!vscode.workspace.isTrusted) {
        this.currentState = "blocked_untrusted_workspace";
        this.lastStartIssue = "Trust this workspace in VS Code before starting a task.";
        void vscode.window.showWarningMessage(this.lastStartIssue);
        return;
      }

      if (process.platform === "win32") {
        this.currentState = "blocked_provider";
        this.lastStartIssue = "Windows workflow execution is blocked until process-tree cancellation is implemented and verified.";
        void vscode.window.showWarningMessage(this.lastStartIssue);
        return;
      }

      const folders = vscode.workspace.workspaceFolders;
      if (!folders || folders.length !== 1) {
        this.currentState = "failed";
        this.lastStartIssue = "Open exactly one project folder as the VS Code workspace.";
        void vscode.window.showErrorMessage(this.lastStartIssue);
        return;
      }
      try { releaseLock = acquireRepositoryLock(folders[0].uri.fsPath); }
      catch (error) {
        this.currentState = "blocked_provider";
        this.lastStartIssue = errorMessage(error);
        void vscode.window.showWarningMessage(this.lastStartIssue);
        return;
      }

      let config;
      try {
        config = validateConfiguration({ ...readConfiguration(), ...request?.providers, ...request?.selection,
          ...(request?.executionPermission ? { executionPermission: request.executionPermission } : {}) });
      } catch (error) {
        this.currentState = "failed";
        this.lastStartIssue = errorMessage(error);
        void vscode.window.showErrorMessage(this.lastStartIssue);
        return;
      }
      if (config.provider === "claude") {
        const accounts = await resolveAccountSelection(request?.accounts);
        const status = await new ClaudeCliProvider({
          config,
          accountDir: accounts.claudeConfigDir,
          gateRecord: await loadClaudeGateRecord(),
        }).checkAvailability();
        if (!status.available) {
          this.currentState = "blocked_provider";
          this.lastStartIssue = `${status.reason ?? "Claude CLI is unavailable."} Run Verify Claude Settings Isolation if needed.`;
          void vscode.window.showWarningMessage(this.lastStartIssue);
          return;
        }
      }
      if (controller.signal.aborted) {
        this.currentState = "cancelled";
        return;
      }

      let repository: string;
      let accounts: WorkflowAccountSelection;
      let startingChanges: GitChanges;
      let tracker: WorkspaceChanges;
      try {
        tracker = await createWorkspaceChanges(folders[0].uri.fsPath);
        repository = tracker.root;
        accounts = await resolveAccountSelection(request?.accounts);
        startingChanges = await tracker.read();
      } catch (error) {
        if (error instanceof GitPreflightError) {
          this.currentState = mapPreflightState(error.kind);
          this.logState(this.currentState, error.message);
          void vscode.window.showErrorMessage(error.message);
        } else {
          this.currentState = "failed";
          this.lastStartIssue = errorMessage(error);
          void vscode.window.showErrorMessage(this.lastStartIssue);
        }
        return;
      }
      if (controller.signal.aborted) {
        this.currentState = "cancelled";
        return;
      }

      try {
        const reconciled = await reconcileSelectedModels(config, repository, Boolean(request?.interaction), accounts);
        config = { ...config, claudeModel: reconciled.claudeModel, claudeEffort: reconciled.claudeEffort,
          codexModel: reconciled.codexModel, codexEffort: reconciled.codexEffort };
        for (const warning of reconciled.warnings) {
          this.output.appendLine(`[${new Date().toLocaleTimeString()}] selection: ${warning}`);
          void vscode.window.showWarningMessage(warning);
        }
      } catch (error) {
        this.currentState = "blocked_provider";
        this.lastStartIssue = errorMessage(error);
        void vscode.window.showWarningMessage(this.lastStartIssue);
        return;
      }
      if (controller.signal.aborted) {
        this.currentState = "cancelled";
        return;
      }

      const task = request ? request.task : await vscode.window.showInputBox({
        title: "Countersign",
        prompt: "Describe the development task",
        placeHolder: "What should change?",
        ignoreFocusOut: true,
        validateInput: (value) => value.trim().length === 0 ? "Enter a task description." : undefined,
      });
      if (task === undefined || !task.trim()) {
        this.currentState = "cancelled";
        return;
      }
      if (controller.signal.aborted) {
        this.currentState = "cancelled";
        return;
      }

      let plan: string | undefined;
      const clarifications: NonNullable<BalancedWorkflowResult["clarifications"]> = [];
      const planningMetrics: BalancedWorkflowResult["metrics"] = [];
      if (config.provider === "claude") {
        this.currentState = "awaiting_input";
        const planner = new ClaudeCliProvider({ config, accountDir: accounts.claudeConfigDir,
          gateRecord: await loadClaudeGateRecord() });
        for (let round = 0; round < 4; round++) {
          await assertStartingChanges(tracker, startingChanges);
          const proposal = await planner.proposePlan(repository, task.trim(),
            clarifications.map(({ question, answer }) => ({ question, answer })), controller.signal);
          if (proposal.metrics) planningMetrics.push({ provider: "claude-planning", ...proposal.metrics });
          await assertStartingChanges(tracker, startingChanges);
          if (controller.signal.aborted) { this.currentState = "cancelled"; return; }
          if (proposal.questions.length === 0) { plan = proposal.plan.trim(); break; }
          for (const question of proposal.questions) {
            if (clarifications.length >= 3) throw new Error("Planning stopped after three clarification questions. No files were changed.");
            const answer = request?.interaction
              ? await request.interaction.askQuestion("planning", question, controller.signal)
              : await vscode.window.showInputBox({ title: "Countersign planning question", prompt: question, ignoreFocusOut: true });
            if (controller.signal.aborted || !answer?.trim()) { this.currentState = "cancelled"; return; }
            clarifications.push({ phase: "planning", question, answer: answer.trim().slice(0, 20_000) });
          }
        }
        if (!plan) throw new Error("Claude did not produce a complete plan after the clarification limit. No files were changed.");
      }
      this.currentState = "awaiting_confirmation";
      const checksSummary = config.localChecks.length === 0
        ? "none"
        : config.localChecks.map((check) => `${check.id}: ${check.executable} ${check.args.join(" ")}`.trim()).join("\n");
      const existingGitEntries = tracker.startingEntries.length === 0
        ? ""
        : `\nExisting Git entries:\n${tracker.startingEntries.slice(0, 20).map((entry) => `- ${entry}`).join("\n")}` +
          (tracker.startingEntries.length > 20
            ? `\n…and ${tracker.startingEntries.length - 20} more. The report lists the full set.`
            : "");
      const details = [
        `Workspace: ${repository}`,
        tracker.source === "snapshot"
          ? "No Git repository root is open for this folder: a file snapshot was captured. Changes cannot be reverted from Countersign here. Generated directories are excluded from review and reporting."
          : tracker.source === "git-snapshot"
          ? `Git had ${tracker.startingEntries.length} existing change(s) when this workflow began. A file snapshot records that baseline; Codex reviews only changes made after it. Earlier Git entries are preserved and excluded from review.${existingGitEntries}\nGenerated directories are excluded from review and reporting.`
          : "Git working tree was clean at the start of the workflow.",
        `Task: ${task.trim()}`,
        `Accounts for this task: Claude ${accounts.claudeLabel}; Codex ${accounts.codexLabel}.`,
        `Claude model: ${config.provider === "claude" ? config.claudeModel || "CLI default" : "Mock"}; effort: ${config.provider === "claude" ? config.claudeEffort || "CLI default" : "Mock"}.`,
        `Codex model: ${config.codexProvider === "real" ? config.codexModel || "CLI default" : "Mock"}; reasoning effort: ${config.codexProvider === "real" ? config.codexEffort || "CLI default" : "Mock"}.`,
        config.provider === "mock" ? "Claude tools: mock uses none." : config.executionPermission === "fullAccess"
          ? `After plan approval: Full access. Claude may run commands, use the network and change files outside the workspace without further prompts. MCP remains disabled. The ${tracker.source === "git" ? "Git diff" : "workspace snapshot diff"} covers only reviewable workspace changes.`
          : "After plan approval: Ask before change. Claude may read workspace files; edits, commands and network tools ask for approval in chat or a VS Code dialog. MCP remains disabled.",
        config.provider === "mock" ? `Mock scenario: ${config.mockScenario}` : "No mock scenario is used in the real workflow.",
        `Configured local checks (${config.executionPermission === "askBeforeChange" ? "each asks for permission before running" : "these will run after approval"}):\n${checksSummary}`,
        `Configured check processes may modify files. Their reviewable changes are included in the ${tracker.source === "git" ? "Git diff" : "workspace snapshot diff"}.`,
        `Finding threshold for the correction path: ${config.findingThreshold}`,
        config.provider === "mock"
          ? "Implementation: mock only. Changes are simulated in memory; the mock does not edit files."
          : `Implementation: real Claude CLI (${config.claudeExecutable}) may consume account quota.`,
        config.codexProvider === "real"
          ? `Review: real Codex CLI (${config.codexExecutable}) in a read-only sandbox. It receives the task and ${config.provider === "mock" ? "simulated" : "actual"} workflow diff, can inspect workspace files as context, and may consume account quota. The invocation ignores Codex config.toml and user/project execpolicy rules; CODEX_HOME authentication remains available.`
          : "Review: mock Codex; no AI provider request is made.",
      ].join("\n\n");
      const confirmationLabel = config.provider === "claude" ? "Start Real Workflow" : config.codexProvider === "real" ? "Start Mock + Codex Review" : "Start Mock Workflow";
      const confirmed = request?.interaction
        ? await request.interaction.confirmPlan(plan ?? "No AI plan was requested for this provider pair.", details, controller.signal)
        : await vscode.window.showWarningMessage(
          config.provider === "claude" ? "Start Claude implementation and Codex review?" : config.codexProvider === "real" ? "Send a review request to Codex?" : "Start the mock workflow?",
          { modal: true, detail: `${plan ? `Proposed plan:\n${plan}\n\n` : ""}${details}` }, confirmationLabel) === confirmationLabel;
      if (!confirmed) {
        this.currentState = "cancelled";
        this.lastStartIssue = "Plan was declined. No execution was started.";
        return;
      }
      if (controller.signal.aborted) {
        this.currentState = "cancelled";
        return;
      }

      if (!vscode.workspace.isTrusted) {
        this.currentState = "blocked_untrusted_workspace";
        this.lastStartIssue = "Workspace trust changed before the task started. No workflow was run.";
        void vscode.window.showWarningMessage(this.lastStartIssue);
        return;
      }

      const currentFolders = vscode.workspace.workspaceFolders;
      if (!currentFolders || currentFolders.length !== 1 || currentFolders[0].uri.fsPath !== folders[0].uri.fsPath) {
        this.currentState = "failed";
        this.lastStartIssue = "The workspace changed while confirmation was open. Start again from the intended folder.";
        void vscode.window.showErrorMessage(this.lastStartIssue);
        return;
      }

      let currentConfig;
      try {
        currentConfig = validateConfiguration({ ...readConfiguration(), ...request?.providers, ...request?.selection,
          ...(request?.executionPermission ? { executionPermission: request.executionPermission } : {}) });
      } catch (error) {
        this.currentState = "failed";
        this.lastStartIssue = errorMessage(error);
        void vscode.window.showErrorMessage(this.lastStartIssue);
        return;
      }
      if (JSON.stringify(currentConfig) !== JSON.stringify(config)) {
        this.currentState = "blocked_provider";
        this.lastStartIssue = "The workflow configuration changed after it was shown. Review the settings and start again.";
        void vscode.window.showWarningMessage(this.lastStartIssue);
        return;
      }

      try {
        await assertStartingChanges(tracker, startingChanges);
      } catch (error) {
        if (error instanceof GitPreflightError) {
          this.currentState = mapPreflightState(error.kind);
          this.logState(this.currentState, error.message);
          void vscode.window.showErrorMessage(`Preflight changed before start: ${error.message}`);
        } else {
          this.currentState = "failed";
          this.lastStartIssue = errorMessage(error);
          void vscode.window.showErrorMessage(this.lastStartIssue);
        }
        return;
      }
      if (controller.signal.aborted) {
        this.currentState = "cancelled";
        return;
      }

      if (!request?.interaction) this.output.show(true);
      this.output.appendLine("--- Countersign workflow ---");
      this.output.appendLine(`Workspace: ${repository}`);
      this.output.appendLine(`Mode: ${config.provider} implementation + ${config.codexProvider} review.`);
      this.output.appendLine(`Claude model/effort: ${config.claudeModel || "CLI default"}/${config.claudeEffort || "CLI default"}; Codex model/effort: ${config.codexModel || "CLI default"}/${config.codexEffort || "CLI default"}.`);

      try {
        const claude = config.provider === "claude"
          ? new ClaudeCliProvider({ config, accountDir: accounts.claudeConfigDir,
              gateRecord: await loadClaudeGateRecord(),
              askPermission: request?.interaction?.askPermission ?? (async (tool, detail) =>
                await vscode.window.showWarningMessage(`Allow Claude ${tool}?`, { modal: true, detail }, "Allow once") === "Allow once"),
            })
          : new MockProvider("implementation", config.mockScenario);
        const codex = config.codexProvider === "real"
          ? new CodexCliProvider({
              executable: config.codexExecutable,
              accountDir: accounts.codexHome,
              model: config.codexModel,
              effort: config.codexEffort,
              timeoutMs: config.providerTimeoutMinutes * 60_000,
              gracePeriodMs: config.terminationGracePeriodMs,
            })
          : new MockProvider("review", config.mockScenario);
        const result = await runWorkflow({
          repository,
          task: task.trim(),
          plan,
          clarifications,
          selectedModels: { claudeModel: config.claudeModel, claudeEffort: config.claudeEffort,
            codexModel: config.codexModel, codexEffort: config.codexEffort },
          initialMetrics: planningMetrics,
          startingChanges,
          startingEntries: tracker.startingEntries,
          tracker,
          config,
          claude,
          codex,
          signal: controller.signal,
          askQuestion: request?.interaction?.askQuestion,
          askPermission: request?.interaction?.askPermission ?? (async (tool, detail) =>
            await vscode.window.showWarningMessage(`Allow ${tool}?`, { modal: true, detail }, "Allow once") === "Allow once"),
          onEvent: (event) => { this.onEvent(event); request?.onEvent?.(event); },
        });
        this.currentState = result.state;
        this.latestResult = result;
        this.writeSummary(result);
        if (!request?.interaction) void vscode.window.showInformationMessage(`Countersign: ${result.state}. Open the output or result commands for details.`);
        return result;
      } catch (error) {
        this.currentState = "failed";
        this.lastStartIssue = errorMessage(error);
        this.output.appendLine(`Workflow failed: ${errorMessage(error)}`);
        void vscode.window.showErrorMessage(`Workflow failed: ${errorMessage(error)}`);
      }
    } finally {
      releaseLock?.();
      if (this.activeController === controller) this.activeController = undefined;
    }
    return undefined;
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
      `Implementation provider: ${process.env.COUNTERSIGN_TEST_MODE === "1" ? String(config.get("provider", "claude")) : "claude"}`,
      `Review provider: ${process.env.COUNTERSIGN_TEST_MODE === "1" ? String(config.get("codexProvider", "real")) : "real"}`,
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

  /**
   * The one explicit exception to marker ownership. It deletes metadata only: it does not
   * interrupt a task that may still be alive in another window, does not resume anything,
   * and creates no cross-window lock.
   */
  private async clearStrictInterruptionMarker(): Promise<void> {
    if (this.strictMarkers.ownsActiveTask()) {
      void vscode.window.showWarningMessage(
        "This window owns an active Strict task. Stop it before clearing the interruption marker.");
      return;
    }
    const status = this.strictMarkers.status();
    if (status.kind === "none") {
      void vscode.window.showInformationMessage("No Strict interruption marker is stored.");
      return;
    }
    const detail = [
      describeStrictMarkerStatus(status),
      "Removing it deletes only this metadata. It does not interrupt a task that may still be running in another window, does not resume or repeat anything, and does not create a lock between windows.",
    ].join("\n\n");
    const confirmed = await vscode.window.showWarningMessage(
      "Clear the Strict interruption marker?", { modal: true, detail }, "Clear marker") === "Clear marker";
    if (!confirmed) {
      void vscode.window.showInformationMessage("The Strict interruption marker was kept.");
      return;
    }
    await this.strictMarkers.clear();
    void vscode.window.showInformationMessage(
      "The Strict interruption marker was removed. No task was interrupted or resumed.");
  }

  private onEvent(event: WorkflowEvent): void {
    this.currentState = event.state;
    this.logState(event.state, event.message);
  }

  private logState(state: WorkflowState, message: string): void {
    this.lastStartIssue = message;
    this.output.appendLine(`[${new Date().toLocaleTimeString()}] ${state}: ${message}`);
  }

  private writeSummary(result: BalancedWorkflowResult): void {
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
        const accountDir = new AccountProfiles(this.context.globalState ?? this.context.workspaceState)
          .selected("claude")?.directory;
        const record = await verifyClaudeSettingsGate(config, controller.signal, runExecutable, accountDir);
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

/**
 * Reconciles a saved selection with the catalogue the installed provider actually exposes.
 * A model or a level that is no longer offered is not an error: the turn falls back to the
 * CLI default for it and says so, because a stored preference should never silently decide
 * a run, and should never block one either.
 */
export interface SelectionReconciliation {
  claudeModel: string;
  claudeEffort: string;
  codexModel: string;
  codexEffort: string;
  warnings: string[];
}

async function reconcileSelectedModels(
  config: OrchestratorConfig,
  repository: string,
  requireSubscription = false,
  accounts?: WorkflowAccountSelection,
): Promise<SelectionReconciliation> {
  const result: SelectionReconciliation = {
    claudeModel: config.claudeModel, claudeEffort: config.claudeEffort,
    codexModel: config.codexModel, codexEffort: config.codexEffort, warnings: [],
  };
  if (config.provider === "claude" && (config.claudeModel || requireSubscription)) {
    const info = await inspectClaude(config.claudeExecutable, repository, accounts?.claudeConfigDir);
    const selected = info.models.find((entry) => entry.value === config.claudeModel);
    if (config.claudeModel && !selected) {
      result.warnings.push(`Claude model ${config.claudeModel} is not in this account's catalogue; the CLI default is used.`);
      result.claudeModel = "";
      result.claudeEffort = "";
    } else if (selected && config.claudeEffort && !selected.effortLevels.some((level) => level.value === config.claudeEffort)) {
      result.warnings.push(`Claude effort ${config.claudeEffort} is not offered for ${selected.label}; the CLI default is used.`);
      result.claudeEffort = "";
    }
  }
  if (config.codexProvider === "real" && (config.codexModel || requireSubscription)) {
    const info = await inspectCodex(config.codexExecutable, repository, accounts?.codexHome);
    const selected = info.models.find((entry) => entry.value === config.codexModel);
    if (config.codexModel && !selected) {
      result.warnings.push(`Codex model ${config.codexModel} is not in this account's catalogue; the CLI default is used.`);
      result.codexModel = "";
      result.codexEffort = "";
    } else if (selected && config.codexEffort && !selected.effortLevels.some((level) => level.value === config.codexEffort)) {
      result.warnings.push(`Codex reasoning effort ${config.codexEffort} is not offered for ${selected.label}; the CLI default is used.`);
      result.codexEffort = "";
    }
  }
  return result;
}

async function resolveAccountSelection(input?: WorkflowAccountSelection): Promise<WorkflowAccountSelection> {
  const directory = async (value: string | undefined, provider: string): Promise<string | undefined> => {
    if (value === undefined) return undefined;
    if (!isAbsolute(value)) throw new Error(`${provider} CLI profile must use an absolute directory.`);
    try {
      const canonical = await realpath(value);
      if (!(await stat(canonical)).isDirectory()) throw new Error("not a directory");
      return canonical;
    } catch { throw new Error(`The selected ${provider} CLI profile directory is unavailable.`); }
  };
  return {
    claudeConfigDir: await directory(input?.claudeConfigDir, "Claude"),
    codexHome: await directory(input?.codexHome, "Codex"),
    claudeLabel: input?.claudeLabel?.slice(0, 80) || "Current Claude CLI login",
    codexLabel: input?.codexLabel?.slice(0, 80) || "Current Codex CLI login",
  };
}


function readConfiguration(): Record<string, unknown> {
  const config = vscode.workspace.getConfiguration("countersign");
  const internalTestMode = process.env.COUNTERSIGN_TEST_MODE === "1";
  return {
    provider: internalTestMode ? config.get<unknown>("provider", "claude") : "claude",
    claudeExecutable: config.get<unknown>("claudeExecutable", "claude"),
    codexProvider: internalTestMode ? config.get<unknown>("codexProvider", "real") : "real",
    codexExecutable: config.get<unknown>("codexExecutable", "codex"),
    mockScenario: internalTestMode ? config.get<unknown>("mockScenario", "clean") : "clean",
    executionPermission: config.get<unknown>("executionPermission", "askBeforeChange"),
    claudeAllowedTools: config.get<unknown>("claudeAllowedTools", ["Read", "Glob", "Grep", "Edit", "Write"]),
    localChecks: config.get<unknown>("localChecks", []),
    taskTimeoutMinutes: config.get<unknown>("taskTimeoutMinutes", 30),
    providerTimeoutMinutes: config.get<unknown>("providerTimeoutMinutes", 15),
    checkTimeoutMinutes: config.get<unknown>("checkTimeoutMinutes", 5),
    findingThreshold: config.get<unknown>("findingThreshold", "High"),
    terminationGracePeriodMs: config.get<unknown>("terminationGracePeriodMs", 1000),
  };
}

async function assertStartingChanges(tracker: WorkspaceChanges, starting: GitChanges): Promise<void> {
  const current = await tracker.read();
  if (JSON.stringify(current) !== JSON.stringify(starting)) {
    throw new Error("The working tree changed during planning or approval. Inspect its changes before starting again.");
  }
}

function mapPreflightState(kind: GitPreflightError["kind"]): WorkflowState {
  if (kind === "git_unavailable") return "blocked_provider";
  if (kind === "workspace_mismatch") return "failed";
  return "failed";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error.";
}

let runtime: ExtensionRuntime | undefined;
let chatRuntime: ChatController | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  runtime = new ExtensionRuntime(context);
  try { await runtime.recoverConfirmedMarker(); }
  catch (error) { console.error("Countersign could not clear the confirmed Strict marker:", error); }
  runtime.register();
  chatRuntime = new ChatController(context, {
    start: (request) => runtime!.startChatWorkflow(request),
    startStrict: (request) => runtime!.startStrictWorkflow(request),
    cancel: () => runtime!.cancelChatWorkflow(),
  });
  chatRuntime.register();
}

export async function deactivate(): Promise<void> {
  chatRuntime?.dispose();
  chatRuntime = undefined;
  await runtime?.dispose();
  runtime = undefined;
}

/** A readable rendering of the canonical plan for the chat approval message. */
function planText(plan: import("./shared/strict").StrictPlan): string {
  const canonical = canonicalizeStrictPlan(plan);
  return [
    `Objective: ${canonical.plan.objective}`,
    canonical.plan.constraints.length ? `Constraints:\n${canonical.plan.constraints.map((item) => `- ${item}`).join("\n")}` : "",
    `Acceptance criteria:\n${canonical.plan.acceptanceCriteria.map((item) => `- ${item}`).join("\n")}`,
    `Expected files (${canonical.plan.expectedFilesComplete ? "complete" : "incomplete or not estimable"}):\n${canonical.plan.expectedFiles.map((item) => `- ${item}`).join("\n") || "- none listed"}`,
    canonical.plan.risks.length ? `Risks:\n${canonical.plan.risks.map((item) => `- ${item}`).join("\n")}` : "",
    canonical.plan.checks.length ? `Checks: ${canonical.plan.checks.join(", ")}` : "Checks: none authorised",
    canonical.plan.questions.length
      ? `Decisions:\n${canonical.plan.questions.map((item) => `- ${item.question}: ${item.answer ?? "unanswered"}`).join("\n")}`
      : "",
  ].filter(Boolean).join("\n\n");
}
