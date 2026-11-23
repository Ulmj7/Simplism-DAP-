/**
 * @dap/security: validation/strict-json.hostile.test.ts
 *
 * QA round on T061: the hostile-input boundary, checked against RFC 8259 and against every way an
 * already-parsed value can lie. Complements strict-json.test.ts.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { parseStrictJson, parseStrictJsonDeferred, type StrictJsonCode } from "./strict-json.js";

type Outcome = "ok" | StrictJsonCode;
const outcome = (input: unknown, options?: Parameters<typeof parseStrictJson>[1]): Outcome => {
  const result = parseStrictJson(input, options);
  return result.ok ? "ok" : result.code;
};
const value = (input: unknown, options?: Parameters<typeof parseStrictJson>[1]): unknown => {
  const result = parseStrictJson(input, options);
  if (!result.ok) throw new Error(`expected success, got ${result.code}`);
  return result.value;
};
const utf8 = (text: string): number => new TextEncoder().encode(text).length;
const parsedAsJson = (text: string): unknown => JSON.parse(text, (_key, node: unknown) => (Object.is(node, -0) ? 0 : node));
/**
 * Counts calls to `target[method]` while `run` executes, and throws as soon as the count passes `limit`, so a guard that stops
 * bounding work fails fast and cleanly instead of grinding through (or exhausting memory on) an unbounded scan.
 */
function boundedCalls<T extends object>(target: T, method: keyof T & string, limit: number, run: () => void): number {
  const original = target[method] as unknown as (...args: unknown[]) => unknown;
  let calls = 0;
  (target as Record<string, unknown>)[method] = function counted(this: unknown, ...args: unknown[]): unknown {
    calls += 1;
    if (calls > limit) throw new RangeError(`${method} called more than ${limit} times: the work is not bounded`);
    return original.apply(this, args);
  };
  try { run(); } finally { (target as Record<string, unknown>)[method] = original; }
  return calls;
}
const nestedArrays = (depth: number): string => "[".repeat(depth) + "]".repeat(depth);
const nestedObjects = (depth: number): string => `{"a":`.repeat(depth) + "1" + "}".repeat(depth);

describe("strings: escapes and surrogates (RFC 8259 section 7 and 8.2)", () => {
  it("decodes every legal escape", () => {
    expect(value('"\\"\\\\\\/\\b\\f\\n\\r\\t"')).toBe('"\\/\b\f\n\r\t');
    expect(value('"\\u0041\\u00e9\\u00E9\\u20AC"')).toBe("A\u00e9\u00e9\u20ac");
    expect(value('"\\ud83d\\ude00"')).toBe("\u{1f600}");
    expect(value('"\\uD83D\\uDE00"')).toBe("\u{1f600}");
    expect(value('"\u{1f600}"')).toBe("\u{1f600}");
    expect(value('"\\u0000"')).toBe("\u0000");
  });

  it.each(['"\\x41"', '"\\\'"', '"\\a"', '"\\u12"', '"\\u12G4"', '"\\u"', '"\\u 123"', '"\\U0041"', '"\\', '"abc', '"\\"', '"\\u123'])(
    "rejects the malformed escape or unterminated string %s", (text) => {
      expect(outcome(text)).toBe("syntax");
    });

  it("rejects every raw control character below U+0020 inside a string, and accepts DEL", () => {
    for (let code = 0; code < 0x20; code += 1) expect(outcome(`"a${String.fromCharCode(code)}b"`), `U+${code.toString(16)}`).toBe("syntax");
    expect(value('"a\u007fb"')).toBe("a\u007fb");
  });

  it.each([
    ["a high surrogate escape", '"\\ud800"'], ["a low surrogate escape", '"\\udc00"'], ["two high surrogates", '"\\ud800\\ud800"'],
    ["a reversed pair", '"\\udc00\\ud800"'], ["a high surrogate then text", '"\\ud800x"'], ["a high surrogate then another escape", '"\\ud800\\u0041"'],
    ["a high surrogate at the end", '"abc\\ud83d"'], ["a lone low surrogate after a pair", '"\\ud83d\\ude00\\ude00"'],
  ])("rejects a lone surrogate: %s", (_label, text) => {
    expect(outcome(text)).toBe("syntax");
    expect(outcome(`{${text}:1}`), "as a key").toBe("syntax");
    expect(outcome(`[${text}]`), "in an array").toBe("syntax");
  });

  it("rejects a lone surrogate written raw in the text, and accepts a raw pair", () => {
    expect(outcome('"\ud800"')).toBe("syntax");
    expect(outcome('"\udc00"')).toBe("syntax");
    expect(outcome('{"\ud800":1}')).toBe("syntax");
    expect(outcome('"\u{1f600}x"')).toBe("ok");
  });
});

