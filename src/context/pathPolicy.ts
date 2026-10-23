import { isAbsolute } from "node:path";
import { StrictPathCategory } from "../shared/strict";

/**
 * The single path policy table. Balanced derives SKIP_DIRS and validateReviewPath from
 * it, and the Strict scanner derives its classification from it, so the two cannot drift.
 * Balanced semantics are preserved exactly: SKIP_DIRS still compares a directory basename
 * case-sensitively, and the review rules still match case-insensitively at any depth.
 *
 * The two modes deliberately differ on credential-shaped paths. Balanced refuses them, as
 * it always has. Strict scans, hashes, diffs and sends them like any other file, because
 * reading the workspace it is asked to change is the point of that mode. Nothing there
 * treats .env, .ssh/ or key files as special.
 */
export type StrictPathAction =
  | "exclude_without_reading"
  | "reject_unreviewable"
  | "scan_and_review";

export type BalancedCompatibility =
  /** In SKIP_DIRS and rejected by validateReviewPath, as today. */
  | "skip_dir_and_review_reject"
  /** In SKIP_DIRS only; validateReviewPath does not reject it today. */
  | "skip_dir_only"
  /** Rejected by validateReviewPath only; the Balanced scanner still walks into it. */
  | "review_reject_only"
  /** No Balanced effect at all: the rule is new and applies to Strict only. */
  | "strict_only";

export type PathMatcher =
  /** A path component at any depth, compared case-insensitively. */
  | { kind: "directory_component"; names: readonly string[] }
  /** The file basename, matched case-insensitively by the existing expression. */
  | { kind: "basename_regex"; pattern: RegExp }
  /** The file basename, compared case-insensitively against a prefix. */
  | { kind: "basename_prefix"; prefixes: readonly string[] }
  /** Structural problems: absolute, escaping, or not representable. */
  | { kind: "structural" };

export interface PathPolicyRule {
  id: string;
  category: StrictPathCategory;
  description: string;
  matcher: PathMatcher;
  strict: StrictPathAction;
  balanced: BalancedCompatibility;
}

export const PATH_POLICY_RULES: readonly PathPolicyRule[] = [
  {
    id: "git-metadata",
    category: "policy",
    description: "Internal .git metadata",
    matcher: { kind: "directory_component", names: [".git"] },
    strict: "exclude_without_reading",
    balanced: "skip_dir_and_review_reject",
  },
  {
    id: "dependency-and-build-output",
    category: "policy",
    description: "node_modules, dist, build, coverage and .cache",
    matcher: { kind: "directory_component", names: ["node_modules", "dist", "build", "coverage", ".cache"] },
    strict: "exclude_without_reading",
    balanced: "skip_dir_and_review_reject",
  },
  {
    id: "language-environment-output",
    category: "policy",
    description: ".venv and target",
    matcher: { kind: "directory_component", names: [".venv", "target"] },
    strict: "exclude_without_reading",
    // validateReviewPath does not reject these today; only the snapshot scanner skips them.
    balanced: "skip_dir_only",
  },
  {
    id: "tooling-output-directories",
    category: "policy",
    description: ".vscode-test, .integration-dist and .test-dist",
    matcher: { kind: "directory_component", names: [".vscode-test", ".integration-dist", ".test-dist"] },
    strict: "exclude_without_reading",
    balanced: "strict_only",
  },
  {
    id: "tooling-output-files",
    category: "policy",
    description: "Packaged .vsix files and npm-debug.log*",
    matcher: { kind: "basename_regex", pattern: /\.vsix$|^npm-debug\.log/i },
    strict: "exclude_without_reading",
    balanced: "strict_only",
  },
  {
    id: "credential-directories",
    category: "included",
    description: ".ssh, .aws and .gnupg",
    matcher: { kind: "directory_component", names: [".ssh", ".aws", ".gnupg"] },
    strict: "scan_and_review",
    balanced: "review_reject_only",
  },
  {
    id: "environment-files",
    category: "included",
    description: ".env and .env.*",
    matcher: { kind: "basename_regex", pattern: /^\.env(?:\.|$)/i },
    strict: "scan_and_review",
    balanced: "review_reject_only",
  },
  {
    id: "credential-files",
    category: "included",
    description: ".npmrc, .pypirc, .netrc, id_rsa and id_ed25519",
    matcher: { kind: "basename_regex", pattern: /^(?:\.npmrc|\.pypirc|\.netrc|id_rsa|id_ed25519)$/i },
    strict: "scan_and_review",
    balanced: "review_reject_only",
  },
  {
    id: "secret-material",
    category: "included",
    description: "Names containing secrets, credentials, tokens or private-key, and .pem or .p12 files",
    matcher: {
      kind: "basename_regex",
      pattern: /(?:^|[-_.])(?:secrets?|credentials?|tokens?|private[-_]?key)(?:[-_.]|$)|\.(?:pem|p12)$/i,
    },
    strict: "scan_and_review",
    balanced: "review_reject_only",
  },
  {
    id: "unsupported-path",
    category: "unsupported",
    description: "Absolute paths, '..' segments, NUL or newline, and paths leaving the workspace root",
    matcher: { kind: "structural" },
    strict: "reject_unreviewable",
    balanced: "review_reject_only",
  },
];

