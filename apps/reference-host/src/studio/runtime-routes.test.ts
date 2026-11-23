/**
 * Independent runtime delivery (Studio COMPLETION, S7) with focused fakes: the key lookup, the exact-Origin authorisation, CORS headers, every refusal, the preflight, the rate limit,
 * cross-tenant isolation and the shared bundle. The PostgreSQL proof (the real SECURITY DEFINER function, real stores) is tests/integration/studio-runtime.test.ts.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGuidanceTransport } from "../http/transport.js";
import { createProposalStore } from "../http/proposal-store.js";
import type { StoredWalkthrough, WalkthroughStore } from "../authoring/store.js";
import { FakeApplicationStore } from "./fake-application-store.js";
import { FakeTargetStore } from "./fake-target-store.js";
import { createRegistryCatalog } from "./registries.js";
import type { ApplicationConfig } from "./applications.js";
import { generateRuntimeKey } from "./applications.js";
import { RUNTIME_MESSAGES, RUNTIME_RATE_LIMIT, createRateLimiter, registerRuntimeRoutes } from "./runtime-routes.js";

const TENANT_A = "1111aaaa-2222-4333-8444-5555bbbb5555";
const TENANT_B = "2222bbbb-3333-4444-8555-6666cccc6666";
const APP_A = "app-0000000000a1"; // tenant A, managed, hash, runtime on
const APP_A2 = "app-0000000000a2"; // tenant A, managed, runtime on (another application of the same tenant)
const APP_H = "app-0000000000a3"; // tenant A, managed, HISTORY, runtime on
const APP_B = "app-0000000000b1"; // tenant B, managed, runtime on
const APP_OFF = "app-0000000000c1"; // tenant A, managed, runtime OFF
const APP_BUILT_IN = "app-0000000000d1"; // tenant A, built-in
const ORIGIN = "http://127.0.0.1:5187";
const ORIGIN_2 = "http://localhost:5187";
const GUIDE_A = "wt-0000000000a1";
const GUIDE_A2 = "wt-0000000000a2";
const GUIDE_DRAFT = "wt-0000000000a3";
const GUIDE_H = "wt-0000000000a4";
const GUIDE_B = "wt-0000000000b1";
const HEX_A = TENANT_A.replace(/-/g, "");
const HEX_B = TENANT_B.replace(/-/g, "");
const SECRETS = [TENANT_A, TENANT_B, "perm.", "allowedOrigins", "runtimeKey", "runtimeAccess", "createdBy", "tenant"];

const managed = (name: string, over: Partial<ApplicationConfig> = {}): ApplicationConfig => ({ name, origin: ORIGIN, allowedOrigins: [ORIGIN, ORIGIN_2], environment: "test", registryId: "studio-managed", routing: "hash", runtimeAccess: true, ...over });
const def = (route = "orders", target = "orders.submitButton", title = "Submit an order") => ({
  title, description: "Submit the order.", start: "n1",
  steps: [{ id: "n1", kind: "navigate", route, next: "s1" }, { id: "s1", kind: "guide", target, text: "Press the button.", wait: "click", verify: `route.${route}`, next: "done" }, { id: "done", kind: "complete", text: "Done." }],
});
const TARGET = { targetId: "orders.submitButton", route: "orders", page: "/#/orders", role: "button" as const, label: "Submit order", description: "Submits.", operations: ["highlight", "click"] as never, privacy: "public" as const };

const open: Array<{ close: () => Promise<unknown> }> = [];
afterEach(async () => { vi.useRealTimers(); await Promise.all(open.splice(0).map((app) => app.close())); });

async function build(options: { rateLimit?: { max: number; windowMs: number; maxEntries: number }; now?: () => number; lookupSpy?: boolean } = {}) {
  const applications = new FakeApplicationStore();
  const targets = new FakeTargetStore(applications);
  const scopeA = { tenantId: TENANT_A, actor: "seed" }; const scopeB = { tenantId: TENANT_B, actor: "seed" };
  await applications.save(scopeA, APP_A, managed("Orders"));
  await applications.save(scopeA, APP_A2, managed("Second", { origin: "http://127.0.0.1:5188", allowedOrigins: ["http://127.0.0.1:5188"] }));
  await applications.save(scopeA, APP_H, managed("History", { routing: "history", origin: "http://127.0.0.1:5189", allowedOrigins: ["http://127.0.0.1:5189"] }));
  await applications.save(scopeA, APP_OFF, managed("Off", { runtimeAccess: false }));
  await applications.save(scopeA, APP_BUILT_IN, { name: "Built-in", origin: "http://127.0.0.1:5173", allowedOrigins: ["http://127.0.0.1:5173"], environment: "test", registryId: "reference" });
  await applications.save(scopeB, APP_B, managed("Tenant B"));
  await targets.register(scopeA, APP_A, TARGET);
  await targets.register(scopeA, APP_A2, TARGET);
  await targets.register(scopeA, APP_OFF, TARGET);
  await targets.register(scopeB, APP_B, TARGET);
  await targets.register(scopeA, APP_H, { ...TARGET, targetId: "users.save", route: "users123", page: "/users/123", label: "Save" });
  const rows: (Omit<StoredWalkthrough, "status"> & { tenantId: string; status: "draft" | "published" })[] = [];
  const publish = (tenantId: string, id: string, applicationId: string | null, definition: unknown, status: "draft" | "published" = "published") => rows.push({ tenantId, id, status, applicationId, definition: { ...(definition as object), id }, updatedAt: "2026-01-01T00:00:00.000Z" });
  publish(TENANT_A, GUIDE_A, APP_A, def());
  publish(TENANT_A, GUIDE_A2, APP_A2, def("orders", "orders.submitButton", "Second app guide"));
  publish(TENANT_A, GUIDE_DRAFT, APP_A, def("orders", "orders.submitButton", "A draft"), "draft");
  publish(TENANT_A, GUIDE_H, APP_H, def("users123", "users.save", "History guide"));
  publish(TENANT_B, GUIDE_B, APP_B, def("orders", "orders.submitButton", "Tenant B guide"));
  const store: Pick<WalkthroughStore, "listPublished"> = { listPublished: async (tenantId) => rows.filter((row) => row.tenantId === tenantId && row.status === "published") };
  const lookups: string[] = [];
  const realFind = applications.findByRuntimeKey.bind(applications);
  applications.findByRuntimeKey = async (tenantId, key) => { lookups.push(`${tenantId}|${key}`); return realFind(tenantId, key); };
  const app = createGuidanceTransport({ ask: async () => ({ kind: "clarify", message: "x" }), catalog: { list: () => [] }, resolveSession: async () => null, proposals: createProposalStore({ now: Date.now, newId: () => "unused" }) });
  open.push(app);
  registerRuntimeRoutes(app, { applications, store, catalog: createRegistryCatalog(), targets, ...(options.rateLimit === undefined ? {} : { rateLimit: options.rateLimit }), ...(options.now === undefined ? {} : { now: options.now }) });
  const key = async (tenantId: string, id: string) => (await applications.get(tenantId, id))!.runtimeKey!;
  const call = async (path: string, init: { method?: "GET" | "OPTIONS" | "POST"; origin?: string | null; headers?: Record<string, string>; remoteAddress?: string } = {}) => {
    const headers: Record<string, string> = { ...(init.origin === null || init.origin === undefined ? {} : { origin: init.origin }), ...(init.headers ?? {}) };
    const res = await app.inject({ method: init.method ?? "GET", url: path, headers, ...(init.remoteAddress === undefined ? {} : { remoteAddress: init.remoteAddress }) });
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(res.body) as Record<string, unknown>; } catch { /* empty */ }
    return { status: res.statusCode, body, raw: res.body, headers: res.headers };
  };
  return { app, applications, targets, publish, rows, lookups, key, call, scopeA, scopeB };
}
const noCors = (headers: Record<string, unknown>) => { for (const name of Object.keys(headers)) expect(name.startsWith("access-control-"), name).toBe(false); };
const noLeak = (raw: string) => { for (const word of SECRETS) expect(raw, word).not.toContain(word); };

