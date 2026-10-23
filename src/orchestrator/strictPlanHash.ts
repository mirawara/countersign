import { createHash } from "node:crypto";
import {
  STRICT_PLAN_CANONICAL_KEYS, STRICT_PLAN_QUESTION_CANONICAL_KEYS, STRICT_PLAN_SCHEMA_VERSION,
  StrictPlan, StrictPlanQuestion, StrictValidation, StrictValidationError,
} from "../shared/strict";

export interface StrictPlanValidationContext {
  /** Check ids the task authorised; a plan may only name these. */
  authorizedChecks: string[];
}

export interface CanonicalStrictPlan {
  /** Compact JSON with the declared key order; the bytes the hash is taken over. */
  canonical: string;
  bytes: number;
  /** Full SHA-256 of those bytes, computed here and never taken from a model. */
  hash: string;
  /** The plan after normalisation: this is what the hash describes. */
  plan: StrictPlan;
}

const MAX_TEXT_LENGTH = 20_000;
const MAX_LIST_ENTRIES = 1_000;

export function validateStrictPlan(value: unknown, context: StrictPlanValidationContext, path = "$"): StrictValidation<StrictPlan> {
  const errors: StrictValidationError[] = [];
  const add = (field: string, code: StrictValidationError["code"], message: string): void => {
    errors.push({ path: field, code, message });
  };
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { ok: false, errors: [{ path, code: "wrong_type", message: "A plan must be a JSON object." }] };
  }
  const raw = value as Record<string, unknown>;
  for (const key of Object.keys(raw)) {
    if (!(STRICT_PLAN_CANONICAL_KEYS as readonly string[]).includes(key)) {
      add(`${path}.${key}`, "unknown_field", `The plan has an unknown field ${key}.`);
    }
  }
  if (raw.schemaVersion !== STRICT_PLAN_SCHEMA_VERSION) {
    add(`${path}.schemaVersion`, "unsupported_schema_version",
      `The plan schema version must be ${STRICT_PLAN_SCHEMA_VERSION}.`);
  }
  const objective = text(raw.objective, `${path}.objective`, add, true);
  const constraints = textList(raw.constraints, `${path}.constraints`, add);
  const acceptanceCriteria = textList(raw.acceptanceCriteria, `${path}.acceptanceCriteria`, add);
  if (acceptanceCriteria.length === 0) {
    add(`${path}.acceptanceCriteria`, "out_of_range", "A plan needs at least one acceptance criterion.");
  }
  const expectedFiles = pathList(raw.expectedFiles, `${path}.expectedFiles`, add);
  if (typeof raw.expectedFilesComplete !== "boolean") {
    add(`${path}.expectedFilesComplete`, raw.expectedFilesComplete === undefined ? "missing_field" : "wrong_type",
      "expectedFilesComplete must say whether the file list is complete.");
  }
  const risks = textList(raw.risks, `${path}.risks`, add);
  const checks = textList(raw.checks, `${path}.checks`, add);
  const seenChecks = new Set<string>();
  for (const check of checks) {
    if (!context.authorizedChecks.includes(check)) {
      add(`${path}.checks`, "invalid_reference", `The plan names a check that the task did not authorise: ${check}.`);
    }
    if (seenChecks.has(check)) add(`${path}.checks`, "duplicate_key", `The plan names the check ${check} twice.`);
    seenChecks.add(check);
  }
  const questions = questionList(raw.questions, `${path}.questions`, add);
  if (errors.length > 0) return { ok: false, errors };
  return {
    ok: true,
    value: {
      schemaVersion: STRICT_PLAN_SCHEMA_VERSION,
      objective,
      constraints,
      acceptanceCriteria,
      expectedFiles,
      expectedFilesComplete: raw.expectedFilesComplete as boolean,
      risks,
      checks,
      questions,
    },
  };
}

/**
 * Canonical form: the declared keys in the declared order, compact JSON with no outer
 * spacing, CRLF and CR normalised to LF, Unicode NFC, paths slash-separated, the file
 * list sorted by UTF-8 bytes, every other list left in its declared order, and no
 * timestamp, request id or provider metadata. An unanswered question omits its answer
 * key, so answering one changes the hash.
 *
 * Newlines are normalised here on purpose: this fixes the plan's semantic identity.
 * The snapshot digest keeps raw bytes instead, because it identifies what is on disk.
 */
