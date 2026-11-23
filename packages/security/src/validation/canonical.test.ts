import { describe, expect, expectTypeOf, it } from "vitest";
import type { Sha256Hex } from "@dap/contracts";
import { canonicalJson, sha256Canonical } from "./canonical.js";
import * as security from "../index.js";

describe("canonical JSON and SHA-256", () => {
  it("sorts keys recursively, including numeric-looking keys, independently of insertion order", () => {
    const left = { z: [{ b: 2, a: 1 }], "2": "two", "10": "ten", a: true };
    const right = { a: true, "10": "ten", "2": "two", z: [{ a: 1, b: 2 }] };
    const expected = '{"10":"ten","2":"two","a":true,"z":[{"a":1,"b":2}]}';
    expect(canonicalJson(left)).toBe(expected);
    expect(canonicalJson(right)).toBe(expected);
    expect(sha256Canonical(left)).toBe(sha256Canonical(right));
  });

  it.each([null, true, false, 0, 1.5, -12, Number.MAX_VALUE, "", "quotes\"\\\n\u0000", "\ud800", [], {}])(
    "encodes supported primitive/empty values: %j", (value) => {
      expect(canonicalJson(value)).toBe(JSON.stringify(value));
    },
  );

  it("preserves array order and distinguishes values and types", () => {
    expect(canonicalJson([null, true, 1, "1", { x: "y" }])).toBe('[null,true,1,"1",{"x":"y"}]');
    expect(sha256Canonical([1, 2])).not.toBe(sha256Canonical([2, 1]));
    expect(sha256Canonical(1)).not.toBe(sha256Canonical("1"));
  });

  it("accepts null-prototype data and does not mutate frozen inputs", () => {
    const input = Object.assign(Object.create(null), { b: 2, a: 1 }) as Record<string, number>;
    Object.freeze(input);
    expect(canonicalJson(input)).toBe('{"a":1,"b":2}');
    expect(Object.getPrototypeOf(input)).toBeNull();
    expect(Object.keys(input)).toEqual(["b", "a"]);
  });

  it("matches the known SHA-256 vector for '{}' and exports a branded result", () => {
    const digest = sha256Canonical({});
    expect(digest).toBe("44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a");
    expectTypeOf(digest).toEqualTypeOf<Sha256Hex>();
    expect(security.canonicalJson).toBe(canonicalJson);
    expect(security.sha256Canonical).toBe(sha256Canonical);
  });
});

describe("strict rejection instead of JSON.stringify coercion or omission", () => {
  class Instance { value = 1; }
  class ArrayInstance extends Array<number> {}
  it.each([
    ["undefined", undefined], ["NaN", NaN], ["positive infinity", Infinity],
    ["negative infinity", -Infinity], ["negative zero", -0],
    ["function", () => 1], ["symbol", Symbol("value")], ["bigint", 1n],
    ["date", new Date("2026-11-13T00:00:00Z")], ["map", new Map()], ["set", new Set()],
    ["class instance", new Instance()], ["array subclass", new ArrayInstance(1)],
    ["boxed number", new Number(1)], ["regexp", /x/], ["typed array", new Uint8Array([1])],
  ])("rejects %s at the root and nested in objects/arrays", (_name, value) => {
    for (const input of [value, { nested: value }, [value]]) {
      expect(() => canonicalJson(input)).toThrow(TypeError);
      expect(() => sha256Canonical(input)).toThrow(TypeError);
    }
  });

  it.each(["__proto__", "prototype", "constructor"])("rejects the own key %s at every depth", (key) => {
    const input: unknown = JSON.parse(`{"${key}":1}`);
    expect(() => canonicalJson(input)).toThrow(TypeError);
    expect(() => canonicalJson({ nested: [input] })).toThrow(TypeError);
  });

  it("rejects symbol keys, hidden properties, sparse arrays, and extra array properties", () => {
    const hidden = Object.defineProperty({}, "hidden", { value: 1 });
    const extra = Object.assign([1], { extra: 2 });
    const symbolicArray = Object.assign([1], { [Symbol("extra")]: 2 });
    for (const input of [{ [Symbol("key")]: 1 }, hidden, Array(2), extra, symbolicArray]) {
      expect(() => canonicalJson(input)).toThrow(TypeError);
    }
  });

  it("rejects direct, indirect, and array cycles but accepts shared acyclic references", () => {
    const direct: Record<string, unknown> = {};
    direct.self = direct;
    const child: Record<string, unknown> = {};
    const indirect = { child };
    child.parent = indirect;
    const array: unknown[] = [];
    array.push(array);
    for (const input of [direct, indirect, array]) expect(() => canonicalJson(input)).toThrow(TypeError);
    const shared = { value: 1 };
    expect(canonicalJson([shared, shared])).toBe('[{"value":1},{"value":1}]');
  });

  it("never calls a toJSON hook to convert unsupported data", () => {
    let calls = 0;
    const input = { toJSON() { calls += 1; return "replacement"; } };
    expect(() => canonicalJson(input)).toThrow(TypeError);
    expect(calls).toBe(0);
  });
});

describe("one snapshot of each input object per invocation", () => {
  it("reads a shared getter once and reuses its captured value", () => {
    let reads = 0;
    const shared = { get value() { reads += 1; return reads; } };
    expect(canonicalJson({ b: shared, a: shared })).toBe('{"a":{"value":1},"b":{"value":1}}');
    expect(reads).toBe(1);
  });

  it("reads Proxy properties once without toJSON, including shared array length and indices", () => {
    for (const target of [{ b: 2, a: 1 }, [1, 2]]) {
      const reads = new Map<PropertyKey, number>();
      let enumerations = 0;
      const proxy = new Proxy(target, {
        ownKeys(value) { enumerations += 1; return Reflect.ownKeys(value); },
        get(value, key) { reads.set(key, (reads.get(key) ?? 0) + 1); return Reflect.get(value, key); },
      });
      const text = Array.isArray(target) ? "[1,2]" : '{"a":1,"b":2}';
      expect(canonicalJson([proxy, proxy])).toBe(`[${text},${text}]`);
      expect(enumerations).toBe(1);
      expect(reads.has("toJSON")).toBe(false);
      expect([...reads.values()].every((count) => count === 1)).toBe(true);
      expect(reads.size).toBe(Array.isArray(target) ? 3 : 2);
    }
  });

  it("fails closed on a throwing getter or Proxy instead of producing a digest", () => {
    const failure = new Error("snapshot failure");
    for (const input of [
      { get value() { throw failure; } },
      new Proxy({}, { ownKeys() { throw failure; } }),
    ]) expect(() => sha256Canonical(input)).toThrow(failure);
  });
});