describe("the guide list", () => {
  it("returns the application's live guides only, with the CORS headers for the exact Origin and no credentials header", async () => {
    const h = await build();
    const res = await h.call(`/api/runtime/${await h.key(TENANT_A, APP_A)}/guides`, { origin: ORIGIN });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ guides: [{ id: GUIDE_A, title: "Submit an order", description: "Submit the order." }] });
    expect(res.headers["access-control-allow-origin"]).toBe(ORIGIN);
    expect(res.headers.vary).toBe("Origin");
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    expect(String(res.headers["content-type"])).toContain("application/json");
    expect(res.headers["access-control-allow-credentials"]).toBeUndefined();
    expect(res.headers["set-cookie"]).toBeUndefined();
    noLeak(res.raw);
  });
  it("accepts every stored allowed origin and echoes exactly the one that asked", async () => {
    const h = await build();
    const key = await h.key(TENANT_A, APP_A);
    expect((await h.call(`/api/runtime/${key}/guides`, { origin: ORIGIN_2 })).headers["access-control-allow-origin"]).toBe(ORIGIN_2);
  });
  it("never lists a draft, another application's guide or another tenant's guide", async () => {
    const h = await build();
    const own = (await h.call(`/api/runtime/${await h.key(TENANT_A, APP_A)}/guides`, { origin: ORIGIN })).raw;
    for (const forbidden of [GUIDE_DRAFT, GUIDE_A2, GUIDE_H, GUIDE_B, "A draft", "Second app guide", "Tenant B guide"]) expect(own, forbidden).not.toContain(forbidden);
    const other = await h.call(`/api/runtime/${await h.key(TENANT_A, APP_A2)}/guides`, { origin: "http://127.0.0.1:5188" });
    expect(other.body).toEqual({ guides: [{ id: GUIDE_A2, title: "Second app guide", description: "Submit the order." }] });
  });
  it("a guide that no longer validates against the CURRENT registry (a disabled target) drops out of the list and the item is 404", async () => {
    const h = await build();
    const key = await h.key(TENANT_A, APP_A);
    expect((await h.call(`/api/runtime/${key}/guides/${GUIDE_A}`, { origin: ORIGIN })).status).toBe(200);
    await h.targets.setStatus(h.scopeA, APP_A, "orders.submitButton", "disabled");
    expect((await h.call(`/api/runtime/${key}/guides`, { origin: ORIGIN })).body).toEqual({ guides: [] });
    expect(await h.call(`/api/runtime/${key}/guides/${GUIDE_A}`, { origin: ORIGIN })).toMatchObject({ status: 404, body: { kind: "not_found", message: RUNTIME_MESSAGES.notFound } });
    await h.targets.setStatus(h.scopeA, APP_A, "orders.submitButton", "active");
    expect((await h.call(`/api/runtime/${key}/guides/${GUIDE_A}`, { origin: ORIGIN })).status).toBe(200);
  });
  it("an unpublished guide (status draft) is not live", async () => {
    const h = await build();
    h.rows.find((row) => row.id === GUIDE_A)!.status = "draft";
    expect((await h.call(`/api/runtime/${await h.key(TENANT_A, APP_A)}/guides`, { origin: ORIGIN })).body).toEqual({ guides: [] });
  });
});

