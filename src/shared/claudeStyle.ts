/**
 * Compact Caveman Ultra fallback when no installed Claude skill is available.
 * Source: https://github.com/Gildaciolopes/claude-caveman-ultra (MIT).
 * Keep this short: it is sent on every Claude request, including fresh Strict turns.
 */
export const CLAUDE_CAVEMAN_ULTRA =
  "Caveman Ultra for your prose: use terse, clear fragments and familiar abbreviations in the user's language. " +
  "Preserve technical facts, JSON schema keys, IDs, paths, code, commands, exact errors and evidence. " +
  "Use full wording when a plan, question, safety warning or action order could become ambiguous.";
