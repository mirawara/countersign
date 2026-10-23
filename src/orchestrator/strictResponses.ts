import {
  STRICT_RESPONSE_SCHEMA_VERSION, StrictDecision, StrictFinding, StrictObjection, StrictObjectionTarget, StrictPlan,
  StrictPlanResponse, StrictValidation, StrictValidationError,
} from "../shared/strict";
import { FindingSeverity, ProviderKind } from "../shared/types";
import { parseStrictJson } from "./strictJson";
import { StrictPlanValidationContext, validateStrictPlan } from "./strictPlanHash";

export interface StrictPlanResponseContext extends StrictPlanValidationContext {
  provider: ProviderKind;
  /** The plan currently under evaluation and the hash computed locally for it. */
  plan: StrictPlan;
  planHash: string;
  maxResponseBytes: number;
}

const RESPONSE_KEYS = ["schemaVersion", "provider", "planHash", "decision", "objections", "revisedPlan", "summary"];
const OBJECTION_KEYS = ["id", "target", "reference", "summary", "rationale", "blocking"];
const OBJECTION_TARGETS: StrictObjectionTarget[] =
  ["objective", "constraint", "acceptance_criterion", "expected_file", "risk", "check", "question"];
const DECISIONS: StrictDecision[] = ["approve", "reject", "revise"];
const MAX_SUMMARY_LENGTH = 4_000;

/** Parses the structured plan proposal. Free prose is a parse failure, never a plan. */
export function parseStrictPlanProposal(raw: string, context: StrictPlanValidationContext & { maxResponseBytes: number }): StrictValidation<StrictPlan> {
  const parsed = parseBounded(raw, context.maxResponseBytes);
  if (!parsed.ok) return parsed;
  return validateStrictPlan(parsed.value, context);
}

/**
 * Parses a provider's decision on one plan hash. The declared hash is checked against
 * the locally computed one, prose is never read as agreement, and a decision that
 * contradicts its own objections is rejected as ambiguous rather than interpreted.
 */
export function parseStrictPlanResponse(raw: string, context: StrictPlanResponseContext): StrictValidation<StrictPlanResponse> {
  const parsed = parseBounded(raw, context.maxResponseBytes);
  if (!parsed.ok) return parsed;
  const value = parsed.value;
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, errors: [{ path: "$", code: "wrong_type", message: "A plan response must be a JSON object." }] };
  }
  const errors: StrictValidationError[] = [];
  const add = (path: string, code: StrictValidationError["code"], message: string): void => {
    errors.push({ path, code, message });
  };
  const rawResponse = value as Record<string, unknown>;
  for (const key of Object.keys(rawResponse)) {
    if (!RESPONSE_KEYS.includes(key)) add(`$.${key}`, "unknown_field", `The response has an unknown field ${key}.`);
  }
  if (rawResponse.schemaVersion !== STRICT_RESPONSE_SCHEMA_VERSION) {
    add("$.schemaVersion", "unsupported_schema_version", `The response schema version must be ${STRICT_RESPONSE_SCHEMA_VERSION}.`);
  }
  if (rawResponse.provider !== context.provider) {
    add("$.provider", "invalid_reference", `The response claims to come from ${String(rawResponse.provider)} instead of ${context.provider}.`);
  }
  if (typeof rawResponse.planHash !== "string") {
    add("$.planHash", rawResponse.planHash === undefined ? "missing_field" : "wrong_type", "planHash must be the evaluated plan hash.");
  } else if (rawResponse.planHash !== context.planHash) {
    add("$.planHash", "hash_mismatch", "The response evaluates a different plan hash than the current plan.");
  }
  const decision = DECISIONS.includes(rawResponse.decision as StrictDecision) ? rawResponse.decision as StrictDecision : undefined;
  if (!decision) {
    add("$.decision", "ambiguous_decision", "decision must be exactly approve, reject or revise.");
  }
  const summary = typeof rawResponse.summary === "string" ? rawResponse.summary : undefined;
  if (summary === undefined) {
    add("$.summary", rawResponse.summary === undefined ? "missing_field" : "wrong_type", "summary must be a string.");
  } else if (summary.trim().length === 0) {
    add("$.summary", "out_of_range", "summary cannot be empty.");
  } else if (summary.length > MAX_SUMMARY_LENGTH) {
    add("$.summary", "out_of_range", `summary is longer than ${MAX_SUMMARY_LENGTH} characters.`);
  }
  const objections = parseObjections(rawResponse.objections, context, add);

  let revisedPlan: StrictPlan | undefined;
  const suppliedRevision = rawResponse.revisedPlan === null ? undefined : rawResponse.revisedPlan;
  if (suppliedRevision !== undefined) {
    const validated = validateStrictPlan(suppliedRevision, context, "$.revisedPlan");
    if (validated.ok) revisedPlan = validated.value;
    else errors.push(...validated.errors);
  }

  if (decision === "approve" && objections.some((objection) => objection.blocking)) {
    add("$.decision", "ambiguous_decision", "A response cannot approve a plan and keep a blocking objection.");
  }
  if (decision === "reject" && objections.length === 0) {
    add("$.objections", "ambiguous_decision", "A rejection must state at least one motivated objection.");
  }
  if (decision === "revise" && suppliedRevision === undefined) {
    add("$.revisedPlan", "ambiguous_decision", "A revise decision must carry the revised plan it proposes.");
  }
  if (decision !== "revise" && suppliedRevision !== undefined) {
    add("$.revisedPlan", "ambiguous_decision", "Only a revise decision may carry a revised plan.");
  }
  if (errors.length > 0 || !decision || summary === undefined) return { ok: false, errors };
  return {
    ok: true,
    value: {
      schemaVersion: STRICT_RESPONSE_SCHEMA_VERSION,
      provider: context.provider,
      planHash: context.planHash,
      decision,
      objections,
      ...(revisedPlan ? { revisedPlan } : {}),
      summary,
    },
  };
}

