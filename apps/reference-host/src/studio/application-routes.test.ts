/**
 * Studio V1A maintainer routes through Fastify `inject`, with a clearly labelled FOCUSED FAKE: an in-memory store and a fake Gateway `submit` that applies the rules the trusted
 * executors apply (permission, validation, the cap of 20). They test the ROUTES (guards, authorization, strict bodies, status codes, closed replies, no echo). The proof that the
 * real Gateway, the real executors and PostgreSQL behave is tests/integration/studio-applications.test.ts.
 */
import { describe, expect, it } from "vitest";
import { AUTHORING_MESSAGES, type AuthoringPrincipal } from "../authoring/routes.js";
import { MAINTAIN_PERMISSION } from "../authoring/capabilities.js";
import { createGuidanceTransport } from "../http/transport.js";
import { createProposalStore } from "../http/proposal-store.js";
import { demoCatalogView } from "../guidance/walkthrough-summaries.js";
import { APPLICATION_MESSAGES, registerApplicationRoutes } from "./application-routes.js";
import { ENABLE_APPLICATION_ACTION_ID, SAVE_APPLICATION_ACTION_ID } from "./application-capabilities.js";
import { FakeApplicationStore } from "./fake-application-store.js";
import { FIXTURE_ENTRY } from "./fixture-registry.js";
import { MAX_APPLICATIONS_PER_TENANT, validateApplicationConfig } from "./applications.js";
import { createRegistryCatalog } from "./registries.js";

const TENANT_A = "1111aaaa-2222-4333-8444-5555bbbb5555";
const TENANT_B = "2222bbbb-3333-4444-8555-6666cccc6666";
const SECRET = "SECRET-SQL-select-from-studio_applications";
/** The seven-field body PUT must carry (POST may omit the last two). */
const full = (over: Record<string, unknown> = {}) => ({ ...config(), routing: "hash", runtimeAccess: false, ...over });
const config = (over: Record<string, unknown> = {}) => ({ name: "Reference application", origin: "http://localhost:5184", allowedOrigins: ["http://localhost:5184"], environment: "development", registryId: "reference", ...over });
const VIEW_KEYS = ["allowedOrigins", "counts", "enabled", "environment", "id", "name", "origin", "registryId", "routing", "runtimeAccess", "runtimeKey", "source", "updatedAt"];

type Who = "maintainer" | "user" | "maintainerB" | "none" | "throws";
interface Submitted { who: Who; action: string; params: Record<string, unknown> }

function build(over: { feedback?: (action: string) => unknown; newIds?: string[]; extra?: boolean } = {}) {
  const store = new FakeApplicationStore();
  const catalog = createRegistryCatalog(over.extra === true ? [FIXTURE_ENTRY] : []);
  const submitted: Submitted[] = [];
  const principals = new Map<Who, AuthoringPrincipal>();
  const table: [Who, string, string[]][] = [["maintainer", TENANT_A, [MAINTAIN_PERMISSION]], ["user", TENANT_A, []], ["maintainerB", TENANT_B, [MAINTAIN_PERMISSION]]];
  for (const [who, tenant, permissions] of table) {
    principals.set(who, {
      key: `fake-${who}`, tenantId: tenant, actor: who, permissions: new Set(permissions),
      // The FAKE Gateway: refuses without the permission, otherwise applies the executors' rules to the fake store.
      submit: async (call) => {
        const { action, params } = JSON.parse(call.arguments) as { action: string; params: Record<string, unknown> };
        submitted.push({ who, action, params });
        if (over.feedback !== undefined) return over.feedback(action) as never;
        if (!permissions.includes(MAINTAIN_PERMISSION)) return { outcome: "UNAUTHORIZED", category: "not_available" };
        const scope = { tenantId: tenant, actor: who };
        if (action === SAVE_APPLICATION_ACTION_ID) {
          const { applicationId, ...candidate } = params;
          const checked = validateApplicationConfig(candidate, catalog.ids());
          if (!checked.ok) return { outcome: "ALLOWED", category: "try_later" };
          const outcome = await store.save(scope, applicationId as string, checked.config);
          return { outcome: "ALLOWED", category: outcome === "created" || outcome === "updated" ? "ok" : "try_later" };
        }
        if (action === ENABLE_APPLICATION_ACTION_ID) {
          const outcome = await store.setEnabled(scope, params.applicationId as string, params.enabled as boolean);
          return { outcome: "ALLOWED", category: outcome === "changed" || outcome === "unchanged" ? "ok" : "try_later" };
        }
        return { outcome: "INVALID_ACTION", category: "not_available" };
      },
    });
  }
  const app = createGuidanceTransport({ ask: async () => ({ kind: "clarify", message: "x" }), catalog: demoCatalogView, resolveSession: async () => null, proposals: createProposalStore({ now: Date.now, newId: () => "proposal-id-0000000000000000" }) });
  const ids = [...(over.newIds ?? [])];
  registerApplicationRoutes(app, {
    applications: store, catalog,
    resolvePrincipal: async (headers) => {
      const who = String(headers["x-test-principal"] ?? "none") as Who;
      if (who === "throws") throw new Error(SECRET);
      return principals.get(who) ?? null;
    },
    ...(ids.length > 0 ? { newId: () => ids.shift()! } : {}),
  });
  const call = async (method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH", url: string, options: { who?: Who; body?: unknown; headers?: Record<string, string>; raw?: string } = {}) => {
    const res = await app.inject({
      method, url,
      headers: { ...(options.raw !== undefined || options.body !== undefined ? { "content-type": "application/json" } : {}), "x-test-principal": options.who ?? "none", ...options.headers },
      ...(options.raw !== undefined ? { payload: options.raw } : options.body !== undefined ? { payload: JSON.stringify(options.body) } : {}),
    });
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(res.body) as Record<string, unknown>; } catch { /* not JSON */ }
    return { status: res.statusCode, body, raw: res.body };
  };
  return { app, store, catalog, submitted, call };
}

