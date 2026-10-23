import {
  StrictBaselineIdentity, StrictFinding, StrictObjection, StrictPlan, StrictPlanQuestion, StrictValidationError,
} from "../shared/strict";
import { ProviderKind, ProviderMetric } from "../shared/types";

/**
 * Ports the Strict protocol talks to. Delivery 2 drives them with fake providers; the
 * CLI adapters implement them later. Nothing here trusts a model: a capability is a
 * property of the installed provider, not something a prompt can assert.
 */
export type StrictProviderErrorKind =
  | "unavailable"
  | "capability_missing"
  | "authentication"
  | "quota"
  | "local_limit"
  | "permissions"
  | "timed_out"
  | "cancelled"
  | "protocol";

export class StrictProviderError extends Error {
  constructor(readonly kind: StrictProviderErrorKind, message: string, readonly provider?: ProviderKind) {
    super(message);
    this.name = "StrictProviderError";
  }
}

export class StrictBaselineError extends Error {
  constructor(readonly kind: "changed" | "unavailable", message: string) {
    super(message);
    this.name = "StrictBaselineError";
  }
}

export interface StrictPlanningCapability {
  available: boolean;
  /**
   * True only when the read-only tool policy is enforced where the tools start — no
   * writes, no mutating commands, no network. A prompt instruction does not count.
   */
  readOnlyToolsEnforced: boolean;
  /** True only when a fresh native context can be verified for the installed version. */
  freshContext: boolean;
  providerVersion?: string;
  sessionId?: string;
  reason?: string;
}

interface StrictPlanRequestBase {
  taskId: string;
  /** The workspace path, for the human-readable context given to the model. */
  repository: string;
  /**
   * The working directory the provider process must run in: the root reached through its
   * open descriptor, so a path replaced before the spawn cannot move the process into
   * another tree.
   */
  workingDirectory: string;
  task: string;
  signal: AbortSignal;
  timeoutMs: number;
  maxResponseBytes: number;
  /** Validation errors from the previous attempt, when this request is a retry. */
  retryErrors?: StrictValidationError[];
  /** A bounded prior answer to repair without repeating repository analysis. */
  previousRaw?: string;
}

export interface StrictPlanProposalRequest extends StrictPlanRequestBase {
  kind: "propose";
  authorizedChecks: string[];
  /** Human answers already recorded, so the proposal keeps them. */
  answeredQuestions: StrictPlanQuestion[];
}

export interface StrictPlanEvaluationRequest extends StrictPlanRequestBase {
  kind: "evaluate";
  plan: StrictPlan;
  planHash: string;
  canonicalPlan: string;
  priorObjections: StrictObjection[];
  authorizedChecks: string[];
}

export type StrictPlanRequest = StrictPlanProposalRequest | StrictPlanEvaluationRequest;

export interface StrictPlanProviderReply {
  /** The raw structured response; it is validated locally and never trusted as sent. */
  raw: string;
  sessionId?: string;
  providerVersion?: string;
  metrics?: Omit<ProviderMetric, "provider">;
}

export interface StrictPlanningProvider {
  readonly id: string;
  readonly kind: ProviderKind;
  checkPlanningCapability(signal: AbortSignal): Promise<StrictPlanningCapability>;
  request(request: StrictPlanRequest): Promise<StrictPlanProviderReply>;
  cancel(taskId: string): Promise<void>;
}

/**
 * The baseline guard. Delivery 3 implements it over the Strict filesystem scan; phase A
 * only needs to re-check that the workspace did not move under it.
 */
export interface StrictBaselineGuard {
  identity(): StrictBaselineIdentity;
  /** Throws StrictBaselineError when the workspace changed or cannot be compared. */
  assertUnchanged(): Promise<void>;
}

// --- Phase B ports -----------------------------------------------------------------

export type StrictSessionKind = "implementation" | "review" | "final_approval";

export interface StrictSessionCapability {
  available: boolean;
  /**
   * True only when a new native context can be verified: a Claude SDK query with no
   * session or resume id, or a Codex thread/start with a new thread id. A prompt that
   * claims a fresh context does not count.
   */
  freshContext: boolean;
  /** True only when the provider itself enforces a read-only sandbox for this session. */
  readOnlySandbox: boolean;
  providerVersion?: string;
  sessionId?: string;
  reason?: string;
}

interface StrictPhaseBRequestBase {
  taskId: string;
  /** The workspace path, for the human-readable context given to the model. */
  repository: string;
  /** The working directory the provider process must run in; see the phase A note. */
  workingDirectory: string;
  task: string;
  plan: StrictPlan;
  planHash: string;
  signal: AbortSignal;
  timeoutMs: number;
  maxResponseBytes: number;
  retryErrors?: StrictValidationError[];
}

export interface StrictImplementationRequest extends StrictPhaseBRequestBase {
  kind: "implement" | "correct";
  acceptanceCriteria: string[];
  answeredQuestions: StrictPlanQuestion[];
  authorizedChecks: string[];
  baseline: StrictBaselineIdentity;
  /** Changes already in the workspace before the task, kept and shown as context. */
  preExistingEntries: string[];
  executionPermission: "askBeforeChange" | "fullAccess";
  snapshotDigest?: string;
  diff?: string;
  /** Findings to confirm or dispute, on a correction turn. */
  findings?: StrictFinding[];
  /** Targeted output of the checks that failed, on a correction turn. */
  failedChecks?: { id: string; output: string }[];
}

export interface StrictReviewRequest extends StrictPhaseBRequestBase {
  snapshotDigest: string;
  diff: string;
  preExistingEntries: string[];
  checkResults: { id: string; passed: boolean }[];
  implementationSummary: string;
}

export interface StrictFinalApprovalRequest extends StrictPhaseBRequestBase {
  snapshotDigest: string;
  diff: string;
  findings: StrictFinding[];
  checkResults: { id: string; passed: boolean }[];
}

export interface StrictPhaseBReply {
  raw: string;
  sessionId?: string;
  providerVersion?: string;
  metrics?: Omit<ProviderMetric, "provider">;
}

export interface StrictImplementationProvider {
  readonly id: string;
  readonly kind: "claude";
  checkSessionCapability(kind: StrictSessionKind, signal: AbortSignal): Promise<StrictSessionCapability>;
  implement(request: StrictImplementationRequest): Promise<StrictPhaseBReply>;
  /** Runs in a separate context with no write tools. */
  approveSnapshot(request: StrictFinalApprovalRequest): Promise<StrictPhaseBReply>;
  cancel(taskId: string): Promise<void>;
}

export interface StrictReviewProvider {
  readonly id: string;
  readonly kind: "codex";
  checkSessionCapability(kind: StrictSessionKind, signal: AbortSignal): Promise<StrictSessionCapability>;
  /** A new review context per examined snapshot; always read-only. */
  review(request: StrictReviewRequest): Promise<StrictPhaseBReply>;
  cancel(taskId: string): Promise<void>;
}
