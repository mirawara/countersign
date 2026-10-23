import { StrictPhase, StrictPhaseBudget } from "../shared/strict";
import { StrictLimitBreach, StrictLimitId, StrictLimits } from "../shared/strictLimits";

/** Monotonic active time plus calendar time; both injectable so tests do not sleep. */
export interface StrictClock {
  monotonicMs(): number;
  calendarMs(): number;
}

export const systemStrictClock: StrictClock = {
  monotonicMs: () => Number(process.hrtime.bigint() / 1_000_000n),
  calendarMs: () => Date.now(),
};

export class StrictLimitReachedError extends Error {
  constructor(readonly breach: StrictLimitBreach) {
    super(`Strict limit ${breach.limit} reached: ${breach.observed} of ${breach.configured} ${breach.unit}.`);
    this.name = "StrictLimitReachedError";
  }
}

/**
 * The time ceiling is the operating limit and the request ceiling is an independent
 * backstop, not a promise that every request may be spent. Active time accrues only
 * while the task works: it stops for a human approval, for an unanswered question and
 * for a pause. Calendar time keeps running and is reported, never spent.
 */
export class StrictBudgetTracker {
  private activeSince: number | undefined;
  private accumulatedActiveMs = 0;
  private providerRequests = 0;
  private reviewCycles = 0;
  private readonly startedAtMonotonic: number;

  constructor(
    private readonly phase: StrictPhase,
    private readonly limits: StrictLimits,
    private readonly clock: StrictClock = systemStrictClock,
  ) {
    this.startedAtMonotonic = clock.monotonicMs();
  }

  resume(): void {
    this.activeSince ??= this.clock.monotonicMs();
  }

  suspend(): void {
    if (this.activeSince === undefined) return;
    this.accumulatedActiveMs += this.clock.monotonicMs() - this.activeSince;
    this.activeSince = undefined;
  }

  get activeMs(): number {
    return this.accumulatedActiveMs + (this.activeSince === undefined ? 0 : this.clock.monotonicMs() - this.activeSince);
  }

  get wallClockMs(): number {
    return this.clock.monotonicMs() - this.startedAtMonotonic;
  }

  get maxActiveMs(): number {
    return this.phaseLimits().maxActiveMinutes * 60_000;
  }

  remainingActiveMs(): number {
    return Math.max(0, this.maxActiveMs - this.activeMs);
  }

  /** Throws when the phase has no active time left. */
  assertActiveTimeRemaining(): void {
    if (this.remainingActiveMs() > 0) return;
    throw this.phaseActiveLimitError();
  }

  /** Also used when an in-flight provider request consumes the last active seconds. */
  phaseActiveLimitError(): StrictLimitReachedError {
    return new StrictLimitReachedError({
      limit: this.limitId("maxActiveMinutes"),
      phase: this.phase,
      configured: this.phaseLimits().maxActiveMinutes,
      observed: Math.max(this.phaseLimits().maxActiveMinutes, Math.round(this.activeMs / 60_000)),
      unit: "minutes",
    });
  }

  /** Counts one provider request, retries included, before it is sent. */
  countProviderRequest(): void {
    const max = this.phaseLimits().maxProviderRequests;
    if (this.providerRequests >= max) {
      throw new StrictLimitReachedError({
        limit: this.limitId("maxProviderRequests"),
        phase: this.phase,
        configured: max,
        observed: this.providerRequests,
        unit: "requests",
      });
    }
    this.providerRequests += 1;
  }

  /** One completed review cycle; the ceiling itself is enforced by the phase protocol. */
  countReviewCycle(): void {
    this.reviewCycles += 1;
  }

  /**
   * A single request may never extend the phase: its deadline is the smaller of the
   * per-request timeout and the active time still left.
   */
  requestTimeoutMs(): number {
    this.assertActiveTimeRemaining();
    return Math.min(this.limits.providerRequestTimeoutMinutes * 60_000, this.remainingActiveMs());
  }

  snapshot(): StrictPhaseBudget {
    return {
      providerRequests: this.providerRequests,
      activeMs: this.activeMs,
      wallClockMs: this.wallClockMs,
      ...(this.phase === "implementation" ? { reviewCycles: this.reviewCycles } : {}),
    };
  }

  private phaseLimits(): { maxProviderRequests: number; maxActiveMinutes: number } {
    return this.phase === "plan" ? this.limits.planPhase : this.limits.implementationPhase;
  }

  private limitId(suffix: "maxProviderRequests" | "maxActiveMinutes"): StrictLimitId {
    return `${this.phase === "plan" ? "planPhase" : "implementationPhase"}.${suffix}` as StrictLimitId;
  }
}