describe("numbers (RFC 8259 section 6)", () => {
  it.each(["0", "-0", "1", "-1", "10", "1.5", "-1.25", "1e5", "1E5", "1e+5", "1e-5", "0.1e2", "0e0", "5e-324", "4503599627370496.5", "12345678901234567890e-5"])(
    "accepts %s", (text) => { expect(outcome(text)).toBe("ok"); expect(outcome(`[${text},{"n":${text}}]`)).toBe("ok"); });

  it.each(["01", "-01", "00", "+1", ".5", "-.5", "5.", "1.e3", "1e", "1e+", "1e-", "0x10", "0b1", "Infinity", "-Infinity", "NaN", "1_000", "- 1", "--1", "1.2.3", "1e5.5", "０", "١"])(
    "rejects the non-JSON number %s", (text) => { expect(outcome(text)).toBe("syntax"); });

  it.each(["1e999", "-1e999", "1e309", "1.8e308", "[1e999]", '{"a":-1e400}', "1" + "0".repeat(400)])("reports overflow %s as non-finite", (text) => {
    expect(outcome(text)).toBe("not_finite");
  });

  it.each([
    "9007199254740992", "9007199254740993", "-9007199254740993", "12345678901234567890", "[9007199254740992]", '{"id":18446744073709551615}', "1" + "0".repeat(30),
    "9007199254740992.0", "9007199254740993.5", "1e20", "-1e20", "1e21", "1.5e300", "123456789012345680000", "1e308",
  ])("rejects %s: beyond 2^53-1 a double may name a different id or amount than the text did", (text) => {
    expect(outcome(text)).toBe("unsafe_number");
  });

  it.each(["9007199254740991", "-9007199254740991", "0.1", "123456789012345.6", "4503599627370496.5", "1e15", "-1e-300"])(
    "accepts %s", (text) => { expect(outcome(text)).toBe("ok"); });

  it("applies the same limit to already-parsed numbers, so both branches agree on what a number is", () => {
    for (const n of [Number.MAX_SAFE_INTEGER + 1, 2 ** 60, 1e21, -1e21, 1.5e300, Number.MAX_VALUE]) expect(outcome([n]), String(n)).toBe("unsafe_number");
    for (const n of [Number.MAX_SAFE_INTEGER, -Number.MAX_SAFE_INTEGER, 0.1, 5e-324, Number.MIN_VALUE]) expect(outcome([n]), String(n)).toBe("ok");
  });

  it.each(["-0", "-0.0", "-0e0", "-0e5", "-0e-999", "[-0]", '{"a":-0}'])("never returns negative zero from %s", (text) => {
    const walk = (node: unknown): void => {
      if (typeof node === "number") expect(Object.is(node, -0)).toBe(false);
      else if (node && typeof node === "object") Object.values(node).forEach(walk);
    };
    walk(value(text));
  });

  it("returns 0, not -0, for negative zero in already-parsed data too", () => {
    for (const input of [-0, [-0], { a: -0 }, { a: [{ b: -0 }] }]) {
      const walk = (node: unknown): void => {
        if (typeof node === "number") expect(Object.is(node, -0)).toBe(false);
        else if (node && typeof node === "object") Object.values(node).forEach(walk);
      };
      walk(value(input));
    }
  });
});

describe("structure and whitespace (RFC 8259 sections 2 to 4)", () => {
  it("allows exactly space, tab, LF and CR between tokens, at every position", () => {
    expect(value(' \t\r\n{ \t\r\n"a" \t\r\n: \t\r\n[ \t\r\n1 \t\r\n, \t\r\n2 \t\r\n] \t\r\n} \t\r\n')).toEqual({ a: [1, 2] });
  });

  it.each(["\f", "\v", "\u00a0", "\u2028", "\u2029", "\ufeff", "\u0000", "\u3000", "\u200b"])("rejects the non-JSON whitespace U+%s", (char) => {
    const code = char.charCodeAt(0).toString(16);
    for (const text of [`${char}{}`, `{}${char}`, `[1${char}]`, `{"a"${char}:1}`, `[1,${char}2]`]) expect(outcome(text), `U+${code} in ${JSON.stringify(text)}`).toBe("syntax");
  });

  it.each([
    "", " ", "\n", "[", "]", "{", "}", "[,]", "[1,]", "[,1]", "[1 2]", "[1,,2]", "{,}", '{"a":1,}', '{,"a":1}', '{"a" 1}', '{"a":}', '{"a"}', "{a:1}", "{'a':1}",
    '{"a":1 "b":2}', '{1:2}', "{}x", "{} {}", "[] []", "/* c */ {}", "{} // c", "{}\u0000", "truefalse", "[true false]", "tru", "True", "nul", "nulll", "undefined", "'a'",
    '{"a":1}}', "[[]", "[]]", '{"a":{"b":1}', '"a" "b"',
  ])("rejects the malformed document %j", (text) => {
    expect(outcome(text)).toBe("syntax");
  });

  it("accepts an empty array and object with interior whitespace", () => {
    expect(value("[ \n ]")).toEqual([]);
    expect(value("{ \n }")).toEqual({});
  });

  it("accepts every root scalar", () => {
    expect([value("null"), value("true"), value("false"), value("0"), value('""')]).toEqual([null, true, false, 0, ""]);
  });
});

