import type { ExecutionPermission, WorkflowModelSelection } from "../configuration/config";
import type { StrictLimitBreach, StrictLimits } from "./strictLimits";
import type { StrictMarkerOutcome } from "./strictMarker";
import type { CheckResult, FindingSeverity, ProviderKind, ProviderMetric, StrictWorkflowEvent, StrictWorkflowState } from "./types";

/**
 * Strict mode data model: the two phases, the canonical plan, the structured provider
 * responses, the approvals, the snapshot digest and the final report contract.
 *
 * Delivery 1 defines the model only. The plan consensus loop, the phase B capture and
 * review, the lifecycle marker and the sidebar interaction are later deliveries, so no
 * runtime code reaches these states yet.
 */

/** Phase A is the plan agreement; phase B is implementation, checks, review and final consensus. */
export type StrictPhase = "plan" | "implementation";

export const STRICT_PLAN_SCHEMA_VERSION = 1;
export const STRICT_RESPONSE_SCHEMA_VERSION = 1;
export const STRICT_SNAPSHOT_FORMAT_VERSION = 1;

/** Prose is never read as agreement: a provider decides with one of these values. */
export type StrictDecision = "approve" | "reject" | "revise";

// --- Phase A: the canonical plan -------------------------------------------------

export interface StrictPlanQuestion {
  id: string;
  question: string;
  /** A human answer becomes part of the canonical plan and therefore changes its hash. */
  answer?: string;
}

export interface StrictPlan {
  schemaVersion: typeof STRICT_PLAN_SCHEMA_VERSION;
  objective: string;
  constraints: string[];
  acceptanceCriteria: string[];
  /** POSIX-relative paths, lexicographic by UTF-8 bytes. */
  expectedFiles: string[];
  /** False when the plan cannot estimate its file list; this is informational at approval. */
  expectedFilesComplete: boolean;
  risks: string[];
  /** Ids of the configured local checks this plan authorises. */
  checks: string[];
  questions: StrictPlanQuestion[];
}

/**
 * Canonical serialisation order, declared by the schema and used for the plan hash:
 * compact JSON (no outer spacing), keys emitted in exactly this order, strings with
 * CRLF/CR normalised to LF and Unicode NFC, paths slash-separated, expectedFiles sorted
 * lexicographically by UTF-8 bytes, every other list kept in its declared order,
 * duplicate keys rejected, timestamps/request ids/provider metadata excluded.
 * SHA-256 over the resulting bytes, full digest.
 *
 * The plan normalises newlines so its semantic identity is stable; the snapshot digest
 * keeps exact bytes so it identifies what is on disk. That asymmetry is intentional.
 */
export const STRICT_PLAN_CANONICAL_KEYS = [
  "schemaVersion",
  "objective",
  "constraints",
  "acceptanceCriteria",
  "expectedFiles",
  "expectedFilesComplete",
  "risks",
  "checks",
  "questions",
] as const;

export const STRICT_PLAN_QUESTION_CANONICAL_KEYS = ["id", "question", "answer"] as const;

export type StrictPlanRevisionSource = "initial" | "continued" | "provider_revision" | "human_revision";

export interface StrictPlanRecord {
  /** Full SHA-256 of the canonical bytes, recomputed locally and never taken from a model. */
  hash: string;
  schemaVersion: number;
  canonicalBytes: number;
  revision: number;
  source: StrictPlanRevisionSource;
  createdAt: string;
  plan: StrictPlan;
}

export type StrictObjectionTarget =
  | "objective" | "constraint" | "acceptance_criterion" | "expected_file" | "risk" | "check" | "question";

export interface StrictObjection {
  id: string;
  target: StrictObjectionTarget;
  /** Index or id of the referenced plan item; an unresolvable reference is a validation error. */
  reference?: string;
  summary: string;
  rationale: string;
  /** A blocking objection prevents agreement; a non-blocking one is recorded and shown. */
  blocking: boolean;
}

export interface StrictPlanResponse {
  schemaVersion: typeof STRICT_RESPONSE_SCHEMA_VERSION;
  provider: ProviderKind;
  /** The hash the provider claims to have evaluated; verified against the current plan. */
  planHash: string;
  decision: StrictDecision;
  objections: StrictObjection[];
  revisedPlan?: StrictPlan;
  summary: string;
}

