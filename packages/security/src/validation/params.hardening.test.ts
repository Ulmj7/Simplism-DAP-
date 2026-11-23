/**
 * @dap/security: validation/params.hardening.test.ts
 *
 * T063. Parameter validation and the parameter digest, checked as a trust boundary: what the model can reach
 * (the input) is judged, what later stages may use (the normalized output) is frozen, copied once and bound to
 * the action, the tenant and the user. Written to fail if any one of those properties is dropped.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineAction } from "@dap/contracts";
import type { ActionId, ExecutorId, PermissionId, ResourceRef } from "@dap/contracts";
import { buildRegistry } from "../registry/build-registry.js";
import { sha256Canonical } from "./canonical.js";
import { paramsDigest, validateParams } from "./params.js";

const TENANT = "00000000-0000-4000-8000-000000000001";
const USER = "alice";
const scope = { tenantId: TENANT, userId: USER };

const schema = z.strictObject({
  name: z.string().max(5),
  count: z.number().int().min(1).max(3),
  tags: z.array(z.string().max(2)).max(2),
  nested: z.strictObject({ x: z.number().min(0).max(5) }),
  email: z.string().max(20).regex(/^\S+@\S+$/).optional(),
  pick: z.union([z.string().max(3), z.number().min(0).max(9)]).optional(),
  "a/b~c": z.number().min(0).max(9).optional(),
});
const good = () => ({ name: "ok", count: 2, tags: ["a"], nested: { x: 1 } });

function define<T>(inputSchema: z.ZodType<T>, extra: { id?: string; version?: number; resource?: (params: never) => ResourceRef | null } = {}) {
  return defineAction({
    id: (extra.id ?? "probeAction") as ActionId, version: extra.version ?? 1, description: "probe", inputSchema, risk: "SAFE", requiredPermission: "probe:view" as PermissionId,
    allowedPages: "any", confirmation: { kind: "not-required" }, changesState: false, audit: { params: [] }, executorId: "probeExecutor" as ExecutorId,
    ...(extra.resource ? { resource: extra.resource as never } : {}),
  });
}
const base = define(schema);
const registered = buildRegistry([base]).get("probeAction")!.definition;
const run = (params: unknown, definition = registered) => validateParams(definition, params, scope);
const issues = (params: unknown) => { const result = run(params); if (result.ok) throw new Error("expected issues"); return result.issues.map((issue) => [issue.path, issue.code]); };

describe("a valid proposal", () => {
  it("returns the normalized output, deeply frozen, with a digest and no resource", () => {
    const result = run(good());
    if (!result.ok) throw new Error("expected success");
    expect(result.normalized).toEqual(good());
    expect(result.resource).toBeNull();
    expect(result.paramsDigest).toMatch(/^[a-f0-9]{64}$/);
    expect(Object.isFrozen(result)).toBe(true);
    const walk = (node: unknown): void => { if (node && typeof node === "object") { expect(Object.isFrozen(node)).toBe(true); Object.values(node).forEach(walk); } };
    walk(result.normalized);
    expect(() => { (result.normalized as { name: string }).name = "changed"; }).toThrow(TypeError);
  });

  it("works against both a raw definition and the registry's frozen view of it", () => {
    expect(run(good(), base)).toEqual(run(good(), registered));
  });

  it("returns an independent copy: later changes to the input never reach the result", () => {
    const input = good();
    const result = run(input);
    input.tags.push("zz");
    input.nested.x = 5;
    if (!result.ok) throw new Error("expected success");
    expect(result.normalized).toEqual(good());
    expect(result.normalized).not.toBe(input);
  });

  it("returns the schema's OUTPUT, not its input: only the normalized value is ever used", () => {
    const withDefault = define(z.strictObject({ name: z.string().max(5), n: z.number().int().min(0).max(9).default(7), label: z.string().max(5).transform((value) => value.toUpperCase()) }));
    const result = validateParams(withDefault, { name: "x", label: "abc" }, scope);
    if (!result.ok) throw new Error("expected success");
    expect(result.normalized).toEqual({ name: "x", n: 7, label: "ABC" });
  });
});

describe("the parameter digest", () => {
  const input = good();
  const digest = (overrides: Partial<Parameters<typeof paramsDigest>[0]> = {}) => paramsDigest({ actionId: "probeAction", version: 1, params: input, resource: null, tenantId: TENANT, userId: USER, ...overrides });

  it("is SHA-256 over canonical JSON of {actionId, version, params, resource, tenant, user}, exactly", () => {
    const result = run(good());
    if (!result.ok) throw new Error("expected success");
    expect(result.paramsDigest).toBe(sha256Canonical({ actionId: "probeAction", version: 1, params: good(), resource: null, tenant: TENANT, user: USER }));
    expect(result.paramsDigest).toBe(digest());
  });

  it.each([
    ["the action", { actionId: "otherAction" }], ["the version", { version: 2 }], ["the params", { params: { ...input, count: 3 } }],
    ["the resource", { resource: { type: "project", id: "p1" } }], ["the tenant", { tenantId: "00000000-0000-4000-8000-000000000002" }], ["the user", { userId: "bob" }],
  ])("changes when %s changes", (_label, change) => {
    expect(digest(change as never)).not.toBe(digest());
  });

  it("changes with the resource id and type separately, and treats no resource differently from any resource", () => {
    expect(digest({ resource: { type: "project", id: "p1" } })).not.toBe(digest({ resource: { type: "project", id: "p2" } }));
    expect(digest({ resource: { type: "project", id: "p1" } })).not.toBe(digest({ resource: { type: "folder", id: "p1" } }));
  });

  it("does not depend on key order", () => {
    expect(digest({ params: { a: 1, b: { c: 2, d: 3 } } })).toBe(digest({ params: { b: { d: 3, c: 2 }, a: 1 } }));
  });

  it("cannot be forged by moving a value between fields", () => {
    expect(digest({ actionId: "a", userId: "bc" })).not.toBe(digest({ actionId: "ab", userId: "c" }));
    expect(paramsDigest({ actionId: "x", version: 1, params: { tenant: TENANT }, resource: null, tenantId: "t1", userId: "u" })).not.toBe(paramsDigest({ actionId: "x", version: 1, params: {}, resource: null, tenantId: "t1", userId: "u" }));
  });

  it.each([
    ["no action", { actionId: "" }], ["a numeric action", { actionId: 7 }], ["version 0", { version: 0 }], ["a fractional version", { version: 1.5 }], ["a string version", { version: "1" }],
    ["no tenant", { tenantId: "" }], ["no user", { userId: "" }], ["an undefined tenant", { tenantId: undefined }], ["a resource that is not null or {type,id}", { resource: {} }],
    ["a resource with an extra key", { resource: { type: "p", id: "1", owner: "x" } }], ["a resource with an empty id", { resource: { type: "p", id: "" } }], ["a string resource", { resource: "project/1" }],
    ["undefined params", { params: undefined }], ["NaN params", { params: { n: NaN } }], ["function params", { params: { f: () => 1 } }], ["negative zero", { params: { n: -0 } }],
  ])("refuses to digest %s", (_label, change) => {
    expect(() => digest(change as never)).toThrow(TypeError);
  });

  it("is injective on the fields it binds (property)", () => {
    fc.assert(fc.property(fc.string({ minLength: 1, maxLength: 8 }), fc.string({ minLength: 1, maxLength: 8 }), fc.string({ minLength: 1, maxLength: 8 }), fc.string({ minLength: 1, maxLength: 8 }), (a, b, c, d) => {
      fc.pre(a !== c || b !== d);
      expect(digest({ tenantId: a, userId: b })).not.toBe(digest({ tenantId: c, userId: d }));
    }), { numRuns: 100 });
  });
});

describe("the resource extractor", () => {
  const withResource = (extractor: (params: never) => unknown) => define(schema, { resource: extractor as never });

  it("is called exactly once, on the normalized frozen parameters, and its answer is bound by the digest", () => {
    const seen: unknown[] = [];
    const definition = withResource((params) => { seen.push(params); return { type: "project", id: "p1" }; });
    const result = validateParams(definition, good(), scope);
    if (!result.ok) throw new Error("expected success");
    expect(seen).toHaveLength(1);
    expect(Object.isFrozen(seen[0])).toBe(true);
    expect(result.resource).toEqual({ type: "project", id: "p1" });
    expect(Object.isFrozen(result.resource)).toBe(true);
    expect(result.paramsDigest).toBe(paramsDigest({ actionId: "probeAction", version: 1, params: good(), resource: { type: "project", id: "p1" }, tenantId: TENANT, userId: USER }));
  });

  it("sees the normalized OUTPUT (defaults and transforms applied), never the raw input", () => {
    const seen: unknown[] = [];
    const definition = define(z.strictObject({ name: z.string().max(5), n: z.number().int().min(0).max(9).default(7) }), { resource: ((params: unknown) => { seen.push(params); return null; }) as never });
    validateParams(definition, { name: "x" }, scope);
    expect(seen).toEqual([{ name: "x", n: 7 }]);
  });

  it("is not called at all when the parameters are invalid", () => {
    let calls = 0;
    const definition = withResource(() => { calls += 1; return null; });
    expect(validateParams(definition, { ...good(), count: 99 }, scope).ok).toBe(false);
    expect(calls).toBe(0);
  });

  it.each([undefined, null])("treats an extractor answer of %j as no resource", (answer) => {
    const result = validateParams(withResource(() => answer), good(), scope);
    expect(result).toMatchObject({ ok: true, resource: null });
  });

  it.each([
    ["a string", "project/1"], ["a missing id", { type: "project" }], ["a missing type", { id: "1" }], ["an extra key", { type: "p", id: "1", owner: "x" }], ["empty text", { type: "", id: "" }],
    ["non-text parts", { type: 1, id: 2 }], ["an array", ["project", "1"]], ["a class instance", new (class Ref { type = "p"; id = "1"; })()], ["NaN", Number.NaN], ["a function", () => 1],
  ])("rejects an extractor that returns %s as a defect, never as a resource", (_label, answer) => {
    expect(() => validateParams(withResource(() => answer), good(), scope)).toThrow(TypeError);
  });

  it("reads the extractor's answer once, and propagates an extractor that throws", () => {
    let reads = 0;
    const result = validateParams(withResource(() => ({ get type() { reads += 1; return reads === 1 ? "project" : "other"; }, id: "1" })), good(), scope);
    expect(result).toMatchObject({ ok: true, resource: { type: "project", id: "1" } });
    expect(reads).toBe(1);
    expect(() => validateParams(withResource(() => { throw new Error("extractor down"); }), good(), scope)).toThrow("extractor down");
  });
});

describe("issues: paths and generic codes, never values", () => {
  it.each([
    ["a missing key", (() => { const { count: _count, ...rest } = good(); void _count; return rest; })(), [["/count", "required"]]],
    ["a missing nested value", { ...good(), nested: {} }, [["/nested/x", "required"]]],
    ["a string where a number belongs", { ...good(), count: "2" }, [["/count", "type"]]],
    ["an array where an object belongs", { ...good(), nested: [] }, [["/nested", "type"]]],
    ["a number where text belongs", { ...good(), name: 5 }, [["/name", "type"]]],
    ["null where a value belongs", { ...good(), name: null }, [["/name", "type"]]],
    ["an extra top-level key", { ...good(), role: "admin" }, [["", "unknown_key"]]],
    ["an extra nested key", { ...good(), nested: { x: 1, extra: 1 } }, [["/nested", "unknown_key"]]],
    ["an extra key three levels deep", { ...good(), nested: { x: 1, deeper: { deepest: { oops: 1 } } } }, [["/nested", "unknown_key"]]],
    ["an oversized string", { ...good(), name: "toolongvalue" }, [["/name", "too_long"]]],
    ["an array that is too long", { ...good(), tags: ["a", "b", "c"] }, [["/tags", "too_many"]]],
    ["an element that is too long", { ...good(), tags: ["abc"] }, [["/tags/0", "too_long"]]],
    ["a number below its range", { ...good(), count: 0 }, [["/count", "out_of_range"]]],
    ["a number above its range", { ...good(), nested: { x: 99 } }, [["/nested/x", "out_of_range"]]],
    ["a fractional integer", { ...good(), count: 1.5 }, [["/count", "type"]]],
    ["a malformed format", { ...good(), email: "not an email" }, [["/email", "format"]]],
    ["a union with no matching branch", { ...good(), pick: true }, [["/pick", "invalid"]]],
  ])("%s", (_label, input, expected) => {
    expect(issues(input)).toEqual(expected);
  });

  it("reports one issue where several refinements fail at the same path with the same code", () => {
    const twice = define(z.strictObject({ s: z.string().max(5).refine(() => false).refine(() => false) }));
    const result = validateParams(twice, { s: "ab" }, scope);
    if (result.ok) throw new Error("expected issues");
    expect(result.issues).toEqual([{ path: "/s", code: "invalid" }]);
  });

  it("escapes pointer syntax in schema keys", () => {
    expect(issues({ ...good(), "a/b~c": 99 })).toEqual([["/a~1b~0c", "out_of_range"]]);
  });

  it.each(["tenantId", "userId", "role", "confirmed", "isAdmin", "permissions", "sessionId"])("rejects the identity-like key %s at any depth (ATK-PARAMS-11)", (key) => {
    expect(issues({ ...good(), [key]: "x" })).toEqual([["", "unknown_key"]]);
    expect(issues({ ...good(), nested: { x: 1, [key]: "x" } })).toEqual([["/nested", "unknown_key"]]);
  });

  it("reports every distinct problem once, in a stable order, and many unknown keys as one issue", () => {
    expect(issues({ name: "toolongvalue", count: 0, tags: ["a", "b", "c"], nested: { x: "s", a: 1, b: 2 }, c: 1, d: 2 })).toEqual([
      ["/name", "too_long"], ["/count", "out_of_range"], ["/tags", "too_many"], ["/nested/x", "type"], ["/nested", "unknown_key"], ["", "unknown_key"],
    ]);
  });

  it("never reflects a value, a message or a model-authored key", () => {
    const hostile = { name: "CANARY_VALUE_1234", count: "CANARY_COUNT", tags: [{ CANARY_KEY: 1 }], nested: { x: 1, CANARY_NESTED_KEY: "CANARY_NESTED_VALUE" }, CANARY_TOP_KEY: "CANARY_TOP_VALUE", email: "CANARY@x" };
    const result = run(hostile);
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("CANARY");
    if (!result.ok) for (const issue of result.issues) expect(Object.keys(issue).sort()).toEqual(["code", "path"]);
  });

  it("caps the list and freezes it", () => {
    const wide = define(z.strictObject({ items: z.array(z.string().max(1)).max(500) }));
    const result = validateParams(wide, { items: Array.from({ length: 200 }, () => "toolong") }, scope);
    if (result.ok) throw new Error("expected issues");
    expect(result.issues).toHaveLength(64);
    expect(Object.isFrozen(result.issues) && result.issues.every((issue) => Object.isFrozen(issue))).toBe(true);
    expect(new Set(result.issues.map((issue) => issue.path)).size).toBe(64);
  });

  it("uses only the eight generic codes", () => {
    const allowed = new Set(["required", "type", "unknown_key", "too_long", "too_many", "out_of_range", "format", "invalid"]);
    const strange = define(z.strictObject({ a: z.string().max(3).refine(() => false), b: z.literal("x"), c: z.number().multipleOf(2).min(0).max(9), d: z.enum(["p", "q"]) }));
    const result = validateParams(strange, { a: "ab", b: "y", c: 3, d: "z" }, scope);
    if (result.ok) throw new Error("expected issues");
    for (const issue of result.issues) expect(allowed.has(issue.code)).toBe(true);
  });
});

describe("hostile input is copied once and judged by strict intake first (ATK-PARAMS-12)", () => {
  it("reads each getter once and validates the copy, so what is checked is what is returned", () => {
    let reads = 0;
    const input = { get name() { reads += 1; return reads === 1 ? "ok" : "toolongvalue"; }, count: 2, tags: [], nested: { x: 1 } };
    const result = run(input);
    expect(reads).toBe(1);
    expect(result).toMatchObject({ ok: true, normalized: { name: "ok" } });
  });

  it("reads a Proxy's traps once per key and never writes through it", () => {
    const counts = new Map<string, number>();
    const target = good();
    const watched = new Proxy(target, {
      get(object, key, receiver) { counts.set(String(key), (counts.get(String(key)) ?? 0) + 1); return Reflect.get(object, key, receiver); },
      set() { throw new Error("must not write"); }, deleteProperty() { throw new Error("must not delete"); },
    });
    expect(run(watched).ok).toBe(true);
    for (const [key, count] of counts) expect(count, key).toBe(1);
  });

  it.each([
    ["a JSON text string", '{"name":"ok","count":2,"tags":[],"nested":{"x":1}}', "type"], ["a forbidden key", Object.defineProperty({ ...good() }, "__proto__", { value: {}, enumerable: true }), "unknown_key"],
    ["a constructor key", { ...good(), constructor: 1 }, "unknown_key"], ["NaN", { ...good(), count: NaN }, "out_of_range"], ["Infinity", { ...good(), count: Infinity }, "out_of_range"],
    ["an unsafe integer", { ...good(), count: 2 ** 60 }, "out_of_range"], ["a class instance", new (class Params { name = "ok"; })(), "type"], ["undefined", undefined, "type"], ["a symbol key", { ...good(), [Symbol("s")]: 1 }, "type"],
    ["a function value", { ...good(), name: () => "ok" }, "type"], ["a bigint", { ...good(), count: 2n }, "type"], ["a hole in an array", { ...good(), tags: [, "a"] }, "type"],
    ["a null prototype is fine, but a foreign prototype is not", Object.create({ inherited: 1 }), "type"],
  ])("rejects %s without throwing", (_label, input, code) => {
    const result = run(input);
    expect(result).toEqual({ ok: false, issues: [{ path: "", code }] });
  });

  it("rejects a cycle and a nesting beyond the depth cap, without throwing or overflowing", () => {
    const cyclic: Record<string, unknown> = { ...good() }; cyclic.nested = cyclic;
    expect(run(cyclic)).toEqual({ ok: false, issues: [{ path: "", code: "type" }] });
    let deep: unknown = 1;
    for (let i = 0; i < 50_000; i += 1) deep = [deep];
    expect(run({ ...good(), tags: deep })).toEqual({ ok: false, issues: [{ path: "", code: "out_of_range" }] });
  });

  it("applies the configured caps and refuses an invalid cap", () => {
    expect(validateParams(registered, good(), scope, { maxPayloadBytes: 10 })).toEqual({ ok: false, issues: [{ path: "", code: "too_long" }] });
    expect(validateParams(registered, good(), scope, { maxJsonDepth: 1 })).toEqual({ ok: false, issues: [{ path: "", code: "out_of_range" }] });
    expect(validateParams(registered, good(), scope, { maxPayloadBytes: 16_384, maxJsonDepth: 8 }).ok).toBe(true);
    expect(() => validateParams(registered, good(), scope, { maxPayloadBytes: 0 })).toThrow(RangeError);
    expect(() => validateParams(registered, good(), scope, { maxJsonDepth: Number.NaN })).toThrow(RangeError);
  });

  it("never throws for arbitrary values", () => {
    fc.assert(fc.property(fc.anything({ withBigInt: true, withDate: true, withMap: true, withSet: true, withNullPrototype: true, withTypedArray: true, withSparseArray: true, withBoxedValues: true, withObjectString: true }), (anything) => {
      const result = run(anything);
      if (result.ok) expect(Object.isFrozen(result.normalized) || typeof result.normalized !== "object").toBe(true);
    }), { numRuns: 300 });
  });
});

describe("defects in the definition are programmer errors, not planner feedback", () => {
  it.each([
    ["a transform to a Date", z.strictObject({ at: z.string().max(10).transform((value) => new Date(value)) }), { at: "2026-01-01" }],
    ["a transform to a class instance", z.strictObject({ at: z.string().max(10).transform(() => new (class Box { n = 1; })()) }), { at: "x" }],
    ["a transform to NaN", z.strictObject({ n: z.number().min(0).max(9).transform(() => Number.NaN) }), { n: 1 }],
    ["a transform to a function", z.strictObject({ n: z.number().min(0).max(9).transform(() => () => 1) }), { n: 1 }],
    ["a transform to undefined", z.strictObject({ n: z.number().min(0).max(9).transform(() => undefined) }), { n: 1 }],
    ["a transform past the payload cap", z.strictObject({ n: z.number().min(0).max(9).transform(() => "x".repeat(20_000)) }), { n: 1 }],
  ])("throws for %s", (_label, inputSchema, input) => {
    expect(() => validateParams(define(inputSchema as never), input, scope)).toThrow(/normalized output must be plain JSON data/);
  });

  it("lets a throwing refinement propagate, and refuses an asynchronous schema", () => {
    expect(() => validateParams(define(z.strictObject({ n: z.number().min(0).max(9).refine(() => { throw new Error("refine down"); }) }) as never), { n: 1 }, scope)).toThrow("refine down");
    expect(() => validateParams(define(z.strictObject({ n: z.number().min(0).max(9).refine(async () => true) }) as never), { n: 1 }, scope)).toThrow();
  });

  it.each([
    ["no schema", { ...base, inputSchema: undefined }], ["a schema without safeParse", { ...base, inputSchema: {} }], ["no id", { ...base, id: "" }], ["a non-numeric version", { ...base, version: "1" }],
  ])("throws for %s", (_label, definition) => {
    expect(() => validateParams(definition as never, good(), scope)).toThrow(TypeError);
  });

  it.each([
    ["no tenant", { tenantId: "", userId: USER }], ["no user", { tenantId: TENANT, userId: "" }], ["numeric ids", { tenantId: 1, userId: 2 }], ["missing ids", {}],
  ])("throws for a scope with %s, so a digest can never be under-bound", (_label, bad) => {
    expect(() => validateParams(registered, good(), bad as never)).toThrow(TypeError);
  });

  it("reports a bad scope as a defect even when the parameters are also invalid", () => {
    expect(() => validateParams(registered, { not: "valid" }, { tenantId: "", userId: USER })).toThrow(TypeError);
  });

  it("reads the scope once", () => {
    let reads = 0;
    const result = validateParams(registered, good(), { get tenantId() { reads += 1; return reads === 1 ? TENANT : "other"; }, userId: USER });
    expect(result).toMatchObject({ ok: true, paramsDigest: paramsDigest({ actionId: "probeAction", version: 1, params: good(), resource: null, tenantId: TENANT, userId: USER }) });
  });
});

/**
 * Guards a mutation sweep found unpinned: each case below fails if the guard named in its title is removed or
 * weakened. Stand-in schemas are used where a real schema cannot reach the branch (a JSON input has no Set, and
 * no real schema reports a missing parent), so the guard itself is judged.
 */
