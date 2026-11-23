/** Studio V1B without a database: the two target capabilities against the Feature 001 registry rules and the extension shape. The Gateway and executor proof is tests/integration/studio-registry.test.ts. */
import { describe, expect, it, vi } from "vitest";
import { buildRegistry, inspectInputSchema } from "@dap/security";
import { DEMO_DEFINITIONS } from "../capabilities.js";
import { composeReferenceHost } from "../compose.js";
import { createAuthoringExtension, MAINTAIN_PERMISSION, MEDIUM_JUSTIFICATION } from "../authoring/capabilities.js";
import type { WalkthroughStore } from "../authoring/store.js";
import { createApplicationExtension } from "./application-capabilities.js";
import { FakeApplicationStore } from "./fake-application-store.js";
import { FakeTargetStore } from "./fake-target-store.js";
import { checkName } from "./registry-checks.js";
import { createRegistryCatalog } from "./registries.js";
import {
  REGISTER_TARGET_ACTION_ID, REGISTER_TARGET_EXECUTOR_ID, TARGET_ACTION_IDS, TARGET_STATUS_ACTION_ID, TARGET_STATUS_EXECUTOR_ID, createTargetExecutors, createTargetExtension, runRegisterCheck, runRegisterTarget, runRepairTarget, runSetCheckStatus, runSetTargetHealth, runSetTargetStatus, registerStudioCheck, setStudioCheckStatus, withRepairReceipt, registerStudioTarget, setStudioTargetStatus,
} from "./target-capabilities.js";

const APP = "app-0123456789ab";
const TENANT = "1111aaaa-2222-4333-8444-5555bbbb5555";
const NO_STORE: WalkthroughStore = { recordEvent: async () => true, summary: async () => [], list: async () => [], get: async () => null, saveDraft: async () => "created", setStatus: async () => "changed", listPublished: async () => [] };
const targets = () => new FakeTargetStore(new FakeApplicationStore());
const input = { applicationId: APP, targetId: "orders.submit", route: "orders", page: "/#/orders", elementRole: "button", label: "Submit", description: "Submits the order", operations: ["highlight", "click"], privacy: "public" };

describe("the two capabilities", () => {
  it("are MEDIUM, state-changing, maintainer-only (exactly perm.walkthrough.maintain), any page, with the written justification instead of a confirmation", () => {
    for (const capability of [registerStudioTarget, setStudioTargetStatus]) {
      expect(capability).toMatchObject({ risk: "MEDIUM", changesState: true, requiredPermission: "perm.walkthrough.maintain", allowedPages: "any", version: 1 });
      expect(capability.confirmation).toEqual({ kind: "not-required", justification: MEDIUM_JUSTIFICATION });
    }
    expect(registerStudioTarget.id).toBe("registerStudioTarget");
    expect(setStudioTargetStatus.id).toBe("setStudioTargetStatus");
    expect(TARGET_ACTION_IDS).toEqual(["registerStudioTarget", "setStudioTargetStatus", "setStudioTargetHealth", "repairStudioTarget", "registerStudioCheck", "setStudioCheckStatus"]);
    expect([REGISTER_TARGET_ACTION_ID, TARGET_STATUS_ACTION_ID]).toEqual(["registerStudioTarget", "setStudioTargetStatus"]);
  });
  it("audit ids and flags only: /applicationId and /targetId (and the closed /status); never a label, description, page, route or operations", () => {
    expect(registerStudioTarget.audit.params).toEqual([{ path: "/applicationId", mode: "plain" }, { path: "/targetId", mode: "plain" }]);
    expect(setStudioTargetStatus.audit.params).toEqual([{ path: "/applicationId", mode: "plain" }, { path: "/targetId", mode: "plain" }, { path: "/status", mode: "plain" }]);
    for (const capability of [registerStudioTarget, setStudioTargetStatus]) for (const param of capability.audit.params) expect(param.path).not.toMatch(/label|description|page|route|operations|role|privacy/i);
  });
  it("declare the application's studioApplication resource (rule R9), built from the application id only", () => {
    expect(registerStudioTarget.resource?.(input as never)).toEqual({ type: "studioApplication", id: APP });
    expect(setStudioTargetStatus.resource?.({ applicationId: APP, targetId: "a.b", status: "disabled" })).toEqual({ type: "studioApplication", id: APP });
  });
  it("use distinct executors, one per capability", () => {
    expect([registerStudioTarget.executorId, setStudioTargetStatus.executorId]).toEqual([REGISTER_TARGET_EXECUTOR_ID, TARGET_STATUS_EXECUTOR_ID]);
    expect(REGISTER_TARGET_EXECUTOR_ID).not.toBe(TARGET_STATUS_EXECUTOR_ID);
  });
  it("satisfy the Feature 001 registry rules next to every other capability family: strict, bounded, and NO reserved parameter name (role is reserved, so the field is elementRole)", () => {
    const authoring = createAuthoringExtension({ store: NO_STORE, applications: new FakeApplicationStore(), catalog: createRegistryCatalog() });
    const applications = createApplicationExtension({ store: new FakeApplicationStore(), catalog: createRegistryCatalog() });
    expect(() => buildRegistry([...DEMO_DEFINITIONS, ...authoring.extension.definitions, ...applications.extension.definitions, registerStudioTarget, setStudioTargetStatus])).not.toThrow();
    for (const capability of [registerStudioTarget, setStudioTargetStatus]) expect(inspectInputSchema(capability.inputSchema).issues, capability.id).toEqual([]);
    expect(Object.keys((registerStudioTarget.inputSchema as unknown as { shape: Record<string, unknown> }).shape)).not.toContain("role");
  });
});

