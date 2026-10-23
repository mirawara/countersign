import { describe, expect, it } from "vitest";
import {
  STRICT_LIMIT_DEFAULTS, STRICT_LIMIT_RANGES, STRICT_SCAN_CAPS, StrictConfigurableLimitId, StrictLimitId,
  StrictLimitOverrides, resolveStrictLimits, strictLimitUnit, strictLimitValue,
} from "../src/shared/strictLimits";

const SCAN_LIMIT_IDS: StrictLimitId[] = [
  "scan.maxScannedFiles", "scan.maxFileBytes", "scan.maxDiffBytes", "scan.maxNewFileBytes",
];

describe("Strict limits", () => {
  it("leaves enough phase A active time for every allowed provider request", () => {
    expect(STRICT_LIMIT_DEFAULTS.planPhase).toEqual({ maxProviderRequests: 8, maxActiveMinutes: 80 });
    expect(STRICT_LIMIT_DEFAULTS.implementationPhase).toEqual({
      maxProviderRequests: 18, maxActiveMinutes: 90, maxReviewCycles: 6, stallCycles: 2,
    });
    expect(STRICT_LIMIT_DEFAULTS.providerRequestTimeoutMinutes).toBe(10);
    expect(STRICT_LIMIT_DEFAULTS.maxStructuredRetries).toBe(2);
    expect(STRICT_LIMIT_DEFAULTS.maxCanonicalPlanBytes).toBe(65_536);
    expect(STRICT_LIMIT_DEFAULTS.maxStructuredResponseBytes).toBe(131_072);
    expect(STRICT_SCAN_CAPS).toEqual({
      maxScannedFiles: 20_000, maxFileBytes: 1_048_576,
      maxDiffBytes: 262_144, maxNewFileBytes: 16_384, maxRetainedContentBytes: 64 * 1024 * 1024,
    });
  });

  it("has no aggregate ceiling on the bytes a scan may read", () => {
    // The perimeter's total size must never be a reason to stop a task, so there is no
    // cap to read back and no breach identifier that could carry one.
    expect(Object.keys(STRICT_SCAN_CAPS)).not.toContain("maxScannedBytes");
    expect(SCAN_LIMIT_IDS).not.toContain("scan.maxScannedBytes" as StrictLimitId);
    // The retention pool bounds memory instead, and it is not a breach identifier either.
    expect(STRICT_SCAN_CAPS.maxRetainedContentBytes).toBeGreaterThan(0);
    expect(SCAN_LIMIT_IDS).not.toContain("scan.maxRetainedContentBytes" as StrictLimitId);
  });

  it("accepts per-task overrides inside the declared ranges", () => {
    const limits = resolveStrictLimits({
      maxStructuredRetries: 0,
      "implementationPhase.maxReviewCycles": 3,
    });
    expect(limits.maxStructuredRetries).toBe(0);
    expect(limits.implementationPhase.maxReviewCycles).toBe(3);
    expect(limits.planPhase.maxProviderRequests).toBe(STRICT_LIMIT_DEFAULTS.planPhase.maxProviderRequests);
  });

  it("freezes the resolved limits so a running task cannot raise one", () => {
    const limits = resolveStrictLimits();
    expect(() => { (limits as { maxStructuredRetries: number }).maxStructuredRetries = 9; }).toThrow(TypeError);
    expect(() => { (limits.implementationPhase as { maxActiveMinutes: number }).maxActiveMinutes = 999; }).toThrow(TypeError);
    expect(limits.maxStructuredRetries).toBe(2);
  });

  it("rejects values outside the range, non-integers and unknown limits", () => {
    expect(() => resolveStrictLimits({ "implementationPhase.maxReviewCycles": 0 })).toThrow("between 1 and 50 cycles");
    expect(() => resolveStrictLimits({ "implementationPhase.maxReviewCycles": 1.5 })).toThrow("must be an integer");
    expect(() => resolveStrictLimits({ "planPhase.maxActiveMinutes": 0 })).toThrow("between 1 and 1440 minutes");
    expect(() => resolveStrictLimits({ maxStructuredRetries: 6 })).toThrow("between 0 and 5 retries");
    expect(() => resolveStrictLimits({ maxCanonicalPlanBytes: 10 })).toThrow("between 1024 and 1048576 bytes");
    expect(() => resolveStrictLimits({ maxStructuredRetries: Number.POSITIVE_INFINITY })).toThrow("must be an integer");
    expect(() => resolveStrictLimits({ unlimited: 1 } as unknown as StrictLimitOverrides)).toThrow("Unknown Strict limit: unlimited.");
  });

  it("keeps the scan ceilings absolute instead of per-task", () => {
    expect(() => resolveStrictLimits({ "scan.maxScannedFiles": 50_000 } as unknown as StrictLimitOverrides))
      .toThrow("Unknown Strict limit: scan.maxScannedFiles.");
    const limits = resolveStrictLimits();
    // The scan ceilings are absolute: Strict has no per-task ceiling on changed files.
    expect(strictLimitValue(limits, "scan.maxScannedFiles")).toBe(20_000);
    expect(strictLimitValue(limits, "scan.maxDiffBytes")).toBe(262_144);
    expect(strictLimitValue(limits, "scan.maxNewFileBytes")).toBe(16_384);
  });

  it("reads back every configurable limit and never leaves one unbounded", () => {
    const limits = resolveStrictLimits();
    const ids = Object.keys(STRICT_LIMIT_RANGES) as StrictConfigurableLimitId[];
    for (const id of ids) {
      const range = STRICT_LIMIT_RANGES[id];
      const value = strictLimitValue(limits, id);
      expect(Number.isFinite(range.max), id).toBe(true);
      expect(value, id).toBeGreaterThanOrEqual(range.min);
      expect(value, id).toBeLessThanOrEqual(range.max);
      expect(strictLimitUnit(id), id).toBe(range.unit);
    }
    for (const id of SCAN_LIMIT_IDS) {
      expect(strictLimitValue(limits, id), id).toBeGreaterThan(0);
      expect(strictLimitUnit(id), id).toBe(id === "scan.maxScannedFiles" ? "files" : "bytes");
    }
  });
});
