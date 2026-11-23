/**
 * Studio V1B on PostgreSQL: Studio-managed application registries through the REAL Gateway, the REAL executors, the PostgreSQL stores and Fastify `inject`. Registration is only reachable through the
 * `registerStudioTarget` capability (there is no HTTP route that creates a target), so the registration matrix drives the capability directly and the READ/LEVER routes through the maintainer routes.
 * Proves: the executor re-validates everything structural (ids, roles, operations, privacy, texts, route and page grammars, the page/route pairing, duplicates, caps), wrong registry (built-in
 * application), cross-application and cross-tenant isolation, disabled applications and targets, references, published/external/bundle behavior, and that no `@e` ref is ever persisted.
 * NEEDS the PostgreSQL of deploy/compose.yaml on a FRESH database; every test uses tenants of its own.
 */
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import type { ReferenceHost } from "../../apps/reference-host/src/index.js";
import { openStatePools } from "../../packages/security/src/state/conformance/state-pg-fixtures.js";
import { fixtureConfig, managedConfig, managedDef, referenceConfig, registration, startHost } from "./studio-registry.support.js";

let owner: Pool; let probe: Pool;
const closers: (() => Promise<unknown>)[] = [];
const hosts: ReferenceHost[] = [];
beforeAll(async () => { ({ app: probe, owner } = await openStatePools(Pool)); });
afterAll(async () => { await Promise.all([probe?.end(), owner?.end()]); });
afterEach(async () => { await Promise.all([...closers.splice(0).map((close) => close()), ...hosts.splice(0).map((host) => host.close())]); });
const start = (options: Parameters<typeof startHost>[3] = {}) => startHost(closers, hosts, owner, options);
const REJECTED = { outcome: "ALLOWED", category: "try_later" };
const OK = { outcome: "ALLOWED", category: "ok" };
const profileDef = () => ({
  title: "Save your name", description: "Change your display name and save it.", start: "n1",
  steps: [{ id: "n1", kind: "navigate", route: "profile", next: "s1" }, { id: "s1", kind: "guide", target: "profile.saveButton", text: "Press Save.", wait: "click", verify: "profile.saved", next: "done" }, { id: "done", kind: "complete", text: "Done." }],
});

