import { describe, expect, it } from "vitest";
import type { ActionId, ExecutorId, RegistrationRule, RiskLevel } from "@dap/contracts";
import { z } from "zod";
import { buildRegistry } from "./build-registry.js";
import { bindExecutors } from "./bind-executors.js";
import { RegistrationError } from "./registration-error.js";
import { RESERVED_FORBIDDEN_ACTION_NAMES, RESERVED_PARAMETER_NAMES } from "./reserved-names.js";
import { consequence, definition, executor, malformed, resource } from "./fixtures.test-support.js";

function rejects(rule: RegistrationRule, run: () => unknown): void {
  let error: unknown;
  try { run(); } catch (caught) { error = caught; }
  expect(error).toBeInstanceOf(RegistrationError);
  expect((error as RegistrationError).issues).toEqual(expect.arrayContaining([
    expect.objectContaining({ rule }),
  ]));
}

describe("startup registration rules R1–R12", () => {
  it("R1 accepts a complete definition and preserves its fields", () => {
    const input = definition();
    expect(buildRegistry([input]).get(input.id)?.definition).toMatchObject({
      id: input.id, version: 1, risk: "SAFE", description: input.description,
      requiredPermission: input.requiredPermission, changesState: false,
    });
  });

  it.each([
    ["id", "ab"], ["id", "ViewProject"], ["id", "view-project"], ["id", "a".repeat(65)],
    ["id", "viewProject\n"], ["id", "constructor"], ["id", "toString"], ["id", "hasOwnProperty"],
    ["version", 0], ["version", -1], ["version", 1.5], ["version", NaN], ["version", Infinity],
    ["version", "1"], ["description", "  "], ["requiredPermission", ""], ["risk", "safe"],
    ["risk", "toString"], ["allowedPages", []], ["allowedPages", [""]], ["allowedPages", "all"],
    ["confirmation", { kind: "maybe" }], ["changesState", "false"], ["executorId", ""],
    ["resource", "extractor"], ["describeConsequence", true], ["audit", { params: [{ path: "bad", mode: "plain" }] }],
    ["audit", { params: [{ path: "/name", mode: "raw" }] }], ["extra", true],
  ])("R1 rejects malformed %s = %j", (field, value) => {
    rejects("R1", () => buildRegistry([malformed({ [field as string]: value })]));
  });

  it.each([
    "id", "version", "description", "inputSchema", "risk", "requiredPermission", "allowedPages",
    "confirmation", "changesState", "audit", "executorId",
  ])("R1 rejects missing %s", (field) => {
    const input = { ...definition() };
    Reflect.deleteProperty(input, field);
    rejects("R1", () => buildRegistry([input]));
  });

  it("R1 accepts the exact id boundaries and positive integer versions", () => {
    for (const id of ["abc", `a${"Z".repeat(63)}`]) {
      expect(buildRegistry([definition({ id: id as ActionId, version: 2 })]).get(id)?.definition.version).toBe(2);
    }
  });

  it("R2 accepts distinct exact ids and rejects duplicates", () => {
    const first = definition();
    const second = definition({ id: "viewproject" as ActionId });
    expect(buildRegistry([first, second]).list()).toHaveLength(2);
    rejects("R2", () => buildRegistry([first, { ...first, version: 2 }]));
  });

  it("R3 accepts bounded strict schemas, including nested arrays and optional values", () => {
    const inputSchema = z.strictObject({
      items: z.array(z.strictObject({ name: z.string().max(20).optional() })).max(3),
    });
    const action = buildRegistry([definition({ inputSchema })]).list()[0];
    expect(action?.definition.inputSchema.safeParse({ items: [{ name: "ok" }] }).success).toBe(true);
  });

  it.each([
    ["plain object", z.object({ name: z.string().max(10) })],
    ["unbounded string", z.strictObject({ name: z.string() })],
    ["unbounded array", z.strictObject({ names: z.array(z.string().max(10)) })],
    ["nested plain object", z.strictObject({ child: z.object({ name: z.string().max(10) }) })],
    ["array object", z.strictObject({ children: z.array(z.object({})).max(2) })],
    ["union branch", z.strictObject({ child: z.union([z.strictObject({}), z.object({})]) })],
    ["unrepresentable", z.strictObject({ date: z.date() })],
    ["unconstrained root", z.any()],
    ["unconstrained property", z.strictObject({ value: z.unknown() })],
    ["unconstrained union branch", z.union([z.strictObject({}), z.unknown()])],
    ["metadata spoofing strictness", z.object({}).meta({ additionalProperties: false })],
    ["root catch fallback", z.strictObject({ name: z.string().max(3) }).catch({ name: "ok" })],
    ["nested catch fallback", z.strictObject({ name: z.string().max(3).catch("ok") })],
    ["literal without the required explicit maxLength", z.strictObject({ name: z.literal("open") })],
    ["enum without the required explicit maxLength", z.strictObject({ name: z.enum(["open", "closed"]) })],
    ["fake schema", { parse: () => ({}), safeParse: () => ({ success: true }) }],
  ])("R3 rejects %s", (_name, inputSchema) => {
    rejects("R3", () => buildRegistry([malformed({ inputSchema })]));
  });

  it.each(["userId", "tenantId", "role", "confirmed", "isAdmin", "USER_ID", "TeNaNt-Id", "is_Admin"])
  ("R3 rejects reserved parameter %s at every depth", (name) => {
    const leaf = z.strictObject({ [name]: z.string().max(10) });
    for (const inputSchema of [leaf, z.strictObject({ child: leaf }), z.strictObject({ children: z.array(leaf).max(2) })]) {
      rejects("R3", () => buildRegistry([definition({ inputSchema })]));
    }
  });

  it("R3 covers the complete reserved parameter catalogue with case and separators", () => {
    expect(RESERVED_PARAMETER_NAMES).toEqual([
      "userId", "tenantId", "sessionId", "role", "roles", "permission", "permissions", "isAdmin",
      "confirmed", "confirmation", "confirmationId", "approved", "authorization", "token",
    ]);
    for (const name of RESERVED_PARAMETER_NAMES) {
      const obfuscated = [...name.toUpperCase()].join("_-");
      rejects("R3", () => buildRegistry([definition({ inputSchema: z.strictObject({ [obfuscated]: z.boolean() }) })]));
    }
  });

  it.each(["HIGH", "CRITICAL"] as const)("R4 enforces required confirmation for %s", (risk) => {
    rejects("R4", () => buildRegistry([definition({ risk })]));
    expect(buildRegistry([definition({ risk, confirmation: { kind: "required" }, describeConsequence: consequence })]).list()).toHaveLength(1);
  });

  it("R5 requires confirmation or a nonempty written MEDIUM justification", () => {
    for (const justification of [undefined, "", "  "]) {
      rejects("R5", () => buildRegistry([malformed({ risk: "MEDIUM", confirmation: { kind: "not-required", justification } })]));
    }
    expect(buildRegistry([definition({ risk: "MEDIUM", confirmation: { kind: "not-required", justification: "Only creates a private draft" } })]).list()).toHaveLength(1);
    expect(buildRegistry([definition({ risk: "MEDIUM", confirmation: { kind: "required" }, describeConsequence: consequence })]).list()).toHaveLength(1);
  });

  it.each(["SAFE", "LOW"] as const)("R6 allows read-only %s but rejects state changes", (risk) => {
    expect(buildRegistry([definition({ risk })]).list()).toHaveLength(1);
    rejects("R6", () => buildRegistry([definition({ risk, changesState: true, resource })]));
  });

  it("R7 allows a FORBIDDEN classification entry with no bound executor and rejects a binding", () => {
    const registry = buildRegistry([definition({ risk: "FORBIDDEN" })]);
    expect(bindExecutors(registry, []).executorFor("viewProjectExecutor" as ExecutorId)).toBeUndefined();
    rejects("R7", () => bindExecutors(registry, [executor()]));
  });

  it("rejects every reserved power as a definition id", () => {
    expect(RESERVED_FORBIDDEN_ACTION_NAMES.length).toBeGreaterThan(10);
    for (const name of RESERVED_FORBIDDEN_ACTION_NAMES) {
      rejects("R1", () => buildRegistry([definition({ id: name as ActionId })]));
    }
  });

  it("R8 requires a consequence builder for any required confirmation", () => {
    rejects("R8", () => buildRegistry([definition({ confirmation: { kind: "required" } })]));
    expect(buildRegistry([definition({ confirmation: { kind: "required" }, describeConsequence: consequence })]).list()).toHaveLength(1);
  });

  it("R9 requires a resource extractor for a state-changing action", () => {
    const action = definition({ risk: "MEDIUM", changesState: true, confirmation: { kind: "required" }, describeConsequence: consequence });
    rejects("R9", () => buildRegistry([action]));
    expect(buildRegistry([{ ...action, resource }]).list()).toHaveLength(1);
    expect(buildRegistry([definition({ resource })]).list()).toHaveLength(1);
  });

  it("R10 requires exactly one executor and rejects unused or duplicate executor ids", () => {
    const registry = buildRegistry([definition()]);
    const implementation = executor();
    expect(bindExecutors(registry, [implementation]).executorFor(implementation.id)?.id).toBe(implementation.id);
    rejects("R10", () => bindExecutors(registry, []));
    rejects("R10", () => bindExecutors(registry, [executor(), executor()]));
    rejects("R10", () => bindExecutors(registry, [executor(), executor("unused")]));
  });

  it("R11 only accepts positive integer lifetimes at most the global default", () => {
    for (const confirmationTtlSeconds of [0, -1, 1.5, NaN, Infinity, 301]) {
      rejects("R11", () => buildRegistry([definition({ confirmationTtlSeconds })]));
    }
    for (const confirmationTtlSeconds of [1, 299, 300]) {
      expect(buildRegistry([definition({ confirmationTtlSeconds })]).list()).toHaveLength(1);
    }
    rejects("R11", () => buildRegistry([definition({ confirmationTtlSeconds: 61 })], { confirmationDefaultTtlSeconds: 60 }));
    expect(buildRegistry([definition({ confirmationTtlSeconds: 60 })], { confirmationDefaultTtlSeconds: 60 }).list()).toHaveLength(1);
    for (const confirmationDefaultTtlSeconds of [0, 901, NaN, 1.5, null as unknown as number]) {
      rejects("R11", () => buildRegistry([], { confirmationDefaultTtlSeconds }));
    }
  });

  it.each(["MEDIUM", "HIGH", "CRITICAL", "FORBIDDEN"] as const)("R12 forbids audit opt-outs for %s", (risk: RiskLevel) => {
    const base = { ...definition({ risk, confirmation: { kind: "required" }, describeConsequence: consequence }) };
    expect(buildRegistry([{ ...base, audit: { params: [] } }]).list()).toHaveLength(1);
    for (const audit of [false, undefined, { params: [], enabled: false }]) {
      rejects("R12", () => buildRegistry([{ ...base, audit } as unknown as typeof base]));
    }
  });
});
