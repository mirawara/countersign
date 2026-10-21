import { createHash, randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, resolve, sep } from "node:path";
import * as vscode from "vscode";
import { chatGateMatches, sdkVersion, verifyClaudeChatGate, VERIFIED_CLAUDE_CHAT_CLI, VERIFIED_CLAUDE_CHAT_SDK } from "./claudeChatGate";
import { clearClaudeChatGate, loadClaudeChatGate, saveClaudeChatGate } from "./claudeChatGateStore";
import { inspectClaude, runClaudeTurn } from "./claudeAdapter";
import { inspectCodex, runCodexTurn } from "./codexAdapter";
import { ChatStore } from "./store";
import { ChatApproval, ChatCapability, ChatMessage, ChatProvider } from "./types";
import { ChatView } from "./view";
import { WorkflowEvent, WorkflowResult } from "../shared/types";
import { detailedWorkflowReport } from "../orchestrator/report";
import { acquireRepositoryLock, isRepositoryLocked, onRepositoryLockChange } from "../shared/repositoryLock";
import { preflightGit } from "../context/gitPreflight";
import { readGitChanges } from "../context/gitChanges";
import { ExecutionPermission, WorkflowModelSelection, WorkflowProviderSelection } from "../configuration/config";
import { WorkflowStartRequest } from "../shared/workflowInteraction";

interface FileAttachment {
  path: string;
  selection: string;
}

type Incoming = Record<string, unknown>;

interface WorkflowPrompt {
  id: string;
  kind: "plan" | "question";
  title: string;
  detail: string;
}

export class ChatController implements vscode.Disposable {
  private readonly store: ChatStore;
  private readonly view: ChatView;
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly capabilities = new Map<ChatProvider, ChatCapability>();
  private activeController: AbortController | undefined;
  private attachment: FileAttachment | undefined;
  private notice = "";
  private approval: ChatApproval | undefined;
  private answerApproval: ((accepted: boolean) => void) | undefined;
  private workflowPrompt: WorkflowPrompt | undefined;
  private answerWorkflowPrompt: ((answer: string | boolean | undefined) => void) | undefined;
  private refreshing = false;

  constructor(private readonly context: vscode.ExtensionContext, private readonly workflow: {
    start: (request: WorkflowStartRequest) => Promise<WorkflowResult | undefined>;
    cancel: () => void;
  }) {
    this.store = new ChatStore(context.workspaceState);
    this.view = new ChatView(context.extensionUri, (message) => { void this.onMessage(message); }, () => this.postState());
    // Internal only: the packaged integration test drives it through countersign.chatMockTurn.
    this.capabilities.set("mock", { provider: "mock", available: true, accountLabel: "Mock · no account",
      models: [{ value: "mock", label: "Mock", effortLevels: [] }] });
    this.capabilities.set("claude", { provider: "claude", available: false, accountLabel: "Current Claude login", models: [],
      reason: "Real chat setup is not complete." });
    this.capabilities.set("codex", { provider: "codex", available: false, accountLabel: "Current ChatGPT login", models: [],
      reason: "Checking Codex setup." });
  }

  register(): void {
    this.subscriptions.push(
      vscode.window.registerWebviewViewProvider(ChatView.viewType, this.view),
      { dispose: onRepositoryLockChange(() => this.postState()) },
      vscode.commands.registerCommand("countersign.openChat", () => this.view.reveal()),
      vscode.commands.registerCommand("countersign.newChat", () => this.newThread()),
      vscode.commands.registerCommand("countersign.clearChatHistory", () => this.clearHistory()),
      vscode.commands.registerCommand("countersign.verifyClaudeChatGate", () => this.verifyClaudeGate()),
      vscode.commands.registerCommand("countersign.chatSnapshot", () => {
        const state = this.store.snapshot();
        return { viewResolved: this.view.resolved, threadCount: state.threads.length,
          activeMessageCount: this.store.activeThread().messages.length,
          totalMessageCount: state.threads.reduce((sum, thread) => sum + thread.messages.length, 0),
          lastStatus: this.store.activeThread().messages.at(-1)?.status ?? null };
      }),
      vscode.commands.registerCommand("countersign.chatMockTurn", (text: string) => this.send({
        type: "send", text, provider: "mock", model: "mock", effort: "", mode: "chat",
      })),
    );
    this.context.subscriptions.push(...this.subscriptions);
  }

  dispose(): void {
    this.activeController?.abort();
    this.answerApproval?.(false);
    this.answerWorkflowPrompt?.(undefined);
    for (const subscription of this.subscriptions) subscription.dispose();
  }