describe("registerStudioTarget through the real Gateway", () => {
  it("registers a target and its route in one call: ALLOWED/ok, the PROPOSED/ALLOWED/EXECUTED trail at MEDIUM with only ids in the audit view, and the registry holds it", async () => {
    const t = await start();
    const appId = await t.createApplication();
    expect(await t.registerTarget(appId)).toEqual(OK);
    expect(t.trustedTargets.executorCalls("registerStudioTarget")).toBe(1);
    const trail = (await t.rows()).filter((row) => row.action_id === "registerStudioTarget");
    expect(trail.map((row) => row.event_type)).toEqual(["AI_ACTION_PROPOSED", "AI_ACTION_ALLOWED", "AI_ACTION_EXECUTED"]);
    expect(trail[1]).toMatchObject({ outcome: "ALLOWED", risk: "MEDIUM", user_id: "maya", resource_type: "studioApplication", resource_id: appId, params_view: { "/applicationId": appId, "/targetId": "orders.submitButton" } });
    expect(trail[2]).toMatchObject({ execution_result: "success" });
    const text = JSON.stringify(await t.rows());
    for (const word of ["Submit order", "Submits the order", "/#/orders", "elementRole", "operations", "public"]) expect(text, word).not.toContain(word);
    const listing = await t.targets.list(t.tenant, appId);
    expect(listing.routes).toEqual([{ route: "orders", page: "/#/orders" }]);
    expect(listing.targets).toEqual([expect.objectContaining({ id: "orders.submitButton", route: "orders", page: "/#/orders", role: "button", label: "Submit order", operations: ["highlight", "click"], privacy: "public", status: "active", references: { drafts: 0, published: 0 } })]);
  });
  it("a second target on an existing page reuses its route (no new route); the first on a new page creates it", async () => {
    const t = await start();
    const appId = await t.createApplication();
    expect(await t.targets.register({ tenantId: t.tenant, actor: "maya" }, appId, { targetId: "orders.submit", route: "orders", page: "/#/orders", role: "button", label: "Submit", description: "Submits", operations: ["highlight", "click"], privacy: "public" }))
      .toEqual({ kind: "created", route: { route: "orders", page: "/#/orders", created: true } });
    expect(await t.targets.register({ tenantId: t.tenant, actor: "maya" }, appId, { targetId: "orders.note", route: "orders", page: "/#/orders", role: "textbox", label: "Note", description: "A note", operations: ["highlight", "input"], privacy: "public" }))
      .toEqual({ kind: "created", route: { route: "orders", page: "/#/orders", created: false } });
    expect((await t.targets.list(t.tenant, appId)).routes).toHaveLength(1);
  });
  it.each([
    ["a malformed id", { targetId: "submit" }], ["an upper-case id", { targetId: "Orders.submit" }], ["a reserved id (dap)", { targetId: "dap.submit" }], ["a reserved id (internal)", { targetId: "internal.submit" }],
    ["an unregistrable role (panel)", { elementRole: "panel" }], ["an unregistrable role (heading)", { elementRole: "heading" }],
    ["click on a textbox", { elementRole: "textbox", operations: ["highlight", "click"] }], ["input on a button", { operations: ["highlight", "input"] }], ["operations without highlight", { operations: ["click"] }],
    ["private privacy", { privacy: "private" }], ["redact privacy", { privacy: "redact" }], ["a malformed route", { route: "Order-List" }], ["a page with a query", { page: "/#/orders?id=1" }], ["a page with a path", { page: "/app/#/orders" }],
    ["a label with markup", { label: "<b>x</b>" }], ["a blank description", { description: "   " }],
  ])("the executor refuses %s with ALLOWED + try_later and stores nothing (not even the route)", async (_name, over) => {
    const t = await start();
    const appId = await t.createApplication();
    expect(await t.registerTarget(appId, over)).toEqual(REJECTED);
    expect(await t.targets.list(t.tenant, appId)).toEqual({ targets: [], routes: [] });
  });
  it("values beyond the schema bounds (an 81-character id, an empty description, five operations) are refused by the strict schema with INVALID_PARAMETERS and stored nothing", async () => {
    const t = await start();
    const appId = await t.createApplication();
    for (const over of [{ targetId: `orders.${"a".repeat(74)}` }, { description: "" }, { label: "" }, { operations: ["highlight", "click", "input", "focus", "x"] }, { page: `/#/${"a".repeat(120)}` }]) {
      expect((await t.registerTarget(appId, over)).outcome, JSON.stringify(over).slice(0, 40)).toBe("INVALID_PARAMETERS");
    }
    expect(await t.targets.list(t.tenant, appId)).toEqual({ targets: [], routes: [] });
  });
  it("spoofed fields, a client-supplied tenant, the reserved name `role` and an @e ref are refused by the strict schema before any executor exists", async () => {
    const t = await start();
    const appId = await t.createApplication();
    for (const extra of [{ tenantId: randomUUID() }, { role: "button" }, { ref: "@e12" }, { status: "active" }, { permissions: ["perm.walkthrough.maintain"] }, { createdBy: "mallory" }]) {
      expect((await t.registerTarget(appId, extra)).outcome, JSON.stringify(extra)).toBe("INVALID_PARAMETERS");
    }
    expect(t.trustedTargets.executorCalls()).toBe(0);
  });
  it("a session without perm.walkthrough.maintain is UNAUTHORIZED on both capabilities (zero executor runs), and the capabilities are OFF unless DAP_ENABLED_ACTIONS lists them", async () => {
    const t = await start();
    const appId = await t.createApplication();
    expect(await t.submit("registerStudioTarget", { applicationId: appId, ...registration() }, t.userToken)).toEqual({ outcome: "UNAUTHORIZED", category: "not_available" });
    expect(await t.submit("setStudioTargetStatus", { applicationId: appId, targetId: "orders.submitButton", status: "disabled" }, t.userToken)).toEqual({ outcome: "UNAUTHORIZED", category: "not_available" });
    expect(t.trustedTargets.executorCalls()).toBe(0);
    const off = await start({ enabled: "demoLookup,saveStudioApplication" });
    const offApp = await off.createApplication();
    expect((await off.registerTarget(offApp)).outcome).not.toBe("ALLOWED");
    expect(await off.targets.list(off.tenant, offApp)).toEqual({ targets: [], routes: [] });
  });
  it("a duplicate id is refused and the first registration is untouched; the id is never reinterpreted", async () => {
    const t = await start();
    const appId = await t.createApplication();
    await t.registerOk(appId);
    expect(await t.registerTarget(appId, { label: "Reinterpreted", elementRole: "link", description: "Other", route: "other", page: "/#/other" })).toEqual(REJECTED);
    const stored = await t.targets.list(t.tenant, appId);
    expect(stored.targets).toEqual([expect.objectContaining({ id: "orders.submitButton", label: "Submit order", role: "button", route: "orders" })]);
    expect(stored.routes).toEqual([{ route: "orders", page: "/#/orders" }]); // the route of the refused attempt was rolled back with it
    expect(await t.targets.register({ tenantId: t.tenant, actor: "maya" }, appId, { targetId: "orders.submitButton", route: "orders", page: "/#/orders", role: "button", label: "x", description: "y", operations: ["highlight"], privacy: "public" })).toEqual({ kind: "target_exists" });
  });
  it("a page that already has a route keeps it, and a route name that belongs to another page is refused (ROUTE_MISMATCH); nothing is created", async () => {
    const t = await start();
    const appId = await t.createApplication();
    await t.registerOk(appId);
    const scope = { tenantId: t.tenant, actor: "maya" };
    const value = (over: object) => ({ targetId: "orders.other", route: "orders", page: "/#/orders", role: "button" as const, label: "Other", description: "Other", operations: ["highlight"] as const, privacy: "public" as const, ...over });
    expect(await t.targets.register(scope, appId, value({ route: "renamed" }))).toEqual({ kind: "route_mismatch" }); // the page /#/orders is already the route `orders`
    expect(await t.targets.register(scope, appId, value({ page: "/#/elsewhere" }))).toEqual({ kind: "route_mismatch" }); // the name `orders` already belongs to /#/orders
    expect(await t.registerTarget(appId, { targetId: "orders.other", route: "renamed" })).toEqual(REJECTED);
    expect((await t.targets.list(t.tenant, appId)).routes).toEqual([{ route: "orders", page: "/#/orders" }]);
  });
  it("the cap of 20 routes and 200 targets per application: the 21st route and the 201st target are registry_full; an update-free registry is never over the cap", async () => {
    const t = await start();
    const appId = await t.createApplication();
    const scope = { tenantId: t.tenant, actor: "maya" };
    const make = (n: number, route: string, page: string) => ({ targetId: `app.t${n}`, route, page, role: "button" as const, label: `T${n}`, description: "d", operations: ["highlight"] as const, privacy: "public" as const });
    for (let i = 0; i < 20; i += 1) expect((await t.targets.register(scope, appId, make(i, `r${i}`, `/#/p${i}`))).kind).toBe("created");
    expect(await t.targets.register(scope, appId, make(20, "r20", "/#/p20"))).toEqual({ kind: "registry_full" });
    expect((await t.targets.list(t.tenant, appId)).routes).toHaveLength(20);
    for (let i = 21; i <= 200; i += 1) expect((await t.targets.register(scope, appId, make(i, "r0", "/#/p0"))).kind).toBe("created");
    expect(await t.targets.register(scope, appId, make(201, "r0", "/#/p0"))).toEqual({ kind: "registry_full" });
    expect((await t.targets.list(t.tenant, appId)).targets).toHaveLength(200);
  }, 120_000);
  it("concurrent registrations cannot exceed the caps (25 routes at once, then 205 targets at once)", async () => {
    const t = await start();
    const appId = await t.createApplication();
    const scope = { tenantId: t.tenant, actor: "maya" };
    const make = (n: number, route: string, page: string) => ({ targetId: `app.t${n}`, route, page, role: "button" as const, label: `T${n}`, description: "d", operations: ["highlight"] as const, privacy: "public" as const });
    const routes = await Promise.all(Array.from({ length: 25 }, (_v, i) => t.targets.register(scope, appId, make(i, `r${i}`, `/#/p${i}`))));
    expect(routes.filter((o) => o.kind === "created")).toHaveLength(20);
    expect(routes.filter((o) => o.kind === "registry_full")).toHaveLength(5);
    const more = await Promise.all(Array.from({ length: 205 }, (_v, i) => t.targets.register(scope, appId, make(100 + i, "r0", "/#/p0"))));
    expect(more.filter((o) => o.kind === "created").length + 20).toBe(200);
    expect((await t.targets.list(t.tenant, appId)).targets).toHaveLength(200);
  }, 120_000);
});