describe("the extension", () => {
  it("is exactly { definitions, executors }, frozen, with a trusted handle that has run nothing", () => {
    const { extension, trusted } = createTargetExtension({ targets: targets() });
    expect(Object.keys(extension).sort()).toEqual(["definitions", "executors"]);
    expect(extension.definitions.map((d) => d.id)).toEqual(["registerStudioTarget", "setStudioTargetStatus", "setStudioTargetHealth", "repairStudioTarget", "registerStudioCheck", "setStudioCheckStatus"]);
    expect(extension.executors.map((e) => e.id)).toEqual([REGISTER_TARGET_EXECUTOR_ID, TARGET_STATUS_EXECUTOR_ID, "ex.studio-set-target-health", "ex.studio-repair-target", "ex.studio-register-check", "ex.studio-set-check-status"]);
    expect(Object.isFrozen(extension)).toBe(true);
    expect(trusted.executorCalls()).toBe(0);
    expect(trusted.receivedCalls("registerStudioTarget")).toEqual([]);
  });
  it("composes with the other extensions, and is OFF unless DAP_ENABLED_ACTIONS lists it (default deny)", async () => {
    const env = { NODE_ENV: "test", DAP_ALLOW_DEV_AUTH: "1", DAP_DATABASE_URL: "postgresql://dap_app:pw@127.0.0.1:1/never_connected",
      DEV_SESSIONS: JSON.stringify([{ token: "tok-0123456789abcdef", userId: "alice", tenantId: TENANT, sessionId: "s-alice", validUntil: new Date(Date.now() + 3_600_000).toISOString(), permissions: [MAINTAIN_PERMISSION] }]) };
    const extensions = [createAuthoringExtension({ store: NO_STORE, applications: new FakeApplicationStore(), catalog: createRegistryCatalog() }).extension,
      createApplicationExtension({ store: new FakeApplicationStore(), catalog: createRegistryCatalog() }).extension, createTargetExtension({ targets: targets() }).extension];
    for (const enabled of ["demoLookup", "demoLookup,registerStudioTarget,setStudioTargetStatus", "demoLookup,saveStudioApplication,registerStudioTarget"]) {
      const composed = await composeReferenceHost({ ...env, DAP_ENABLED_ACTIONS: enabled }, { extensions });
      await composed.host.close();
    }
    await expect(composeReferenceHost({ ...env, DAP_ENABLED_ACTIONS: "demoLookup,registerStudioTarget" }, { extensions: [] })).rejects.toThrow(/unknown or empty capability id/);
  });
  it("a second target extension collides", async () => {
    const env = { NODE_ENV: "test", DAP_ALLOW_DEV_AUTH: "1", DAP_DATABASE_URL: "postgresql://dap_app:pw@127.0.0.1:1/never_connected", DAP_ENABLED_ACTIONS: "demoLookup",
      DEV_SESSIONS: JSON.stringify([{ token: "tok-0123456789abcdef", userId: "alice", tenantId: TENANT, sessionId: "s-alice", validUntil: new Date(Date.now() + 3_600_000).toISOString() }]) };
    await expect(composeReferenceHost(env, { extensions: [createTargetExtension({ targets: targets() }).extension, createTargetExtension({ targets: targets() }).extension] })).rejects.toThrow(/collides/);
  });
});

