/**
 * Studio COMPLETION S1/S2/S7 end to end on PostgreSQL through the REAL Gateway, executors, stores and HTTP routes: routing and runtime access on enrolment, the server-made runtime key (stable
 * until rotated, never in an audit record), history registration, ROUTING_LOCKED, counts and the overview, and the key-addressed runtime delivery through the tenant-scoped lookup
 * (exact Origin, disabled/rotated/not-live refusals, cross-tenant isolation, the rate limit). NEEDS the PostgreSQL of deploy/compose.yaml; every test uses tenants of its own.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import type { ReferenceHost } from "../../apps/reference-host/src/index.js";
import { createPostgresApplicationStore } from "../../apps/reference-host/src/studio/postgres-application-store.js";
import { registerRuntimeRoutes } from "../../apps/reference-host/src/studio/runtime-routes.js";
import { openStatePools } from "../../packages/security/src/state/conformance/state-pg-fixtures.js";
import { managedConfig, managedDef, referenceConfig, registration, startHost } from "./studio-registry.support.js";

let owner: Pool; let probe: Pool;
const closers: (() => Promise<unknown>)[] = [];
const hosts: ReferenceHost[] = [];
beforeAll(async () => { ({ app: probe, owner } = await openStatePools(Pool)); });
afterAll(async () => { await Promise.all([probe?.end(), owner?.end()]); });
afterEach(async () => { await Promise.all([...closers.splice(0).map((close) => close()), ...hosts.splice(0).map((host) => host.close())]); });

const ORIGIN = "http://127.0.0.1:5187";
const HISTORY_ORIGIN = "http://127.0.0.1:5189";
const KEY = /^rk-[a-f0-9]{32}-[a-f0-9]{32}$/;

async function start(options: { rateLimit?: { max: number; windowMs: number; maxEntries: number } } = {}) {
  const t = await startHost(closers, hosts, owner);
  registerRuntimeRoutes(t.app, { applications: t.applications, store: t.store, catalog: t.catalog, targets: t.targets, resolver: t.resolver, ...(options.rateLimit === undefined ? {} : { rateLimit: options.rateLimit }) });
  const runtime = async (path: string, origin: string | null, method: "GET" | "OPTIONS" = "GET", headers: Record<string, string> = {}) => {
    const res = await t.app.inject({ method, url: path, headers: { ...(origin === null ? {} : { origin }), ...headers } });
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(res.body) as Record<string, unknown>; } catch { /* empty */ }
    return { status: res.statusCode, body, raw: res.body, headers: res.headers };
  };
  const config = (over: Record<string, unknown> = {}) => managedConfig({ runtimeAccess: true, ...over } as never);
  const view = async (appId: string) => (await t.call("GET", `/api/admin/applications/${appId}`, "maintainer")).body;
  const publish = async (appId: string, definition = managedDef()) => {
    const wf = await t.createWorkflow(appId, definition);
    expect(wf.res.status).toBe(201);
    expect((await t.call("POST", `/api/admin/walkthroughs/${wf.id}/status`, "maintainer", { status: "published" })).status).toBe(200);
    return wf.id;
  };
  return { ...t, runtime, config, view, publish };
}

