import { describe, expect, it } from "vitest";
import {
  OUTCOMES,
  PIPELINE_STAGES,
  REASON_CODES,
  RISK_LEVELS,
  RISK_RANK,
} from "./core.js";

// FR-007, FR-014: the shared vocabulary is a fixed contract. The tests pin the exact
// members and their order so a silent edit (a renamed reason, a re-ordered risk scale, an
// added outcome) is caught in CI rather than silently changing policy.

describe("RISK_LEVELS (FR-007)", () => {
  it("is exactly SAFE, LOW, MEDIUM, HIGH, CRITICAL, FORBIDDEN in order", () => {
    expect(RISK_LEVELS).toEqual(["SAFE", "LOW", "MEDIUM", "HIGH", "CRITICAL", "FORBIDDEN"]);
  });

  it("has no duplicates and exactly six members", () => {
    expect(RISK_LEVELS.length).toBe(6);
    expect(new Set(RISK_LEVELS).size).toBe(6);
  });
});

describe("RISK_RANK", () => {
  it("orders SAFE(0) through FORBIDDEN(5) strictly monotonically", () => {
    const sorted = [...RISK_LEVELS].sort((a, b) => RISK_RANK[a] - RISK_RANK[b]);
    expect(sorted).toEqual(["SAFE", "LOW", "MEDIUM", "HIGH", "CRITICAL", "FORBIDDEN"]);
  });

  it("assigns a distinct integer rank to every level", () => {
    const ranks = Object.values(RISK_RANK);
    expect(ranks.length).toBe(RISK_LEVELS.length);
    expect(new Set(ranks).size).toBe(RISK_LEVELS.length);
    // FORBIDDEN is the highest rank so "at least X" comparisons include it.
    expect(RISK_RANK.FORBIDDEN).toBeGreaterThan(RISK_RANK.CRITICAL);
    expect(RISK_RANK.SAFE).toBe(0);
  });
});

describe("OUTCOMES (FR-014)", () => {
  it("is exactly the seven gateway outcomes", () => {
    expect(OUTCOMES).toEqual([
      "ALLOWED",
      "DENIED",
      "REQUIRES_CONFIRMATION",
      "INVALID_ACTION",
      "INVALID_PARAMETERS",
      "UNAUTHORIZED",
      "FORBIDDEN_POLICY",
    ]);
    expect(OUTCOMES.length).toBe(7);
  });
});

describe("REASON_CODES", () => {
  it("has no duplicates", () => {
    expect(new Set(REASON_CODES).size).toBe(REASON_CODES.length);
  });

  it("starts with the sentinel 'allowed'", () => {
    expect(REASON_CODES[0]).toBe("allowed");
  });

  it("covers the fail-closed infrastructure codes", () => {
    for (const code of [
      "unknown_action",
      "replayed_request",
      "audit_unavailable",
      "state_unavailable",
      "internal_error",
    ]) {
      expect(REASON_CODES).toContain(code);
    }
  });
});

describe("PIPELINE_STAGES", () => {
  it("is the ordered pipeline from context to execute", () => {
    expect(PIPELINE_STAGES).toEqual([
      "context",
      "intake",
      "rate_limit",
      "replay",
      "resolve",
      "validate",
      "authorize",
      "risk",
      "confirmation",
      "audit",
      "execute",
    ]);
  });

  it("starts at 'context' and ends at 'execute'", () => {
    expect(PIPELINE_STAGES[0]).toBe("context");
    expect(PIPELINE_STAGES[PIPELINE_STAGES.length - 1]).toBe("execute");
  });
});
