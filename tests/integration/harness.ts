import * as vscode from "vscode";

export interface OpenedDocument {
  language: string;
  content: string;
}

export interface Recorder {
  outputLines: string[];
  modals: { message: string; detail: string; items: string[]; answered: string | undefined }[];
  information: string[];
  warnings: string[];
  errors: string[];
  documents: OpenedDocument[];
  restore(): void;
}

export interface RecorderOptions {
  /** Value returned by the task input box; undefined simulates a dismissed box. */
  task: string | undefined;
  /** When false, every modal confirmation is dismissed instead of accepted. */
  confirm: boolean;
}

type AnyFunction = (...args: never[]) => unknown;

function patch<T extends object>(target: T, key: keyof T, value: AnyFunction): () => void {
  const original = target[key];
  Object.defineProperty(target, key, { value, configurable: true, writable: true });
  return () => Object.defineProperty(target, key, { value: original, configurable: true, writable: true });
}

/**
 * Replaces the interactive surfaces the extension uses so a command can run without a human,
 * and records everything the user would have seen.
 */
export function installRecorder(options: RecorderOptions): Recorder {
  const outputLines: string[] = [];
  const modals: Recorder["modals"] = [];
  const information: string[] = [];
  const warnings: string[] = [];
  const errors: string[] = [];
  const documents: OpenedDocument[] = [];
  const restores: (() => void)[] = [];

  const createOutputChannel = vscode.window.createOutputChannel.bind(vscode.window);
  restores.push(patch(vscode.window, "createOutputChannel", ((name: string) => {
    const channel = createOutputChannel(name);
    return new Proxy(channel, {
      get(target, property, receiver) {
        if (property === "appendLine") {
          return (value: string): void => {
            outputLines.push(...value.split("\n"));
            target.appendLine(value);
          };
        }
        if (property === "append") {
          return (value: string): void => {
            outputLines.push(...value.split("\n"));
            target.append(value);
          };
        }
        if (property === "show") {
          // Avoid stealing focus from the test run.
          return (): void => undefined;
        }
        return Reflect.get(target, property, receiver) as unknown;
      },
    });
  }) as AnyFunction));

  restores.push(patch(vscode.window, "showInputBox", (() => Promise.resolve(options.task)) as AnyFunction));

  restores.push(patch(vscode.window, "showWarningMessage", ((
    message: string,
    second?: unknown,
    ...rest: unknown[]
  ) => {
    const isOptions = typeof second === "object" && second !== null;
    const items = (isOptions ? rest : [second, ...rest]).filter((item): item is string => typeof item === "string");
    const detail = isOptions ? String((second as { detail?: unknown }).detail ?? "") : "";
    const answered = options.confirm ? items[0] : undefined;
    modals.push({ message, detail, items, answered });
    warnings.push(message);
    return Promise.resolve(answered);
  }) as AnyFunction));

  restores.push(patch(vscode.window, "showInformationMessage", ((message: string) => {
    information.push(message);
    return Promise.resolve(undefined);
  }) as AnyFunction));

  restores.push(patch(vscode.window, "showErrorMessage", ((message: string) => {
    errors.push(message);
    return Promise.resolve(undefined);
  }) as AnyFunction));

  const openTextDocument = vscode.workspace.openTextDocument.bind(vscode.workspace);
  restores.push(patch(vscode.workspace, "openTextDocument", ((argument: unknown) => {
    if (typeof argument === "object" && argument !== null && "content" in argument) {
      const options_ = argument as { content?: string; language?: string };
      documents.push({ language: options_.language ?? "", content: options_.content ?? "" });
    }
    return openTextDocument(argument as never);
  }) as AnyFunction));

  restores.push(patch(vscode.window, "showTextDocument", (() => Promise.resolve(undefined)) as AnyFunction));

  return {
    outputLines,
    modals,
    information,
    warnings,
    errors,
    documents,
    restore: () => {
      for (const restore of restores.reverse()) restore();
    },
  };
}

export class AssertionError extends Error {}

export function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new AssertionError(message);
}

export function assertIncludes(haystack: string, needle: string, context: string): void {
  assert(haystack.includes(needle), `${context}: expected to find ${JSON.stringify(needle)}.`);
}

export function assertExcludes(haystack: string, needle: string, context: string): void {
  assert(!haystack.includes(needle), `${context}: expected NOT to find ${JSON.stringify(needle)}.`);
}

export function countOccurrences(lines: string[], token: string): number {
  return lines.filter((line) => line.includes(token)).length;
}

export function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** Polls until the predicate holds, so tests never depend on fixed sleeps. */
export async function waitFor(predicate: () => boolean, timeoutMs: number, description: string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await delay(100);
  }
  throw new AssertionError(`Timed out after ${timeoutMs} ms waiting for ${description}.`);
}
