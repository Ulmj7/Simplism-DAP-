import { describe, expect, it } from "vitest";
import { parseGuidanceDecision } from "./decision.js";

const ok = { kind: "start_walkthrough", walkthroughId: "profileUpdate" };
const CTRL = String.fromCharCode(7);
const BIDI = String.fromCharCode(0x202e);

describe("the four valid kinds", () => {
  it.each([
    [{ kind: "start_walkthrough", walkthroughId: "profileUpdate" }],
    [{ kind: "answer", answer: "Two-factor authentication adds a second step when you sign in.", sources: ["kb-2fa", "kb.security_1"] }],
    [{ kind: "answer", answer: "A short answer.", sources: [] }],
    [{ kind: "clarify", message: "Do you mean the profile page or the settings page?" }],
    [{ kind: "unsupported", message: "I can only help with the product." }],
  ])("%j is accepted, returned as a frozen copy", (raw) => {
    const decision = parseGuidanceDecision(raw);
    expect(decision).toEqual(raw);
    expect(decision).not.toBe(raw);
    expect(Object.isFrozen(decision)).toBe(true);
  });
  it("accepts the length boundaries: answer 1200, message 300, 4 sources, a 64-character walkthrough id", () => {
    expect(parseGuidanceDecision({ kind: "answer", answer: "a".repeat(1200), sources: ["s1", "s2", "s3", "s4"] })).not.toBeNull();
    expect(parseGuidanceDecision({ kind: "clarify", message: "m".repeat(300) })).not.toBeNull();
    expect(parseGuidanceDecision({ kind: "start_walkthrough", walkthroughId: "A" + "b".repeat(63) })).not.toBeNull();
  });
});

describe("what is rejected (nothing is repaired)", () => {
  it.each([
    ["the order's example: confirmed true on a start", { kind: "start_walkthrough", walkthroughId: "profileUpdate", confirmed: true }],
    ["the order's example: kind execute", { kind: "execute", action: "deleteEverything" }],
    ["the order's example: no kind", { walkthroughId: "profileUpdate" }],
    ["a missing kind on an otherwise valid answer", { answer: "x", sources: [] }],
    ["an unknown kind", { kind: "run", walkthroughId: "profileUpdate" }],
    ["a kind in the wrong case", { kind: "Answer", answer: "x", sources: [] }],
    ["a non-string kind", { kind: 1 }],
    ["a bad id with a space and a bang", { kind: "start_walkthrough", walkthroughId: "bad id!" }],
    ["an id that starts with a digit", { kind: "start_walkthrough", walkthroughId: "1profile" }],
    ["an id with a dot", { kind: "start_walkthrough", walkthroughId: "profile.update" }],
    ["an id of 65 characters", { kind: "start_walkthrough", walkthroughId: "A" + "b".repeat(64) }],
    ["an empty id", { kind: "start_walkthrough", walkthroughId: "" }],
    ["a non-string id", { kind: "start_walkthrough", walkthroughId: 5 }],
    ["a missing id", { kind: "start_walkthrough" }],
    ["trailing whitespace on an id (not trimmed into validity)", { kind: "start_walkthrough", walkthroughId: "profileUpdate " }],
    ["a newline in an id", { kind: "start_walkthrough", walkthroughId: "profileUpdate\n" }],
    ["constructor as an id", { kind: "start_walkthrough", walkthroughId: "constructor" }],
    ["prototype as an id", { kind: "start_walkthrough", walkthroughId: "prototype" }],
    ["toString as an id", { kind: "start_walkthrough", walkthroughId: "toString" }],
    ["__proto__ as an id", { kind: "start_walkthrough", walkthroughId: "__proto__" }],
    ["an answer over 1200", { kind: "answer", answer: "a".repeat(1201), sources: [] }],
    ["a message over 300", { kind: "clarify", message: "m".repeat(301) }],
    ["an empty answer", { kind: "answer", answer: "", sources: [] }],
    ["a blank message", { kind: "clarify", message: "   " }],
    ["5 sources", { kind: "answer", answer: "x", sources: ["a", "b", "c", "d", "e"] }],
    ["a source id with a space", { kind: "answer", answer: "x", sources: ["bad id"] }],
    ["a non-string source id", { kind: "answer", answer: "x", sources: [1] }],
    ["sources that is not an array", { kind: "answer", answer: "x", sources: "kb" }],
    ["sources given as objects", { kind: "answer", answer: "x", sources: [{ id: "kb" }] }],
    ["missing sources", { kind: "answer", answer: "x" }],
    ["markup in an answer", { kind: "answer", answer: "Click <b>here</b>", sources: [] }],
    ["an ampersand in a message", { kind: "clarify", message: "this & that" }],
    ["a quote in a message", { kind: "clarify", message: "say 'hi'" }],
    ["a backtick in an answer", { kind: "answer", answer: "run `rm`", sources: [] }],
    ["a control character in a message", { kind: "clarify", message: `a${CTRL}b` }],
    ["a newline in an answer", { kind: "answer", answer: "line1\nline2", sources: [] }],
    ["a bidi override in a message", { kind: "clarify", message: `abc${BIDI}def` }],
    ["a prototype key (own __proto__)", JSON.parse('{"kind":"clarify","message":"hi","__proto__":{"admin":true}}')],
    ["a constructor key", { kind: "clarify", message: "hi", constructor: 1 }],
    ["a prototype key", { kind: "clarify", message: "hi", prototype: 1 }],
  ])("%s", (_name, raw) => {
    expect(parseGuidanceDecision(raw)).toBeNull();
  });
  it.each(["confirmed", "isAdmin", "selector", "script", "action", "permission", "risk", "executor", "url", "sql", "randomFieldName123"])("an extra field named %s is rejected, on every kind", (name) => {
    for (const base of [ok, { kind: "answer", answer: "x", sources: [] }, { kind: "clarify", message: "x" }, { kind: "unsupported", message: "x" }]) {
      expect(parseGuidanceDecision({ ...base, [name]: true })).toBeNull();
      expect(parseGuidanceDecision({ ...base, [name]: "value" })).toBeNull();
    }
  });
  it("a field of one kind on another kind is rejected", () => {
    expect(parseGuidanceDecision({ kind: "clarify", message: "x", walkthroughId: "profileUpdate" })).toBeNull();
    expect(parseGuidanceDecision({ kind: "start_walkthrough", walkthroughId: "profileUpdate", answer: "x" })).toBeNull();
  });
  it.each([null, undefined, "start_walkthrough", 5, true, [], [ok], () => ok, Symbol("s"), 10n])("a non-object (%s) is rejected", (raw) => {
    expect(parseGuidanceDecision(raw)).toBeNull();
  });
  it("an unparsed JSON string is not repaired into a decision", () => {
    expect(parseGuidanceDecision(JSON.stringify(ok))).toBeNull();
  });
});