  private async onMessage(raw: unknown): Promise<void> {
    if (!isRecord(raw) || typeof raw.type !== "string") return;
    try {
      switch (raw.type) {
        case "refresh": await this.refreshCapabilities(); break;
        case "discover": if (raw.provider === "claude" || raw.provider === "codex") await this.refreshCapabilities(); break;
        case "newThread": await this.newThread(); break;
        case "selectThread":
          if (typeof raw.id === "string" && !this.activeController) {
            await this.store.selectThread(raw.id);
            this.postState();
          }
          break;
        case "deleteThread":
          if (typeof raw.id === "string") await this.deleteThread(raw.id);
          break;
        case "renameThread":
          if (typeof raw.id === "string") await this.renameThread(raw.id);
          break;
        case "exportThread":
          if (typeof raw.id === "string") await this.exportThread(raw.id);
          break;
        case "openDiff":
          if (typeof raw.messageId === "string") await this.openDiff(raw.messageId);
          break;
        case "addMode": await this.addMode(); break;
        case "deleteMode":
          if (typeof raw.id === "string") await this.deleteMode(raw.id);
          break;
        case "addFile": await this.addActiveFile(); break;
        case "cancel": this.activeController?.abort(); break;
        case "approval":
          if (raw.id === this.approval?.id && ["accept", "decline", "cancel"].includes(String(raw.decision))) {
            if (raw.decision === "cancel") this.activeController?.abort();
            else this.answerApproval?.(raw.decision === "accept");
          }
          break;
        case "workflowResponse":
          if (raw.id === this.workflowPrompt?.id) {
            if (raw.decision === "cancel") {
              this.activeController?.abort();
              this.answerWorkflowPrompt?.(undefined);
            } else if (this.workflowPrompt?.kind === "plan" && raw.decision === "confirm") {
              this.answerWorkflowPrompt?.(true);
            } else if (this.workflowPrompt?.kind === "question" && raw.decision === "answer" &&
              typeof raw.answer === "string" && raw.answer.trim().length > 0 && raw.answer.length <= 20_000) {
              this.answerWorkflowPrompt?.(raw.answer.trim());
            }
          }
          break;
        case "send": await this.send(raw); break;
      }
    } catch (error) {
      this.notice = error instanceof Error ? error.message.slice(0, 300) : "Chat action failed.";
      this.postState();
    }
  }

  private async newThread(): Promise<void> {
    if (this.activeController) return;
    await this.store.createThread();
    this.attachment = undefined;
    this.notice = "";
    this.postState();
  }

  private async deleteThread(id: string): Promise<void> {
    if (this.activeController) return;
    const thread = this.store.snapshot().threads.find((entry) => entry.id === id);
    if (!thread) return;
    const choice = await vscode.window.showWarningMessage(`Delete conversation “${thread.title}”?`,
      { modal: true, detail: "Countersign messages and saved diffs are removed. Native Claude/Codex sessions remain in provider storage." }, "Delete");
    if (choice !== "Delete") return;
    await this.deleteArtifacts(thread.messages);
    await this.store.deleteThread(id);
    this.postState();
  }

  private async clearHistory(): Promise<void> {
    if (this.activeController) return;
    const choice = await vscode.window.showWarningMessage("Delete all Countersign chat history in this workspace?",
      { modal: true, detail: "Messages and saved diffs are removed. Custom modes and native provider sessions remain." }, "Delete all");
    if (choice !== "Delete all") return;
    for (const thread of this.store.snapshot().threads) await this.deleteArtifacts(thread.messages);
    await this.store.clear();
    this.attachment = undefined;
    this.notice = "Countersign chat history and diffs deleted; native provider sessions remain.";
    this.postState();
  }

  private async renameThread(id: string): Promise<void> {
    if (this.activeController) return;
    const thread = this.store.snapshot().threads.find((entry) => entry.id === id);
    if (!thread) return;
    const title = await vscode.window.showInputBox({ title: "Rename conversation", value: thread.title,
      validateInput: (value) => value.trim() ? undefined : "Enter a title." });
    if (title === undefined) return;
    await this.store.renameThread(id, title);
    this.postState();
  }

  private async exportThread(id: string): Promise<void> {
    const thread = this.store.snapshot().threads.find((entry) => entry.id === id);
    if (!thread) return;
    const safeName = thread.title.replace(/[^a-zA-Z0-9_-]+/g, "-").slice(0, 40) || "conversation";
    const folder = vscode.workspace.workspaceFolders?.[0]?.uri;
    const destination = await vscode.window.showSaveDialog({ title: "Export conversation summary (may contain repository content)",
      defaultUri: folder ? vscode.Uri.joinPath(folder, `${safeName}.md`) : undefined,
      filters: { Markdown: ["md"] } });
    if (!destination) return;
    const lines = [`# ${thread.title}`, "", `Updated: ${thread.updatedAt}`, "",
      ...thread.messages.slice(-40).flatMap((message) => [
        `## ${message.role}${message.provider ? ` · ${message.provider}` : ""}`,
        "", message.text.slice(0, 4_000), "",
        ...(message.activity?.length ? [`Activity: ${message.activity.slice(-5).join("; ")}`, ""] : []),
      ])];
    await vscode.workspace.fs.writeFile(destination, Buffer.from(lines.join("\n"), "utf8"));
    this.notice = "Conversation summary exported.";
    this.postState();
  }

