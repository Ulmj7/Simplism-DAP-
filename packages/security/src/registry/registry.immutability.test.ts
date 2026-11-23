import { describe, expect, it } from "vitest";
import type { ActionId, AnyActionDefinition, ExecutorId, PageId, PermissionId } from "@dap/contracts";
import { z } from "zod";
import { buildRegistry } from "./build-registry.js";
import { bindExecutors } from "./bind-executors.js";
import { definitionHash } from "./definition-hash.js";
import { inspectInputSchema } from "./schema-rules.js";
import { definition, executor } from "./fixtures.test-support.js";

describe("immutable startup registry", () => {
  it("exposes a frozen registry and list without any mutation methods", () => {
    const registry = buildRegistry([definition()]);
    expect(Object.isFrozen(registry)).toBe(true);
    for (const name of ["register", "remove", "replace", "set", "delete", "clear"]) {
      expect(registry).not.toHaveProperty(name);
    }
    expect(Object.isFrozen(registry.list())).toBe(true);
    expect(() => Reflect.set(registry, "fingerprint", "changed")).not.toThrow();
    expect(Reflect.set(registry, "fingerprint", "changed")).toBe(false);
    expect(registry.fingerprint).toMatch(/^[a-f0-9]{64}$/);
    expect(registry.list()[0]).toBe(registry.get("viewProject"));
  });

  it.each([
    "ViewProject", "viewproject", "viewProject ", " viewProject", "viewProject\n", "viewProject\u200b",
    "vіewProject", "viеwProject", "viewProjéct", "viewProje\u0301ct", "ｖiewProject",
    "__proto__", "constructor", "toString", "hasOwnProperty", "prototype",
  ])("does not match look-alike or prototype key %j", (id) => {
    const registry = buildRegistry([definition()]);
    expect(registry.get("viewProject")?.definition.id).toBe("viewProject");
    expect(registry.get(id)).toBeUndefined();
  });

  it("classification is lenient but can never grant lookup", () => {
    const registry = buildRegistry([]);
    for (const name of ["executeShell", "EXECUTE_SHELL", " execute-shell! ", "executeScript", "executeSQL", "fetchUrl", "clickSelector", "getToken", "disableAudit", "changePermissions"]) {
      expect(registry.isReservedForbidden(name)).toBe(true);
      expect(registry.get(name)).toBeUndefined();
    }
    expect(registry.isReservedForbidden("viewProject")).toBe(false);
  });

  it.each([
    "executeShell", "runShell", "executeJavaScript", "queryDatabase", "fetchAnyUrl", "clickAnySelector",
    "typeAnySelector", "getPassword", "disableAudit", "changeOwnPermissions", "grantPermission",
  ])("classifies catalogue power %s and separator variants as forbidden", (name) => {
    const registry = buildRegistry([]);
    expect(registry.isReservedForbidden(name)).toBe(true);
    expect(registry.isReservedForbidden([...name.toUpperCase()].join("_-"))).toBe(true);
    expect(registry.get(name)).toBeUndefined();
  });

  it("snapshots the input array, definitions and all policy objects without freezing inputs", () => {
    const pages = ["projects" as PageId];
    const confirmation = { kind: "not-required" as const, justification: "Read only" };
    const rule = { path: "/name", mode: "masked" as "plain" | "masked" };
    const audit = { params: [rule] };
    const input = { ...definition({ allowedPages: pages, confirmation, audit }) };
    const inputs: AnyActionDefinition[] = [input];
    const registry = buildRegistry(inputs);
    const hash = registry.fingerprint;
    inputs.length = 0;
    input.id = "changedId" as ActionId;
    input.risk = "LOW";
    pages.push("other" as PageId);
    confirmation.justification = "Changed";
    rule.mode = "plain";
    audit.params.length = 0;
    const entry = registry.get("viewProject");
    expect(entry).toBeDefined();
    expect(entry?.definition).toMatchObject({
      id: "viewProject", risk: "SAFE", allowedPages: ["projects"],
      confirmation: { kind: "not-required", justification: "Read only" },
      audit: { params: [{ path: "/name", mode: "masked" }] },
    });
    for (const value of [entry, entry?.definition, entry?.definition.allowedPages, entry?.definition.confirmation,
      entry?.definition.audit, entry?.definition.audit.params, entry?.definition.audit.params[0]]) {
      expect(Object.isFrozen(value)).toBe(true);
    }
    expect(registry.fingerprint).toBe(hash);
    expect(registry.get("changedId")).toBeUndefined();
  });

  it("detaches and freezes the runtime schema, preserving transforms and rejecting extra keys", () => {
    const field = z.string().max(10).transform((value) => value.trim());
    const inputSchema = z.strictObject({ name: field, tags: z.array(z.string().max(4)).max(2).optional() });
    const registered = buildRegistry([definition({ inputSchema })]).get("viewProject")!;
    const captured = registered.definition.inputSchema;
    expect(captured).not.toBe(inputSchema);
    expect(Object.isFrozen(captured)).toBe(true);
    expect(captured.parse({ name: " ok " })).toEqual({ name: "ok" });
    expect(captured.safeParse({ name: "ok", extra: true }).success).toBe(false);
    expect(captured.safeParse({ name: "way too long a name" }).success).toBe(false);
    Reflect.set(inputSchema.def.shape, "name", z.string());
    Reflect.set(field.def.in.def.checks![0]!._zod.def, "maximum", 1000);
    expect(captured.safeParse({ name: "way too long a name" }).success).toBe(false);
    expect(captured.parse({ name: " ok ", tags: ["tag"] })).toEqual({ name: "ok", tags: ["tag"] });
    const json = z.toJSONSchema(captured, { io: "input", unrepresentable: "throw" });
    expect(json.properties?.name).toMatchObject({ type: "string", maxLength: 10 });
    expect(Object.isFrozen(captured.def)).toBe(true);
    expect(Reflect.set(captured.def, "type", "any")).toBe(false);
  });

  it("reads each accessor/Proxy field once and uses the same snapshot for checks, hashes and handout", () => {
    const counts = new Map<PropertyKey, number>();
    const first = definition();
    const proxy = new Proxy(first, {
      get(target, key, receiver) {
        const count = (counts.get(key) ?? 0) + 1;
        counts.set(key, count);
        if (count > 1) throw new Error(`Repeated read: ${String(key)}`);
        return Reflect.get(target, key, receiver);
      },
    });
    const pages = ["projects" as PageId];
    let pageReads = 0;
    Object.defineProperty(pages, "0", { get: () => (++pageReads === 1 ? "projects" : "other"), configurable: true });
    const confirmation = { kind: "not-required" as const };
    let confirmationReads = 0;
    Object.defineProperty(confirmation, "kind", { get: () => (++confirmationReads === 1 ? "not-required" : "required") });
    const guarded = new Proxy(proxy, {
      get(target, key, receiver) {
        const value: unknown = Reflect.get(target, key, receiver);
        return key === "allowedPages" ? pages : key === "confirmation" ? confirmation : value;
      },
    });
    const registry = buildRegistry([guarded]);
    expect(registry.get(first.id)?.definition.allowedPages).toEqual(["projects"]);
    expect(registry.get(first.id)?.definition.confirmation).toEqual({ kind: "not-required" });
    expect([...counts.values()]).not.toContain(2);
    expect(pageReads).toBe(1);
    expect(confirmationReads).toBe(1);
    expect(registry.fingerprint).toBe(buildRegistry([definition()]).fingerprint);
  });

  it("reads shared nested policy objects only once across definitions", () => {
    let reads = 0;
    const confirmation = { get kind() { reads += 1; if (reads > 1) throw new Error("repeat"); return "not-required" as const; } };
    expect(buildRegistry([definition({ confirmation }), definition({ id: "viewOther" as ActionId, confirmation })]).list()).toHaveLength(2);
    expect(reads).toBe(1);
  });

  it.each([
    ["refine", z.string().max(20).refine((value) => value === "allowed")],
    ["superRefine", z.string().max(20).superRefine((value, context) => {
      if (value !== "allowed") context.addIssue({ code: "custom", message: "not allowed" });
    })],
    ["check function", z.string().max(20).check((context) => {
      if (context.value !== "allowed") context.issues.push({ code: "custom", message: "not allowed", input: context.value });
    })],
    ["regular expression", z.string().max(20).regex(/^allowed$/g)],
  ])("preserves %s validation in its frozen schema", (_name, field) => {
    const captured = buildRegistry([definition({ inputSchema: z.strictObject({ name: field }) })]).get("viewProject")!.definition.inputSchema;
    expect(captured.safeParse({ name: "allowed" }).success).toBe(true);
    expect(captured.safeParse({ name: "denied" }).success).toBe(false);
    expect(captured.safeParse({ name: "allowed" }).success).toBe(true);
    expect(Object.isFrozen(captured.def)).toBe(true);
  });

  it("captures a lazy resolver once and preserves recursive schemas", () => {
    let resolutions = 0;
    const child = z.strictObject({ name: z.string().max(10) });
    const lazy = z.lazy(() => { resolutions += 1; return resolutions === 1 ? child : z.object({}); });
    const captured = buildRegistry([definition({ inputSchema: z.strictObject({ child: lazy }) })]).get("viewProject")!.definition.inputSchema;
    expect(captured.safeParse({ child: { name: "ok" } }).success).toBe(true);
    expect(captured.safeParse({ child: { name: "ok", extra: true } }).success).toBe(false);
    expect(resolutions).toBe(1);

    const recursive = z.strictObject({
      name: z.string().max(10),
      get children() { return z.array(recursive).max(2).optional(); },
    });
    const recursiveCaptured = buildRegistry([definition({ inputSchema: recursive })]).get("viewProject")!.definition.inputSchema;
    expect(recursiveCaptured.safeParse({ name: "root", children: [{ name: "leaf" }] }).success).toBe(true);
    expect(recursiveCaptured.safeParse({ name: "root", children: [{ name: "leaf", extra: true }] }).success).toBe(false);
  });

  it("does not hand out mutable schemas through schema authoring methods", () => {
    const captured = buildRegistry([definition()]).get("viewProject")!.definition.inputSchema;
    for (const schema of [captured.brand(), captured.optional(), captured.clone()]) {
      expect(Object.isFrozen(schema)).toBe(true);
      expect(Object.isFrozen(schema.def)).toBe(true);
      expect(Reflect.set(schema.def, "type", "any")).toBe(false);
    }
    expect(captured.safeParse({ projectId: "id", name: "ok", extra: true }).success).toBe(false);
  });

  it("does not expose its working parser through callbacks or raw Zod issue instances", () => {
    const captured = buildRegistry([definition()]).get("viewProject")!.definition.inputSchema;
    const bypass = (schema: z.core.$ZodType): void => {
      Reflect.set(schema._zod, "run", (payload: z.core.ParsePayload) => payload);
    };
    captured.apply((schema) => { bypass(schema); });
    expect(captured.safeParse({ extra: true }).success).toBe(false);
    captured.safeParse({ extra: true }, { error: (issue) => { if (issue.inst instanceof z.core.$ZodType) bypass(issue.inst); } });
    expect(captured.safeParse({ extra: true }).success).toBe(false);
    const payload = captured._zod.run({ value: { extra: true }, issues: [] }, {});
    expect(payload).not.toBeInstanceOf(Promise);
    if (!(payload instanceof Promise)) {
      for (const issue of payload.issues) if (issue.inst instanceof z.core.$ZodType) bypass(issue.inst);
    }
    expect(captured.safeParse({ extra: true }).success).toBe(false);
  });

  it("captures schema annotations and hashes them without retaining live metadata", () => {
    const metadata = { description: "Original description" };
    const inputSchema = z.strictObject({ name: z.string().max(10).describe("A name") }).meta(metadata);
    const registered = buildRegistry([definition({ inputSchema })]).get("viewProject")!;
    const captured = registered.definition.inputSchema;
    metadata.description = "Mutated description";
    expect(captured.description).toBe("Original description");
    expect(z.toJSONSchema(captured, { io: "input" }).properties?.name).toHaveProperty("description", "A name");
    const changed = buildRegistry([definition({ inputSchema: inputSchema.describe("Other description") })]).get("viewProject")!;
    expect(changed.definitionHash).not.toBe(registered.definitionHash);
  });

  it("does not allow RegExp.compile to mutate a registered validator", () => {
    const inputSchema = z.strictObject({ name: z.string().max(20).regex(/^allowed$/) });
    const captured = buildRegistry([definition({ inputSchema })]).get("viewProject")!.definition.inputSchema as typeof inputSchema;
    const check = captured.def.shape.name.def.checks![1]!;
    const pattern = Reflect.get(check._zod.def, "pattern") as RegExp;
    expect(captured.safeParse({ name: "denied" }).success).toBe(false);
    expect(() => pattern.compile(".*")).toThrow(TypeError);
    expect(captured.safeParse({ name: "denied" }).success).toBe(false);
    expect(captured.safeParse({ name: "allowed" }).success).toBe(true);
  });

  it("fingerprint is independent of definition order and changes with content", () => {
    const first = definition();
    const second = definition({ id: "viewOther" as ActionId });
    const fingerprint = buildRegistry([first, second]).fingerprint;
    expect(buildRegistry([second, first]).fingerprint).toBe(fingerprint);
    expect(buildRegistry([first]).fingerprint).not.toBe(fingerprint);
    expect(buildRegistry([first, { ...second, version: 2 }]).fingerprint).not.toBe(fingerprint);
    expect(buildRegistry([]).fingerprint).toMatch(/^[a-f0-9]{64}$/);
  });

  it.each([
    ["id", { id: "viewOther" as ActionId }], ["version", { version: 2 }], ["risk", { risk: "LOW" as const }],
    ["requiredPermission", { requiredPermission: "project:list" as PermissionId }],
    ["allowedPages", { allowedPages: "any" as const }],
    ["confirmation", { confirmation: { kind: "required" as const } }],
    ["changesState", { changesState: true }],
    ["inputSchemaJson", { inputSchema: z.strictObject({ projectId: z.string().max(63) }) }],
    ["inputSchemaJson annotations", { inputSchema: definition().inputSchema.describe("A schema description") }],
  ])("definitionHash binds the %s field", (_field, changes) => {
    const before = definition();
    const after = { ...before, ...changes };
    const beforeJson = inspectInputSchema(before.inputSchema).inputSchemaJson!;
    const afterJson = inspectInputSchema(after.inputSchema).inputSchemaJson!;
    expect(definitionHash(after, afterJson)).not.toBe(definitionHash(before, beforeJson));
  });

  it("executor table snapshots its inputs and uses exact Map lookups", () => {
    const implementation = { ...executor() };
    const implementations = [implementation];
    const table = bindExecutors(buildRegistry([definition()]), implementations);
    implementations.length = 0;
    implementation.id = "changed" as ExecutorId;
    const captured = table.executorFor("viewProjectExecutor" as ExecutorId);
    expect(captured?.id).toBe("viewProjectExecutor");
    expect(Object.isFrozen(table)).toBe(true);
    expect(Object.isFrozen(captured)).toBe(true);
    for (const id of ["__proto__", "constructor", "toString", "hasOwnProperty", "ViewProjectExecutor", "viewProjectExecutor "]) {
      expect(table.executorFor(id as ExecutorId)).toBeUndefined();
    }
  });

  it("reads executor getters once and retains the defineExecutor grant guard", async () => {
    const original = executor();
    const counts = new Map<PropertyKey, number>();
    const hostile = new Proxy(original, {
      get(target, key, receiver) {
        const count = (counts.get(key) ?? 0) + 1;
        counts.set(key, count);
        if (count > 1) throw new Error("repeat");
        return Reflect.get(target, key, receiver);
      },
    });
    const table = bindExecutors(buildRegistry([definition()]), [hostile]);
    const captured = table.executorFor("viewProjectExecutor" as ExecutorId)!;
    expect(captured.id).toBe("viewProjectExecutor");
    await expect(captured.execute(undefined as unknown as Parameters<typeof captured.execute>[0])).rejects.toThrow();
    expect(counts.get("id")).toBe(1);
    expect(counts.get("execute")).toBe(1);
  });
});
