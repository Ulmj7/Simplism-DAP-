/**
 * T406 (Feature 004): the authoring routes through the REAL Gateway, the REAL PostgreSQL store and Fastify `inject` (no port is opened): create -> read ->
 * publish -> published list -> edit refused (409) -> unpublish -> edit allowed, with a maintainer and an ordinary user, plus the Gateway layer refusing a principal that
 * the route's own check let through, default deny, tenant isolation and the audit trail. The routes sit on the EXISTING C01 transport instance.
 * NEEDS the PostgreSQL of deploy/compose.yaml on a FRESH database; every test uses a tenant of its own.
 */
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { composeReferenceHost } from "../../apps/reference-host/src/index.js";
import type { ReferenceHost } from "../../apps/reference-host/src/index.js";
import { parseDevSessions } from "../../apps/reference-host/src/dev-auth/index.js";
import { createAuthoringExtension } from "../../apps/reference-host/src/authoring/capabilities.js";
import { createPostgresWalkthroughStore } from "../../apps/reference-host/src/authoring/postgres-store.js";
import { createDemoPrincipalResolver } from "../../apps/reference-host/src/authoring/principal.js";
import { AUTHORING_MESSAGES, registerAuthoringRoutes } from "../../apps/reference-host/src/authoring/routes.js";
import type { AuthoringPrincipal } from "../../apps/reference-host/src/authoring/routes.js";
import { createProposalStore } from "../../apps/reference-host/src/http/proposal-store.js";
import { createGuidanceTransport } from "../../apps/reference-host/src/http/transport.js";
import { demoCatalogView } from "../../apps/reference-host/src/guidance/walkthrough-summaries.js";
import { createPostgresApplicationStore } from "../../apps/reference-host/src/studio/postgres-application-store.js";
import { createRegistryCatalog } from "../../apps/reference-host/src/studio/registries.js";
import { createPostgresPool } from "../../packages/security/src/index.js";
import { withTenant } from "../../packages/security/src/state/postgres/tenant-tx.js";
import { openStatePools } from "../../packages/security/src/state/conformance/state-pg-fixtures.js";

let owner: Pool; let probe: Pool;
const closers: (() => Promise<unknown>)[] = [];
const hosts: ReferenceHost[] = [];
beforeAll(async () => { ({ app: probe, owner } = await openStatePools(Pool)); });
afterAll(async () => { await Promise.all([probe?.end(), owner?.end()]); });
afterEach(async () => { await Promise.all([...closers.splice(0).map((close) => close()), ...hosts.splice(0).map((host) => host.close())]); });

const TITLE = "Distinctive-Route-Title-5521";
const defOf = (over: Record<string, unknown> = {}) => ({
  title: TITLE, description: "Change your display name and save it.", start: "n1",
  steps: [{ id: "n1", kind: "navigate", route: "profile", next: "s1" }, { id: "s1", kind: "guide", target: "profile.saveButton", text: "Press Save.", wait: "click", verify: "profile.saved", next: "done" }, { id: "done", kind: "complete", text: "Done." }],
  ...over,
});

