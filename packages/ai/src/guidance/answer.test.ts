import { describe, expect, it } from "vitest";
import { groundDecision } from "./answer.js";

// The end-to-end answer path (retrieval, one model call, grounding against the chunks actually supplied) is tested through the service: service.test.ts.
describe("groundDecision: the grounding rule, pure and total over the four kinds", () => {
  const supplied = [{ id: "a.1", docId: "a", title: "A" }, { id: "a.2", docId: "a", title: "A" }, { id: "b.1", docId: "b", title: "B" }];
  it("an answer citing supplied chunks becomes sources {id: docId, title} from the trusted chunks, deduplicated by document, in order of first citation", () => {
    expect(groundDecision({ kind: "answer", answer: "x", sources: ["b.1", "a.1", "a.2"] }, supplied)).toEqual({ kind: "answer", answer: "x", sources: [{ id: "b", title: "B" }, { id: "a", title: "A" }] });
  });
  it("an answer citing nothing, an invented id, or one real and one invented id is ungrounded", () => {
    expect(groundDecision({ kind: "answer", answer: "x", sources: [] }, supplied)).toMatchObject({ kind: "unsupported", reason: "ungrounded" });
    expect(groundDecision({ kind: "answer", answer: "x", sources: ["invented.1"] }, supplied)).toMatchObject({ reason: "ungrounded" });
    expect(groundDecision({ kind: "answer", answer: "x", sources: ["a.1", "invented.1"] }, supplied)).toMatchObject({ reason: "ungrounded" });
  });
  it("with no supplied chunks no answer can be grounded", () => {
    expect(groundDecision({ kind: "answer", answer: "x", sources: ["a.1"] }, [])).toMatchObject({ reason: "ungrounded" });
    expect(groundDecision({ kind: "answer", answer: "x", sources: [] }, [])).toMatchObject({ reason: "ungrounded" });
  });
  it("a prototype-key source id is not found (Map lookup)", () => {
    expect(groundDecision({ kind: "answer", answer: "x", sources: ["__proto__"] }, supplied)).toMatchObject({ reason: "ungrounded" });
    expect(groundDecision({ kind: "answer", answer: "x", sources: ["constructor"] }, supplied)).toMatchObject({ reason: "ungrounded" });
  });
  it("clarify passes its validated message through; unsupported becomes the fixed message, never model text", () => {
    expect(groundDecision({ kind: "clarify", message: "Which page?" }, supplied)).toEqual({ kind: "clarify", message: "Which page?" });
    const unsupported = groundDecision({ kind: "unsupported", message: "SECRET-MODEL-TEXT" }, supplied);
    expect(unsupported).toMatchObject({ kind: "unsupported", reason: "unsupported_request" });
    expect(JSON.stringify(unsupported)).not.toContain("SECRET-MODEL-TEXT");
  });
  it("results are frozen", () => {
    expect(Object.isFrozen(groundDecision({ kind: "answer", answer: "x", sources: ["a.1"] }, supplied))).toBe(true);
  });
});
