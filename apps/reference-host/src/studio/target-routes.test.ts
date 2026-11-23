/**
 * Studio V1B routes for managed targets through Fastify `inject`, with focused fakes (in-memory application and target stores, a fake Gateway that applies the executors' rules). They test the ROUTES:
 * guards, closed shapes, exact bodies, status codes and that nothing the caller typed is echoed. The PostgreSQL proof is tests/integration/studio-registry.test.ts.
 */
import { describe, expect, it, vi } from "vitest";
import { AUTHORING_MESSAGES, type AuthoringPrincipal } from "../authoring/routes.js";
import { MAINTAIN_PERMISSION } from "../authoring/capabilities.js";
import { createGuidanceTransport } from "../http/transport.js";
import { createProposalStore } from "../http/proposal-store.js";
import { demoCatalogView } from "../guidance/walkthrough-summaries.js";
import { registerApplicationRoutes } from "./application-routes.js";
import { FakeApplicationStore } from "./fake-application-store.js";
import { FakeTargetStore } from "./fake-target-store.js";
import { createRegistryCatalog } from "./registries.js";
import { TARGET_STATUS_ACTION_ID } from "./target-capabilities.js";

const TENANT_A = "1111aaaa-2222-4333-8444-5555bbbb5555";
const TENANT_B = "2222bbbb-3333-4444-8555-6666cccc6666";
const SECRET = "SECRET-SQL-select-from-studio_registry_targets";
const MANAGED = "app-0000000000a1";
const BUILT_IN = "app-0000000000b1";
const OTHER = "app-0000000000c1";
const managedConfig = { name: "Managed", origin: "http://127.0.0.1:5187", allowedOrigins: ["http://127.0.0.1:5187"], environment: "test" as const, registryId: "studio-managed" };
const builtInConfig = { ...managedConfig, name: "Reference", registryId: "reference" };
const registration = (over: object = {}) => ({ targetId: "orders.submit", route: "orders", page: "/#/orders", role: "button" as const, label: "Submit", description: "Submits", operations: ["highlight", "click"] as const, privacy: "public" as const, ...over });

type Who = "maintainer" | "user" | "maintainerB" | "none" | "throws";
async function build(over: { feedback?: () => unknown } = {}) {
  const applications = new FakeApplicationStore();
  const targets = new FakeTargetStore(applications);
  const seed = { tenantId: TENANT_A, actor: "seed" };
  await applications.save(seed, MANAGED, managedConfig);
  await applications.save(seed, BUILT_IN, builtInConfig);
  await applications.save({ tenantId: TENANT_B, actor: "seed" }, OTHER, managedConfig);
  await targets.register(seed, MANAGED, registration());
  await targets.register({ tenantId: TENANT_B, actor: "seed" }, OTHER, registration({ label: "Tenant B's own" }));
  const submitted: { action: string; params: Record<string, unknown> }[] = [];
  const principals = new Map<Who, AuthoringPrincipal>();
  for (const [who, tenant, permissions] of [["maintainer", TENANT_A, [MAINTAIN_PERMISSION]], ["user", TENANT_A, []], ["maintainerB", TENANT_B, [MAINTAIN_PERMISSION]]] as [Who, string, string[]][]) {
    principals.set(who, {
      key: `fake-${who}`, tenantId: tenant, actor: who, permissions: new Set(permissions),
      submit: async (call) => {
        const { action, params } = JSON.parse(call.arguments) as { action: string; params: Record<string, unknown> };
        submitted.push({ action, params });
        if (over.feedback !== undefined) return over.feedback() as never;
        if (!permissions.includes(MAINTAIN_PERMISSION)) return { outcome: "UNAUTHORIZED", category: "not_available" };
        if (action === TARGET_STATUS_ACTION_ID) {
          const outcome = await targets.setStatus({ tenantId: tenant, actor: who }, params.applicationId as string, params.targetId as string, params.status as "active" | "disabled");
          return { outcome: "ALLOWED", category: outcome === "changed" || outcome === "unchanged" ? "ok" : "try_later" };
        }
        return { outcome: "INVALID_ACTION", category: "not_available" };
      },
    });
  }
  const app = createGuidanceTransport({ ask: async () => ({ kind: "clarify", message: "x" }), catalog: demoCatalogView, resolveSession: async () => null, proposals: createProposalStore({ now: Date.now, newId: () => "proposal-id-0000000000000000" }) });
  registerApplicationRoutes(app, {
    applications, catalog: createRegistryCatalog(), targets,
    resolvePrincipal: async (headers) => { const who = String(headers["x-test-principal"] ?? "none") as Who; if (who === "throws") throw new Error(SECRET); return principals.get(who) ?? null; },
  });
  const call = async (method: "GET" | "POST" | "PUT" | "DELETE" | "PATCH", url: string, options: { who?: Who; body?: unknown } = {}) => {
    const res = await app.inject({ method, url, headers: { ...(options.body !== undefined ? { "content-type": "application/json" } : {}), "x-test-principal": options.who ?? "none" }, ...(options.body !== undefined ? { payload: JSON.stringify(options.body) } : {}) });
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(res.body) as Record<string, unknown>; } catch { /* not JSON */ }
    return { status: res.statusCode, body, raw: res.body };
  };
  return { app, applications, targets, submitted, call };
}
const listUrl = (id: string) => `/api/admin/applications/${id}/targets`;
const statusUrl = (id: string, target = "orders.submit") => `/api/admin/applications/${id}/targets/${target}/status`;
const noLeak = (raw: string) => { for (const word of [SECRET, "SECRET", "perm.", "setStudioTargetStatus", "ex.studio", "Error", "stack", "UNAUTHORIZED", "ALLOWED", "studio_registry"]) expect(raw, word).not.toContain(word); };