export function canonicalizeStrictPlan(plan: StrictPlan): CanonicalStrictPlan {
  const normalized: StrictPlan = {
    schemaVersion: STRICT_PLAN_SCHEMA_VERSION,
    objective: normalizeText(plan.objective),
    constraints: plan.constraints.map(normalizeText),
    acceptanceCriteria: plan.acceptanceCriteria.map(normalizeText),
    expectedFiles: [...plan.expectedFiles.map(normalizePath)].sort(byUtf8Bytes),
    expectedFilesComplete: plan.expectedFilesComplete,
    risks: plan.risks.map(normalizeText),
    checks: plan.checks.map(normalizeText),
    questions: plan.questions.map((question) => ({
      id: normalizeText(question.id),
      question: normalizeText(question.question),
      ...(question.answer === undefined ? {} : { answer: normalizeText(question.answer) }),
    })),
  };
  const ordered: Record<string, unknown> = {};
  for (const key of STRICT_PLAN_CANONICAL_KEYS) {
    ordered[key] = key === "questions"
      ? normalized.questions.map(orderQuestion)
      : normalized[key];
  }
  const canonical = JSON.stringify(ordered);
  return {
    canonical,
    bytes: Buffer.byteLength(canonical, "utf8"),
    hash: createHash("sha256").update(canonical, "utf8").digest("hex"),
    plan: normalized,
  };
}

export function answerStrictPlanQuestion(plan: StrictPlan, questionId: string, answer: string): StrictPlan {
  return {
    ...plan,
    questions: plan.questions.map((question) => question.id === questionId ? { ...question, answer } : question),
  };
}

function orderQuestion(question: StrictPlanQuestion): Record<string, unknown> {
  const ordered: Record<string, unknown> = {};
  for (const key of STRICT_PLAN_QUESTION_CANONICAL_KEYS) {
    if (key === "answer" && question.answer === undefined) continue;
    ordered[key] = question[key];
  }
  return ordered;
}

function normalizeText(value: string): string {
  return value.replace(/\r\n?/g, "\n").normalize("NFC");
}

function normalizePath(value: string): string {
  return normalizeText(value).replaceAll("\\", "/");
}

function byUtf8Bytes(left: string, right: string): number {
  return Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8"));
}

type AddError = (path: string, code: StrictValidationError["code"], message: string) => void;

function text(value: unknown, path: string, add: AddError, required: boolean): string {
  if (value === undefined) {
    if (required) add(path, "missing_field", `${path} is required.`);
    return "";
  }
  if (typeof value !== "string") {
    add(path, "wrong_type", `${path} must be a string.`);
    return "";
  }
  if (required && value.trim().length === 0) {
    add(path, "out_of_range", `${path} cannot be empty.`);
  }
  if (value.length > MAX_TEXT_LENGTH) {
    add(path, "out_of_range", `${path} is longer than ${MAX_TEXT_LENGTH} characters.`);
  }
  return value;
}

function textList(value: unknown, path: string, add: AddError): string[] {
  if (value === undefined) {
    add(path, "missing_field", `${path} is required.`);
    return [];
  }
  if (!Array.isArray(value)) {
    add(path, "wrong_type", `${path} must be an array of strings.`);
    return [];
  }
  if (value.length > MAX_LIST_ENTRIES) {
    add(path, "out_of_range", `${path} has more than ${MAX_LIST_ENTRIES} entries.`);
    return [];
  }
  return value.map((entry, index) => text(entry, `${path}[${index}]`, add, true));
}

function pathList(value: unknown, path: string, add: AddError): string[] {
  const entries = textList(value, path, add);
  return entries.map((entry, index) => {
    const normalized = entry.replaceAll("\\", "/");
    const unsafe = normalized.length === 0 || normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)
      || normalized.split("/").includes("..") || entry.includes("\0") || entry.includes("\n");
    if (unsafe) {
      add(`${path}[${index}]`, "invalid_path",
        `${path}[${index}] must be a relative workspace path without '..', NUL or newline.`);
    }
    return entry;
  });
}

function questionList(value: unknown, path: string, add: AddError): StrictPlanQuestion[] {
  if (value === undefined) {
    add(path, "missing_field", `${path} is required.`);
    return [];
  }
  if (!Array.isArray(value)) {
    add(path, "wrong_type", `${path} must be an array of question objects.`);
    return [];
  }
  const seen = new Set<string>();
  return value.map((entry, index) => {
    const entryPath = `${path}[${index}]`;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      add(entryPath, "wrong_type", `${entryPath} must be an object.`);
      return { id: "", question: "" };
    }
    const raw = entry as Record<string, unknown>;
    for (const key of Object.keys(raw)) {
      if (!(STRICT_PLAN_QUESTION_CANONICAL_KEYS as readonly string[]).includes(key)) {
        add(`${entryPath}.${key}`, "unknown_field", `${entryPath} has an unknown field ${key}.`);
      }
    }
    const id = text(raw.id, `${entryPath}.id`, add, true);
    if (seen.has(id)) add(`${entryPath}.id`, "duplicate_key", `Two questions share the id ${id}.`);
    seen.add(id);
    const question = text(raw.question, `${entryPath}.question`, add, true);
    const answer = raw.answer === undefined || raw.answer === null
      ? undefined : text(raw.answer, `${entryPath}.answer`, add, true);
    return answer === undefined ? { id, question } : { id, question, answer };
  });
}