const A1 = "app-0000000000a1";
const A2 = "app-0000000000a2";
function expectNoLeak(raw: string) {
  for (const word of [SECRET, "SECRET", "perm.", "walkthrough.maintain", "saveStudioApplication", "setStudioApplicationEnabled", "ex.studio", "Error", "stack", "    at ", "Zod", "zod", "invalid_type", "UNAUTHORIZED", "ALLOWED", "INVALID_ACTION", "studio_applications"]) expect(raw, word).not.toContain(word);
}

describe("the guards", () => {
  const routes: ["GET" | "POST" | "PUT", string, unknown?][] = [
    ["GET", "/api/admin/applications"], ["GET", `/api/admin/applications/${A1}`], ["GET", `/api/admin/applications/${A1}/registry`],
    ["POST", "/api/admin/applications", config()], ["PUT", `/api/admin/applications/${A1}`, config()], ["POST", `/api/admin/applications/${A1}/status`, { enabled: false }],
  ];
  it("no session is 401 and an ordinary user is 403 on every route, with fixed bodies, no Gateway call and no store access", async () => {
    const t = build();
    for (const [method, url, body] of routes) {
      const none = await t.call(method, url, { who: "none", ...(body === undefined ? {} : { body }) });
      expect([method, url, none.status, none.body]).toEqual([method, url, 401, { kind: "unauthenticated", message: AUTHORING_MESSAGES.noSession }]);
      const user = await t.call(method, url, { who: "user", ...(body === undefined ? {} : { body }) });
      expect([method, url, user.status, user.body]).toEqual([method, url, 403, { kind: "forbidden", message: AUTHORING_MESSAGES.forbidden }]);
      const broken = await t.call(method, url, { who: "throws", ...(body === undefined ? {} : { body }) });
      expect(broken.status).toBe(401);
      expectNoLeak(none.raw + user.raw + broken.raw);
    }
    expect(t.submitted).toEqual([]);
    expect(t.store.rows).toEqual([]);
  });
  it("inherits the transport guards: a non-loopback Host and a cross-site request are refused before routing", async () => {
    const t = build();
    expect((await t.call("GET", "/api/admin/applications", { who: "maintainer", headers: { host: "evil.example" } })).status).toBe(403);
    expect((await t.call("POST", "/api/admin/applications", { who: "maintainer", body: config(), headers: { "sec-fetch-site": "cross-site" } })).status).toBe(403);
    expect((await t.call("POST", "/api/admin/applications", { who: "maintainer", raw: JSON.stringify(config()), headers: { "content-type": "text/plain" } })).status).toBe(415);
    expect(t.submitted).toEqual([]);
  });
});

