import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type * as vscode from "vscode";
import { createCleanGitRepository, removeRepository } from "./helpers/git";
import { ClaudeCliProvider } from "../src/providers/claudeCliProvider";
import { CodexCliProvider } from "../src/providers/codexCliProvider";
import * as claudeChatAdapter from "../src/chat/claudeAdapter";
import * as codexChatAdapter from "../src/chat/codexAdapter";

const callbacks = new Map<string, () => Promise<void> | void>();
const information: string[] = [];
const warnings: string[] = [];
let repository = "";
let resolveInput: ((value: string | undefined) => void) | undefined;

vi.mock("vscode", () => ({
  version: "1.95.0",
  commands: { registerCommand: (name: string, callback: () => Promise<void> | void) => {
    callbacks.set(name, callback);
    return { dispose: () => undefined };
  } },
  workspace: {
    get isTrusted() { return true; },
    get workspaceFolders() { return [{ uri: { fsPath: repository } }]; },
    getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }),
  },
  window: {
    registerWebviewViewProvider: () => ({ dispose: () => undefined }),
    createOutputChannel: () => ({ show: () => undefined, appendLine: () => undefined, dispose: () => undefined }),
    showInformationMessage: (message: string) => { information.push(message); return Promise.resolve(undefined); },
    showWarningMessage: (message: string) => { warnings.push(message); return Promise.resolve(undefined); },
    showErrorMessage: () => Promise.resolve(undefined),
    showInputBox: () => new Promise<string | undefined>((resolve) => { resolveInput = resolve; }),
  },
}));

import { activate, deactivate, ExtensionRuntime } from "../src/extension";

process.env.COUNTERSIGN_TEST_MODE = "1";

afterEach(async () => {
  resolveInput?.(undefined);
  resolveInput = undefined;
  deactivate();
  callbacks.clear();
  information.length = 0;
  warnings.length = 0;
  vi.restoreAllMocks();
  if (repository) await removeRepository(repository);
  repository = "";
});