  private async openDiff(messageId: string): Promise<void> {
    const storage = this.context.storageUri;
    const message = this.store.activeThread().messages.find((entry) => entry.id === messageId);
    if (!storage || !message?.diffArtifact) return;
    const document = await vscode.workspace.openTextDocument(vscode.Uri.joinPath(storage, message.diffArtifact));
    await vscode.window.showTextDocument(document, { preview: true });
  }

  private async addMode(): Promise<void> {
    if (this.activeController) return;
    const label = await vscode.window.showInputBox({ title: "New chat mode", prompt: "Name this mode",
      validateInput: (value) => value.trim() ? undefined : "Enter a name." });
    if (!label) return;
    const instruction = await vscode.window.showInputBox({ title: `Instruction for ${label}`,
      prompt: "Describe how this mode should respond (chat protocol; no automatic checks)",
      validateInput: (value) => value.trim() ? undefined : "Enter an instruction." });
    if (!instruction) return;
    const minutes = await vscode.window.showInputBox({ title: "Maximum time per turn", value: "10",
      validateInput: (value) => /^[1-9]\d?$/.test(value) && Number(value) <= 60 ? undefined : "Enter 1 to 60 minutes." });
    if (!minutes) return;
    const created = await this.store.createMode(label, instruction, Number(minutes));
    this.notice = `Mode “${created.label}” added for this workspace.`;
    this.postState();
  }

  private async deleteMode(id: string): Promise<void> {
    if (this.activeController || !id.startsWith("custom-")) return;
    const mode = this.store.snapshot().modes.find((entry) => entry.id === id);
    if (!mode) return;
    const choice = await vscode.window.showWarningMessage(`Delete mode “${mode.label}”? Existing messages keep their mode label.`,
      { modal: true }, "Delete mode");
    if (choice !== "Delete mode") return;
    await this.store.deleteMode(id);
    this.postState();
  }

  private async deleteArtifacts(messages: ChatMessage[]): Promise<void> {
    const storage = this.context.storageUri;
    if (!storage) return;
    for (const message of messages) {
      if (message.diffArtifact) {
        try { await vscode.workspace.fs.delete(vscode.Uri.joinPath(storage, message.diffArtifact)); }
        catch { /* The artifact may already have been removed. */ }
      }
    }
  }

