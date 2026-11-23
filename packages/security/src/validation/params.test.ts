/**
 * @dap/security: validation/params.test.ts
 *
 * T056. The attack-scenario contract of validateParams / paramsDigest, one test per scenario from the
 * malformed-parameter catalogue (ATK-PARAMS-01..12). Every assertion is written to fail when the property it
 * names is dropped: hostile input is a rejection with generic issues (never an exception, never an echo), the
 * issue path of an unknown key is its PARENT, and only the normalized snapshot is validated, frozen and digested.
 *
 * The planner never sees a parent path for an unknown key (feedback redacts it to the root); that seam is pinned
 * in the last block so the two behaviours cannot drift apart unnoticed.
 */
import { types } from "node:util";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { defineAction } from "@dap/contracts";
import type { ActionId, ExecutorId, PermissionId, ResourceRef } from "@dap/contracts";
import { denyDecision } from "../gateway/decision.js";
import { toPlannerFeedback } from "../gateway/feedback.js";
import { buildRegistry } from "../registry/build-registry.js";
import { paramsDigest, validateParams } from "./params.js";

const TENANT = "00000000-0000-4000-8000-0000000000a1";
const USER = "user-one";
const scope = { tenantId: TENANT, userId: USER };
const CODES = ["required", "type", "unknown_key", "too_long", "too_many", "out_of_range", "format", "invalid"];
const SHA256 = /^[a-f0-9]{64}$/;
type Caps = { maxPayloadBytes?: number; maxJsonDepth?: number };

// The same bounded strict shape the catalogue registers on the target, plus a format field and an escaped key.
const schema = z.strictObject({
  message: z.string().max(200),
  options: z.strictObject({ nested: z.strictObject({ leaf: z.strictObject({ value: z.string().max(20) }) }) }).optional(),
  count: z.number().min(0).max(10).optional(),
  tags: z.array(z.string().max(20)).max(2).optional(),
  email: z.string().max(40).regex(/^\S+@\S+$/).optional(),
  "a/b~c": z.number().max(3).optional(),
});

function define(inputSchema: z.ZodType = schema, resource?: (params: never) => ResourceRef | null) {
  const definition = defineAction({
    id: "probeAction" as ActionId, version: 4, description: "probe", inputSchema, risk: "SAFE", requiredPermission: "probe:view" as PermissionId,
    allowedPages: "any", confirmation: { kind: "not-required" }, changesState: false, audit: { params: [] }, executorId: "probeExecutor" as ExecutorId,
    ...(resource ? { resource: resource as never } : {}),
  });
  return buildRegistry([definition]).get("probeAction")!.definition;
}
const registered = define();

function outcome(params: unknown, options?: Caps, definition = registered) {
  return validateParams(definition, params, scope, options);
}
function success(params: unknown, options?: Caps, definition = registered) {
  const result = outcome(params, options, definition);
  if (!result.ok) throw new Error(`expected success, got ${JSON.stringify(result.issues)}`);
  return result;
}
function failure(params: unknown, options?: Caps, definition = registered) {
  const result = outcome(params, options, definition);
  if (result.ok) throw new Error("expected a rejection");
  return result.issues;
}
function deepFrozen(node: unknown): boolean {
  return node === null || typeof node !== "object" || (Object.isFrozen(node) && Object.values(node).every(deepFrozen));
}

