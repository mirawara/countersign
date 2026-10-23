import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";
import { ChatController } from "../src/chat/controller";
import { StrictWorkflowStartRequest, WorkflowStartRequest } from "../src/shared/workflowInteraction";
import { resolveStrictLimits } from "../src/shared/strictLimits";
import { StrictWorkflowResult } from "../src/shared/strict";

let root = "";
let activeFile = "";

vi.mock("vscode", () => ({
  commands: { executeCommand: () => Promise.resolve(undefined), registerCommand: () => ({ dispose: () => undefined }) },
  workspace: {
    get isTrusted() { return true; },
    get workspaceFolders() { return [{ uri: { fsPath: root } }]; },
    getConfiguration: () => ({ get: (_key: string, fallback: unknown) => fallback }),
  },
  window: {
    get activeTextEditor() { return { document: {
      uri: { scheme: "file", fsPath: activeFile }, getText: () => "selected line",
    }, selection: { isEmpty: false } }; },
  },
}));

vi.mock("../src/chat/claudeAdapter", () => ({
  inspectClaude: async () => { throw new Error("Provider probe disabled in controller tests."); },
  inspectClaudeAccount: async () => undefined,
}));
vi.mock("../src/chat/codexAdapter", () => ({
  inspectCodex: async () => { throw new Error("Provider probe disabled in controller tests."); },
  inspectCodexAccount: async () => undefined,
}));

afterEach(async () => { if (root) await rm(root, { recursive: true, force: true }); root = ""; activeFile = ""; });

describe("sidebar task routing", () => {
  it("sends a referenced file to Balanced even when a legacy single-provider mode is requested", async () => {
    root = await mkdtemp(join(tmpdir(), "countersign-chat-route-"));
    activeFile = join(root, "sample.ts");
    await writeFile(activeFile, "selected line\n");
    const data = new Map<string, unknown>();
    let request: WorkflowStartRequest | undefined;
    const controller = new ChatController({
      extensionUri: {} as vscode.Uri,
      workspaceState: { get: (key: string) => data.get(key), update: async (key: string, value: unknown) => { data.set(key, value); } },
    } as unknown as vscode.ExtensionContext, {
      start: async (input) => { request = input; throw new Error("test stop before provider startup"); },
      cancel: () => undefined,
    });
    const actions = controller as unknown as {
      addActiveFile: () => Promise<void>;
      send: (input: Record<string, unknown>) => Promise<void>;
    };
    await actions.addActiveFile();
    await actions.send({ text: "Review this change", provider: "codex", mode: "chat",
      attachment: { path: "sample.ts" }, executionPermission: "askBeforeChange",
      selection: { claudeModel: "", claudeEffort: "", codexModel: "", codexEffort: "" } });

    expect(request?.providers).toEqual({ provider: "claude", codexProvider: "real" });
    expect(request?.task).toContain("Review this change\n\nReferenced workspace file: sample.ts\nSelected text:\nselected line");
    expect(request?.executionPermission).toBe("askBeforeChange");
    controller.dispose();
  });

  it("runs Strict from the sidebar: plan gate, pause control and report", async () => {
    root = await mkdtemp(join(tmpdir(), "countersign-chat-strict-"));
    const data = new Map<string, unknown>();
    let request: StrictWorkflowStartRequest | undefined;
    let approval: Awaited<ReturnType<StrictWorkflowStartRequest["interaction"]["approvePlan"]>>;
    let pauseChoice: "resume" | "stop" | undefined;
    const controller = new ChatController({
      extensionUri: {} as vscode.Uri,
      workspaceState: { get: (key: string) => data.get(key), update: async (key: string, value: unknown) => { data.set(key, value); } },
    } as unknown as vscode.ExtensionContext, {
      start: async () => undefined,
      startStrict: async (input) => {
        request = input;
        const signal = new AbortController().signal;
        approval = await input.interaction.approvePlan({
          planText: "Objective: Add the parser",
          planHash: "a".repeat(64),
          expectedFileCount: 50,
          expectedFilesComplete: true,
          executionPermission: "askBeforeChange",
        }, signal);
        pauseChoice = await input.interaction.onPause("No verifiable progress for 2 cycles.", signal);
        return strictResult();
      },
      cancel: () => undefined,
    });
    const actions = controller as unknown as {
      send: (input: Record<string, unknown>) => Promise<void>;
      onMessage: (input: Record<string, unknown>) => Promise<void>;
      workflowPrompt?: { id: string; kind: string; strict?: Record<string, unknown> };
      store: { activeThread: () => { messages: { text: string; modeLabel?: string }[] } };
    };

    const run = actions.send({ text: "Refactor the parser", mode: "strict",
      executionPermission: "askBeforeChange",
      selection: { claudeModel: "", claudeEffort: "", codexModel: "", codexEffort: "" } });

    const planPrompt = await waitForPrompt(actions, "strictPlan");
    expect(planPrompt.strict).toMatchObject({ expectedFileCount: 50, expectedFilesComplete: true });
    await actions.onMessage({ type: "workflowResponse", id: planPrompt.id, decision: "approve", executionPermission: "fullAccess", acknowledgedIncompleteFileList: false });

    const pausePrompt = await waitForPrompt(actions, "pause");
    await actions.onMessage({ type: "workflowResponse", id: pausePrompt.id, decision: "stop" });
    await run;

    expect(request).toMatchObject({ task: "Refactor the parser", executionPermission: "askBeforeChange" });
    expect(request).not.toHaveProperty("maxChangedFiles");
    expect(approval).toEqual({ approved: true, executionPermission: "fullAccess" });
    expect(pauseChoice).toBe("stop");
    const messages = actions.store.activeThread().messages;
    expect(messages.some((message) => message.modeLabel === "Strict plan" && message.text.includes("a".repeat(64)))).toBe(true);
    expect(messages.some((message) => message.modeLabel === "Strict approval" && message.text.includes("approved with Full access"))).toBe(true);
    expect(messages.some((message) => message.modeLabel === "Strict pause")).toBe(true);
    expect(messages.some((message) => message.modeLabel === "Strict report" && message.text.includes("# Strict workflow report"))).toBe(true);
    controller.dispose();
  });
});

async function waitForPrompt(
  actions: { workflowPrompt?: { id: string; kind: string; strict?: Record<string, unknown> } },
  kind: string,
): Promise<{ id: string; kind: string; strict?: Record<string, unknown> }> {
  for (let attempt = 0; attempt < 200; attempt++) {
    if (actions.workflowPrompt?.kind === kind) return actions.workflowPrompt;
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  throw new Error(`The ${kind} prompt never appeared.`);
}

function strictResult(): StrictWorkflowResult {
  return {
    mode: "strict",
    taskId: "task-1",
    state: "completed_clean",
    repository: "/repo",
    task: "Refactor the parser",
    startedAt: "2026-10-22T09:00:00.000Z",
    finishedAt: "2026-10-22T09:40:00.000Z",
    message: "Both providers approved the final digest.",
    limits: resolveStrictLimits(),
    limitBreaches: [],
    budget: {
      plan: { providerRequests: 3, activeMs: 600_000, wallClockMs: 900_000 },
      implementation: { providerRequests: 5, activeMs: 900_000, wallClockMs: 1_200_000, reviewCycles: 1 },
    },
    plans: [],
    snapshots: [],
    sessions: [],
    findings: [],
    checkRounds: [],
    preExistingEntries: [],
    policyExclusions: [],
    unsupportedPaths: [],
    pauses: [],
    events: [],
    metrics: [],
  };
}