describe("hostile untrusted values return null, never throw, and are read once", () => {
  it("a getter is never called, even once", () => {
    let calls = 0;
    const raw = { kind: "clarify", get message() { calls++; return "hello"; } };
    expect(parseGuidanceDecision(raw)).toBeNull();
    expect(calls).toBe(0);
  });
  it("a getter that throws gives null", () => {
    expect(parseGuidanceDecision({ kind: "clarify", get message(): string { throw new Error("boom"); } })).toBeNull();
  });
  it("a value that changes between reads cannot get through: it is read exactly once", () => {
    let reads = 0;
    const raw = new Proxy({ kind: "clarify", message: "hello" }, { getOwnPropertyDescriptor(target, key) { reads++; return Reflect.getOwnPropertyDescriptor(target, key); } });
    const decision = parseGuidanceDecision(raw);
    expect(decision).toEqual({ kind: "clarify", message: "hello" });
    expect(reads).toBe(2); // one descriptor read per key, no more
  });
  it.each([
    ["a proxy whose ownKeys throws", new Proxy({}, { ownKeys() { throw new Error("boom"); } })],
    ["a proxy whose getOwnPropertyDescriptor throws", new Proxy({ kind: "clarify" }, { getOwnPropertyDescriptor() { throw new Error("boom"); } })],
    ["a proxy whose getPrototypeOf throws", new Proxy({}, { getPrototypeOf() { throw new Error("boom"); } })],
    ["a proxy that hides a getter in a descriptor", new Proxy({ kind: "clarify", message: "x" }, { getOwnPropertyDescriptor(t, k) { return k === "message" ? { configurable: true, enumerable: true, get: () => "x" } : Reflect.getOwnPropertyDescriptor(t, k); } })],
    ["a class instance", new (class Decision { kind = "clarify"; message = "hello"; })()],
    ["an object with a custom prototype", Object.create({ kind: "clarify", message: "hello" })],
    ["a symbol-keyed property", { kind: "clarify", message: "hello", [Symbol("s")]: 1 }],
    ["a non-enumerable property", Object.defineProperty({ kind: "clarify", message: "hello" }, "hidden", { value: 1, enumerable: false })],
    ["a function value", { kind: "clarify", message: () => "hello" }],
    ["a bigint value", { kind: "clarify", message: 10n }],
    ["undefined as a value", { kind: "clarify", message: undefined }],
    ["a Date", new Date(0)],
    ["a Map", new Map()],
    ["an array with an extra property", Object.assign(["a"], { x: 1 })],
    ["a sparse array in sources", { kind: "answer", answer: "x", sources: new Array(2) }],
    ["an array getter element", { kind: "answer", answer: "x", sources: Object.defineProperty([], "0", { get: () => "a", enumerable: true }) }],
  ])("%s", (_name, raw) => {
    expect(() => parseGuidanceDecision(raw)).not.toThrow();
    expect(parseGuidanceDecision(raw)).toBeNull();
  });
  it("a cyclic value, an over-deep value and an over-large value are refused", () => {
    const cyclic: Record<string, unknown> = { kind: "clarify", message: "x" };
    cyclic.self = cyclic;
    expect(parseGuidanceDecision(cyclic)).toBeNull();
    let deep: unknown = "x";
    for (let i = 0; i < 20; i++) deep = { n: deep };
    expect(parseGuidanceDecision({ kind: "clarify", message: "x", deep })).toBeNull();
    expect(parseGuidanceDecision({ kind: "answer", answer: "x", sources: Array.from({ length: 5000 }, () => "a") })).toBeNull();
    expect(parseGuidanceDecision({ kind: "clarify", message: "m".repeat(100_000) })).toBeNull();
  });
  it("never returns or throws the offending value", () => {
    const secret = "sk-SECRET-VALUE";
    let thrown: unknown;
    try { parseGuidanceDecision({ kind: "execute", secret }); } catch (error) { thrown = error; }
    expect(thrown).toBeUndefined();
    expect(JSON.stringify(parseGuidanceDecision({ kind: "execute", secret }))).toBe("null");
  });
});
