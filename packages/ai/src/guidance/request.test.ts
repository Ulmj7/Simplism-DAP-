import { describe, expect, it } from "vitest";
import { parseGuidanceModelRequest } from "./request.js";

const element = (n: number, over: Record<string, unknown> = {}) => ({ id: `profile.field${n}`, role: "textbox", label: `Field ${n}`, description: `The field number ${n}`, privacy: "public", available: true, ...over });
const base = () => ({
  input: {
    query: "How do I change my name?",
    semanticContext: { route: "profile", elements: [element(1), element(2, { privacy: "private", available: false })] },
    walkthroughSummaries: [{ id: "profileUpdate", title: "Update your profile", description: "Change your name and save" }],
    sources: [] as unknown[],
  },
  maxOutputChars: 1200,
});
const withInput = (patch: Record<string, unknown>) => ({ ...base(), input: { ...base().input, ...patch } });
const withContext = (patch: Record<string, unknown>) => withInput({ semanticContext: { ...base().input.semanticContext, ...patch } });
const reason = (raw: unknown) => { const r = parseGuidanceModelRequest(raw); return r.ok ? "ok" : r.reason; };

describe("a valid request", () => {
  it("is accepted and returned as a deeply frozen copy", () => {
    const parsed = parseGuidanceModelRequest(base());
    expect(parsed.ok).toBe(true);
    if (!parsed.ok) return;
    expect(parsed.request).toEqual(base());
    expect(parsed.request).not.toBe(base());
    expect(Object.isFrozen(parsed.request)).toBe(true);
    expect(Object.isFrozen(parsed.request.input.semanticContext.elements[0])).toBe(true);
  });
  it("accepts retrieved sources with their text", () => {
    const sources = [{ id: "kb-2fa", title: "Two-factor", text: "It's a second step; \"codes\" & more are fine in document text." }];
    expect(reason(withInput({ sources }))).toBe("ok");
  });
});

describe("the query is bounded", () => {
  it.each([
    ["empty", ""], ["blank", "   "], ["501 characters", "q".repeat(501)], ["a control character", `a${String.fromCharCode(7)}b`], ["a newline", "line1\nline2"],
    ["a bidi override", `x${String.fromCharCode(0x202e)}y`], ["a number", 5], ["an object", { text: "x" }], ["null", null],
  ])("%s -> query_invalid", (_name, query) => {
    expect(reason(withInput({ query }))).toBe("query_invalid");
  });
  it("exactly 500 characters, and quotes and apostrophes in a question, are accepted", () => {
    expect(reason(withInput({ query: "q".repeat(500) }))).toBe("ok");
    expect(reason(withInput({ query: `What's "two-factor" & why?` }))).toBe("ok");
  });
  it("a missing query is query_invalid; no structure at all, or an undefined value anywhere, is context_invalid", () => {
    expect(reason({ input: {}, maxOutputChars: 1 })).toBe("query_invalid");
    expect(reason(withInput({ query: undefined }))).toBe("context_invalid");
    expect(reason({ maxOutputChars: 1 })).toBe("context_invalid");
    expect(reason(null)).toBe("context_invalid");
    expect(reason("query")).toBe("context_invalid");
  });
});

describe("the semantic context is bounded and strict", () => {
  it.each([
    ["an unknown key on the context", withContext({ html: "<div>" })],
    ["a value on an element", withContext({ elements: [element(1, { value: "Ada" })] })],
    ["text on an element", withContext({ elements: [element(1, { text: "Ada" })] })],
    ["an attribute bag on an element", withContext({ elements: [element(1, { attributes: { id: "x" } })] })],
    ["markup in a label", withContext({ elements: [element(1, { label: "<b>Name</b>" })] })],
    ["an ampersand in a description", withContext({ elements: [element(1, { description: "a & b" })] })],
    ["a quote in a label", withContext({ elements: [element(1, { label: 'say "hi"' })] })],
    ["a label over 80", withContext({ elements: [element(1, { label: "l".repeat(81) })] })],
    ["a description over 240", withContext({ elements: [element(1, { description: "d".repeat(241) })] })],
    ["an empty label", withContext({ elements: [element(1, { label: "" })] })],
    ["a non-boolean available", withContext({ elements: [element(1, { available: "yes" })] })],
    ["a missing available", withContext({ elements: [element(1, { available: undefined })] })],
    ["an unknown role (password)", withContext({ elements: [element(1, { role: "password" })] })],
    ["an unknown privacy", withContext({ elements: [element(1, { privacy: "secret" })] })],
    ["a malformed element id", withContext({ elements: [element(1, { id: "Profile Field" })] })],
    ["a prototype-name element id", withContext({ elements: [element(1, { id: "constructor" })] })],
    ["an element id over 128", withContext({ elements: [element(1, { id: `a.${"b".repeat(130)}` })] })],
    ["a malformed route", withContext({ route: "Profile Page" })],
    ["a route over 64", withContext({ route: "r".repeat(65) })],
    ["a missing route", withContext({ route: undefined })],
    ["61 elements", withContext({ elements: Array.from({ length: 61 }, (_, i) => element(i)) })],
    ["elements that is not an array", withContext({ elements: "none" })],
    ["a prototype key on an element", withContext({ elements: [JSON.parse(`{"id":"profile.a","role":"text","label":"L","description":"D","privacy":"public","available":true,"__proto__":{"x":1}}`)] })],
    ["a prototype key on the context", withContext(JSON.parse('{"__proto__":{"x":1}}'))],
  ])("%s -> context_invalid", (_name, raw) => {
    expect(reason(raw)).toBe("context_invalid");
  });
  it("accepts exactly 60 elements", () => {
    expect(reason(withContext({ elements: Array.from({ length: 60 }, (_, i) => element(i)) }))).toBe("ok");
  });
});

