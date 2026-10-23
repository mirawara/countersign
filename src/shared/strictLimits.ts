import type { StrictPhase } from "./strict";

/**
 * Strict ceilings. Every number below is an arbitrary placeholder: roadmap item 4
 * (daily use and measurement) was skipped by an explicit product decision, so no
 * value here is derived from measured runs. They are per-task configurable,
 * frozen once a task starts, and never absent.
 */
export interface StrictPlanPhaseLimits {
  maxProviderRequests: number;
  maxActiveMinutes: number;
}

export interface StrictImplementationPhaseLimits extends StrictPlanPhaseLimits {
  maxReviewCycles: number;
  /** Full review cycles without verifiable progress before the task pauses. */
  stallCycles: number;
}

export interface StrictLimits {
  readonly planPhase: Readonly<StrictPlanPhaseLimits>;
  readonly implementationPhase: Readonly<StrictImplementationPhaseLimits>;
  readonly providerRequestTimeoutMinutes: number;
  /** Retries allowed after the initial request when a structured response is invalid. */
  readonly maxStructuredRetries: number;
  readonly maxCanonicalPlanBytes: number;
  readonly maxStructuredResponseBytes: number;
}

/**
 * Absolute scan ceilings. They are not per-task configurable: 20,000 scanned files stays
 * the hard ceiling. Policy-excluded paths do not consume them.
 *
 * There is deliberately no ceiling on how many bytes a scan may read. Strict hashes every
 * included file in streaming, whatever the perimeter weighs, so a large workspace is read
 * rather than refused. What is bounded is memory, not work: `maxRetainedContentBytes` caps
 * the file bytes the scan keeps in RAM to build diffs. Exhausting it never ends a task and
 * never needs a setting changed — it only means a change in a file whose bytes were not
 * kept is reported as unreviewable, which blocks a clean completion.
 */
export const STRICT_SCAN_CAPS = Object.freeze({
  maxScannedFiles: 20_000,
  maxFileBytes: 1024 * 1024,
  maxDiffBytes: 262_144,
  maxNewFileBytes: 16_384,
  /**
   * Memory pool for retained file contents, per scan. A capture holds the baseline pool
   * and its own at the same time, so the live worst case is twice this value.
   */
  maxRetainedContentBytes: 64 * 1024 * 1024,
});

export type StrictConfigurableLimitId =
  | "planPhase.maxProviderRequests"
  | "planPhase.maxActiveMinutes"
  | "implementationPhase.maxProviderRequests"
  | "implementationPhase.maxActiveMinutes"
  | "implementationPhase.maxReviewCycles"
  | "implementationPhase.stallCycles"
  | "providerRequestTimeoutMinutes"
  | "maxStructuredRetries"
  | "maxCanonicalPlanBytes"
  | "maxStructuredResponseBytes";

/**
 * Scan ceilings that can end a task when reached. `maxRetainedContentBytes` is absent on
 * purpose: a full retention pool is never a breach, so it has no breach identifier.
 */
export type StrictScanLimitId =
  | "scan.maxScannedFiles"
  | "scan.maxFileBytes"
  | "scan.maxDiffBytes"
  | "scan.maxNewFileBytes";

export type StrictLimitId = StrictConfigurableLimitId | StrictScanLimitId;

export type StrictLimitUnit = "requests" | "minutes" | "cycles" | "retries" | "files" | "bytes";

/** The exact ceiling a task reached, shown in chat before the result and in the report. */
export interface StrictLimitBreach {
  limit: StrictLimitId;
  phase: StrictPhase;
  configured: number;
  observed: number;
  unit: StrictLimitUnit;
}

export interface StrictLimitRange {
  min: number;
  max: number;
  unit: StrictLimitUnit;
}

export const STRICT_LIMIT_DEFAULTS: StrictLimits = Object.freeze({
  // Eight requests at up to ten minutes each must fit without the phase ceiling
  // silently shortening a later consensus or schema-repair request.
  planPhase: Object.freeze({ maxProviderRequests: 8, maxActiveMinutes: 80 }),
  implementationPhase: Object.freeze({
    maxProviderRequests: 18,
    maxActiveMinutes: 90,
    maxReviewCycles: 6,
    stallCycles: 2,
  }),
  providerRequestTimeoutMinutes: 10,
  maxStructuredRetries: 2,
  maxCanonicalPlanBytes: 64 * 1024,
  maxStructuredResponseBytes: 128 * 1024,
});

/**
 * Per-task bounds. Every bound comes from
 * the Strict specification; the others are bounded here only so no ceiling can be removed.
 */