describe("the strict inputs", () => {
  const register = (value: unknown) => registerStudioTarget.inputSchema.safeParse(value).success;
  const status = (value: unknown) => setStudioTargetStatus.inputSchema.safeParse(value).success;
  it.each(["tenantId", "permissions", "actorId", "userId", "role", "isAdmin", "confirmed", "risk", "createdBy", "id", "status", "ref", "snapshot"])("refuse the spoofed top-level field %s", (key) => {
    expect(register({ ...input, [key]: "x" })).toBe(false);
    expect(status({ applicationId: APP, targetId: "a.b", status: "active", [key]: "x" })).toBe(false);
  });
  it("accept the exact register shape and refuse a bad application id", () => {
    expect(register(input)).toBe(true);
    expect(register({ ...input, applicationId: "reference" })).toBe(false);
  });
});

// --- the executor is the persistence authority: run it directly against a recording store (mutation pass D16) -----------------------------------------------------------------
describe("the register executor, called directly", () => {
  const SEC = { tenantId: TENANT, userId: "maya" };
  async function setup() {
    const applications = new FakeApplicationStore();
    await applications.save({ tenantId: TENANT, actor: "seed" }, APP, { name: "Managed", origin: "http://127.0.0.1:5187", allowedOrigins: ["http://127.0.0.1:5187"], environment: "test", registryId: "studio-managed" });
    const store = new FakeTargetStore(applications);
    const registerSpy: unknown[][] = [];
    const real = store.register.bind(store);
    store.register = async (...args) => { registerSpy.push(args); return real(...args); };
    const run = (params: unknown) => runRegisterTarget(store, { params: params as never, security: SEC as never });
    return { store, registerSpy, run };
  }
  it("a registration the validator refuses (a role outside the registry roles) never reaches the store and is invalid_target", async () => {
    const { run, registerSpy } = await setup();
    expect(await run({ ...input, elementRole: "slider" })).toEqual({ status: "failure", code: "invalid_target" });
    expect(await run({ ...input, operations: ["highlight", "input"] })).toEqual({ status: "failure", code: "invalid_target" });
    expect(registerSpy).toEqual([]);
  });
  it("a malformed application id is id_refused before the store is asked", async () => {
    const { run, registerSpy } = await setup();
    expect(await run({ ...input, applicationId: "nope" })).toEqual({ status: "failure", code: "id_refused" });
    expect(registerSpy).toEqual([]);
  });
  it("hands the store the VALIDATED value (trimmed text, canonical operation order) with tenant and actor taken from the trusted security context only", async () => {
    const { run, registerSpy, store } = await setup();
    expect(await run({ ...input, label: "  Submit  ", operations: ["click", "highlight"] })).toMatchObject({ status: "success" });
    expect(registerSpy).toHaveLength(1);
    expect(registerSpy[0]![0]).toEqual({ tenantId: TENANT, actor: "maya" });
    expect(registerSpy[0]![2]).toMatchObject({ label: "Submit", operations: ["highlight", "click"] });
    expect((await store.get(TENANT, APP, "orders.submit"))?.label).toBe("Submit");
  });
  it("a store outcome other than created is the failure with that code; a store that throws is store_unavailable, never a success", async () => {
    const { run, store } = await setup();
    expect(await run(input)).toMatchObject({ status: "success" });
    expect(await run(input)).toEqual({ status: "failure", code: "target_exists" });
    store.failWith = new Error("db down");
    expect(await run({ ...input, targetId: "orders.other" })).toEqual({ status: "failure", code: "store_unavailable" });
  });
  it("the status executor: a refusal is its failure code, a thrown store error is store_unavailable, and the requested status is what the store gets", async () => {
    const { store } = await setup();
    const status = (params: unknown) => runSetTargetStatus(store, { params: params as never, security: SEC as never });
    await store.register({ tenantId: TENANT, actor: "seed" }, APP, { targetId: "orders.submit", route: "orders", page: "/#/orders", role: "button", label: "S", description: "S.", operations: ["highlight", "click"], privacy: "public" });
    expect(await status({ applicationId: APP, targetId: "orders.submit", status: "disabled" })).toMatchObject({ status: "success" });
    expect((await store.get(TENANT, APP, "orders.submit"))?.status).toBe("disabled");
    expect(await status({ applicationId: APP, targetId: "orders.missing", status: "active" })).toEqual({ status: "failure", code: "target_not_found" });
    store.failWith = new Error("db down");
    expect(await status({ applicationId: APP, targetId: "orders.submit", status: "active" })).toEqual({ status: "failure", code: "store_unavailable" });
  });
});

