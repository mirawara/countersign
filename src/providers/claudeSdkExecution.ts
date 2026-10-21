import { query as queryType } from "@anthropic-ai/claude-agent-sdk";
import { OrchestratorConfig } from "../configuration/config";
import { safeSummary, subscriptionEnvironment } from "../chat/providerUtils";
import { claudeToolPolicy } from "../chat/claudeToolPolicy";
import { VERIFIED_CLAUDE_CHAT_CLI, VERIFIED_CLAUDE_CHAT_SDK, chatGateMatches, sdkVersion } from "../chat/claudeChatGate";
import { loadClaudeChatGate } from "../chat/claudeChatGateStore";
import { ClaudeProviderError } from "./claudeCliProvider";
import { AgentRequest } from "../shared/types";

export type WorkflowPermissionPrompt = (tool: string, detail: string, signal: AbortSignal) => Promise<boolean>;

export async function runClaudeSdkExecution(config: OrchestratorConfig, request: AgentRequest, prompt: string,
  schema: Record<string, unknown>, askPermission: WorkflowPermissionPrompt): Promise<string> {
  const gate = await loadClaudeChatGate();
  const sdk = await sdkVersion();
  if (sdk !== VERIFIED_CLAUDE_CHAT_SDK || !chatGateMatches(gate, VERIFIED_CLAUDE_CHAT_CLI, sdk)) {
    throw new ClaudeProviderError("gate_missing", "Ask before change needs the verified Claude Agent SDK isolation gate. Run Verify Claude Chat Isolation.");
  }
  const { query } = await (Function("name", "return import(name)")("@anthropic-ai/claude-agent-sdk") as Promise<{ query: typeof queryType }>);
  const controller = new AbortController();
  const onAbort = (): void => controller.abort();
  request.signal.addEventListener("abort", onAbort, { once: true });
  if (request.signal.aborted) controller.abort();
  const timer = setTimeout(() => controller.abort(), config.providerTimeoutMinutes * 60_000);
  const active = query({ prompt, options: {
    cwd: request.repository,
    pathToClaudeCodeExecutable: config.claudeExecutable,
    env: subscriptionEnvironment(),
    settingSources: [], strictMcpConfig: true, mcpServers: {},
    tools: ["Read", "Glob", "Grep", "Edit", "Write", "Bash", "WebFetch", "WebSearch"],
    allowedTools: [], permissionMode: "default", persistSession: false,
    hooks: { PreToolUse: [{ hooks: [async (input) => claudeToolPolicy(request.repository, input, true)] }] },
    canUseTool: async (tool, input, options) => {
      if (controller.signal.aborted || options.signal.aborted) return { behavior: "deny", message: "Workflow cancelled." };
      const allowed = await askPermission(tool, safeSummary(input), options.signal);
      return allowed && !controller.signal.aborted && !options.signal.aborted
        ? { behavior: "allow", updatedInput: input } : { behavior: "deny", message: "Permission declined." };
    },
    outputFormat: { type: "json_schema", schema },
    ...(config.claudeModel ? { model: config.claudeModel } : {}),
    ...(config.claudeEffort ? { effort: config.claudeEffort as "low" | "medium" | "high" | "max" } : {}),
    maxTurns: 30, maxBudgetUsd: config.budgetGuardUsd, abortController: controller,
  } });
  let result: string | undefined;
  let subscriptionConfirmed = false;
  try {
    for await (const message of active) {
      if (message.type === "system" && message.subtype === "init") {
        if (message.apiKeySource !== "none") throw new ClaudeProviderError("authentication", "Claude did not confirm subscription authentication.");
        subscriptionConfirmed = true;
      }
      if (message.type === "result") {
        if (message.subtype !== "success" || message.is_error) {
          throw new ClaudeProviderError("execution", `Claude SDK turn ended: ${message.subtype}.`);
        }
        result = JSON.stringify({ is_error: false, structured_output: message.structured_output,
          total_cost_usd: message.total_cost_usd, usage: message.usage });
      }
    }
    if (controller.signal.aborted) throw new ClaudeProviderError(request.signal.aborted ? "cancelled" : "timed_out", "Claude SDK execution was interrupted.");
    if (!subscriptionConfirmed || !result) throw new ClaudeProviderError("execution", "Claude SDK ended without a verified subscription result.");
    return result;
  } finally {
    clearTimeout(timer);
    request.signal.removeEventListener("abort", onAbort);
    active.close();
  }
}