function parseBounded(raw: string, maxResponseBytes: number): StrictValidation<unknown> {
  const bytes = Buffer.byteLength(raw, "utf8");
  if (bytes > maxResponseBytes) {
    return { ok: false, errors: [{ path: "$", code: "too_large", message: `The response is ${bytes} bytes, above the ${maxResponseBytes}-byte limit.` }] };
  }
  return parseStrictJson(raw);
}

function parseObjections(
  value: unknown,
  context: StrictPlanResponseContext,
  add: (path: string, code: StrictValidationError["code"], message: string) => void,
): StrictObjection[] {
  if (value === undefined) {
    add("$.objections", "missing_field", "objections is required, even when empty.");
    return [];
  }
  if (!Array.isArray(value)) {
    add("$.objections", "wrong_type", "objections must be an array.");
    return [];
  }
  const seen = new Set<string>();
  const objections: StrictObjection[] = [];
  value.forEach((entry, index) => {
    const path = `$.objections[${index}]`;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      add(path, "wrong_type", `${path} must be an object.`);
      return;
    }
    const raw = entry as Record<string, unknown>;
    for (const key of Object.keys(raw)) {
      if (!OBJECTION_KEYS.includes(key)) add(`${path}.${key}`, "unknown_field", `${path} has an unknown field ${key}.`);
    }
    const id = typeof raw.id === "string" && raw.id.trim().length > 0 ? raw.id : undefined;
    if (!id) add(`${path}.id`, raw.id === undefined ? "missing_field" : "wrong_type", `${path}.id must be a non-empty string.`);
    else if (seen.has(id)) add(`${path}.id`, "duplicate_key", `Two objections share the id ${id}.`);
    if (id) seen.add(id);
    const target = OBJECTION_TARGETS.includes(raw.target as StrictObjectionTarget) ? raw.target as StrictObjectionTarget : undefined;
    if (!target) add(`${path}.target`, "wrong_type", `${path}.target must name a plan section.`);
    const summary = typeof raw.summary === "string" && raw.summary.trim().length > 0 ? raw.summary : undefined;
    if (!summary) add(`${path}.summary`, "missing_field", `${path}.summary must be a non-empty string.`);
    const rationale = typeof raw.rationale === "string" && raw.rationale.trim().length > 0 ? raw.rationale : undefined;
    if (!rationale) add(`${path}.rationale`, "missing_field", `${path}.rationale must explain the objection.`);
    if (typeof raw.blocking !== "boolean") {
      add(`${path}.blocking`, raw.blocking === undefined ? "missing_field" : "wrong_type", `${path}.blocking must be a boolean.`);
    }
    const reference = raw.reference === undefined || raw.reference === null
      ? undefined : typeof raw.reference === "string" ? raw.reference : undefined;
    if (raw.reference !== undefined && raw.reference !== null && reference === undefined) {
      add(`${path}.reference`, "wrong_type", `${path}.reference must be a string.`);
    }
    if (target) validateReference(target, reference, context.plan, path, add);
    if (!id || !target || !summary || !rationale || typeof raw.blocking !== "boolean") return;
    objections.push({ id, target, ...(reference === undefined ? {} : { reference }), summary, rationale, blocking: raw.blocking });
  });
  return objections;
}