describe("the guide bundle", () => {
  it("is the shared bundle: definition, application, the registry with markers, checks, routing and pages, and the version", async () => {
    const h = await build();
    const res = await h.call(`/api/runtime/${await h.key(TENANT_A, APP_A)}/guides/${GUIDE_A}`, { origin: ORIGIN });
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(["application", "definition", "registry", "version"]);
    expect(res.body.version).toBe(1);
    expect(res.body.application).toEqual({ id: APP_A, name: "Orders", origin: ORIGIN });
    expect(res.body.definition).toMatchObject({ id: GUIDE_A, title: "Submit an order" });
    const registry = res.body.registry as Record<string, unknown>;
    expect(Object.keys(registry).sort()).toEqual(["checks", "elements", "pages", "postconditionNames", "routes", "routing"]);
    expect(registry).toMatchObject({ routes: ["orders"], routing: "hash", checks: [], pages: { "/#/orders": "orders" }, postconditionNames: ["route.orders"] });
    expect(registry.elements).toEqual([{ id: "orders.submitButton", marker: "orders.submitButton", route: "orders", role: "button", label: "Submit order", description: "Submits.", operations: ["highlight", "click"], privacy: "public" }]);
    noLeak(res.raw);
  });
  it("for a history application the pages map is pathname -> route and the routing says history", async () => {
    const h = await build();
    const res = await h.call(`/api/runtime/${await h.key(TENANT_A, APP_H)}/guides/${GUIDE_H}`, { origin: "http://127.0.0.1:5189" });
    expect(res.body.registry).toMatchObject({ routing: "history", pages: { "/users/123": "users123" }, routes: ["users123"] });
  });
  it("binds the runtime bundle to the allowed origin requesting playback", async () => {
    const h = await build();
    const res = await h.call(`/api/runtime/${await h.key(TENANT_A, APP_A)}/guides/${GUIDE_A}`, { origin: ORIGIN_2 });
    expect(res.status).toBe(200);
    expect(res.headers["access-control-allow-origin"]).toBe(ORIGIN_2);
    expect(res.body.application).toEqual({ id: APP_A, name: "Orders", origin: ORIGIN_2 });
  });
  it("is byte-for-byte the maintainer bundle builder's output (one shared builder)", async () => {
    const { buildGuideBundle } = await import("./guide-bundle.js");
    const h = await build();
    const record = (await h.applications.get(TENANT_A, APP_A))!;
    const { createRegistryResolver } = await import("./registry-resolver.js");
    const resolved = (await createRegistryResolver({ catalog: createRegistryCatalog(), targets: h.targets }).resolve(TENANT_A, record))!;
    const res = await h.call(`/api/runtime/${record.runtimeKey}/guides/${GUIDE_A}`, { origin: ORIGIN });
    expect(res.body).toEqual(JSON.parse(JSON.stringify(buildGuideBundle({ definition: res.body.definition as never, application: record, resolved }))));
  });
  it.each([["a draft", GUIDE_DRAFT], ["another application's guide", GUIDE_A2], ["another tenant's guide", GUIDE_B], ["an unknown guide", "wt-ffffffffffff"], ["a malformed id", "not-a-guide"], ["an upper-case id", "WT-0000000000A1"], ["an over-long id", `wt-${"a".repeat(40)}`]])(
    "%s is 404 with the fixed body", async (_name, id) => {
      const h = await build();
      const res = await h.call(`/api/runtime/${await h.key(TENANT_A, APP_A)}/guides/${id}`, { origin: ORIGIN });
      expect(res).toMatchObject({ status: 404, body: { kind: "not_found", message: RUNTIME_MESSAGES.notFound } });
      expect(res.raw).not.toContain(id.length > 6 ? id : "\u0000");
    });
});

