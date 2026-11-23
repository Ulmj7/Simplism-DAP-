import { describe, expect, it } from "vitest";
import { unsupportedResult } from "./result.js";
import { GUIDANCE_REASONS } from "./types.js";

describe("unsupportedResult", () => {
  it("has the closed reason list of the plan", () => {
    expect([...GUIDANCE_REASONS]).toEqual(["query_invalid", "context_invalid", "model_unavailable", "invalid_model_output", "unknown_walkthrough", "ungrounded", "not_permitted", "unavailable", "unsupported_request"]);
  });
  it.each(GUIDANCE_REASONS)("%s gives a fixed, generic, frozen message", (reason) => {
    const result = unsupportedResult(reason);
    expect(result).toEqual({ kind: "unsupported", message: expect.any(String), reason });
    expect(result.message.length).toBeGreaterThan(5);
    expect(Object.isFrozen(result)).toBe(true);
    expect(unsupportedResult(reason).message).toBe(result.message); // a constant per reason
    expect(result.message).not.toMatch(/[<>&"'`]|error|stack|exception|undefined/i);
  });
  it("anything that is not a known reason becomes unsupported_request, and no input text can reach the message", () => {
    for (const reason of ["boom: sk-SECRET", "", undefined, null, 5, {}] as const) {
      const result = unsupportedResult(reason as never);
      expect(result.reason).toBe("unsupported_request");
      expect(JSON.stringify(result)).not.toContain("SECRET");
    }
  });
});