describe("routing and runtime access on enrolment through the real routes and Gateway", () => {
  it("enrols a managed application with history routing and runtime access: the key is made by the server (rk- + 32 hex), the view says so, and it is stable across saves and access off/on", async () => {
    const t = await start();
    const created = await t.call("POST", "/api/admin/applications", "maintainer", t.config({ routing: "history", origin: HISTORY_ORIGIN, allowedOrigins: [HISTORY_ORIGIN] }));
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ routing: "history", runtimeAccess: true, source: "studio-managed", counts: { targets: 0, drafts: 0, published: 0 } });
    const key = created.body.runtimeKey as string;
    expect(key).toMatch(KEY);
    const id = created.body.id as string;
    const put = (over: Record<string, unknown>) => t.call("PUT", `/api/admin/applications/${id}`, "maintainer", t.config({ routing: "history", origin: HISTORY_ORIGIN, allowedOrigins: [HISTORY_ORIGIN], ...over }));
    expect((await put({ name: "Renamed" })).body).toMatchObject({ name: "Renamed", runtimeKey: key });
    expect((await put({ runtimeAccess: false })).body).toMatchObject({ runtimeAccess: false, runtimeKey: key });
    expect((await put({ runtimeAccess: true })).body).toMatchObject({ runtimeAccess: true, runtimeKey: key });
  });
  it("defaults on POST are hash and no runtime access (and no key); a built-in application cannot ask for history or runtime access (422)", async () => {
    const t = await start();
    const created = await t.call("POST", "/api/admin/applications", "maintainer", managedConfig());
    expect(created.body).toMatchObject({ routing: "hash", runtimeAccess: false, runtimeKey: null });
    for (const over of [{ routing: "history" }, { runtimeAccess: true }]) {
      const res = await t.call("POST", "/api/admin/applications", "maintainer", referenceConfig(over as never));
      expect(res.status, JSON.stringify(over)).toBe(422);
    }
  });
  it("the audit trail of enrolment and rotation records the application id only: no origin, routing, runtime flag or key ever reaches an audit row", async () => {
    const t = await start();
    const created = await t.call("POST", "/api/admin/applications", "maintainer", t.config());
    const id = created.body.id as string;
    const rotated = await t.call("POST", `/api/admin/applications/${id}/runtime-key`, "maintainer");
    expect(rotated.status).toBe(200);
    const text = JSON.stringify(await t.rows());
    for (const word of [created.body.runtimeKey as string, rotated.body.runtimeKey as string, "rk-", ORIGIN, "runtimeAccess", "routing", "history"]) expect(text, word).not.toContain(word);
    const trail = (await t.rows()).filter((row) => row.action_id === "rotateStudioRuntimeKey");
    expect(trail.map((row) => row.event_type)).toEqual(["AI_ACTION_PROPOSED", "AI_ACTION_ALLOWED", "AI_ACTION_EXECUTED"]);
    expect(trail[1]).toMatchObject({ risk: "MEDIUM", resource_type: "studioApplication", resource_id: id, params_view: { "/applicationId": id } });
  });
  it("rotation replaces the key (the old one no longer resolves in its tenant; the new one carries the tenant), only for managed applications; the ordinary user cannot rotate", async () => {
    const t = await start();
    const created = await t.call("POST", "/api/admin/applications", "maintainer", t.config());
    const id = created.body.id as string; const old = created.body.runtimeKey as string;
    const rotated = await t.call("POST", `/api/admin/applications/${id}/runtime-key`, "maintainer");
    expect(rotated.body.runtimeKey).toMatch(KEY);
    expect(rotated.body.runtimeKey).not.toBe(old);
    expect(rotated.body.runtimeKey).toContain(`rk-${t.tenant.replace(/-/g, "")}-`);
    expect(await t.applications.findByRuntimeKey(t.tenant, old)).toBeNull();
    expect((await t.applications.findByRuntimeKey(t.tenant, rotated.body.runtimeKey as string))?.id).toBe(id);
    const builtIn = await t.createApplication(referenceConfig());
    expect((await t.call("POST", `/api/admin/applications/${builtIn}/runtime-key`, "maintainer")).body).toMatchObject({ code: "REGISTRY_NOT_MANAGED" });
    expect((await t.call("POST", `/api/admin/applications/${id}/runtime-key`, "user")).status).toBe(403);
    expect((await t.targets.list(t.tenant, id)).targets).toEqual([]);
  });
  it("another tenant cannot rotate or read this tenant's key, and its application ids look unknown", async () => {
    const one = await start(); const two = await start();
    const id = (await one.call("POST", "/api/admin/applications", "maintainer", one.config())).body.id as string;
    expect((await two.call("POST", `/api/admin/applications/${id}/runtime-key`, "maintainer")).status).toBe(404);
    expect((await two.call("GET", `/api/admin/applications/${id}`, "maintainer")).status).toBe(404);
    expect((await two.call("GET", `/api/admin/applications/${id}/overview`, "maintainer")).status).toBe(404);
    expect((await two.call("GET", "/api/admin/applications", "maintainer")).body.applications).toEqual([]);
  });
});

