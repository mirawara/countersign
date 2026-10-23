import { randomUUID } from "node:crypto";
import { query as queryType, type Query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { ChatModelOption, ChatQuota, ChatUsage } from "./types";
import { ExecutionPermission } from "../configuration/config";
import { executableOutput, safeSummary, subscriptionEnvironment } from "./providerUtils";
import { claudeToolPolicy } from "./claudeToolPolicy";
import { CLAUDE_FULL_ACCESS_REJECTED, claudeBypassRejected } from "../shared/claudePermissions";

type Sdk = { query: typeof queryType };

async function sdk(): Promise<Sdk> {
  // TypeScript emits CommonJS for the VS Code extension host. Keep the SDK's ESM loader native.
  return Function("name", "return import(name)")("@anthropic-ai/claude-agent-sdk") as Promise<Sdk>;
}

export interface ClaudeAvailability {
  version: string;
  accountLabel: string;
  models: ChatModelOption[];
}

export async function inspectClaude(executable: string, cwd: string): Promise<ClaudeAvailability> {
  subscriptionEnvironment();
  const [version, authText] = await Promise.all([
    executableOutput(executable, ["--version"], cwd),
    executableOutput(executable, ["auth", "status", "--json"], cwd),
  ]);
  let auth: unknown;
  try { auth = JSON.parse(authText); } catch { throw new Error("Claude authentication status is invalid."); }
  if (!isRecord(auth) || auth.loggedIn !== true || auth.authMethod !== "claude.ai") {
    throw new Error("Sign in with the official Claude CLI subscription login.");
  }
  const { query } = await sdk();
  async function* empty(): AsyncGenerator<never> { /* Catalog control request only. */ }
  const active = query({ prompt: empty(), options: {
    cwd, pathToClaudeCodeExecutable: executable, env: subscriptionEnvironment(),
    settingSources: [], strictMcpConfig: true, mcpServers: {}, tools: [], allowedTools: [],
    permissionMode: "default", persistSession: false,
  } });
  try {
    const models = await active.supportedModels();
    return { version, accountLabel: typeof auth.email === "string" ? auth.email : "Claude subscription login",
      models: models.map((model) => ({
      value: model.value, label: model.displayName,
      effortLevels: model.supportsEffort ? model.supportedEffortLevels ?? [] : [],
    })) };
  } finally { active.close(); }
}

export interface ClaudeTurn {
  cwd: string;
  executable: string;
  prompt: string;
  sessionId?: string;
  model: string;
  effort?: string;
  signal: AbortSignal;
  onText: (text: string) => void;
  onActivity: (text: string) => void;
  onQuota?: (quota: ChatQuota) => void;
  askPermission: (tool: string, detail: string, signal: AbortSignal) => Promise<boolean>;
  phase?: "planning";
  executionPermission?: ExecutionPermission;
}

export interface ClaudeTurnResult {
  sessionId: string;
  model?: string;
  effectiveEffort?: string;
  usage?: ChatUsage;
  quota?: ChatQuota;
}

export async function runClaudeTurn(options: ClaudeTurn): Promise<ClaudeTurnResult> {
  const { query } = await sdk();
  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  options.signal.addEventListener("abort", onAbort, { once: true });
  if (options.signal.aborted) controller.abort();
  const sessionId = options.sessionId ?? randomUUID();
  const planning = options.phase === "planning";
  const fullAccess = !planning && options.executionPermission === "fullAccess";
  const tools = planning ? ["Read", "Glob", "Grep"]
    : ["Read", "Glob", "Grep", "Edit", "Write", "Bash", "WebFetch", "WebSearch"];
  let active: Query;
  try { active = query({ prompt: options.prompt, options: {
    cwd: options.cwd, pathToClaudeCodeExecutable: options.executable, env: subscriptionEnvironment(),
    ...(options.sessionId ? { resume: sessionId } : { sessionId }),
    settingSources: [], strictMcpConfig: true, mcpServers: {},
    tools, allowedTools: [],
    disallowedTools: ["PowerShell", "Agent"],
    permissionMode: planning ? "plan" : fullAccess ? "bypassPermissions" : "default",
    ...(fullAccess ? { allowDangerouslySkipPermissions: true } : {}),
    ...(!fullAccess ? { hooks: { PreToolUse: [{ hooks: [async (input: { hook_event_name: string;
      tool_name?: string; tool_input?: unknown }) => claudeToolPolicy(options.cwd, input, !planning)] }] } } : {}),
    includePartialMessages: true,
    model: options.model, ...(options.effort ? { effort: options.effort as "low" | "medium" | "high" | "xhigh" | "max" } : {}),
    maxTurns: 12, abortController: controller,
    ...(!fullAccess ? { canUseTool: async (tool: string, input: Record<string, unknown>, request: { signal: AbortSignal }) => {
      if (controller.signal.aborted || request.signal.aborted) return { behavior: "deny", message: "Turn cancelled." };
      if (!tools.includes(tool)) {
        return { behavior: "deny", message: "Tool is outside the chat allowlist." };
      }
      if (planning) return { behavior: "deny", message: "Planning is read-only." };
      const allowed = await options.askPermission(tool, safeSummary(input), request.signal);
      return allowed && !controller.signal.aborted && !request.signal.aborted
        ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: "Permission declined." };
    } } : {}),
  } }); } catch (error) {
    options.signal.removeEventListener("abort", onAbort);
    if (fullAccess && claudeBypassRejected(error)) throw new Error(CLAUDE_FULL_ACCESS_REJECTED, { cause: error });
    throw error;
  }
  let resultSeen = false;
  let actualModel: string | undefined;
  let effectiveEffort: string | undefined;
  let usage: ChatUsage | undefined;
  let quota: ChatQuota | undefined;
  let textSeen = false;
  try {
    for await (const message of active) {
      const item = message as SDKMessage;
      if (item.type === "system" && item.subtype === "init") {
        if (item.apiKeySource !== "none") throw new Error("Claude did not confirm subscription authentication.");
        actualModel = item.model;
        effectiveEffort = typeof item.effort === "string" ? item.effort : undefined;
      }
      if (item.type === "stream_event" && item.event.type === "content_block_delta" &&
          item.event.delta.type === "text_delta") {
        options.onText(item.event.delta.text);
        textSeen = true;
      }
      if (item.type === "assistant") {
        for (const block of item.message.content) {
          if (block.type === "tool_use") options.onActivity(`Tool requested: ${block.name}`);
        }
      }
      if (item.type === "user" && Array.isArray(item.message.content)) {
        for (const block of item.message.content) {
          if (block.type === "tool_result") {
            const detail = block.is_error && typeof block.content === "string" ? `: ${block.content.slice(0, 300)}` : "";
            options.onActivity(`Tool result: ${block.is_error ? "error" : "success"}${detail}`);
          }
        }
      }
      if (item.type === "rate_limit_event") {
        const info = item.rate_limit_info;
        quota = { status: info.status, type: info.rateLimitType, utilization: info.utilization };
        options.onQuota?.(quota);
        if (info.status === "rejected") options.onActivity("Claude subscription limit reached. No account switch was attempted.");
        else if (info.status === "allowed_warning") options.onActivity("Claude subscription quota is nearing a limit.");
      }
      if (item.type === "result") {
        resultSeen = true;
        if (item.subtype !== "success" || item.is_error) {
          const diagnostics = "errors" in item && Array.isArray(item.errors) ? item.errors.join(" ") : "";
          if (fullAccess && claudeBypassRejected(diagnostics)) throw new Error(CLAUDE_FULL_ACCESS_REJECTED);
          throw new Error(`Claude turn ended: ${item.subtype}.`);
        }
        if (!textSeen && typeof item.result === "string") options.onText(item.result);
        usage = { inputTokens: item.usage.input_tokens, outputTokens: item.usage.output_tokens,
          estimatedCostUsd: item.total_cost_usd };
      }
    }
    if (controller.signal.aborted) throw new Error("Claude turn cancelled.");
    if (!resultSeen) throw new Error("Claude ended without a result.");
    return { sessionId, model: actualModel, effectiveEffort, usage, quota };
  } catch (error) {
    if (fullAccess && claudeBypassRejected(error)) throw new Error(CLAUDE_FULL_ACCESS_REJECTED, { cause: error });
    throw error;
  } finally {
    active.close();
    options.signal.removeEventListener("abort", onAbort);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