// --- Phase B: findings and the review exchange -----------------------------------

export type StrictFindingStatus = "open" | "resolved" | "disputed";

export interface StrictFindingResolution {
  by: ProviderKind;
  decidedAt: string;
  rationale: string;
  snapshotDigest: string;
}

export interface StrictFinding {
  id: string;
  severity: FindingSeverity;
  file: string;
  line: number;
  evidence: string;
  summary: string;
  /** An open blocking finding prevents completed_clean. */
  blocking: boolean;
  status: StrictFindingStatus;
  reportedOnDigest: string;
  resolution?: StrictFindingResolution;
}

export interface StrictReviewResponse {
  schemaVersion: typeof STRICT_RESPONSE_SCHEMA_VERSION;
  provider: ProviderKind;
  /** The digest the provider claims to have reviewed; verified against the current snapshot. */
  snapshotDigest: string;
  decision: StrictDecision;
  findings: StrictFinding[];
  summary: string;
}

// --- Structured response validation ----------------------------------------------

export type StrictValidationCode =
  | "missing_field"
  | "wrong_type"
  | "unknown_field"
  | "invalid_reference"
  | "invalid_path"
  | "out_of_range"
  | "duplicate_key"
  | "ambiguous_decision"
  | "too_large"
  | "hash_mismatch"
  | "digest_mismatch"
  | "unsupported_schema_version";

export interface StrictValidationError {
  path: string;
  code: StrictValidationCode;
  message: string;
}

export type StrictValidation<T> =
  | { ok: true; value: T }
  | { ok: false; errors: StrictValidationError[] };

// --- Approvals and consensus ------------------------------------------------------

export type StrictApprovalSubject = "plan" | "snapshot";

export interface StrictProviderApproval {
  provider: ProviderKind;
  subject: StrictApprovalSubject;
  /** The plan hash or snapshot digest this approval is bound to. */
  hash: string;
  decision: StrictDecision;
  decidedAt: string;
  sessionId?: string;
  providerVersion?: string;
}

export interface StrictConsensus {
  subject: StrictApprovalSubject;
  hash: string;
  approvals: StrictProviderApproval[];
  openObjections: StrictObjection[];
  /** Set only when both providers approved this exact hash with no open blocking objection. */
  reachedAt?: string;
}

export interface StrictHumanApproval {
  approved: boolean;
  planHash: string;
  decidedAt: string;
  executionPermission: ExecutionPermission;
  note?: string;
}

// --- Sessions ---------------------------------------------------------------------

export type StrictSessionRole =
  | "plan_claude" | "plan_codex" | "implementation_claude" | "review_codex" | "final_approval_claude";

/** A session whose fresh context cannot be verified blocks Strict; a prompt is not proof. */
export type StrictSessionIsolation = "verified_new_context" | "unverifiable";

export interface StrictSessionRecord {
  role: StrictSessionRole;
  provider: ProviderKind;
  providerVersion?: string;
  /** Opaque native session identifier when the provider reports one. */
  sessionId?: string;
  isolation: StrictSessionIsolation;
  startedAt: string;
}

// --- Baseline, path policy and snapshot digest -------------------------------------

export type StrictPathCategory = "included" | "policy" | "unsupported";

export interface StrictBaselineIdentity {
  root: string;
  /** Strict always uses a full filesystem scan of the declared perimeter. */
  source: "filesystem_scan";
  capturedAt: string;
  digest: string;
  entryCount: number;
  /** Git may supply repository identity and the initial HEAD; it never defines the file set. */
  git?: { repository: string; head?: string };
}

export type StrictEntryKind = "file" | "binary" | "symlink" | "other";
export type StrictEntryStatus = "added" | "modified" | "deleted";

