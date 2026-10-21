// Manual vNext protocol probe. No inference without --live.
// Prints only derived facts: never raw account data, prompts, or responses.
import { spawn, spawnSync } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";

const live = process.argv.includes("--live");
const cancelProbe = process.argv.includes("--cancel-probe");
const shellInterruptProbe = process.argv.includes("--interrupt-shell-probe");
const permissionProbe = process.argv.includes("--permission-probe");
if ((cancelProbe || permissionProbe) && !live) {
  throw new Error("A model turn requires --live; no inference was started.");
}
const login = spawnSync("codex", ["login", "status"], { encoding: "utf8", timeout: 10_000 });
if (login.status !== 0 || !/logged in.*chatgpt/i.test(`${login.stdout}\n${login.stderr}`)) {
  throw new Error("Codex is not confirmed as signed in with ChatGPT; no probe was started.");
}
const directory = await mkdtemp(join(tmpdir(), "countersign-codex-spike-"));
const git = spawnSync("git", ["init", "--quiet", directory], { encoding: "utf8", timeout: 10_000 });
if (git.status !== 0) throw new Error("Temporary Git repository could not be created.");
await writeFile(join(directory, "README.md"), "Temporary Countersign protocol probe.\n");

class AppServer {
  constructor(cwd) {
    this.child = spawn("codex", ["app-server", "--listen", "stdio://"], {
      cwd, stdio: ["pipe", "pipe", "pipe"], detached: process.platform !== "win32",
      env: Object.fromEntries(Object.entries(process.env).filter(([key]) =>
        !/^(OPENAI_API_KEY|CODEX_API_KEY|ANTHROPIC_API_KEY|ANTHROPIC_AUTH_TOKEN)$/.test(key) &&
        (!key.startsWith("CODEX_") || key === "CODEX_HOME"))),
    });
    this.nextId = 1;
    this.pending = new Map();
    this.events = [];
    this.stderrBytes = 0;
    this.child.stderr.on("data", (chunk) => { this.stderrBytes += chunk.length; });
    createInterface({ input: this.child.stdout }).on("line", (line) => {
      let message;
      try { message = JSON.parse(line); } catch { return; }
      if (typeof message.id === "number" && this.pending.has(message.id)) {
        const { resolve, reject, timer } = this.pending.get(message.id);
        clearTimeout(timer);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(`Protocol error ${String(message.error.code ?? "unknown")}`));
        else resolve(message.result);
      } else if (typeof message.method === "string") {
        this.events.push(message);
      }
    });
    this.child.on("exit", () => {
      for (const { reject, timer } of this.pending.values()) {
        clearTimeout(timer);
        reject(new Error("App-server exited before replying."));
      }
      this.pending.clear();
    });
  }

  request(method, params = {}, timeoutMs = 20_000) {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`${method} timed out.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  }

  notify(method, params = {}) {
    this.child.stdin.write(`${JSON.stringify({ method, params })}\n`);
  }

  respond(id, result) {
    this.child.stdin.write(`${JSON.stringify({ id, result })}\n`);
  }

  async initialize() {
    await this.request("initialize", { clientInfo: { name: "countersign_spike", title: "Countersign Spike", version: "0.1.0" } });
    this.notify("initialized");
  }

  async completedTurn(threadId, prompt, model, effort) {
    const started = await this.request("turn/start", {
      threadId, input: [{ type: "text", text: prompt }], cwd: directory,
      model, effort, approvalPolicy: "never", sandboxPolicy: { type: "readOnly" },
    }, 30_000);
    const turnId = started?.turn?.id;
    if (typeof turnId !== "string") throw new Error("turn/start returned no turn ID.");
    const deadline = Date.now() + 120_000;
    while (Date.now() < deadline) {
      const index = this.events.findIndex((event) => event.method === "turn/completed" && event.params?.threadId === threadId && event.params?.turn?.id === turnId);
      if (index >= 0) {
        const completed = this.events.splice(index, 1)[0];
        const deltas = this.events.filter((event) => event.method === "item/agentMessage/delta" && event.params?.threadId === threadId);
        this.events = this.events.filter((event) => event.method !== "item/agentMessage/delta" || event.params?.threadId !== threadId);
        return { status: completed.params.turn.status, deltaCount: deltas.length, text: deltas.map((event) => event.params?.delta ?? "").join("") };
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    await this.request("turn/interrupt", { threadId, turnId }).catch(() => {});
    throw new Error("Turn timed out and interruption was requested.");
  }

  close() {
    if (this.child.pid) {
      try { process.kill(process.platform === "win32" ? this.child.pid : -this.child.pid, "SIGTERM"); } catch { /* exited */ }
    }
  }
}

let first;
let second;
try {
  first = new AppServer(directory);
  await first.initialize();
  const account = await first.request("account/read", { refreshToken: false });
  const accountType = account?.account?.type ?? null;
  if (accountType !== "chatgpt") throw new Error("App-server did not confirm ChatGPT authentication; no inference was sent.");
  const models = await first.request("model/list", { limit: 100, includeHidden: false });
  const data = Array.isArray(models?.data) ? models.data : [];
  const selected = data.find((entry) => entry.isDefault) ?? data[0];
  console.log(JSON.stringify({ phase: "local", appServerInitialized: true, accountType, modelCount: data.length,
    selectedModel: selected?.model ?? null, efforts: selected?.supportedReasoningEfforts?.map((value) => value.reasoningEffort) ?? [] }));
  if (shellInterruptProbe) {
    const marker = join(directory, "must-not-exist-after-cancel");
    const started = await first.request("thread/start", { cwd: directory, model: selected.model,
      sandboxPolicy: { type: "readOnly" } });
    const threadId = started?.thread?.id;
    if (typeof threadId !== "string") throw new Error("thread/start returned no thread ID.");
    await first.request("thread/shellCommand", { threadId,
      command: "sh -c 'echo $$ > .spike-shell-pid; sleep 8; touch must-not-exist-after-cancel'", timeoutMs: 10_000 });
    let turnId = null;
    const startDeadline = Date.now() + 5_000;
    while (Date.now() < startDeadline) {
      const event = first.events.find((value) => value.method === "turn/started" && value.params?.threadId === threadId);
      if (event) { turnId = event.params?.turn?.id; break; }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (typeof turnId !== "string") throw new Error("Shell command did not start a turn.");
    let shellPid = null;
    const pidDeadline = Date.now() + 5_000;
    while (Date.now() < pidDeadline) {
      try {
        const value = Number((await readFile(join(directory, ".spike-shell-pid"), "utf8")).trim());
        if (Number.isSafeInteger(value) && value > 0) { shellPid = value; break; }
      } catch { /* command has not started yet */ }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (shellPid === null) throw new Error("Shell command PID was not observed.");
    let interruptAccepted = false;
    try { await first.request("turn/interrupt", { threadId, turnId }); interruptAccepted = true; } catch { /* recorded below */ }
    let finalStatus = null;
    const finishDeadline = Date.now() + 10_000;
    while (Date.now() < finishDeadline) {
      const event = first.events.find((value) => value.method === "turn/completed" &&
        value.params?.threadId === threadId && value.params?.turn?.id === turnId);
      if (event) { finalStatus = event.params.turn.status; break; }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    let markerAbsent = false;
    try { await access(marker); } catch { markerAbsent = true; }
    await new Promise((resolve) => setTimeout(resolve, 300));
    const shellState = spawnSync("ps", ["-o", "stat=", "-p", String(shellPid)], { encoding: "utf8", timeout: 5_000 }).stdout.trim();
    const shellStopped = !shellState || shellState.startsWith("Z");
    console.log(JSON.stringify({ phase: "interrupt-shell-probe", interruptAccepted, finalStatus, markerAbsent, shellStopped }));
    await first.request("thread/delete", { threadId }).catch(() => {});
    if (!interruptAccepted || finalStatus !== "interrupted" || !markerAbsent || !shellStopped) process.exitCode = 1;
  } else if (permissionProbe) {
    if (!selected?.model) throw new Error("No model was returned for a live turn.");
    const attemptedFile = join(directory, "must-not-exist-after-denial");
    const started = await first.request("thread/start", { cwd: directory, model: selected.model,
      approvalPolicy: "on-request", sandbox: "read-only" });
    const threadId = started?.thread?.id;
    if (typeof threadId !== "string") throw new Error("thread/start returned no thread ID.");
    try {
      const turn = await first.request("turn/start", { threadId,
        input: [{ type: "text", text: "Create a file named must-not-exist-after-denial containing TEST in this temporary repository. Use a command or file edit tool. Wait for any required approval; do not treat approval as implicit." }],
        cwd: directory, model: selected.model, approvalPolicy: "on-request", sandboxPolicy: { type: "readOnly" } }, 30_000);
      const turnId = turn?.turn?.id;
      if (typeof turnId !== "string") throw new Error("turn/start returned no turn ID.");
      let approvalMethod = null;
      let finalStatus = null;
      let failureKind = null;
      let failureClass = null;
      const deadline = Date.now() + 90_000;
      while (Date.now() < deadline) {
        const requestIndex = first.events.findIndex((event) => typeof event.id === "number" &&
          ["item/commandExecution/requestApproval", "item/fileChange/requestApproval"].includes(event.method) &&
          event.params?.threadId === threadId && event.params?.turnId === turnId);
        if (requestIndex >= 0) {
          const event = first.events.splice(requestIndex, 1)[0];
          approvalMethod = event.method;
          first.respond(event.id, { decision: "cancel" });
        }
        const completed = first.events.find((event) => event.method === "turn/completed" &&
          event.params?.threadId === threadId && event.params?.turn?.id === turnId);
        if (completed) {
          finalStatus = completed.params.turn.status;
          const error = completed.params.turn.error;
          const rawKind = error?.codexErrorInfo?.type ?? Object.keys(error?.codexErrorInfo ?? {})[0] ?? null;
          failureKind = typeof rawKind === "string" && /^[A-Za-z0-9_]+$/.test(rawKind) ? rawKind : null;
          const message = typeof error?.message === "string" ? error.message : "";
          failureClass = /quota|usage.?limit|rate.?limit/i.test(message) ? "quota" :
            /auth|login|unauthorized|forbidden/i.test(message) ? "authentication" :
            /sandbox|read.?only|write.?access/i.test(message) ? "sandbox" :
            /approv|permission|denied/i.test(message) ? "permissions" :
            /connect|network|http|timeout/i.test(message) ? "network" :
            message ? "other" : null;
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      if (finalStatus === null) await first.request("turn/interrupt", { threadId, turnId }).catch(() => {});
      let fileAbsent = false;
      try { await access(attemptedFile); } catch { fileAbsent = true; }
      const serverRequestTypes = [...new Set(first.events.filter((event) => typeof event.id === "number" &&
        typeof event.method === "string").map((event) => event.method))];
      const itemTypes = [...new Set(first.events.filter((event) => event.method === "item/started" ||
        event.method === "item/completed").map((event) => event.params?.item?.type).filter(Boolean))];
      console.log(JSON.stringify({ phase: "permission-probe", approvalMethod, decision: approvalMethod ? "cancel" : null,
        finalStatus, failureKind, failureClass, serverRequestTypes, itemTypes, fileAbsent }));
      if (!approvalMethod || finalStatus !== "interrupted" || !fileAbsent) process.exitCode = 1;
    } finally {
      await first.request("thread/delete", { threadId }).catch(() => {});
    }
  } else if (cancelProbe) {
    const attemptedFile = join(directory, "must-not-exist");
    let commandExit = null;
    try {
      const command = await first.request("command/exec", { command: ["sh", "-c", "touch must-not-exist"],
        cwd: directory, sandboxPolicy: { type: "readOnly" }, timeoutMs: 10_000 });
      commandExit = command?.exitCode ?? null;
    } catch { commandExit = "rejected"; }
    let writeBlocked = false;
    try { await access(attemptedFile); } catch { writeBlocked = true; }
    const started = await first.request("thread/start", { cwd: directory, model: selected.model,
      sandboxPolicy: { type: "readOnly" } });
    const threadId = started?.thread?.id;
    if (typeof threadId !== "string") throw new Error("thread/start returned no thread ID.");
    const turn = await first.request("turn/start", { threadId,
      input: [{ type: "text", text: "Write a long detailed explanation of this temporary repository. Do not use tools." }],
      cwd: directory, model: selected.model, approvalPolicy: "never", sandboxPolicy: { type: "readOnly" } });
    const turnId = turn?.turn?.id;
    if (typeof turnId !== "string") throw new Error("turn/start returned no turn ID.");
    let interruptAccepted = false;
    try { await first.request("turn/interrupt", { threadId, turnId }); interruptAccepted = true; } catch { /* may finish first */ }
    const deadline = Date.now() + 30_000;
    let finalStatus = null;
    while (Date.now() < deadline) {
      const event = first.events.find((value) => value.method === "turn/completed" &&
        value.params?.threadId === threadId && value.params?.turn?.id === turnId);
      if (event) { finalStatus = event.params.turn.status; break; }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    console.log(JSON.stringify({ phase: "cancel-probe", commandExit, writeBlocked, interruptAccepted, finalStatus }));
    await first.request("thread/delete", { threadId }).catch(() => {});
    if (!writeBlocked || !interruptAccepted || finalStatus !== "interrupted") process.exitCode = 1;
  } else if (!live) process.exitCode = 0;
  else {
    if (!selected?.model) throw new Error("No model was returned for a live turn.");
    const started = await first.request("thread/start", { cwd: directory, model: selected.model, sandboxPolicy: { type: "readOnly" } });
    const threadId = started?.thread?.id;
    if (typeof threadId !== "string") throw new Error("thread/start returned no thread ID.");
    const effort = selected.defaultReasoningEffort;
    const turnOne = await first.completedTurn(threadId, "Remember the marker VIOLET-42. Reply with only OK. Do not use tools.", selected.model, effort);
    first.close();
    second = new AppServer(directory);
    await second.initialize();
    await second.request("thread/resume", { threadId });
    const turnTwo = await second.completedTurn(threadId, "What marker did I ask you to remember? Reply with only the marker. Do not use tools.", selected.model, effort);
    console.log(JSON.stringify({ phase: "live", firstStatus: turnOne.status, secondStatus: turnTwo.status,
      firstDeltas: turnOne.deltaCount, secondDeltas: turnTwo.deltaCount, resumed: /VIOLET-42/.test(turnTwo.text) }));
    await second.request("thread/delete", { threadId }).catch(() => {});
  }
} finally {
  first?.close();
  second?.close();
  await rm(directory, { recursive: true, force: true });
}