describe("create", () => {
  it("validates, generates the id on the host, goes through the Gateway once with exactly the normalised configuration, reads it back and replies 201 with the closed view", async () => {
    const t = build({ newIds: [A1] });
    const res = await t.call("POST", "/api/admin/applications", { who: "maintainer", body: config({ origin: "HTTP://LocalHost:5184/", allowedOrigins: ["HTTP://LocalHost:5184/"] }) });
    expect(res.status).toBe(201);
    expect(Object.keys(res.body).sort()).toEqual(VIEW_KEYS);
    expect(res.body).toMatchObject({ id: A1, name: "Reference application", origin: "http://localhost:5184", allowedOrigins: ["http://localhost:5184"], environment: "development", registryId: "reference", enabled: true });
    expect(t.submitted).toHaveLength(1);
    expect(t.submitted[0]).toMatchObject({ who: "maintainer", action: "saveStudioApplication", params: { applicationId: A1, origin: "http://localhost:5184" } });
    expect(Object.keys(t.submitted[0]!.params).sort()).toEqual(["allowedOrigins", "applicationId", "environment", "name", "origin", "registryId", "routing", "runtimeAccess"]);
    expect(t.store.rows[0]).toMatchObject({ tenantId: TENANT_A });
    expectNoLeak(res.raw);
  });
  it.each([
    ["tenantId"], ["permissions"], ["id"], ["enabled"], ["applicationId"], ["status"], ["__proto__x"],
  ])("a body with the extra key %s is 400 and nothing is submitted", async (key) => {
    const t = build();
    const res = await t.call("POST", "/api/admin/applications", { who: "maintainer", body: { ...config(), [key]: "x" } });
    expect(res).toMatchObject({ status: 400, body: { kind: "malformed", message: AUTHORING_MESSAGES.malformed } });
    expect(t.submitted).toEqual([]);
  });
  it.each([[{}], [{ name: "x" }], [{ ...config(), allowedOrigins: undefined }], [[]], [null], ["x"]])("the malformed body %j is 400", async (body) => {
    const t = build();
    const res = await t.call("POST", "/api/admin/applications", { who: "maintainer", body });
    expect(res.status).toBe(400);
    expect(t.submitted).toEqual([]);
  });
  it("prototype-poisoning keys and broken JSON are refused with fixed messages", async () => {
    const t = build();
    for (const raw of ["{", '{"__proto__":{"x":1},"name":"n"}', '{"constructor":{"prototype":{}}}']) {
      const res = await t.call("POST", "/api/admin/applications", { who: "maintainer", raw });
      expect(res.status, raw).toBe(400);
      expectNoLeak(res.raw);
    }
    expect(t.submitted).toEqual([]);
  });
  it("an invalid enrollment is 422 { kind: 'invalid', issues } with fixed phrases that never echo what was typed, and the Gateway is never asked", async () => {
    const t = build();
    const MARKER = "TYPED-MARKER-7731";
    const res = await t.call("POST", "/api/admin/applications", { who: "maintainer", body: config({ name: `${MARKER}<`, origin: `javascript:${MARKER}`, allowedOrigins: [`ftp://${MARKER}`, `https://u:${MARKER}@x.example`], environment: MARKER, registryId: MARKER }) });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ kind: "invalid", message: APPLICATION_MESSAGES.invalid });
    expect(Object.keys(res.body).sort()).toEqual(["issues", "kind", "message"]);
    expect((res.body.issues as string[]).length).toBeGreaterThan(3);
    expect(res.raw).not.toContain(MARKER);
    expectNoLeak(res.raw);
    expect(t.submitted).toEqual([]);
  });
  it("refuses an unknown registry, a production environment and an origin outside the allowed list with 422", async () => {
    const t = build();
    for (const bad of [{ registryId: "fixture" }, { environment: "production" }, { allowedOrigins: ["http://localhost:5185"] }, { origin: "http://example.com", allowedOrigins: ["http://example.com"] }, { origin: "http://10.0.0.1", allowedOrigins: ["http://10.0.0.1"] }]) {
      expect((await t.call("POST", "/api/admin/applications", { who: "maintainer", body: config(bad) })).status, JSON.stringify(bad)).toBe(422);
    }
    expect(t.submitted).toEqual([]);
  });
  it("accepts the second registry once it is in the catalog", async () => {
    const t = build({ newIds: [A1], extra: true });
    const res = await t.call("POST", "/api/admin/applications", { who: "maintainer", body: config({ registryId: "fixture", origin: "http://127.0.0.1:5185", allowedOrigins: ["http://127.0.0.1:5185"], environment: "test" }) });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ registryId: "fixture", environment: "test" });
  });
  it(`the ${MAX_APPLICATIONS_PER_TENANT + 1}st application of a tenant is a 409 limit before the Gateway; another tenant is unaffected`, async () => {
    const ids = Array.from({ length: MAX_APPLICATIONS_PER_TENANT + 2 }, (_v, i) => `app-${String(i).padStart(12, "0")}`);
    const t = build({ newIds: ids });
    for (let i = 0; i < MAX_APPLICATIONS_PER_TENANT; i += 1) expect((await t.call("POST", "/api/admin/applications", { who: "maintainer", body: config({ name: `App ${i}` }) })).status).toBe(201);
    t.submitted.length = 0;
    const over = await t.call("POST", "/api/admin/applications", { who: "maintainer", body: config() });
    expect(over).toMatchObject({ status: 409, body: { kind: "conflict", message: APPLICATION_MESSAGES.limit } });
    expect(t.submitted).toEqual([]);
    expect((await t.call("POST", "/api/admin/applications", { who: "maintainerB", body: config() })).status).toBe(201);
  });
  it("a race that reaches the executor and loses (limit_reached there) is still a 409, not a 503", async () => {
    const ids = Array.from({ length: MAX_APPLICATIONS_PER_TENANT + 2 }, (_v, i) => `app-${String(i).padStart(12, "0")}`);
    const t = build({ newIds: ids });
    for (let i = 0; i < MAX_APPLICATIONS_PER_TENANT - 1; i += 1) await t.call("POST", "/api/admin/applications", { who: "maintainer", body: config() });
    const originalList = t.store.list.bind(t.store);
    let first = true;
    t.store.list = async (tenant) => { const rows = await originalList(tenant); if (first) { first = false; return rows; } return [...rows, ...rows.slice(0, 1)]; }; // the pre-check sees room; the post-check sees the cap
    t.store.rows.push({ ...t.store.rows[0]!, id: "app-ffffffffff01" }); // another request took the last slot in between
    const res = await t.call("POST", "/api/admin/applications", { who: "maintainer", body: config() });
    expect(res.status).toBe(409);
  });
  it.each([["UNAUTHORIZED"], ["DENIED"], ["INVALID_PARAMETERS"], ["RATE_LIMITED"]])("a Gateway answer of %s that is not ALLOWED is a fixed 403 with nothing stored", async (outcome) => {
    const t = build({ feedback: () => ({ outcome, category: "not_available", issues: [{ path: "/name", code: "format" }] }) });
    const res = await t.call("POST", "/api/admin/applications", { who: "maintainer", body: config() });
    expect(res).toMatchObject({ status: 403, body: { kind: "forbidden", message: AUTHORING_MESSAGES.refused } });
    expectNoLeak(res.raw);
    expect(t.store.rows).toEqual([]);
  });
  it("an ALLOWED answer that is not ok, or whose read-back finds nothing, is a 503; a Gateway that throws is a 503", async () => {
    for (const feedback of [() => ({ outcome: "ALLOWED", category: "try_later" }), () => ({ outcome: "ALLOWED", category: "ok" }), () => { throw new Error(SECRET); }, () => null]) {
      const t = build({ feedback });
      const res = await t.call("POST", "/api/admin/applications", { who: "maintainer", body: config() });
      expect(res).toMatchObject({ status: 503, body: { kind: "unavailable", message: AUTHORING_MESSAGES.unavailable } });
      expectNoLeak(res.raw);
    }
  });
});