/** Directory basenames the Balanced snapshot scanner skips, compared exactly as before. */
export const SKIP_DIRS: ReadonlySet<string> = new Set(
  PATH_POLICY_RULES
    .filter((rule) => rule.balanced === "skip_dir_and_review_reject" || rule.balanced === "skip_dir_only")
    .flatMap((rule) => rule.matcher.kind === "directory_component" ? [...rule.matcher.names] : []),
);

export interface StrictPathClassification {
  category: StrictPathCategory;
  action: StrictPathAction;
  /** The rule that decided it; "default-included" when no rule matched. */
  rule: string;
}

const INCLUDED: StrictPathClassification = { category: "included", action: "scan_and_review", rule: "default-included" };

/**
 * Classifies a workspace-relative path for the Strict scanner. internal/ and every other
 * unlisted path is included and reviewed, even when Git ignores it.
 */
export function classifyStrictPath(path: string): StrictPathClassification {
  for (const rule of PATH_POLICY_RULES) {
    if (matches(rule.matcher, path)) {
      return { category: rule.category, action: rule.strict, rule: rule.id };
    }
  }
  return INCLUDED;
}

/** True when the Strict scanner must not descend into this directory or read it. */
export function classifyStrictDirectory(path: string, name: string): StrictPathClassification {
  for (const rule of PATH_POLICY_RULES) {
    if (rule.matcher.kind === "directory_component" && containsName(rule.matcher.names, name)) {
      return { category: rule.category, action: rule.strict, rule: rule.id };
    }
    if (rule.matcher.kind === "structural" && isStructurallyUnsafe(path)) {
      return { category: rule.category, action: rule.strict, rule: rule.id };
    }
  }
  return INCLUDED;
}

/** The Balanced rules, derived from the same table and unchanged in behaviour. */
export function isBalancedExcludedPath(path: string): boolean {
  return PATH_POLICY_RULES.some((rule) =>
    (rule.balanced === "skip_dir_and_review_reject" || rule.balanced === "review_reject_only")
    && matches(rule.matcher, path));
}

function matches(matcher: PathMatcher, path: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  const name = normalized.split("/").at(-1) ?? "";
  switch (matcher.kind) {
    case "directory_component":
      return normalized.split("/").some((component) => containsName(matcher.names, component));
    case "basename_regex":
      return matcher.pattern.test(name);
    case "basename_prefix":
      return matcher.prefixes.some((prefix) => name.toLowerCase().startsWith(prefix.toLowerCase()));
    case "structural":
      return isStructurallyUnsafe(path);
  }
}

function containsName(names: readonly string[], candidate: string): boolean {
  return names.some((name) => name.toLowerCase() === candidate.toLowerCase());
}

function isStructurallyUnsafe(path: string): boolean {
  const normalized = path.replaceAll("\\", "/");
  return !path || isAbsolute(path) || normalized.split("/").includes("..")
    || path.includes("\0") || path.includes("\n");
}
