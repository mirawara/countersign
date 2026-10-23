import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Script } from "node:vm";
import { describe, expect, it } from "vitest";

/** Minimal DOM double that records the node tree the webview script builds. */
class Element {
  value = "";
  textContent = "";
  className = "";
  disabled = false;
  children: Element[] = [];
  get options(): Element[] { return this.children; }
  scrollHeight = 0;
  scrollTop = 0;
  clientHeight = 0;
  classList = { toggle: (_name: string, _enabled?: boolean): void => {} };
  listeners = new Map<string, (event: { target: Element }) => void>();

  constructor(readonly tag = "div") {}
  get parentElement(): Element { return this; }
  replaceChildren(...children: Element[]): void {
    this.children = children;
    if (children.length && !children.some((child) => child.value === this.value)) this.value = children[0].value;
  }
  append(...children: Element[]): void { this.children.push(...children); }
  addEventListener(name: string, callback: (event: { target: Element }) => void): void { this.listeners.set(name, callback); }
  dispatch(name: string): void { this.listeners.get(name)?.({ target: this }); }
  find(predicate: (node: Element) => boolean): Element | undefined {
    if (predicate(this)) return this;
    for (const child of this.children) {
      const match = child.find(predicate);
      if (match) return match;
    }
    return undefined;
  }
  text(): string { return this.children.length ? this.children.map((child) => child.text()).join("") : this.textContent; }
}

function run(messages: unknown[]): { get: (id: string) => Element } {
  const elements = new Map<string, Element>();
  const get = (id: string): Element => {
    if (!elements.has(id)) elements.set(id, new Element());
    return elements.get(id)!;
  };
  let receive: ((event: { data: unknown }) => void) | undefined;
  const source = readFileSync(resolve(process.cwd(), "media/chat.js"), "utf8");
  new Script(source).runInNewContext({
    setInterval: () => 0,
    acquireVsCodeApi: () => ({ postMessage: () => {} }),
    document: { getElementById: get, createElement: (tag: string) => new Element(tag) },
    window: { addEventListener: (_name: string, callback: (event: { data: unknown }) => void) => { receive = callback; } },
  });
  receive?.({ data: {
    type: "state",
    state: { activeThreadId: "thread", threads: [{ id: "thread", title: "Test", messages }] },
    capabilities: [{ provider: "claude", available: true, accountLabel: "Claude login", models: [{ value: "default", label: "Default", effortLevels: ["high"] }] }],
  } });
  return { get };
}

describe("chat message rendering", () => {
  it("separates user and assistant rows", () => {
    const { get } = run([
      { id: "a", role: "user", text: "Explain this", createdAt: "2026-10-21T09:00:00.000Z" },
      { id: "b", role: "assistant", provider: "claude", text: "Answer", status: "completed", createdAt: "2026-10-21T09:00:05.000Z" },
    ]);
    const rows = get("messages").children;
    expect(rows.map((row) => row.className)).toEqual(["row user", "row assistant"]);
    expect(rows[0].find((node) => node.className === "who")?.textContent).toBe("You");
    expect(rows[1].find((node) => node.className === "who")?.textContent).toBe("Claude");
  });

  it("renders fenced code, inline code and lists as nodes instead of raw text", () => {
    const { get } = run([{
      id: "a", role: "assistant", provider: "codex", status: "completed", createdAt: "2026-10-21T09:00:00.000Z",
      text: "## Title\n\nUse `npm test` first.\n\n- one\n- two\n\n```ts\nconst x = 1;\n```",
    }]);
    const body = get("messages").children[0].find((node) => node.className === "body")!;
    expect(body.find((node) => node.className === "heading")?.text()).toBe("Title");
    expect(body.find((node) => node.className === "inline-code")?.textContent).toBe("npm test");
    expect(body.find((node) => node.className === "list")?.children.map((item) => item.text())).toEqual(["one", "two"]);
    const code = body.find((node) => node.className === "code-block")!;
    expect(code.find((node) => node.className === "code-language")?.textContent).toBe("ts");
    expect(code.find((node) => node.tag === "pre")?.textContent).toBe("const x = 1;");
  });

  it("shows a working placeholder and collapses activity for a running turn", () => {
    const { get } = run([{
      id: "a", role: "assistant", provider: "claude", status: "running", text: "",
      createdAt: "2026-10-21T09:00:00.000Z", activity: ["Read file", "Ran check"],
    }]);
    const row = get("messages").children[0];
    expect(row.find((node) => node.className === "typing")?.textContent).toBe("Working…");
    expect(row.find((node) => node.className === "status running")?.textContent).toBe("running");
    expect(row.find((node) => node.className === "activity")?.find((node) => node.tag === "summary")?.textContent)
      .toBe("Activity (2)");
  });
});