describe("reads", () => {
  it("list returns the tenant's applications and the selectable registries, nothing of another tenant", async () => {
    const t = build({ newIds: [A1, A2], extra: true });
    await t.call("POST", "/api/admin/applications", { who: "maintainer", body: config({ name: "One" }) });
    await t.call("POST", "/api/admin/applications", { who: "maintainerB", body: config({ name: "Two" }) });
    const res = await t.call("GET", "/api/admin/applications", { who: "maintainer" });
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(["applications", "registries"]);
    expect((res.body.applications as { id: string; name: string }[]).map((a) => [a.id, a.name])).toEqual([[A1, "One"]]);
    expect(Object.keys((res.body.applications as object[])[0]!).sort()).toEqual(VIEW_KEYS);
    expect(res.body.registries).toEqual([{ id: "reference", label: "Reference application", source: "built-in" }, { id: "fixture", label: "Second application", source: "built-in" },
      { id: "studio-managed", label: "Studio-managed (register targets from the browser)", source: "studio-managed" }]);
    expect(((await t.call("GET", "/api/admin/applications", { who: "maintainerB" })).body.applications as { name: string }[]).map((a) => a.name)).toEqual(["Two"]);
    expectNoLeak(res.raw);
  });
  it("get returns the view; a malformed id, an unknown id and ANOTHER TENANT's id are all the same 404 with a fixed code and no data", async () => {
    const t = build({ newIds: [A1] });
    await t.call("POST", "/api/admin/applications", { who: "maintainer", body: config() });
    const own = await t.call("GET", `/api/admin/applications/${A1}`, { who: "maintainer" });
    expect(own.status).toBe(200);
    expect(Object.keys(own.body).sort()).toEqual(VIEW_KEYS);
    const notFound = { kind: "not_found", message: APPLICATION_MESSAGES.notFound, code: "APPLICATION_NOT_FOUND" };
    for (const id of [A2, "not-an-app", "wt-0123456789ab", "app-0123456789AB"]) {
      const res = await t.call("GET", `/api/admin/applications/${id}`, { who: "maintainer" });
      expect([id, res.status, res.body]).toEqual([id, 404, notFound]);
    }
    const crossTenant = await t.call("GET", `/api/admin/applications/${A1}`, { who: "maintainerB" });
    expect([crossTenant.status, crossTenant.body]).toEqual([404, notFound]);
    expect(crossTenant.raw).not.toContain("Reference application");
  });
  it("a store that throws (SQL text in the error) is a 503 on every read, with no leak", async () => {
    const t = build({ newIds: [A1] });
    await t.call("POST", "/api/admin/applications", { who: "maintainer", body: config() });
    t.store.failWith = new Error(SECRET);
    for (const url of ["/api/admin/applications", `/api/admin/applications/${A1}`, `/api/admin/applications/${A1}/registry`]) {
      const res = await t.call("GET", url, { who: "maintainer" });
      expect([url, res.status, res.body]).toEqual([url, 503, { kind: "unavailable", message: AUTHORING_MESSAGES.unavailable }]);
      expectNoLeak(res.raw);
    }
  });
  it("registry returns the application's PUBLIC-eligible registry: the private email field never appears, and previewable is true only for the reference registry", async () => {
    const t = build({ newIds: [A1, A2], extra: true });
    await t.call("POST", "/api/admin/applications", { who: "maintainer", body: config() });
    await t.call("POST", "/api/admin/applications", { who: "maintainer", body: config({ registryId: "fixture", origin: "http://127.0.0.1:5185", allowedOrigins: ["http://127.0.0.1:5185"], environment: "test" }) });
    const reference = await t.call("GET", `/api/admin/applications/${A1}/registry`, { who: "maintainer" });
    expect(reference.status).toBe(200);
    expect(Object.keys(reference.body).sort()).toEqual(["elements", "pages", "postconditionNames", "previewMode", "previewable", "routes", "source"]);
    expect(reference.body.previewable).toBe(true);
    expect(reference.body.routes).toEqual(["dashboard", "profile", "settings"]);
    expect((reference.body.elements as { id: string; privacy: string }[]).map((e) => e.id)).not.toContain("profile.emailInput");
    expect((reference.body.elements as { privacy: string }[]).every((e) => e.privacy === "public")).toBe(true);
    expect(reference.raw).not.toContain("emailInput");
    const second = await t.call("GET", `/api/admin/applications/${A2}/registry`, { who: "maintainer" });
    expect(second.body).toMatchObject({ routes: ["home", "orders"], previewable: false, postconditionNames: ["orders.exported"] });
    expect((second.body.elements as { id: string }[]).map((e) => e.id)).toEqual(["orders.exportButton"]);
    expect((await t.call("GET", `/api/admin/applications/${A1}/registry`, { who: "maintainerB" })).status).toBe(404);
    expect((await t.call("GET", "/api/admin/applications/app-ffffffffffff/registry", { who: "maintainer" })).body).toMatchObject({ code: "APPLICATION_NOT_FOUND" });
  });
  it("registry of an application whose registry id is no longer in the catalog is a 503, never an empty pass", async () => {
    const t = build();
    await t.store.save({ tenantId: TENANT_A, actor: "seed" }, A1, { ...config(), registryId: "gone" } as never);
    expect((await t.call("GET", `/api/admin/applications/${A1}/registry`, { who: "maintainer" })).status).toBe(503);
  });
});

