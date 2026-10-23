import { describe, expect, it } from "vitest";
import { parseStrictJson } from "../src/orchestrator/strictJson";
import { canonicalizeStrictPlan } from "../src/orchestrator/strictPlanHash";
import {
  parseStrictImplementationResponse, parseStrictPlanProposal, parseStrictPlanResponse, parseStrictReviewResponse,
  StrictPlanResponseContext,
} from "../src/orchestrator/strictResponses";
import { STRICT_PLAN_SCHEMA_VERSION, STRICT_RESPONSE_SCHEMA_VERSION, StrictPlan, StrictValidationError } from "../src/shared/strict";

const PLAN: StrictPlan = {
  schemaVersion: STRICT_PLAN_SCHEMA_VERSION,
  objective: "Add the parser",
  constraints: ["No new dependency"],
  acceptanceCriteria: ["Unit tests pass"],
  expectedFiles: ["src/a.ts"],
  expectedFilesComplete: true,
  risks: ["Wide rewrite"],
  checks: ["lint"],
  questions: [{ id: "q1", question: "Which format?", answer: "JSON" }],
};

const PLAN_HASH = canonicalizeStrictPlan(PLAN).hash;

const CONTEXT: StrictPlanResponseContext = {
  provider: "codex",
  plan: PLAN,
  planHash: PLAN_HASH,
  authorizedChecks: ["lint", "test"],
  maxResponseBytes: 131_072,
};

function response(overrides: Record<string, unknown> = {}): string {
  return JSON.stringify({
    schemaVersion: STRICT_RESPONSE_SCHEMA_VERSION,
    provider: "codex",
    planHash: PLAN_HASH,
    decision: "approve",
    objections: [],
    summary: "The plan matches the request.",
    ...overrides,
  });
}

function codes(errors: StrictValidationError[]): string[] {
  return errors.map((error) => error.code);
}

describe("strict JSON reader", () => {
  it("rejects duplicate keys instead of keeping the last one", () => {
    const parsed = parseStrictJson('{"decision":"reject","decision":"approve"}');
    expect(parsed.ok).toBe(false);
    expect(parsed.ok === false && parsed.errors[0].code).toBe("duplicate_key");
  });

  it("rejects prose, trailing content, control characters and __proto__", () => {
    for (const [text, code] of [
      ["The plan looks good to me.", "wrong_type"],
      ['{"a":1} trailing', "wrong_type"],
      ['{"a":"line\nbreak"}', "wrong_type"],
      ['{"__proto__":{}}', "unknown_field"],
      ['{"a":NaN}', "wrong_type"],
    ] as const) {
      const parsed = parseStrictJson(text);
      expect(parsed.ok, text).toBe(false);
      expect(parsed.ok === false && parsed.errors[0].code, text).toBe(code);
    }
    expect(parseStrictJson('{"a":[1,2,{"b":null}],"c":true}').ok).toBe(true);
  });
});

describe("Strict plan proposal validation", () => {
  it("accepts a plan and rejects one above the response byte limit", () => {
    const accepted = parseStrictPlanProposal(JSON.stringify(PLAN), { authorizedChecks: ["lint"], maxResponseBytes: 131_072 });
    expect(accepted.ok).toBe(true);
    const tooLarge = parseStrictPlanProposal(JSON.stringify(PLAN), { authorizedChecks: ["lint"], maxResponseBytes: 32 });
    expect(tooLarge.ok === false && tooLarge.errors[0].code).toBe("too_large");
  });

  it("never reads prose as a plan", () => {
    const prose = parseStrictPlanProposal("Here is my plan: refactor everything.", { authorizedChecks: [], maxResponseBytes: 131_072 });
    expect(prose.ok).toBe(false);
  });
});