describe("T056 validateParams contract", () => {
  it("accepts valid bounded strict params with a REQUIRED third argument {tenantId,userId}; returns only ok, normalized, resource and paramsDigest", () => {
    const result = success({ message: "hello", count: 3 });
    expect(Object.keys(result).sort()).toEqual(["normalized", "ok", "paramsDigest", "resource"]);
    expect(result).toMatchObject({ ok: true, normalized: { message: "hello", count: 3 }, resource: null });
    expect(result.paramsDigest).toMatch(SHA256);
  });

  it("ATK-PARAMS-01 missing required field returns {ok:false,issues:[{path:'/message',code:'required'}]} without input values", () => {
    const result = outcome({ count: 4 });
    expect(result).toEqual({ ok: false, issues: [{ path: "/message", code: "required" }] });
    expect(JSON.stringify(result)).not.toContain("4");
  });

  it("ATK-PARAMS-02 scalar type mismatch and array-instead-of-object report type at the affected JSON pointer", () => {
    expect(failure({ message: 7 })).toEqual([{ path: "/message", code: "type" }]);
    expect(failure({ message: "ok", count: "1" })).toEqual([{ path: "/count", code: "type" }]);
    expect(failure({ message: "ok", options: [] })).toEqual([{ path: "/options", code: "type" }]);
    expect(failure([])).toEqual([{ path: "", code: "type" }]);
    expect(failure({ message: "ok", tags: { 0: "a" } })).toEqual([{ path: "/tags", code: "type" }]);
  });

  it("ATK-PARAMS-03 extra top-level key reports {path:'',code:'unknown_key'} at its PARENT, without the unknown name or value", () => {
    const result = outcome({ message: "ok", CANARY_KEY: "CANARY_VALUE" });
    expect(result).toEqual({ ok: false, issues: [{ path: "", code: "unknown_key" }] });
    expect(JSON.stringify(result)).not.toContain("CANARY");
  });

  it("ATK-PARAMS-04 extra key nested three levels deep reports unknown_key at its PARENT '/options/nested/leaf'", () => {
    const result = outcome({ message: "ok", options: { nested: { leaf: { value: "ok", CANARY_KEY: true } } } });
    expect(result).toEqual({ ok: false, issues: [{ path: "/options/nested/leaf", code: "unknown_key" }] });
    expect(JSON.stringify(result)).not.toContain("CANARY");
  });

  it("ATK-PARAMS-05 string maximum is inclusive; max+1 reports too_long at the field path", () => {
    expect(success({ message: "x".repeat(200) }).normalized).toEqual({ message: "x".repeat(200) });
    expect(failure({ message: "x".repeat(201) })).toEqual([{ path: "/message", code: "too_long" }]);
    expect(failure({ message: "ok", options: { nested: { leaf: { value: "y".repeat(21) } } } })).toEqual([{ path: "/options/nested/leaf/value", code: "too_long" }]);
  });

  it("ATK-PARAMS-05 array maximum is inclusive; max+1 reports too_many at the array path", () => {
    expect(success({ message: "ok", tags: ["a", "b"] }).normalized).toEqual({ message: "ok", tags: ["a", "b"] });
    expect(failure({ message: "ok", tags: ["a", "b", "c"] })).toEqual([{ path: "/tags", code: "too_many" }]);
  });

  it("ATK-PARAMS-05 numeric endpoints are accepted; below minimum and above maximum report out_of_range", () => {
    expect(success({ message: "ok", count: 0 }).normalized).toEqual({ message: "ok", count: 0 });
    expect(success({ message: "ok", count: 10 }).normalized).toEqual({ message: "ok", count: 10 });
    expect(failure({ message: "ok", count: -1 })).toEqual([{ path: "/count", code: "out_of_range" }]);
    expect(failure({ message: "ok", count: 11 })).toEqual([{ path: "/count", code: "out_of_range" }]);
    expect(failure({ message: "ok", count: 10.000001 })).toEqual([{ path: "/count", code: "out_of_range" }]);
  });

  it("format violations report format; non-finite numbers and other invalid values report only a generic allowed code", () => {
    expect(failure({ message: "ok", email: "not-an-email" })).toEqual([{ path: "/email", code: "format" }]);
    for (const count of [NaN, Infinity, -Infinity, 2 ** 60]) expect(failure({ message: "ok", count })).toEqual([{ path: "", code: "out_of_range" }]);
    for (const value of [1n, Symbol("CANARY"), () => "CANARY", new Date(0), new Map(), undefined]) {
      const issues = failure({ message: "ok", count: value });
      expect(issues).toHaveLength(1);
      expect(CODES).toContain(issues[0]!.code);
      expect(JSON.stringify(issues)).not.toContain("CANARY");
    }
  });

  it("ATK-PARAMS-11 tenantId/userId/role/confirmed/isAdmin are unknown_key at their parent at top-level and nested depth", () => {
    for (const key of ["tenantId", "userId", "role", "confirmed", "isAdmin"]) {
      expect(failure({ message: "ok", [key]: "claimed" })).toEqual([{ path: "", code: "unknown_key" }]);
      expect(failure({ message: "ok", options: { nested: { leaf: { value: "ok", [key]: "claimed" } } } })).toEqual([{ path: "/options/nested/leaf", code: "unknown_key" }]);
    }
  });

  it("all failures expose only path and code drawn from the eight generic codes; no Zod messages, input, stack or custom refinements leak", () => {
    const refined = define(z.strictObject({ message: z.string().max(10) }).superRefine((params, ctx) => {
      ctx.addIssue({ code: "custom", path: [params.message], message: "REFINEMENT_SECRET" });
      ctx.addIssue({ code: "custom", message: "REFINEMENT_SECRET" });
    }));
    const hostile = [
      outcome({ message: 7 }), outcome({ message: "CANARY_VALUE_".repeat(30) }), outcome({ message: "ok", CANARY_KEY: 1 }), outcome("CANARY_TEXT"),
      outcome({ message: "CANARY_VAL" }, undefined, refined), outcome({ get message(): string { throw new Error("CANARY_THROWN"); } }),
    ];
    for (const result of hostile) {
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(Object.isFrozen(result.issues)).toBe(true);
      expect(result.issues.length).toBeGreaterThan(0);
      for (const issue of result.issues) {
        expect(Object.keys(issue).sort()).toEqual(["code", "path"]);
        expect(CODES).toContain(issue.code);
        expect(issue.path).toMatch(/^(\/[A-Za-z0-9_~]+)*$/);
      }
      expect(JSON.stringify(result)).not.toMatch(/CANARY|REFINEMENT_SECRET|Expected|Invalid input|stack|\bat \w/);
    }
    // The refinement's invented path (a model value) and message never reach the issue list.
    expect(outcome({ message: "CANARY_VAL" }, undefined, refined)).toEqual({ ok: false, issues: [{ path: "", code: "invalid" }] });
  });

  it("JSON pointer paths escape '/' as '~1' and '~' as '~0'; array errors use numeric segments", () => {
    expect(failure({ message: "ok", "a/b~c": 9 })).toEqual([{ path: "/a~1b~0c", code: "out_of_range" }]);
    const list = define(z.strictObject({ rows: z.array(z.strictObject({ name: z.string().max(3) })).max(5) }));
    expect(failure({ rows: [{ name: "ok" }, { name: "toolong" }] }, undefined, list)).toEqual([{ path: "/rows/1/name", code: "too_long" }]);
    expect(failure({ rows: [{ name: "ok" }, { name: "ok" }, { name: 3 }] }, undefined, list)).toEqual([{ path: "/rows/2/name", code: "type" }]);
  });

  it("normalization uses the schema output; resource extraction and digest consume that same normalized snapshot", () => {
    const seen: unknown[] = [];
    const shaped = define(
      z.strictObject({ message: z.string().max(20).transform((value) => value.toUpperCase()), count: z.number().int().max(9).default(7) }),
      ((params: { message: string }) => { seen.push(params); return { type: "doc", id: params.message }; }) as never,
    );
    const result = success({ message: "abc" }, undefined, shaped);
    expect(result.normalized).toEqual({ message: "ABC", count: 7 });
    expect(seen).toHaveLength(1);
    expect(seen[0]).toEqual({ message: "ABC", count: 7 });
    expect(result.resource).toEqual({ type: "doc", id: "ABC" });
    expect(result.paramsDigest).toBe(paramsDigest({ actionId: "probeAction", version: 4, params: { message: "ABC", count: 7 }, resource: { type: "doc", id: "ABC" }, ...scope }));
    expect(result.paramsDigest).not.toBe(paramsDigest({ actionId: "probeAction", version: 4, params: { message: "abc" }, resource: { type: "doc", id: "abc" }, ...scope }));
  });

  it("normalized root, nested objects, arrays and resource are deeply frozen and detached; mutating original input cannot change them or their digest", () => {
    const resourceFor = (params: { options: { nested: { leaf: { value: string } } } }) => ({ type: "doc", id: params.options.nested.leaf.value });
    const withResource = define(schema, resourceFor as never);
    const input = { message: "ok", tags: ["a", "b"], options: { nested: { leaf: { value: "v" } } } };
    const result = success(input, undefined, withResource);
    const digest = result.paramsDigest;
    expect(deepFrozen(result)).toBe(true);
    expect(deepFrozen(result.resource)).toBe(true);
    expect(result.normalized).not.toBe(input);
    input.tags.push("c");
    input.options.nested.leaf.value = "changed";
    input.message = "changed";
    expect(result.normalized).toEqual({ message: "ok", tags: ["a", "b"], options: { nested: { leaf: { value: "v" } } } });
    expect(result.resource).toEqual({ type: "doc", id: "v" });
    expect(result.paramsDigest).toBe(digest);
    expect(() => { (result.normalized as { message: string }).message = "x"; }).toThrow(TypeError);
    expect(() => { (result.resource as { id: string }).id = "x"; }).toThrow(TypeError);
  });

  it("ATK-PARAMS-12 getter returning valid data then invalid data is read exactly once; normalized/resource/digest use the first value and input is not frozen", () => {
    let reads = 0;
    const input = { get message() { return ++reads === 1 ? "first" : 7; } };
    const resourceFor = (params: { message: string }) => ({ type: "doc", id: params.message });
    const result = success(input, undefined, define(schema, resourceFor as never));
    expect(reads).toBe(1);
    expect(result.normalized).toEqual({ message: "first" });
    expect(result.resource).toEqual({ type: "doc", id: "first" });
    expect(result.paramsDigest).toBe(paramsDigest({ actionId: "probeAction", version: 4, params: { message: "first" }, resource: { type: "doc", id: "first" }, ...scope }));
    expect(Object.isFrozen(input)).toBe(false);
    expect(Object.getOwnPropertyDescriptor(input, "message")?.get).toBeTypeOf("function");
  });

  it("ATK-PARAMS-12 Proxy returning different data on a second get is read once per field including nested fields; normalized copy is plain frozen data", () => {
    const reads = new Map<string, number>();
    const spy = <T extends object>(target: T, path: string, later: Record<string, unknown>): T => new Proxy(target, {
      get(inner, key, receiver) {
        if (typeof key !== "string") return Reflect.get(inner, key, receiver);
        const name = `${path}/${key}`;
        const count = (reads.get(name) ?? 0) + 1;
        reads.set(name, count);
        return count === 1 ? Reflect.get(inner, key, receiver) : later[key];
      },
    });
    const leaf = spy({ value: "v1" }, "leaf", { value: 99 });
    const nested = spy({ leaf }, "nested", { leaf: null });
    const options = spy({ nested }, "options", { nested: 5 });
    const input = spy({ message: "m1", count: 3, options }, "root", { message: 7, count: "x", options: "bad" });
    const result = success(input);
    expect(result.normalized).toEqual({ message: "m1", count: 3, options: { nested: { leaf: { value: "v1" } } } });
    for (const name of ["root/message", "root/count", "root/options", "options/nested", "nested/leaf", "leaf/value"]) expect(reads.get(name)).toBe(1);
    expect([...reads.values()].every((count) => count === 1)).toBe(true);
    expect(deepFrozen(result.normalized)).toBe(true);
    expect(types.isProxy(result.normalized)).toBe(false);
    expect(Object.getPrototypeOf(result.normalized)).toBe(Object.prototype);
  });

  it("ATK-PARAMS-12 initially invalid getter/Proxy then valid data remains invalid; second-read data never rescues validation", () => {
    let getterReads = 0;
    const getter = { get message() { return ++getterReads === 1 ? 7 : "ok"; } };
    expect(failure(getter)).toEqual([{ path: "/message", code: "type" }]);
    expect(getterReads).toBe(1);
    let proxyReads = 0;
    const proxy = new Proxy({ message: 7 }, { get: (target, key, receiver) => key === "message" ? (++proxyReads === 1 ? 7 : "ok") : Reflect.get(target, key, receiver) });
    expect(failure(proxy)).toEqual([{ path: "/message", code: "type" }]);
    expect(proxyReads).toBe(1);
  });

  it("throwing getter or Proxy trap fails closed with generic issues and never echoes its error message or stack", () => {
    const secret = new Error("CANARY_ERROR_MESSAGE");
    const hostile: unknown[] = [
      { get message(): string { throw secret; } },
      new Proxy({}, { get() { throw secret; } }),
      new Proxy({ message: "ok" }, { ownKeys() { throw secret; } }),
      new Proxy({ message: "ok" }, { getOwnPropertyDescriptor() { throw secret; } }),
      new Proxy({ message: "ok" }, { getPrototypeOf() { throw secret; } }),
      new Proxy([], { get() { throw secret; } }),
    ];
    for (const input of hostile) {
      const result = outcome(input);
      expect(result.ok).toBe(false);
      if (result.ok) continue;
      expect(result.issues.length).toBeGreaterThan(0);
      for (const issue of result.issues) expect(CODES).toContain(issue.code);
      expect(JSON.stringify(result)).not.toMatch(/CANARY|Error|stack|validate/);
    }
  });

  it("optional maxPayloadBytes/maxJsonDepth caps reject oversized/deep object input without values in issues", () => {
    const fits = { message: "ok" };
    expect(success(fits, { maxPayloadBytes: 64, maxJsonDepth: 2 }).normalized).toEqual(fits);
    const big = failure({ message: "CANARY".repeat(40) }, { maxPayloadBytes: 64 });
    expect(big).toEqual([{ path: "", code: "too_long" }]);
    const deep = failure({ message: "ok", options: { nested: { leaf: { value: "CANARY" } } } }, { maxJsonDepth: 3 });
    expect(deep).toEqual([{ path: "", code: "out_of_range" }]);
    expect(JSON.stringify([big, deep])).not.toContain("CANARY");
    // Multibyte text is charged in UTF-8 bytes, not characters: 30 characters of 3 bytes is 90 bytes plus framing.
    expect(failure({ message: "界".repeat(30) }, { maxPayloadBytes: 64 })).toEqual([{ path: "", code: "too_long" }]);
    expect(() => outcome({ message: "ok" }, { maxPayloadBytes: 0 })).toThrow(RangeError);
  });

  it("resource resolver returns typed resource from normalized input; null resource is valid for non-resource action", () => {
    const resolver = (params: { message: string }): ResourceRef => ({ type: "doc", id: `id-${params.message}` });
    const withResource = success({ message: "a" }, undefined, define(schema, resolver as never));
    expect(withResource.resource).toEqual({ type: "doc", id: "id-a" });
    expect(Object.keys(withResource.resource!).sort()).toEqual(["id", "type"]);
    expect(success({ message: "a" }).resource).toBeNull();
    expect(success({ message: "a" }, undefined, define(schema, (() => null) as never)).resource).toBeNull();
    for (const bad of [{ type: "doc" }, { type: "doc", id: "" }, { type: "doc", id: "1", extra: 1 }, "doc/1", 7, { type: 1, id: "1" }]) {
      expect(() => success({ message: "a" }, undefined, define(schema, (() => bad) as never))).toThrow(TypeError);
    }
  });

  it("missing caller scope or invalid tenantId/userId fails closed; compile-time call signature requires argument three", () => {
    const bad: unknown[] = [undefined, null, {}, { tenantId: TENANT }, { userId: USER }, { tenantId: "", userId: USER }, { tenantId: TENANT, userId: "" }, { tenantId: 7, userId: USER }, { tenantId: TENANT, userId: {} }];
    for (const scoped of bad) expect(() => validateParams(registered, { message: "ok" }, scoped as never)).toThrow(TypeError);
    // A malformed scope is a caller defect and is refused even when the params are hostile: no verdict without an identity.
    for (const scoped of bad) for (const hostile of ["CANARY", { message: 7 }, { message: "ok", extra: 1 }]) expect(() => validateParams(registered, hostile, scoped as never), JSON.stringify(scoped)).toThrow(TypeError);
    // @ts-expect-error the third argument is not optional.
    expect(() => validateParams(registered, { message: "ok" })).toThrow(TypeError);
  });
});