describe("depth is counted exactly, for arrays, objects and mixes", () => {
  it.each([["arrays", nestedArrays], ["objects", nestedObjects]] as const)("%s: depth 8 is accepted and depth 9 is not", (_label, make) => {
    expect(outcome(make(8))).toBe("ok");
    expect(outcome(make(9))).toBe("too_deep");
    expect(outcome(make(1), { maxJsonDepth: 1 })).toBe("ok");
    expect(outcome(make(2), { maxJsonDepth: 1 })).toBe("too_deep");
  });

  it("counts a mix of arrays and objects as one chain", () => {
    expect(outcome('[{"a":[{"b":[{"c":[[1]]}]}]}]')).toBe("ok");
    expect(outcome('[{"a":[{"b":[{"c":[[[1]]]}]}]}]')).toBe("too_deep");
  });

  it("does not count scalars, and counts siblings by their own depth only", () => {
    expect(outcome(`[${nestedArrays(7)},${nestedArrays(7)},1,"x",null]`)).toBe("ok");
    expect(outcome(`[${nestedArrays(8)}]`)).toBe("too_deep");
  });

  it("rejects 100000-deep text without overflowing the stack, and never throws even with an absurd cap", () => {
    const text = "[".repeat(100_000);
    expect(outcome(text, { maxPayloadBytes: 10_000_000 })).toBe("too_deep");
    expect(() => parseStrictJson(nestedArrays(200_000), { maxPayloadBytes: 10_000_000, maxJsonDepth: 1_000_000 })).not.toThrow();
    expect(outcome(nestedArrays(200_000), { maxPayloadBytes: 10_000_000, maxJsonDepth: 1_000_000 })).not.toBe("ok");
  });

  it("applies the same depth rule to already-parsed values", () => {
    const deep = (depth: number): unknown => { let node: unknown = 1; for (let i = 0; i < depth; i += 1) node = [node]; return node; };
    const deepObject = (depth: number): unknown => { let node: unknown = 1; for (let i = 0; i < depth; i += 1) node = { a: node }; return node; };
    expect(outcome(deep(8))).toBe("ok");
    expect(outcome(deep(9))).toBe("too_deep");
    expect(outcome(deepObject(8))).toBe("ok");
    expect(outcome(deepObject(9))).toBe("too_deep");
    expect(outcome(deep(500_000), { maxPayloadBytes: 1e9 })).toBe("too_deep");
  });
});

describe("the byte cap is measured on the raw UTF-8 text", () => {
  const widths: ReadonlyArray<[string, string, number]> = [["1-byte", "a", 1], ["2-byte", "\u00e9", 2], ["3-byte", "\u20ac", 3], ["4-byte", "\u{1f600}", 4]];

  it.each(widths)("is exact at the boundary for %s characters", (_label, char, width) => {
    const cap = 40;
    const filler = Math.floor((cap - 4) / width);
    let text = `["${char.repeat(filler)}"]`;
    const pad = cap - utf8(text);
    text = `["${char.repeat(filler)}${"a".repeat(pad)}"]`;
    expect(utf8(text)).toBe(cap);
    expect(outcome(text, { maxPayloadBytes: cap })).toBe("ok");
    expect(outcome(text, { maxPayloadBytes: cap - 1 })).toBe("too_large");
    expect(outcome(text.replace('"]', 'a"]'), { maxPayloadBytes: cap })).toBe("too_large");
  });

  it("counts escapes by their raw length, not their decoded length", () => {
    const text = `["${"\\u00e9".repeat(3000)}"]`;
    expect(utf8(text)).toBe(18_004);
    expect(outcome(text)).toBe("too_large");
    expect(outcome(text, { maxPayloadBytes: 18_004 })).toBe("ok");
  });

  it("measures default 16384 on multi-byte text", () => {
    const fits = `"${"\u20ac".repeat(5460)}"`;
    expect(utf8(fits)).toBe(16_382);
    expect(outcome(fits)).toBe("ok");
    expect(outcome(`"${"\u20ac".repeat(5461)}"`)).toBe("too_large");
  });

  it("rejects an enormous string immediately, before scanning a single character of it", () => {
    const huge = "x".repeat(2 ** 26);
    // Counted work, not wall-clock time: a scan of 64M characters would call charCodeAt 64M times.
    expect(boundedCalls(String.prototype, "charCodeAt", 0, () => { expect(outcome(huge)).toBe("too_large"); })).toBe(0);
  });

  it("bounds the scan of a multi-byte string that fits the length bound but not the byte cap by the cap itself", () => {
    const text = `"${"\u20ac".repeat(16_383)}"`;
    boundedCalls(String.prototype, "charCodeAt", text.length, () => { expect(outcome(text)).toBe("too_large"); });
  });
});