describe("GET targets", () => {
  it("lists the application's targets with references, routes and limits, in the closed shape", async () => {
    const t = await build();
    t.targets.references.set(`${TENANT_A}/${MANAGED}/orders.submit`, { drafts: 2, published: 1 });
    const res = await t.call("GET", listUrl(MANAGED), { who: "maintainer" });
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(["limits", "routes", "targets"]);
    expect(res.body.limits).toEqual({ maxTargets: 200, maxRoutes: 20 });
    expect(res.body.routes).toEqual([{ route: "orders", page: "/#/orders" }]);
    const [target] = res.body.targets as Record<string, unknown>[];
    expect(Object.keys(target!).sort()).toEqual(["description", "id", "label", "operations", "page", "privacy", "references", "role", "route", "status", "updatedAt"]);
    expect(target).toMatchObject({ id: "orders.submit", status: "active", privacy: "public", references: { drafts: 2, published: 1 } });
    noLeak(res.raw);
  });
  it("401 without a session (also when the principal lookup throws), 403 for a user, with the fixed bodies and no store access", async () => {
    const t = await build();
    for (const who of ["none", "throws"] as const) expect([who, (await t.call("GET", listUrl(MANAGED), { who })).body]).toEqual([who, { kind: "unauthenticated", message: AUTHORING_MESSAGES.noSession }]);
    const user = await t.call("GET", listUrl(MANAGED), { who: "user" });
    expect([user.status, user.body]).toEqual([403, { kind: "forbidden", message: AUTHORING_MESSAGES.forbidden }]);
    noLeak(user.raw);
  });
  it("404 APPLICATION_NOT_FOUND for an unknown, malformed or another tenant's application (identical, no data); 409 REGISTRY_NOT_MANAGED for a built-in application", async () => {
    const t = await build();
    const notFound = { kind: "not_found", message: "That application was not found.", code: "APPLICATION_NOT_FOUND" };
    for (const [who, id] of [["maintainer", "app-ffffffffffff"], ["maintainer", "not-an-app"], ["maintainer", OTHER], ["maintainerB", MANAGED]] as const) {
      const res = await t.call("GET", listUrl(id), { who });
      expect([who, id, res.status, res.body]).toEqual([who, id, 404, notFound]);
      expect(res.raw).not.toContain("Tenant B's own");
    }
    const builtIn = await t.call("GET", listUrl(BUILT_IN), { who: "maintainer" });
    expect([builtIn.status, builtIn.body]).toEqual([409, { kind: "conflict", message: "That application does not use a Studio-managed registry.", code: "REGISTRY_NOT_MANAGED" }]);
  });
  it("a store that throws (SQL text in the error) is a fixed 503", async () => {
    const t = await build();
    t.targets.failWith = new Error(SECRET);
    const res = await t.call("GET", listUrl(MANAGED), { who: "maintainer" });
    expect([res.status, res.body]).toEqual([503, { kind: "unavailable", message: AUTHORING_MESSAGES.unavailable }]);
    noLeak(res.raw);
  });
  it("there is no write on the collection: POST, PUT, DELETE and PATCH on the list are not routes", async () => {
    const t = await build();
    for (const method of ["POST", "PUT", "DELETE", "PATCH"] as const) expect((await t.call(method, listUrl(MANAGED), { who: "maintainer", body: registration() })).status, method).toBeGreaterThanOrEqual(400);
    expect((await t.targets.list(TENANT_A, MANAGED)).targets).toHaveLength(1);
  });
});