export const STRICT_LIMIT_RANGES: Readonly<Record<StrictConfigurableLimitId, StrictLimitRange>> = Object.freeze({
  "planPhase.maxProviderRequests": { min: 1, max: 200, unit: "requests" },
  "planPhase.maxActiveMinutes": { min: 1, max: 1_440, unit: "minutes" },
  "implementationPhase.maxProviderRequests": { min: 1, max: 400, unit: "requests" },
  "implementationPhase.maxActiveMinutes": { min: 1, max: 1_440, unit: "minutes" },
  "implementationPhase.maxReviewCycles": { min: 1, max: 50, unit: "cycles" },
  "implementationPhase.stallCycles": { min: 1, max: 20, unit: "cycles" },
  providerRequestTimeoutMinutes: { min: 1, max: 120, unit: "minutes" },
  maxStructuredRetries: { min: 0, max: 5, unit: "retries" },
  maxCanonicalPlanBytes: { min: 1_024, max: 1_048_576, unit: "bytes" },
  maxStructuredResponseBytes: { min: 1_024, max: 1_048_576, unit: "bytes" },
});

export type StrictLimitOverrides = Partial<Record<StrictConfigurableLimitId, number>>;

const CONFIGURABLE_LIMIT_IDS = Object.keys(STRICT_LIMIT_RANGES) as StrictConfigurableLimitId[];

/**
 * Validates per-task overrides and returns frozen limits. A task freezes these before its
 * first provider request; nothing may raise or remove a ceiling afterwards.
 */
export function resolveStrictLimits(overrides: StrictLimitOverrides = {}): StrictLimits {
  for (const key of Object.keys(overrides)) {
    if (!CONFIGURABLE_LIMIT_IDS.includes(key as StrictConfigurableLimitId)) {
      throw new Error(`Unknown Strict limit: ${key}.`);
    }
  }
  const value = (id: StrictConfigurableLimitId): number => {
    const override = overrides[id];
    if (override === undefined) return strictLimitValue(STRICT_LIMIT_DEFAULTS, id);
    const range = STRICT_LIMIT_RANGES[id];
    if (typeof override !== "number" || !Number.isInteger(override)) {
      throw new Error(`Strict limit ${id} must be an integer.`);
    }
    if (override < range.min || override > range.max) {
      throw new Error(`Strict limit ${id} must be between ${range.min} and ${range.max} ${range.unit}.`);
    }
    return override;
  };
  return Object.freeze({
    planPhase: Object.freeze({
      maxProviderRequests: value("planPhase.maxProviderRequests"),
      maxActiveMinutes: value("planPhase.maxActiveMinutes"),
    }),
    implementationPhase: Object.freeze({
      maxProviderRequests: value("implementationPhase.maxProviderRequests"),
      maxActiveMinutes: value("implementationPhase.maxActiveMinutes"),
      maxReviewCycles: value("implementationPhase.maxReviewCycles"),
      stallCycles: value("implementationPhase.stallCycles"),
    }),
    providerRequestTimeoutMinutes: value("providerRequestTimeoutMinutes"),
    maxStructuredRetries: value("maxStructuredRetries"),
    maxCanonicalPlanBytes: value("maxCanonicalPlanBytes"),
    maxStructuredResponseBytes: value("maxStructuredResponseBytes"),
  });
}

export function strictLimitValue(limits: StrictLimits, id: StrictLimitId): number {
  switch (id) {
    case "planPhase.maxProviderRequests": return limits.planPhase.maxProviderRequests;
    case "planPhase.maxActiveMinutes": return limits.planPhase.maxActiveMinutes;
    case "implementationPhase.maxProviderRequests": return limits.implementationPhase.maxProviderRequests;
    case "implementationPhase.maxActiveMinutes": return limits.implementationPhase.maxActiveMinutes;
    case "implementationPhase.maxReviewCycles": return limits.implementationPhase.maxReviewCycles;
    case "implementationPhase.stallCycles": return limits.implementationPhase.stallCycles;
    case "providerRequestTimeoutMinutes": return limits.providerRequestTimeoutMinutes;
    case "maxStructuredRetries": return limits.maxStructuredRetries;
    case "maxCanonicalPlanBytes": return limits.maxCanonicalPlanBytes;
    case "maxStructuredResponseBytes": return limits.maxStructuredResponseBytes;
    case "scan.maxScannedFiles": return STRICT_SCAN_CAPS.maxScannedFiles;
    case "scan.maxFileBytes": return STRICT_SCAN_CAPS.maxFileBytes;
    case "scan.maxDiffBytes": return STRICT_SCAN_CAPS.maxDiffBytes;
    case "scan.maxNewFileBytes": return STRICT_SCAN_CAPS.maxNewFileBytes;
  }
}

export function strictLimitUnit(id: StrictLimitId): StrictLimitUnit {
  if (id in STRICT_LIMIT_RANGES) return STRICT_LIMIT_RANGES[id as StrictConfigurableLimitId].unit;
  return id === "scan.maxScannedFiles" ? "files" : "bytes";
}

/** Returns new frozen limits with one ceiling replaced, validated against its range. */
export function withStrictLimit(limits: StrictLimits, id: StrictConfigurableLimitId, value: number): StrictLimits {
  const overrides: StrictLimitOverrides = {};
  for (const current of CONFIGURABLE_LIMIT_IDS) overrides[current] = strictLimitValue(limits, current);
  overrides[id] = value;
  return resolveStrictLimits(overrides);
}
