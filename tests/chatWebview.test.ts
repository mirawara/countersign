import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Script } from "node:vm";
import { describe, expect, it } from "vitest";

class Element {
  value = "";
  textContent = "";
  disabled = false;
  children: Element[] = [];
  get options(): Element[] { return this.children; }
  scrollHeight = 0;
  scrollTop = 0;
  clientHeight = 0;
  classes: Record<string, boolean> = {};
  classList = {
    toggle: (name: string, enabled?: boolean): void => { this.classes[name] = enabled ?? !this.classes[name]; },
  };
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
    const posted: Record<string, unknown>[] = [];
    let receive: ((event: { data: unknown }) => void) | undefined;
    const source = readFileSync(resolve(process.cwd(), "media/chat.js"), "utf8");
    new Script(source).runInNewContext({
      setInterval: () => 0,
      acquireVsCodeApi: () => ({ postMessage: (message: Record<string, unknown>) => posted.push(message) }),
      document: { getElementById: get, createElement: () => new Element() },
      window: { addEventListener: (_name: string, callback: (event: { data: unknown }) => void) => { receive = callback; } },
    });
    receive?.({ data: {
      type: "state",
      state: { activeThreadId: "thread", threads: [{ id: "thread", title: "Test", messages: [] }] },
      capabilities: [
        { provider: "mock", available: true, models: [{ value: "mock", label: "Mock", effortLevels: [] }] },
        { provider: "claude", available: true, models: [
          { value: "default", label: "Default", effortLevels: [{ value: "high" }] },
          { value: "opus[1m]", label: "Opus", effortLevels: [{ value: "high" }] },
        ] },
        { provider: "codex", available: true, models: [
          { value: "gpt-6.1-sol", label: "GPT", effortLevels: [{ value: "xhigh" }] },
        ] },
      ],
    } });

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
    get("execution-permission").value = "fullAccess";
    get("prompt").value = "Change README";
    get("send").dispatch("click");
    // The mode belongs to this task, not to the thread, so every send declares it.
    expect(posted.at(-1)).toMatchObject({ type: "send", mode: "balanced", executionPermission: "fullAccess", selection: {
      claudeModel: "opus[1m]", claudeEffort: "high", codexModel: "gpt-6.1-sol", codexEffort: "xhigh",
    } });
    expect(posted.at(-1)).not.toHaveProperty("provider");
    expect(posted.at(-1)).not.toHaveProperty("maxChangedFiles");