describe("wrong registry, cross-application and cross-tenant", () => {
  it("a BUILT-IN application (reference, fixture) refuses registration with try_later; the database holds nothing for it", async () => {
    const t = await start();
    const reference = await t.createApplication(referenceConfig());
    const fixture = await t.createApplication(fixtureConfig());
    for (const appId of [reference, fixture]) {
      expect(await t.registerTarget(appId)).toEqual(REJECTED);
      expect(await t.targets.register({ tenantId: t.tenant, actor: "maya" }, appId, { targetId: "orders.x", route: "orders", page: "/#/orders", role: "button", label: "x", description: "y", operations: ["highlight"], privacy: "public" })).toEqual({ kind: "registry_not_managed" });
    }
    expect(await t.sql((c) => c.query("SELECT count(*)::int AS n FROM public.studio_registry_routes"))).toMatchObject({ rows: [{ n: 0 }] });
  });
  it("an unknown application, another tenant's application and a malformed application id register nothing", async () => {
    const a = await start(); const b = await start();
    const appA = await a.createApplication();
    expect(await a.submit("registerStudioTarget", { applicationId: "app-ffffffffffff", ...registration() })).toEqual(REJECTED);
    expect(await b.registerTarget(appA)).toEqual(REJECTED); // tenant B naming tenant A's application
    expect((await b.submit("registerStudioTarget", { applicationId: "reference", ...registration() })).outcome).toBe("INVALID_PARAMETERS");
    expect(await a.targets.list(a.tenant, appA)).toEqual({ targets: [], routes: [] });
  });
  it("A's targets do not validate in B's registry: a workflow for B using A's target id is refused, and each application's own target validates for it", async () => {
    const t = await start();
    const [a, b] = [await t.createApplication(managedConfig({ name: "A" })), await t.createApplication(managedConfig({ name: "B", origin: "http://127.0.0.1:5188", allowedOrigins: ["http://127.0.0.1:5188"] }))];
    await t.registerOk(a, { targetId: "orders.aOnly", route: "ordersA", page: "/#/orders-a" });
    await t.registerOk(b, { targetId: "orders.bOnly", route: "ordersB", page: "/#/orders-b" });
    expect((await t.createWorkflow(b, managedDef("orders.aOnly", "ordersA"))).res.status).toBe(422);
    expect((await t.createWorkflow(a, managedDef("orders.bOnly", "ordersB"))).res.status).toBe(422);
    expect((await t.createWorkflow(a, managedDef("orders.aOnly", "ordersA"))).res.status).toBe(201);
    expect((await t.createWorkflow(b, managedDef("orders.bOnly", "ordersB"))).res.status).toBe(201);
    // The same id may exist in both registries as two separate targets.
    await t.registerOk(b, { targetId: "orders.aOnly", route: "ordersB2", page: "/#/orders-b2" });
    expect((await t.createWorkflow(b, managedDef("orders.aOnly", "ordersB2"))).res.status).toBe(201);
  });
  it("a managed application's workflow cannot use a built-in application's targets either, and a reference workflow cannot use managed targets", async () => {
    const t = await start();
    const managed = await t.createApplication();
    const reference = await t.createApplication(referenceConfig());
    await t.registerOk(managed);
    expect((await t.createWorkflow(managed, profileDef())).res.status).toBe(422);
    expect((await t.createWorkflow(reference, managedDef())).res.status).toBe(422);
    expect((await t.createWorkflow(reference, profileDef())).res.status).toBe(201);
  });
  it("cross-tenant: tenant 1 cannot list, read, disable or see tenant 2's targets, by the routes or by the Gateway; tenant 2's data is untouched", async () => {
    const a = await start(); const b = await start();
    const appA = await a.createApplication();
    await a.registerOk(appA);
    const notFound = { kind: "not_found", message: "That application was not found.", code: "APPLICATION_NOT_FOUND" };
    for (const [method, url, body] of [["GET", `/api/admin/applications/${appA}/targets`], ["GET", `/api/admin/applications/${appA}/registry`], ["POST", `/api/admin/applications/${appA}/targets/orders.submitButton/status`, { status: "disabled" }]] as const) {
      const res = await b.call(method, url, "maintainer", body);
      expect([method, url, res.status, res.body]).toEqual([method, url, 404, notFound]);
      expect(res.raw).not.toContain("Submit order");
    }
    expect(await b.submit("setStudioTargetStatus", { applicationId: appA, targetId: "orders.submitButton", status: "disabled" })).toEqual(REJECTED);
    expect(await b.targets.list(b.tenant, appA)).toEqual({ targets: [], routes: [] });
    expect((await a.targets.get(a.tenant, appA, "orders.submitButton"))?.status).toBe("active");
  });
  it("an @e element ref is never persisted: no table or audit row of the registration holds one", async () => {
    const t = await start();
    const appId = await t.createApplication();
    await t.registerOk(appId);
    const dump = JSON.stringify([await t.sql((c) => c.query("SELECT * FROM public.studio_registry_targets")), await t.sql((c) => c.query("SELECT * FROM public.studio_registry_routes")), await t.rows()]);
    expect(dump).not.toMatch(/@e\d/);
  });
});

