/** Studio COMPLETION S4 without a database: the grammar, the derived name and the closed shapes of verification checks. The PostgreSQL proof is tests/integration/studio-checks-*.test.ts. */
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CHECK_ATTRIBUTES, CHECK_ISSUE_PHRASES, CHECK_KINDS, CHECK_NAME_PATTERN, checkName, checkStatusInputSchema, isCheckName, registerCheckInputSchema, toBundleCheck, validateCheckRegistration } from "./registry-checks.js";

const APP = "app-0123456789ab";
const ok = (input: unknown) => {
  const result = validateCheckRegistration(input);
  if (!result.ok) throw new Error(`expected ok: ${result.issues.join("; ")}`);
  return result.value;
};
const issues = (input: unknown): readonly string[] => {
  const result = validateCheckRegistration(input);
  if (result.ok) throw new Error("expected issues");
  return result.issues;
};

describe("the derived name", () => {
  it("is `check.v` + the first 10 hex of the SHA-256 of the canonical JSON {kind,targetId,route,attribute,expected}, null when absent (independent recomputation)", () => {
    const canonical = '{"kind":"element.text.equals","targetId":"orders.status","route":null,"attribute":null,"expected":"Order placed"}';
    const expected = `check.v${createHash("sha256").update(canonical).digest("hex").slice(0, 10)}`;
    expect(checkName({ kind: "element.text.equals", targetId: "orders.status", route: null, attribute: null, expected: "Order placed" })).toBe(expected);
    expect(expected).toMatch(CHECK_NAME_PATTERN);
    expect(ok({ kind: "element.text.equals", targetId: "orders.status", expected: "Order placed" }).name).toBe(expected);
  });
  it("is stable for the same content, different for any difference, and ignores key order and absent optionals", () => {
    const a = ok({ kind: "element.attribute.equals", targetId: "orders.toggle", attribute: "aria-pressed", expected: "true" });
    const b = ok({ expected: "true", attribute: "aria-pressed", targetId: "orders.toggle", kind: "element.attribute.equals", route: undefined });
    expect(a.name).toBe(b.name);
    for (const other of [{ expected: "false" }, { attribute: "aria-checked" }, { targetId: "orders.other" }]) {
      expect(ok({ kind: "element.attribute.equals", targetId: "orders.toggle", attribute: "aria-pressed", expected: "true", ...other }).name).not.toBe(a.name);
    }
    expect(ok({ kind: "element.visible", targetId: "orders.x" }).name).not.toBe(ok({ kind: "element.hidden", targetId: "orders.x" }).name);
  });
  it("isCheckName accepts only the exact grammar", () => {
    expect(isCheckName("check.v0123456789")).toBe(true);
    for (const bad of ["check.v012345678", "check.v01234567890", "check.vABCDEFGHIJ", "Check.v0123456789", "route.orders", "check.v0123456789 ", 7, null, undefined]) expect(isCheckName(bad), String(bad)).toBe(false);
  });
});

