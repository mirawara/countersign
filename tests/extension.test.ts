import { afterEach, describe, expect, it, vi } from "vitest";
import { writeFile } from "node:fs/promises";
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
          return true;
        },
      },
    });
    expect(asked).toEqual(["Which format?"]);
    expect(offeredPlan).toBe("Create feature.ts using JSON.");
    expect(propose).toHaveBeenCalledTimes(2);
    expect(result?.state).toBe("completed_clean");
    expect(result?.plan).toBe(offeredPlan);
    expect(warnings).toEqual([]);
    runtime.dispose();
  });
});
