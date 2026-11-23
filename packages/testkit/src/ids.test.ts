import { describe, expect, it } from "vitest";
import { IdGenerator } from "./ids.js";

// T027: seeded deterministic IdGenerator. Same seed => identical sequence,
// different seed => different sequence. Deterministic — no crypto, no Date, no Math.random.
const UUID_V4_SHAPE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("seeded IdGenerator", () => {
  it("same seed produces identical sequences", () => {
    const a = new IdGenerator(42);
    const b = new IdGenerator(42);
    for (let i = 0; i < 50; i++) {
      expect(a.newConfirmationId()).toBe(b.newConfirmationId());
    }
    expect(a.newDecisionId()).toBe(b.newDecisionId());
  });

  it("different seeds produce different sequences", () => {
    const a = new IdGenerator(42);
    const b = new IdGenerator(43);
    let identical = 0;
    for (let i = 0; i < 20; i++) {
      if (a.newConfirmationId() === b.newConfirmationId()) identical++;
    }
    expect(identical).toBe(0);
    expect(a.newDecisionId()).not.toBe(b.newDecisionId());
  });

  it("confirmation ids are UUID-v4 shaped (36 chars, version and variant nibbles)", () => {
    const generator = new IdGenerator(7);
    for (let i = 0; i < 100; i++) {
      const id = generator.newConfirmationId();
      expect(id).toHaveLength(36);
      expect(id).toMatch(UUID_V4_SHAPE);
    }
  });

  it("all ids are unique within a run of 10,000", () => {
    const generator = new IdGenerator(1234);
    const confirmationIds = new Set<string>();
    const decisionIds = new Set<string>();
    for (let i = 0; i < 10_000; i++) {
      confirmationIds.add(generator.newConfirmationId());
      decisionIds.add(generator.newDecisionId());
    }
    expect(confirmationIds.size).toBe(10_000);
    expect(decisionIds.size).toBe(10_000);
  });
});