describe("Strict plan response validation", () => {
  it("accepts an explicit approval of the current hash", () => {
    const parsed = parseStrictPlanResponse(response(), CONTEXT);
    expect(parsed.ok).toBe(true);
    expect(parsed.ok && parsed.value.decision).toBe("approve");
  });

  it("normalizes null optional fields from Codex strict output", () => {
    const approval = parseStrictPlanResponse(response({ revisedPlan: null }), CONTEXT);
    expect(approval.ok).toBe(true);
    expect(approval.ok && approval.value.revisedPlan).toBeUndefined();
    const rejection = parseStrictPlanResponse(response({
      decision: "reject", revisedPlan: null,
      objections: [{ id: "o1", target: "objective", reference: null, summary: "Too broad", rationale: "One step is unclear", blocking: true }],
    }), CONTEXT);
    expect(rejection.ok).toBe(true);
    expect(rejection.ok && rejection.value.objections[0].reference).toBeUndefined();
  });

  it("rejects a decision on another hash", () => {
    const parsed = parseStrictPlanResponse(response({ planHash: "f".repeat(64) }), CONTEXT);
    expect(parsed.ok === false && codes(parsed.errors)).toContain("hash_mismatch");
  });

  it("rejects missing fields, wrong types, unknown fields and a wrong schema version", () => {
    const missing = parseStrictPlanResponse(JSON.stringify({ schemaVersion: 1, provider: "codex", planHash: PLAN_HASH, decision: "approve" }), CONTEXT);
    expect(missing.ok === false && codes(missing.errors)).toEqual(expect.arrayContaining(["missing_field"]));
    const wrongType = parseStrictPlanResponse(response({ objections: "none" }), CONTEXT);
    expect(wrongType.ok === false && codes(wrongType.errors)).toContain("wrong_type");
    const unknown = parseStrictPlanResponse(response({ confidence: 0.9 }), CONTEXT);
    expect(unknown.ok === false && codes(unknown.errors)).toContain("unknown_field");
    const version = parseStrictPlanResponse(response({ schemaVersion: 9 }), CONTEXT);
    expect(version.ok === false && codes(version.errors)).toContain("unsupported_schema_version");
    const otherProvider = parseStrictPlanResponse(response({ provider: "claude" }), CONTEXT);
    expect(otherProvider.ok === false && codes(otherProvider.errors)).toContain("invalid_reference");
  });

  it("rejects an ambiguous decision rather than interpreting it", () => {
    const unknownDecision = parseStrictPlanResponse(response({ decision: "looks fine" }), CONTEXT);
    expect(unknownDecision.ok === false && codes(unknownDecision.errors)).toContain("ambiguous_decision");
    const approveWithBlocking = parseStrictPlanResponse(response({
      objections: [{ id: "o1", target: "objective", summary: "Too wide", rationale: "The objective covers two tasks", blocking: true }],
    }), CONTEXT);
    expect(approveWithBlocking.ok === false && codes(approveWithBlocking.errors)).toContain("ambiguous_decision");
    const rejectWithoutObjection = parseStrictPlanResponse(response({ decision: "reject" }), CONTEXT);
    expect(rejectWithoutObjection.ok === false && codes(rejectWithoutObjection.errors)).toContain("ambiguous_decision");
    const reviseWithoutPlan = parseStrictPlanResponse(response({ decision: "revise" }), CONTEXT);
    expect(reviseWithoutPlan.ok === false && codes(reviseWithoutPlan.errors)).toContain("ambiguous_decision");
    const approveWithPlan = parseStrictPlanResponse(response({ revisedPlan: PLAN }), CONTEXT);
    expect(approveWithPlan.ok === false && codes(approveWithPlan.errors)).toContain("ambiguous_decision");
  });

  it("rejects an objection that references something the plan does not contain", () => {
    const badFile = parseStrictPlanResponse(response({
      decision: "reject",
      objections: [{ id: "o1", target: "expected_file", reference: "src/missing.ts", summary: "Out of scope", rationale: "Not in the objective", blocking: true }],
    }), CONTEXT);
    expect(badFile.ok === false && codes(badFile.errors)).toContain("invalid_reference");
    const badIndex = parseStrictPlanResponse(response({
      decision: "reject",
      objections: [{ id: "o1", target: "constraint", reference: "7", summary: "Wrong", rationale: "No such constraint", blocking: true }],
    }), CONTEXT);
    expect(badIndex.ok === false && codes(badIndex.errors)).toContain("invalid_reference");
    const good = parseStrictPlanResponse(response({
      decision: "reject",
      objections: [{ id: "o1", target: "constraint", reference: "0", summary: "Wrong", rationale: "The constraint blocks the objective", blocking: true }],
    }), CONTEXT);
    expect(good.ok).toBe(true);
  });

  it("validates a revised plan carried by a revise decision", () => {
    const valid = parseStrictPlanResponse(response({
      decision: "revise",
      revisedPlan: { ...PLAN, expectedFiles: ["src/a.ts", "src/b.ts"] },
      objections: [{ id: "o1", target: "expected_file", reference: "src/a.ts", summary: "Needs a second file", rationale: "The parser is split in two", blocking: true }],
    }), CONTEXT);
    expect(valid.ok).toBe(true);
    expect(valid.ok && valid.value.revisedPlan?.expectedFiles).toEqual(["src/a.ts", "src/b.ts"]);
    const invalid = parseStrictPlanResponse(response({
      decision: "revise",
      revisedPlan: { ...PLAN, checks: ["deploy"] },
      objections: [],
    }), CONTEXT);
    expect(invalid.ok === false && codes(invalid.errors)).toContain("invalid_reference");
  });

  it("rejects a response above the byte limit and duplicate objection ids", () => {
    const tooLarge = parseStrictPlanResponse(response(), { ...CONTEXT, maxResponseBytes: 50 });
    expect(tooLarge.ok === false && codes(tooLarge.errors)).toContain("too_large");
    const duplicate = parseStrictPlanResponse(response({
      decision: "reject",
      objections: [
        { id: "o1", target: "objective", summary: "One", rationale: "First", blocking: true },
        { id: "o1", target: "objective", summary: "Two", rationale: "Second", blocking: false },
      ],
    }), CONTEXT);
    expect(duplicate.ok === false && codes(duplicate.errors)).toContain("duplicate_key");
  });
});

