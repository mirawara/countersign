import { randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import * as vscode from "vscode";
import { chatGateMatches, sdkVersion, verifyClaudeChatGate, VERIFIED_CLAUDE_CHAT_CLI, VERIFIED_CLAUDE_CHAT_SDK } from "./claudeChatGate";
import { clearClaudeChatGate, loadClaudeChatGate, saveClaudeChatGate } from "./claudeChatGateStore";
import { inspectClaude, inspectClaudeAccount } from "./claudeAdapter";
import { inspectCodex, inspectCodexAccount } from "./codexAdapter";
import { ChatStore } from "./store";
import { ChatApproval, ChatCapability, ChatMessage, ChatProvider } from "./types";
import { ChatView } from "./view";
import { AccountProfiles, AccountProvider } from "./accountProfiles";
import { BalancedWorkflowResult, WorkflowEvent } from "../shared/types";
import { detailedWorkflowReport } from "../orchestrator/report";
import { isRepositoryLocked, onRepositoryLockChange } from "../shared/repositoryLock";
import { CavemanStyle, ExecutionPermission, WorkflowModelSelection, WorkflowProviderSelection } from "../configuration/config";
import {
  StrictPlanApprovalAnswer, StrictPlanPromptData, StrictWorkflowStartRequest, WorkflowStartRequest,
  WorkflowAccountSelection,
  StrictApprovedContinuation,
} from "../shared/workflowInteraction";
import { StrictConsensus, StrictHumanApproval, StrictPlan, StrictWorkflowResult } from "../shared/strict";

interface FileAttachment {
  path: string;
  selection: string;
}

type Incoming = Record<string, unknown>;

interface WorkflowPrompt {
  id: string;
  kind: "plan" | "question" | "strictPlan" | "pause";
  title: string;
  detail: string;
  /** The informational file estimate and permission control shown with a Strict plan. */
  strict?: StrictPlanPromptData;
}

type WorkflowPromptAnswer = string | boolean | StrictPlanApprovalAnswer | "resume" | "stop" | undefined;

interface TurnSettings {
  mode: "balanced" | "strict";
  executionPermission: ExecutionPermission;
  cavemanStyle: CavemanStyle;
  selection: WorkflowModelSelection;
}

interface LiveTask {
  label: string;
  since: number;
}

const TURN_SETTINGS_KEY = "countersign.turnSettings.v1";

export class ChatController implements vscode.Disposable {
  private readonly sessionId = randomUUID();
  private readonly store: ChatStore;
  private readonly accounts: AccountProfiles;
  private readonly view: ChatView;
  private readonly subscriptions: vscode.Disposable[] = [];
  private readonly capabilities = new Map<ChatProvider, ChatCapability>();
  private readonly accountEmails = new Map<string, string | null>();
  private turnSettings: TurnSettings;
  private turnSettingsStored: boolean;
  private settingsSave: Promise<void> = Promise.resolve();
  private identitiesRefreshing = false;
  private identitiesRefreshPending = false;
  private liveTask: LiveTask | undefined;
  private activeController: AbortController | undefined;
  private sending = false;
  private attachment: FileAttachment | undefined;
  private notice = "";
  private approval: ChatApproval | undefined;
  private answerApproval: ((accepted: boolean) => void) | undefined;
  private workflowPrompt: WorkflowPrompt | undefined;
  private answerWorkflowPrompt: ((answer: WorkflowPromptAnswer) => void) | undefined;
  private refreshing = false;
  private refreshPending = false;

  constructor(private readonly context: vscode.ExtensionContext, private readonly workflow: {
    start: (request: WorkflowStartRequest) => Promise<BalancedWorkflowResult | undefined>;
    startStrict?: (request: StrictWorkflowStartRequest) => Promise<StrictWorkflowResult>;
    cancel: () => void;
  }) {
    this.store = new ChatStore(context.workspaceState);
    this.accounts = new AccountProfiles(context.globalState ?? context.workspaceState);
    const storedTurnSettings = context.workspaceState.get<unknown>(TURN_SETTINGS_KEY);
    this.turnSettingsStored = storedTurnSettings !== undefined;
    this.turnSettings = restoreTurnSettings(storedTurnSettings, configuredCavemanStyle());
    this.view = new ChatView(context.extensionUri, (message) => { void this.onMessage(message); }, () => this.postState());
    if (process.env.COUNTERSIGN_TEST_MODE === "1") {
      this.capabilities.set("mock", { provider: "mock", available: true, accountLabel: "Test provider",
        models: [{ value: "mock", label: "Test provider", effortLevels: [] }] });
    }
    this.capabilities.set("claude", { provider: "claude", available: false, accountLabel: "Current Claude login", models: [],
      reason: "Real chat setup is not complete." });
    this.capabilities.set("codex", { provider: "codex", available: false, accountLabel: "Current ChatGPT login", models: [],
      reason: "Checking Codex setup." });
  }

  register(): void {
    this.subscriptions.push(
      vscode.window.registerWebviewViewProvider(ChatView.viewType, this.view,
        { webviewOptions: { retainContextWhenHidden: true } }),
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
    );
    if (process.env.COUNTERSIGN_TEST_MODE === "1") {
      this.subscriptions.push(vscode.commands.registerCommand("countersign.chatMockTurn", (text: string) => this.mockChatTranscript(text)));
    }
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
        case "refresh":
          void this.refreshAccountIdentities();
          await this.refreshCapabilities();
          break;
        case "turnSettings":
          if (!this.activeController) await this.saveTurnSettings(raw.settings);
          break;
        case "selectAccount":
          if (!this.activeController && !this.sending && accountProvider(raw.provider) && typeof raw.id === "string") {
            await this.accounts.select(raw.provider, raw.id);
            this.clearAccountCapability(raw.provider);
            this.postState();
            void this.refreshAccountIdentities();
            await this.refreshCapabilities();
          }
          break;
        case "addAccount":
          if (!this.activeController && !this.sending && accountProvider(raw.provider)) await this.addAccount(raw.provider);
          break;
        case "loginAccount":
          if (!this.activeController && !this.sending && accountProvider(raw.provider)) this.openLoginTerminal(raw.provider);
          break;
        case "removeAccount":
          if (!this.activeController && !this.sending && accountProvider(raw.provider)) {
            const selected = this.accounts.selected(raw.provider);
            if (selected) {
              await this.accounts.remove(raw.provider, selected.id);
              this.clearAccountCapability(raw.provider);
              this.notice = `Removed ${selected.label} from Countersign. CLI files were left in place.`;
              this.postState();
              void this.refreshAccountIdentities();
              await this.refreshCapabilities();
            }
          }
          break;
        case "newThread": await this.newThread(); break;
        case "selectThread":
          if (typeof raw.id === "string" && !this.activeController && !this.sending) {
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
        case "continueStrict":
          if (typeof raw.messageId === "string") await this.continueStrict(raw.messageId);
          break;
        case "addFile": await this.addActiveFile(); break;
        case "cancel":
          this.setLiveTask("Stopping task");
          this.activeController?.abort();
          break;
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
            } else if (this.workflowPrompt?.kind === "pause" && (raw.decision === "resume" || raw.decision === "stop")) {
              this.answerWorkflowPrompt?.(raw.decision);
            } else if (this.workflowPrompt?.kind === "strictPlan") {
              this.answerWorkflowPrompt?.(strictApprovalFrom(raw, this.workflowPrompt.strict));
            }
          }
          break;
        case "send":
          if (this.sending) break;
          this.sending = true;
          this.postState();
          try { await this.send(raw); }
          finally { this.sending = false; this.postState(); }
          break;
      }
    } catch (error) {
      this.notice = error instanceof Error ? error.message.slice(0, 300) : "Chat action failed.";
      this.postState();
    }
  }

  private async newThread(): Promise<void> {
    if (this.activeController || this.sending) return;
    await this.store.createThread();
    this.attachment = undefined;
    this.notice = "";
    this.postState();
  }

  private async deleteThread(id: string): Promise<void> {
    if (this.activeController || this.sending) return;
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
    if (this.activeController || this.sending) return;
    const choice = await vscode.window.showWarningMessage("Delete all Countersign chat history in this workspace?",
      { modal: true, detail: "Messages and saved diffs are removed. Native provider sessions remain." }, "Delete all");
    if (choice !== "Delete all") return;
    for (const thread of this.store.snapshot().threads) await this.deleteArtifacts(thread.messages);
    await this.store.clear();
    this.attachment = undefined;
    this.notice = "Countersign chat history and diffs deleted; native provider sessions remain.";
    this.postState();
  }

  private async addAccount(provider: AccountProvider): Promise<void> {
    const action = await vscode.window.showQuickPick([
      { label: "Use an existing CLI profile", value: "existing" as const,
        description: "Choose a directory already authenticated by the provider CLI" },
      { label: "Sign in to a new CLI profile", value: "new" as const,
        description: "Create a separate local directory and open the provider login" },
    ], { title: `Add ${provider === "claude" ? "Claude" : "Codex"} account` });
    if (!action) return;
    let directory: string | undefined;
    if (action.value === "existing") {
      const picked = await vscode.window.showOpenDialog({ title: "Choose the CLI profile directory",
        canSelectFolders: true, canSelectFiles: false, canSelectMany: false });
      directory = picked?.[0]?.fsPath;
      if (!directory) return;
    }
    const label = await vscode.window.showInputBox({ title: "Account label in Countersign",
      value: directory ? basename(directory) : provider === "claude" ? "Claude account" : "Codex account",
      validateInput: (value) => value.trim() ? undefined : "Enter a label." });
    if (label === undefined) return;
    const profile = directory
      ? await this.accounts.addExisting(provider, label, directory)
      : await this.accounts.create(provider, label);
    this.clearAccountCapability(provider);
    this.notice = `${profile.label} selected. ${directory ? "Press Refresh to check its CLI login." : "Complete login in the terminal, then press Refresh."}`;
    this.postState();
    if (!directory) this.openLoginTerminal(provider, profile);
    else {
      void this.refreshAccountIdentities();
      await this.refreshCapabilities();
    }
  }

  private openLoginTerminal(provider: AccountProvider, profile = this.accounts.selected(provider)): void {
    this.clearAccountCapability(provider);
    const config = vscode.workspace.getConfiguration("countersign");
    const executable = config.get<string>(provider === "claude" ? "claudeExecutable" : "codexExecutable") || provider;
    const env: Record<string, string | null> = {
      ANTHROPIC_API_KEY: null, ANTHROPIC_AUTH_TOKEN: null, OPENAI_API_KEY: null, CODEX_API_KEY: null,
    };
    if (profile) env[provider === "claude" ? "CLAUDE_CONFIG_DIR" : "CODEX_HOME"] = profile.directory;
    const terminal = vscode.window.createTerminal({
      name: `${provider === "claude" ? "Claude" : "Codex"} login · ${profile?.label ?? "CLI default"}`,
      cwd: tmpdir(), env,
    });
    const args = provider === "claude" ? ["auth", "login"]
      : profile ? ["login", "--config", 'cli_auth_credentials_store="file"'] : ["login"];
    terminal.show();
    terminal.sendText([executable, ...args].map(shellQuote).join(" "));
    this.notice = "Finish the provider CLI login in the terminal, then press Refresh in Turn settings.";
    this.postState();
  }

  private clearAccountCapability(provider: AccountProvider): void {
    this.capabilities.set(provider, { provider, available: false,
      accountLabel: "Checking selected CLI login", models: [], reason: "Press Refresh to check this CLI login." });
  }

  private async renameThread(id: string): Promise<void> {
    if (this.activeController || this.sending) return;
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
    const continuation = typeof raw.resumeMessageId === "string"
      ? this.strictContinuation(raw.resumeMessageId) : undefined;
    if (isRecord(raw.accounts)) {
      for (const provider of ["claude", "codex"] as const) {
        const id = raw.accounts[provider];
        if (typeof id !== "string") throw new Error(`Choose a ${provider} account profile.`);
        await this.accounts.select(provider, id);
      }
    }
    const text = continuation?.displayText ?? (typeof raw.text === "string" ? raw.text.trim() : "");
    if (!text || text.length > 100_000) {
      this.notice = "Enter a task of up to 100,000 characters.";
      this.postState();
      return;
    }
    let selection: WorkflowModelSelection | undefined;
    const providers: WorkflowProviderSelection = { provider: "claude", codexProvider: "real" };
    const executionPermission = raw.executionPermission;
    if (executionPermission !== "askBeforeChange" && executionPermission !== "fullAccess") {
      this.notice = "Choose Ask before change or Full access.";
      this.postState();
      return;
    }
    const cavemanStyle = raw.cavemanStyle ?? this.turnSettings.cavemanStyle;
    if (cavemanStyle !== "auto" && cavemanStyle !== "always" && cavemanStyle !== "internalOnly") {
      this.notice = "Choose a Caveman style for the turn.";
      this.postState();
      return;
    }
    if (raw.selection !== undefined) {
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
    const mode = continuation ? "strict"
      : raw.mode === "strict" ? "strict" : raw.mode === "balanced" ? "balanced" : this.turnSettings.mode;
    if (mode === "strict" && !this.workflow.startStrict) {
      this.notice = "Strict is not available in this window.";
      this.postState();
      return;
    }
    if (!vscode.workspace.isTrusted || process.platform !== "linux" ||
        vscode.workspace.workspaceFolders?.length !== 1) {
      this.notice = `${mode === "strict" ? "Strict" : "Balanced"} requires one trusted workspace on verified Linux.`;
      this.postState();
      return;
    }
    await this.saveTurnSettings({ mode, executionPermission, cavemanStyle,
      selection: selection ?? this.turnSettings.selection });
    const controller = new AbortController();
    this.activeController = controller;
    this.liveTask = { label: `Starting ${mode === "strict" ? "Strict" : "Balanced"} task`, since: Date.now() };
    const threadId = this.store.activeThread().id;
    const incomingAttachment = isRecord(raw.attachment) && raw.attachment.path === this.attachment?.path
      ? this.attachment : undefined;
    this.attachment = undefined;
    const task = continuation?.task ?? (incomingAttachment
      ? `${text}\n\nReferenced workspace file: ${incomingAttachment.path}${incomingAttachment.selection
        ? `\nSelected text:\n${incomingAttachment.selection}` : ""}`
      : text);
    const modeLabel = mode === "strict" ? "Strict" : "Balanced";
    const selectedAccounts = this.accounts.snapshot().selected;
    const accounts = this.accounts.selection({
      claude: this.accountEmails.get(`claude:${selectedAccounts.claude}`) ?? undefined,
      codex: this.accountEmails.get(`codex:${selectedAccounts.codex}`) ?? undefined,
    });
    const accountLabel = `Claude: ${accounts.claudeLabel}; Codex: ${accounts.codexLabel}`;
    const user: ChatMessage = { id: randomUUID(), role: "user", text, createdAt: new Date().toISOString(),
      modeLabel, accountLabel,
      fileRefs: incomingAttachment ? [incomingAttachment.path] : [] };
    const replyId = randomUUID();
    const reply: ChatMessage = { id: replyId, role: "assistant", text: "", createdAt: new Date().toISOString(),
      modeLabel, accountLabel,
      status: "running", activity: [] };
    try {
      const evictedUser = await this.store.append(threadId, user);
      const evictedReply = await this.store.append(threadId, reply);
      await this.deleteArtifacts([evictedUser, evictedReply].filter((entry): entry is ChatMessage => Boolean(entry)));
      this.notice = "";
      this.view.post({ type: "sent" });
      this.postState();
      if (mode === "strict") {
        await this.runStrict(threadId, replyId, task, selection, accounts, executionPermission, controller.signal,
          continuation?.plan, continuation?.approved);
      } else {
        await this.runBalanced(threadId, replyId, task, providers, selection, accounts, executionPermission, controller.signal);
      }
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
      this.answerApproval?.(false);
      this.answerWorkflowPrompt?.(undefined);
      if (this.activeController === controller) this.activeController = undefined;
      this.liveTask = undefined;
      this.postState();
      void this.refreshCapabilities();
    }
  }

  private async continueStrict(messageId: string): Promise<void> {
    if (this.activeController || this.sending) return;
    // Resolve before starting a task so a stale, malformed or foreign report never
    // becomes an instruction to a provider.
    const continuation = this.strictContinuation(messageId);
    if (continuation.approved && continuation.quotaStop) {
      await this.refreshAccountIdentities();
      const choices = this.accounts.snapshot();
      const provider = continuation.quotaProvider;
      const name = provider === "codex" ? "Codex" : "Claude";
      const options = [
        ...choices.profiles.filter((profile) => profile.provider === provider && profile.id !== choices.selected[provider])
          .map((profile) => ({ id: profile.id, label: profile.label, directory: profile.directory })),
        { id: "default", label: `Current ${name} CLI login`, directory: "Default CLI profile" },
        ...choices.profiles.filter((profile) => profile.provider === provider && profile.id === choices.selected[provider])
          .map((profile) => ({ id: profile.id, label: profile.label, directory: profile.directory })),
      ].filter((option, index, all) => all.findIndex((item) => item.id === option.id) === index);
      const executable = vscode.workspace.getConfiguration("countersign")
        .get<string>(provider === "claude" ? "claudeExecutable" : "codexExecutable") || provider;
      const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
      await Promise.all(options.map(async (option) => {
          try {
            const directory = option.id === "default" ? undefined : option.directory;
            const email = provider === "claude"
              ? await inspectClaudeAccount(executable, cwd, directory)
              : await inspectCodexAccount(executable, cwd, directory);
            this.accountEmails.set(`${provider}:${option.id}`, email ?? null);
          } catch { this.accountEmails.set(`${provider}:${option.id}`, null); }
        }));
      const picked = await vscode.window.showQuickPick([...options.map((option) => ({
        label: option.label,
        description: this.accountEmails.get(`${provider}:${option.id}`) ||
          (option.id === choices.selected[provider] ? this.capabilities.get(provider)?.accountEmail : undefined) ||
          "Email unavailable",
        detail: option.directory,
        id: option.id,
      })), { id: "__add__", label: `Add or sign in to another ${name} account`,
        description: "Import a CLI profile or open the official login" }],
      { title: `Choose the ${name} account for the approved Strict plan`,
        placeHolder: "The workspace must still match the approved baseline" });
      if (!picked) return;
      if (picked.id === "__add__") {
        await this.addAccount(provider);
        this.notice = `Finish the ${name} login if needed, then use Change account and resume again.`;
        this.postState();
        return;
      }
      await this.accounts.select(provider, picked.id);
      this.clearAccountCapability(provider);
      this.postState();
    }
    this.view.reveal();
    await this.onMessage({ type: "send", resumeMessageId: messageId, mode: "strict",
      selection: this.turnSettings.selection,
      executionPermission: continuation.approved?.humanApproval.executionPermission ??
        this.turnSettings.executionPermission });
  }

  private strictContinuation(messageId: string): {
    displayText: string; task: string; plan?: StrictPlan;
    approved?: StrictApprovedContinuation; quotaProvider: AccountProvider; quotaStop: boolean;
  } {
    const thread = this.store.activeThread();
    const index = thread.messages.findIndex((message) => message.id === messageId);
    const report = thread.messages[index];
    if (!report || report.modeLabel !== "Strict report" || !report.text.includes("Strict workflow report")) {
      throw new Error("Choose a Strict report in this conversation.");
    }
    if (/^Status: completed_clean$/m.test(report.text)) {
      throw new Error("That Strict task already completed cleanly.");
    }
    const repository = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const reportedRepository = report.strictContinuation?.repository ?? report.text.match(/^Workspace: (.+)$/m)?.[1];
    if (!repository || repository !== reportedRepository) {
      throw new Error("Open the workspace named in this Strict report before continuing.");
    }
    const saved = report.strictContinuation;
    const quotaStop = /^Reason: quota_exhausted\b/m.test(report.text);
    const timedOut = /^Reason: timed_out\b/m.test(report.text);
    const quotaProvider: AccountProvider = /^Reason: quota_exhausted — Codex\b/m.test(report.text)
      ? "codex" : "claude";
    if (saved) {
      const approval = saved.baselineDigest && (quotaStop || timedOut)
        ? saved.approved ?? legacyApprovedContinuation(report.text, saved.planHash) : undefined;
      const approved: StrictApprovedContinuation | undefined = approval && saved.baselineDigest
        ? { plan: saved.plan, planHash: saved.planHash, baselineDigest: saved.baselineDigest,
          baselineHead: saved.baselineHead ?? reportBaselineHead(report.text),
          consensus: approval.consensus, humanApproval: approval.humanApproval,
          preExistingEntries: saved.preExistingEntries ?? reportPreExistingEntries(report.text) } : undefined;
      return {
        displayText: approved
          ? `Resume approved Strict plan ${saved.planHash.slice(0, 12)}…${quotaStop ? ` with another ${quotaProvider === "codex" ? "Codex" : "Claude"} account` : " after the interrupted provider turn"}. Strict verifies any partial files against the approved baseline before a provider call.\n\nOriginal task:\n${saved.task}`
          : `Continue the saved Strict draft ${saved.planHash.slice(0, 12)}… in a new task. Claude and Codex must approve it again before implementation.\n\nOriginal task:\n${saved.task}`,
        task: saved.task,
        plan: saved.plan,
        approved,
        quotaProvider,
        quotaStop,
      };
    }
    // Reports made before this feature have only the human-readable last draft.
    // Re-use it as context for a fresh proposal; never invent missing structured
    // fields or claim to resume its old hash or approvals.
    const previousUser = thread.messages.slice(0, index).reverse()
      .find((message) => message.role === "user" && message.modeLabel === "Strict")?.text;
    const originalTask = previousUser ?? report.text.match(/^Task: (.+)$/m)?.[1];
    const history = report.text.split("## Plan history\n")[1]?.split("\n## Plan consensus")[0] ?? "";
    const revisions = [...history.matchAll(/(?:^|\n)\d+\. (?:initial|continued|provider_revision|human_revision) at /g)];
    const lastDraft = revisions.length > 0 ? history.slice(revisions.at(-1)!.index).trim().slice(0, 15_000) : "";
    if (!originalTask || !lastDraft) {
      throw new Error("This older report has no reusable plan draft. Start a new Strict task with its objective.");
    }
    const task = `${originalTask.slice(0, 70_000)}\n\nPrevious Strict draft (context only; not approved or complete):\n${lastDraft}\n\nReinspect the current workspace. Correct outdated paths and names in that draft before proposing a new canonical plan. Do not treat any previous approval as valid.`;
    return { displayText: task, task, quotaProvider, quotaStop };
  }

  private async runBalanced(threadId: string, replyId: string, task: string,
    providers: WorkflowProviderSelection, selection: WorkflowModelSelection | undefined,
    accounts: WorkflowAccountSelection,
    executionPermission: ExecutionPermission, signal: AbortSignal): Promise<void> {
    const activity: string[] = [];
    const onAbort = (): void => this.workflow.cancel();
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      const result = await this.workflow.start({
        task,
        providers,
        selection,
        accounts,
        executionPermission,
        cavemanStyle: this.turnSettings.cavemanStyle,
        interaction: {
          askQuestion: (phase: "planning" | "implementing" | "reviewing" | "correcting", question: string,
            requestSignal: AbortSignal) => this.askWorkflowQuestion(threadId, phase, question, requestSignal),
          confirmPlan: (plan: string, details: string, requestSignal: AbortSignal) =>
            this.confirmWorkflowPlan(threadId, plan, details, requestSignal),
          askPermission: (tool: string, detail: string, requestSignal: AbortSignal) =>
            this.askPermission("claude", "tool", tool, detail, requestSignal),
        },
        onEvent: (event: WorkflowEvent) => {
          this.setLiveTask(`Balanced · ${event.state.replace(/_/g, " ")}`);
          activity.push(`${event.state}: ${event.message}`.slice(0, 300));
          void this.store.updateMessage(threadId, replyId, { activity: activity.slice(-100) }).then(() => this.postState());
        },
      });
      if (!result) throw new Error("Balanced workflow did not start or was declined.");
      this.setLiveTask("Preparing Balanced report");
      await this.store.updateMessage(threadId, replyId, {
        text: `Workflow finished: ${result.state}. The detailed report is below.`,
        provider: result.implementationProvider,
      });
      const report: ChatMessage = { id: randomUUID(), role: "assistant",
        text: `Selected CLI profiles: Claude ${accounts.claudeLabel}; Codex ${accounts.codexLabel}.\n\n${detailedWorkflowReport(result)}`,
        createdAt: new Date().toISOString(), provider: result.implementationProvider,
        modeLabel: "Balanced report", accountLabel: `Claude: ${accounts.claudeLabel}; Codex: ${accounts.codexLabel}`,
        status: "completed", fileRefs: result.workingTreeEntries.slice(0, 20) };
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

  /**
   * One Strict task driven from the sidebar. The plan, the consensus, the questions, the
   * limits and pauses are all visible in the chat. A stopped provider session never
   * resumes; a saved approved plan can start a fresh phase B on an identical baseline.
   */
  private async runStrict(threadId: string, replyId: string, task: string,
    selection: WorkflowModelSelection | undefined, accounts: WorkflowAccountSelection,
    executionPermission: ExecutionPermission,
    signal: AbortSignal, continuedPlan?: StrictPlan,
    approvedContinuation?: StrictApprovedContinuation): Promise<void> {
    const startStrict = this.workflow.startStrict;
    if (!startStrict) throw new Error("Strict is not available in this window.");
    const activity: string[] = [];
    const onAbort = (): void => this.workflow.cancel();
    signal.addEventListener("abort", onAbort, { once: true });
    try {
      const result = await startStrict({
        task,
        continuedPlan: approvedContinuation ? undefined : continuedPlan,
        approvedContinuation,
        selection,
        accounts,
        executionPermission,
        cavemanStyle: this.turnSettings.cavemanStyle,
        signal,
        onEvent: (event) => {
          this.setLiveTask(`Strict phase ${event.phase === "plan" ? "A" : "B"} · ${event.state.replace(/_/g, " ")}`);
          activity.push(`${event.state} (phase ${event.phase === "plan" ? "A" : "B"}): ${event.message}`.slice(0, 300));
          void this.store.updateMessage(threadId, replyId, { activity: activity.slice(-100) }).then(() => this.postState());
        },
        interaction: {
          askQuestion: (question, requestSignal) =>
            this.askWorkflowQuestion(threadId, "planning", question, requestSignal, "Strict"),
          approvePlan: (data, requestSignal) => this.approveStrictPlan(threadId, data, requestSignal),
          onPause: (detail, requestSignal) => this.handleStrictPause(threadId, detail, requestSignal),
          askPermission: (tool, detail, requestSignal) =>
            this.askPermission("claude", "tool", tool, detail, requestSignal),
        },
      });
      const providerRequests = result.budget.plan.providerRequests + result.budget.implementation.providerRequests;
      const stoppedBeforeAgents = result.state !== "completed_clean" && providerRequests === 0 &&
        result.sessions.length === 0;
      if (!stoppedBeforeAgents) this.setLiveTask("Preparing Strict report");
      await this.store.updateMessage(threadId, replyId, {
        text: stoppedBeforeAgents
          ? `Strict could not start: ${result.reason?.message ?? result.message}\n\n${result.reason?.nextAction ?? "Check the workspace and try again."}\n\nNo provider was contacted. Strict changed no workspace files.`
          : (result.reason?.code === "quota_exhausted" || result.reason?.code === "timed_out") && result.humanApproval?.approved
          ? `The approved plan stopped during implementation: ${result.reason.message}\n\nUse “Resume approved work” on the report below. Strict verifies partial files before it runs.`
          : `Strict task finished: ${result.state}. ${result.reason ? result.reason.message : result.message}`,
        provider: "claude",
      });
      if (!stoppedBeforeAgents) await this.appendWorkflowMessage(threadId, {
        id: randomUUID(), role: "assistant",
        text: `Selected CLI profiles: Claude ${accounts.claudeLabel}; Codex ${accounts.codexLabel}.\n\n${detailedWorkflowReport(result)}`,
        createdAt: new Date().toISOString(), provider: "claude", modeLabel: "Strict report",
        accountLabel: `Claude: ${accounts.claudeLabel}; Codex: ${accounts.codexLabel}`, status: "completed",
        fileRefs: result.snapshots.at(-1)?.entries.slice(0, 20).map((entry) => entry.path) ?? [],
        strictContinuation: result.plans.length && result.state !== "completed_clean"
          ? { repository: result.repository, task: result.task, baselineDigest: result.baseline?.digest,
            baselineHead: result.baseline?.git?.head,
            planHash: result.plans.at(-1)!.hash, plan: result.plans.at(-1)!.plan,
            preExistingEntries: result.preExistingEntries,
            ...((result.reason?.code === "quota_exhausted" || result.reason?.code === "timed_out") && result.budget.implementation.providerRequests > 0 &&
              result.humanApproval?.approved && result.planConsensus?.reachedAt &&
              result.planConsensus.approvals.some((approval) => approval.provider === "claude" && approval.decision === "approve") &&
              result.planConsensus.approvals.some((approval) => approval.provider === "codex" && approval.decision === "approve")
              ? { approved: { consensus: result.planConsensus,
                humanApproval: result.humanApproval } } : {}) }
          : undefined,
      });
      this.postState();
      if (result.state !== "completed_clean") {
        throw new Error(`Strict task ended: ${result.state}. ${result.reason?.nextAction ?? ""}`.trim());
      }
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }

  private async approveStrictPlan(threadId: string, data: StrictPlanPromptData,
    signal: AbortSignal): Promise<StrictPlanApprovalAnswer | undefined> {
    await this.appendWorkflowMessage(threadId, {
      id: randomUUID(), role: "assistant", provider: "claude", modeLabel: "Strict plan",
      createdAt: new Date().toISOString(),
      text: [
        `Claude and Codex approved this plan. Hash ${data.planHash}.`,
        data.planText,
        // The estimate is information. Nothing is blocked on it: the scan and diff
        // ceilings are the only limits on how wide a change may be.
        data.expectedFilesComplete
          ? `The plan expects ${data.expectedFileCount} file(s).`
          : "The plan cannot estimate how many files it will touch.",
        "Nothing is implemented until you approve this exact hash.",
      ].filter(Boolean).join("\n\n"),
    });
    const answer = await this.waitForWorkflowPrompt({
      id: randomUUID(), kind: "strictPlan",
      title: "Approve the Strict plan",
      detail: "Approve this exact plan hash, or refuse without changing any file.",
      strict: data,
    }, signal);
    if (!answer || typeof answer !== "object") return undefined;
    const decision = answer as StrictPlanApprovalAnswer;
    await this.appendWorkflowMessage(threadId, {
      id: randomUUID(), role: "user", createdAt: new Date().toISOString(), modeLabel: "Strict approval",
      text: decision.approved
        ? `Plan ${data.planHash.slice(0, 12)}… approved with ${decision.executionPermission === "fullAccess" ? "Full access" : "Ask before change"}.`
        : "Plan refused. No file was changed.",
    });
    this.postState();
    return decision;
  }

  private async handleStrictPause(threadId: string, detail: string, signal: AbortSignal): Promise<"resume" | "stop"> {
    await this.appendWorkflowMessage(threadId, {
      id: randomUUID(), role: "assistant", provider: "claude", modeLabel: "Strict pause",
      createdAt: new Date().toISOString(),
      text: `${detail}\n\nThe pause lives only in this window. If VS Code restarts, the task is gone and you start a new one against a new baseline.`,
    });
    const answer = await this.waitForWorkflowPrompt({
      id: randomUUID(), kind: "pause", title: "Strict task paused",
      detail: "Resume in this window, or stop the task and read the report.",
    }, signal);
    const choice = answer === "resume" ? "resume" : "stop";
    await this.appendWorkflowMessage(threadId, {
      id: randomUUID(), role: "user", createdAt: new Date().toISOString(), modeLabel: "Strict pause",
      text: choice === "resume" ? "Resume the task." : "Stop the task.",
    });
    this.postState();
    return choice;
  }

  private async askWorkflowQuestion(threadId: string, phase: string, question: string,
    signal: AbortSignal, mode: "Balanced" | "Strict" = "Balanced"): Promise<string | undefined> {
    await this.appendWorkflowMessage(threadId, { id: randomUUID(), role: "assistant",
      text: `Question during ${phase}:\n\n${question}`, createdAt: new Date().toISOString(),
      provider: phase === "reviewing" ? "codex" : "claude", modeLabel: mode });
    const answer = await this.waitForWorkflowPrompt({ id: randomUUID(), kind: "question",
      title: `Question during ${phase}`, detail: question }, signal);
    if (typeof answer !== "string") return undefined;
    await this.appendWorkflowMessage(threadId, { id: randomUUID(), role: "user", text: answer,
      createdAt: new Date().toISOString(), modeLabel: `${mode} answer` });
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

  private waitForWorkflowPrompt(prompt: WorkflowPrompt, signal: AbortSignal): Promise<WorkflowPromptAnswer> {
    if (signal.aborted || this.activeController?.signal.aborted || this.workflowPrompt) return Promise.resolve(undefined);
    return new Promise((resolve) => {
      const onAbort = (): void => finish(undefined);
      const finish = (answer: WorkflowPromptAnswer): void => {
        signal.removeEventListener("abort", onAbort);
        this.activeController?.signal.removeEventListener("abort", onAbort);
        if (this.workflowPrompt?.id === prompt.id) {
          this.workflowPrompt = undefined;
          this.answerWorkflowPrompt = undefined;
          this.postState();
        }
        this.setLiveTask(answer === undefined ? "Stopping task" : "Resuming task");
        resolve(answer);
      };
      this.workflowPrompt = prompt;
      this.answerWorkflowPrompt = finish;
      this.setLiveTask(prompt.kind === "question" ? "Waiting for your answer"
        : prompt.kind === "pause" ? "Strict task paused"
          : "Waiting for plan approval");
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
        this.setLiveTask(accepted ? "Resuming task" : "Permission declined");
        resolve(accepted && vscode.workspace.isTrusted);
      };
      this.approval = { id, provider, kind, summary, detail };
      this.answerApproval = finish;
      this.setLiveTask("Waiting for your permission");
      signal.addEventListener("abort", onAbort, { once: true });
      turnSignal?.addEventListener("abort", onAbort, { once: true });
      this.view.reveal();
      this.postState();
    });
  }

  private async refreshCapabilities(): Promise<void> {
    if (this.refreshing) { this.refreshPending = true; return; }
    this.refreshing = true;
    try {
      const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
      const config = vscode.workspace.getConfiguration("countersign");
      const claudeExecutable = config.get<string>("claudeExecutable") || "claude";
      const codexExecutable = config.get<string>("codexExecutable") || "codex";
      for (const provider of ["claude", "codex"] as const) {
        const profile = this.accounts.selected(provider);
        const profileId = profile?.id ?? "default";
        try {
          if (process.platform !== "linux") throw new Error("Real chat is verified on Linux only.");
          if (provider === "claude") {
            const info = await inspectClaude(claudeExecutable, cwd, profile?.directory, true);
            const gate = await loadClaudeChatGate();
            const sdk = await sdkVersion();
            const compatible = info.version === VERIFIED_CLAUDE_CHAT_CLI && sdk === VERIFIED_CLAUDE_CHAT_SDK;
            const passed = compatible && chatGateMatches(gate, info.version, sdk);
            if ((this.accounts.selected(provider)?.id ?? "default") !== profileId) continue;
            this.capabilities.set(provider, { provider, available: passed, accountLabel: info.accountLabel,
              accountEmail: info.accountEmail, usage: info.usage,
              models: info.models, version: info.version, quotaLabel: "Unavailable",
              reason: passed ? undefined : compatible
                ? "Run Countersign: Verify Claude Chat Isolation for this CLI and SDK version."
                : "Claude chat requires verified CLI 2.1.109 and SDK 0.3.306." });
            this.accountEmails.set(`${provider}:${profileId}`, info.accountEmail ?? null);
          } else {
            const info = await inspectCodex(codexExecutable, cwd, profile?.directory, true);
            const passed = info.version === "codex-cli 0.163.0";
            if ((this.accounts.selected(provider)?.id ?? "default") !== profileId) continue;
            this.capabilities.set(provider, { provider, available: passed, accountLabel: info.accountLabel,
              accountEmail: info.accountEmail, usage: info.usage,
              models: info.models, version: info.version, quotaLabel: "Unavailable",
              reason: passed ? undefined : "Codex app-server needs the verified CLI 0.163.0." });
            this.accountEmails.set(`${provider}:${profileId}`, info.accountEmail ?? null);
          }
        } catch (error) {
          if ((this.accounts.selected(provider)?.id ?? "default") !== profileId) continue;
          this.capabilities.set(provider, { provider, available: false, accountLabel: "Unavailable", models: [],
            reason: error instanceof Error ? error.message.slice(0, 200) : "Provider check failed." });
        }
        this.postState();
      }
    } finally {
      this.refreshing = false;
      if (this.refreshPending) {
        this.refreshPending = false;
        void this.refreshCapabilities();
      }
    }
  }

  private async refreshAccountIdentities(): Promise<void> {
    if (this.identitiesRefreshing) { this.identitiesRefreshPending = true; return; }
    this.identitiesRefreshing = true;
    try {
      const choices = this.accounts.snapshot();
      const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? process.cwd();
      const config = vscode.workspace.getConfiguration("countersign");
      const jobs = (["claude", "codex"] as const).flatMap((provider) => [
        { provider, id: "default", directory: undefined as string | undefined },
        ...choices.profiles.filter((profile) => profile.provider === provider)
          .map((profile) => ({ provider, id: profile.id, directory: profile.directory })),
      ]).filter(({ provider, id }) => choices.selected[provider] !== id);
      let next = 0;
      const worker = async (): Promise<void> => {
        while (next < jobs.length) {
          const job = jobs[next++];
          const executable = config.get<string>(job.provider === "claude" ? "claudeExecutable" : "codexExecutable") || job.provider;
          let email: string | undefined;
          try {
            if (process.platform === "linux") email = job.provider === "claude"
              ? await inspectClaudeAccount(executable, cwd, job.directory)
              : await inspectCodexAccount(executable, cwd, job.directory);
          } catch { /* An unavailable profile stays selectable so the user can sign in. */ }
          if (job.id === "default" || this.accounts.snapshot().profiles.some((entry) =>
            entry.provider === job.provider && entry.id === job.id && entry.directory === job.directory)) {
            this.accountEmails.set(`${job.provider}:${job.id}`, email ?? null);
            this.postState();
          }
        }
      };
      await Promise.all([worker(), worker()]);
    } catch { /* Account emails are optional; a failed probe must not break the sidebar. */ }
    finally {
      this.identitiesRefreshing = false;
      if (this.identitiesRefreshPending) {
        this.identitiesRefreshPending = false;
        void this.refreshAccountIdentities();
      }
    }
  }

  private saveTurnSettings(raw: unknown): Promise<void> {
    const next = restoreTurnSettings(raw, this.turnSettings.cavemanStyle);
    if (!isRecord(raw) || !isRecord(raw.selection) ||
        !["balanced", "strict"].includes(String(raw.mode)) ||
        !["askBeforeChange", "fullAccess"].includes(String(raw.executionPermission)) ||
        !["auto", "always", "internalOnly"].includes(String(raw.cavemanStyle))) {
      throw new Error("Turn settings are invalid.");
    }
    this.turnSettings = next;
    this.turnSettingsStored = true;
    this.settingsSave = this.settingsSave.catch(() => {}).then(() =>
      this.context.workspaceState.update(TURN_SETTINGS_KEY, structuredClone(next)));
    return this.settingsSave;
  }

  private setLiveTask(label: string): void {
    if (!this.activeController) return;
    this.liveTask = { label, since: Date.now() };
    this.postState();
  }

  private async verifyClaudeGate(): Promise<void> {
    if (this.activeController) return;
    const choice = await vscode.window.showWarningMessage(
      "Verify Claude chat isolation with two short requests in a temporary repository? This uses your Claude subscription quota.",
      { modal: true }, "Run verification");
    if (choice !== "Run verification") return;
    try {
      const executable = vscode.workspace.getConfiguration("countersign").get<string>("claudeExecutable") || "claude";
      const record = await verifyClaudeChatGate(executable, this.accounts.selected("claude")?.directory);
      await saveClaudeChatGate(record);
      this.notice = `Claude chat isolation passed for SDK ${record.sdkVersion}, CLI ${record.cliVersion}.`;
    } catch (error) {
      await clearClaudeChatGate();
      this.notice = error instanceof Error ? error.message.slice(0, 300) : "Isolation verification failed.";
    }
    await this.refreshCapabilities();
  }

  private async mockChatTranscript(text: string): Promise<void> {
    if (this.activeController) return;
    const threadId = this.store.activeThread().id;
    await this.store.append(threadId, { id: randomUUID(), role: "user", text,
      createdAt: new Date().toISOString(), modeLabel: "Balanced test" });
    await this.store.append(threadId, { id: randomUUID(), role: "assistant", provider: "mock",
      text: "Packaged chat storage is working. No provider was called or file changed.",
      createdAt: new Date().toISOString(), status: "completed", modeLabel: "Balanced test" });
    this.postState();
  }

  private postState(): void {
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    const offered = [...this.capabilities.values()].filter((entry) => entry.provider !== "mock" || process.env.COUNTERSIGN_TEST_MODE === "1");
    const accounts = this.accounts.snapshot();
    const emails: Record<AccountProvider, Record<string, string | null>> = { claude: {}, codex: {} };
    for (const [key, value] of this.accountEmails) {
      const split = key.indexOf(":");
      const provider = key.slice(0, split);
      if (accountProvider(provider)) emails[provider][key.slice(split + 1)] = value;
    }
    this.view.post({ type: "state", sessionId: this.sessionId, state: this.store.snapshot(),
      chatRevision: this.store.revision, capabilities: offered,
      accounts: { ...accounts, emails }, turnSettings: this.turnSettings,
      turnSettingsStored: this.turnSettingsStored,
      busy: Boolean(this.activeController || this.sending), repositoryBusy: root ? isRepositoryLocked(root) : false,
      liveTask: this.liveTask ?? null,
      approval: this.approval ?? null, workflowPrompt: this.workflowPrompt ?? null, notice: this.notice });
  }
}

/** The sidebar overrides countersign.cavemanStyle, which is the default until it does. */
function configuredCavemanStyle(): CavemanStyle {
  const value = vscode.workspace.getConfiguration("countersign").get<unknown>("cavemanStyle", "auto");
  return value === "always" || value === "internalOnly" ? value : "auto";
}

function restoreTurnSettings(raw: unknown, cavemanDefault: CavemanStyle): TurnSettings {
  const selection = isRecord(raw) && isRecord(raw.selection) ? raw.selection : {};
  const value = (key: keyof WorkflowModelSelection): string => {
    const candidate = selection[key];
    return typeof candidate === "string" && candidate.length <= 100 && !/\s/.test(candidate) ? candidate : "";
  };
  return {
    mode: isRecord(raw) && raw.mode === "strict" ? "strict" : "balanced",
    executionPermission: isRecord(raw) && raw.executionPermission === "fullAccess" ? "fullAccess" : "askBeforeChange",
    cavemanStyle: isRecord(raw) && (raw.cavemanStyle === "always" || raw.cavemanStyle === "internalOnly"
      || raw.cavemanStyle === "auto") ? raw.cavemanStyle : cavemanDefault,
    selection: { claudeModel: value("claudeModel"), claudeEffort: value("claudeEffort"),
      codexModel: value("codexModel"), codexEffort: value("codexEffort") },
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function accountProvider(value: unknown): value is AccountProvider {
  return value === "claude" || value === "codex";
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/** Recover the approved gate from reports created before it was stored as structured data. */
function legacyApprovedContinuation(report: string, hash: string):
  { consensus: StrictConsensus; humanApproval: StrictHumanApproval } | undefined {
  const consensusText = report.split("## Plan consensus\n")[1]?.split("\n## ")[0];
  const humanText = report.split("## Human approval\n")[1]?.split("\n## ")[0];
  if (!consensusText || !humanText || !/^Reason: (?:quota_exhausted|timed_out)\b/m.test(report) ||
      !/^- Phase B: [1-9]\d* provider request\(s\)/m.test(report)) return undefined;
  const reached = consensusText.match(/^Hash under evaluation: ([0-9a-f]{64})\. Both providers approved this exact hash at ([^\n.]+(?:\.[0-9]+)?Z)\.$/m);
  const human = humanText.match(/^Approved at ([^\n ]+) on plan hash ([0-9a-f]{64}); permission (askBeforeChange|fullAccess)\.$/m);
  if (!reached || reached[1] !== hash || !human || human[2] !== hash) return undefined;
  const approvals = (["claude", "codex"] as const).map((provider) => {
    const match = consensusText.match(new RegExp(`^- ${provider}: approve on ([0-9a-f]{64}) at ([^\\n ]+)`, "m"));
    return match?.[1] === hash ? { provider, subject: "plan" as const, hash,
      decision: "approve" as const, decidedAt: match[2] } : undefined;
  });
  if (approvals.some((approval) => !approval)) return undefined;
  return {
    // Older reports could carry objections from a replaced plan even after both
    // providers approved the final hash. They are not objections to this hash.
    consensus: { subject: "plan", hash, reachedAt: reached[2],
      approvals: approvals as StrictConsensus["approvals"], openObjections: [] },
    humanApproval: { approved: true, planHash: hash, decidedAt: human[1],
      executionPermission: human[3] as StrictHumanApproval["executionPermission"] },
  };
}

function reportPreExistingEntries(report: string): string[] {
  const section = report.split("## Changes already present before this task\n")[1]?.split("\n## ")[0] ?? "";
  return section.split("\n").filter((line) => line.startsWith("- ")).map((line) => line.slice(2));
}

function reportBaselineHead(report: string): string | undefined {
  return report.match(/\bGit repository [^\n;]+ at HEAD ([0-9a-f]{40,64});/)?.[1];
}

/** Reads a Strict approval from the webview, refusing anything outside the allowed range. */
function strictApprovalFrom(raw: Record<string, unknown>, data: StrictPlanPromptData | undefined): StrictPlanApprovalAnswer | undefined {
  if (!data) return undefined;
  if (raw.decision === "refuse") return { approved: false, executionPermission: data.executionPermission };
  if (raw.decision !== "approve") return undefined;
  return {
    approved: true,
    executionPermission: raw.executionPermission === "fullAccess" ? "fullAccess" : "askBeforeChange",
  };
}