describe("duplicate and forbidden keys are judged after escape decoding", () => {
  it.each([
    '{"a":1,"a":2}', '{"a":1,"\\u0061":2}', '{"\\u0061":1,"a":2}', '{"ab":1,"\\u0061\\u0062":2}', '{"":1,"":2}', '{"\\u0000":1,"\\u0000":2}',
    '{"x":{"a":1,"\\u0061":2}}', '[{"a":1,"a":2}]', '{"a":1,"b":2,"c":3,"a":4}', '{"\\/":1,"/":2}', '{"\\ud83d\\ude00":1,"\u{1f600}":2}',
  ])("rejects the duplicate key in %s", (text) => {
    expect(outcome(text)).toBe("duplicate_key");
  });

  it("accepts keys that merely look alike, and the same key in different objects", () => {
    expect(outcome('{"a":1,"A":2,"a ":3,"\u0430":4}')).toBe("ok");
    expect(outcome('{"a":{"a":1},"b":{"a":1},"c":[{"a":1},{"a":2}]}')).toBe("ok");
  });

  it.each([
    '{"__proto__":1}', '{"\\u005f\\u005fproto\\u005f\\u005f":1}', '{"__\\u0070roto__":1}', '{"constructor":1}', '{"constr\\u0075ctor":1}', '{"\\u0063onstructor":1}',
    '{"prototype":1}', '{"\\u0070rototype":1}', '{"a":{"__proto__":{"x":1}}}', '[{"a":[{"constructor":1}]}]', '{"a":1,"__proto__":2}',
  ])("rejects the forbidden key in %s", (text) => {
    expect(outcome(text)).toBe("forbidden_key");
  });

  it("accepts near-miss keys and never touches Object.prototype", () => {
    expect(outcome('{"__proto":1,"proto__":2,"_proto_":3,"Constructor":4,"constructors":5,"prototypes":6,"__PROTO__":7}')).toBe("ok");
    const parsed = value('{"toString":1,"hasOwnProperty":2,"valueOf":3,"__defineGetter__":4,"isPrototypeOf":5}') as Record<string, unknown>;
    expect(Object.keys(parsed)).toHaveLength(5);
    expect(Object.getPrototypeOf(parsed)).toBe(Object.prototype);
    expect(({} as Record<string, unknown>).toString).toBe(Object.prototype.toString);
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
  });
});

describe("failures carry nothing from the input", () => {
  it.each([
    ['{"CANARY":1,"CANARY":2}', "duplicate_key"], ['{"__proto__":"CANARY"}', "forbidden_key"], ['["CANARY",1e999]', "not_finite"], ['{"CANARY":}', "syntax"],
    [`["CANARY"${",1".repeat(20_000)}]`, "too_large"], [`{"a":[[[[[[[[["CANARY"]]]]]]]]]}`, "too_deep"],
  ] as const)("%s", (text, code) => {
    const result = parseStrictJson(text);
    expect(result).toEqual({ ok: false, code });
    expect(Object.keys(result).sort()).toEqual(["code", "ok"]);
    expect(JSON.stringify(result)).not.toContain("CANARY");
  });
});

describe("a structural fault outranks a numeric fault, wherever each sits", () => {
  it.each([
    ['{"n":1e999,"n":2}', "duplicate_key"], ['{"n":1e999,"__proto__":1}', "forbidden_key"], ['{"__proto__":1,"n":1e999}', "forbidden_key"], ['[1e999,', "syntax"], ['[1e999 1]', "syntax"],
    ['[1e999,"\\ud800"]', "syntax"], ['{"a":1e999,"b":}', "syntax"], [`[1e999,${nestedArrays(9)}]`, "too_deep"], ['{"a":1e20,"a":1}', "duplicate_key"],
    ['{"a":1e-400,"constructor":1}', "forbidden_key"],
  ])("%s is %s", (text, code) => {
    expect(outcome(text)).toBe(code);
  });

  it("reports the first numeric fault when that is the only kind", () => {
    expect(outcome("[1e999,1e20]")).toBe("not_finite");
    expect(outcome("[1e20,1e999]")).toBe("unsafe_number");
    expect(outcome("[1e-400,1e999]")).toBe("unsafe_number");
  });

  it("holds for already-parsed data too", () => {
    const hidden = Object.defineProperty({}, "x", { value: 1, enumerable: false });
    expect(outcome({ a: NaN, b: 1n })).toBe("not_plain");
    expect(outcome([Infinity, undefined])).toBe("not_plain");
    expect(outcome({ a: 2 ** 60, b: Symbol("s") })).toBe("not_plain");
    expect(outcome({ a: NaN, b: hidden, c: 1 })).toBe("not_plain");
    expect(outcome({ a: NaN, b: "\ud800" })).toBe("not_plain");
    expect(outcome({ a: NaN, ["__proto__"]: 1 })).toBe("forbidden_key");
    expect(outcome([NaN, [[[[[[[[[1]]]]]]]]]])).toBe("too_deep");
    expect(outcome({ a: NaN, b: [Infinity] })).toBe("not_finite");
    expect(outcome({ a: 2 ** 60, b: NaN })).toBe("unsafe_number");
  });

  it("does not let a numeric fault hide an oversized payload", () => {
    expect(outcome([NaN, ...Array.from({ length: 10_000 }, () => 1)])).toBe("too_large");
  });
});

describe("a faulty number is charged like the text it would serialize to, so it cannot hide an oversized payload", () => {
  it.each([
    ["NaN", Number.NaN, 3276, "not_finite"], ["Infinity", Infinity, 3276, "not_finite"], ["-Infinity", -Infinity, 3276, "not_finite"],
    ["1e300", 1e300, 2340, "unsafe_number"], ["2^60", 2 ** 60, 819, "unsafe_number"],
  ] as const)("%s: the boundary is where the compact text crosses the cap", (_label, number, fits, fault) => {
    // JSON.stringify writes NaN and Infinity as null, so [x, x, ...] costs n * (len("[x]") - 1) + 1 bytes.
    const perElement = JSON.stringify([number]).length - 1;
    const size = (n: number): number => n * perElement + 1;
    expect(size(fits)).toBeLessThanOrEqual(16384);
    expect(size(fits + 1)).toBeGreaterThan(16384);
    expect(outcome(Array.from({ length: fits }, () => number))).toBe(fault);
    expect(outcome(Array.from({ length: fits + 1 }, () => number))).toBe("too_large");
  });

  it("agrees with the text branch on what is too large", () => {
    const numbers = Array.from({ length: 5000 }, () => Number.NaN);
    expect(outcome(numbers)).toBe("too_large");
    expect(outcome(`[${Array.from({ length: 5000 }, () => "1e999").join(",")}]`)).toBe("too_large");
  });
});