describe("Strict phase B response validation", () => {
  const REVIEW_CONTEXT = {
    provider: "codex" as const,
    snapshotDigest: "d".repeat(64),
    reviewedPaths: ["src/a.ts"],
    maxResponseBytes: 131_072,
    allowRevise: true,
  };

  function reviewRaw(overrides: Record<string, unknown> = {}): string {
    return JSON.stringify({
      schemaVersion: STRICT_RESPONSE_SCHEMA_VERSION,
      provider: "codex",
      snapshotDigest: REVIEW_CONTEXT.snapshotDigest,
      decision: "approve",
      findings: [],
      summary: "The diff matches the plan.",
      ...overrides,
    });
  }

  const finding = (overrides: Record<string, unknown> = {}): Record<string, unknown> => ({
    id: "f1", severity: "High", file: "src/a.ts", line: 3, evidence: "line 3", summary: "Off by one",
    blocking: true, ...overrides,
  });

  it("accepts an explicit approval of the reviewed digest", () => {
    const parsed = parseStrictReviewResponse(reviewRaw(), REVIEW_CONTEXT);
    expect(parsed.ok && parsed.value.decision).toBe("approve");
  });

  it("rejects a decision on another digest and an approval that keeps a blocking finding", () => {
    const other = parseStrictReviewResponse(reviewRaw({ snapshotDigest: "e".repeat(64) }), REVIEW_CONTEXT);
    expect(other.ok === false && codes(other.errors)).toContain("digest_mismatch");
    const contradictory = parseStrictReviewResponse(reviewRaw({ findings: [finding()] }), REVIEW_CONTEXT);
    expect(contradictory.ok === false && codes(contradictory.errors)).toContain("ambiguous_decision");
    const emptyRejection = parseStrictReviewResponse(reviewRaw({ decision: "reject" }), REVIEW_CONTEXT);
    expect(emptyRejection.ok === false && codes(emptyRejection.errors)).toContain("ambiguous_decision");
  });

  it("rejects a finding outside the reviewed snapshot or without evidence", () => {
    const outside = parseStrictReviewResponse(reviewRaw({ decision: "reject", findings: [finding({ file: "src/other.ts" })] }), REVIEW_CONTEXT);
    expect(outside.ok === false && codes(outside.errors)).toContain("invalid_reference");
    const noEvidence = parseStrictReviewResponse(reviewRaw({ decision: "reject", findings: [finding({ evidence: " " })] }), REVIEW_CONTEXT);
    expect(noEvidence.ok === false && codes(noEvidence.errors)).toContain("missing_field");
    const badLine = parseStrictReviewResponse(reviewRaw({ decision: "reject", findings: [finding({ line: 0 })] }), REVIEW_CONTEXT);
    expect(badLine.ok === false && codes(badLine.errors)).toContain("out_of_range");
  });

  it("forbids revise on a final snapshot approval", () => {
    const allowed = parseStrictReviewResponse(reviewRaw({ decision: "revise" }), REVIEW_CONTEXT);
    expect(allowed.ok).toBe(true);
    const final = parseStrictReviewResponse(reviewRaw({ provider: "claude", decision: "revise" }), {
      ...REVIEW_CONTEXT, provider: "claude", allowRevise: false,
    });
    expect(final.ok === false && codes(final.errors)).toContain("ambiguous_decision");
  });

  it("requires the implementation turn to answer every open finding with a reason", () => {
    const context = { maxResponseBytes: 131_072, openFindingIds: ["f1", "f2"] };
    const complete = parseStrictImplementationResponse(JSON.stringify({
      schemaVersion: STRICT_RESPONSE_SCHEMA_VERSION, provider: "claude", summary: "Fixed one, disputed one.",
      findingDecisions: [
        { findingId: "f1", decision: "fixed", rationale: "Corrected the bound." },
        { findingId: "f2", decision: "disputed", rationale: "The reviewer misread the loop." },
      ],
    }), context);
    expect(complete.ok).toBe(true);

    const partial = parseStrictImplementationResponse(JSON.stringify({
      schemaVersion: STRICT_RESPONSE_SCHEMA_VERSION, provider: "claude", summary: "Fixed one.",
      findingDecisions: [{ findingId: "f1", decision: "fixed", rationale: "Corrected the bound." }],
    }), context);
    expect(partial.ok === false && codes(partial.errors)).toContain("missing_field");

    const unknown = parseStrictImplementationResponse(JSON.stringify({
      schemaVersion: STRICT_RESPONSE_SCHEMA_VERSION, provider: "claude", summary: "Fixed something else.",
      findingDecisions: [{ findingId: "f9", decision: "fixed", rationale: "Unrelated." }],
    }), { maxResponseBytes: 131_072, openFindingIds: ["f1"] });
    expect(unknown.ok === false && codes(unknown.errors)).toContain("invalid_reference");

    const noRationale = parseStrictImplementationResponse(JSON.stringify({
      schemaVersion: STRICT_RESPONSE_SCHEMA_VERSION, provider: "claude", summary: "Fixed it.",
      findingDecisions: [{ findingId: "f1", decision: "fixed", rationale: "" }],
    }), { maxResponseBytes: 131_072, openFindingIds: ["f1"] });
    expect(noRationale.ok === false && codes(noRationale.errors)).toContain("missing_field");
  });
});
