import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { REDACTED, SCRUB_LIMITS, TRUNCATED, UNSERIALIZABLE, scrubJson, scrubText } from "./scrubber.js";

const b64 = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
const JWT = `${b64({ alg: "HS256", typ: "JWT" })}.${b64({ sub: "alice" })}.c2lnbmF0dXJlLXNpZ25hdHVyZQ`;
const SK = "sk-abcdefghijklmnopqrstuvwx";
const AKIA = "AKIAABCDEFGHIJKLMNOP";
const HEX32 = "0123456789abcdef0123456789abcdef";

describe("the limits are exactly these", () => {
  it("pins every bound", () => {
    expect(SCRUB_LIMITS).toEqual({ maxDepth: 6, maxString: 1024, maxEntries: 64, maxNodes: 1024 });
    expect(Object.isFrozen(SCRUB_LIMITS)).toBe(true);
  });
  it("at maxString characters a string is kept whole, one more is cut", () => {
    expect(scrubText("x".repeat(1024))).toBe("x".repeat(1024));
    expect(scrubText("x".repeat(1025))).toBe(`${"x".repeat(1024)}[truncated]`);
  });
  it("keeps exactly 64 entries and marks the 65th", () => {
    expect(scrubJson(Array.from({ length: 64 }, () => 1))).toHaveLength(64);
    expect(scrubJson(Array.from({ length: 65 }, () => 1))).toHaveLength(65);
    expect((scrubJson(Array.from({ length: 65 }, () => 1)) as unknown[])[64]).toBe("[truncated]");
  });
  it("keeps exactly 6 nested containers", () => {
    expect(JSON.stringify(scrubJson([[[[[[1]]]]]]))).toBe("[[[[[[1]]]]]]");
    expect(JSON.stringify(scrubJson([[[[[[[1]]]]]]]))).toBe('[[[[[["[truncated]"]]]]]]');
  });
  it("keeps exactly 1024 nodes in total and truncates from the 1025th", () => {
    // 1 root + 33 arrays + 33 x 30 numbers = 1024 nodes; one more number makes 1025.
    const tree = (extra: number) => Array.from({ length: 33 }, (_, i) => Array.from({ length: 30 + (i === 32 ? extra : 0) }, () => 1));
    expect(JSON.stringify(scrubJson(tree(0)))).not.toContain("[truncated]");
    expect(JSON.stringify(scrubJson(tree(1)))).toContain("[truncated]");
  });
});