describe("history registration and the routing lock through the real Gateway and PostgreSQL", () => {
  it("a history application registers pathname pages; a hash page is refused, and a hash application refuses a pathname (nothing is stored)", async () => {
    const t = await start();
    const history = (await t.call("POST", "/api/admin/applications", "maintainer", t.config({ routing: "history", origin: HISTORY_ORIGIN, allowedOrigins: [HISTORY_ORIGIN] }))).body.id as string;
    const hash = await t.createApplication(managedConfig({ name: "Hash app" }));
    const REFUSED = { outcome: "ALLOWED", category: "try_later" };
    expect(await t.registerTarget(history, registration({ targetId: "users.save", route: "users123", page: "/users/123" }))).toEqual({ outcome: "ALLOWED", category: "ok" });
    expect(await t.registerTarget(history, registration({ targetId: "orders.go", route: "orders", page: "/#/orders" }))).toEqual(REFUSED);
    expect(await t.registerTarget(hash, registration({ targetId: "users.save", route: "users123", page: "/users/123" }))).toEqual(REFUSED);
    expect((await t.targets.list(t.tenant, history)).routes).toEqual([{ route: "users123", page: "/users/123" }]);
    expect((await t.targets.list(t.tenant, hash))).toEqual({ targets: [], routes: [] });
    // the registry read of the history application maps pathnames to routes
    expect((await t.call("GET", `/api/admin/applications/${history}/registry`, "maintainer")).body).toMatchObject({ routes: ["users123"], pages: { "/users/123": "users123" }, postconditionNames: ["route.users123"] });
  });
  it("history pages must be well formed pathnames: a trailing slash, a query, a fragment, a dot segment or 201 characters never reach the database", async () => {
    const t = await start();
    const id = (await t.call("POST", "/api/admin/applications", "maintainer", t.config({ routing: "history", origin: HISTORY_ORIGIN, allowedOrigins: [HISTORY_ORIGIN] }))).body.id as string;
    for (const page of ["/users/", "/users?x=1", "/users#x", "/a/./b", "/a/../b", `/${"a".repeat(200)}`, "/a b", "/a%20b"]) {
      const feedback = await t.registerTarget(id, registration({ targetId: "users.save", route: "users123", page }));
      expect(feedback.outcome === "ALLOWED" && feedback.category === "ok", page).toBe(false);
    }
    expect((await t.targets.list(t.tenant, id))).toEqual({ targets: [], routes: [] });
  });
  it("routing is 409 ROUTING_LOCKED once the first route exists (route and database agree), and before that it may change", async () => {
    const t = await start();
    const id = (await t.call("POST", "/api/admin/applications", "maintainer", t.config())).body.id as string;
    const put = (routing: string) => t.call("PUT", `/api/admin/applications/${id}`, "maintainer", t.config({ routing }));
    expect((await put("history")).body).toMatchObject({ routing: "history" });
    expect((await put("hash")).body).toMatchObject({ routing: "hash" });
    await t.registerOk(id);
    const locked = await put("history");
    expect(locked).toMatchObject({ status: 409, body: { kind: "conflict", code: "ROUTING_LOCKED" } });
    expect((await t.view(id)).routing).toBe("hash");
    expect((await put("hash")).status, "the same routing is still fine").toBe(200);
    // the Gateway executor refuses it as well, without the route's pre-check
    const feedback = await t.submit("saveStudioApplication", { applicationId: id, ...t.config({ routing: "history" }) });
    expect(feedback).toEqual({ outcome: "ALLOWED", category: "try_later" });
    expect((await t.view(id)).routing).toBe("hash");
  });
});