/**
 * A list objection references its item by 0-based index; an expected file, a check or a
 * question references its own value or id. Anything that does not resolve against the
 * evaluated plan is an invalid reference, not a vague complaint.
 */
function validateReference(
  target: StrictObjectionTarget,
  reference: string | undefined,
  plan: StrictPlan,
  path: string,
  add: (path: string, code: StrictValidationError["code"], message: string) => void,
): void {
  const referencePath = `${path}.reference`;
  if (target === "objective") {
    if (reference !== undefined) add(referencePath, "invalid_reference", "An objection on the objective takes no reference.");
    return;
  }
  if (reference === undefined) {
    add(referencePath, "missing_field", `An objection on ${target} must name the item it objects to.`);
    return;
  }
  if (target === "expected_file") {
    if (!plan.expectedFiles.includes(reference)) add(referencePath, "invalid_reference", `The plan does not list the file ${reference}.`);
    return;
  }
  if (target === "check") {
    if (!plan.checks.includes(reference)) add(referencePath, "invalid_reference", `The plan does not list the check ${reference}.`);
    return;
  }
  if (target === "question") {
    if (!plan.questions.some((question) => question.id === reference)) {
      add(referencePath, "invalid_reference", `The plan has no question with id ${reference}.`);
    }
    return;
  }
  const list = target === "constraint" ? plan.constraints : target === "acceptance_criterion" ? plan.acceptanceCriteria : plan.risks;
  const index = /^\d+$/.test(reference) ? Number.parseInt(reference, 10) : Number.NaN;
  if (!Number.isInteger(index) || index < 0 || index >= list.length) {
    add(referencePath, "invalid_reference", `The plan has no ${target} at index ${reference}.`);
  }
}

// --- Phase B responses --------------------------------------------------------------

/** A finding as the reviewer reports it; status and bookkeeping are added locally. */
export type StrictReportedFinding = Omit<StrictFinding, "status" | "reportedOnDigest" | "resolution">;

export interface StrictReviewResponseContext {
  provider: ProviderKind;
  snapshotDigest: string;
  /** Paths in the reviewed snapshot; a finding outside them is an invalid reference. */
  reviewedPaths: string[];
  maxResponseBytes: number;
  /** A final approval decides on the snapshot: revise is not one of its options. */
  allowRevise: boolean;
}

export interface StrictReviewDecision {
  schemaVersion: typeof STRICT_RESPONSE_SCHEMA_VERSION;
  provider: ProviderKind;
  snapshotDigest: string;
  decision: StrictDecision;
  findings: StrictReportedFinding[];
  summary: string;
}

export interface StrictImplementationResponseContext {
  maxResponseBytes: number;
  /** Findings the implementation turn must answer, by id. */
  openFindingIds: string[];
}

export interface StrictFindingDecision {
  findingId: string;
  decision: "fixed" | "disputed";
  rationale: string;
}

export interface StrictImplementationDecision {
  schemaVersion: typeof STRICT_RESPONSE_SCHEMA_VERSION;
  provider: "claude";
  summary: string;
  findingDecisions: StrictFindingDecision[];
}

const REVIEW_KEYS = ["schemaVersion", "provider", "snapshotDigest", "decision", "findings", "summary"];
const FINDING_KEYS = ["id", "severity", "file", "line", "evidence", "summary", "blocking"];
const IMPLEMENTATION_KEYS = ["schemaVersion", "provider", "summary", "findingDecisions"];
const FINDING_DECISION_KEYS = ["findingId", "decision", "rationale"];
const SEVERITIES: FindingSeverity[] = ["Critical", "High", "Medium", "Low", "Info"];

/**
 * Validates a decision on one snapshot digest. A review without findings still has to
 * approve explicitly: silence is never agreement.
 */
