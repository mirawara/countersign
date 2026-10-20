import { setTimeout as delay } from "node:timers/promises";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ProcessFailure, runExecutable } from "../src/shared/process";

describe("runExecutable", () => {
  it("sends input through stdin and closes the stream", async () => {
    const script = "let text='';process.stdin.setEncoding('utf8');process.stdin.on('data',c=>text+=c);process.stdin.on('end',()=>process.stdout.write(text))";
    const result = await runExecutable(process.execPath, ["-e", script], {
      cwd: process.cwd(),
      timeoutMs: 5_000,
      stdin: "prompt ✓",
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toBe("prompt ✓");
    expect(result.stderr).toBe("");
  });

  it("keeps stdout and stderr in separate result fields", async () => {
    const script = "process.stdout.write('structured-json');process.stderr.write('diagnostic')";
    const result = await runExecutable(process.execPath, ["-e", script], {
      cwd: process.cwd(),
      timeoutMs: 5_000,
    });
    expect(result.stdout).toBe("structured-json");
    expect(result.stderr).toBe("diagnostic");
  });

  it("decodes UTF-8 characters split across output chunks", async () => {
    const script = "process.stdout.write(Buffer.from([0xe2]));setTimeout(()=>process.stdout.write(Buffer.from([0x82,0xac])),10)";
    const result = await runExecutable(process.execPath, ["-e", script], {
      cwd: process.cwd(),
      timeoutMs: 5_000,
    });
    expect(result.stdout).toBe("€");
  });

  it("enforces the output byte cap", async () => {
    const script = "process.stdout.write('x'.repeat(4096))";
    await expect(runExecutable(process.execPath, ["-e", script], {
      cwd: process.cwd(),
      timeoutMs: 5_000,
      maxOutputBytes: 64,
    })).rejects.toMatchObject({ kind: "output_limit" });
  });

  it.skipIf(process.platform === "win32")("escalates output-limit termination when SIGTERM is ignored", async () => {
    const script = "process.on('SIGTERM',()=>{});setTimeout(()=>process.exit(0),1500);process.stdout.write('x'.repeat(4096))";
    const started = Date.now();
    await expect(runExecutable(process.execPath, ["-e", script], {
      cwd: process.cwd(), timeoutMs: 5_000, maxOutputBytes: 64, gracePeriodMs: 100,
    })).rejects.toMatchObject({ kind: "output_limit" });
    expect(Date.now() - started).toBeLessThan(1_000);
  });

  it.skipIf(process.platform === "win32")("kills a TERM-resistant descendant after its parent exits", async () => {
    const folder = await mkdtemp(join(tmpdir(), "ai-dev-orchestrator-process-test-"));
    const marker = join(folder, "descendant-survived");
    try {
      const descendant = `process.on('SIGTERM',()=>{});setTimeout(()=>{require('node:fs').writeFileSync(${JSON.stringify(marker)},'survived');process.exit(0)},700)`;
      const script = `const {spawn}=require('node:child_process');spawn(process.execPath,['-e',${JSON.stringify(descendant)}],{stdio:'ignore'});setInterval(()=>{},1000)`;
      const controller = new AbortController();
      const promise = runExecutable(process.execPath, ["-e", script], {
        cwd: process.cwd(), timeoutMs: 5_000, gracePeriodMs: 100, signal: controller.signal,
      });
      setTimeout(() => controller.abort(), 300);
      await expect(promise).rejects.toMatchObject({ kind: "cancelled" });
      await delay(600);
      await expect(access(marker)).rejects.toThrow();
    } finally {
      await rm(folder, { recursive: true, force: true });
    }
  });

  it("times out and terminates the process group", async () => {
    const script = "setInterval(()=>{},1000)";
    await expect(runExecutable(process.execPath, ["-e", script], {
      cwd: process.cwd(),
      timeoutMs: 100,
      gracePeriodMs: 100,
    })).rejects.toMatchObject({ kind: "timed_out" });
  });

  it("cancels a running process", async () => {
    const controller = new AbortController();
    const promise = runExecutable(process.execPath, ["-e", "setInterval(()=>{},1000)"], {
      cwd: process.cwd(),
      timeoutMs: 5_000,
      gracePeriodMs: 100,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 50);
    await expect(promise).rejects.toMatchObject({ kind: "cancelled" });
  });

  it.skipIf(process.platform === "win32")("terminates descendants in the process group", async () => {
    const script = "const {spawn}=require('node:child_process');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.log(child.pid);setInterval(()=>{},1000)";
    const controller = new AbortController();
    const promise = runExecutable(process.execPath, ["-e", script], {
      cwd: process.cwd(),
      timeoutMs: 5_000,
      gracePeriodMs: 100,
      signal: controller.signal,
    });
    setTimeout(() => controller.abort(), 300);
    let failure: ProcessFailure | undefined;
    try {
      await promise;
    } catch (error) {
      if (error instanceof ProcessFailure) failure = error;
      else throw error;
    }
    expect(failure?.kind).toBe("cancelled");
    const childPid = Number(failure?.output.trim());
    expect(Number.isInteger(childPid)).toBe(true);
    let alive = true;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      try {
        process.kill(childPid, 0);
        await delay(25);
      } catch {
        alive = false;
        break;
      }
    }
    expect(alive).toBe(false);
  }, 5_000);

  it("does not inherit arbitrary environment variables", async () => {
    const key = "AI_DEV_ORCHESTRATOR_TEST_SECRET";
    const previous = process.env[key];
    process.env[key] = "test-secret-value";
    try {
      const result = await runExecutable(process.execPath, ["-e", `process.stdout.write(process.env.${key} ?? 'absent')`], {
        cwd: process.cwd(),
        timeoutMs: 5_000,
      });
      expect(result.stdout).toBe("absent");
    } finally {
      if (previous === undefined) delete process.env[key];
      else process.env[key] = previous;
    }
  });

  it("passes CODEX_HOME so the Codex CLI can locate its account auth without inheriting other variables", async () => {
    const previous = process.env.CODEX_HOME;
    process.env.CODEX_HOME = "/tmp/codex-home-for-test";
    try {
      const result = await runExecutable(process.execPath, ["-e", "process.stdout.write(process.env.CODEX_HOME ?? 'absent')"], {
        cwd: process.cwd(),
        timeoutMs: 5_000,
      });
      expect(result.stdout).toBe("/tmp/codex-home-for-test");
    } finally {
      if (previous === undefined) delete process.env.CODEX_HOME;
      else process.env.CODEX_HOME = previous;
    }
  });
});