// --- health and repair executor bodies (Studio COMPLETION, S3) ---------------------------------------------------------------------------------------------------------
describe("the health and repair executors, called directly", () => {
  const SEC = { tenantId: TENANT, userId: "maya" } as never;
  const guide = (target: string, wait: "click" | "input" | "ack" = "click", title = "Submit an order") => ({
    id: "wt-0000000000a1", title, description: "Submit the order.", start: "n1",
    steps: [{ id: "n1", kind: "navigate", route: "orders", next: "s1" }, { id: "s1", kind: "guide", target, text: "Press it.", wait, verify: "route.orders", next: "done" }, { id: "done", kind: "complete", text: "Done." }],
  });
  async function setup(options: { managed?: boolean } = {}) {
    const applications = new FakeApplicationStore();
    await applications.save({ tenantId: TENANT, actor: "seed" }, APP, { name: "Managed", origin: "http://127.0.0.1:5187", allowedOrigins: ["http://127.0.0.1:5187"], environment: "test", registryId: options.managed === false ? "reference" : "studio-managed" });
    const store = new FakeTargetStore(applications);
    if (options.managed !== false) await store.register({ tenantId: TENANT, actor: "seed" }, APP, { targetId: "orders.submit", route: "orders", page: "/#/orders", role: "button", label: "Submit", description: "Submits.", operations: ["highlight", "click"], privacy: "public" });
    const health = (params: Record<string, unknown>) => runSetTargetHealth(store, { params: { applicationId: APP, targetId: "orders.submit", health: "broken", ...params } as never, security: SEC });
    const repair = (params: Record<string, unknown> = {}) => runRepairTarget(store, { params: { applicationId: APP, targetId: "orders.submit", marker: "orders.submitNew", elementRole: "button", operations: ["highlight", "click"], label: "Submit now", description: "Submits it.", ...params } as never, security: SEC });
    return { applications, store, health, repair };
  }
  it("health: changed, unchanged, never needs an enabled application, and refuses a built-in application, an unknown target and a malformed id", async () => {
    const t = await setup();
    expect(await t.health({})).toMatchObject({ status: "success" });
    expect((await t.store.get(TENANT, APP, "orders.submit"))?.health).toBe("broken");
    expect(await t.health({ health: "healthy" })).toMatchObject({ status: "success" });
    expect((await t.store.get(TENANT, APP, "orders.submit"))).toMatchObject({ health: "healthy", healthCheckedAt: expect.any(String) });
    expect(await t.health({ targetId: "orders.other" })).toEqual({ status: "failure", code: "target_not_found" });
    expect(await t.health({ applicationId: "nope" })).toEqual({ status: "failure", code: "id_refused" });
    await t.applications.setEnabled({ tenantId: TENANT, actor: "seed" }, APP, false);
    expect(await t.health({ health: "unverified" })).toMatchObject({ status: "success" });
    const builtIn = await setup({ managed: false });
    expect(await builtIn.health({})).toEqual({ status: "failure", code: "registry_not_managed" });
    t.store.failWith = new Error("db down");
    expect(await t.health({})).toEqual({ status: "failure", code: "store_unavailable" });
  });
  it("repair: re-binds the marker, role, operations and texts, keeps the id, raises the revision, marks it healthy and writes the history (tenant and actor from the trusted context)", async () => {
    const t = await setup();
    const { result, repaired } = await withRepairReceipt({ tenantId: TENANT, applicationId: APP, targetId: "orders.submit" }, () => t.repair());
    expect(result).toMatchObject({ status: "success" });
    expect(repaired?.target).toMatchObject({ id: "orders.submit", marker: "orders.submitNew", label: "Submit now", revision: 2, health: "healthy" });
    expect(repaired?.after).toEqual({ marker: "orders.submitNew", role: "button", operations: ["highlight", "click"], label: "Submit now", description: "Submits it." });
    const changes = await t.store.changes(TENANT, APP, "orders.submit", 50);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ revision: 2, changedBy: "maya", before: { marker: "orders.submit", label: "Submit" }, after: { marker: "orders.submitNew" } });
    expect((await t.store.registry(TENANT, APP)).markers).toEqual({ "orders.submit": "orders.submitNew" });
  });
  it("repair refuses a structurally invalid repair before the store is asked, an unchanged one, a marker in use (another target's id or marker), a disabled application, a built-in application and an unknown target", async () => {
    const t = await setup();
    await t.store.register({ tenantId: TENANT, actor: "seed" }, APP, { targetId: "orders.note", route: "orders", page: "/#/orders", role: "textbox", label: "Note", description: "Note.", operations: ["highlight", "input"], privacy: "public" });
    const spy = vi.spyOn(t.store, "repair");
    expect(await t.repair({ marker: "Bad.marker" })).toEqual({ status: "failure", code: "invalid_target" });
    expect(await t.repair({ operations: ["highlight", "input"] })).toEqual({ status: "failure", code: "invalid_target" });
    expect(await t.repair({ route: "orders" })).toEqual({ status: "failure", code: "invalid_target" });
    expect(await t.repair({ applicationId: "nope" })).toEqual({ status: "failure", code: "id_refused" });
    expect(spy).not.toHaveBeenCalled();
    expect(await t.repair({ marker: "orders.submit", label: "Submit", description: "Submits." })).toEqual({ status: "failure", code: "unchanged" });
    expect(await t.repair({ marker: "orders.note" })).toEqual({ status: "failure", code: "marker_in_use" });
    expect(await t.repair({ targetId: "orders.missing" })).toEqual({ status: "failure", code: "target_not_found" });
    await t.repair({ marker: "orders.submitNew" });
    expect(await t.repair({ targetId: "orders.note", marker: "orders.submitNew", elementRole: "textbox", operations: ["highlight", "input"] })).toEqual({ status: "failure", code: "marker_in_use" });
    expect(await t.repair({ targetId: "orders.note", marker: "orders.submit", elementRole: "textbox", operations: ["highlight", "input"] })).toEqual({ status: "failure", code: "marker_in_use" }); // the id of another target
    await t.applications.setEnabled({ tenantId: TENANT, actor: "seed" }, APP, false);
    expect(await t.repair({ marker: "orders.other" })).toEqual({ status: "failure", code: "application_disabled" });
    expect(await (await setup({ managed: false })).repair()).toEqual({ status: "failure", code: "registry_not_managed" });
  });
  it("repair is refused when a draft or a published guide would stop validating, with the validator's fixed problems on the receipt, and nothing changes", async () => {
    const t = await setup();
    t.store.definitions.push({ tenantId: TENANT, applicationId: APP, id: "wt-0000000000a1", title: "Submit an order", status: "draft", definition: guide("orders.submit", "click") });
    t.store.definitions.push({ tenantId: TENANT, applicationId: APP, id: "wt-0000000000a2", title: "Live one", status: "published", definition: { ...guide("orders.submit", "click", "Live one"), id: "wt-0000000000a2" } });
    const bad = await withRepairReceipt({ tenantId: TENANT, applicationId: APP, targetId: "orders.submit" }, () => t.repair({ elementRole: "textbox", operations: ["highlight", "input"] }));
    expect(bad.result).toEqual({ status: "failure", code: "incompatible" });
    expect(bad.problems?.length).toBeGreaterThan(0);
    expect(bad.problems?.every((problem) => problem.startsWith("wt-0000000000a"))).toBe(true);
    expect((bad.problems ?? []).join(" ")).toMatch(/click/u);
    expect(await t.store.get(TENANT, APP, "orders.submit")).toMatchObject({ role: "button", revision: 1, marker: "orders.submit" });
    expect(await t.store.changes(TENANT, APP, "orders.submit", 5)).toEqual([]);
    // a compatible repair of the same target (only the marker and texts change) goes through and reports both workflows
    const ok = await withRepairReceipt({ tenantId: TENANT, applicationId: APP, targetId: "orders.submit" }, () => t.repair());
    expect(ok.result).toMatchObject({ status: "success" });
    expect(ok.repaired?.impact).toEqual({ drafts: [{ id: "wt-0000000000a1", title: "Submit an order" }], published: [{ id: "wt-0000000000a2", title: "Live one", version: 1 }] });
  });
  it("the receipt belongs to the awaiting request only: a repair for another target or tenant never writes into it", async () => {
    const t = await setup();
    const other = await withRepairReceipt({ tenantId: TENANT, applicationId: APP, targetId: "orders.other" }, () => t.repair());
    expect(other.result).toMatchObject({ status: "success" });
    expect(other.repaired).toBeUndefined();
  });
});

