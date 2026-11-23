import { describe, expect, it } from "vitest";
import { WALKTHROUGH_ID, isId } from "./text.js";
import { parseGuidanceDecision } from "./decision.js";
import { parseGuidanceModelRequest } from "./request.js";
import { parseCatalogSummaries, validateProposedWalkthrough } from "./selection.js";

// The ONE walkthrough id grammar: exactly Feature 002's ID_GRAMMAR. Its agreement with the real catalog is tested in tests/integration/guidance-context-contract.test.ts.
const OK = ["profileUpdate", "find-security", "find_two_factor", "a", "A", "a-", "a_", "a1-b_2", "a".repeat(64), "Z".repeat(64), "a-".repeat(32)];
const BAD = [
  "", "a".repeat(65), "1abc", "9", "_abc", "-abc", " abc", "abc ", "ab c", "abc\n", "\tabc", "a.b", "a/b", "a\\b", "a:b", "a@b", "a\u0000b",
  "caf\u00e9", "\u0430bc" /* Cyrillic a */, "ab\u0441" /* Cyrillic s */, "\uff41bc" /* full-width a */, "abc\u200b", "a\u2010b" /* Unicode hyphen */, "\u{1d41a}bc",
];
const summary = (id: string) => ({ id, title: "T", description: "D" });
const request = (id: string) => ({ input: { query: "q", semanticContext: { route: "", elements: [] }, walkthroughSummaries: [summary(id)], sources: [] }, maxOutputChars: 10 });

describe("WALKTHROUGH_ID: Feature 002's grammar, defined once", () => {
  it("is exactly /^[a-zA-Z][A-Za-z0-9_-]{0,63}$/", () => { expect(WALKTHROUGH_ID.source).toBe("^[a-zA-Z][A-Za-z0-9_-]{0,63}$"); expect(WALKTHROUGH_ID.flags).toBe(""); });
  it.each(OK)("accepts %j everywhere an id is validated (decision, request summary, catalog parse, exact match)", (id) => {
    expect(isId(id, WALKTHROUGH_ID)).toBe(true);
    expect(parseGuidanceDecision({ kind: "start_walkthrough", walkthroughId: id })).toEqual({ kind: "start_walkthrough", walkthroughId: id });
    expect(parseGuidanceModelRequest(request(id)).ok).toBe(true);
    expect(parseCatalogSummaries([summary(id)])).toEqual([summary(id)]);
    expect(validateProposedWalkthrough([summary(id)], id)).toEqual(summary(id));
  });
  it.each(BAD)("refuses %j everywhere an id is validated", (id) => {
    expect(isId(id, WALKTHROUGH_ID)).toBe(false);
    expect(parseGuidanceDecision({ kind: "start_walkthrough", walkthroughId: id })).toBeNull();
    expect(parseGuidanceModelRequest(request(id)).ok).toBe(false);
    expect(parseCatalogSummaries([summary(id)])).toBeNull();
  });
  it("prototype names are refused although they match the pattern, and an exact match never finds them", () => {
    for (const id of ["__proto__", "constructor", "prototype", "toString", "hasOwnProperty", "valueOf"]) {
      expect(isId(id, WALKTHROUGH_ID)).toBe(false);
      expect(parseGuidanceDecision({ kind: "start_walkthrough", walkthroughId: id })).toBeNull();
      expect(parseCatalogSummaries([summary(id)])).toBeNull();
      expect(validateProposedWalkthrough([summary("find-security")], id)).toBeNull();
    }
  });
  it("whitespace and case variants of a hyphenated id never match it", () => {
    const list = [summary("find-security")];
    for (const id of [" find-security", "find-security ", "Find-Security", "find_security", "findsecurity", "find\u2010security"]) expect(validateProposedWalkthrough(list, id)).toBeNull();
  });
});