async function start(options: { enabled?: string; tenant?: string; mismatched?: boolean } = {}) {
  const tenant = options.tenant ?? randomUUID();
  const suffix = tenant.slice(0, 8);
  const future = new Date(Date.now() + 3_600_000).toISOString();
  const [userToken, maintToken] = [`tok-${randomUUID()}`, `tok-${randomUUID()}`];
  const sessions = [
    { token: userToken, userId: "ula", tenantId: tenant, sessionId: `s-ula-${suffix}-${randomUUID().slice(0, 4)}`, validUntil: future, permissions: ["perm.demo.lookup"] },
    { token: maintToken, userId: "maya", tenantId: tenant, sessionId: `s-maya-${suffix}-${randomUUID().slice(0, 4)}`, validUntil: future, permissions: ["perm.walkthrough.maintain"] },
  ];
  const pool = createPostgresPool(process.env.DAP_DATABASE_URL!, { max: 4 });
  closers.push(() => pool.end());
  const store = createPostgresWalkthroughStore(pool);
  // Studio V1A: every draft belongs to an enrolled application (one per tenant, stable id).
  const applications = createPostgresApplicationStore(pool);
  const catalog = createRegistryCatalog();
  const appId = `app-${tenant.replace(/-/g, "").slice(0, 12)}`;
  await applications.save({ tenantId: tenant, actor: "seed" }, appId, { name: "Reference application", origin: "http://localhost:5184", allowedOrigins: ["http://localhost:5184"], environment: "development", registryId: "reference" });
  const authoring = createAuthoringExtension({ store, applications, catalog });
  const { host } = await composeReferenceHost(
    { NODE_ENV: "test", DAP_ALLOW_DEV_AUTH: "1", DAP_DATABASE_URL: process.env.DAP_DATABASE_URL, DAP_ENABLED_ACTIONS: options.enabled ?? "demoLookup,saveWalkthroughDraft,setWalkthroughStatus", DEV_SESSIONS: JSON.stringify(sessions) },
    { extensions: [authoring.extension] },
  );
  hosts.push(host);
  const table = parseDevSessions(JSON.stringify(sessions));
  const real = createDemoPrincipalResolver({ sessions: table, userToken, maintainerToken: maintToken, openSession: (evidence) => host.openSession(evidence) });
  // For the "Gateway refuses what the route let through" case: a principal that CLAIMS the permission (route gate passes) but whose Gateway session is the user's.
  const lying = async (): Promise<AuthoringPrincipal> => {
    const base = (await real({ "x-demo-role": "user" }))!;
    return { ...base, permissions: new Set(["perm.walkthrough.maintain"]) };
  };
  const app = createGuidanceTransport({ ask: async () => ({ kind: "clarify", message: "x" }), catalog: demoCatalogView, resolveSession: async () => null, proposals: createProposalStore({ now: Date.now, newId: () => "proposal-id-0000000000000000" }) });
  registerAuthoringRoutes(app, { store, applications, catalog, resolvePrincipal: async (headers) => (options.mismatched ? lying() : real(headers)) });
  closers.push(() => app.close());
  const call = async (method: "GET" | "POST" | "PUT", url: string, role: "user" | "maintainer", body?: unknown) => {
    const res = await app.inject({ method, url, headers: { "x-demo-role": role, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { payload: JSON.stringify(body) }) });
    return { status: res.statusCode, body: JSON.parse(res.body) as Record<string, unknown>, raw: res.body };
  };
  const rows = async () => (await withTenant(owner, tenant, (client) => client.query("SELECT event_type, action_id, outcome, risk, params_view, execution_result, user_id FROM public.sec_audit_events ORDER BY seq"))).rows as Record<string, unknown>[];
  return { tenant, call, rows, store, appId, applications, trusted: authoring.trusted };
}