  private async addActiveFile(): Promise<void> {
    const editor = vscode.window.activeTextEditor;
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!editor || !folder || editor.document.uri.scheme !== "file") {
      this.notice = "Open a file in this workspace to add a reference.";
      this.postState();
      return;
    }
    const root = resolve(folder.uri.fsPath);
    const file = resolve(editor.document.uri.fsPath);
    if (file !== root && !file.startsWith(`${root}${sep}`)) {
      this.notice = "The active file is outside this workspace.";
      this.postState();
      return;
    }
    let canonicalRelative: string;
    try { canonicalRelative = relative(await realpath(root), await realpath(file)); }
    catch {
      this.notice = "The active file cannot be checked.";
      this.postState();
      return;
    }
    if (canonicalRelative === ".." || canonicalRelative.startsWith(`..${sep}`) || isAbsolute(canonicalRelative)) {
      this.notice = "The active file is outside this workspace.";
      this.postState();
      return;
    }
    const selection = editor.selection.isEmpty ? "" : editor.document.getText(editor.selection).slice(0, 8_000);
    this.attachment = { path: relative(root, file), selection };
    this.view.post({ type: "attachment", attachment: this.attachment });
    this.notice = "File reference added to the next message.";
    this.postState();
  }

  private async send(raw: Incoming): Promise<void> {
    if (this.activeController) return;
    const text = typeof raw.text === "string" ? raw.text.trim() : "";
    const provider = raw.provider;
    const model = raw.model;
    const effort = raw.effort;
    const mode = raw.mode;
    const modeDefinition = this.store.snapshot().modes.find((entry) => entry.id === mode);
    if (!text || text.length > 20_000 || !isProvider(provider) || typeof model !== "string" ||
        typeof effort !== "string" || !modeDefinition) {
      this.notice = "Enter a message and choose a supported provider, model and mode.";
      this.postState();
      return;
    }
    let selection: WorkflowModelSelection | undefined;
    let providers: WorkflowProviderSelection | undefined;
    const executionPermission = raw.executionPermission;
    if (provider !== "mock" && executionPermission !== "askBeforeChange" && executionPermission !== "fullAccess") {
      this.notice = "Choose Ask before change or Full access.";
      this.postState();
      return;
    }
    if (modeDefinition.protocol === "balanced") {
      if (raw.agents !== undefined && raw.agents !== "real") {
        this.notice = "Balanced runs the real Claude and Codex agents.";
        this.postState();
        return;
      }
      providers = { provider: "claude", codexProvider: "real" };
    }
    if (modeDefinition.protocol === "balanced" && raw.selection !== undefined) {
      if (!isRecord(raw.selection) || !["claudeModel", "claudeEffort", "codexModel", "codexEffort"]
        .every((key) => typeof raw.selection === "object" &&
          typeof (raw.selection as Record<string, unknown>)[key] === "string" &&
          ((raw.selection as Record<string, string>)[key]).length <= 100)) {
        this.notice = "Choose supported models and effort levels for Balanced.";
        this.postState();
        return;
      }
      selection = raw.selection as WorkflowModelSelection;
    }
    const capability = this.capabilities.get(provider);
    const selected = capability?.models.find((entry) => entry.value === model);
    if (modeDefinition.protocol === "chat" && (!capability?.available || !selected || (effort && !selected.effortLevels.includes(effort)))) {
      this.notice = capability?.reason || "The selected model or effort is unavailable. Refresh providers.";
      this.postState();
      return;
    }
    if ((provider !== "mock" || modeDefinition.protocol === "balanced") && (!vscode.workspace.isTrusted || process.platform !== "linux" ||
        vscode.workspace.workspaceFolders?.length !== 1)) {
      this.notice = "Real chat requires one trusted workspace on verified Linux.";
      this.postState();
      return;
    }
    let releaseLock: (() => void) | undefined;
    if (modeDefinition.protocol === "chat" && provider !== "mock") {
      try { releaseLock = acquireRepositoryLock(vscode.workspace.workspaceFolders![0].uri.fsPath); }
      catch (error) {
        this.notice = error instanceof Error ? error.message : "Repository is busy.";
        this.postState();
        return;
      }
    }
    const controller = new AbortController();
    this.activeController = controller;
    const turnTimer = modeDefinition.protocol === "chat" ? setTimeout(() => controller.abort(),
      (modeDefinition.timeoutMinutes ?? 10) * 60_000) : undefined;
    const threadId = this.store.activeThread().id;
    const incomingAttachment = isRecord(raw.attachment) && raw.attachment.path === this.attachment?.path
      ? this.attachment : undefined;
    this.attachment = undefined;
    const user: ChatMessage = { id: randomUUID(), role: "user", text, createdAt: new Date().toISOString(),
      ...(modeDefinition.protocol === "chat" ? { provider, accountLabel: capability?.accountLabel,
        model, requestedModel: model, requestedEffort: effort || undefined } : {}),
      modeLabel: modeDefinition.label,
      fileRefs: incomingAttachment ? [incomingAttachment.path] : [] };
    const replyId = randomUUID();
    const reply: ChatMessage = { id: replyId, role: "assistant", text: "", createdAt: new Date().toISOString(),
      ...(modeDefinition.protocol === "chat" ? { provider, accountLabel: capability?.accountLabel,
        model, requestedModel: model, requestedEffort: effort || undefined } : {}),
      modeLabel: modeDefinition.label,
      status: "running", activity: [] };
    try {
      const evictedUser = await this.store.append(threadId, user);
      const evictedReply = await this.store.append(threadId, reply);
      await this.deleteArtifacts([evictedUser, evictedReply].filter((entry): entry is ChatMessage => Boolean(entry)));
      this.notice = "";
      this.view.post({ type: "sent" });
      this.postState();
      if (modeDefinition.protocol === "balanced") await this.runBalanced(threadId, replyId, text, providers!, selection,
        executionPermission as ExecutionPermission, controller.signal);
      else if (provider === "mock") await this.runMock(threadId, replyId, text, controller.signal);
      else await this.runReal(provider, threadId, replyId, text, model, effort, incomingAttachment,
        modeDefinition.instruction, executionPermission as ExecutionPermission, controller.signal);
      await this.store.updateMessage(threadId, replyId, { status: controller.signal.aborted ? "cancelled" : "completed" });
    } catch (error) {
      const previousActivity = this.store.activeThread().messages.find((entry) => entry.id === replyId)?.activity ?? [];
      if (!this.store.activeThread().messages.some((entry) => entry.id === replyId)) {
        this.notice = error instanceof Error ? error.message.slice(0, 300) : "Could not start the turn.";
      }
      await this.store.updateMessage(threadId, replyId, { status: controller.signal.aborted ? "cancelled" : "failed",
        text: this.store.activeThread().messages.find((entry) => entry.id === replyId)?.text ||
          (controller.signal.aborted ? "Workflow cancelled." : error instanceof Error ? error.message.slice(0, 2_000) : "Turn failed."),
        activity: [...previousActivity, controller.signal.aborted ? "Turn cancelled." : error instanceof Error
          ? error.message.slice(0, 300) : "Turn failed."] });
    } finally {
      if (turnTimer) clearTimeout(turnTimer);
      releaseLock?.();
      this.answerApproval?.(false);
      this.answerWorkflowPrompt?.(undefined);
      if (this.activeController === controller) this.activeController = undefined;
      this.postState();
    }
  }

  private async runBalanced(threadId: string, replyId: string, task: string,
    providers: WorkflowProviderSelection, selection: WorkflowModelSelection | undefined,
    executionPermission: ExecutionPermission, signal: AbortSignal): Promise<void> {
    const activity: string[] = [];
    const onAbort = (): void => this.workflow.cancel();
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      const result = await this.workflow.start({
        task,
        providers,
        selection,
        executionPermission,
        interaction: {
          askQuestion: (phase: "planning" | "implementing" | "reviewing" | "correcting", question: string,
            requestSignal: AbortSignal) => this.askWorkflowQuestion(threadId, phase, question, requestSignal),
          confirmPlan: (plan: string, details: string, requestSignal: AbortSignal) =>
            this.confirmWorkflowPlan(threadId, plan, details, requestSignal),
          askPermission: (tool: string, detail: string, requestSignal: AbortSignal) =>
            this.askPermission("claude", "tool", tool, detail, requestSignal),
        },
        onEvent: (event: WorkflowEvent) => {
          activity.push(`${event.state}: ${event.message}`.slice(0, 300));
          void this.store.updateMessage(threadId, replyId, { activity: activity.slice(-100) }).then(() => this.postState());
        },
      });
      if (!result) throw new Error("Balanced workflow did not start or was declined.");
      await this.store.updateMessage(threadId, replyId, {
        text: `Workflow finished: ${result.state}. The detailed report is below.`,
        provider: result.implementationProvider,
      });
      const report: ChatMessage = { id: randomUUID(), role: "assistant", text: detailedWorkflowReport(result),
        createdAt: new Date().toISOString(), provider: result.implementationProvider,
        modeLabel: "Balanced report", status: "completed", fileRefs: result.workingTreeEntries.slice(0, 20) };
      const diff = result.diff ?? result.simulatedDiff;
      if (diff) {
        try { report.diffArtifact = await this.saveDiffArtifact(diff); }
        catch { report.text += "\n\nThe diff could not be saved as a chat artifact. Use Countersign: Show Workflow Diff while this VS Code session remains open."; }
      }
      await this.appendWorkflowMessage(threadId, report);
      this.postState();
      if (!["completed_clean", "completed_with_findings", "no_changes"].includes(result.state)) {
        throw new Error(`Balanced workflow ended: ${result.state}.`);
      }
    } finally { signal.removeEventListener("abort", onAbort); }
  }

  private async askWorkflowQuestion(threadId: string, phase: string, question: string,
    signal: AbortSignal): Promise<string | undefined> {
    await this.appendWorkflowMessage(threadId, { id: randomUUID(), role: "assistant",
      text: `Question during ${phase}:\n\n${question}`, createdAt: new Date().toISOString(),
      provider: phase === "reviewing" ? "codex" : "claude", modeLabel: "Balanced" });
    const answer = await this.waitForWorkflowPrompt({ id: randomUUID(), kind: "question",
      title: `Question during ${phase}`, detail: question }, signal);
    if (typeof answer !== "string") return undefined;
    await this.appendWorkflowMessage(threadId, { id: randomUUID(), role: "user", text: answer,
      createdAt: new Date().toISOString(), modeLabel: "Balanced answer" });
    this.postState();
    return answer;
  }

  private async confirmWorkflowPlan(threadId: string, plan: string, details: string,
    signal: AbortSignal): Promise<boolean> {
    await this.appendWorkflowMessage(threadId, { id: randomUUID(), role: "assistant",
      text: `Proposed plan\n\n${plan}\n\nBefore execution\n\n${details}`,
      createdAt: new Date().toISOString(), provider: "claude", modeLabel: "Balanced plan" });
    const answer = await this.waitForWorkflowPrompt({ id: randomUUID(), kind: "plan",
      title: "Review the plan in this chat", detail: "Approve to start the workflow, or cancel without editing files." }, signal);
    if (answer === true) {
      await this.appendWorkflowMessage(threadId, { id: randomUUID(), role: "user", text: "Plan approved. Start execution.",
        createdAt: new Date().toISOString(), modeLabel: "Balanced approval" });
    }
    this.postState();
    return answer === true;
  }

  private async confirmChatPlan(threadId: string, provider: "claude" | "codex", plan: string,
    details: string, signal: AbortSignal): Promise<boolean> {
    await this.appendWorkflowMessage(threadId, { id: randomUUID(), role: "assistant",
      text: `Proposed plan\n\n${plan}\n\n${details}`,
      createdAt: new Date().toISOString(), provider, modeLabel: "Chat plan" });
    const answer = await this.waitForWorkflowPrompt({ id: randomUUID(), kind: "plan",
      title: "Review the plan in this chat", detail: "Approve to start execution, or cancel without executing the plan." }, signal);
    if (answer === true) {
      await this.appendWorkflowMessage(threadId, { id: randomUUID(), role: "user", text: "Plan approved. Start execution.",
        createdAt: new Date().toISOString(), modeLabel: "Chat approval" });
    }
    this.postState();
    return answer === true;
  }

  private waitForWorkflowPrompt(prompt: WorkflowPrompt, signal: AbortSignal): Promise<string | boolean | undefined> {
    if (signal.aborted || this.activeController?.signal.aborted || this.workflowPrompt) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      const onAbort = (): void => finish(undefined);
      const finish = (answer: string | boolean | undefined): void => {
        signal.removeEventListener("abort", onAbort);
        this.activeController?.signal.removeEventListener("abort", onAbort);
        if (this.workflowPrompt?.id === prompt.id) {
          this.workflowPrompt = undefined;
          this.answerWorkflowPrompt = undefined;
          this.postState();
        }
        resolve(answer);
      };
      this.workflowPrompt = prompt;
      this.answerWorkflowPrompt = finish;
      signal.addEventListener("abort", onAbort, { once: true });
      this.activeController?.signal.addEventListener("abort", onAbort, { once: true });
      this.view.reveal();
      this.postState();
    });
  }

  private async saveDiffArtifact(diff: string): Promise<string> {
    const storage = this.context.storageUri;
    if (!storage) throw new Error("Chat artifact storage is unavailable.");
    await vscode.workspace.fs.createDirectory(storage);
    const name = `${randomUUID()}.diff`;
    await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(storage, name), Buffer.from(diff, "utf8"));
    return name;
  }

  private async appendWorkflowMessage(threadId: string, message: ChatMessage): Promise<void> {
    const evicted = await this.store.append(threadId, message);
    if (evicted) await this.deleteArtifacts([evicted]);
  }

  private async runReal(provider: "claude" | "codex", threadId: string, replyId: string, text: string,
    model: string, effort: string, attachment: FileAttachment | undefined, instruction: string | undefined,
    executionPermission: ExecutionPermission, signal: AbortSignal): Promise<void> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder || !vscode.workspace.isTrusted) throw new Error("Workspace trust is required.");
    const cwd = folder.uri.fsPath;
    const threadBefore = this.store.snapshot().threads.find((entry) => entry.id === threadId);
    if (!threadBefore?.repositoryDigest) await preflightGit(cwd);
    else {
      const current = await readGitChanges(cwd);
      const digest = createHash("sha256").update(current.diff).digest("hex");
      if (digest !== threadBefore.repositoryDigest) {
        throw new Error("Repository changed outside this chat turn. Inspect the diff before starting another real turn.");
      }
    }
    const config = vscode.workspace.getConfiguration("countersign");
    const executable = config.get<string>(provider === "claude" ? "claudeExecutable" : "codexExecutable") || provider;
    if (signal.aborted) throw new Error("Turn cancelled.");
    const info = provider === "claude" ? await inspectClaude(executable, cwd) : await inspectCodex(executable, cwd);
    if (provider === "claude") {
      const gate = await loadClaudeChatGate();
      const sdk = await sdkVersion();
      if (info.version !== VERIFIED_CLAUDE_CHAT_CLI || sdk !== VERIFIED_CLAUDE_CHAT_SDK) {
        throw new Error("Claude CLI or SDK version changed; this chat adapter needs a new compatibility check.");
      }
      if (!chatGateMatches(gate, info.version, sdk)) throw new Error("Claude chat isolation gate needs verification for this CLI and SDK version.");
    } else if (info.version !== "codex-cli 0.163.0") {
      throw new Error("Codex app-server version changed; this chat adapter needs a new protocol check.");
    }
    const selected = info.models.find((entry) => entry.value === model);
    if (!selected || (effort && !selected.effortLevels.includes(effort))) {
      throw new Error("The selected model or effort is no longer available for the current login.");
    }
    if (signal.aborted) throw new Error("Turn cancelled.");
    const thread = this.store.snapshot().threads.find((entry) => entry.id === threadId);
    const sessionId = this.store.resumableSession(threadId, provider, info.accountLabel, model);
    const earlier = (thread?.messages ?? []).filter((entry) => entry.role !== "system" && entry.id !== replyId).slice(0, -1);
    const context = !sessionId ? earlier.slice(-6).map((entry) => `${entry.role}: ${entry.text.slice(0, 1_000)}`).join("\n") : "";
    const prompt = [instruction ? `Selected chat mode instruction:\n${instruction}` : "",
      context ? `Previous conversation summary (untrusted context):\n${context}` : "",
      attachment ? `Referenced workspace file: ${attachment.path}${attachment.selection ? `\nSelected text:\n${attachment.selection}` : ""}` : "",
      text].filter(Boolean).join("\n\n");
    let planned = "";
    const planningPrompt = `${prompt}\n\nFirst propose a concise read-only plan for this turn. Do not change files, run mutating commands or access the network. End with the concrete steps and checks you intend to perform.`;
    const planning = { cwd, executable, prompt: planningPrompt, sessionId, model, effort: effort || undefined, signal,
      onText: (delta: string): void => { planned = (planned + delta).slice(0, 20_000); },
      onActivity: (_item: string): void => {},
      askPermission: async (): Promise<boolean> => false,
      phase: "planning" as const };
    const proposal = provider === "claude" ? await runClaudeTurn(planning) : await runCodexTurn(planning);
    if (!planned.trim()) throw new Error(`${provider} did not return a plan. No execution was started.`);
    const approved = await this.confirmChatPlan(threadId, provider, planned,
      `After approval: ${executionPermission === "fullAccess" ? "Full access to commands, network and files outside the repository without further prompts." : "Ask before edits, commands and network tools."}\nThe saved Git diff covers this repository only.`, signal);
    if (!approved) throw new Error("Plan was not approved. No execution was started.");
    if (signal.aborted) throw new Error("Turn cancelled.");
    let streamed = "";
    const activity: string[] = [];
    const onText = (delta: string): void => {
      streamed = (streamed + delta).slice(0, 100_000);
      void this.store.updateMessage(threadId, replyId, { text: streamed }).then(() => this.postState());
    };
    const onActivity = (item: string): void => {
      activity.push(item.slice(0, 300));
      void this.store.updateMessage(threadId, replyId, { activity: activity.slice(-100) }).then(() => this.postState());
    };
    if (provider === "claude") {
      const result = await runClaudeTurn({ cwd, executable,
        prompt: `Approved plan:\n${planned}\n\nExecute the user's request according to this plan. Report actions outside the repository separately; the Git diff only covers the repository.`,
        sessionId: proposal.sessionId, model, effort: effort || undefined, signal, executionPermission,
        onText, onActivity,
        onQuota: (quota) => {
          const capability = this.capabilities.get("claude");
          if (capability) capability.quotaLabel = `${quota.status}${quota.type ? ` (${quota.type})` : ""}`;
          void this.store.updateMessage(threadId, replyId, { quota }).then(() => this.postState());
        },
        askPermission: (tool, detail, requestSignal) => this.askPermission(provider, "tool", tool, detail, requestSignal),
      });
      await this.store.setSession(threadId, provider, result.sessionId, info.accountLabel, model);
      await this.store.updateMessage(threadId, replyId, { model: result.model || model,
        effectiveEffort: result.effectiveEffort, usage: result.usage, quota: result.quota,
        accountLabel: info.accountLabel });
      await this.captureDiff(cwd, threadId, replyId);
    } else {
      const result = await runCodexTurn({ cwd, executable,
        prompt: `Approved plan:\n${planned}\n\nExecute the user's request according to this plan. Report actions outside the repository separately; the Git diff only covers the repository.`,
        sessionId: proposal.sessionId, model, effort: effort || undefined, signal, executionPermission,
        onText, onActivity,
        askPermission: (kind, detail, requestSignal) => this.askPermission(provider, kind, kind, detail, requestSignal),
      });
      await this.store.setSession(threadId, provider, result.sessionId, info.accountLabel, model);
      await this.store.updateMessage(threadId, replyId, { accountLabel: info.accountLabel });
      await this.captureDiff(cwd, threadId, replyId);
    }
  }

  private async captureDiff(cwd: string, threadId: string, replyId: string): Promise<void> {
    const changes = await readGitChanges(cwd);
    const digest = createHash("sha256").update(changes.diff).digest("hex");
    if (!changes.diff) { await this.store.setRepositoryDigest(threadId, digest); return; }
    const storage = this.context.storageUri;
    if (!storage) throw new Error("Chat artifact storage is unavailable.");
    await vscode.workspace.fs.createDirectory(storage);
    const name = `${randomUUID()}.diff`;
    await vscode.workspace.fs.writeFile(vscode.Uri.joinPath(storage, name), Buffer.from(changes.diff, "utf8"));
    await this.store.updateMessage(threadId, replyId, { diffArtifact: name, fileRefs: changes.paths });
    await this.store.setRepositoryDigest(threadId, digest);
  }

  private askPermission(provider: "claude" | "codex", kind: ChatApproval["kind"], summary: string,
    detail: string, signal: AbortSignal): Promise<boolean> {
    const turnSignal = this.activeController?.signal;
    if (!vscode.workspace.isTrusted || signal.aborted || turnSignal?.aborted || this.approval) return Promise.resolve(false);
    return new Promise((resolve) => {
      const id = randomUUID();
      const timer = setTimeout(() => finish(false), 120_000);
      const onAbort = (): void => finish(false);
      const finish = (accepted: boolean): void => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        turnSignal?.removeEventListener("abort", onAbort);
        if (this.approval?.id === id) { this.approval = undefined; this.answerApproval = undefined; this.postState(); }
        resolve(accepted && vscode.workspace.isTrusted);
      };
      this.approval = { id, provider, kind, summary, detail };
      this.answerApproval = finish;
      signal.addEventListener("abort", onAbort, { once: true });
      turnSignal?.addEventListener("abort", onAbort, { once: true });
      this.view.reveal();
      this.postState();
    });
  }

  private async refreshCapabilities(): Promise<void> {
    if (this.refreshing) return;
    this.refreshing = true;
    try {
      const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
      const config = vscode.workspace.getConfiguration("countersign");
      const claudeExecutable = config.get<string>("claudeExecutable") || "claude";
      const codexExecutable = config.get<string>("codexExecutable") || "codex";
      for (const provider of ["claude", "codex"] as const) {
        try {
          if (process.platform !== "linux") throw new Error("Real chat is verified on Linux only.");
          if (provider === "claude") {
            const info = await inspectClaude(claudeExecutable, cwd);
            const gate = await loadClaudeChatGate();
            const sdk = await sdkVersion();
            const compatible = info.version === VERIFIED_CLAUDE_CHAT_CLI && sdk === VERIFIED_CLAUDE_CHAT_SDK;
            const passed = compatible && chatGateMatches(gate, info.version, sdk);
            this.capabilities.set(provider, { provider, available: passed, accountLabel: info.accountLabel,
              models: info.models, version: info.version, quotaLabel: "Unavailable",
              reason: passed ? undefined : compatible
                ? "Run Countersign: Verify Claude Chat Isolation for this CLI and SDK version."
                : "Claude chat requires verified CLI 2.1.109 and SDK 0.3.306." });
          } else {
            const info = await inspectCodex(codexExecutable, cwd);
            const passed = info.version === "codex-cli 0.163.0";
            this.capabilities.set(provider, { provider, available: passed, accountLabel: info.accountLabel,
              models: info.models, version: info.version, quotaLabel: "Unavailable",
              reason: passed ? undefined : "Codex app-server needs the verified CLI 0.163.0." });
          }
        } catch (error) {
          this.capabilities.set(provider, { provider, available: false, accountLabel: "Unavailable", models: [],
            reason: error instanceof Error ? error.message.slice(0, 200) : "Provider check failed." });
        }
        this.postState();
      }
    } finally { this.refreshing = false; }
  }

  private async verifyClaudeGate(): Promise<void> {
    if (this.activeController) return;
    const choice = await vscode.window.showWarningMessage(
      "Verify Claude chat isolation with two short requests in a temporary repository? This uses your Claude subscription quota.",
      { modal: true }, "Run verification");
    if (choice !== "Run verification") return;
    try {
      const executable = vscode.workspace.getConfiguration("countersign").get<string>("claudeExecutable") || "claude";
      const record = await verifyClaudeChatGate(executable);
      await saveClaudeChatGate(record);
      this.notice = `Claude chat isolation passed for SDK ${record.sdkVersion}, CLI ${record.cliVersion}.`;
    } catch (error) {
      await clearClaudeChatGate();
      this.notice = error instanceof Error ? error.message.slice(0, 300) : "Isolation verification failed.";
    }
    await this.refreshCapabilities();
  }

  private async runMock(threadId: string, replyId: string, prompt: string, signal: AbortSignal): Promise<void> {
    const parts = ["Mock turn started. ", `Received ${prompt.length} characters. `, "No files were changed."];
    let text = "";
    for (const part of parts) {
      if (signal.aborted) return;
      await new Promise((resolve) => setTimeout(resolve, 40));
      if (signal.aborted) return;
      text += part;
      await this.store.updateMessage(threadId, replyId, { text });
      this.postState();
    }
  }

  private postState(): void {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const offered = [...this.capabilities.values()].filter((entry) => entry.provider !== "mock");
    this.view.post({ type: "state", state: this.store.snapshot(), capabilities: offered,
      busy: Boolean(this.activeController), repositoryBusy: root ? isRepositoryLocked(root) : false,
      approval: this.approval ?? null, workflowPrompt: this.workflowPrompt ?? null, notice: this.notice });
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isProvider(value: unknown): value is ChatProvider {
  return value === "mock" || value === "claude" || value === "codex";
}