describe("parseStrictJsonDeferred cannot be mistaken for usable data", () => {
  it("offers value only when every number is usable, and a shape only otherwise", () => {
    const good = parseStrictJsonDeferred('{"a":[1,2]}');
    expect(good).toEqual({ ok: true, value: { a: [1, 2] } });
    expect(good).not.toHaveProperty("shape");
    for (const input of ['{"a":1e999}', '{"a":9007199254740993}', '{"a":1e-999}', { a: NaN }, { a: 2 ** 60 }]) {
      const faulty = parseStrictJsonDeferred(input);
      expect(faulty).toMatchObject({ ok: true, numberFault: expect.stringMatching(/not_finite|unsafe_number/), shape: { a: 0 } });
      expect(faulty).not.toHaveProperty("value");
    }
  });

  it("is frozen like any other result, and reports structural faults as failures", () => {
    const faulty = parseStrictJsonDeferred('{"a":1e999}');
    if (!faulty.ok || !("shape" in faulty)) throw new Error("expected a deferred number fault");
    expect(Object.isFrozen(faulty.shape)).toBe(true);
    expect(parseStrictJsonDeferred('{"a":1e999,"a":1}')).toEqual({ ok: false, code: "duplicate_key" });
  });
});

describe("a nonzero literal that underflows to zero is not silently zero", () => {
  it.each(["1e-400", "-1e-400", "0.0000000001e-400", "5e-325", "[1e-999]", '{"amount":1e-999}', "1.5e-1000"])("rejects %s", (text) => {
    expect(outcome(text)).toBe("unsafe_number");
  });
  it.each(["0", "0.0", "0e5", "0.000e-999", "-0", "-0.0e10", "5e-324", "1e-300", "2.2250738585072014e-308"])("accepts %s", (text) => {
    expect(outcome(text)).toBe("ok");
  });
});