describe("validateCheckRegistration", () => {
  it("accepts each of the six kinds with exactly its fields and freezes the result with null for the absent ones", () => {
    const cases: [unknown, Record<string, unknown>][] = [
      [{ kind: "route.equals", route: "orders" }, { kind: "route.equals", route: "orders", targetId: null, attribute: null, expected: null }],
      [{ kind: "element.visible", targetId: "orders.submit" }, { kind: "element.visible", targetId: "orders.submit", route: null, attribute: null, expected: null }],
      [{ kind: "element.hidden", targetId: "orders.submit" }, { kind: "element.hidden", targetId: "orders.submit", route: null, attribute: null, expected: null }],
      [{ kind: "element.text.equals", targetId: "orders.status", expected: "Done" }, { kind: "element.text.equals", targetId: "orders.status", route: null, attribute: null, expected: "Done" }],
      [{ kind: "element.value.equals", targetId: "orders.note", expected: "hello" }, { kind: "element.value.equals", targetId: "orders.note", route: null, attribute: null, expected: "hello" }],
      [{ kind: "element.attribute.equals", targetId: "orders.toggle", attribute: "disabled", expected: "true" }, { kind: "element.attribute.equals", targetId: "orders.toggle", route: null, attribute: "disabled", expected: "true" }],
    ];
    expect(cases.map(([input]) => (input as { kind: string }).kind).sort()).toEqual([...CHECK_KINDS].sort());
    for (const [input, expected] of cases) {
      const value = ok(input);
      expect(value).toMatchObject(expected);
      expect(Object.isFrozen(value)).toBe(true);
    }
  });
  it("refuses an unknown kind and a non-object with ONE fixed phrase", () => {
    for (const input of [{ kind: "element.click", targetId: "a.b" }, { kind: "eval", expected: "x" }, {}, null, "x", 5, [], { kind: 1 }]) expect(issues(input).length).toBe(1);
    expect(issues({ kind: "element.click" })).toEqual([CHECK_ISSUE_PHRASES.kind]);
    expect(issues(null)).toEqual([CHECK_ISSUE_PHRASES.shape]);
  });
  it("refuses a field the kind does not carry, and a missing one", () => {
    expect(issues({ kind: "route.equals", route: "orders", targetId: "orders.submit" })).toContain(CHECK_ISSUE_PHRASES.shape);
    expect(issues({ kind: "element.visible", targetId: "orders.submit", expected: "x" })).toContain(CHECK_ISSUE_PHRASES.shape);
    expect(issues({ kind: "element.hidden", targetId: "orders.submit", attribute: "disabled" })).toContain(CHECK_ISSUE_PHRASES.shape);
    expect(issues({ kind: "route.equals" })).toEqual([CHECK_ISSUE_PHRASES.route]);
    expect(issues({ kind: "element.text.equals", targetId: "orders.status" })).toEqual([CHECK_ISSUE_PHRASES.expected]);
    expect(issues({ kind: "element.attribute.equals", targetId: "orders.toggle", expected: "true" })).toEqual([CHECK_ISSUE_PHRASES.attribute]);
  });
  it("enforces the id, route and attribute grammars (reserved ids, odd routes, the attribute allow-list)", () => {
    for (const targetId of ["dap.x", "nope", "orders.", "Orders.x", 5, "", "a.b".repeat(40)]) expect(issues({ kind: "element.visible", targetId }), String(targetId)).toEqual([CHECK_ISSUE_PHRASES.targetId]);
    for (const route of ["Orders", "1orders", "or-ders", "o".repeat(41), "", 5]) expect(issues({ kind: "route.equals", route }), String(route)).toEqual([CHECK_ISSUE_PHRASES.route]);
    for (const attribute of CHECK_ATTRIBUTES) expect(ok({ kind: "element.attribute.equals", targetId: "orders.t", attribute, expected: "true" }).attribute).toBe(attribute);
    for (const attribute of ["onclick", "value", "class", "aria-label", "style", "ARIA-CHECKED", "", 5]) expect(issues({ kind: "element.attribute.equals", targetId: "orders.t", attribute, expected: "true" }), String(attribute)).toEqual([CHECK_ISSUE_PHRASES.attribute]);
  });
  it("bounds the expected value: 1..120 characters (1..40 for an attribute), not blank, no control or bidi characters; the boundary values pass", () => {
    expect(ok({ kind: "element.text.equals", targetId: "orders.t", expected: "x".repeat(120) }).expected).toHaveLength(120);
    expect(ok({ kind: "element.attribute.equals", targetId: "orders.t", attribute: "aria-current", expected: "x".repeat(40) }).expected).toHaveLength(40);
    expect(ok({ kind: "element.value.equals", targetId: "orders.t", expected: " keeps spaces " }).expected).toBe(" keeps spaces ");
    const phrase = [CHECK_ISSUE_PHRASES.expected];
    for (const expected of ["x".repeat(121), "", "   ", "\t", "a\nb", "a\u0000b", "a\u007fb", "a\u0085b", "a\u2028b", "a\u2029b", "a\u202eb", "a\u2066b", 5, null]) {
      expect(issues({ kind: "element.text.equals", targetId: "orders.t", expected }), JSON.stringify(expected)).toEqual(phrase);
    }
    expect(issues({ kind: "element.attribute.equals", targetId: "orders.t", attribute: "disabled", expected: "x".repeat(41) })).toEqual(phrase);
  });
  it("never repeats what was supplied in an issue", () => {
    const secret = "S3CRET-expected-value-12345";
    const result = validateCheckRegistration({ kind: "element.attribute.equals", targetId: "orders.t", attribute: secret, expected: secret.repeat(5), extra: secret });
    expect(JSON.stringify(result)).not.toContain(secret);
  });
  it("survives hostile inputs (getters that throw, prototype keys) with a fixed phrase", () => {
    const hostile = { get kind(): string { throw new Error("boom"); } };
    expect(issues(hostile)).toEqual([CHECK_ISSUE_PHRASES.shape]);
    expect(issues({ kind: "element.visible", targetId: "orders.t", __proto__: { expected: "x" }, constructor: 1 })).toContain(CHECK_ISSUE_PHRASES.shape);
  });
});