export function parseStrictReviewResponse(raw: string, context: StrictReviewResponseContext): StrictValidation<StrictReviewDecision> {
  const parsed = parseBounded(raw, context.maxResponseBytes);
  if (!parsed.ok) return parsed;
  if (typeof parsed.value !== "object" || parsed.value === null || Array.isArray(parsed.value)) {
    return { ok: false, errors: [{ path: "$", code: "wrong_type", message: "A review response must be a JSON object." }] };
  }
  const errors: StrictValidationError[] = [];
  const add = (path: string, code: StrictValidationError["code"], message: string): void => {
    errors.push({ path, code, message });
  };
  const raw_ = parsed.value as Record<string, unknown>;
  for (const key of Object.keys(raw_)) {
    if (!REVIEW_KEYS.includes(key)) add(`$.${key}`, "unknown_field", `The response has an unknown field ${key}.`);
  }
  if (raw_.schemaVersion !== STRICT_RESPONSE_SCHEMA_VERSION) {
    add("$.schemaVersion", "unsupported_schema_version", `The response schema version must be ${STRICT_RESPONSE_SCHEMA_VERSION}.`);
  }
  if (raw_.provider !== context.provider) {
    add("$.provider", "invalid_reference", `The response claims to come from ${String(raw_.provider)} instead of ${context.provider}.`);
  }
  if (typeof raw_.snapshotDigest !== "string") {
    add("$.snapshotDigest", raw_.snapshotDigest === undefined ? "missing_field" : "wrong_type", "snapshotDigest must be the reviewed digest.");
  } else if (raw_.snapshotDigest !== context.snapshotDigest) {
    add("$.snapshotDigest", "digest_mismatch", "The response decides on a different snapshot digest than the current one.");
  }
  const decision = DECISIONS.includes(raw_.decision as StrictDecision) ? raw_.decision as StrictDecision : undefined;
  if (!decision) add("$.decision", "ambiguous_decision", "decision must be exactly approve, reject or revise.");
  if (decision === "revise" && !context.allowRevise) {
    add("$.decision", "ambiguous_decision", "A final snapshot approval must approve or reject, not revise.");
  }
  const summary = typeof raw_.summary === "string" && raw_.summary.trim().length > 0 ? raw_.summary : undefined;
  if (summary === undefined) add("$.summary", "missing_field", "summary must be a non-empty string.");
  const findings = parseFindings(raw_.findings, context, add);
  if (decision === "approve" && findings.some((finding) => finding.blocking)) {
    add("$.decision", "ambiguous_decision", "A response cannot approve a snapshot and keep a blocking finding.");
  }
  if (decision === "reject" && findings.length === 0) {
    add("$.findings", "ambiguous_decision", "A rejection must report at least one finding with evidence.");
  }
  if (errors.length > 0 || !decision || summary === undefined) return { ok: false, errors };
  return {
    ok: true,
    value: {
      schemaVersion: STRICT_RESPONSE_SCHEMA_VERSION,
      provider: context.provider,
      snapshotDigest: context.snapshotDigest,
      decision,
      findings,
      summary,
    },
  };
}

/** Validates the implementation turn: every open finding is answered with a reason. */
export function parseStrictImplementationResponse(
  raw: string,
  context: StrictImplementationResponseContext,
): StrictValidation<StrictImplementationDecision> {
  const parsed = parseBounded(raw, context.maxResponseBytes);
  if (!parsed.ok) return parsed;
  if (typeof parsed.value !== "object" || parsed.value === null || Array.isArray(parsed.value)) {
    return { ok: false, errors: [{ path: "$", code: "wrong_type", message: "An implementation response must be a JSON object." }] };
  }
  const errors: StrictValidationError[] = [];
  const add = (path: string, code: StrictValidationError["code"], message: string): void => {
    errors.push({ path, code, message });
  };
  const raw_ = parsed.value as Record<string, unknown>;
  for (const key of Object.keys(raw_)) {
    if (!IMPLEMENTATION_KEYS.includes(key)) add(`$.${key}`, "unknown_field", `The response has an unknown field ${key}.`);
  }
  if (raw_.schemaVersion !== STRICT_RESPONSE_SCHEMA_VERSION) {
    add("$.schemaVersion", "unsupported_schema_version", `The response schema version must be ${STRICT_RESPONSE_SCHEMA_VERSION}.`);
  }
  if (raw_.provider !== "claude") add("$.provider", "invalid_reference", "The implementation response must come from claude.");
  const summary = typeof raw_.summary === "string" && raw_.summary.trim().length > 0 ? raw_.summary : undefined;
  if (summary === undefined) add("$.summary", "missing_field", "summary must be a non-empty string.");

  const decisions: StrictFindingDecision[] = [];
  const seen = new Set<string>();
  if (raw_.findingDecisions === undefined) {
    add("$.findingDecisions", "missing_field", "findingDecisions is required, even when empty.");
  } else if (!Array.isArray(raw_.findingDecisions)) {
    add("$.findingDecisions", "wrong_type", "findingDecisions must be an array.");
  } else {
    raw_.findingDecisions.forEach((entry, index) => {
      const path = `$.findingDecisions[${index}]`;
      if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
        add(path, "wrong_type", `${path} must be an object.`);
        return;
      }
      const item = entry as Record<string, unknown>;
      for (const key of Object.keys(item)) {
        if (!FINDING_DECISION_KEYS.includes(key)) add(`${path}.${key}`, "unknown_field", `${path} has an unknown field ${key}.`);
      }
      const findingId = typeof item.findingId === "string" ? item.findingId : undefined;
      if (!findingId) add(`${path}.findingId`, "missing_field", `${path}.findingId must be a string.`);
      else if (!context.openFindingIds.includes(findingId)) {
        add(`${path}.findingId`, "invalid_reference", `${path}.findingId does not name an open finding.`);
      } else if (seen.has(findingId)) {
        add(`${path}.findingId`, "duplicate_key", `${path}.findingId answers the same finding twice.`);
      }
      if (findingId) seen.add(findingId);
      if (item.decision !== "fixed" && item.decision !== "disputed") {
        add(`${path}.decision`, "ambiguous_decision", `${path}.decision must be fixed or disputed.`);
      }
      const rationale = typeof item.rationale === "string" && item.rationale.trim().length > 0 ? item.rationale : undefined;
      if (!rationale) add(`${path}.rationale`, "missing_field", `${path}.rationale must explain the decision.`);
      if (findingId && rationale && (item.decision === "fixed" || item.decision === "disputed")) {
        decisions.push({ findingId, decision: item.decision, rationale });
      }
    });
    for (const open of context.openFindingIds) {
      if (!seen.has(open)) add("$.findingDecisions", "missing_field", `Finding ${open} was not answered.`);
    }
  }

  if (errors.length > 0 || summary === undefined) return { ok: false, errors };
  return {
    ok: true,
    value: { schemaVersion: STRICT_RESPONSE_SCHEMA_VERSION, provider: "claude", summary, findingDecisions: decisions },
  };
}