describe("disabled applications and disabled targets", () => {
  it("a DISABLED application cannot register or re-enable a target but can still disable one; re-enabling the application restores both", async () => {
    const t = await start();
    const appId = await t.createApplication();
    await t.registerOk(appId);
    await t.registerOk(appId, { targetId: "orders.note", elementRole: "textbox", operations: ["highlight", "input"], label: "Note" });
    expect((await t.call("POST", `/api/admin/applications/${appId}/status`, "maintainer", { enabled: false })).status).toBe(200);
    expect(await t.registerTarget(appId, { targetId: "orders.third" })).toEqual(REJECTED);
    expect(await t.submit("setStudioTargetStatus", { applicationId: appId, targetId: "orders.note", status: "disabled" })).toEqual(OK); // the safety lever
    expect(await t.submit("setStudioTargetStatus", { applicationId: appId, targetId: "orders.note", status: "active" })).toEqual(REJECTED);
    expect((await t.targets.get(t.tenant, appId, "orders.note"))?.status).toBe("disabled");
    await t.call("POST", `/api/admin/applications/${appId}/status`, "maintainer", { enabled: true });
    expect(await t.submit("setStudioTargetStatus", { applicationId: appId, targetId: "orders.note", status: "active" })).toEqual(OK);
    expect(await t.registerTarget(appId, { targetId: "orders.third" })).toEqual(OK);
  });
  it("a target status on a built-in application is refused (REGISTRY_NOT_MANAGED), and on an unknown target is target_not_found", async () => {
    const t = await start();
    const reference = await t.createApplication(referenceConfig());
    expect(await t.submit("setStudioTargetStatus", { applicationId: reference, targetId: "profile.saveButton", status: "disabled" })).toEqual(REJECTED);
    const managed = await t.createApplication();
    expect(await t.targets.setStatus({ tenantId: t.tenant, actor: "maya" }, managed, "orders.missing", "disabled")).toBe("target_not_found");
    expect(await t.targets.setStatus({ tenantId: t.tenant, actor: "maya" }, reference, "profile.saveButton", "disabled")).toBe("registry_not_managed");
  });
  it("disabling a target drops it from the registry validators see: a draft fails validation at save and publish; a published guide leaves published, external and bundle; re-enabling restores them", async () => {
    const t = await start();
    const appId = await t.createApplication();
    await t.registerOk(appId);
    const live = await t.createWorkflow(appId, managedDef());
    const draft = await t.createWorkflow(appId, managedDef(undefined, undefined, { title: "A draft" }));
    expect((await t.call("POST", `/api/admin/walkthroughs/${live.id}/status`, "maintainer", { status: "published" })).status).toBe(200);
    const served = async () => {
      const list = (await t.call("GET", "/api/walkthroughs/published", "user")).body;
      return { walkthroughs: (list.walkthroughs as { id: string }[]).map((g) => g.id), external: (list.external as { id: string }[]).map((g) => g.id) };
    };
    expect(await served()).toEqual({ walkthroughs: [], external: [live.id] });
    expect((await t.call("GET", `/api/walkthroughs/published/${live.id}/bundle`, "user")).status).toBe(200);

    const off = await t.call("POST", "/api/admin/applications/" + appId + "/targets/orders.submitButton/status", "maintainer", { status: "disabled" });
    expect(off.status).toBe(200);
    expect(off.body).toMatchObject({ id: "orders.submitButton", status: "disabled", references: { drafts: 1, published: 1 } });
    expect(await served()).toEqual({ walkthroughs: [], external: [] });
    expect((await t.call("GET", `/api/walkthroughs/published/${live.id}/bundle`, "user")).status).toBe(404);
    expect((await t.call("PUT", `/api/admin/walkthroughs/${draft.id}`, "maintainer", { applicationId: appId, definition: managedDef() })).status).toBe(422);
    expect((await t.call("POST", "/api/admin/walkthroughs", "maintainer", { applicationId: appId, definition: managedDef() })).status).toBe(422);
    expect((await t.call("POST", `/api/admin/walkthroughs/${draft.id}/status`, "maintainer", { status: "published" })).status).toBe(422);
    // The Gateway-level executors apply the same rule (defence in depth).
    expect(await t.submit("saveWalkthroughDraft", { walkthroughId: draft.id, applicationId: appId, definition: { ...managedDef(), id: draft.id } })).toEqual(REJECTED);
    expect(await t.submit("setWalkthroughStatus", { walkthroughId: draft.id, status: "published" })).toEqual(REJECTED);
    expect((await t.realStore.get(t.tenant, draft.id))?.status).toBe("draft");
    // The registry the editor loads has no active target now, but the route stays.
    expect((await t.call("GET", `/api/admin/applications/${appId}/registry`, "maintainer")).body).toMatchObject({ routes: ["orders"], elements: [], postconditionNames: ["route.orders"] });

    const on = await t.call("POST", `/api/admin/applications/${appId}/targets/orders.submitButton/status`, "maintainer", { status: "active" });
    expect(on.body).toMatchObject({ status: "active" });
    expect(await served()).toEqual({ walkthroughs: [], external: [live.id] });
    expect((await t.call("GET", `/api/walkthroughs/published/${live.id}/bundle`, "user")).status).toBe(200);
    expect((await t.call("POST", `/api/admin/walkthroughs/${draft.id}/status`, "maintainer", { status: "published" })).status).toBe(200);
  });
});