describe("the full authoring flow over the real Gateway and PostgreSQL", () => {
  it("create -> read -> publish -> published list -> edit refused (409) -> unpublish -> edit allowed", async () => {
    const t = await start();
    const created = await t.call("POST", "/api/admin/walkthroughs", "maintainer", { applicationId: t.appId, definition: defOf() });
    expect(created.status).toBe(201);
    const id = created.body.id as string;
    expect(id).toMatch(/^wt-[a-f0-9]{12}$/);
    expect(created.body).toMatchObject({ status: "draft", definition: { id, title: TITLE } });

    const list = await t.call("GET", "/api/admin/walkthroughs", "maintainer");
    expect(list.status).toBe(200);
    expect((list.body.authored as { id: string }[]).map((g) => g.id)).toEqual([id]);
    expect((list.body.builtIn as { id: string }[]).map((g) => g.id)).toEqual(["profileUpdate", "findSecuritySettings", "findTwoFactorSettings"]);
    expect((await t.call("GET", `/api/admin/walkthroughs/${id}`, "maintainer")).body).toMatchObject({ id, status: "draft" });

    expect((await t.call("GET", "/api/walkthroughs/published", "user")).body).toEqual({ walkthroughs: [], external: [] }); // a draft is never published

    const published = await t.call("POST", `/api/admin/walkthroughs/${id}/status`, "maintainer", { status: "published" });
    expect(published.status).toBe(200);
    expect(published.body).toMatchObject({ id, status: "published" });
    const served = await t.call("GET", "/api/walkthroughs/published", "user");
    expect((served.body.walkthroughs as { id: string; title: string }[]).map((g) => [g.id, g.title])).toEqual([[id, TITLE]]);

    const refused = await t.call("PUT", `/api/admin/walkthroughs/${id}`, "maintainer", { applicationId: t.appId, definition: defOf({ title: "Nope" }) });
    expect(refused.status).toBe(409);
    expect(refused.body).toEqual({ kind: "conflict", message: AUTHORING_MESSAGES.published });
    expect((await t.store.get(t.tenant, id))?.definition).toMatchObject({ title: TITLE });

    const unpublished = await t.call("POST", `/api/admin/walkthroughs/${id}/status`, "maintainer", { status: "draft" });
    expect(unpublished.status).toBe(200);
    expect((await t.call("GET", "/api/walkthroughs/published", "user")).body).toEqual({ walkthroughs: [], external: [] });
    const edited = await t.call("PUT", `/api/admin/walkthroughs/${id}`, "maintainer", { applicationId: t.appId, definition: defOf({ title: "Edited" }) });
    expect(edited.status).toBe(200);
    expect(edited.body).toMatchObject({ id, status: "draft", definition: { id, title: "Edited" } });
  });

  it("the audit trail shows one MEDIUM allowed execution per write, for the maintainer, and never the definition", async () => {
    const t = await start();
    const created = await t.call("POST", "/api/admin/walkthroughs", "maintainer", { applicationId: t.appId, definition: defOf() });
    const id = created.body.id as string;
    await t.call("POST", `/api/admin/walkthroughs/${id}/status`, "maintainer", { status: "published" });
    const trail = await t.rows();
    expect(trail.map((r) => r.event_type)).toEqual(Array(2).fill(["AI_ACTION_PROPOSED", "AI_ACTION_ALLOWED", "AI_ACTION_EXECUTED"]).flat());
    expect(trail.filter((r) => r.event_type === "AI_ACTION_ALLOWED").map((r) => [r.action_id, r.risk, r.user_id])).toEqual([["saveWalkthroughDraft", "MEDIUM", "maya"], ["setWalkthroughStatus", "MEDIUM", "maya"]]);
    expect(trail.filter((r) => r.event_type === "AI_ACTION_EXECUTED").map((r) => r.execution_result)).toEqual(["success", "success"]);
    const text = JSON.stringify(trail);
    for (const word of [TITLE, "profile.saveButton", "Press Save", "navigate", "steps"]) expect(text, word).not.toContain(word);
  });

  it("an ordinary user is refused (403) on every admin route, with no Gateway call and no audit row, and can still read the published list", async () => {
    const t = await start();
    const created = await t.call("POST", "/api/admin/walkthroughs", "maintainer", { applicationId: t.appId, definition: defOf() });
    const id = created.body.id as string;
    const before = (await t.rows()).length;
    for (const [method, url, body] of [["GET", "/api/admin/walkthroughs"], ["GET", `/api/admin/walkthroughs/${id}`], ["POST", "/api/admin/walkthroughs", { applicationId: t.appId, definition: defOf() }], ["PUT", `/api/admin/walkthroughs/${id}`, { applicationId: t.appId, definition: defOf() }], ["POST", `/api/admin/walkthroughs/${id}/status`, { status: "published" }]] as const) {
      const res = await t.call(method, url, "user", body);
      expect(res.status, `${method} ${url}`).toBe(403);
      expect(res.body).toEqual({ kind: "forbidden", message: AUTHORING_MESSAGES.forbidden });
    }
    expect(await t.rows()).toHaveLength(before);
    expect((await t.store.get(t.tenant, id))?.status).toBe("draft");
    expect((await t.call("GET", "/api/walkthroughs/published", "user")).status).toBe(200);
  });

  it("the Gateway is a second lock: a principal the ROUTE lets through but whose Gateway session lacks the permission is refused (403) with an UNAUTHORIZED trail and nothing stored", async () => {
    const t = await start({ mismatched: true });
    const res = await t.call("POST", "/api/admin/walkthroughs", "maintainer", { applicationId: t.appId, definition: defOf() });
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ kind: "forbidden", message: AUTHORING_MESSAGES.refused });
    for (const word of ["perm.", "UNAUTHORIZED", "walkthrough.maintain", "Gateway"]) expect(res.raw).not.toContain(word);
    expect(await t.store.list(t.tenant)).toEqual([]);
    expect(t.trusted.executorCalls()).toBe(0);
    const trail = await t.rows();
    expect(trail.map((r) => r.event_type)).toEqual(["AI_ACTION_PROPOSED", "AI_ACTION_DENIED"]);
    expect(trail[1]).toMatchObject({ outcome: "UNAUTHORIZED" });
  });

  it("an invalid definition is a 422 with issues BEFORE the Gateway: no audit row, nothing stored", async () => {
    const t = await start();
    const res = await t.call("POST", "/api/admin/walkthroughs", "maintainer", { applicationId: t.appId, definition: defOf({ start: "nowhere" }) });
    expect(res.status).toBe(422);
    expect((res.body.issues as string[]).join(" ")).toMatch(/missing start step/);
    expect(await t.rows()).toEqual([]);
    expect(await t.store.list(t.tenant)).toEqual([]);
  });

  it("capabilities are OFF unless DAP_ENABLED_ACTIONS lists them: a maintainer's write is refused (403) and nothing is stored", async () => {
    const t = await start({ enabled: "demoLookup" });
    const res = await t.call("POST", "/api/admin/walkthroughs", "maintainer", { applicationId: t.appId, definition: defOf() });
    expect(res.status).toBe(403);
    expect(await t.store.list(t.tenant)).toEqual([]);
    expect(t.trusted.executorCalls()).toBe(0);
    expect((await t.call("GET", "/api/admin/walkthroughs", "maintainer")).status).toBe(200); // reads are not Gateway capabilities
  });

  it("tenants are isolated: another tenant's maintainer lists none of it, cannot read, edit or publish it, and sees none in the published list", async () => {
    const a = await start();
    const b = await start();
    const created = await a.call("POST", "/api/admin/walkthroughs", "maintainer", { applicationId: a.appId, definition: defOf() });
    const id = created.body.id as string;
    await a.call("POST", `/api/admin/walkthroughs/${id}/status`, "maintainer", { status: "published" });
    expect(((await b.call("GET", "/api/admin/walkthroughs", "maintainer")).body.authored as unknown[])).toEqual([]);
    expect((await b.call("GET", `/api/admin/walkthroughs/${id}`, "maintainer")).status).toBe(404);
    expect((await b.call("PUT", `/api/admin/walkthroughs/${id}`, "maintainer", { applicationId: b.appId, definition: defOf() })).status).toBe(404);
    expect((await b.call("POST", `/api/admin/walkthroughs/${id}/status`, "maintainer", { status: "draft" })).status).toBe(404);
    expect((await b.call("GET", "/api/walkthroughs/published", "user")).body).toEqual({ walkthroughs: [], external: [] });
    expect((await a.call("GET", "/api/walkthroughs/published", "user")).body).toMatchObject({ walkthroughs: [expect.objectContaining({ id })] });
  });

  it("a supplied built-in id is refused before submission, and a built-in guide can never be replaced", async () => {
    const t = await start();
    const res = await t.call("POST", "/api/admin/walkthroughs", "maintainer", { applicationId: t.appId, definition: defOf({ id: "profileUpdate" }) });
    expect(res.status).toBe(422);
    expect(t.trusted.executorCalls()).toBe(0);
    expect(await t.rows()).toEqual([]);
    expect((await t.call("PUT", "/api/admin/walkthroughs/profileUpdate", "maintainer", { applicationId: t.appId, definition: defOf() })).status).toBe(404);
    expect((await t.call("POST", "/api/admin/walkthroughs/profileUpdate/status", "maintainer", { status: "published" })).status).toBe(404);
    expect((await t.call("GET", "/api/admin/walkthroughs/profileUpdate", "maintainer")).status).toBe(404);
  });
});
