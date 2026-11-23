import { describe, expect, it } from "vitest";
import { DEFAULT_FAKE_EPOCH, FakeClock } from "./clock.js";

// T027: FakeClock is fully deterministic — it starts at a fixed instant and never reads
// the real clock.
describe("FakeClock", () => {
  it("starts at the fixed default instant", () => {
    expect(DEFAULT_FAKE_EPOCH).toBe("2026-01-01T00:00:00Z");
    expect(new FakeClock().now()).toBe("2026-01-01T00:00:00.000Z");
  });

  it("starts at a constructor-provided instant", () => {
    expect(new FakeClock("2026-02-03T04:05:06Z").now()).toBe("2026-02-03T04:05:06.000Z");
  });

  it("advances by whole and fractional seconds", () => {
    const clock = new FakeClock();
    clock.advance(90);
    expect(clock.now()).toBe("2026-01-01T00:01:30.000Z");
    clock.advance(0.5);
    expect(clock.now()).toBe("2026-01-01T00:01:30.500Z");
  });

  it("rejects negative, NaN, Infinity and non-number arguments without moving", () => {
    const clock = new FakeClock();
    const bad: unknown[] = [-1, -Infinity, NaN, Infinity, "5", null, undefined, { seconds: 5 }];
    for (const value of bad) {
      expect(() => clock.advance(value as number)).toThrow(RangeError);
    }
    expect(clock.now()).toBe("2026-01-01T00:00:00.000Z");
  });

  it("rejects an invalid start instant", () => {
    expect(() => new FakeClock("not a date")).toThrow(RangeError);
  });
});
