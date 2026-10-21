import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Script } from "node:vm";
import { describe, expect, it } from "vitest";

class Element {
  value = "";
  textContent = "";
  disabled = false;
  children: Element[] = [];
  scrollHeight = 0;
  scrollTop = 0;
  clientHeight = 0;
  classList = { toggle: (_name: string, _enabled?: boolean): void => {} };
  listeners = new Map<string, (event: { target: Element }) => void>();

  get parentElement(): Element { return this; }
  replaceChildren(...children: Element[]): void {
    this.children = children;
    if (children.length && !children.some((child) => child.value === this.value)) this.value = children[0].value;
  }
  addEventListener(name: string, callback: (event: { target: Element }) => void): void {
    this.listeners.set(name, callback);
  }
  dispatch(name: string): void { this.listeners.get(name)?.({ target: this }); }
  append(_child: Element): void {}
}

describe("Balanced sidebar controls", () => {
  it("enables real Claude and Codex selections without global provider settings", () => {
    const elements = new Map<string, Element>();
    const get = (id: string): Element => {
      if (!elements.has(id)) elements.set(id, new Element());
      return elements.get(id)!;
    };
    get("balanced-agents").value = "real"; // First option in the webview HTML.
    const posted: Record<string, unknown>[] = [];
    let receive: ((event: { data: unknown }) => void) | undefined;
    const source = readFileSync(resolve(process.cwd(), "media/chat.js"), "utf8");
    new Script(source).runInNewContext({
      acquireVsCodeApi: () => ({ postMessage: (message: Record<string, unknown>) => posted.push(message) }),
      document: { getElementById: get, createElement: () => new Element() },
      window: { addEventListener: (_name: string, callback: (event: { data: unknown }) => void) => { receive = callback; } },
    });
    receive?.({ data: {
      type: "state",
      state: { activeThreadId: "thread", threads: [{ id: "thread", title: "Test", messages: [] }], modes: [
        { id: "chat", label: "Chat", protocol: "chat" },
        { id: "balanced", label: "Claude + Codex (Balanced)", protocol: "balanced" },
      ] },
      capabilities: [
        { provider: "mock", available: true, models: [{ value: "mock", label: "Mock", effortLevels: [] }] },
        { provider: "claude", available: true, models: [
          { value: "default", label: "Default", effortLevels: ["high"] },
          { value: "opus[1m]", label: "Opus", effortLevels: ["high"] },
        ] },
        { provider: "codex", available: true, models: [
          { value: "gpt-6.1-sol", label: "GPT", effortLevels: ["xhigh"] },
        ] },
      ],
    } });

    get("mode").value = "balanced";
    get("mode").dispatch("change");
    expect(get("balanced-claude-model").disabled).toBe(false);
    expect(get("balanced-codex-model").disabled).toBe(false);
    expect(get("balanced-claude-model").children.map((child) => child.value)).toContain("opus[1m]");
    expect(get("balanced-codex-model").children.map((child) => child.value)).toContain("gpt-6.1-sol");

    get("balanced-claude-model").value = "opus[1m]";
    get("balanced-claude-model").dispatch("change");
    get("balanced-claude-effort").value = "high";
    get("balanced-claude-effort").dispatch("change");
    get("balanced-codex-model").value = "gpt-6.1-sol";
    get("balanced-codex-model").dispatch("change");
    get("balanced-codex-effort").value = "xhigh";
    get("balanced-codex-effort").dispatch("change");
    get("prompt").value = "Change README";
    get("send").dispatch("click");
    expect(posted.at(-1)).toMatchObject({ type: "send", agents: "real", selection: {
      claudeModel: "opus[1m]", claudeEffort: "high", codexModel: "gpt-6.1-sol", codexEffort: "xhigh",
    } });
  });

  it("collects plan approval and clarification answers inside the sidebar", () => {
    const elements = new Map<string, Element>();
    const get = (id: string): Element => {
      if (!elements.has(id)) elements.set(id, new Element());
      return elements.get(id)!;
    };
    const posted: Record<string, unknown>[] = [];
    let receive: ((event: { data: unknown }) => void) | undefined;
    new Script(readFileSync(resolve(process.cwd(), "media/chat.js"), "utf8")).runInNewContext({
      acquireVsCodeApi: () => ({ postMessage: (message: Record<string, unknown>) => posted.push(message) }),
      document: { getElementById: get, createElement: () => new Element() },
      window: { addEventListener: (_name: string, callback: (event: { data: unknown }) => void) => { receive = callback; } },
    });
    const state = { activeThreadId: "thread", threads: [{ id: "thread", title: "Test", messages: [] }],
      modes: [{ id: "chat", label: "Chat", protocol: "chat" }] };
    receive?.({ data: { type: "state", state, capabilities: [], busy: true,
      workflowPrompt: { id: "plan-1", kind: "plan", title: "Review the plan", detail: "Read it above." } } });
    expect(get("workflow-submit").textContent).toBe("Approve plan");
    get("workflow-submit").dispatch("click");
    expect(posted.at(-1)).toMatchObject({ type: "workflowResponse", id: "plan-1", decision: "confirm" });

    receive?.({ data: { type: "state", state, capabilities: [], busy: true,
      workflowPrompt: { id: "question-1", kind: "question", title: "Claude asks", detail: "Which format?" } } });
    get("workflow-answer").value = "JSON";
    get("workflow-answer").dispatch("input");
    get("workflow-submit").dispatch("click");
    expect(posted.at(-1)).toMatchObject({ type: "workflowResponse", id: "question-1", decision: "answer", answer: "JSON" });
  });
});
