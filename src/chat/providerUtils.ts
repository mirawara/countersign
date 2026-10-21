import { runExecutable } from "../shared/process";
import { realpath } from "node:fs/promises";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";

export function subscriptionEnvironment(): NodeJS.ProcessEnv {
  const forbidden = ["ANTHROPIC_API_KEY", "ANTHROPIC_AUTH_TOKEN", "OPENAI_API_KEY", "CODEX_API_KEY"];
  if (forbidden.some((key) => Boolean(process.env[key]))) {
    throw new Error("API credentials are present in the environment. Remove them before using subscription chat.");
  }
  return Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !forbidden.includes(key) && (!key.startsWith("CODEX_") || key === "CODEX_HOME")));
}

export async function executableOutput(executable: string, args: string[], cwd: string): Promise<string> {
  const result = await runExecutable(executable, args, { cwd, timeoutMs: 10_000, maxOutputBytes: 32_768 });
  if (result.exitCode !== 0) throw new Error(`${executable} ${args[0]} failed.`);
  return result.stdout.trim();
}

export function safeSummary(value: unknown, max = 8_000): string {
  let text: string;
  try { text = JSON.stringify(value); } catch { text = "[unavailable]"; }
  return text.length > max ? `${text.slice(0, max)}\n[truncated]` : text;
}

export async function fileToolWithinWorkspace(cwd: string, tool: string, input: Record<string, unknown>): Promise<boolean> {
  const root = await realpath(cwd);
  const specified = tool === "Glob" || tool === "Grep" ? input.path : input.file_path;
  if (specified !== undefined && typeof specified !== "string") return false;
  if (typeof specified === "string" && /^~[^/\\]*([/\\]|$)/.test(specified)) return false;
  const target = typeof specified === "string" && specified ? resolve(cwd, specified) : root;
  let canonical: string;
  try { canonical = await realpath(tool === "Write" ? dirname(target) : target); }
  catch { return false; }
  const path = relative(root, canonical);
  if (path === ".." || path.startsWith(`..${sep}`) || isAbsolute(path)) return false;
  if (tool === "Write") {
    try {
      const existing = relative(root, await realpath(target));
      if (existing === ".." || existing.startsWith(`..${sep}`) || isAbsolute(existing)) return false;
    } catch (error) {
      if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) return false;
    }
  }
  if ((tool === "Glob" || tool === "Grep") && typeof input.pattern === "string" &&
      (input.pattern.startsWith("/") || /^~[^/\\]*([/\\]|$)/.test(input.pattern) ||
        input.pattern.split(/[\\/]/).includes(".."))) return false;
  return true;
}