describe("counts and the overview over real rows", () => {
  it("counts targets, drafts and published workflows per application in one list read, tenant-scoped; the overview adds the target states", async () => {
    const t = await start();
    const one = await t.createApplication(managedConfig({ name: "One" }));
    const two = await t.createApplication(managedConfig({ name: "Two", origin: "http://127.0.0.1:5188", allowedOrigins: ["http://127.0.0.1:5188"] }));
    await t.registerOk(one);
    await t.registerOk(one, { targetId: "orders.note", elementRole: "textbox", operations: ["highlight", "input"], label: "Note", description: "The note" });
    await t.registerOk(one, { targetId: "orders.cancel", label: "Cancel" });
    await t.call("POST", `/api/admin/applications/${one}/targets/orders.cancel/status`, "maintainer", { status: "disabled" });
    await t.registerOk(two);
    await t.createWorkflow(one, managedDef());
    await t.publish(one, managedDef(undefined, undefined, { title: "Live" }));
    const list = (await t.call("GET", "/api/admin/applications", "maintainer")).body.applications as { id: string; counts: unknown }[];
    expect(list.find((a) => a.id === one)!.counts).toEqual({ targets: 3, drafts: 1, published: 1 });
    expect(list.find((a) => a.id === two)!.counts).toEqual({ targets: 1, drafts: 0, published: 0 });
    const overview = await t.call("GET", `/api/admin/applications/${one}/overview`, "maintainer");
    expect(overview.body.targets).toEqual({ total: 3, active: 2, disabled: 1, healthy: 0, unverified: 2, broken: 0 });
    expect(overview.body.workflows).toEqual({ draft: 1, published: 1 });
    expect(overview.body.application).toMatchObject({ id: one, counts: { targets: 3, drafts: 1, published: 1 } });
  });
  it("the list is ONE aggregate round trip: the number of statements does not grow with the number of applications", async () => {
    const t = await start();
    const statements: string[] = [];
    const counting = { connect: async () => { const client = await t.pool.connect(); return { query: (sql: string, params?: unknown[]) => { statements.push(sql); return client.query(sql, params as never); }, release: (d?: boolean) => client.release(d) }; } };
    const store = createPostgresApplicationStore(counting as never);
    for (let i = 0; i < 4; i += 1) await t.createApplication(managedConfig({ name: `App ${i}`, origin: `http://127.0.0.1:${5300 + i}`, allowedOrigins: [`http://127.0.0.1:${5300 + i}`] }));
    const list = await store.list(t.tenant);
    expect(list).toHaveLength(4);
    expect(statements.filter((sql) => /SELECT/u.test(sql) && /studio_applications/u.test(sql))).toHaveLength(1);
    expect(statements).toHaveLength(4); // BEGIN, set_config, the one SELECT, COMMIT
  });
});