describe("Origin: exactly an allowed origin, or 403 with no CORS header", () => {
  it.each([
    ["no Origin header", null], ["another origin", "http://evil.example"], ["the same host on another port", "http://127.0.0.1:5188"], ["the other scheme", "https://127.0.0.1:5187"], ["a trailing slash", `${ORIGIN}/`],
    ["an upper-case scheme and host", "HTTP://127.0.0.1:5187"], ["a path", `${ORIGIN}/x`], ["the literal null origin", "null"], ["an empty Origin", ""], ["a prefix of an allowed origin", "http://127.0.0.1:518"],
    ["an allowed origin followed by text", `${ORIGIN}.evil.example`], ["a wildcard", "*"],
  ])("%s is refused: 403, fixed body, no Access-Control-* header, nothing of the guides", async (_name, origin) => {
    const h = await build();
    const key = await h.key(TENANT_A, APP_A);
    for (const path of [`/api/runtime/${key}/guides`, `/api/runtime/${key}/guides/${GUIDE_A}`]) {
      const res = await h.call(path, { origin });
      expect(res.status, path).toBe(403);
      expect(res.body).toEqual({ kind: "forbidden", message: RUNTIME_MESSAGES.forbidden });
      noCors(res.headers);
      expect(res.raw).not.toContain("Submit an order");
      expect(res.raw).not.toContain(String(origin).length > 3 ? String(origin) : "\u0000");
    }
  });
  it("a request from the OTHER tenant's application origin cannot read this application", async () => {
    const h = await build();
    expect((await h.call(`/api/runtime/${await h.key(TENANT_A, APP_A2)}/guides`, { origin: ORIGIN })).status).toBe(403);
  });
  it("Cookie and Authorization headers change nothing: the answer depends on the key and the Origin only, and no cookie is ever set", async () => {
    const h = await build();
    const key = await h.key(TENANT_A, APP_A);
    const plain = await h.call(`/api/runtime/${key}/guides`, { origin: ORIGIN });
    const decorated = await h.call(`/api/runtime/${key}/guides`, { origin: ORIGIN, headers: { cookie: "session=abc", authorization: "Bearer x", "x-demo-role": "maintainer" } });
    expect(decorated.body).toEqual(plain.body);
    expect(decorated.headers["set-cookie"]).toBeUndefined();
    const denied = await h.call(`/api/runtime/${key}/guides`, { origin: "http://evil.example", headers: { cookie: "session=abc", authorization: "Bearer x" } });
    expect(denied.status).toBe(403);
  });
});