describe("the capability inputs", () => {
  it("registerCheck is strict: the fields of the union only, applicationId required and bounded, a name is not a field", () => {
    expect(registerCheckInputSchema.safeParse({ applicationId: APP, kind: "route.equals", route: "orders" }).success).toBe(true);
    expect(registerCheckInputSchema.safeParse({ applicationId: APP, kind: "element.visible", targetId: "orders.t" }).success).toBe(true);
    for (const bad of [{ kind: "route.equals", route: "orders" }, { applicationId: "nope", kind: "route.equals", route: "orders" }, { applicationId: APP, kind: "route.equals", route: "orders", name: "check.v0123456789" },
      { applicationId: APP, kind: "x".repeat(33) }, { applicationId: APP, kind: "element.text.equals", targetId: "orders.t", expected: "x".repeat(121) }, { applicationId: APP, kind: "element.visible", extra: 1 }]) {
      expect(registerCheckInputSchema.safeParse(bad).success, JSON.stringify(bad)).toBe(false);
    }
  });
  it("setCheckStatus accepts exactly active|disabled", () => {
    expect(checkStatusInputSchema.safeParse({ applicationId: APP, name: "check.v0123456789", status: "disabled" }).success).toBe(true);
    for (const status of ["enabled", "", "ACTIVE", "healthy"]) expect(checkStatusInputSchema.safeParse({ applicationId: APP, name: "check.v0123456789", status }).success, status).toBe(false);
    expect(checkStatusInputSchema.safeParse({ applicationId: APP, name: "check.v0123456789", status: "active", extra: 1 }).success).toBe(false);
  });
});

describe("the closed bundle shapes (the embed reviewer's)", () => {
  const rec = (value: Parameters<typeof ok>[0]) => ({ ...ok(value), status: "active" as const });
  it("route.equals {name,kind,route}; visible/hidden {name,kind,targetId}; text/value {name,kind,targetId,expected}; attribute {name,kind,targetId,attribute,expected}; nothing else", () => {
    const keys = (value: Parameters<typeof ok>[0]) => Object.keys(toBundleCheck(rec(value))).sort();
    expect(keys({ kind: "route.equals", route: "orders" })).toEqual(["kind", "name", "route"]);
    expect(keys({ kind: "element.visible", targetId: "orders.t" })).toEqual(["kind", "name", "targetId"]);
    expect(keys({ kind: "element.hidden", targetId: "orders.t" })).toEqual(["kind", "name", "targetId"]);
    expect(keys({ kind: "element.text.equals", targetId: "orders.t", expected: "x" })).toEqual(["expected", "kind", "name", "targetId"]);
    expect(keys({ kind: "element.value.equals", targetId: "orders.t", expected: "x" })).toEqual(["expected", "kind", "name", "targetId"]);
    expect(keys({ kind: "element.attribute.equals", targetId: "orders.t", attribute: "disabled", expected: "true" })).toEqual(["attribute", "expected", "kind", "name", "targetId"]);
    expect(Object.isFrozen(toBundleCheck(rec({ kind: "route.equals", route: "orders" })))).toBe(true);
  });
});
