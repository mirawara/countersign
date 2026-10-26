import { ChildProcess, spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

export type ProcessFailureKind = "cancelled" | "timed_out" | "output_limit" | "spawn_error";

export class ProcessFailure extends Error {
  constructor(
    readonly kind: ProcessFailureKind,
    message: string,
    readonly stdout = "",
    readonly stderr = "",
  ) {
    super(message);
    this.name = "ProcessFailure";
  }

  get output(): string {
    return this.stdout + this.stderr;
  }
}

export interface ProcessResult {
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export interface ProcessOptions {
  cwd: string;
  timeoutMs: number;
  /** Selects a CLI's own credential/config directory for this child only. */
  env?: Partial<Record<"CLAUDE_CONFIG_DIR" | "CODEX_HOME", string>>;
  signal?: AbortSignal;
  maxOutputBytes?: number;
  gracePeriodMs?: number;
  stdin?: string | Buffer;
}

const DEFAULT_MAX_OUTPUT_BYTES = 1_048_576;

export function runExecutable(
  executable: string,
  args: string[],
  options: ProcessOptions,
): Promise<ProcessResult> {
  if (options.signal?.aborted) {
    return Promise.reject(new ProcessFailure("cancelled", "Process cancelled before start."));
  }

  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let outputBytes = 0;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;
    let failure: ProcessFailure | undefined;
    let closed = false;
    let stdoutEnded = false;
    let stderrEnded = false;
    const maxBytes = options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES;
    const gracePeriodMs = options.gracePeriodMs ?? 1_000;
    const stdoutDecoder = new StringDecoder("utf8");
    const stderrDecoder = new StringDecoder("utf8");
    const child = spawn(executable, args, {
      cwd: options.cwd,
      shell: false,
      windowsHide: true,
      detached: process.platform !== "win32",
      env: buildChildEnvironment(options.env),
      stdio: ["pipe", "pipe", "pipe"],
    });

    const append = (chunk: Buffer, decoder: StringDecoder, stream: "stdout" | "stderr"): void => {
      if (settled || failure) {
        return;
      }
      const remaining = Math.max(0, maxBytes - outputBytes);
      const accepted = chunk.subarray(0, remaining);
      outputBytes += accepted.byteLength;
      const decoded = decoder.write(accepted);
      if (stream === "stdout") stdout += decoded;
      else stderr += decoded;
      if (chunk.byteLength > remaining) {
        failAndTerminate(new ProcessFailure("output_limit", `Output exceeded ${maxBytes} bytes.`, stdout, stderr));
        return;
      }
    };

    const flushStdout = (): void => {
      if (stdoutEnded) return;
      stdout += stdoutDecoder.end();
      stdoutEnded = true;
    };

    const flushStderr = (): void => {
      if (stderrEnded) return;
      stderr += stderrDecoder.end();
      stderrEnded = true;
    };

    const cleanup = (): void => {
      if (timeout) clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      options.signal?.removeEventListener("abort", onAbort);
    };

    const finish = (): void => {
      if (settled) return;
      settled = true;
      flushStdout();
      flushStderr();
      cleanup();
      if (failure) reject(new ProcessFailure(failure.kind, failure.message, stdout, stderr));
      else resolve({ exitCode: child.exitCode, stdout, stderr });
    };

    const failAndTerminate = (reason: ProcessFailure): void => {
      if (failure || settled) return;
      failure = reason;
      terminateChild(child);
      killTimer = setTimeout(() => {
        killTimer = undefined;
        terminateChild(child, "SIGKILL");
        if (closed) finish();
      }, gracePeriodMs);
    };

    const onAbort = (): void => {
      failAndTerminate(new ProcessFailure("cancelled", "Process cancelled.", stdout, stderr));
    };

    options.signal?.addEventListener("abort", onAbort, { once: true });
    if (options.signal?.aborted) onAbort();
    const timeout = options.timeoutMs > 0 ? setTimeout(() => {
      failAndTerminate(new ProcessFailure("timed_out", `Process exceeded ${options.timeoutMs} ms.`, stdout, stderr));
    }, options.timeoutMs) : undefined;
    timeout?.unref();
    child.stdout.on("data", (chunk: Buffer) => append(chunk, stdoutDecoder, "stdout"));
    child.stderr.on("data", (chunk: Buffer) => append(chunk, stderrDecoder, "stderr"));
    child.stdout.once("end", flushStdout);
    child.stderr.once("end", flushStderr);
    child.stdin.on("error", () => {
      // A child may exit without consuming all input; process exit status remains authoritative.
    });
    child.stdin.end(options.stdin);
    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(failure ?? new ProcessFailure("spawn_error", error.message, stdout, stderr));
    });
    child.once("close", () => {
      if (settled) return;
      closed = true;
      if (failure && killTimer && processGroupAlive(child)) return;
      finish();
    });
  });
}

function terminateChild(child: ChildProcess, signal: NodeJS.Signals = "SIGTERM"): void {
  if (!child.pid) return;
  try {
    if (process.platform !== "win32") {
      process.kill(-child.pid, signal);
    } else {
      child.kill(signal);
    }
  } catch {
    // The process may have exited between the check and signal.
  }
}

function processGroupAlive(child: ChildProcess): boolean {
  if (process.platform === "win32" || !child.pid) return false;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch {
    return false;
  }
}

function buildChildEnvironment(overrides?: ProcessOptions["env"]): NodeJS.ProcessEnv {
  const names = process.platform === "win32"
    ? ["PATH", "PATHEXT", "SYSTEMROOT", "WINDIR", "TEMP", "TMP", "USERPROFILE", "CODEX_HOME"]
    : ["PATH", "HOME", "TMPDIR", "CODEX_HOME", "CLAUDE_CONFIG_DIR"];
  const env: NodeJS.ProcessEnv = {};
  for (const name of names) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  if (overrides?.CLAUDE_CONFIG_DIR) env.CLAUDE_CONFIG_DIR = overrides.CLAUDE_CONFIG_DIR;
  if (overrides?.CODEX_HOME) env.CODEX_HOME = overrides.CODEX_HOME;
  return env;
}
