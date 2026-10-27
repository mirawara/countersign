import { ChildProcess, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import { ChatAccountUsage, ChatModelOption } from "./types";
import { codexAccountUsage } from "./accountUsage";
import { cavemanCoversAnswer, codexCavemanPrompt } from "../shared/cavemanSkill";
import { CavemanStyle, ExecutionPermission } from "../configuration/config";
import { executableOutput, safeSummary, subscriptionEnvironment } from "./providerUtils";

type Json = Record<string, unknown>;
type Pending = { resolve: (value: Json) => void; reject: (error: Error) => void; timer: NodeJS.Timeout };

function record(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function get(value: unknown, key: string): unknown { return record(value) ? value[key] : undefined; }

export class CodexAppServer {
  private readonly child: ChildProcess;
  private readonly pending = new Map<number, Pending>();
  private readonly events: Json[] = [];
  private nextId = 1;
  private exitError: Error | undefined;
  private closed = false;

  constructor(executable: string, cwd: string, codexHome?: string) {
    this.child = spawn(executable, [...(codexHome ? ["--config", 'cli_auth_credentials_store="file"'] : []),
      "app-server", "--listen", "stdio://"], {
      cwd, env: subscriptionEnvironment(codexHome ? { CODEX_HOME: codexHome } : undefined), stdio: ["pipe", "pipe", "pipe"],
      shell: false, windowsHide: true, detached: process.platform !== "win32",
    });
    this.child.stderr?.resume();
    this.child.once("error", (error) => this.fail(error));
    this.child.once("exit", () => this.fail(new Error("Codex app-server exited.")));
    createInterface({ input: this.child.stdout! }).on("line", (line) => {
      if (line.length > 2_000_000) { this.close(); return; }
      let message: unknown;
      try { message = JSON.parse(line); } catch { return; }
      if (!record(message)) return;
      const id = message.id;
      if (typeof id === "number" && this.pending.has(id)) {
        const pending = this.pending.get(id)!;
        this.pending.delete(id);
        clearTimeout(pending.timer);
        if (message.error) pending.reject(new Error(`Codex protocol error: ${safeSummary(message.error, 200)}`));
        else pending.resolve(record(message.result) ? message.result : {});
      } else if (typeof message.method === "string") {
        this.events.push(message);
        if (this.events.length > 2_000) this.events.splice(0, this.events.length - 2_000);
      }
    });
  }

  async initialize(timeoutMs = 20_000): Promise<void> {
    await this.request("initialize", { clientInfo: { name: "countersign", title: "Countersign", version: "0.1.0" } }, timeoutMs);
    this.notify("initialized");
  }

  request(method: string, params: Json = {}, timeoutMs = 20_000): Promise<Json> {
    if (this.closed || this.exitError) return Promise.reject(this.exitError ?? new Error("Codex app-server closed."));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin?.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  notify(method: string, params: Json = {}): void {
    this.child.stdin?.write(`${JSON.stringify({ method, params })}\n`);
  }

  respond(id: number, result: Json): void {
    this.child.stdin?.write(`${JSON.stringify({ id, result })}\n`);
  }

  takeEvent(): Json | undefined { return this.events.shift(); }
  get failure(): Error | undefined { return this.exitError; }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    if (this.child.pid) {
      try { process.kill(process.platform === "win32" ? this.child.pid : -this.child.pid, "SIGTERM"); } catch { /* exited */ }
      const pid = this.child.pid;
      setTimeout(() => { try { process.kill(process.platform === "win32" ? pid : -pid, "SIGKILL"); } catch { /* exited */ } }, 1_000).unref();
    }
    this.fail(new Error("Codex app-server closed."));
  }

  private fail(error: Error): void {
    if (this.exitError) return;
    this.exitError = error;
    for (const pending of this.pending.values()) { clearTimeout(pending.timer); pending.reject(error); }
    this.pending.clear();
  }
}

export interface CodexAvailability {
  version: string;
  accountLabel: string;
  accountEmail?: string;
  usage?: ChatAccountUsage;
  models: ChatModelOption[];
}

/** Read only the email needed by the account picker; no model or usage request. */
export async function inspectCodexAccount(executable: string, cwd: string, codexHome?: string): Promise<string | undefined> {
  subscriptionEnvironment();
  const server = new CodexAppServer(executable, cwd, codexHome);
  try {
    await server.initialize(8_000);
    const account = await server.request("account/read", { refreshToken: false }, 8_000);
    const email = get(account.account, "email");
    return get(account.account, "type") === "chatgpt" && typeof email === "string" && email.trim()
      ? email.trim() : undefined;
  } finally { server.close(); }
}

export async function inspectCodex(executable: string, cwd: string, codexHome?: string,
  includeUsage = false): Promise<CodexAvailability> {
  subscriptionEnvironment();
  const version = await executableOutput(executable, ["--version"], cwd,
    codexHome ? { CODEX_HOME: codexHome } : undefined);
  const server = new CodexAppServer(executable, cwd, codexHome);
  try {
    await server.initialize();
    const account = await server.request("account/read", { refreshToken: false });
    if (get(account.account, "type") !== "chatgpt") throw new Error("Sign in with the official ChatGPT Codex login.");
    const catalog = await server.request("model/list", { limit: 100, includeHidden: false });
    const rows = Array.isArray(catalog.data) ? catalog.data : [];
    const models: ChatModelOption[] = rows.filter(record).filter((row) => typeof row.model === "string")
      .map((row) => ({ value: row.model as string, label: typeof row.displayName === "string" ? row.displayName : row.model as string,
        effortLevels: Array.isArray(row.supportedReasoningEfforts)
          ? row.supportedReasoningEfforts
            .map((entry) => {
              const value = get(entry, "reasoningEffort");
              if (typeof value !== "string") return undefined;
              const label = get(entry, "displayName") ?? get(entry, "label");
              return { value, label: typeof label === "string" ? label : codexEffortLabel(value) };
            })
            .filter((entry): entry is { value: string; label: string } => entry !== undefined)
          : [] }));
    const email = get(account.account, "email");
    const accountEmail = typeof email === "string" && email.trim() ? email.trim() : undefined;
    let usage: ChatAccountUsage | undefined;
    if (includeUsage) {
      try { usage = codexAccountUsage(await server.request("account/rateLimits/read", {}, 8_000)); }
      catch { /* A quota read is optional and cannot fail model discovery. */ }
    }
    return { version, accountLabel: accountEmail ?? "ChatGPT subscription login",
      ...(accountEmail ? { accountEmail } : {}), ...(usage ? { usage } : {}), models };
  } finally { server.close(); }
}

function codexEffortLabel(value: string): string {
  switch (value) {
    case "low": return "Light";
    case "medium": return "Medium";
    case "high": return "High";
    case "xhigh": return "Extra high";
    case "max": return "Max";
    case "ultra": return "Ultra";
    default: return value;
  }
}

export interface CodexTurn {
  executable: string;
  cwd: string;
  codexHome?: string;
  prompt: string;
  sessionId?: string;
  model: string;
  effort?: string;
  signal: AbortSignal;
  onText: (text: string) => void;
  onActivity: (text: string) => void;
  askPermission: (kind: "command" | "fileChange", detail: string, signal: AbortSignal) => Promise<boolean>;
  phase?: "planning";
  executionPermission?: ExecutionPermission;
  cavemanStyle?: CavemanStyle;
}

async function findCavemanSkill(server: CodexAppServer, cwd: string): Promise<{ name: string; path: string } | undefined> {
  try {
    const reply = await server.request("skills/list", { cwds: [cwd], forceReload: true }, 8_000);
    const data = reply.data;
    if (!Array.isArray(data)) return undefined;
    const item = data.find((entry) => get(entry, "cwd") === cwd);
    const skills = get(item, "skills");
    if (!Array.isArray(skills)) return undefined;
    const selected = skills.find((entry) => get(entry, "name") === "caveman:caveman" && get(entry, "enabled") === true)
      ?? skills.find((entry) => get(entry, "name") === "caveman" && get(entry, "enabled") === true);
    const name = get(selected, "name");
    const path = get(selected, "path");
    return typeof name === "string" && typeof path === "string" ? { name, path } : undefined;
  } catch { return undefined; }
}

export async function runCodexTurn(options: CodexTurn): Promise<{ sessionId: string }> {
  const fullAccess = options.phase !== "planning" && options.executionPermission === "fullAccess";
  const approvalPolicy = options.phase === "planning" || fullAccess ? "never" : "on-request";
  const sandbox = fullAccess ? "danger-full-access" : "read-only";
  const sandboxPolicy = { type: fullAccess ? "dangerFullAccess" : "readOnly" };
  const server = new CodexAppServer(options.executable, options.cwd, options.codexHome);
  let threadId = options.sessionId;
  let turnId: string | undefined;
  let cancelled = options.signal.aborted;
  const onAbort = (): void => {
    cancelled = true;
    if (threadId && turnId) void server.request("turn/interrupt", { threadId, turnId }, 5_000).catch(() => {});
  };
  options.signal.addEventListener("abort", onAbort, { once: true });
  try {
    if (cancelled) throw new Error("Codex turn cancelled.");
    await server.initialize();
    const account = await server.request("account/read", { refreshToken: false });
    if (get(account.account, "type") !== "chatgpt") throw new Error("Codex is not signed in with ChatGPT.");
    // A chat turn is nothing but the answer, so the style either covers it or is not applied.
    const style = options.cavemanStyle ?? "auto";
    const caveman = style === "internalOnly" ? undefined : await findCavemanSkill(server, options.cwd);
    const terse = cavemanCoversAnswer(style, caveman !== undefined);
    if (threadId) await server.request("thread/resume", { threadId });
    else {
      const started = await server.request("thread/start", { cwd: options.cwd, model: options.model,
        approvalPolicy, sandbox });
      threadId = get(started.thread, "id") as string | undefined;
      if (!threadId) throw new Error("Codex did not return a thread ID.");
    }
    const started = await server.request("turn/start", { threadId,
      input: [
        { type: "text", text: terse ? codexCavemanPrompt(options.prompt, caveman?.name, "always", []) : options.prompt },
        ...(terse && caveman ? [{ type: "skill", name: caveman.name, path: caveman.path }] : []),
      ], cwd: options.cwd, model: options.model,
      ...(options.effort ? { effort: options.effort } : {}),
      approvalPolicy, sandboxPolicy,
    }, 30_000);
    turnId = get(started.turn, "id") as string | undefined;
    if (!turnId) throw new Error("Codex did not return a turn ID.");
    if (cancelled) onAbort();
    const deadline = Date.now() + 180_000;
    while (Date.now() < deadline) {
      const event = server.takeEvent();
      if (!event) {
        if (server.failure) throw server.failure;
        await new Promise((resolve) => setTimeout(resolve, 25));
        continue;
      }
      const method = event.method;
      const params = record(event.params) ? event.params : {};
      if (params.threadId !== threadId) continue;
      if (method === "item/agentMessage/delta" && typeof params.delta === "string") options.onText(params.delta);
      if (method === "item/started") {
        const kind = get(params.item, "type");
        if (typeof kind === "string") options.onActivity(`Started: ${kind}`);
      }
      if (typeof event.id === "number" && (method === "item/commandExecution/requestApproval" || method === "item/fileChange/requestApproval")) {
        const kind = method === "item/commandExecution/requestApproval" ? "command" : "fileChange";
        const approved = options.phase === "planning" ? false : fullAccess ? true
          : await options.askPermission(kind, safeSummary(params), options.signal);
        server.respond(event.id, { decision: approved && !cancelled ? "accept" : "cancel" });
      }
      if (method === "turn/completed" && get(params.turn, "id") === turnId) {
        const status = get(params.turn, "status");
        if (status !== "completed" || cancelled) {
          const message = get(get(params.turn, "error"), "message");
          if (typeof message === "string" && /quota|usage.?limit|rate.?limit/i.test(message)) {
            throw new Error("Codex reported a usage or rate limit. Choose when to retry; no account switch was attempted.");
          }
          throw new Error(`Codex turn ended: ${String(status)}.`);
        }
        return { sessionId: threadId };
      }
    }
    onAbort();
    throw new Error("Codex turn timed out.");
  } finally {
    options.signal.removeEventListener("abort", onAbort);
    server.close();
  }
}
