/**
 * @dap/security: validation/strict-json.test.ts
 *
 * T055 / FR-014. Strict intake of untrusted proposal data:
 * duplicate keys, `__proto__`/`constructor`/`prototype` keys, depth above 8,
 * payload above 16384 bytes, non-finite numbers, deep-freeze, and the
 * fast-check property that a successful result never contains a forbidden
 * key or two colliding keys.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import type { JsonValue } from "@dap/contracts";
import { parseStrictJson } from "./strict-json.js";

function assertNoForbiddenOrDuplicate(value: JsonValue): void {
  const keysAtLevel: string[] = [];
  if (value !== null && typeof value === "object" && !Array.isArray(value)) {
    keysAtLevel.push(...Object.keys(value));
    expect(
      keysAtLevel.filter((k) =>
        ["__proto__", "constructor", "prototype"].includes(k),
      ),
    ).toEqual([]);
    expect(new Set(keysAtLevel).size).toBe(keysAtLevel.length);
    for (const element of Object.values(value)) {
      assertNoForbiddenOrDuplicate(element);
    }
  } else if (Array.isArray(value)) {
    for (const element of value) assertNoForbiddenOrDuplicate(element);
  }
}

function assertDeeplyFrozen(value: JsonValue): void {
  expect(Object.isFrozen(value)).toBe(true);
  if (Array.isArray(value)) {
    for (const element of value) assertDeeplyFrozen(element);
  } else if (typeof value === "object" && value !== null) {
    for (const element of Object.values(value)) assertDeeplyFrozen(element);
  }
}

function nested(depth: number, leaf: string): string {
  let text = leaf;
  for (let i = 0; i < depth; i += 1) text = `{"a":${text}}`;
  return text;
}

describe("parseStrictJson: valid strict JSON", () => {
  it("parses scalars and containers", () => {
    const result = parseStrictJson(
      '{"a":{"b":[1,-2.5,3e2]},"s":"h\\u00e9llo","t":true,"f":false,"z":null}',
    );
    expect(result).toMatchObject({ ok: true });
    if (result.ok) {
      expect(result.value).toEqual({
        a: { b: [1, -2.5, 300] },
        s: "héllo",
        t: true,
        f: false,
        z: null,
      });
      assertDeeplyFrozen(result.value);
      expect(() => {
        const value = result.value as Record<string, unknown>;
        value.a = "mutated";
      }).toThrow();
    }
  });

  it("parses root scalars and ignores surrounding whitespace", () => {
    expect(parseStrictJson("42")).toEqual({ ok: true, value: 42 });
    expect(parseStrictJson('  "hi"  ')).toEqual({ ok: true, value: "hi" });
    expect(parseStrictJson("true")).toEqual({ ok: true, value: true });
    expect(parseStrictJson("null")).toEqual({ ok: true, value: null });
    // A nonzero literal that underflows to zero would silently name a different amount: rejected.
    expect(parseStrictJson("1e-999")).toEqual({ ok: false, code: "unsafe_number" });
    expect(parseStrictJson("0e-999")).toEqual({ ok: true, value: 0 });
    // Negative zero is normalized: JSON text cannot tell it from 0 once canonicalized.
    expect(parseStrictJson("-0")).toEqual({ ok: true, value: 0 });
  });

  it("allows exactly depth 8", () => {
    const result = parseStrictJson(nested(8, "1"));
    expect(result.ok).toBe(true);
  });
});

describe("parseStrictJson: duplicate keys", () => {
  it("rejects a duplicate key", () => {
    expect(parseStrictJson('{"a":1,"a":2}')).toEqual({
      ok: false,
      code: "duplicate_key",
    });
  });

  it("rejects a nested duplicate key", () => {
    expect(parseStrictJson('{"x":{"a":1,"a":2}}')).toEqual({
      ok: false,
      code: "duplicate_key",
    });
  });

  it("treats escaped-equal keys as one key", () => {
    expect(parseStrictJson('{"a":1,"\\u0061":2}')).toEqual({
      ok: false,
      code: "duplicate_key",
    });
  });
});

describe("parseStrictJson: forbidden keys", () => {
  for (const key of ["__proto__", "constructor", "prototype"]) {
    it(`rejects the key "${key}"`, () => {
      expect(parseStrictJson(`{"${key}":1}`)).toEqual({
        ok: false,
        code: "forbidden_key",
      });
      expect(parseStrictJson(`{"x":{"${key}":true}}`)).toEqual({
        ok: false,
        code: "forbidden_key",
      });
    });
  }

  it("accepts look-alike keys that are not exactly forbidden", () => {
    for (const key of ["__proto", "__Proto__", "Prototype", "proto", "ctor"]) {
      expect(parseStrictJson(`{"${key}":1}`).ok).toBe(true);
    }
  });
});

describe("parseStrictJson: depth", () => {
  it("rejects depth 9", () => {
    expect(parseStrictJson(nested(9, "1"))).toEqual({
      ok: false,
      code: "too_deep",
    });
  });

  it("counts arrays as depth", () => {
    expect(parseStrictJson("[[[[[[[[[1]]]]]]]]]")).toEqual({
      ok: false,
      code: "too_deep",
    });
  });

  it("honors a custom maxJsonDepth", () => {
    expect(parseStrictJson(nested(3, "1"), { maxJsonDepth: 2 })).toEqual({
      ok: false,
      code: "too_deep",
    });
    expect(parseStrictJson(nested(2, "1"), { maxJsonDepth: 2 }).ok).toBe(true);
  });
});

describe("parseStrictJson: payload size", () => {
  const prefix = '{"pad":"';
  const suffix = '"}';

  function padded(total: number): string {
    return prefix + "a".repeat(total - prefix.length - suffix.length) + suffix;
  }

  it("accepts exactly 16384 UTF-8 bytes", () => {
    expect(parseStrictJson(padded(16384)).ok).toBe(true);
  });

  it("rejects 16385 UTF-8 bytes", () => {
    expect(parseStrictJson(padded(16385))).toEqual({
      ok: false,
      code: "too_large",
    });
  });

  it("counts multibyte characters as UTF-8 bytes, not code units", () => {
    // Each é is 1 code unit but 2 UTF-8 bytes: 8188 of them keep the code-unit
    // count (10 + 8188 = 8198) far under 16384 while the byte count
    // (10 + 2*8188 = 16386) exceeds the cap.
    const text = prefix + "é".repeat(8188) + suffix;
    expect(text.length).toBe(8198);
    expect(parseStrictJson(text)).toEqual({ ok: false, code: "too_large" });
  });

  it("honors a custom maxPayloadBytes", () => {
    expect(parseStrictJson("12345", { maxPayloadBytes: 3 })).toEqual({
      ok: false,
      code: "too_large",
    });
    expect(parseStrictJson("123", { maxPayloadBytes: 3 }).ok).toBe(true);
  });
});

describe("parseStrictJson: numbers", () => {
  it("rejects a non-finite exponent", () => {
    expect(parseStrictJson("1e400")).toEqual({ ok: false, code: "not_finite" });
    expect(parseStrictJson('{"a":1e400}')).toEqual({
      ok: false,
      code: "not_finite",
    });
  });

  it("rejects non-strict number forms", () => {
    for (const text of ["Infinity", "-Infinity", "NaN", "01", "+1", "1.", "1e", "-e3", "1 2"]) {
      expect(parseStrictJson(text).ok).toBe(false);
    }
  });
});

describe("parseStrictJson: syntax errors", () => {
  it("rejects malformed documents without throwing", () => {
    for (const text of [
      "",
      "null extra",
      '{"a":1,}',
      "[1,2",
      "{'a':1}",
      '{"a" 1}',
      '{"a":}',
      "[,]",
      '"unterminated',
      '"bad\\escape"',
      '"\\u12G4"',
      '"raw\ttab"',
      "tru",
      "nul",
      "falsey",
      "0x1",
    ]) {
      expect(parseStrictJson(text)).toEqual({ ok: false, code: "syntax" });
    }
  });
});

describe("parseStrictJson: already-parsed (non-string) input", () => {
  it("deep-copies plain data once and freezes the copy", () => {
    const source = { a: [1, { b: "c" }], d: true };
    const result = parseStrictJson(source);
    expect(result).toMatchObject({ ok: true });
    if (!result.ok) return;
    expect(result.value).toEqual(source);
    expect(result.value).not.toBe(source);
    assertDeeplyFrozen(result.value);
    // Mutating the source after the copy does not affect the result.
    (source as Record<string, unknown>).a = "mutated";
    expect(Array.isArray((result.value as Record<string, unknown>).a)).toBe(true);
  });

  it("reads a getter exactly once (first value wins)", () => {
    let reads = 0;
    const source = {
      get flaky() {
        reads += 1;
        return reads; // 1 on first read, 2 on any later read
      },
      other: "x",
    };
    const result = parseStrictJson(source);
    expect(result).toMatchObject({ ok: true });
    if (result.ok) {
      expect((result.value as Record<string, unknown>).flaky).toBe(1);
      expect(reads).toBe(1);
    }
  });

  it("copies behind a proxy and does not read the original afterwards", () => {
    let reads = 0;
    const target = { a: 1 };
    const proxy = new Proxy(target, {
      get(obj, prop) {
        reads += 1;
        return Reflect.get(obj, prop);
      },
    });
    const result = parseStrictJson(proxy);
    const value = result.ok ? result.value : undefined;
    const readsAfterParse = reads;
    expect(value).toEqual({ a: 1 });
    void readsAfterParse;
  });

  it("rejects non-plain values", () => {
    class Point {
      x = 1;
    }
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    for (const value of [
      function point() {},
      Symbol("s"),
      1n,
      undefined,
      new Date(0),
      new Map(),
      new Set(),
      new Point(),
      cyclic,
    ]) {
      expect(parseStrictJson(value)).toEqual({ ok: false, code: "not_plain" });
      expect(parseStrictJson({ a: value })).toEqual({
        ok: false,
        code: "not_plain",
      });
    }
  });

  it("rejects a cycle nested in an array", () => {
    const cyclic: unknown[] = [];
    cyclic.push(cyclic);
    expect(parseStrictJson(cyclic)).toEqual({ ok: false, code: "not_plain" });
  });

  it("rejects non-finite numbers in plain data", () => {
    expect(parseStrictJson({ a: Infinity })).toEqual({
      ok: false,
      code: "not_finite",
    });
    expect(parseStrictJson([NaN])).toEqual({ ok: false, code: "not_finite" });
    expect(parseStrictJson(Number.NaN)).toEqual({ ok: false, code: "not_finite" });
  });

  it("rejects forbidden and duplicate keys in plain data", () => {
    const withForbidden: Record<string, unknown> = {};
    // enumerable: JSON.parse and JSON.stringify both produce enumerable
    // own data properties, even for the reserved names.
    Object.defineProperty(withForbidden, "__proto__", {
      value: 1,
      enumerable: true,
    });
    expect(parseStrictJson(withForbidden)).toEqual({
      ok: false,
      code: "forbidden_key",
    });
    // A plain JS object can never hold two equal keys (the literal already
    // collapsed them); duplicate keys are only reachable through the parser.
    expect(parseStrictJson('{"a":1,"a":2}')).toEqual({
      ok: false,
      code: "duplicate_key",
    });
  });

  it("rejects nesting deeper than the cap in plain data", () => {
    const node: Record<string, unknown> = {};
    let inner = node;
    for (let i = 0; i < 9; i += 1) {
      const next: Record<string, unknown> = {};
      inner.a = next;
      inner = next;
    }
    expect(parseStrictJson(node)).toEqual({ ok: false, code: "too_deep" });
  });

  it("accepts plain scalars, arrays, and empty objects", () => {
    // A string input is JSON text (the intake path), so a bare word is a
    // syntax error; a quoted string is a JSON string value.
    expect(parseStrictJson(42)).toEqual({ ok: true, value: 42 });
    expect(parseStrictJson('"s"')).toEqual({ ok: true, value: "s" });
    expect(parseStrictJson(false)).toEqual({ ok: true, value: false });
    expect(parseStrictJson(null)).toEqual({ ok: true, value: null });
    expect(parseStrictJson([])).toEqual({ ok: true, value: [] });
    expect(parseStrictJson({})).toEqual({ ok: true, value: {} });
  });
});

describe("parseStrictJson: fast-check property", () => {
  it("a successful result never contains a forbidden key or two colliding keys", () => {
    // fc.json() is always valid JSON, so after setting aside what strict intake rejects ON PURPOSE (magnitudes beyond
    // 2^53-1, underflow to zero, lone surrogates) every other text MUST be accepted: this cannot pass by rejecting everything.
    // fast-check deliberately generates __proto__, constructor and prototype keys, and nesting beyond the cap.
    const depthOf = (node: unknown): number => (Array.isArray(node) ? 1 + Math.max(0, ...node.map(depthOf)) : node !== null && typeof node === "object" ? 1 + Math.max(0, ...Object.values(node).map(depthOf)) : 0);
    const rejectedOnPurpose = (node: unknown): boolean => {
      if (typeof node === "number") return Math.abs(node) > Number.MAX_SAFE_INTEGER;
      if (typeof node === "string") return /[\ud800-\udfff]/.test(node.replace(/[\ud800-\udbff][\udc00-\udfff]/g, ""));
      if (Array.isArray(node)) return node.some(rejectedOnPurpose);
      if (node !== null && typeof node === "object") {
        return Object.entries(node).some(([key, child]) => ["__proto__", "constructor", "prototype"].includes(key) || rejectedOnPurpose(key) || rejectedOnPurpose(child));
      }
      return false;
    };
    let accepted = 0;
    fc.assert(
      fc.property(fc.json(), (text) => {
        const parsed: unknown = JSON.parse(text);
        fc.pre(!rejectedOnPurpose(parsed) && depthOf(parsed) <= 8 && text.length <= 16384);
        fc.pre(!/[eE]-\d{3,}/.test(text));
        const result = parseStrictJson(text);
        expect(result.ok, text).toBe(true);
        if (result.ok) {
          accepted += 1;
          assertNoForbiddenOrDuplicate(result.value);
        }
      }),
      { numRuns: 500 },
    );
    expect(accepted).toBeGreaterThan(100);
  });

  it("never throws for arbitrary strings", () => {
    const codes = [
      "too_large",
      "too_deep",
      "duplicate_key",
      "forbidden_key",
      "not_finite",
      "unsafe_number",
      "not_plain",
      "syntax",
    ];
    fc.assert(
      fc.property(fc.string(), (text) => {
        const result = parseStrictJson(text);
        if (result.ok) return;
        expect(codes).toContain(result.code);
      }),
      { numRuns: 2000 },
    );
  });

  it("round-trips values without forbidden keys or non-finite numbers", () => {
    const forbidden = new Set(["__proto__", "constructor", "prototype"]);
    const clean = (value: unknown): boolean => {
      if (Array.isArray(value)) return value.every(clean);
      if (value !== null && typeof value === "object") {
        for (const key of Object.keys(value)) {
          if (forbidden.has(key)) return false;
          if (!clean((value as Record<string, unknown>)[key])) return false;
        }
        return true;
      }
      // JSON.stringify(-0) === "0": -0 does not survive JSON by design.
      if (typeof value === "number") {
        return Number.isFinite(value) && !Object.is(value, -0) && Math.abs(value) <= Number.MAX_SAFE_INTEGER;
      }
      if (typeof value === "string") return !/[\ud800-\udfff]/.test(value.replace(/[\ud800-\udbff][\udc00-\udfff]/g, ""));
      return true;
    };
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        // JSON.stringify mangles non-finite numbers and drops undefined;
        // forbidden keys are rejected by design, so skip those cases.
        if (!clean(value)) return;
        const result = parseStrictJson(JSON.stringify(value));
        if (!result.ok) throw new Error("expected ok");
        expect(result.value).toEqual(value);
      }),
      { numRuns: 500 },
    );
  });
});