export type StrictUnreviewableReason =
  | "binary_without_supported_review"
  | "symlink_bytes_not_readable"
  /** The file itself is larger than the per-file snapshot limit, so its bytes are never kept. */
  | "over_file_size_limit"
  | "new_file_over_limit"
  | "not_utf8"
  | "unsupported_path"
  /**
   * The file was hashed in full, but its bytes were not kept because the scan's diff-content
   * pool was already full. The change is detected; it just cannot be shown as a diff. This is
   * not the per-file size limit: the file may be small and the workspace simply large.
   */
  | "content_not_retained";

export interface StrictSnapshotEntry {
  /** Relative POSIX path. */
  path: string;
  kind: StrictEntryKind;
  status: StrictEntryStatus;
  /** Git file mode including the executable bit, when known. */
  beforeMode?: string;
  afterMode?: string;
  beforeSize?: number;
  afterSize?: number;
  /** SHA-256 of the raw bytes; absent when the content was not read. A rename is a delete plus an add. */
  beforeHash?: string;
  afterHash?: string;
  reviewable: boolean;
  unreviewableReason?: StrictUnreviewableReason;
}

/**
 * What the scan kept in memory to build diffs. The pool bounds memory only: a full pool
 * never ends a task, never stops the baseline and never makes a change look unchanged. It
 * makes a change in a file whose bytes were dropped unreviewable, which blocks a clean
 * completion until that file is reviewed another way.
 */
export interface StrictContentRetention {
  maxBytes: number;
  /** Bytes the latest scan kept; never above maxBytes. */
  retainedBytes: number;
  /** Included files the latest scan hashed in full without keeping their bytes, for any reason. */
  filesWithoutContent: number;
  /** Of those, the ones dropped only because the pool was full. */
  filesDroppedForBudget: number;
  /** The same count for the baseline scan: a baseline drop also makes a later change unreviewable. */
  baselineFilesDroppedForBudget: number;
}

export interface StrictPolicyExclusion {
  /** The policy rule that excluded these paths, declared before the task starts. */
  rule: string;
  root: string;
  entryCount: number;
}

export type StrictUnsupportedPathReason =
  | "absolute_path" | "parent_segment" | "nul_or_newline" | "outside_root" | "symlink" | "special_file";

export interface StrictUnsupportedPath {
  path: string;
  reason: StrictUnsupportedPathReason;
}

export interface StrictSnapshotRecord {
  formatVersion: typeof STRICT_SNAPSHOT_FORMAT_VERSION;
  /** SHA-256 of the canonical manifest of reviewable in-perimeter changes. */
  digest: string;
  baselineDigest: string;
  capturedAt: string;
  entries: StrictSnapshotEntry[];
  changedFileCount: number;
  /** False when any in-perimeter change could not be reviewed; completed_clean is then impossible. */
  reviewable: boolean;
}

// --- Checks, budget and pauses -----------------------------------------------------

export interface StrictCheckRound {
  round: number;
  trigger: "after_implementation" | "after_correction";
  snapshotDigest: string;
  /** False when no local check is configured; the report says so instead of claiming tests passed. */
  configured: boolean;
  results: CheckResult[];
}

/** Active-time budget stops in these states; calendar time keeps being recorded. */
export const STRICT_CLOCK_STOPPED_STATES: readonly StrictWorkflowState[] =
  ["awaiting_human_approval", "awaiting_input", "paused"];

export interface StrictPhaseBudget {
  providerRequests: number;
  /** Monotonic active time consumed by providers, local checks and automatic work. */
  activeMs: number;
  /** Calendar time, reported but never used to exhaust the budget. */
  wallClockMs: number;
  reviewCycles?: number;
  consecutiveCyclesWithoutProgress?: number;
}

export interface StrictBudgetReport {
  plan: StrictPhaseBudget;
  implementation: StrictPhaseBudget;
}

/** What the report says about the lifecycle marker; it is metadata, never resumable state. */
export interface StrictMarkerReport {
  status: "none" | "owned" | "undeterminable" | "foreign" | "malformed";
  outcome?: StrictMarkerOutcome;
  timestamp?: string;
  /** True when the user removed it with Countersign: Clear Strict interruption marker. */
  clearedByCommand?: boolean;
}

export type StrictPauseReason = "stall" | "user";