function parseFindings(
  value: unknown,
  context: StrictReviewResponseContext,
  add: (path: string, code: StrictValidationError["code"], message: string) => void,
): StrictReportedFinding[] {
  if (value === undefined) {
    add("$.findings", "missing_field", "findings is required, even when empty.");
    return [];
  }
  if (!Array.isArray(value)) {
    add("$.findings", "wrong_type", "findings must be an array.");
    return [];
  }
  const seen = new Set<string>();
  const findings: StrictReportedFinding[] = [];
  value.forEach((entry, index) => {
    const path = `$.findings[${index}]`;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      add(path, "wrong_type", `${path} must be an object.`);
      return;
    }
    const raw = entry as Record<string, unknown>;
    for (const key of Object.keys(raw)) {
      if (!FINDING_KEYS.includes(key)) add(`${path}.${key}`, "unknown_field", `${path} has an unknown field ${key}.`);
    }
    const id = typeof raw.id === "string" && raw.id.trim().length > 0 ? raw.id : undefined;
    if (!id) add(`${path}.id`, "missing_field", `${path}.id must be a non-empty string.`);
    else if (seen.has(id)) add(`${path}.id`, "duplicate_key", `Two findings share the id ${id}.`);
    if (id) seen.add(id);
    const severity = SEVERITIES.includes(raw.severity as FindingSeverity) ? raw.severity as FindingSeverity : undefined;
    if (!severity) add(`${path}.severity`, "wrong_type", `${path}.severity must be a known severity.`);
    const file = typeof raw.file === "string" ? raw.file : undefined;
    if (file === undefined) add(`${path}.file`, "missing_field", `${path}.file must be a string.`);
    else if (!context.reviewedPaths.includes(file)) {
      add(`${path}.file`, "invalid_reference", `${path}.file is not part of the reviewed snapshot.`);
    }
    if (!Number.isInteger(raw.line) || (raw.line as number) < 1) {
      add(`${path}.line`, "out_of_range", `${path}.line must be a positive integer.`);
    }
    const evidence = typeof raw.evidence === "string" && raw.evidence.trim().length > 0 ? raw.evidence : undefined;
    if (!evidence) add(`${path}.evidence`, "missing_field", `${path}.evidence must quote what supports the finding.`);
    const summary = typeof raw.summary === "string" && raw.summary.trim().length > 0 ? raw.summary : undefined;
    if (!summary) add(`${path}.summary`, "missing_field", `${path}.summary must be a non-empty string.`);
    if (typeof raw.blocking !== "boolean") {
      add(`${path}.blocking`, raw.blocking === undefined ? "missing_field" : "wrong_type", `${path}.blocking must be a boolean.`);
    }
    if (!id || !severity || file === undefined || !evidence || !summary || typeof raw.blocking !== "boolean") return;
    findings.push({ id, severity, file, line: raw.line as number, evidence, summary, blocking: raw.blocking });
  });
  return findings;
}