describe("POST targets/:targetId/status", () => {
  it("disables and re-enables through the Gateway with server-built params, and replies with the closed TargetView read back", async () => {
    const t = await build();
    const off = await t.call("POST", statusUrl(MANAGED), { who: "maintainer", body: { status: "disabled" } });
    expect(off.status).toBe(200);
    expect(off.body).toMatchObject({ id: "orders.submit", status: "disabled" });
    expect(t.submitted.at(-1)).toEqual({ action: "setStudioTargetStatus", params: { applicationId: MANAGED, targetId: "orders.submit", status: "disabled" } });
    expect((await t.call("POST", statusUrl(MANAGED), { who: "maintainer", body: { status: "active" } })).body).toMatchObject({ status: "active" });
    noLeak(off.raw);
  });
  it.each([[{}], [{ status: "deleted" }], [{ status: "ACTIVE" }], [{ status: 1 }], [{ status: "active", extra: 1 }], [{ status: "active", applicationId: OTHER }], [{ enabled: true }], [[]], [null]])("the body %j is 400 and nothing is submitted", async (body) => {
    const t = await build();
    const res = await t.call("POST", statusUrl(MANAGED), { who: "maintainer", body });
    expect([res.status, res.body]).toEqual([400, { kind: "malformed", message: AUTHORING_MESSAGES.malformed }]);
    expect(t.submitted).toEqual([]);
  });
  it("401 / 403 with fixed bodies and no Gateway call", async () => {
    const t = await build();
    expect((await t.call("POST", statusUrl(MANAGED), { who: "none", body: { status: "disabled" } })).status).toBe(401);
    expect((await t.call("POST", statusUrl(MANAGED), { who: "user", body: { status: "disabled" } })).status).toBe(403);
    expect(t.submitted).toEqual([]);
    expect((await t.targets.get(TENANT_A, MANAGED, "orders.submit"))?.status).toBe("active");
  });
  it("404 TARGET_NOT_FOUND for an unknown, malformed or reserved target id, with a fixed body that does not echo the id; no Gateway call", async () => {
    const t = await build();
    for (const target of ["orders.missing", "submit", "dap.x", "Orders.Submit", "a..b"]) {
      const res = await t.call("POST", statusUrl(MANAGED, target), { who: "maintainer", body: { status: "disabled" } });
      expect([target, res.status, res.body]).toEqual([target, 404, { kind: "not_found", message: "That target was not found.", code: "TARGET_NOT_FOUND" }]);
      expect(res.raw).not.toContain(target);
    }
    expect(t.submitted).toEqual([]);
  });
  it("another tenant's application or target, an unknown application and a built-in application are refused without touching anything", async () => {
    const t = await build();
    expect((await t.call("POST", statusUrl(MANAGED), { who: "maintainerB", body: { status: "disabled" } })).body).toMatchObject({ code: "APPLICATION_NOT_FOUND" });
    expect((await t.call("POST", statusUrl(OTHER), { who: "maintainer", body: { status: "disabled" } })).body).toMatchObject({ code: "APPLICATION_NOT_FOUND" });
    expect((await t.call("POST", statusUrl("app-ffffffffffff"), { who: "maintainer", body: { status: "disabled" } })).body).toMatchObject({ code: "APPLICATION_NOT_FOUND" });
    expect((await t.call("POST", statusUrl(BUILT_IN), { who: "maintainer", body: { status: "disabled" } })).body).toMatchObject({ kind: "conflict", code: "REGISTRY_NOT_MANAGED" });
    expect(t.submitted).toEqual([]);
    expect((await t.targets.get(TENANT_B, OTHER, "orders.submit"))?.status).toBe("active");
  });
  it("a DISABLED application: enabling a target is 409 APPLICATION_DISABLED (nothing submitted), disabling is still allowed", async () => {
    const t = await build();
    await t.targets.setStatus({ tenantId: TENANT_A, actor: "m" }, MANAGED, "orders.submit", "disabled");
    await t.applications.setEnabled({ tenantId: TENANT_A, actor: "seed" }, MANAGED, false);
    t.submitted.length = 0;
    const enable = await t.call("POST", statusUrl(MANAGED), { who: "maintainer", body: { status: "active" } });
    expect([enable.status, enable.body]).toEqual([409, { kind: "conflict", message: "That application is disabled. Enable it first.", code: "APPLICATION_DISABLED" }]);
    expect(t.submitted).toEqual([]);
    await t.applications.setEnabled({ tenantId: TENANT_A, actor: "seed" }, MANAGED, true);
    await t.call("POST", statusUrl(MANAGED), { who: "maintainer", body: { status: "active" } });
    await t.applications.setEnabled({ tenantId: TENANT_A, actor: "seed" }, MANAGED, false);
    const disable = await t.call("POST", statusUrl(MANAGED), { who: "maintainer", body: { status: "disabled" } });
    expect([disable.status, disable.body]).toMatchObject([200, { status: "disabled" }]);
  });
  it.each([["UNAUTHORIZED"], ["DENIED"], ["INVALID_PARAMETERS"]])("a Gateway answer of %s is a fixed 403; the target is untouched", async (outcome) => {
    const t = await build({ feedback: () => ({ outcome, category: "not_available", issues: [{ path: "/targetId", code: "format" }] }) });
    const res = await t.call("POST", statusUrl(MANAGED), { who: "maintainer", body: { status: "disabled" } });
    expect([res.status, res.body]).toEqual([403, { kind: "forbidden", message: AUTHORING_MESSAGES.refused }]);
    noLeak(res.raw);
    expect((await t.targets.get(TENANT_A, MANAGED, "orders.submit"))?.status).toBe("active");
  });
  it("an ALLOWED answer that is not ok, a Gateway that throws and a failing store are a fixed 503", async () => {
    for (const feedback of [() => ({ outcome: "ALLOWED", category: "try_later" }), () => { throw new Error(SECRET); }, () => null]) {
      const t = await build({ feedback });
      const res = await t.call("POST", statusUrl(MANAGED), { who: "maintainer", body: { status: "disabled" } });
      expect([res.status, res.body]).toEqual([503, { kind: "unavailable", message: AUTHORING_MESSAGES.unavailable }]);
      noLeak(res.raw);
    }
    const t = await build();
    vi.spyOn(t.targets, "get").mockRejectedValue(new Error(SECRET));
    const res = await t.call("POST", statusUrl(MANAGED), { who: "maintainer", body: { status: "disabled" } });
    expect(res.status).toBe(503);
    noLeak(res.raw);
  });
  it("no caller text is echoed: a hostile target id in the path and hostile body values never appear in any reply", async () => {
    const t = await build();
    const MARK = "TYPED-MARKER-7391";
    for (const [url, body] of [[statusUrl(MANAGED, `${MARK}.x`), { status: "disabled" }], [statusUrl(MANAGED), { status: MARK }], [statusUrl(MANAGED), { [MARK]: 1 }]] as const) {
      expect((await t.call("POST", url, { who: "maintainer", body })).raw).not.toContain(MARK);
    }
  });
});