describe("summaries, sources and the output bound", () => {
  const summary = (n: number, over: Record<string, unknown> = {}) => ({ id: `walk${n}`, title: `Title ${n}`, description: `Description ${n}`, ...over });
  const source = (n: number, over: Record<string, unknown> = {}) => ({ id: `kb-${n}`, title: `Doc ${n}`, text: `Text ${n}`, ...over });
  it("accepts 20 summaries and 4 sources of 800 characters, and refuses one more of each", () => {
    expect(reason(withInput({ walkthroughSummaries: Array.from({ length: 20 }, (_, i) => summary(i)) }))).toBe("ok");
    expect(reason(withInput({ walkthroughSummaries: Array.from({ length: 21 }, (_, i) => summary(i)) }))).toBe("context_invalid");
    expect(reason(withInput({ sources: Array.from({ length: 4 }, (_, i) => source(i, { text: "t".repeat(800) })) }))).toBe("ok");
    expect(reason(withInput({ sources: Array.from({ length: 5 }, (_, i) => source(i)) }))).toBe("context_invalid");
    expect(reason(withInput({ sources: [source(1, { text: "t".repeat(801) })] }))).toBe("context_invalid");
  });
  it.each([
    ["a summary with steps (a walkthrough definition)", { walkthroughSummaries: [summary(1, { steps: [] })] }],
    ["a summary with a start step", { walkthroughSummaries: [summary(1, { start: "a1" })] }],
    ["a summary id with a dot", { walkthroughSummaries: [summary(1, { id: "a.b" })] }],
    ["a summary title with markup", { walkthroughSummaries: [summary(1, { title: "<i>x</i>" })] }],
    ["a summary description over 240", { walkthroughSummaries: [summary(1, { description: "d".repeat(241) })] }],
    ["a source id with a space", { sources: [source(1, { id: "bad id" })] }],
    ["a source with a url", { sources: [source(1, { url: "https://x" })] }],
    ["a source with a control character", { sources: [source(1, { text: `a${String.fromCharCode(0)}b` })] }],
    ["a source title with markup", { sources: [source(1, { title: "<b>x</b>" })] }],
  ])("%s -> context_invalid", (_name, patch) => {
    expect(reason(withInput(patch))).toBe("context_invalid");
  });
  it.each([0, -1, 1201, 1.5, "100", null, undefined])("maxOutputChars %s -> context_invalid", (maxOutputChars) => {
    expect(reason({ ...base(), maxOutputChars })).toBe("context_invalid");
  });
  it.each([1, 1200])("maxOutputChars %s is accepted", (maxOutputChars) => {
    expect(reason({ ...base(), maxOutputChars })).toBe("ok");
  });
});

describe("the request cannot carry authority", () => {
  it.each(["authorizationContext", "context", "token", "cookie", "cookies", "html", "attributes", "executor", "executors", "gateway", "registry", "definition", "walkthroughDefinition", "steps", "session", "headers", "userId", "tenantId", "url"])("a top-level or input key named %s is rejected", (name) => {
    expect(reason({ ...base(), [name]: "x" })).toBe("context_invalid");
    expect(reason(withInput({ [name]: { any: "thing" } }))).toBe("context_invalid");
  });
  it("a missing part is rejected", () => {
    const { input } = base();
    for (const part of ["semanticContext", "walkthroughSummaries", "sources"]) {
      const copy: Record<string, unknown> = { ...input };
      delete copy[part];
      expect(reason({ input: copy, maxOutputChars: 1200 })).toBe("context_invalid");
    }
  });
  it("hostile values are refused without throwing: getters, proxies, classes, cycles", () => {
    let reads = 0;
    const getter = { ...base(), get input(): unknown { reads++; return base().input; } };
    expect(reason(getter)).toBe("context_invalid");
    expect(reads).toBe(0);
    expect(reason(new Proxy({}, { ownKeys() { throw new Error("boom"); } }))).toBe("context_invalid");
    expect(reason(new (class R { input = base().input; maxOutputChars = 1200; })())).toBe("context_invalid");
    const cyclic: Record<string, unknown> = base();
    cyclic.self = cyclic;
    expect(reason(cyclic)).toBe("context_invalid");
  });
  it("never echoes a value in its refusal", () => {
    const result = parseGuidanceModelRequest(withInput({ query: "q".repeat(600) + "SECRET" }));
    expect(JSON.stringify(result)).not.toContain("SECRET");
    expect(result).toEqual({ ok: false, reason: "query_invalid" });
  });
});