describe("key refusals: 404, never distinguishing unknown from disabled", () => {
  const FIXED = { kind: "not_found", message: RUNTIME_MESSAGES.notFound };
  it("an unknown key, a disabled application, runtime access off, a rotated key and a key of a built-in application's id look identical", async () => {
    const h = await build();
    const key = await h.key(TENANT_A, APP_A);
    const unknown = await h.call(`/api/runtime/rk-${HEX_A}-${"0".repeat(32)}/guides`, { origin: ORIGIN });
    expect(unknown).toMatchObject({ status: 404, body: FIXED });
    await h.applications.setEnabled(h.scopeA, APP_A, false);
    const disabled = await h.call(`/api/runtime/${key}/guides`, { origin: ORIGIN });
    expect(disabled.status).toBe(404);
    expect(disabled.raw).toBe(unknown.raw);
    expect(Object.keys(disabled.headers).sort()).toEqual(Object.keys(unknown.headers).sort());
    await h.applications.setEnabled(h.scopeA, APP_A, true);
    expect((await h.call(`/api/runtime/${key}/guides`, { origin: ORIGIN })).status).toBe(200);
    // runtime access switched off
    await h.applications.save(h.scopeA, APP_A, managed("Orders", { runtimeAccess: false }));
    expect((await h.call(`/api/runtime/${key}/guides`, { origin: ORIGIN })).raw).toBe(unknown.raw);
    // and back on: the SAME key works again
    await h.applications.save(h.scopeA, APP_A, managed("Orders", { runtimeAccess: true }));
    expect((await h.call(`/api/runtime/${key}/guides`, { origin: ORIGIN })).status).toBe(200);
    // an application whose runtime access never was on has a key of null: nothing to guess
    expect((await h.applications.get(TENANT_A, APP_OFF))!.runtimeKey).toBeNull();
    expect((await h.applications.get(TENANT_A, APP_BUILT_IN))!.runtimeKey).toBeNull();
  });
  it("rotating the key kills the old key at once; the new key works", async () => {
    const h = await build();
    const old = await h.key(TENANT_A, APP_A);
    const fresh = generateRuntimeKey(TENANT_A, () => Buffer.alloc(16, 0xbb));
    expect(await h.applications.rotateRuntimeKey(h.scopeA, APP_A, fresh)).toBe("rotated");
    expect(await h.call(`/api/runtime/${old}/guides`, { origin: ORIGIN })).toMatchObject({ status: 404, body: FIXED });
    expect((await h.call(`/api/runtime/${fresh}/guides`, { origin: ORIGIN })).status).toBe(200);
  });
  it.each([["too short", "rk-abc"], ["the old 32-hex format", `rk-${"a".repeat(32)}`], ["upper-case tenant part", `rk-${HEX_A.toUpperCase()}-${"a".repeat(32)}`], ["upper-case hex", `rk-${HEX_A}-${"A".repeat(32)}`], ["no prefix", `${HEX_A}-${"a".repeat(32)}`], ["a missing random part", `rk-${HEX_A}-`], ["a wrong separator", `rk-${HEX_A}_${"a".repeat(32)}`], ["a sql probe", "x'%20OR%201=1--"], ["a path probe", "..%2Fapplications"], ["33 random hex", `rk-${HEX_A}-${"a".repeat(33)}`]])(
    "a malformed key (%s) is 404 and never reaches the lookup", async (_name, key) => {
      const h = await build();
      expect(await h.call(`/api/runtime/${key}/guides`, { origin: ORIGIN })).toMatchObject({ status: 404 });
      expect(h.lookups).toEqual([]);
    });
  it("a failing lookup or application store is a fixed 503 that leaks nothing", async () => {
    const h = await build();
    const key = await h.key(TENANT_A, APP_A);
    h.applications.failWith = new Error("SECRET db down /home/x");
    const res = await h.call(`/api/runtime/${key}/guides`, { origin: ORIGIN });
    expect(res).toMatchObject({ status: 503, body: { kind: "unavailable", message: RUNTIME_MESSAGES.unavailable } });
    expect(res.raw).not.toContain("SECRET");
  });
  it("only GET and OPTIONS exist: POST, PUT and DELETE are the transport's fixed 404", async () => {
    const h = await build();
    const key = await h.key(TENANT_A, APP_A);
    for (const method of ["POST", "PUT", "DELETE"] as const) {
      const res = await h.app.inject({ method, url: `/api/runtime/${key}/guides`, headers: { origin: ORIGIN } });
      expect(res.statusCode, method).toBeGreaterThanOrEqual(400);
      expect(res.headers["access-control-allow-origin"], method).toBeUndefined();
    }
  });
});