describe("independent runtime delivery over PostgreSQL (the real tenant-scoped read)", () => {
  async function live() {
    const t = await start();
    const created = await t.call("POST", "/api/admin/applications", "maintainer", t.config({ name: "Orders" }));
    const id = created.body.id as string; const key = created.body.runtimeKey as string;
    await t.registerOk(id);
    const guide = await t.publish(id);
    return { t, id, key, guide };
  }
  it("lists and serves the live guide with the exact-Origin CORS headers; the bundle carries markers, checks, routing, pages and the version", async () => {
    const { t, key, guide, id } = await live();
    const list = await t.runtime(`/api/runtime/${key}/guides`, ORIGIN);
    expect(list.status).toBe(200);
    expect(list.body).toEqual({ guides: [{ id: guide, title: "Submit an order", description: "Submit the order." }] });
    expect(list.headers["access-control-allow-origin"]).toBe(ORIGIN);
    expect(list.headers.vary).toBe("Origin");
    expect(list.headers["access-control-allow-credentials"]).toBeUndefined();
    const item = await t.runtime(`/api/runtime/${key}/guides/${guide}`, ORIGIN);
    expect(item.status).toBe(200);
    expect(item.body).toMatchObject({ version: 1, application: { id, name: "Orders", origin: ORIGIN }, registry: { routing: "hash", checks: [], pages: { "/#/orders": "orders" }, routes: ["orders"] } });
    expect((item.body.registry as { elements: { id: string; marker: string }[] }).elements.map((e) => [e.id, e.marker])).toEqual([["orders.submitButton", "orders.submitButton"]]);
    // the maintainer route serves the SAME bundle (one builder)
    expect((await t.call("GET", `/api/walkthroughs/published/${guide}/bundle`, "user")).body).toEqual(item.body);
    for (const word of [t.tenant, "perm.", "tenant", "runtimeKey", "allowedOrigins"]) expect(item.raw, word).not.toContain(word);
  });
  it("refuses a missing or other Origin with 403 and no CORS header; the preflight answers the allowed origin only", async () => {
    const { t, key, guide } = await live();
    for (const origin of [null, "http://other.example", "http://127.0.0.1:5188", "https://127.0.0.1:5187", `${ORIGIN}/`, "HTTP://127.0.0.1:5187"]) {
      const res = await t.runtime(`/api/runtime/${key}/guides/${guide}`, origin);
      expect(res.status, String(origin)).toBe(403);
      for (const name of Object.keys(res.headers)) expect(name.startsWith("access-control-"), name).toBe(false);
    }
    expect((await t.runtime(`/api/runtime/${key}/guides`, ORIGIN, "OPTIONS", { "access-control-request-method": "GET" })).status).toBe(204);
    expect((await t.runtime(`/api/runtime/${key}/guides`, "http://evil.example", "OPTIONS", { "access-control-request-method": "GET" })).status).toBe(403);
  });
  it("binds the SDK's application identifier to the key for list and bundle reads", async () => {
    const { t, id, key, guide } = await live();
    const other = await t.createApplication(t.config({ name: "Other application" }));
    for (const resource of ["guides", `guides/${guide}`]) {
      const path = `/api/runtime/${key}/${resource}`;
      expect((await t.runtime(`${path}?applicationId=${id}`, ORIGIN)).status).toBe(200);
      for (const query of [other, "invalid", `${id}&applicationId=${other}`]) {
        const result = await t.runtime(`${path}?applicationId=${query}`, ORIGIN);
        expect(result.status).toBe(404);
        expect(result.body).toEqual({ kind: "not_found", message: "Not found." });
        expect(result.headers["cache-control"]).toBe("no-store");
      }
    }
  });
  it("a disabled application, runtime access off, a rotated key and an unknown key are the same 404; re-enabling restores the same key", async () => {
    const { t, id, key, guide } = await live();
    const probe404 = async (k: string) => (await t.runtime(`/api/runtime/${k}/guides/${guide}`, ORIGIN)).raw;
    const unknown = await probe404(`rk-${t.tenant.replace(/-/g, "")}-${"0".repeat(32)}`);
    expect(JSON.parse(unknown)).toMatchObject({ kind: "not_found" });
    expect((await t.call("POST", `/api/admin/applications/${id}/status`, "maintainer", { enabled: false })).status).toBe(200);
    expect(await probe404(key)).toBe(unknown);
    expect((await t.call("POST", `/api/admin/applications/${id}/status`, "maintainer", { enabled: true })).status).toBe(200);
    expect((await t.runtime(`/api/runtime/${key}/guides/${guide}`, ORIGIN)).status).toBe(200);
    expect((await t.call("PUT", `/api/admin/applications/${id}`, "maintainer", t.config({ name: "Orders", runtimeAccess: false }))).status).toBe(200);
    expect(await probe404(key)).toBe(unknown);
    expect((await t.call("PUT", `/api/admin/applications/${id}`, "maintainer", t.config({ name: "Orders", runtimeAccess: true }))).body.runtimeKey).toBe(key);
    expect((await t.runtime(`/api/runtime/${key}/guides/${guide}`, ORIGIN)).status).toBe(200);
    const fresh = (await t.call("POST", `/api/admin/applications/${id}/runtime-key`, "maintainer")).body.runtimeKey as string;
    expect(await probe404(key)).toBe(unknown);
    expect((await t.runtime(`/api/runtime/${fresh}/guides/${guide}`, ORIGIN)).status).toBe(200);
  });
  it("a guide that is unpublished or no longer validates (a disabled target) is not served; re-enabling the target restores it", async () => {
    const { t, id, key, guide } = await live();
    const served = async () => (await t.runtime(`/api/runtime/${key}/guides/${guide}`, ORIGIN)).status;
    expect(await served()).toBe(200);
    await t.call("POST", `/api/admin/applications/${id}/targets/orders.submitButton/status`, "maintainer", { status: "disabled" });
    expect(await served()).toBe(404);
    expect((await t.runtime(`/api/runtime/${key}/guides`, ORIGIN)).body).toEqual({ guides: [] });
    await t.call("POST", `/api/admin/applications/${id}/targets/orders.submitButton/status`, "maintainer", { status: "active" });
    expect(await served()).toBe(200);
    expect((await t.call("POST", `/api/admin/walkthroughs/${guide}/status`, "maintainer", { status: "draft" })).status).toBe(200);
    expect(await served()).toBe(404);
  });
  it("serves a history application's guide with routing history and a pathname page map", async () => {
    const t = await start();
    const created = await t.call("POST", "/api/admin/applications", "maintainer", t.config({ routing: "history", origin: HISTORY_ORIGIN, allowedOrigins: [HISTORY_ORIGIN] }));
    const id = created.body.id as string; const key = created.body.runtimeKey as string;
    await t.registerOk(id, { targetId: "users.save", route: "users123", page: "/users/123" });
    const guide = await t.publish(id, managedDef("users.save", "users123"));
    const item = await t.runtime(`/api/runtime/${key}/guides/${guide}`, HISTORY_ORIGIN);
    expect(item.status).toBe(200);
    expect(item.body.registry).toMatchObject({ routing: "history", pages: { "/users/123": "users123" } });
  });
  it("tenants never cross: tenant two's key and Origin reach only tenant two's guides, and tenant one's guide id is 404 for it", async () => {
    const one = await live();
    const two = await start();
    const created = await two.call("POST", "/api/admin/applications", "maintainer", two.config({ name: "Tenant two orders" }));
    const keyTwo = created.body.runtimeKey as string;
    await two.registerOk(created.body.id as string);
    const guideTwo = await two.publish(created.body.id as string, managedDef(undefined, undefined, { title: "Tenant two guide" }));
    expect((await two.runtime(`/api/runtime/${keyTwo}/guides`, ORIGIN)).body).toEqual({ guides: [{ id: guideTwo, title: "Tenant two guide", description: "Submit the order." }] });
    expect((await two.runtime(`/api/runtime/${keyTwo}/guides/${one.guide}`, ORIGIN)).status).toBe(404);
    expect((await one.t.runtime(`/api/runtime/${one.key}/guides/${guideTwo}`, ORIGIN)).status).toBe(404);
    expect((await one.t.runtime(`/api/runtime/${one.key}/guides`, ORIGIN)).raw).not.toContain("Tenant two");
  });
  it("a key whose tenant part names ANOTHER tenant resolves nothing, through the real database, and is the same fixed 404 as an unknown key", async () => {
    const one = await live();
    const two = await start();
    const createdTwo = await two.call("POST", "/api/admin/applications", "maintainer", two.config());
    const hexTwo = two.tenant.replace(/-/g, "");
    const crossed = `rk-${hexTwo}-${one.key.slice(-32)}`; // tenant two's id with tenant one's random part
    const unknown = await one.t.runtime(`/api/runtime/rk-${one.t.tenant.replace(/-/g, "")}-${"0".repeat(32)}/guides`, ORIGIN);
    const res = await one.t.runtime(`/api/runtime/${crossed}/guides`, ORIGIN);
    expect(res.status).toBe(404);
    expect(res.raw).toBe(unknown.raw);
    // tenant two's own key with the origin of tenant two's application works; tenant one's key never reads tenant two's rows
    expect((await two.runtime(`/api/runtime/${createdTwo.body.runtimeKey}/guides`, ORIGIN)).status).toBe(200);
    expect((await one.t.applications.findByRuntimeKey(two.tenant, one.key))).toBeNull();
  });
  it("the rate limit answers 429 after the allowed requests, with no CORS header", async () => {
    const t = await start({ rateLimit: { max: 3, windowMs: 60_000, maxEntries: 100 } });
    const created = await t.call("POST", "/api/admin/applications", "maintainer", t.config());
    const key = created.body.runtimeKey as string;
    for (let i = 0; i < 3; i += 1) expect((await t.runtime(`/api/runtime/${key}/guides`, ORIGIN)).status).toBe(200);
    const limited = await t.runtime(`/api/runtime/${key}/guides`, ORIGIN);
    expect(limited.status).toBe(429);
    for (const name of Object.keys(limited.headers)) expect(name.startsWith("access-control-"), name).toBe(false);
  });
});
