/**
 * @dap/testkit: clock.ts (T027)
 *
 * Deterministic FakeClock for tests. Starts at a fixed, constructor-provided instant and
 * NEVER reads the real clock (no Date.now, no process clock): `now()` formats the stored
 * instant and `advance(seconds)` moves it forward.
 */
import type { Clock, IsoInstant } from "@dap/contracts";

/** The fixed default start instant for FakeClock. */
export const DEFAULT_FAKE_EPOCH = "2026-01-01T00:00:00Z";

export class FakeClock implements Clock {
  private readonly startMs: number;
  private elapsedMs = 0;

  constructor(startAt: string = DEFAULT_FAKE_EPOCH) {
    const parsed = Date.parse(startAt);
    if (!Number.isFinite(parsed) || !/^\d{4}-\d{2}-\d{2}T.*(?:Z|[+-]\d{2}:\d{2})$/.test(startAt)) {
      throw new RangeError(`FakeClock: invalid start instant: ${String(startAt)}`);
    }
    this.startMs = parsed;
  }

  /** The current fake instant, as ISO 8601 UTC. */
  now(): IsoInstant {
    return new Date(this.startMs + this.elapsedMs).toISOString() as IsoInstant;
  }

  /**
   * Move the clock forward by `seconds`. Throws RangeError for negative, NaN, Infinity
   * (either sign), or any non-number.
   */
  advance(seconds: number): void {
    if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) {
      throw new RangeError(
        `FakeClock: advance() requires a finite, non-negative number of seconds, got: ${String(seconds)}`,
      );
    }
    const elapsed = this.elapsedMs + seconds * 1000;
    const next = this.startMs + elapsed;
    if (!Number.isFinite(next) || Math.abs(next) > 8.64e15) throw new RangeError("FakeClock: advance exceeds the date range");
    this.elapsedMs = elapsed;
  }
}
