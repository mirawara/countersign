import { describe, expect, it } from "vitest";
import { answerStrictPlanQuestion, canonicalizeStrictPlan, validateStrictPlan } from "../src/orchestrator/strictPlanHash";
import { STRICT_PLAN_SCHEMA_VERSION, StrictPlan } from "../src/shared/strict";

const CONTEXT = { authorizedChecks: ["lint", "test"] };

function plan(overrides: Partial<StrictPlan> = {}): StrictPlan {
  return {
    schemaVersion: STRICT_PLAN_SCHEMA_VERSION,
    objective: "Add the parser",
    constraints: ["No new dependency"],
    acceptanceCriteria: ["Unit tests pass"],
    expectedFiles: ["src/a.ts", "src/b.ts"],
    expectedFilesComplete: true,
    risks: ["Wide rewrite"],
    checks: ["lint"],
    questions: [],
    ...overrides,
  };
}

describe("canonical Strict plan", () => {
  it("writes the declared keys in the declared order with no outer spacing", () => {
    const canonical = canonicalizeStrictPlan(plan()).canonical;
    expect(canonical.startsWith('{"schemaVersion":1,"objective":"Add the parser","constraints":["No new dependency"],"acceptanceCriteria":')).toBe(true);
    expect(canonical).toContain('"expectedFiles":["src/a.ts","src/b.ts"],"expectedFilesComplete":true');
    expect(canonical.endsWith('"questions":[]}')).toBe(true);
    expect(canonical).not.toContain("\n");
    expect(canonicalizeStrictPlan(plan()).hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("gives one hash to plans that differ only in newline style, Unicode form, path separator or file order", () => {
    const base = canonicalizeStrictPlan(plan({ objective: "Line one\nLine two", expectedFiles: ["src/a.ts", "src/b.ts"] }));
    const crlf = canonicalizeStrictPlan(plan({ objective: "Line one\r\nLine two", expectedFiles: ["src/a.ts", "src/b.ts"] }));
    const cr = canonicalizeStrictPlan(plan({ objective: "Line one\rLine two", expectedFiles: ["src/a.ts", "src/b.ts"] }));
    const reordered = canonicalizeStrictPlan(plan({ objective: "Line one\nLine two", expectedFiles: ["src/b.ts", "src\\a.ts"] }));
    expect(crlf.hash).toBe(base.hash);
    expect(cr.hash).toBe(base.hash);
    expect(reordered.hash).toBe(base.hash);
    const decomposed = canonicalizeStrictPlan(plan({ objective: "cafe\u0301" }));
    const composed = canonicalizeStrictPlan(plan({ objective: "caf\u00e9" }));
    expect(decomposed.hash).toBe(composed.hash);
  });

  it("sorts the file list by UTF-8 bytes and keeps every other list in its declared order", () => {
    const sorted = canonicalizeStrictPlan(plan({ expectedFiles: ["src/z.ts", "src/A.ts", "src/é.ts", "src/a.ts"] }));
    expect(sorted.plan.expectedFiles).toEqual(["src/A.ts", "src/a.ts", "src/z.ts", "src/é.ts"]);
    const one = canonicalizeStrictPlan(plan({ constraints: ["first", "second"] }));
    const other = canonicalizeStrictPlan(plan({ constraints: ["second", "first"] }));
    expect(one.hash).not.toBe(other.hash);
  });

  it("changes the hash when an answer, a file or a criterion changes", () => {
    const withQuestion = plan({ questions: [{ id: "q1", question: "Which format?" }] });
    const unanswered = canonicalizeStrictPlan(withQuestion);
    const answered = canonicalizeStrictPlan(answerStrictPlanQuestion(withQuestion, "q1", "JSON"));
    expect(answered.hash).not.toBe(unanswered.hash);
    expect(unanswered.canonical).toContain('"questions":[{"id":"q1","question":"Which format?"}]');
    expect(answered.canonical).toContain('"answer":"JSON"');
    expect(canonicalizeStrictPlan(plan({ expectedFiles: ["src/a.ts"] })).hash).not.toBe(canonicalizeStrictPlan(plan()).hash);
    expect(canonicalizeStrictPlan(plan({ acceptanceCriteria: ["Other"] })).hash).not.toBe(canonicalizeStrictPlan(plan()).hash);
  });

  it("excludes nothing but the declared fields from the canonical bytes", () => {
    const canonical = canonicalizeStrictPlan(plan()).canonical;
    for (const excluded of ["timestamp", "createdAt", "requestId", "provider", "sessionId"]) {
      expect(canonical, excluded).not.toContain(excluded);
    }
  });
});

describe("Strict plan validation", () => {
  it("accepts a well-formed plan", () => {
    const validated = validateStrictPlan(plan(), CONTEXT);
    expect(validated.ok).toBe(true);
  });

  it("normalizes a null answer from a required Codex question field", () => {
    const validated = validateStrictPlan({ ...plan(), questions: [{ id: "q1", question: "Which format?", answer: null }] }, CONTEXT);
    expect(validated.ok).toBe(true);
    expect(validated.ok && validated.value.questions).toEqual([{ id: "q1", question: "Which format?" }]);
  });

  it("rejects unknown fields, wrong types and an unsupported schema version", () => {
    const unknown = validateStrictPlan({ ...plan(), note: "extra" }, CONTEXT);
    expect(unknown.ok).toBe(false);
    expect(unknown.ok === false && unknown.errors[0].code).toBe("unknown_field");
    const wrongType = validateStrictPlan({ ...plan(), constraints: "none" }, CONTEXT);
    expect(wrongType.ok === false && wrongType.errors.some((error) => error.code === "wrong_type")).toBe(true);
    const version = validateStrictPlan({ ...plan(), schemaVersion: 2 }, CONTEXT);
    expect(version.ok === false && version.errors.some((error) => error.code === "unsupported_schema_version")).toBe(true);
    const missing = validateStrictPlan({ ...plan(), expectedFilesComplete: undefined }, CONTEXT);
    expect(missing.ok === false && missing.errors.some((error) => error.code === "missing_field")).toBe(true);
  });

  it("rejects an empty objective, no acceptance criterion and unsafe paths", () => {
    const empty = validateStrictPlan(plan({ objective: "  " }), CONTEXT);
    expect(empty.ok === false && empty.errors.some((error) => error.code === "out_of_range")).toBe(true);
    const noCriteria = validateStrictPlan(plan({ acceptanceCriteria: [] }), CONTEXT);
    expect(noCriteria.ok === false && noCriteria.errors.some((error) => error.code === "out_of_range")).toBe(true);
    for (const unsafe of ["/etc/passwd", "../outside.ts", "C:/win.ts", "src/a\nb.ts"]) {
      const result = validateStrictPlan(plan({ expectedFiles: [unsafe] }), CONTEXT);
      expect(result.ok === false && result.errors.some((error) => error.code === "invalid_path"), unsafe).toBe(true);
    }
  });

  it("rejects a check the task did not authorise and duplicate question ids", () => {
    const check = validateStrictPlan(plan({ checks: ["deploy"] }), CONTEXT);
    expect(check.ok === false && check.errors[0].code).toBe("invalid_reference");
    const duplicateCheck = validateStrictPlan(plan({ checks: ["lint", "lint"] }), CONTEXT);
    expect(duplicateCheck.ok === false && duplicateCheck.errors[0].code).toBe("duplicate_key");
    const questions = validateStrictPlan(plan({
      questions: [{ id: "q1", question: "A?" }, { id: "q1", question: "B?" }],
    }), CONTEXT);
    expect(questions.ok === false && questions.errors[0].code).toBe("duplicate_key");
  });
});