export interface StrictPauseRecord {
  reason: StrictPauseReason;
  fromState: StrictWorkflowState;
  startedAt: string;
  resumedAt?: string;
  /** A pause lives in memory in one extension host; a restart never resumes it. */
  resumable: boolean;
}

// --- Outcome ------------------------------------------------------------------------

export type StrictReasonCode =
  | "no_changes"
  | "plan_rejected_by_provider"
  | "plan_rejected_by_human"
  | "plan_consensus_not_reached"
  | "invalid_structured_response"
  | "plan_too_large"
  | "response_too_large"
  | "limit_reached"
  | "stall"
  | "quota_exhausted"
  | "authentication_failed"
  | "provider_unavailable"
  | "session_isolation_unverifiable"
  | "planning_tools_not_read_only"
  | "provider_permission_denied"
  | "plan_question_unanswered"
  | "review_sandbox_not_read_only"
  | "blocking_findings_open"
  | "checks_failed"
  | "unreviewable_change"
  | "policy_path_in_plan"
  | "declared_output_not_excluded"
  | "baseline_unavailable"
  | "workspace_changed"
  | "marker_conflict"
  | "untrusted_workspace"
  | "cancelled"
  | "timed_out"
  | "internal_error";

export interface StrictOutcomeReason {
  code: StrictReasonCode;
  message: string;
  nextAction: string;
  limit?: StrictLimitBreach;
}

/** Terminal Strict states. completed_with_findings is deliberately absent: open blocking findings end in consensus_not_reached. */
export const STRICT_TERMINAL_STATES = [
  "completed_clean",
  "no_changes",
  "consensus_not_reached",
  "validation_failed",
  "review_failed",
  "blocked_untrusted_workspace",
  "blocked_provider",
  "blocked_permissions",
  "blocked_auth_or_quota",
  "cancelled",
  "timed_out",
  "failed",
] as const;

export type StrictTerminalState = typeof STRICT_TERMINAL_STATES[number];

/**
 * The report contract. completed_clean requires all of: plan consensus on one hash,
 * human approval, configured checks passing on the last snapshot, no open blocking
 * finding, explicit Codex and Claude approvals of the same final digest, a stable
 * baseline and workspace, and no excluded or unreviewable change.
 */
export interface StrictResultCore {
  mode: "strict";
  taskId: string;
  repository: string;
  task: string;
  startedAt: string;
  finishedAt: string;
  message: string;
  limits: StrictLimits;
  limitBreaches: StrictLimitBreach[];
  budget: StrictBudgetReport;
  plans: StrictPlanRecord[];
  planConsensus?: StrictConsensus;
  humanApproval?: StrictHumanApproval;
  baseline?: StrictBaselineIdentity;
  /** Every reviewed snapshot, in order; the last one carries the final digest. */
  snapshots: StrictSnapshotRecord[];
  finalConsensus?: StrictConsensus;
  sessions: StrictSessionRecord[];
  findings: StrictFinding[];
  checkRounds: StrictCheckRound[];
  /** Changes already present before the task; preserved and kept distinct from the task delta. */
  preExistingEntries: string[];
  /**
   * Where that list came from. An empty list means nothing was changed only when Git
   * answered: a folder without Git has no list, a Git status that could not be read is
   * not evidence of a clean tree, and an absent value means the task ended before
   * Countersign looked at all.
   */
  preExistingStatus?: "git" | "no_repository" | "unavailable";
  policyExclusions: StrictPolicyExclusion[];
  unsupportedPaths: StrictUnsupportedPath[];
  /** Absent when no perimeter scan was compared, for instance when the task stopped in preflight. */
  contentRetention?: StrictContentRetention;
  pauses: StrictPauseRecord[];
  marker?: StrictMarkerReport;
  events: StrictWorkflowEvent[];
  metrics: ProviderMetric[];
  selectedModels?: WorkflowModelSelection;
  executionPermission?: ExecutionPermission;
}

/** Only completed_clean may omit a reason: every other outcome states why and what to do next. */
export type StrictWorkflowResult = StrictResultCore & (
  | { state: "completed_clean"; reason?: undefined }
  | { state: Exclude<StrictTerminalState, "completed_clean">; reason: StrictOutcomeReason }
);