describe("already-parsed input: it is copied once, and only what is really data survives", () => {
  it("reads each accessor and proxy trap exactly once", () => {
    const reads: Record<string, number> = {};
    const count = (key: string): void => { reads[key] = (reads[key] ?? 0) + 1; };
    const source = { a: 1, b: [1, 2, 3], c: { d: "x" } } as Record<string, unknown>;
    const traps: string[] = [];
    const watched = new Proxy(source, {
      get(target, key, receiver) { count(`get:${String(key)}`); return Reflect.get(target, key, receiver); },
      ownKeys(target) { traps.push("ownKeys"); return Reflect.ownKeys(target); },
      getOwnPropertyDescriptor(target, key) { traps.push("descriptor"); return Reflect.getOwnPropertyDescriptor(target, key); },
      getPrototypeOf(target) { traps.push("getPrototypeOf"); return Reflect.getPrototypeOf(target); },
      has() { throw new Error("must not probe with in"); }, set() { throw new Error("must not write"); }, deleteProperty() { throw new Error("must not delete"); },
    });
    expect(value(watched)).toEqual({ a: 1, b: [1, 2, 3], c: { d: "x" } });
    expect(reads).toEqual({ "get:a": 1, "get:b": 1, "get:c": 1 });
    expect(traps.filter((trap) => trap === "ownKeys")).toHaveLength(1);
    expect(traps.filter((trap) => trap === "getPrototypeOf")).toHaveLength(1);
    expect(traps.filter((trap) => trap === "descriptor").length).toBeLessThanOrEqual(3);
  });

  it("returns the first answer of a flip-flopping accessor, on objects and on array elements", () => {
    let reads = 0;
    const object = { get a(): number { reads += 1; return reads; } };
    const array: unknown[] = [];
    let elementReads = 0;
    Object.defineProperty(array, "0", { enumerable: true, get() { elementReads += 1; return elementReads * 10; } });
    expect(value(object)).toEqual({ a: 1 });
    expect(value(array)).toEqual([10]);
    expect([reads, elementReads]).toEqual([1, 1]);
  });

  it("is unaffected by later mutation of the source", () => {
    const source = { a: { b: [1, 2] } };
    const result = value(source) as typeof source;
    source.a.b.push(3);
    source.a = { b: [] };
    expect(result).toEqual({ a: { b: [1, 2] } });
    expect(result).not.toBe(source);
    expect(result.a).not.toBe(source.a);
  });

  it.each([
    ["a symbol-keyed property", () => ({ a: 1, [Symbol("s")]: 2 })],
    ["a non-enumerable property", () => Object.defineProperty({ a: 1 }, "hidden", { value: 2, enumerable: false })],
    ["a non-enumerable accessor", () => Object.defineProperty({ a: 1 }, "hidden", { get: () => 2, enumerable: false })],
    ["an array with a named property", () => Object.assign([1], { extra: 2 })],
    ["an array with a symbol property", () => Object.assign([1], { [Symbol("s")]: 2 })],
    ["an array with a hidden property", () => Object.defineProperty([1], "hidden", { value: 2, enumerable: false })],
    ["an array hole", () => [1, , 3]],
    ["an array element that is not enumerable", () => Object.defineProperty([], "0", { value: 1, enumerable: false, configurable: true, writable: true })],
    ["an array whose later element is not enumerable", () => Object.defineProperty([1, 2], "1", { value: 2, enumerable: false, configurable: true, writable: true })],
    ["a nested sparse array", () => ({ a: [, ,] })],
  ])("rejects %s instead of silently dropping it", (_label, make) => {
    expect(outcome(make())).toBe("not_plain");
  });

  it("rejects a sparse array of absurd length at the first hole, without visiting the rest", () => {
    boundedCalls(Object, "getOwnPropertyDescriptor", 10, () => {
      expect(outcome(new Array(2 ** 32 - 1))).not.toBe("ok");
      expect(outcome({ a: new Array(2 ** 31) })).not.toBe("ok");
    });
  });

  it.each([
    ["an array with an object prototype", () => Object.setPrototypeOf([1], {})], ["an array with a null prototype", () => Object.setPrototypeOf([1], null)],
    ["an Array subclass instance", () => new (class Tuple extends Array<number> {})(1, 2)], ["a nested subclass", () => ({ a: new (class Tuple extends Array<number> {})() })],
  ])("rejects %s, which is not plain data", (_label, make) => {
    expect(outcome(make())).toBe("not_plain");
  });

  it("accepts null-prototype objects, including nested ones", () => {
    const bare = Object.assign(Object.create(null) as Record<string, unknown>, { a: Object.assign(Object.create(null), { b: 1 }) });
    expect(value(bare)).toEqual({ a: { b: 1 } });
  });

  it.each([
    ["a class instance", () => new (class Point { x = 1; })()], ["a Date", () => new Date(0)], ["a Map", () => new Map()], ["a Set", () => new Set()], ["a RegExp", () => /x/],
    ["an Error", () => new Error("CANARY")], ["a typed array", () => new Uint8Array(2)], ["an ArrayBuffer", () => new ArrayBuffer(2)], ["a boxed string", () => new String("x")],
    ["a boxed number", () => new Number(1)], ["a Promise", () => Promise.resolve(1)], ["a function", () => () => 1], ["an object with a foreign prototype", () => Object.create({ inherited: 1 })],
    ["undefined", () => undefined], ["a symbol", () => Symbol("s")], ["a bigint", () => 1n], ["nested undefined", () => ({ a: undefined })], ["nested bigint", () => [1n]],
    ["nested function", () => ({ a: { b: () => 1 } })], ["a Proxy over a Date", () => new Proxy(new Date(0), {})],
  ])("rejects %s", (_label, make) => {
    expect(outcome(make())).toBe("not_plain");
  });

  it.each([NaN, Infinity, -Infinity, [NaN], { a: { b: Infinity } }])("reports non-finite number %j", (input) => {
    expect(outcome(input)).toBe("not_finite");
  });

  it("contains a hostile proxy or throwing accessor without throwing or echoing", () => {
    const hostile: Array<() => unknown> = [
      () => ({ get a(): never { throw new Error("CANARY"); } }),
      () => new Proxy({}, { ownKeys() { throw new Error("CANARY"); } }),
      () => new Proxy({ a: 1 }, { getOwnPropertyDescriptor() { throw new Error("CANARY"); } }),
      () => new Proxy({ a: 1 }, { get() { throw new Error("CANARY"); } }),
      () => new Proxy({}, { getPrototypeOf() { throw new Error("CANARY"); } }),
      () => { const { proxy, revoke } = Proxy.revocable({ a: 1 }, {}); revoke(); return proxy; },
      () => new Proxy([1], { get() { throw new Error("CANARY"); } }),
    ];
    for (const make of hostile) {
      const result = parseStrictJson(make());
      expect(result).toEqual({ ok: false, code: "not_plain" });
      expect(JSON.stringify(result)).not.toContain("CANARY");
    }
  });

  it.each([
    ["a lone surrogate value", { a: "\ud800" }], ["a lone surrogate key", { "\udc00": 1 }], ["a lone surrogate in an array", ["x", "\ud83d"]], ["a reversed pair", ["\ude00\ud83d"]],
  ])("rejects %s", (_label, input) => {
    expect(outcome(input)).toBe("not_plain");
  });

  it("accepts a well-formed surrogate pair", () => {
    expect(value({ "\u{1f600}": "\u{1f600}" })).toEqual({ "\u{1f600}": "\u{1f600}" });
  });
});