    // Strict is a per-task choice in the same thread.
    get("mode").value = "strict";
    get("mode").dispatch("change");
    get("prompt").value = "Refactor the parser";
    get("send").dispatch("click");
    expect(posted.at(-1)).toMatchObject({ type: "send", mode: "strict" });
  });

  it("offers exactly the levels each model's catalogue reports, including ones this build never knew", () => {
    const { get, posted, receive } = sidebar();
    receive({
      capabilities: [
        { provider: "claude", available: true, models: [
          // A level no allowlist in this repository has ever contained.
          { value: "opus[1m]", label: "Opus", effortLevels: [{ value: "ultra", label: "Ultra (new)" }, { value: "high" }] },
          { value: "haiku", label: "Haiku", effortLevels: [{ value: "low" }] },
        ] },
        { provider: "codex", available: true, models: [
          { value: "gpt", label: "GPT", effortLevels: [{ value: "xhigh" }] },
        ] },
      ],
    });

    get("balanced-claude-model").value = "opus[1m]";
    get("balanced-claude-model").dispatch("change");
    expect(get("balanced-claude-effort").children.map((child) => child.value)).toEqual(["", "ultra", "high"]);
    // The catalogue's own label is what the menu shows.
    expect(get("balanced-claude-effort").children.map((child) => child.textContent))
      .toEqual(["Default (CLI)", "Ultra (new)", "high"]);

    get("balanced-claude-effort").value = "ultra";
    get("balanced-claude-effort").dispatch("change");
    get("prompt").value = "Do the thing";
    get("send").dispatch("click");
    // Sent to the provider exactly as the catalogue spelled it.
    expect(posted.at(-1)).toMatchObject({ selection: { claudeModel: "opus[1m]", claudeEffort: "ultra" } });
  });

  it("drops a saved level the selected model does not offer, and says so", () => {
    const { get, posted, receive } = sidebar();
    const capabilities = [
      { provider: "claude", available: true, models: [
        { value: "opus[1m]", label: "Opus", effortLevels: [{ value: "ultra" }] },
        { value: "haiku", label: "Haiku", effortLevels: [{ value: "low" }] },
      ] },
      { provider: "codex", available: true, models: [{ value: "gpt", label: "GPT", effortLevels: [{ value: "xhigh" }] }] },
    ];
    receive({ capabilities });
    get("balanced-claude-model").value = "opus[1m]";
    get("balanced-claude-model").dispatch("change");
    get("balanced-claude-effort").value = "ultra";
    get("balanced-claude-effort").dispatch("change");

    // Switching to a model whose catalogue has different levels.
    get("balanced-claude-model").value = "haiku";
    get("balanced-claude-model").dispatch("change");
    expect(get("balanced-claude-effort").children.map((child) => child.value)).toEqual(["", "low"]);
    expect(get("selection-notice").classes.hidden).toBe(false);
    expect(get("selection-notice").textContent).toContain("ultra");
    expect(get("selection-notice").textContent).toContain("CLI default");

    get("prompt").value = "Do the thing";
    get("send").dispatch("click");
    // Fallen back to the CLI default rather than sending a level the model rejects.
    expect(posted.at(-1)).toMatchObject({ selection: { claudeModel: "haiku", claudeEffort: "" } });
  });

  it("falls back and warns when a saved model has left the catalogue", () => {
    const { get, receive } = sidebar();
    receive({
      capabilities: [
        { provider: "claude", available: true, models: [{ value: "opus[1m]", label: "Opus", effortLevels: [{ value: "high" }] }] },
        { provider: "codex", available: true, models: [{ value: "gpt", label: "GPT", effortLevels: [{ value: "xhigh" }] }] },
      ],
    });
    get("balanced-claude-model").value = "opus[1m]";
    get("balanced-claude-model").dispatch("change");

    // The next refresh no longer lists that model.
    receive({
      capabilities: [
        { provider: "claude", available: true, models: [{ value: "haiku", label: "Haiku", effortLevels: [{ value: "low" }] }] },
        { provider: "codex", available: true, models: [{ value: "gpt", label: "GPT", effortLevels: [{ value: "xhigh" }] }] },
      ],
    });
    expect(get("selection-notice").classes.hidden).toBe(false);
    expect(get("selection-notice").textContent).toContain("opus[1m]");
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
      setInterval: () => 0,
      acquireVsCodeApi: () => ({ postMessage: (message: Record<string, unknown>) => posted.push(message) }),
      document: { getElementById: get, createElement: () => new Element() },
      window: { addEventListener: (_name: string, callback: (event: { data: unknown }) => void) => { receive = callback; } },
    });
    const state = { activeThreadId: "thread", threads: [{ id: "thread", title: "Test", messages: [] }] };
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

    // The Strict gate shows the plan estimate and the permission the user confirms.
    receive?.({ data: { type: "state", state, capabilities: [], busy: true,
      workflowPrompt: { id: "strict-1", kind: "strictPlan", title: "Approve the Strict plan",
        detail: "Approve this exact plan hash.",
        strict: { planHash: "a".repeat(64), expectedFileCount: 50, expectedFilesComplete: true,
          executionPermission: "askBeforeChange" } } } });
    expect(get("strict-controls").classes.hidden).toBe(false);
    expect(get("strict-hint").textContent).toContain("expects 50 file(s)");
    get("strict-permission").value = "fullAccess";
    get("workflow-submit").dispatch("click");
    expect(posted.at(-1)).toMatchObject({ type: "workflowResponse", id: "strict-1", decision: "approve", executionPermission: "fullAccess" });
    get("workflow-secondary").dispatch("click");
    expect(posted.at(-1)).toMatchObject({ type: "workflowResponse", id: "strict-1", decision: "refuse" });

    // An unestimable file list asks for an explicit acknowledgement.
    receive?.({ data: { type: "state", state, capabilities: [], busy: true,
      workflowPrompt: { id: "strict-2", kind: "strictPlan", title: "Approve the Strict plan", detail: "Approve this plan or refuse it.",
        strict: { planHash: "b".repeat(64), expectedFilesComplete: false, executionPermission: "askBeforeChange" } } } });
    expect(get("strict-hint").textContent).toContain("cannot estimate");

    // A paused task offers resume and stop, in this window only.
    receive?.({ data: { type: "state", state, capabilities: [], busy: true,
      workflowPrompt: { id: "pause-1", kind: "pause", title: "Strict task paused", detail: "Resume or stop." } } });
    expect(get("workflow-submit").textContent).toBe("Resume task");
    expect(get("workflow-secondary").textContent).toBe("Stop task");
    get("workflow-submit").dispatch("click");
    expect(posted.at(-1)).toMatchObject({ type: "workflowResponse", id: "pause-1", decision: "resume" });
    get("workflow-secondary").dispatch("click");
    expect(posted.at(-1)).toMatchObject({ type: "workflowResponse", id: "pause-1", decision: "stop" });
  });
});

/** A fresh sidebar script with its own element table, for the catalogue cases. */
function sidebar(): {
  get: (id: string) => Element;
  posted: Record<string, unknown>[];
  receive: (state: Record<string, unknown>) => void;
} {
  const elements = new Map<string, Element>();
  const get = (id: string): Element => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id)!;
  };
  const posted: Record<string, unknown>[] = [];
  let listener: ((event: { data: unknown }) => void) | undefined;
  new Script(readFileSync(resolve(process.cwd(), "media/chat.js"), "utf8")).runInNewContext({
    setInterval: () => 0,
    acquireVsCodeApi: () => ({ postMessage: (message: Record<string, unknown>) => posted.push(message) }),
    document: { getElementById: get, createElement: () => new Element() },
    window: { addEventListener: (_name: string, callback: (event: { data: unknown }) => void) => { listener = callback; } },
  });
  const receive = (state: Record<string, unknown>): void => listener?.({
    data: {
      type: "state",
      state: { activeThreadId: "thread", threads: [{ id: "thread", title: "Test", messages: [] }] },
      busy: false,
      ...state,
    },
  });
  return { get, posted, receive };
}