describe("guards pinned by mutation testing", () => {
  const fake = (safeParse: () => unknown) => ({ ...registered, inputSchema: { safeParse } }) as never;
  const reporting = (...found: object[]) => fake(() => ({ success: false, error: { issues: found } }));
  const typeIssue = (...path: string[]) => ({ code: "invalid_type", path });

  describe("the caller's scope and the definition are rejected with their own reason", () => {
    it.each([["no tenant", { tenantId: "", userId: USER }], ["no user", { tenantId: TENANT, userId: "" }], ["a non-text tenant", { tenantId: 5, userId: USER }], ["a non-text user", { tenantId: TENANT, userId: 5 }]])(
      "%s", (_name, bad) => {
        expect(() => validateParams(registered, good(), bad as never)).toThrow("Parameters are validated for a tenant and a user");
      });

    it.each([
      ["no id", { ...registered, id: "" }], ["a non-text id", { ...registered, id: 7 }], ["a non-numeric version", { ...registered, version: "1" }], ["no version", { ...registered, version: undefined }],
      ["a null schema", { ...registered, inputSchema: null }], ["a schema that is not an object", { ...registered, inputSchema: "schema" }], ["a schema without safeParse", { ...registered, inputSchema: {} }],
      ["a schema whose safeParse is not a function", { ...registered, inputSchema: { safeParse: 1 } }], ["a function that carries a safeParse", { ...registered, inputSchema: Object.assign(() => 1, { safeParse: () => ({ success: true, data: {} }) }) }],
    ])("%s", (_name, bad) => {
      expect(() => validateParams(bad as never, good(), scope)).toThrow("Cannot validate against a malformed definition");
    });
  });

  describe("paramsDigest judges every part of the resource", () => {
    const resourceDigest = (resource: unknown) => () => paramsDigest({ actionId: "probeAction", version: 1, params: {}, resource: resource as never, tenantId: TENANT, userId: USER });
    it.each([["an empty type", { type: "", id: "x" }], ["a non-text type", { type: 1, id: "x" }], ["an empty id", { type: "x", id: "" }], ["a non-text id", { type: "x", id: 1 }], ["a missing id", { type: "x" }]])("rejects %s", (_name, resource) => {
      expect(resourceDigest(resource)).toThrow("A parameter digest needs a resource");
    });
    it("still accepts null and a well-formed resource", () => {
      expect(resourceDigest(null)()).toMatch(/^[a-f0-9]{64}$/);
      expect(resourceDigest({ type: "x", id: "y" })()).toMatch(/^[a-f0-9]{64}$/);
    });
  });

  describe("an extractor's answer is judged on its own, with its own reason", () => {
    const ANSWER = "A resource extractor must return { type, id } or null";
    it.each([
      ["JSON text for a resource", '{"type":"p","id":"1"}'], ["the text null", "null"], ["a number", 5], ["true", true], ["an array of two", ["p", "1"]], ["an empty array", []], ["an empty object", {}],
      ["an empty type", { type: "", id: "1" }], ["a non-text type", { type: 1, id: "1" }], ["an empty id", { type: "p", id: "" }], ["a non-text id", { type: "p", id: 1 }], ["an extra key", { type: "p", id: "1", x: 1 }],
      ["an object that is not plain data", new Date()], ["a value strict intake refuses", { type: "p", id: "1", n: Number.NaN }],
    ])("rejects %s", (_name, answer) => {
      expect(() => validateParams(define(schema, { resource: (() => answer) as never }), good(), scope)).toThrow(ANSWER);
    });
  });

  describe("issue codes", () => {
    it("distinguishes an absent value from a present one, at any depth", () => {
      const where = (input: unknown, ...path: string[]) => { const result = validateParams(reporting(typeIssue(...path)), input, scope); return result.ok ? null : result.issues.map((issue) => issue.code); };
      expect(where({}, "a")).toEqual(["required"]);
      expect(where({ a: 1 }, "a")).toEqual(["type"]);
      expect(where({ a: {} }, "a", "b")).toEqual(["required"]);
      expect(where({ a: { b: 1 } }, "a", "b")).toEqual(["type"]);
      expect(where({}, "ghost", "x")).toEqual(["type"]); // an absent PARENT is not the missing value
      expect(where({ a: null }, "a", "b")).toEqual(["type"]); // nor is a null one
      expect(where({ a: "text" }, "a", "b")).toEqual(["type"]); // nor a scalar one
      expect(where({}, "toString")).toEqual(["required"]); // only own properties count as present
      expect(where({}, "constructor")).toEqual(["required"]);
      expect(where({ a: 1 }, ...[])).toEqual(["type"]); // the root itself is never "missing"
    });

    it("collapses an exact duplicate, but keeps two codes at one path and one code at two paths", () => {
      const tooBig = { code: "too_big", origin: "string", path: ["a"] };
      const format = { code: "invalid_format", path: ["a"] };
      // Real declared fields keep this assertion about distinct STRUCTURAL paths, not invented paths.
      const codes = (...found: object[]) => {
        const schema = z.strictObject({ a: z.string().max(5).optional(), b: z.string().max(5).optional() }).superRefine((_params, ctx) => {
          for (const issue of found) ctx.addIssue({ ...issue, message: "synthetic diagnostic" } as never);
        });
        const result = validateParams(define(schema), {}, scope);
        return result.ok ? null : result.issues.map((issue) => `${issue.path}:${issue.code}`);
      };
      expect(codes(tooBig, tooBig)).toEqual(["/a:too_long"]);
      expect(codes(tooBig, format)).toEqual(["/a:too_long", "/a:format"]);
      expect(codes(tooBig, { ...tooBig, path: ["b"] })).toEqual(["/a:too_long", "/b:too_long"]);
    });

    it("maps a number that is not a multiple to out_of_range", () => {
      const definition = define(z.strictObject({ n: z.number().multipleOf(5) }));
      const result = validateParams(definition, { n: 7 }, scope);
      expect(result).toMatchObject({ ok: false, issues: [{ path: "/n", code: "out_of_range" }] });
    });

    it("reports a rejection that carries no issues as an empty list, never as success", () => {
      expect(validateParams(fake(() => ({ success: false })), {}, scope)).toEqual({ ok: false, issues: [] });
    });
  });

  describe("a rejection is frozen all the way down", () => {
    const walk = (node: unknown): void => { if (node && typeof node === "object") { expect(Object.isFrozen(node)).toBe(true); Object.values(node).forEach(walk); } };
    it.each([["a schema rejection", { ...good(), count: 99, name: 5 }], ["an input that strict intake refuses", { n: Number.NaN }], ["text instead of an object", "{}"]])("%s", (_name, params) => {
      const result = validateParams(registered, params, scope);
      expect(result.ok).toBe(false);
      walk(result);
      if (result.ok) throw new Error("expected a rejection");
      expect(result.issues.length).toBeGreaterThan(0);
      expect(() => { (result.issues as unknown as { path: string }[])[0]!.path = "/forged"; }).toThrow(TypeError);
    });
  });

  describe("what the schema sees and what is bound", () => {
    it("holds the schema's OUTPUT to the configured caps, not only its input", () => {
      const deep = { a: { b: { c: { d: 1 } } } };
      const definition = fake(() => ({ success: true, data: deep }));
      expect(validateParams(definition, {}, scope, { maxJsonDepth: 8 })).toMatchObject({ ok: true });
      expect(() => validateParams(definition, {}, scope, { maxJsonDepth: 3 })).toThrow("A schema's normalized output must be plain JSON data");
    });

    it("never touches the caller's object again after the single copy, not even to classify an issue", () => {
      const touched: PropertyKey[] = [];
      const hostile = new Proxy({ name: "ok", count: 2, tags: ["a"] } as Record<string, unknown>, {
        getOwnPropertyDescriptor(target, key) { touched.push(key); return Reflect.getOwnPropertyDescriptor(target, key); },
        has(target, key) { touched.push(key); return Reflect.has(target, key); },
        get(target, key) { touched.push(key); return Reflect.get(target, key); },
      });
      const result = validateParams(registered, hostile, scope); // `nested` is required and absent
      expect(result).toMatchObject({ ok: false, issues: [{ path: "/nested", code: "required" }] });
      expect(touched).not.toContain("nested");
    });

    it("digests the normalized output, not the input", () => {
      const definition = define(z.strictObject({ name: z.string().trim().min(1).max(5), n: z.number().int().min(0).max(9).default(7) }));
      const result = validateParams(definition, { name: "  ab  " }, scope);
      if (!result.ok) throw new Error("expected success");
      expect(result.normalized).toEqual({ name: "ab", n: 7 });
      expect(result.paramsDigest).toBe(paramsDigest({ actionId: "probeAction", version: 1, params: { name: "ab", n: 7 }, resource: null, tenantId: TENANT, userId: USER }));
      expect(result.paramsDigest).not.toBe(paramsDigest({ actionId: "probeAction", version: 1, params: { name: "  ab  " }, resource: null, tenantId: TENANT, userId: USER }));
    });
  });
});