describe("already-parsed input: shared references are data, cycles are not, and expansion is bounded", () => {
  it("accepts a shared sub-object and returns an independent tree", () => {
    const shared = { n: 1 };
    const list = [1];
    const source = { x: shared, y: shared, z: [list, list] };
    const result = value(source) as { x: object; y: object; z: object[] };
    expect(result).toEqual({ x: { n: 1 }, y: { n: 1 }, z: [[1], [1]] });
    expect(result.x).not.toBe(result.y);
    expect(result.x).not.toBe(shared);
    expect(result.z[0]).not.toBe(result.z[1]);
    expect(Object.isFrozen(result.x) && Object.isFrozen(result.y)).toBe(true);
  });

  it("rejects a self-reference, an indirect cycle and a cycle through an array", () => {
    const self: Record<string, unknown> = {}; self.me = self;
    const a: Record<string, unknown> = {}; const b: Record<string, unknown> = { a }; a.b = b;
    const loop: unknown[] = []; loop.push([loop]);
    const viaGetter: Record<string, unknown> = { get again(): unknown { return viaGetter; } };
    for (const input of [self, a, loop, viaGetter]) expect(outcome(input)).toBe("not_plain");
  });

  it("is not fooled by repetition at depth: a cycle at depth 3 still fails, a repeated leaf at depth 3 does not", () => {
    const leaf = { k: 1 };
    expect(outcome({ a: { b: { c: leaf, d: leaf } } })).toBe("ok");
    const top: Record<string, unknown> = { a: { b: {} } };
    ((top.a as Record<string, unknown>).b as Record<string, unknown>).c = top;
    expect(outcome(top)).toBe("not_plain");
  });

  it("refuses an expansion bomb quickly instead of building a billion-node tree", () => {
    let node: unknown = [1];
    for (let level = 0; level < 7; level += 1) node = Array.from({ length: 100 }, () => node);
    let objects: unknown = { v: 1 };
    for (let level = 0; level < 7; level += 1) { const next: Record<string, unknown> = {}; for (let i = 0; i < 100; i += 1) next[`k${i}`] = objects; objects = next; }
    // Counted work: every element charges at least a byte, so the 16 KiB cap allows at most ~16k descriptor reads per bomb,
    // where an unbounded copy would perform 100^7 of them.
    boundedCalls(Object, "getOwnPropertyDescriptor", 40_000, () => {
      expect(outcome(node)).toBe("too_large");
      expect(outcome(objects)).toBe("too_large");
    });
  });

  it("applies the payload cap to already-parsed data, not just to text", () => {
    expect(outcome(Array.from({ length: 10_000 }, () => 1))).toBe("too_large");
    expect(outcome({ text: "x".repeat(20_000) })).toBe("too_large");
    expect(outcome(Array.from({ length: 10_000 }, () => 1), { maxPayloadBytes: 20_001 })).toBe("ok");
    expect(outcome(new Proxy([1], { get(target, key, receiver) { return key === "length" ? 1e9 : Reflect.get(target, key, receiver) ?? 1; } }))).not.toBe("ok");
  });

  it("measures already-parsed data as its compact JSON, so both branches agree at the boundary", () => {
    const wellFormedText = (text: string): boolean => !/[\ud800-\udfff]/.test(text.replace(/[\ud800-\udbff][\udc00-\udfff]/g, ""));
    const wellFormed = (node: unknown): boolean => {
      if (typeof node === "string") return wellFormedText(node);
      if (Array.isArray(node)) return node.every(wellFormed);
      if (node && typeof node === "object") return Object.entries(node).every(([key, child]) => wellFormedText(key) && wellFormed(child));
      return true;
    };
    const hasUnsafeNumber = (node: unknown): boolean => {
      if (typeof node === "number") return Math.abs(node) > Number.MAX_SAFE_INTEGER;
      if (Array.isArray(node)) return node.some(hasUnsafeNumber);
      if (node && typeof node === "object") return Object.values(node).some(hasUnsafeNumber);
      return false;
    };
    const hasForbiddenKey = (node: unknown): boolean => {
      if (Array.isArray(node)) return node.some(hasForbiddenKey);
      if (node && typeof node === "object") return Object.entries(node).some(([key, child]) => ["__proto__", "constructor", "prototype"].includes(key) || hasForbiddenKey(child));
      return false;
    };
    fc.assert(fc.property(fc.jsonValue({ maxDepth: 4 }), (generated) => {
      // A bare string would be read as JSON text, so only containers can be offered as already-parsed data.
      fc.pre(typeof generated === "object" && generated !== null);
      fc.pre(wellFormed(generated) && !hasForbiddenKey(generated) && !hasUnsafeNumber(generated));
      const text = JSON.stringify(generated);
      const size = utf8(text);
      fc.pre(size > 1);
      const big = { maxJsonDepth: 1000 };
      expect(outcome(text, { ...big, maxPayloadBytes: size })).toBe("ok");
      expect(outcome(generated, { ...big, maxPayloadBytes: size })).toBe("ok");
      expect(outcome(text, { ...big, maxPayloadBytes: size - 1 })).toBe("too_large");
      expect(outcome(generated, { ...big, maxPayloadBytes: size - 1 })).toBe("too_large");
      expect(value(generated, { ...big, maxPayloadBytes: size })).toEqual(parsedAsJson(text));
    }), { numRuns: 200 });
  });
});

describe("options are validated rather than trusted", () => {
  it.each([NaN, 0, -1, 1.5, Infinity, -Infinity, 2 ** 53, "16384", null, {}, true])("rejects maxPayloadBytes %j", (bad) => {
    expect(() => parseStrictJson("{}", { maxPayloadBytes: bad as number })).toThrow(RangeError);
  });
  it.each([NaN, 0, -1, 1.5, Infinity, -Infinity, 2 ** 53, "8", null, {}, true])("rejects maxJsonDepth %j", (bad) => {
    expect(() => parseStrictJson("{}", { maxJsonDepth: bad as number })).toThrow(RangeError);
  });
  it("uses the documented defaults when options are absent or undefined", () => {
    expect(outcome("{}", {})).toBe("ok");
    const explicitlyUndefined = { maxJsonDepth: undefined, maxPayloadBytes: undefined } as unknown as Parameters<typeof parseStrictJson>[1];
    expect(outcome(nestedArrays(9), explicitlyUndefined)).toBe("too_deep");
    expect(outcome(`"${"x".repeat(16_383)}"`, explicitlyUndefined)).toBe("too_large");
  });
});