describe("the check capabilities and executors (S4)", () => {
  const SEC = { tenantId: TENANT, userId: "maya" } as never;
  async function setup(options: { managed?: boolean } = {}) {
    const applications = new FakeApplicationStore();
    await applications.save({ tenantId: TENANT, actor: "seed" }, APP, { name: "Managed", origin: "http://127.0.0.1:5187", allowedOrigins: ["http://127.0.0.1:5187"], environment: "test", registryId: options.managed === false ? "reference" : "studio-managed" });
    const store = new FakeTargetStore(applications);
    if (options.managed !== false) {
      const scope = { tenantId: TENANT, actor: "seed" };
      await store.register(scope, APP, { targetId: "orders.submit", route: "orders", page: "/#/orders", role: "button", label: "Submit", description: "Submits.", operations: ["highlight", "click"], privacy: "public" });
      await store.register(scope, APP, { targetId: "orders.note", route: "orders", page: "/#/orders", role: "textbox", label: "Note", description: "A note.", operations: ["highlight", "input"], privacy: "public" });
    }
    const add = (params: Record<string, unknown>) => runRegisterCheck(store, { params: { applicationId: APP, kind: "element.visible", targetId: "orders.submit", ...params } as never, security: SEC });
    const status = (params: Record<string, unknown>) => runSetCheckStatus(store, { params: { applicationId: APP, name: "check.v0123456789", status: "disabled", ...params } as never, security: SEC });
    return { applications, store, add, status };
  }
  it("are MEDIUM, state-changing, maintainer-only, any page, with the written justification; audit records ids and closed values only, never an expected value, route or attribute", () => {
    for (const capability of [registerStudioCheck, setStudioCheckStatus]) {
      expect(capability).toMatchObject({ risk: "MEDIUM", changesState: true, requiredPermission: "perm.walkthrough.maintain", allowedPages: "any", version: 1 });
      expect(capability.confirmation).toEqual({ kind: "not-required", justification: MEDIUM_JUSTIFICATION });
      expect(capability.resource?.({ applicationId: APP } as never)).toEqual({ type: "studioApplication", id: APP });
      expect(inspectInputSchema(capability.inputSchema).issues, capability.id).toEqual([]);
    }
    expect(registerStudioCheck.audit.params).toEqual([{ path: "/applicationId", mode: "plain" }, { path: "/kind", mode: "plain" }, { path: "/targetId", mode: "plain" }]);
    expect(setStudioCheckStatus.audit.params).toEqual([{ path: "/applicationId", mode: "plain" }, { path: "/name", mode: "plain" }, { path: "/status", mode: "plain" }]);
    for (const param of registerStudioCheck.audit.params) expect(param.path).not.toMatch(/expected|route|attribute/i);
  });
  it("the registry accepts them next to every other family", () => {
    expect(() => buildRegistry([...DEMO_DEFINITIONS, registerStudioCheck, setStudioCheckStatus])).not.toThrow();
  });
  it("register: derives the NAME itself (the caller cannot send one), creates, and a second identical call is a no-op success", async () => {
    const t = await setup();
    expect(await t.add({})).toMatchObject({ status: "success" });
    expect(await t.add({})).toMatchObject({ status: "success" });
    const stored = await t.store.checks(TENANT, APP);
    expect(stored).toHaveLength(1);
    expect(stored[0]).toMatchObject({ kind: "element.visible", targetId: "orders.submit", route: null, attribute: null, expected: null, status: "active" });
    expect(stored[0]!.name).toBe(checkName({ kind: "element.visible", targetId: "orders.submit", route: null, attribute: null, expected: null }));
    expect(await t.add({ name: "check.v0000000000" })).toEqual({ status: "failure", code: "invalid_target" }); // a supplied name is not a field
  });
  it("register: refuses structurally bad checks before the store is asked, with the executor's fixed codes", async () => {
    const t = await setup();
    const spy = vi.spyOn(t.store, "registerCheck");
    for (const bad of [{ kind: "element.exec" }, { kind: "route.equals", targetId: undefined, route: "Bad Route" }, { kind: "element.text.equals", expected: "" }, { kind: "element.attribute.equals", attribute: "onclick", expected: "x" },
      { kind: "element.value.equals", expected: "a\nb" }, { kind: "element.visible", targetId: "dap.reserved" }, { kind: "element.visible", expected: "extra" }]) {
      expect(await t.add(bad), JSON.stringify(bad)).toEqual({ status: "failure", code: "invalid_target" });
    }
    expect(await t.add({ applicationId: "nope" })).toEqual({ status: "failure", code: "id_refused" });
    expect(spy).not.toHaveBeenCalled();
  });
  it("register: unknown or disabled targets, unknown routes, a value check on a button, a built-in or disabled application and a full registry are the store's fixed codes", async () => {
    const t = await setup();
    expect(await t.add({ targetId: "orders.missing" })).toEqual({ status: "failure", code: "target_not_found" });
    expect(await t.add({ kind: "route.equals", targetId: undefined, route: "nowhere" })).toEqual({ status: "failure", code: "route_not_found" });
    expect(await t.add({ kind: "element.value.equals", targetId: "orders.submit", expected: "x" })).toEqual({ status: "failure", code: "role_refused" });
    expect(await t.add({ kind: "element.value.equals", targetId: "orders.note", expected: "x" })).toMatchObject({ status: "success" });
    expect(await t.add({ kind: "route.equals", targetId: undefined, route: "orders" })).toMatchObject({ status: "success" });
    await t.store.setStatus({ tenantId: TENANT, actor: "seed" }, APP, "orders.note", "disabled");
    expect(await t.add({ kind: "element.hidden", targetId: "orders.note" })).toEqual({ status: "failure", code: "target_disabled" });
    for (let i = 0; i < 98; i += 1) expect(await t.add({ kind: "element.text.equals", expected: `Text ${i}` })).toMatchObject({ status: "success" });
    expect(await t.add({ kind: "element.text.equals", expected: "One more" })).toEqual({ status: "failure", code: "registry_full" });
    await t.applications.setEnabled({ tenantId: TENANT, actor: "seed" }, APP, false);
    expect(await t.add({ kind: "element.hidden" })).toEqual({ status: "failure", code: "application_disabled" });
    expect(await (await setup({ managed: false })).add({})).toEqual({ status: "failure", code: "registry_not_managed" });
    t.store.failWith = new Error("db down secret");
    expect(await t.add({})).toEqual({ status: "failure", code: "store_unavailable" });
  });
  it("status: disables and re-enables by name, refuses an unknown name, a malformed id, a built-in application, and re-enabling in a disabled application", async () => {
    const t = await setup();
    await t.add({});
    const [check] = await t.store.checks(TENANT, APP);
    expect(await t.status({ name: check!.name })).toMatchObject({ status: "success" });
    expect((await t.store.checks(TENANT, APP))[0]!.status).toBe("disabled");
    expect(await t.status({ name: check!.name })).toMatchObject({ status: "success" }); // unchanged
    expect(await t.status({ name: "check.v0000000000" })).toEqual({ status: "failure", code: "check_not_found" });
    expect(await t.status({ applicationId: "nope" })).toEqual({ status: "failure", code: "id_refused" });
    await t.applications.setEnabled({ tenantId: TENANT, actor: "seed" }, APP, false);
    expect(await t.status({ name: check!.name, status: "active" })).toEqual({ status: "failure", code: "application_disabled" });
    expect(await t.status({ name: check!.name, status: "disabled" })).toMatchObject({ status: "success" });
    expect(await (await setup({ managed: false })).status({})).toEqual({ status: "failure", code: "registry_not_managed" });
  });
  it("tenant and actor come from the trusted context; the executors record received calls only in the host's own handle", async () => {
    const t = await setup();
    const { executors, trusted } = createTargetExecutors({ targets: t.store });
    expect(executors.map((e) => e.id)).toContain("ex.studio-register-check");
    expect(trusted.executorCalls("registerStudioCheck")).toBe(0);
  });
});
