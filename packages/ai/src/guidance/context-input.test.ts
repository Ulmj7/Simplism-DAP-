import { describe, expect, it } from "vitest";
import { parseSemanticContextInput } from "./context-input.js";

const element = (n: number, over: Record<string, unknown> = {}) => ({ id: `profile.field${n}`, role: "textbox", label: `Field ${n}`, description: `The field number ${n}`, privacy: "public", available: true, ...over });
const valid = () => ({ route: "profile", elements: [element(1), element(2, { privacy: "private", available: false }), element(3, { privacy: "redact" })] });
const BEL = String.fromCharCode(7);

describe("parseSemanticContextInput: valid input", () => {
  it("accepts a valid context and returns a deeply frozen, equal copy", () => {
    const input = valid();
    const out = parseSemanticContextInput(input);
    expect(out).toEqual(valid());
    expect(out).not.toBe(input);
    expect(Object.isFrozen(out)).toBe(true);
    expect(Object.isFrozen(out!.elements)).toBe(true);
    expect(Object.isFrozen(out!.elements[0])).toBe(true);
  });
  it("accepts every role and privacy value, no elements, and exactly 60 elements", () => {
    for (const role of ["button", "link", "textbox", "checkbox", "select", "panel", "nav", "heading", "text"]) expect(parseSemanticContextInput({ route: "profile", elements: [element(1, { role })] })).not.toBeNull();
    for (const privacy of ["public", "private", "redact"]) expect(parseSemanticContextInput({ route: "profile", elements: [element(1, { privacy })] })).not.toBeNull();
    expect(parseSemanticContextInput({ route: "profile", elements: [] })).not.toBeNull();
    expect(parseSemanticContextInput({ route: "profile", elements: Array.from({ length: 60 }, (_v, i) => element(i)) })).not.toBeNull();
  });
  it("accepts the empty route that Feature 002 reports for an unknown page, only with no elements", () => {
    expect(parseSemanticContextInput({ route: "", elements: [] })).toEqual({ route: "", elements: [] });
    expect(parseSemanticContextInput({ route: "", elements: [element(1)] })).toBeNull();
  });
  it("never adds data: the output has exactly the input's keys", () => {
    const out = parseSemanticContextInput(valid())!;
    expect(Object.keys(out)).toEqual(["route", "elements"]);
    expect(Object.keys(out.elements[0]!).sort()).toEqual(["available", "description", "id", "label", "privacy", "role"]);
  });
  it("does not change the input", () => {
    const input = valid();
    const before = JSON.stringify(input);
    parseSemanticContextInput(input);
    expect(JSON.stringify(input)).toBe(before);
    expect(Object.isFrozen(input)).toBe(false);
  });
});

describe("parseSemanticContextInput: refusals", () => {
  const cases: readonly [string, unknown][] = [
    ["null", null], ["a string", "profile"], ["an array", []], ["a number", 5], ["undefined", undefined],
    ["an unknown key on the context", { ...valid(), html: "<div>" }],
    ["a missing route", { elements: [] }],
    ["a missing elements list", { route: "profile" }],
    ["a malformed route", { ...valid(), route: "Profile Page" }],
    ["a route over 64", { ...valid(), route: "r".repeat(65) }],
    ["an unknown key on an element", { route: "profile", elements: [element(1, { value: "Ada" })] }],
    ["a text key on an element", { route: "profile", elements: [element(1, { text: "Ada" })] }],
    ["an attribute bag", { route: "profile", elements: [element(1, { attributes: { id: "x" } })] }],
    ["a missing element field", { route: "profile", elements: [{ id: "profile.a", role: "button", label: "A", description: "B", privacy: "public" }] }],
    ["an unknown role", { route: "profile", elements: [element(1, { role: "script" })] }],
    ["an unknown privacy", { route: "profile", elements: [element(1, { privacy: "internal" })] }],
    ["a string available", { route: "profile", elements: [element(1, { available: "true" })] }],
    ["a numeric available", { route: "profile", elements: [element(1, { available: 1 })] }],
    ["a null available", { route: "profile", elements: [element(1, { available: null })] }],
    ["a malformed element id", { route: "profile", elements: [element(1, { id: "Profile Field" })] }],
    ["an element id without a dot", { route: "profile", elements: [element(1, { id: "profile" })] }],
    ["markup in a label", { route: "profile", elements: [element(1, { label: "<b>Name</b>" })] }],
    ["a quote in a description", { route: "profile", elements: [element(1, { description: `say "hi"` })] }],
    ["a control character in a label", { route: "profile", elements: [element(1, { label: `a${BEL}b` })] }],
    ["an empty label", { route: "profile", elements: [element(1, { label: "" })] }],
    ["a label over 80", { route: "profile", elements: [element(1, { label: "l".repeat(81) })] }],
    ["a description over 240", { route: "profile", elements: [element(1, { description: "d".repeat(241) })] }],
    ["61 elements", { route: "profile", elements: Array.from({ length: 61 }, (_v, i) => element(i)) }],
    ["elements that is not an array", { route: "profile", elements: { 0: element(1) } }],
  ];
  it.each(cases)("%s -> null", (_name, raw) => { expect(parseSemanticContextInput(raw)).toBeNull(); });

  it("refuses prototype keys at every level", () => {
    expect(parseSemanticContextInput(JSON.parse(`{"route":"profile","elements":[],"__proto__":{"x":1}}`))).toBeNull();
    expect(parseSemanticContextInput(JSON.parse(`{"route":"profile","elements":[{"id":"profile.a","role":"button","label":"A","description":"B","privacy":"public","available":true,"constructor":{}}]}`))).toBeNull();
    expect(parseSemanticContextInput({ route: "profile", elements: [element(1, { id: "__proto__" })] })).toBeNull();
    expect(parseSemanticContextInput({ route: "constructor".replace("c", "C"), elements: [] })).toBeNull();
  });
  it("refuses a getter, a symbol key, a class instance, a cycle and a Proxy that throws, without calling them", () => {
    let read = 0;
    expect(parseSemanticContextInput({ route: "profile", get elements() { read++; return []; } })).toBeNull();
    expect(read).toBe(0);
    expect(parseSemanticContextInput({ ...valid(), [Symbol("x")]: 1 })).toBeNull();
    class Ctx { route = "profile"; elements: unknown[] = []; }
    expect(parseSemanticContextInput(new Ctx())).toBeNull();
    const cyclic: Record<string, unknown> = { route: "profile", elements: [] };
    (cyclic.elements as unknown[]).push(cyclic);
    expect(parseSemanticContextInput(cyclic)).toBeNull();
    const hostile = new Proxy({}, { ownKeys() { throw new Error("secret trap text"); }, getPrototypeOf() { throw new Error("secret trap text"); } });
    expect(parseSemanticContextInput(hostile)).toBeNull();
  });
  it("refuses an enormous value without trouble, and never throws", () => {
    expect(parseSemanticContextInput({ route: "profile", elements: Array.from({ length: 5000 }, (_v, i) => element(i)) })).toBeNull();
    expect(parseSemanticContextInput({ route: "x".repeat(10_000_000), elements: [] })).toBeNull();
    expect(() => parseSemanticContextInput(Object.create(null))).not.toThrow();
  });
});