/** What a success may look like, and nothing else: plain frozen JSON, no forbidden key, finite non-negative-zero numbers, well-formed text, within the cap. */
function assertStrictShape(node: unknown, path = "$"): void {
  if (node === null || typeof node === "boolean") return;
  if (typeof node === "string") { expect(/[\ud800-\udfff]/.test(node.replace(/[\ud800-\udbff][\udc00-\udfff]/g, "")), `${path} lone surrogate`).toBe(false); return; }
  if (typeof node === "number") { expect(Number.isFinite(node) && !Object.is(node, -0), `${path} number`).toBe(true); return; }
  expect(typeof node, `${path} type`).toBe("object");
  expect(Object.isFrozen(node), `${path} frozen`).toBe(true);
  if (Array.isArray(node)) {
    expect(Object.getPrototypeOf(node), `${path} prototype`).toBe(Array.prototype);
    node.forEach((child, index) => assertStrictShape(child, `${path}[${index}]`));
    return;
  }
  expect(Object.getPrototypeOf(node), `${path} prototype`).toBe(Object.prototype);
  expect(Reflect.ownKeys(node as object).every((key) => typeof key === "string" && !["__proto__", "constructor", "prototype"].includes(key)), `${path} keys`).toBe(true);
  for (const [key, child] of Object.entries(node as object)) { assertStrictShape(key, `${path}.key`); assertStrictShape(child, `${path}.${key}`); }
}

describe("totality", () => {
  it("never throws, and a success is always strictly shaped, for arbitrary values", () => {
    fc.assert(fc.property(fc.anything({ withBigInt: true, withDate: true, withMap: true, withSet: true, withObjectString: true, withNullPrototype: true, withTypedArray: true, withSparseArray: true, withBoxedValues: true }), (anything) => {
      const result = parseStrictJson(anything);
      if (result.ok) assertStrictShape(result.value);
    }), { numRuns: 300 });
  });

  it("never lets an exotic value through when it is nested anywhere in an otherwise valid document", () => {
    const cyclic: Record<string, unknown> = {}; cyclic.self = cyclic;
    const exotics: unknown[] = [new Date(0), new Map(), new Set(), () => 1, Symbol("s"), 1n, undefined, NaN, Infinity, -Infinity, new (class Thing { x = 1; })(), Object.create({ inherited: 1 }), cyclic, new Uint8Array(1), /x/, Promise.resolve(1), new Error("e"), "\ud800", Object.assign([1], { extra: 1 }), [, 1]];
    fc.assert(fc.property(fc.jsonValue({ maxDepth: 3 }), fc.constantFrom(...exotics), fc.constantFrom("object", "array", "deep"), (generated, exotic, place) => {
      const wrapped = place === "object" ? { ok: generated, bad: exotic } : place === "array" ? [generated, exotic] : { a: { b: [generated, { c: exotic }] } };
      expect(outcome(wrapped, { maxPayloadBytes: 1_000_000 })).not.toBe("ok");
    }), { numRuns: 300 });
  });

  it("never throws on arbitrary text, and a success is strictly shaped, for text built from JSON fragments", () => {
    const fragment = fc.constantFrom('{', '}', '[', ']', ',', ':', '"', '\\', 'u', '0', '1', '-', 'e', '.', 'true', 'null', ' ', '\n', '"a"', '\\u00', '\ud800', '1e999', '"__proto__"', '9007199254740993');
    fc.assert(fc.property(fc.array(fragment, { maxLength: 40 }).map((parts) => parts.join("")), (text) => {
      const result = parseStrictJson(text);
      if (result.ok) { assertStrictShape(result.value); expect(JSON.parse(JSON.stringify(result.value))).toEqual(parsedAsJson(text)); }
    }), { numRuns: 500 });
  });

  it("agrees with JSON.parse on everything it accepts, and accepts everything JSON.parse does unless a strict rule applies", () => {
    fc.assert(fc.property(fc.jsonValue({ maxDepth: 4 }), (generated) => {
      fc.pre(!JSON.stringify(generated).includes("__proto__") && !JSON.stringify(generated).includes('"constructor"') && !JSON.stringify(generated).includes('"prototype"'));
      fc.pre(JSON.stringify(generated).length < 3000);
      const text = JSON.stringify(generated);
      fc.pre(!/[\ud800-\udfff]/.test(text.replace(/[\ud800-\udbff][\udc00-\udfff]/g, "")));
      // A strict rule that rejects on purpose: a number JSON.parse would accept but whose magnitude exceeds 2^53-1.
      fc.pre(!JSON.stringify(generated, (_key, node: unknown) => (typeof node === "number" && Math.abs(node) > Number.MAX_SAFE_INTEGER ? "UNSAFE" : node)).includes('"UNSAFE"'));
      const result = parseStrictJson(text);
      expect(result.ok).toBe(true);
      if (result.ok) { assertStrictShape(result.value); expect(result.value).toEqual(parsedAsJson(text)); }
    }), { numRuns: 300 });
  });
});