describe("scrubText: secret-shaped text is redacted", () => {
  it.each([
    ["a JWT", JWT], ["a JWT with only typ in its header", `${b64({ typ: "JWT" })}.${b64({ a: 1 })}.sig-sig-sig`], ["a JWT with only alg in its header", `${b64({ alg: "none" })}.${b64({ a: 1 })}.sig-sig-sig`],
    ["a JSON-headed token without alg or typ (over-redacted on purpose)", `${b64({ hello: "world" })}.${b64({ a: 1 })}.signature`], ["an sk- key", SK], ["an sk-proj- key", "sk-proj-abcdefghijklmnop1234"], ["an sk-svcacct- key", "sk-svcacct-abcdefghijklmnop1234"], ["an AKIA key", AKIA],
    ["32 hex characters", HEX32], ["a long upper-case hex run", "ABCDEF0123456789ABCDEF0123456789ABCDEF01"], ["a 64-character hex digest", "a".repeat(64)],
  ])("%s", (_name, secret) => {
    expect(scrubText(secret)).toBe(REDACTED);
    expect(scrubText(`before ${secret} after`)).toBe(`before ${REDACTED} after`);
    expect(scrubText(`${secret} and ${secret}`)).toBe(`${REDACTED} and ${REDACTED}`);
  });

  it("recognises a JWT whose header is not the usual `{\"` (a leading space) by decoding it", () => {
    const spaced = (header: object) => `${Buffer.from(` ${JSON.stringify(header)}`).toString("base64url")}.${b64({ a: 1 })}.sig-sig-sig`;
    expect(Buffer.from(` {"alg":"x"}`).toString("base64url").startsWith("eyJ")).toBe(false);
    expect(scrubText(spaced({ alg: "HS256" }))).toBe(REDACTED);
    expect(scrubText(spaced({ typ: "JWT" }))).toBe(REDACTED);
    expect(scrubText(spaced({ typ: "other" }))).toBe(spaced({ typ: "other" }));
    expect(scrubText(spaced({ alg: 5 }))).toBe(spaced({ alg: 5 }));
    expect(scrubText(spaced({ hello: "world" }))).toBe(spaced({ hello: "world" }));
    const nonObject = (value: unknown) => `${Buffer.from(JSON.stringify(value)).toString("base64url")}.${b64({ a: 1 })}.sig-sig-sig`;
    for (const odd of [5, null, "alg", [1]]) expect(scrubText(nonObject(odd)), String(odd)).toBe(nonObject(odd));
  });

  it("redacts `eyJ` plus 4 characters as a header, and not plus 3", () => {
    expect(scrubText("eyJabcd.abcd.abcd")).toBe(REDACTED);
    expect(scrubText("eyJabc.abcd.abcd")).toBe("eyJabc.abcd.abcd");
  });

  it("matches AKIA only in upper case and digits", () => {
    expect(scrubText(`AKIA${"a".repeat(16)}`)).toBe(`AKIA${"a".repeat(16)}`);
    expect(scrubText(`AKIA${"A1".repeat(8)}`)).toBe(REDACTED);
  });

  it("leaves what is not secret-shaped alone", () => {
    for (const plain of ["", "hello world", "project p1", "sk-short", "AKIA123", "a".repeat(31), "0123456789abcdef", "task-1234-5678", "a.b.c", "one.two.three", "1.2.3", "2026.01.01", "ask-abcdefghijklmnopqrstuvwx".slice(1, 4)]) {
      expect(scrubText(plain), plain).toBe(plain);
    }
  });

  it("applies exact thresholds: 16 characters after sk-, 16 after AKIA, 32 hex", () => {
    expect(scrubText(`sk-${"a".repeat(16)}`)).toBe(REDACTED);
    expect(scrubText(`sk-${"a".repeat(15)}`)).toBe(`sk-${"a".repeat(15)}`);
    expect(scrubText(`AKIA${"A".repeat(16)}`)).toBe(REDACTED);
    expect(scrubText(`AKIA${"A".repeat(15)}`)).toBe(`AKIA${"A".repeat(15)}`);
    expect(scrubText("f".repeat(32))).toBe(REDACTED);
    expect(scrubText("f".repeat(31))).toBe("f".repeat(31));
  });

  it("redacts a secret that is disguised by invisible or look-alike characters, and the whole value with it", () => {
    for (const disguised of ["sk-abcdefgh\u200bijklmnopqrstuvwx", "AKIAABCDEFGH\u00adIJKLMNOP", `0123456789abcdef\ufeff0123456789abcdef`, "ＡＫＩＡABCDEFGHIJKLMNOP", "sk-abcd\u202eefghijklmnopqrstuvwx"]) {
      expect(scrubText(`token ${disguised} end`), disguised).toBe(REDACTED);
    }
  });

  it("treats invisible characters and split whitespace as disguises while preserving visible punctuation", () => {
    const hide = (code: number) => `sk-abcdefgh${String.fromCharCode(code)}ijklmnopqrstuvwx`;
    const invisible = [0xad, 0x200b, 0x200c, 0x200d, 0x200e, 0x200f, 0x202a, 0x202b, 0x202c, 0x202d, 0x202e, 0x2060, 0x2061, 0x2062, 0x2063, 0x2064, 0xfeff];
    for (const code of invisible) expect(scrubText(hide(code)), code.toString(16)).toBe(REDACTED);
    for (const code of [0x200a, 0x2029, 0x202f, 0x205f, 0x2065]) expect(scrubText(hide(code)), code.toString(16)).toBe(REDACTED);
    for (const code of [0xac, 0xae, 0x2010, 0xfefe]) expect(scrubText(hide(code)), code.toString(16)).toBe(hide(code));
  });

  it("keeps ordinary text with invisible characters that hide nothing", () => {
    expect(scrubText("a\u200bb")).toBe("a\u200bb");
  });

  it("is bounded: an overlong string is cut and marked, a secret in the cut part is not kept", () => {
    const long = scrubText("x".repeat(SCRUB_LIMITS.maxString + 500));
    expect(long).toBe(`${"x".repeat(SCRUB_LIMITS.maxString)}${TRUNCATED}`);
    expect(scrubText("x".repeat(SCRUB_LIMITS.maxString))).toBe("x".repeat(SCRUB_LIMITS.maxString));
    expect(scrubText(`${"x".repeat(SCRUB_LIMITS.maxString)}${SK}`)).not.toContain("sk-");
    expect(scrubText(`${"x".repeat(SCRUB_LIMITS.maxString - 10)}${SK}`)).not.toContain(SK);
  });

  it("redacts a JWT however it is glued to surrounding text", () => {
    expect(scrubText(`0${JWT}`)).toBe(`0${REDACTED}`);
    expect(scrubText(`${JWT}9`)).not.toContain("eyJ");
    expect(scrubText(`x=${JWT};y`)).toBe(`x=${REDACTED};y`);
  });

  it("never throws and never leaves a pattern behind, for any text (property)", () => {
    fc.assert(fc.property(fc.string({ maxLength: 200 }), fc.constantFrom(SK, AKIA, HEX32, JWT), fc.string({ maxLength: 20 }), (before, secret, after) => {
      const out = scrubText(`${before}${secret}${after}`);
      expect(out).not.toContain(secret);
      expect(typeof out).toBe("string");
    }), { numRuns: 200 });
  });
});