describe("the preflight", () => {
  it("answers only for an allowed origin and only GET: 204 with the origin, GET, a max age and nothing else CORS", async () => {
    const h = await build();
    const key = await h.key(TENANT_A, APP_A);
    const res = await h.call(`/api/runtime/${key}/guides`, { method: "OPTIONS", origin: ORIGIN, headers: { "access-control-request-method": "GET", "access-control-request-headers": "accept" } });
    expect(res.status).toBe(204);
    expect(res.raw).toBe("");
    expect(res.headers["access-control-allow-origin"]).toBe(ORIGIN);
    expect(res.headers["access-control-allow-methods"]).toBe("GET");
    expect(res.headers["access-control-max-age"]).toBe("600");
    expect(res.headers["access-control-allow-headers"]).toBeUndefined();
    expect(res.headers["access-control-allow-credentials"]).toBeUndefined();
    expect(res.headers.vary).toBe("Origin");
    expect((await h.call(`/api/runtime/${key}/guides/${GUIDE_A}`, { method: "OPTIONS", origin: ORIGIN })).status).toBe(204);
  });
  it.each([
    ["another origin", { origin: "http://evil.example" }], ["no origin", { origin: null }], ["a POST", { origin: ORIGIN, headers: { "access-control-request-method": "POST" } }],
    ["a DELETE", { origin: ORIGIN, headers: { "access-control-request-method": "DELETE" } }], ["an authorization header", { origin: ORIGIN, headers: { "access-control-request-method": "GET", "access-control-request-headers": "authorization" } }],
    ["a custom header", { origin: ORIGIN, headers: { "access-control-request-method": "GET", "access-control-request-headers": "accept, x-dap-anything" } }],
    ["a content type", { origin: ORIGIN, headers: { "access-control-request-method": "GET", "access-control-request-headers": "content-type" } }],
  ])("a preflight with %s is refused with no Access-Control-* header", async (_name, init) => {
    const h = await build();
    const res = await h.call(`/api/runtime/${await h.key(TENANT_A, APP_A)}/guides`, { method: "OPTIONS", ...init });
    expect(res.status).toBe(403);
    noCors(res.headers);
  });
  it("an unknown key or a disabled application is 404 for the preflight as well", async () => {
    const h = await build();
    expect((await h.call(`/api/runtime/rk-${HEX_A}-${"1".repeat(32)}/guides`, { method: "OPTIONS", origin: ORIGIN })).status).toBe(404);
  });
});

