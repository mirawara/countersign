import { afterEach, describe, expect, it, vi } from "vitest";
import type * as vscode from "vscode";
import { createCleanGitRepository, removeRepository } from "./helpers/git";

const callbacks = new Map<string, () => Promise<void> | void>();
const information: string[] = [];
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
    createOutputChannel: () => ({ show: () => undefined, appendLine: () => undefined, dispose: () => undefined }),
    showInformationMessage: (message: string) => { information.push(message); return Promise.resolve(undefined); },
    showWarningMessage: () => Promise.resolve(undefined),
    showErrorMessage: () => Promise.resolve(undefined),
    showInputBox: () => new Promise<string | undefined>((resolve) => { resolveInput = resolve; }),
  },
}));

import { activate, deactivate } from "../src/extension";

afterEach(async () => {
  resolveInput?.(undefined);
  resolveInput = undefined;
  deactivate();
  callbacks.clear();
  information.length = 0;
  if (repository) await removeRepository(repository);
  repository = "";
});

describe("VS Code command entry", () => {
  it("locks a workflow before the first async preflight so a second start is rejected", async () => {
    repository = await createCleanGitRepository();
    activate({ subscriptions: [] } as unknown as vscode.ExtensionContext);
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
});