describe("scrubJson: plain, frozen, bounded JSON; never throws", () => {
  it("passes plain data through unchanged and freezes it all the way down", () => {
    const out = scrubJson({ a: 1, b: [true, null, "x", { c: 2.5 }], d: { e: "f" } });
    expect(out).toEqual({ a: 1, b: [true, null, "x", { c: 2.5 }], d: { e: "f" } });
    const walk = (node: unknown): void => { if (node && typeof node === "object") { expect(Object.isFrozen(node)).toBe(true); Object.values(node).forEach(walk); } };
    walk(out);
  });

  it("redacts secret-shaped strings anywhere, in values AND keys", () => {
    const out = scrubJson({ token: SK, nested: [{ k: AKIA }], [HEX32]: "v" });
    expect(JSON.stringify(out)).not.toMatch(/sk-abc|AKIAABC|0123456789abcdef0123/);
    expect(out).toEqual({ token: REDACTED, nested: [{ k: REDACTED }], [REDACTED]: "v" });
  });

  it.each([["undefined", undefined], ["a function", () => 1], ["a symbol", Symbol("s")], ["a bigint", 10n], ["NaN", Number.NaN], ["Infinity", Number.POSITIVE_INFINITY], ["-Infinity", Number.NEGATIVE_INFINITY]])(
    "%s becomes the unserializable marker", (_name, value) => {
      expect(scrubJson(value)).toBe(UNSERIALIZABLE);
      expect(scrubJson({ v: value })).toEqual({ v: UNSERIALIZABLE });
      expect(scrubJson([value])).toEqual([UNSERIALIZABLE]);
    });

  it("an array whose length is not a safe non-negative integer is unserializable", () => {
    for (const length of [Number.NaN, Number.POSITIVE_INFINITY, 1.5, -1, 2 ** 53]) {
      expect(scrubJson(new Proxy([1], { get: (target, key) => (key === "length" ? length : Reflect.get(target, key)) })), String(length)).toBe(UNSERIALIZABLE);
    }
  });

  it("survives hostile objects: throwing getters, throwing proxies, cycles, exotic lengths", () => {
    const cyclic: Record<string, unknown> = { a: 1 }; cyclic.self = cyclic;
    expect(scrubJson(cyclic)).toEqual({ a: 1, self: UNSERIALIZABLE });
    const list: unknown[] = []; list.push(list);
    expect(scrubJson(list)).toEqual([UNSERIALIZABLE]);
    expect(scrubJson({ get boom(): never { throw new Error("CANARY"); } })).toBe(UNSERIALIZABLE);
    expect(scrubJson(new Proxy({}, { ownKeys() { throw new Error("CANARY"); } }))).toBe(UNSERIALIZABLE);
    expect(scrubJson(new Proxy([], { get() { throw new Error("CANARY"); } }))).toBe(UNSERIALIZABLE);
    const fake = new Proxy([1, 2], { get: (target, key) => (key === "length" ? 2 ** 40 : Reflect.get(target, key)) });
    expect(() => scrubJson(fake)).not.toThrow();
    expect((scrubJson(fake) as unknown[]).length).toBeLessThanOrEqual(SCRUB_LIMITS.maxEntries + 1);
    expect(scrubJson(new Proxy([1], { get: (target, key) => (key === "length" ? -1 : Reflect.get(target, key)) }))).toBe(UNSERIALIZABLE);
    expect(scrubJson(new Proxy([1], { get: (target, key) => (key === "length" ? "2" : Reflect.get(target, key)) }))).toBe(UNSERIALIZABLE);
    expect(JSON.stringify(scrubJson({ get boom(): never { throw new Error("CANARY"); } }))).not.toContain("CANARY");
  });

  it("a shared (non-cyclic) object appearing twice is copied twice, not marked a cycle", () => {
    const shared = { x: 1 };
    expect(scrubJson({ a: shared, b: shared })).toEqual({ a: { x: 1 }, b: { x: 1 } });
  });

  it("reads each property exactly once", () => {
    let reads = 0;
    const out = scrubJson({ get v() { reads += 1; return reads === 1 ? "first" : SK; } });
    expect(out).toEqual({ v: "first" });
    expect(reads).toBe(1);
  });

  it("bounds depth: a container at maxDepth is truncated", () => {
    const nest = (levels: number): unknown => (levels === 0 ? "leaf" : { n: nest(levels - 1) });
    // maxDepth counts nested containers: that many are kept, one more is cut.
    expect(JSON.stringify(scrubJson(nest(SCRUB_LIMITS.maxDepth)))).toContain("leaf");
    expect(JSON.stringify(scrubJson(nest(SCRUB_LIMITS.maxDepth)))).not.toContain(TRUNCATED);
    expect(JSON.stringify(scrubJson(nest(SCRUB_LIMITS.maxDepth + 1)))).toContain(TRUNCATED);
    expect(JSON.stringify(scrubJson(nest(SCRUB_LIMITS.maxDepth + 1)))).not.toContain("leaf");
    const deepArray = (levels: number): unknown => (levels === 0 ? ["leaf"] : [deepArray(levels - 1)]);
    expect(JSON.stringify(scrubJson(deepArray(50)))).not.toContain("leaf");
  });

  it("bounds the number of entries in an array and in an object, and says so", () => {
    const list = scrubJson(Array.from({ length: SCRUB_LIMITS.maxEntries + 10 }, (_, i) => i)) as unknown[];
    expect(list).toHaveLength(SCRUB_LIMITS.maxEntries + 1);
    expect(list.at(-1)).toBe(TRUNCATED);
    expect(list[SCRUB_LIMITS.maxEntries - 1]).toBe(SCRUB_LIMITS.maxEntries - 1);
    const exact = scrubJson(Array.from({ length: SCRUB_LIMITS.maxEntries }, (_, i) => i)) as unknown[];
    expect(exact).toHaveLength(SCRUB_LIMITS.maxEntries);
    const wide = scrubJson(Object.fromEntries(Array.from({ length: SCRUB_LIMITS.maxEntries + 10 }, (_, i) => [`k${i}`, i]))) as Record<string, unknown>;
    expect(Object.keys(wide)).toHaveLength(SCRUB_LIMITS.maxEntries + 1);
    expect(wide[TRUNCATED]).toBe(TRUNCATED);
    expect(wide[`k${SCRUB_LIMITS.maxEntries - 1}`]).toBe(SCRUB_LIMITS.maxEntries - 1);
    const fits = scrubJson(Object.fromEntries(Array.from({ length: SCRUB_LIMITS.maxEntries }, (_, i) => [`k${i}`, i]))) as Record<string, unknown>;
    expect(Object.keys(fits)).toHaveLength(SCRUB_LIMITS.maxEntries);
    expect(Object.hasOwn(fits, TRUNCATED)).toBe(false);
  });

  it("bounds the total number of nodes, so a wide tree of wide trees stays small", () => {
    const tree = Array.from({ length: SCRUB_LIMITS.maxEntries }, () => Array.from({ length: SCRUB_LIMITS.maxEntries }, () => Array.from({ length: SCRUB_LIMITS.maxEntries }, () => 1)));
    expect(JSON.stringify(scrubJson(tree)).length).toBeLessThan(SCRUB_LIMITS.maxNodes * 14);
    expect(JSON.stringify(scrubJson(tree))).toContain(TRUNCATED);
  });

  it("keeps newlines, ANSI escapes and JSON-breaking text inside ONE value (ATK-INJECT-04)", () => {
    const hostile = "line1\n\u001b[31mred\u001b[0m\r\n\"},{\"forged\":true,\"x\":\"";
    const out = scrubJson({ note: hostile }) as Record<string, unknown>;
    expect(Object.keys(out)).toEqual(["note"]);
    expect(out.note).toBe(hostile);
    const line = JSON.stringify(out);
    expect(line.includes("\n")).toBe(false);
    expect(JSON.parse(line)).toEqual({ note: hostile });
  });

  it("a duplicate key after scrubbing keeps the first", () => {
    expect(scrubJson({ [SK]: "first", [`${SK}0`]: "second" })).toEqual({ [REDACTED]: "first" });
  });

  it("has no prototype to pollute", () => {
    const out = scrubJson(JSON.parse('{"__proto__":{"polluted":true},"a":1}')) as Record<string, unknown>;
    expect(({} as Record<string, unknown>).polluted).toBeUndefined();
    expect(Object.getPrototypeOf(out)).toBe(null);
  });

  it("never throws for any input (property)", () => {
    fc.assert(fc.property(fc.anything(), (value) => { expect(() => scrubJson(value)).not.toThrow(); }), { numRuns: 200 });
  });
});
