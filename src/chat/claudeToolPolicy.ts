import { fileToolWithinWorkspace } from "./providerUtils";

const FILE_TOOLS = new Set(["Read", "Glob", "Grep", "Edit", "Write"]);
const PROMPT_TOOLS = new Set(["Edit", "Write", "Bash", "WebFetch", "WebSearch"]);

export async function claudeToolPolicy(cwd: string, input: { hook_event_name: string; tool_name?: string;
  tool_input?: unknown }, askBeforeChange: boolean) {
  if (input.hook_event_name !== "PreToolUse") return {};
  const tool = input.tool_name ?? "";
  if (FILE_TOOLS.has(tool)) {
    const args = input.tool_input;
    if (typeof args !== "object" || args === null || Array.isArray(args) ||
      !(await fileToolWithinWorkspace(cwd, tool, args as Record<string, unknown>))) {
      return { hookSpecificOutput: { hookEventName: "PreToolUse" as const,
        permissionDecision: "deny" as const,
        permissionDecisionReason: "File tool path is outside the repository or cannot be checked." } };
    }
  }
  if (askBeforeChange && PROMPT_TOOLS.has(tool)) {
    return { hookSpecificOutput: { hookEventName: "PreToolUse" as const, permissionDecision: "ask" as const } };
  }
  return {};
}