describe("VS Code command entry", () => {
  it("locks a workflow before the first async preflight so a second start is rejected", async () => {
    repository = await createCleanGitRepository();
    activate({ subscriptions: [], workspaceState: { get: () => undefined, update: () => Promise.resolve() } } as unknown as vscode.ExtensionContext);
    const start = callbacks.get("countersign.startWorkflow");
    expect(start).toBeDefined();
    const first = Promise.resolve(start?.());
    await Promise.resolve(start?.());
    expect(information).toContain("A workflow is already running.");
    // The first command may still be in Git preflight; abort it before the input box opens.
    await Promise.resolve(callbacks.get("countersign.cancelWorkflow")?.());
    resolveInput?.(undefined);
    await first;
  });

  it("does not accept chat approval callbacks through the public VS Code command", async () => {
    repository = await createCleanGitRepository();
    activate({ subscriptions: [], workspaceState: { get: () => undefined, update: () => Promise.resolve() } } as unknown as vscode.ExtensionContext);
    const start = callbacks.get("countersign.startWorkflow") as unknown as (request: unknown) => Promise<unknown>;
    const injectedApproval = vi.fn(async () => true);
    const running = start({ task: "Injected task", interaction: { confirmPlan: injectedApproval } });
    await vi.waitFor(() => expect(resolveInput).toBeDefined());
    resolveInput?.(undefined);
    await running;
    expect(injectedApproval).not.toHaveBeenCalled();
  });

  it("asks and approves a read-only plan through the chat callbacks without a modal", async () => {
    repository = await createCleanGitRepository();
    await writeFile(join(repository, "existing.txt"), "Earlier work.\n");
    vi.spyOn(claudeChatAdapter, "inspectClaude").mockResolvedValue({ version: "2.1.109 (Claude Code)",
      accountLabel: "Claude subscription", models: [] });
    vi.spyOn(codexChatAdapter, "inspectCodex").mockResolvedValue({ version: "codex-cli 0.163.0",
      accountLabel: "ChatGPT subscription", models: [] });
    vi.spyOn(ClaudeCliProvider.prototype, "checkAvailability").mockResolvedValue({ available: true });
    vi.spyOn(CodexCliProvider.prototype, "checkAvailability").mockResolvedValue({ available: true });
    const propose = vi.spyOn(ClaudeCliProvider.prototype, "proposePlan")
      .mockResolvedValueOnce({ plan: "", questions: ["Which format?"] })
      .mockResolvedValueOnce({ plan: "Create feature.ts using JSON.", questions: [] });
    vi.spyOn(ClaudeCliProvider.prototype, "execute").mockImplementation(async (request) => {
      await writeFile(join(request.repository, "feature.ts"), "export const format = 'JSON';\n");
      return { changed: true, changedPaths: ["feature.ts"], findings: [], message: "Created feature.ts." };
    });
    vi.spyOn(CodexCliProvider.prototype, "execute").mockResolvedValue({ changed: false, findings: [], message: "No findings." });
    const runtime = new ExtensionRuntime({ subscriptions: [], workspaceState: { get: () => undefined, update: () => Promise.resolve() } } as unknown as vscode.ExtensionContext);
    const asked: string[] = [];
    let offeredPlan = "";
    const result = await runtime.startChatWorkflow({ task: "Add a format", providers: { provider: "claude", codexProvider: "real" },
      interaction: {
        askQuestion: async (_phase: string, question: string) => { asked.push(question); return "JSON"; },
        confirmPlan: async (plan: string, details: string) => {
          offeredPlan = plan;
          expect(details).toContain("Add a format");
          expect(details).toContain("existing.txt");
          return true;
        },
      },
    });
    expect(asked).toEqual(["Which format?"]);
    expect(offeredPlan).toBe("Create feature.ts using JSON.");
    expect(propose).toHaveBeenCalledTimes(2);
    expect(result?.state).toBe("completed_clean");
    expect(result?.plan).toBe(offeredPlan);
    expect(result?.startingWorkingTreeEntries).toContain("?? existing.txt");
    expect(result?.diff).not.toContain("existing.txt");
    expect(result?.diff).toContain("feature.ts");
    expect(warnings).toEqual([]);
    runtime.dispose();
  });

  it("does not execute Balanced when the proposed plan is declined", async () => {
    repository = await createCleanGitRepository();
    vi.spyOn(claudeChatAdapter, "inspectClaude").mockResolvedValue({ version: "2.1.109 (Claude Code)",
      accountLabel: "Claude subscription", models: [] });
    vi.spyOn(codexChatAdapter, "inspectCodex").mockResolvedValue({ version: "codex-cli 0.163.0",
      accountLabel: "ChatGPT subscription", models: [] });
    vi.spyOn(ClaudeCliProvider.prototype, "checkAvailability").mockResolvedValue({ available: true });
    vi.spyOn(ClaudeCliProvider.prototype, "proposePlan").mockResolvedValue({ plan: "Change feature.ts.", questions: [] });
    const execute = vi.spyOn(ClaudeCliProvider.prototype, "execute");
    const runtime = new ExtensionRuntime({ subscriptions: [], workspaceState: { get: () => undefined, update: () => Promise.resolve() } } as unknown as vscode.ExtensionContext);
    await expect(runtime.startChatWorkflow({ task: "Change feature", providers: { provider: "claude", codexProvider: "real" },
      executionPermission: "fullAccess", interaction: {
        askQuestion: async () => undefined,
        confirmPlan: async (_plan, details) => {
          expect(details).toContain("Full access");
          return false;
        },
      } })).rejects.toThrow("Plan was declined. No execution was started.");
    expect(execute).not.toHaveBeenCalled();
    runtime.dispose();
  });

  it("starts a mock workflow with existing uncommitted files", async () => {
    repository = await createCleanGitRepository();
    await writeFile(join(repository, "pending.txt"), "Uncommitted work.\n");
    const runtime = new ExtensionRuntime({ subscriptions: [], workspaceState: {
      get: () => undefined, update: () => Promise.resolve(),
    } } as unknown as vscode.ExtensionContext);
    const confirmPlan = vi.fn(async () => true);
    const result = await runtime.startChatWorkflow({ task: "Change feature",
      providers: { provider: "mock", codexProvider: "mock" },
      interaction: { askQuestion: async () => undefined, confirmPlan },
    });
    expect(confirmPlan).toHaveBeenCalledOnce();
    expect(result?.state).toBe("completed_clean");
    expect(result?.startingWorkingTreeEntries).toContain("?? pending.txt");
    runtime.dispose();
  });

  it("starts a workflow in a folder without Git", async () => {
    repository = await mkdtemp(join(tmpdir(), "countersign-no-git-"));
    await writeFile(join(repository, "existing.txt"), "Original work.\n");
    const runtime = new ExtensionRuntime({ subscriptions: [], workspaceState: {
      get: () => undefined, update: () => Promise.resolve(),
    } } as unknown as vscode.ExtensionContext);
    const result = await runtime.startChatWorkflow({ task: "Change feature",
      providers: { provider: "mock", codexProvider: "mock" },
      interaction: { askQuestion: async () => undefined, confirmPlan: async (_plan, details) => {
        expect(details).toContain("No Git repository");
        return true;
      } },
    });
    expect(result?.state).toBe("completed_clean");
    expect(result?.changeSource).toBe("snapshot");
    runtime.dispose();
  });

  it("reviews a real file diff in a folder without Git", async () => {
    repository = await mkdtemp(join(tmpdir(), "countersign-no-git-"));
    await writeFile(join(repository, "existing.txt"), "Before.\n");
    vi.spyOn(claudeChatAdapter, "inspectClaude").mockResolvedValue({ version: "2.1.109 (Claude Code)",
      accountLabel: "Claude subscription", models: [] });
    vi.spyOn(codexChatAdapter, "inspectCodex").mockResolvedValue({ version: "codex-cli 0.163.0",
      accountLabel: "ChatGPT subscription", models: [] });
    vi.spyOn(ClaudeCliProvider.prototype, "checkAvailability").mockResolvedValue({ available: true });
    vi.spyOn(CodexCliProvider.prototype, "checkAvailability").mockResolvedValue({ available: true });
    vi.spyOn(ClaudeCliProvider.prototype, "proposePlan").mockResolvedValue({ plan: "Update existing.txt.", questions: [] });
    vi.spyOn(ClaudeCliProvider.prototype, "execute").mockImplementation(async (request) => {
      await writeFile(join(request.repository, "existing.txt"), "After.\n");
      return { changed: true, changedPaths: ["existing.txt"], findings: [], message: "Updated existing.txt." };
    });
    const review = vi.spyOn(CodexCliProvider.prototype, "execute").mockResolvedValue({ changed: false, findings: [], message: "No findings." });
    const runtime = new ExtensionRuntime({ subscriptions: [], workspaceState: {
      get: () => undefined, update: () => Promise.resolve(),
    } } as unknown as vscode.ExtensionContext);
    const result = await runtime.startChatWorkflow({ task: "Update the file",
      providers: { provider: "claude", codexProvider: "real" },
      interaction: { askQuestion: async () => undefined, confirmPlan: async () => true },
    });
    expect(result?.state).toBe("completed_clean");
    expect(result?.diff).toContain("-Before.");
    expect(result?.diff).toContain("+After.");
    expect(review.mock.calls[0][0].changeSource).toBe("snapshot");
    runtime.dispose();
  });

  it("stops when existing work changes while its plan is awaiting approval", async () => {
    repository = await createCleanGitRepository();
    await writeFile(join(repository, "existing.txt"), "Original work.\n");
    vi.spyOn(claudeChatAdapter, "inspectClaude").mockResolvedValue({ version: "2.1.109 (Claude Code)",
      accountLabel: "Claude subscription", models: [] });
    vi.spyOn(codexChatAdapter, "inspectCodex").mockResolvedValue({ version: "codex-cli 0.163.0",
      accountLabel: "ChatGPT subscription", models: [] });
    vi.spyOn(ClaudeCliProvider.prototype, "checkAvailability").mockResolvedValue({ available: true });
    vi.spyOn(ClaudeCliProvider.prototype, "proposePlan").mockResolvedValue({ plan: "Continue earlier work.", questions: [] });
    const execute = vi.spyOn(ClaudeCliProvider.prototype, "execute");
    const runtime = new ExtensionRuntime({ subscriptions: [], workspaceState: {
      get: () => undefined, update: () => Promise.resolve(),
    } } as unknown as vscode.ExtensionContext);
    await expect(runtime.startChatWorkflow({ task: "Continue earlier work",
      providers: { provider: "claude", codexProvider: "real" },
      interaction: {
        askQuestion: async () => undefined,
        confirmPlan: async () => {
          await writeFile(join(repository, "existing.txt"), "Changed during approval.\n");
          return true;
        },
      },
    })).rejects.toThrow("The working tree changed during planning or approval.");
    expect(execute).not.toHaveBeenCalled();
    runtime.dispose();
  });
});