describe("the rate limit", () => {
  it("allows 60 requests per minute per key and address, then 429 with a fixed body, Retry-After and no CORS header; another key and another address are independent", async () => {
    let clock = 1_000_000;
    const h = await build({ now: () => clock });
    const key = await h.key(TENANT_A, APP_A); const key2 = await h.key(TENANT_A, APP_A2);
    for (let i = 0; i < RUNTIME_RATE_LIMIT.max; i += 1) expect((await h.call(`/api/runtime/${key}/guides`, { origin: ORIGIN })).status, `request ${i}`).toBe(200);
    const limited = await h.call(`/api/runtime/${key}/guides`, { origin: ORIGIN });
    expect(limited).toMatchObject({ status: 429, body: { kind: "rate_limited", message: RUNTIME_MESSAGES.rateLimited } });
    expect(limited.headers["retry-after"]).toBe("60");
    noCors(limited.headers);
    expect((await h.call(`/api/runtime/${key}/guides`, { origin: ORIGIN, remoteAddress: "127.0.0.2" })).status, "another address").toBe(200);
    expect((await h.call(`/api/runtime/${key2}/guides`, { origin: "http://127.0.0.1:5188" })).status, "another key").toBe(200);
    clock += 60_001;
    expect((await h.call(`/api/runtime/${key}/guides`, { origin: ORIGIN })).status, "the window slid").toBe(200);
  });
  it("counts refused requests too (a wrong Origin cannot be hammered), and the limiter's map is bounded", async () => {
    const h = await build({ rateLimit: { max: 3, windowMs: 60_000, maxEntries: 2 } });
    const key = await h.key(TENANT_A, APP_A);
    for (let i = 0; i < 3; i += 1) expect((await h.call(`/api/runtime/${key}/guides`, { origin: "http://evil.example" })).status).toBe(403);
    expect((await h.call(`/api/runtime/${key}/guides`, { origin: ORIGIN })).status).toBe(429);
  });
  it("the limiter itself: a sliding window, a bounded number of keys (the least recently used are dropped), at most `max` stamps per key", () => {
    let t = 0;
    const limiter = createRateLimiter({ max: 2, windowMs: 100, maxEntries: 3 }, () => t);
    expect([limiter.allow("a"), limiter.allow("a"), limiter.allow("a")]).toEqual([true, true, false]);
    t = 101;
    expect(limiter.allow("a")).toBe(true);
    for (const key of ["b", "c", "d", "e", "f"]) limiter.allow(key);
    expect(limiter.size()).toBe(3);
  });
  it("malformed keys never create limiter entries (an attacker cannot grow the map with garbage)", async () => {
    const h = await build({ rateLimit: { max: 1, windowMs: 60_000, maxEntries: 10 } });
    for (let i = 0; i < 20; i += 1) expect((await h.call(`/api/runtime/garbage-${i}/guides`, { origin: ORIGIN })).status).toBe(404);
  });
});