describe("the maintainer routes for managed registries", () => {
  it("GET targets lists targets with references and routes and the limits; a built-in application is 409 REGISTRY_NOT_MANAGED; unknown and other tenants' are 404", async () => {
    const t = await start();
    const appId = await t.createApplication();
    await t.registerOk(appId);
    await t.registerOk(appId, { targetId: "orders.note", elementRole: "textbox", operations: ["highlight", "input", "focus"], label: "Order note" });
    const used = await t.createWorkflow(appId, managedDef());
    await t.createWorkflow(appId, managedDef(undefined, undefined, { title: "Second" }));
    await t.call("POST", `/api/admin/walkthroughs/${used.id}/status`, "maintainer", { status: "published" });
    const res = await t.call("GET", `/api/admin/applications/${appId}/targets`, "maintainer");
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(["limits", "routes", "targets"]);
    expect(res.body.limits).toEqual({ maxTargets: 200, maxRoutes: 20 });
    expect(res.body.routes).toEqual([{ route: "orders", page: "/#/orders" }]);
    const targets = res.body.targets as Record<string, unknown>[];
    expect(targets.map((target) => target.id)).toEqual(["orders.submitButton", "orders.note"]);
    expect(Object.keys(targets[0]!).sort()).toEqual(["description", "id", "label", "operations", "page", "privacy", "references", "role", "route", "status", "updatedAt"]);
    expect(targets[0]).toMatchObject({ references: { drafts: 1, published: 1 } });
    expect(targets[1]).toMatchObject({ references: { drafts: 0, published: 0 } });
    const builtIn = await t.createApplication(referenceConfig());
    expect((await t.call("GET", `/api/admin/applications/${builtIn}/targets`, "maintainer")).body).toMatchObject({ kind: "conflict", code: "REGISTRY_NOT_MANAGED" });
    expect((await t.call("GET", "/api/admin/applications/app-ffffffffffff/targets", "maintainer")).body).toMatchObject({ code: "APPLICATION_NOT_FOUND" });
    expect((await t.call("GET", `/api/admin/applications/${appId}/targets`, "user")).status).toBe(403);
  });
  it("POST status needs EXACTLY { status }, answers 404 TARGET_NOT_FOUND for an unknown or malformed target id, 409 APPLICATION_DISABLED to enable under a disabled application (disabling still works), 409 REGISTRY_NOT_MANAGED for a built-in one", async () => {
    const t = await start();
    const appId = await t.createApplication();
    await t.registerOk(appId);
    const url = (id: string, target = "orders.submitButton") => `/api/admin/applications/${id}/targets/${target}/status`;
    for (const body of [{}, { status: "deleted" }, { status: "active", extra: 1 }, { enabled: false }, []]) expect((await t.call("POST", url(appId), "maintainer", body)).status, JSON.stringify(body)).toBe(400);
    for (const target of ["orders.missing", "submit", "dap.x", "Orders.Submit"]) expect((await t.call("POST", url(appId, target), "maintainer", { status: "disabled" })).body, target).toMatchObject({ kind: "not_found", code: "TARGET_NOT_FOUND" });
    expect((await t.call("POST", url(appId), "user", { status: "disabled" })).status).toBe(403);
    await t.call("POST", `/api/admin/applications/${appId}/status`, "maintainer", { enabled: false });
    expect((await t.call("POST", url(appId), "maintainer", { status: "disabled" })).body).toMatchObject({ status: "disabled" });
    expect((await t.call("POST", url(appId), "maintainer", { status: "active" })).body).toMatchObject({ kind: "conflict", code: "APPLICATION_DISABLED" });
    const builtIn = await t.createApplication(referenceConfig());
    expect((await t.call("POST", url(builtIn, "profile.saveButton"), "maintainer", { status: "disabled" })).body).toMatchObject({ code: "REGISTRY_NOT_MANAGED" });
  });
  it("there is NO HTTP route that creates a target, whatever the body", async () => {
    const t = await start();
    const appId = await t.createApplication();
    for (const [method, url] of [["POST", `/api/admin/applications/${appId}/targets`], ["PUT", `/api/admin/applications/${appId}/targets/orders.submitButton`], ["POST", `/api/admin/applications/${appId}/registry`], ["POST", "/api/admin/targets"]] as const) {
      const res = await t.call(method, url, "maintainer", { ...registration(), applicationId: appId });
      expect([method, url, res.status >= 400, res.status === 201 || res.status === 200]).toEqual([method, url, true, false]);
    }
    expect(await t.targets.list(t.tenant, appId)).toEqual({ targets: [], routes: [] });
  });
  it("the registry read of a managed application: active public targets, route.* postconditions, pages, previewable only with a route, previewMode application-window; built-in applications keep V1A with source built-in", async () => {
    const t = await start();
    const appId = await t.createApplication();
    const empty = await t.call("GET", `/api/admin/applications/${appId}/registry`, "maintainer");
    expect(empty.body).toEqual({ routes: [], elements: [], postconditionNames: [], previewable: false, source: "studio-managed", pages: {}, previewMode: "application-window" });
    await t.registerOk(appId);
    await t.registerOk(appId, { targetId: "home.start", route: "home", page: "/", label: "Start" });
    const filled = await t.call("GET", `/api/admin/applications/${appId}/registry`, "maintainer");
    expect(filled.body).toMatchObject({ routes: ["orders", "home"], postconditionNames: ["route.orders", "route.home"], previewable: true, source: "studio-managed", pages: { "/#/orders": "orders", "/": "home" }, previewMode: "application-window" });
    expect((filled.body.elements as { id: string; privacy: string }[]).map((e) => [e.id, e.privacy])).toEqual([["orders.submitButton", "public"], ["home.start", "public"]]);
    expect(Object.keys((filled.body.elements as object[])[0]!).sort()).toEqual(["description", "id", "label", "operations", "privacy", "role", "route"]);
    await t.call("POST", `/api/admin/applications/${appId}/status`, "maintainer", { enabled: false });
    expect((await t.call("GET", `/api/admin/applications/${appId}/registry`, "maintainer")).status, "a disabled application stays readable").toBe(200);
    const reference = await t.createApplication(referenceConfig());
    expect((await t.call("GET", `/api/admin/applications/${reference}/registry`, "maintainer")).body).toMatchObject({ source: "built-in", previewMode: "in-app", previewable: true, pages: { "/#/profile": "profile" } });
  });
  it("applications carry source, the registry choice list offers the managed entry, and an application cannot be switched between built-in and Studio-managed (422), while built-ins can still be switched among themselves", async () => {
    const t = await start();
    const list = await t.call("GET", "/api/admin/applications", "maintainer");
    expect(list.body.registries).toEqual([
      { id: "reference", label: "Reference application", source: "built-in" }, { id: "fixture", label: "Second application", source: "built-in" },
      { id: "studio-managed", label: "Studio-managed (register targets from the browser)", source: "studio-managed" },
    ]);
    const managed = await t.createApplication();
    const reference = await t.createApplication(referenceConfig());
    expect((await t.call("GET", `/api/admin/applications/${managed}`, "maintainer")).body).toMatchObject({ source: "studio-managed", registryId: "studio-managed" });
    expect((await t.call("GET", `/api/admin/applications/${reference}`, "maintainer")).body).toMatchObject({ source: "built-in" });
    const phrase = "registryId: cannot switch between built-in and Studio-managed registries";
    const toBuiltIn = await t.call("PUT", `/api/admin/applications/${managed}`, "maintainer", managedConfig({ registryId: "reference" }));
    expect([toBuiltIn.status, toBuiltIn.body.issues]).toEqual([422, [phrase]]);
    const toManaged = await t.call("PUT", `/api/admin/applications/${reference}`, "maintainer", referenceConfig({ registryId: "studio-managed" }));
    expect([toManaged.status, toManaged.body.issues]).toEqual([422, [phrase]]);
    expect((await t.call("PUT", `/api/admin/applications/${reference}`, "maintainer", referenceConfig({ registryId: "fixture" }))).body).toMatchObject({ registryId: "fixture", source: "built-in" });
    expect((await t.call("PUT", `/api/admin/applications/${managed}`, "maintainer", managedConfig({ name: "Renamed" }))).body).toMatchObject({ name: "Renamed", source: "studio-managed" });
    // The Gateway executor and the store refuse it as well (defence in depth), and the database refuses a re-point while targets exist.
    expect(await t.submit("saveStudioApplication", { applicationId: managed, ...managedConfig({ registryId: "reference" }) })).toEqual(REJECTED);
    expect(await t.applications.save({ tenantId: t.tenant, actor: "maya" }, managed, managedConfig({ registryId: "reference" }))).toBe("registry_switch");
    await t.registerOk(managed);
    await expect(t.sql((c) => c.query("UPDATE public.studio_applications SET registry_id = 'reference' WHERE application_id = $1", [managed]))).rejects.toThrow(/foreign key/);
  });
  it("the stored definition's references: a target named by a draft and by a published guide counts once per definition, even when several steps name it", async () => {
    const t = await start();
    const appId = await t.createApplication();
    await t.registerOk(appId);
    const twice = managedDef(undefined, undefined, { steps: [
      { id: "n1", kind: "navigate", route: "orders", next: "s1" }, { id: "s1", kind: "guide", target: "orders.submitButton", text: "One", wait: "click", next: "s2" },
      { id: "s2", kind: "guide", target: "orders.submitButton", text: "Two", wait: "click", next: "done" }, { id: "done", kind: "complete", text: "Done." }] });
    const one = await t.createWorkflow(appId, twice);
    expect(one.res.status).toBe(201);
    await t.createWorkflow(appId, managedDef());
    expect((await t.targets.get(t.tenant, appId, "orders.submitButton"))?.references).toEqual({ drafts: 2, published: 0 });
    await t.call("POST", `/api/admin/walkthroughs/${one.id}/status`, "maintainer", { status: "published" });
    expect((await t.targets.get(t.tenant, appId, "orders.submitButton"))?.references).toEqual({ drafts: 1, published: 1 });
    // Another application's definitions never count.
    const other = await t.createApplication(managedConfig({ origin: "http://127.0.0.1:5188", allowedOrigins: ["http://127.0.0.1:5188"] }));
    await t.registerOk(other);
    expect((await t.targets.get(t.tenant, other, "orders.submitButton"))?.references).toEqual({ drafts: 0, published: 0 });
  });
});