describe("update and enable/disable", () => {
  it("PUT updates the configuration of the caller's own application and leaves the enabled flag alone", async () => {
    const t = build({ newIds: [A1] });
    await t.call("POST", "/api/admin/applications", { who: "maintainer", body: config() });
    await t.call("POST", `/api/admin/applications/${A1}/status`, { who: "maintainer", body: { enabled: false } });
    const res = await t.call("PUT", `/api/admin/applications/${A1}`, { who: "maintainer", body: full({ name: "Renamed" }) });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: A1, name: "Renamed", enabled: false });
    expect(t.submitted.at(-1)).toMatchObject({ action: "saveStudioApplication", params: { applicationId: A1, name: "Renamed" } });
  });
  it("PUT of an unknown, malformed or other tenant's application is 404 with no Gateway call; invalid input is 422; extra keys are 400", async () => {
    const t = build({ newIds: [A1] });
    await t.call("POST", "/api/admin/applications", { who: "maintainer", body: config() });
    t.submitted.length = 0;
    for (const [who, id] of [["maintainer", A2], ["maintainer", "nope"], ["maintainerB", A1]] as const) {
      const res = await t.call("PUT", `/api/admin/applications/${id}`, { who, body: full() });
      expect([who, id, res.status, res.body.code]).toEqual([who, id, 404, "APPLICATION_NOT_FOUND"]);
    }
    expect((await t.call("PUT", `/api/admin/applications/${A1}`, { who: "maintainer", body: full({ origin: "ftp://x" }) })).status).toBe(422);
    expect((await t.call("PUT", `/api/admin/applications/${A1}`, { who: "maintainer", body: { ...full(), enabled: true } })).status).toBe(400);
    expect(t.submitted).toEqual([]);
    expect(t.store.rows[0]).toMatchObject({ name: "Reference application" });
  });
  it("status enables and disables with the closed view, needs EXACTLY { enabled: boolean }, and never touches another tenant's application", async () => {
    const t = build({ newIds: [A1] });
    await t.call("POST", "/api/admin/applications", { who: "maintainer", body: config() });
    const off = await t.call("POST", `/api/admin/applications/${A1}/status`, { who: "maintainer", body: { enabled: false } });
    expect(off.status).toBe(200);
    expect(off.body).toMatchObject({ id: A1, enabled: false });
    expect(t.submitted.at(-1)).toEqual({ who: "maintainer", action: "setStudioApplicationEnabled", params: { applicationId: A1, enabled: false } });
    expect((await t.call("POST", `/api/admin/applications/${A1}/status`, { who: "maintainer", body: { enabled: true } })).body).toMatchObject({ enabled: true });
    for (const body of [{}, { enabled: "true" }, { enabled: 1 }, { enabled: false, name: "x" }, { status: "disabled" }, [], null]) {
      expect((await t.call("POST", `/api/admin/applications/${A1}/status`, { who: "maintainer", body })).status, JSON.stringify(body)).toBe(400);
    }
    const before = t.submitted.length;
    expect((await t.call("POST", `/api/admin/applications/${A1}/status`, { who: "maintainerB", body: { enabled: false } })).body).toMatchObject({ code: "APPLICATION_NOT_FOUND" });
    expect((await t.call("POST", "/api/admin/applications/app-ffffffffffff/status", { who: "maintainer", body: { enabled: false } })).status).toBe(404);
    expect(t.submitted).toHaveLength(before);
    expect(t.store.rows[0]?.enabled).toBe(true);
  });
  it("there is no DELETE and no PATCH: an application is only ever disabled", async () => {
    const t = build({ newIds: [A1] });
    await t.call("POST", "/api/admin/applications", { who: "maintainer", body: config() });
    for (const method of ["DELETE", "PATCH"] as const) expect((await t.call(method, `/api/admin/applications/${A1}`, { who: "maintainer" })).status).toBeGreaterThanOrEqual(400);
    expect(t.store.rows).toHaveLength(1);
  });
});