describe("T056 paramsDigest contract", () => {
  const base = { actionId: "probeAction", version: 4, params: { a: 1, b: { c: [1, 2], d: "x" } }, resource: null as ResourceRef | null, tenantId: TENANT, userId: USER };

  it("canonical key reordering yields the same 64-lowercase-hex digest for equivalent normalized params/resource and same scope", () => {
    const one = paramsDigest({ ...base, resource: { type: "doc", id: "1" } });
    const two = paramsDigest({ ...base, params: { b: { d: "x", c: [1, 2] }, a: 1 }, resource: { id: "1", type: "doc" } });
    expect(one).toMatch(SHA256);
    expect(two).toBe(one);
  });

  it("changing each of actionId/version/params/resource/tenantId/userId individually changes the digest", () => {
    const reference = paramsDigest(base);
    const variants: Array<Partial<typeof base>> = [
      { actionId: "otherAction" }, { version: 5 }, { params: { a: 2, b: { c: [1, 2], d: "x" } } },
      { resource: { type: "doc", id: "1" } }, { tenantId: "00000000-0000-4000-8000-0000000000a2" }, { userId: "user-two" },
    ];
    const digests = variants.map((change) => paramsDigest({ ...base, ...change }));
    expect(new Set([reference, ...digests]).size).toBe(variants.length + 1);
  });

  it("array reordering changes the digest; object key order does not; null resource differs from a concrete resource", () => {
    expect(paramsDigest({ ...base, params: { list: [1, 2, 3] } })).not.toBe(paramsDigest({ ...base, params: { list: [3, 2, 1] } }));
    expect(paramsDigest({ ...base, params: { x: 1, y: 2 } })).toBe(paramsDigest({ ...base, params: { y: 2, x: 1 } }));
    expect(paramsDigest({ ...base, resource: null })).not.toBe(paramsDigest({ ...base, resource: { type: "doc", id: "1" } }));
    expect(paramsDigest({ ...base, resource: { type: "doc", id: "1" } })).not.toBe(paramsDigest({ ...base, resource: { type: "doc", id: "2" } }));
  });

  it("validateParams success paramsDigest equals paramsDigest over its normalized/resource and required caller scope", () => {
    const resourceFor = (params: { message: string }): ResourceRef => ({ type: "doc", id: params.message });
    const definition = define(schema, resourceFor as never);
    const result = success({ message: "m", count: 2 }, undefined, definition);
    expect(result.paramsDigest).toBe(paramsDigest({ actionId: "probeAction", version: 4, params: result.normalized, resource: result.resource, ...scope }));
    const otherUser = validateParams(definition, { message: "m", count: 2 }, { tenantId: TENANT, userId: "user-two" });
    const otherTenant = validateParams(definition, { message: "m", count: 2 }, { tenantId: "00000000-0000-4000-8000-0000000000a2", userId: USER });
    expect(otherUser.ok && otherUser.paramsDigest).toMatch(SHA256);
    expect(otherUser.ok && otherUser.paramsDigest).not.toBe(result.paramsDigest);
    expect(otherTenant.ok && otherTenant.paramsDigest).toMatch(SHA256);
    expect(otherTenant.ok && otherTenant.paramsDigest).not.toBe(result.paramsDigest);
  });

  it("digest input with getters/Proxy is captured once and later mutations cannot change the captured digest binding", () => {
    let reads = 0;
    const params = { get a() { return ++reads === 1 ? 1 : 999; }, b: 2 };
    const first = paramsDigest({ ...base, params });
    expect(reads).toBe(1);
    expect(first).toBe(paramsDigest({ ...base, params: { a: 1, b: 2 } }));
    let proxyReads = 0;
    const proxy = new Proxy({ a: 1 }, { get: (target, key, receiver) => key === "a" ? (++proxyReads === 1 ? 1 : 2) : Reflect.get(target, key, receiver) });
    expect(paramsDigest({ ...base, params: proxy })).toBe(paramsDigest({ ...base, params: { a: 1 } }));
    expect(proxyReads).toBe(1);
  });
});

describe("T056 reconciliation: validator parent paths versus planner feedback", () => {
  const feedbackFor = (issues: readonly { path: string; code: string }[]) => toPlannerFeedback(denyDecision({
    decisionId: "d1", requestId: "r1" as never, stage: "validate", outcome: "INVALID_PARAMETERS", reason: "invalid_parameters", issues: issues as never,
  }));

  it("the validator keeps the parent path internally, and the planner sees an unknown key at the root, with structural paths intact", () => {
    const inner = failure({ message: "ok", options: { nested: { leaf: { value: "ok", CANARY_KEY: 1 } } } });
    expect(inner).toEqual([{ path: "/options/nested/leaf", code: "unknown_key" }]);
    expect(feedbackFor(inner)).toEqual({ outcome: "INVALID_PARAMETERS", category: "invalid_input", issues: [{ path: "", code: "unknown_key" }] });
    const structural = failure({ message: "ok", options: { nested: { leaf: { value: "x".repeat(21) } } } });
    expect(feedbackFor(structural)).toEqual({ outcome: "INVALID_PARAMETERS", category: "invalid_input", issues: [{ path: "/options/nested/leaf/value", code: "too_long" }] });
  });
});