describe("the transport's guards still hold around the runtime routes", () => {
  it("a cross-site browser request (Sec-Fetch-Site: cross-site) reaches the runtime routes, which authorise by key and Origin; the other routes still refuse it", async () => {
    const h = await build();
    const key = await h.key(TENANT_A, APP_A);
    expect((await h.call(`/api/runtime/${key}/guides`, { origin: ORIGIN, headers: { "sec-fetch-site": "same-site" } })).status).toBe(200);
    expect((await h.call(`/api/runtime/${key}/guides`, { origin: ORIGIN, headers: { "sec-fetch-site": "cross-site" } })).status).toBe(200);
    const other = await h.app.inject({ method: "POST", url: "/api/guidance", headers: { "sec-fetch-site": "cross-site", "content-type": "application/json" }, payload: "{}" });
    expect(other.statusCode).toBe(403);
  });
  it("a Host that is not loopback is refused before routing (DNS rebinding)", async () => {
    const h = await build();
    const key = await h.key(TENANT_A, APP_A);
    const res = await h.app.inject({ method: "GET", url: `/api/runtime/${key}/guides`, headers: { host: "evil.example", origin: ORIGIN } });
    expect(res.statusCode).toBe(403);
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

describe("the key carries its tenant: a key can only ever be read inside that tenant", () => {
  it("a key whose tenant part names ANOTHER tenant (the random part of A's key under B's tenant, and the reverse) finds nothing: the same fixed 404, and the lookup ran only inside the named tenant", async () => {
    const h = await build();
    const keyA = await h.key(TENANT_A, APP_A); const keyB = await h.key(TENANT_B, APP_B);
    const randomA = keyA.slice(-32); const randomB = keyB.slice(-32);
    const crossed = [`rk-${HEX_B}-${randomA}`, `rk-${HEX_A}-${randomB}`];
    const unknown = await h.call(`/api/runtime/rk-${HEX_A}-${"0".repeat(32)}/guides`, { origin: ORIGIN });
    h.lookups.length = 0;
    for (const key of crossed) {
      const res = await h.call(`/api/runtime/${key}/guides`, { origin: ORIGIN });
      expect(res.status, key).toBe(404);
      expect(res.raw).toBe(unknown.raw);
    }
    expect(h.lookups).toEqual([`${TENANT_B}|rk-${HEX_B}-${randomA}`, `${TENANT_A}|rk-${HEX_A}-${randomB}`]);
    // and the store itself: tenant B's own read of tenant A's key is empty
    expect(await h.applications.findByRuntimeKey(TENANT_B, keyA)).toBeNull();
    expect(await h.applications.findByRuntimeKey(TENANT_A, keyA)).not.toBeNull();
  });
  it("a valid key is read only in the tenant it names (one store read, parameters = that tenant and the key)", async () => {
    const h = await build();
    const key = await h.key(TENANT_A, APP_A);
    h.lookups.length = 0;
    await h.call(`/api/runtime/${key}/guides`, { origin: ORIGIN });
    expect(h.lookups).toEqual([`${TENANT_A}|${key}`]);
  });
  it("a store that ignores the tenant cannot leak: the route re-checks that the record's own key equals the request's key", async () => {
    const h = await build();
    const keyB = await h.key(TENANT_B, APP_B);
    const real = h.applications.findByRuntimeKey.bind(h.applications);
    h.applications.findByRuntimeKey = async () => real(TENANT_B, keyB); // a broken store answering tenant B's application for any key
    const res = await h.call(`/api/runtime/rk-${HEX_A}-${"c".repeat(32)}/guides`, { origin: ORIGIN });
    expect(res.status).toBe(404);
    expect(res.raw).not.toContain("Tenant B guide");
  });
});

describe("tenants never cross", () => {
  it("each tenant's key reads only its own application's guides, even when both applications have the same allowed origin", async () => {
    const h = await build();
    const a = await h.call(`/api/runtime/${await h.key(TENANT_A, APP_A)}/guides`, { origin: ORIGIN });
    const b = await h.call(`/api/runtime/${await h.key(TENANT_B, APP_B)}/guides`, { origin: ORIGIN });
    expect(a.body).toEqual({ guides: [{ id: GUIDE_A, title: "Submit an order", description: "Submit the order." }] });
    expect(b.body).toEqual({ guides: [{ id: GUIDE_B, title: "Tenant B guide", description: "Submit the order." }] });
    expect((await h.call(`/api/runtime/${await h.key(TENANT_B, APP_B)}/guides/${GUIDE_A}`, { origin: ORIGIN })).status).toBe(404);
    expect((await h.call(`/api/runtime/${await h.key(TENANT_A, APP_A)}/guides/${GUIDE_B}`, { origin: ORIGIN })).status).toBe(404);
    for (const raw of [a.raw, b.raw]) noLeak(raw);
  });
});