describe("published, external and bundle", () => {
  it("a published guide of a managed application is listed as external metadata (never in walkthroughs) and its bundle holds the definition, the application and the CURRENT active public registry; built-in guides stay in walkthroughs exactly as before", async () => {
    const t = await start();
    const managed = await t.createApplication(managedConfig({ name: "Orders app" }));
    await t.registerOk(managed);
    await t.registerOk(managed, { targetId: "orders.note", elementRole: "textbox", operations: ["highlight", "input"], label: "Note", description: "The note" });
    const reference = await t.createApplication(referenceConfig());
    const guide = await t.createWorkflow(managed, managedDef());
    const builtIn = await t.createWorkflow(reference, profileDef());
    for (const id of [guide.id, builtIn.id]) await t.call("POST", `/api/admin/walkthroughs/${id}/status`, "maintainer", { status: "published" });
    const list = await t.call("GET", "/api/walkthroughs/published", "user");
    expect(Object.keys(list.body).sort()).toEqual(["external", "walkthroughs"]);
    expect((list.body.walkthroughs as { id: string }[]).map((g) => g.id)).toEqual([builtIn.id]);
    expect(list.body.external).toEqual([{ id: guide.id, title: "Submit an order", description: "Submit the order.", application: { id: managed, name: "Orders app", origin: "http://127.0.0.1:5187" } }]);
    const bundle = await t.call("GET", `/api/walkthroughs/published/${guide.id}/bundle`, "user");
    expect(bundle.status).toBe(200);
    expect(Object.keys(bundle.body).sort()).toEqual(["application", "definition", "registry"]);
    expect(bundle.body.application).toEqual({ id: managed, name: "Orders app", origin: "http://127.0.0.1:5187" });
    expect(bundle.body.definition).toMatchObject({ id: guide.id, title: "Submit an order" });
    const registry = bundle.body.registry as { routes: string[]; elements: { id: string; privacy: string }[]; postconditionNames: string[]; pages: Record<string, string> };
    expect(Object.keys(registry).sort()).toEqual(["elements", "pages", "postconditionNames", "routes"]);
    expect(registry.routes).toEqual(["orders"]);
    expect(registry.elements.map((e) => [e.id, e.privacy])).toEqual([["orders.submitButton", "public"], ["orders.note", "public"]]);
    expect(registry.postconditionNames).toEqual(["route.orders"]);
    expect(registry.pages).toEqual({ "/#/orders": "orders" });
    for (const word of ["perm.", "tenant", "createdBy", "created_by", "SECRET"]) expect(bundle.raw, word).not.toContain(word);
  });
  it("the bundle is 404 for a built-in guide, a draft, an unpublished guide, an unknown or malformed id and another tenant's guide; a disabled application still serves its published guides", async () => {
    const a = await start(); const b = await start();
    const managed = await a.createApplication();
    await a.registerOk(managed);
    const reference = await a.createApplication(referenceConfig());
    const guide = await a.createWorkflow(managed, managedDef());
    const draft = await a.createWorkflow(managed, managedDef(undefined, undefined, { title: "Draft" }));
    const builtIn = await a.createWorkflow(reference, profileDef());
    for (const id of [guide.id, builtIn.id]) await a.call("POST", `/api/admin/walkthroughs/${id}/status`, "maintainer", { status: "published" });
    const bundle = (t: typeof a, id: string) => t.call("GET", `/api/walkthroughs/published/${id}/bundle`, "user");
    for (const id of [builtIn.id, draft.id, "wt-ffffffffffff", "profileUpdate", "wt-preview", "nope"]) expect((await bundle(a, id)).body, id).toMatchObject({ kind: "not_found" });
    expect((await bundle(b, guide.id)).status).toBe(404);
    await a.call("POST", `/api/admin/applications/${managed}/status`, "maintainer", { enabled: false });
    expect((await bundle(a, guide.id)).status).toBe(200);
    expect(((await a.call("GET", "/api/walkthroughs/published", "user")).body.external as unknown[])).toHaveLength(1);
    await a.call("POST", `/api/admin/walkthroughs/${guide.id}/status`, "maintainer", { status: "draft" });
    expect((await bundle(a, guide.id)).status).toBe(404);
  });
  it("a published managed guide whose route disappeared from the registry cannot exist (a route is permanent), and a guide that no longer validates is left out while others load", async () => {
    const t = await start();
    const appId = await t.createApplication();
    await t.registerOk(appId);
    await t.registerOk(appId, { targetId: "orders.note", elementRole: "textbox", operations: ["highlight", "input"], label: "Note" });
    const one = await t.createWorkflow(appId, managedDef("orders.submitButton"));
    const two = await t.createWorkflow(appId, managedDef("orders.note", "orders", { title: "Second guide" }));
    for (const id of [one.id, two.id]) await t.call("POST", `/api/admin/walkthroughs/${id}/status`, "maintainer", { status: "published" });
    await t.call("POST", `/api/admin/applications/${appId}/targets/orders.note/status`, "maintainer", { status: "disabled" });
    const external = ((await t.call("GET", "/api/walkthroughs/published", "user")).body.external as { id: string }[]).map((g) => g.id);
    expect(external).toEqual([one.id]);
  });
});
