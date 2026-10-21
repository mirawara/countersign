export const CLAUDE_FULL_ACCESS_REJECTED =
  "Claude Full access was refused by its CLI or managed settings. Select Ask before change or review the managed permission policy.";

export function claudeBypassRejected(diagnostics: unknown): boolean {
  const value = typeof diagnostics === "string" ? diagnostics : diagnostics instanceof Error ? diagnostics.message : "";
  return /bypass.?permissions|dangerously.?skip.?permissions|full access/i.test(value) &&
    /disabled|disallow|not allowed|forbid|refus|denied|managed|policy|require/i.test(value);
}
