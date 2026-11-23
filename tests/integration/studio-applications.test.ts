/**
 * Studio V1A on PostgreSQL: the application store (RLS, the cap of 20, no delete), and the application-aware authoring flow through the REAL Policy Gateway, the REAL
 * executors and Fastify `inject` (no port is opened): create application -> create workflow -> save -> publish -> published list; tenant isolation incl. cross-tenant
 * get/update/status; cross-application mismatch at save/update/publish; disabled applications; a second registry injected through the catalog proving validation uses the
 * APPLICATION's registry; capability audit rows that hold only /applicationId (+ /enabled); a legacy guide without an application. NEEDS the PostgreSQL of
 * deploy/compose.yaml on a FRESH database (DAP_DATABASE_URL / DAP_MIGRATE_DATABASE_URL); every test uses tenants of its own.
 */
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { composeReferenceHost } from "../../apps/reference-host/src/index.js";
import type { ReferenceHost } from "../../apps/reference-host/src/index.js";
import { parseDevSessions } from "../../apps/reference-host/src/dev-auth/index.js";
import { createAuthoringExtension } from "../../apps/reference-host/src/authoring/capabilities.js";
import type { WalkthroughStore } from "../../apps/reference-host/src/authoring/store.js";
import { createPostgresWalkthroughStore } from "../../apps/reference-host/src/authoring/postgres-store.js";
import { createDemoPrincipalResolver } from "../../apps/reference-host/src/authoring/principal.js";
import { AUTHORING_MESSAGES, registerAuthoringRoutes } from "../../apps/reference-host/src/authoring/routes.js";
import { withTenant } from "../../apps/reference-host/src/authoring/tenant-tx.js";
import { createProposalStore } from "../../apps/reference-host/src/http/proposal-store.js";
import { createGuidanceTransport } from "../../apps/reference-host/src/http/transport.js";
import { demoCatalogView } from "../../apps/reference-host/src/guidance/walkthrough-summaries.js";
import { createApplicationExtension } from "../../apps/reference-host/src/studio/application-capabilities.js";
import { registerApplicationRoutes } from "../../apps/reference-host/src/studio/application-routes.js";
import { MAX_APPLICATIONS_PER_TENANT, generateApplicationId } from "../../apps/reference-host/src/studio/applications.js";
import type { ApplicationConfig } from "../../apps/reference-host/src/studio/applications.js";
import { FIXTURE_ENTRY } from "../../apps/reference-host/src/studio/fixture-registry.js";
import { createPostgresApplicationStore } from "../../apps/reference-host/src/studio/postgres-application-store.js";
import { createRegistryCatalog } from "../../apps/reference-host/src/studio/registries.js";
import { createPostgresPool } from "../../packages/security/src/index.js";
import { withTenant as withTenantOwner } from "../../packages/security/src/state/postgres/tenant-tx.js";
import { openStatePools } from "../../packages/security/src/state/conformance/state-pg-fixtures.js";

let owner: Pool; let probe: Pool;
const closers: (() => Promise<unknown>)[] = [];
const hosts: ReferenceHost[] = [];
beforeAll(async () => { ({ app: probe, owner } = await openStatePools(Pool)); });
afterAll(async () => { await Promise.all([probe?.end(), owner?.end()]); });
afterEach(async () => { await Promise.all([...closers.splice(0).map((close) => close()), ...hosts.splice(0).map((host) => host.close())]); });

const NAME = "Distinctive-Application-Name-3319";
const ORIGIN = "http://127.0.0.1:5199";
const referenceConfig = (over: Partial<ApplicationConfig> = {}): ApplicationConfig => ({ name: NAME, origin: "http://localhost:5184", allowedOrigins: ["http://localhost:5184"], environment: "development", registryId: "reference", routing: "hash", runtimeAccess: false, ...over });
const fixtureConfig = (over: Partial<ApplicationConfig> = {}): ApplicationConfig => ({ name: "Second application", origin: ORIGIN, allowedOrigins: [ORIGIN], environment: "test", registryId: "fixture", routing: "hash", runtimeAccess: false, ...over });
const profileDef = (over: Record<string, unknown> = {}) => ({
  title: "Save your name", description: "Change your display name and save it.", start: "n1",
  steps: [{ id: "n1", kind: "navigate", route: "profile", next: "s1" }, { id: "s1", kind: "guide", target: "profile.saveButton", text: "Press Save.", wait: "click", verify: "profile.saved", next: "done" }, { id: "done", kind: "complete", text: "Done." }],
  ...over,
});
const ordersDef = (over: Record<string, unknown> = {}) => ({
  title: "Export orders", description: "Export the orders list.", start: "n1",
  steps: [{ id: "n1", kind: "navigate", route: "orders", next: "s1" }, { id: "s1", kind: "guide", target: "orders.exportButton", text: "Press Export.", wait: "click", next: "done" }, { id: "done", kind: "complete", text: "Done." }],
  ...over,
});

const ALL_ACTIONS = "demoLookup,saveWalkthroughDraft,setWalkthroughStatus,saveStudioApplication,setStudioApplicationEnabled";

/** One tenant, one host: a maintainer and an ordinary user, both capabilities families, both route families, the second registry in the catalog. */
async function start(options: { enabled?: string; tenant?: string; wrapStore?: (real: WalkthroughStore) => WalkthroughStore } = {}) {
  const tenant = options.tenant ?? randomUUID();
  const suffix = tenant.slice(0, 8);
  const future = new Date(Date.now() + 3_600_000).toISOString();
  const [userToken, maintToken] = [`tok-${randomUUID()}`, `tok-${randomUUID()}`];
  const sessions = [
    { token: userToken, userId: "ula", tenantId: tenant, sessionId: `s-ula-${suffix}-${randomUUID().slice(0, 4)}`, validUntil: future, permissions: ["perm.demo.lookup"] },
    { token: maintToken, userId: "maya", tenantId: tenant, sessionId: `s-maya-${suffix}-${randomUUID().slice(0, 4)}`, validUntil: future, permissions: ["perm.walkthrough.maintain", "perm.demo.lookup"] },
  ];
  const pool = createPostgresPool(process.env.DAP_DATABASE_URL!, { max: 6 });
  closers.push(() => pool.end());
  const realStore = createPostgresWalkthroughStore(pool);
  // Every saveDraft that reaches the store is counted: an executor that refuses (unknown, other-tenant or disabled application) must NOT get this far.
  const saveDraft = vi.fn(realStore.saveDraft);
  const store: WalkthroughStore = options.wrapStore ? options.wrapStore({ ...realStore, saveDraft }) : { ...realStore, saveDraft };
  const applications = createPostgresApplicationStore(pool);
  const catalog = createRegistryCatalog([FIXTURE_ENTRY]);
  const authoring = createAuthoringExtension({ store, applications, catalog });
  const studio = createApplicationExtension({ store: applications, catalog });
  const { host } = await composeReferenceHost(
    { NODE_ENV: "test", DAP_ALLOW_DEV_AUTH: "1", DAP_DATABASE_URL: process.env.DAP_DATABASE_URL, DAP_ENABLED_ACTIONS: options.enabled ?? ALL_ACTIONS, DEV_SESSIONS: JSON.stringify(sessions) },
    { extensions: [authoring.extension, studio.extension] },
  );
  hosts.push(host);
  const resolvePrincipal = createDemoPrincipalResolver({ sessions: parseDevSessions(JSON.stringify(sessions)), userToken, maintainerToken: maintToken, openSession: (evidence) => host.openSession(evidence) });
  const app = createGuidanceTransport({ ask: async () => ({ kind: "clarify", message: "x" }), catalog: demoCatalogView, resolveSession: async () => null, proposals: createProposalStore({ now: Date.now, newId: () => "proposal-id-0000000000000000" }) });
  registerAuthoringRoutes(app, { store, applications, catalog, resolvePrincipal });
  registerApplicationRoutes(app, { applications, catalog, resolvePrincipal });
  closers.push(() => app.close());
  const call = async (method: "GET" | "POST" | "PUT", url: string, role: "user" | "maintainer", body?: unknown) => {
    const res = await app.inject({ method, url, headers: { "x-demo-role": role, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { payload: JSON.stringify(body) }) });
    return { status: res.statusCode, body: JSON.parse(res.body) as Record<string, unknown>, raw: res.body };
  };
  /** A FRESH Gateway session per call: each write is its own turn. */
  const submit = async (action: string, params: unknown, token = maintToken) => {
    const session = await host.openSession(token);
    if (session === null) throw new Error("session refused");
    return session.submit({ providerCallId: `call-${randomUUID()}`, arguments: JSON.stringify({ action, params }) });
  };
  const rows = async () => (await withTenantOwner(owner, tenant, (client) => client.query("SELECT event_type, action_id, outcome, risk, params_view, execution_result, resource_type, resource_id, user_id FROM public.sec_audit_events ORDER BY seq"))).rows as Record<string, unknown>[];
  const createApplication = async (config: ApplicationConfig = referenceConfig()) => {
    const res = await call("POST", "/api/admin/applications", "maintainer", config);
    if (res.status !== 201) throw new Error(`application not created: ${res.status}`);
    return res.body.id as string;
  };
  const createWorkflow = async (applicationId: string, definition: unknown = profileDef()) => {
    const res = await call("POST", "/api/admin/walkthroughs", "maintainer", { applicationId, definition });
    return { res, id: res.body.id as string };
  };
  return { tenant, call, submit, rows, store, realStore, saveDraft, applications, trusted: authoring.trusted, studioTrusted: studio.trusted, createApplication, createWorkflow, maintToken, userToken, pool };
}

describe("the application store on PostgreSQL", () => {
  const scope = (tenantId: string, actor = "maya") => ({ tenantId, actor });
  const stores = () => { const pool = createPostgresPool(process.env.DAP_DATABASE_URL!, { max: 8 }); closers.push(() => pool.end()); return createPostgresApplicationStore(pool); };

  it("creates, reads back and lists an application with the normalised fields and an enabled flag that starts true", async () => {
    const s = stores(); const tenant = randomUUID(); const id = generateApplicationId();
    expect(await s.save(scope(tenant), id, referenceConfig())).toBe("created");
    expect(await s.get(tenant, id)).toMatchObject({ id, name: NAME, origin: "http://localhost:5184", allowedOrigins: ["http://localhost:5184"], environment: "development", registryId: "reference", enabled: true });
    expect(await s.list(tenant)).toEqual([expect.objectContaining({ id, enabled: true })]);
    const stored = (await withTenant(createPostgresPool(process.env.DAP_DATABASE_URL!, { max: 1 }), tenant, (c) => c.query("SELECT created_by, updated_by FROM public.studio_applications"))).rows;
    expect(stored).toEqual([{ created_by: "maya", updated_by: "maya" }]);
  });
  it("update keeps the id, the creator and the enabled flag; setEnabled reports changed / unchanged / not_found and never creates", async () => {
    const s = stores(); const tenant = randomUUID(); const id = generateApplicationId();
    await s.save(scope(tenant, "alice"), id, referenceConfig());
    expect(await s.setEnabled(scope(tenant), id, false)).toBe("changed");
    expect(await s.setEnabled(scope(tenant), id, false)).toBe("unchanged");
    expect(await s.save(scope(tenant, "bob"), id, referenceConfig({ name: "Renamed" }))).toBe("updated");
    expect(await s.get(tenant, id)).toMatchObject({ name: "Renamed", enabled: false });
    expect(await s.setEnabled(scope(tenant), generateApplicationId(), true)).toBe("not_found");
    expect(await s.list(tenant)).toHaveLength(1);
    const stored = (await withTenant(createPostgresPool(process.env.DAP_DATABASE_URL!, { max: 1 }), tenant, (c) => c.query("SELECT created_by, updated_by FROM public.studio_applications"))).rows;
    expect(stored).toEqual([{ created_by: "alice", updated_by: "bob" }]);
  });
  it("tenants are isolated: another tenant cannot read, list, enable or overwrite an application, and the same id may exist in both", async () => {
    const s = stores(); const [a, b] = [randomUUID(), randomUUID()]; const id = generateApplicationId();
    await s.save(scope(a), id, referenceConfig({ name: "Tenant A" }));
    expect(await s.get(b, id)).toBeNull();
    expect(await s.list(b)).toEqual([]);
    expect(await s.setEnabled(scope(b), id, false)).toBe("not_found");
    expect(await s.save(scope(b), id, referenceConfig({ name: "Tenant B" }))).toBe("created"); // B's own, separate row
    expect((await s.get(a, id))?.name).toBe("Tenant A");
    expect((await s.get(b, id))?.name).toBe("Tenant B");
    expect((await s.get(a, id))?.enabled).toBe(true);
  });
  it(`caps an application count at ${MAX_APPLICATIONS_PER_TENANT} per tenant (the 21st is limit_reached; an update at the cap still works); another tenant is unaffected`, async () => {
    const s = stores(); const tenant = randomUUID();
    const ids = Array.from({ length: MAX_APPLICATIONS_PER_TENANT + 1 }, () => generateApplicationId());
    for (const id of ids.slice(0, MAX_APPLICATIONS_PER_TENANT)) expect(await s.save(scope(tenant), id, referenceConfig())).toBe("created");
    expect(await s.save(scope(tenant), ids[MAX_APPLICATIONS_PER_TENANT]!, referenceConfig())).toBe("limit_reached");
    expect(await s.get(tenant, ids[MAX_APPLICATIONS_PER_TENANT]!)).toBeNull();
    expect(await s.save(scope(tenant), ids[0]!, referenceConfig({ name: "Still editable" }))).toBe("updated");
    expect(await s.list(tenant)).toHaveLength(MAX_APPLICATIONS_PER_TENANT);
    expect(await s.save(scope(randomUUID()), ids[MAX_APPLICATIONS_PER_TENANT]!, referenceConfig())).toBe("created");
  }, 60_000);
  it("concurrent creates cannot exceed the cap", async () => {
    const s = stores(); const tenant = randomUUID();
    const ids = Array.from({ length: MAX_APPLICATIONS_PER_TENANT + 5 }, () => generateApplicationId());
    const outcomes = await Promise.all(ids.map((id) => s.save(scope(tenant), id, referenceConfig())));
    expect(outcomes.filter((o) => o === "created")).toHaveLength(MAX_APPLICATIONS_PER_TENANT);
    expect(outcomes.filter((o) => o === "limit_reached")).toHaveLength(5);
    expect(await s.list(tenant)).toHaveLength(MAX_APPLICATIONS_PER_TENANT);
  }, 60_000);
  it("lists newest update first", async () => {
    const s = stores(); const tenant = randomUUID();
    const [x, y] = [generateApplicationId(), generateApplicationId()];
    await s.save(scope(tenant), x, referenceConfig({ name: "X" }));
    await new Promise((resolve) => setTimeout(resolve, 15));
    await s.save(scope(tenant), y, referenceConfig({ name: "Y" }));
    expect((await s.list(tenant)).map((a) => a.name)).toEqual(["Y", "X"]);
    await new Promise((resolve) => setTimeout(resolve, 15));
    await s.setEnabled(scope(tenant), x, false);
    expect((await s.list(tenant)).map((a) => a.name)).toEqual(["X", "Y"]);
  });
  it.each(["wt-0123456789ab", "app-0123456789AB", "app-0123456789a", "", "__proto__", "app-0123456789ab\n", "../x"])("refuses the id %j: save and setEnabled say id_refused, get returns null, and nothing is stored", async (id) => {
    const s = stores(); const tenant = randomUUID();
    expect(await s.save(scope(tenant), id, referenceConfig())).toBe("id_refused");
    expect(await s.setEnabled(scope(tenant), id, true)).toBe("id_refused");
    expect(await s.get(tenant, id)).toBeNull();
    expect(await s.list(tenant)).toEqual([]);
  });
  it("refuses an empty or oversize actor and a malformed tenant, and a closed pool rejects instead of answering", async () => {
    const s = stores(); const id = generateApplicationId();
    expect(await s.save({ tenantId: randomUUID(), actor: "" }, id, referenceConfig())).toBe("id_refused");
    expect(await s.save({ tenantId: randomUUID(), actor: "a".repeat(257) }, id, referenceConfig())).toBe("id_refused");
    await expect(s.save({ tenantId: "not-a-tenant", actor: "alice" }, id, referenceConfig())).rejects.toThrow(TypeError);
    await expect(s.list("' OR 1=1 --")).rejects.toThrow(TypeError);
    const pool = createPostgresPool(process.env.DAP_DATABASE_URL!, { max: 1 });
    const closed = createPostgresApplicationStore(pool);
    await pool.end();
    await expect(closed.list(randomUUID())).rejects.toThrow();
  });
  it("takes tenant and actor ONLY from the scope: extra fields on the configuration change nothing about who owns the row", async () => {
    const s = stores(); const [real, claimed] = [randomUUID(), randomUUID()]; const id = generateApplicationId();
    await s.save(scope(real, "alice"), id, { ...referenceConfig(), tenantId: claimed, createdBy: "mallory" } as unknown as ApplicationConfig);
    expect(await s.get(claimed, id)).toBeNull();
    expect((await withTenant(createPostgresPool(process.env.DAP_DATABASE_URL!, { max: 1 }), real, (c) => c.query("SELECT created_by, updated_by FROM public.studio_applications"))).rows).toEqual([{ created_by: "alice", updated_by: "alice" }]);
  });
});

describe("the application capabilities through the real Gateway", () => {
  it("saveStudioApplication: ALLOWED, the exact PROPOSED/ALLOWED/EXECUTED trail at risk MEDIUM, a studioApplication resource, and only /applicationId in the audit view", async () => {
    const t = await start();
    const id = generateApplicationId();
    expect(await t.submit("saveStudioApplication", { applicationId: id, ...referenceConfig() })).toEqual({ outcome: "ALLOWED", category: "ok" });
    expect(t.studioTrusted.executorCalls("saveStudioApplication")).toBe(1);
    expect(t.studioTrusted.receivedCalls("saveStudioApplication")).toEqual([{ applicationId: id, ...referenceConfig() }]);
    expect(await t.applications.get(t.tenant, id)).toMatchObject({ id, name: NAME, enabled: true });
    const trail = await t.rows();
    expect(trail.map((row) => row.event_type)).toEqual(["AI_ACTION_PROPOSED", "AI_ACTION_ALLOWED", "AI_ACTION_EXECUTED"]);
    expect(trail[1]).toMatchObject({ outcome: "ALLOWED", risk: "MEDIUM", user_id: "maya", resource_type: "studioApplication", resource_id: id, params_view: { "/applicationId": id } });
    expect(trail[2]).toMatchObject({ execution_result: "success", resource_type: "studioApplication", resource_id: id });
  });
  it("setStudioApplicationEnabled audits only /applicationId and the boolean /enabled; NO name, origin, origins, environment or registry id appears in any audit row", async () => {
    const t = await start();
    const id = await t.createApplication();
    expect(await t.submit("setStudioApplicationEnabled", { applicationId: id, enabled: false })).toEqual({ outcome: "ALLOWED", category: "ok" });
    const trail = await t.rows();
    const views = trail.filter((row) => row.event_type === "AI_ACTION_ALLOWED").map((row) => row.params_view);
    expect(views).toEqual([{ "/applicationId": id }, { "/applicationId": id, "/enabled": false }]);
    const text = JSON.stringify(trail);
    for (const word of [NAME, "localhost", "5184", "development", "registry", "reference", "allowedOrigins", "origin"]) expect(text, word).not.toContain(word);
  });
  it("a session WITHOUT perm.walkthrough.maintain is UNAUTHORIZED on both capabilities, with zero executor runs and nothing stored", async () => {
    const t = await start();
    const id = generateApplicationId();
    expect(await t.submit("saveStudioApplication", { applicationId: id, ...referenceConfig() }, t.userToken)).toEqual({ outcome: "UNAUTHORIZED", category: "not_available" });
    expect(await t.submit("setStudioApplicationEnabled", { applicationId: id, enabled: false }, t.userToken)).toEqual({ outcome: "UNAUTHORIZED", category: "not_available" });
    expect(t.studioTrusted.executorCalls()).toBe(0);
    expect(await t.applications.list(t.tenant)).toEqual([]);
  });
  it("is default-deny: unless DAP_ENABLED_ACTIONS lists the capabilities, a maintainer's route write is refused (403) and nothing is stored", async () => {
    const t = await start({ enabled: "demoLookup,saveWalkthroughDraft,setWalkthroughStatus" });
    const res = await t.call("POST", "/api/admin/applications", "maintainer", referenceConfig());
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ kind: "forbidden", message: AUTHORING_MESSAGES.refused });
    expect(await t.applications.list(t.tenant)).toEqual([]);
    expect(t.studioTrusted.executorCalls()).toBe(0);
  });
  it("spoofed fields are refused by the strict schema (INVALID_PARAMETERS) and never reach an executor", async () => {
    const t = await start();
    for (const extra of [{ tenantId: randomUUID() }, { permissions: ["perm.walkthrough.maintain"] }, { actorId: "mallory" }, { enabled: true }, { role: "admin" }]) {
      expect((await t.submit("saveStudioApplication", { applicationId: generateApplicationId(), ...referenceConfig(), ...extra })).outcome, JSON.stringify(extra)).toBe("INVALID_PARAMETERS");
    }
    expect((await t.submit("setStudioApplicationEnabled", { applicationId: generateApplicationId(), enabled: true, tenantId: randomUUID() })).outcome).toBe("INVALID_PARAMETERS");
    expect(t.studioTrusted.executorCalls()).toBe(0);
  });
  it("an enrollment the validator refuses is ALLOWED by policy and FAILS in the executor (ALLOWED + try_later): nothing stored, the trail says allowed then executed/failure", async () => {
    const t = await start();
    const bad = { applicationId: generateApplicationId(), ...referenceConfig({ origin: "http://example.com", allowedOrigins: ["http://example.com"] }) };
    expect(await t.submit("saveStudioApplication", bad)).toEqual({ outcome: "ALLOWED", category: "try_later" });
    expect(await t.applications.list(t.tenant)).toEqual([]);
    const executed = (await t.rows()).find((row) => row.event_type === "AI_ACTION_EXECUTED");
    expect(executed).toMatchObject({ execution_result: "failure" });
  });
  it("the executor takes the tenant and actor from the trusted context: a tenant id in the parameters is refused, and the row belongs to the session's own tenant", async () => {
    const t = await start();
    const id = await t.createApplication();
    expect((await t.rows()).filter((row) => row.event_type === "AI_ACTION_ALLOWED")[0]).toMatchObject({ user_id: "maya" });
    expect(await t.applications.get(t.tenant, id)).not.toBeNull();
    expect(await t.applications.get(randomUUID(), id)).toBeNull();
  });
  it("the 21st application through the Gateway fails in the executor (limit_reached) and the route answers 409", async () => {
    const t = await start();
    for (let i = 0; i < MAX_APPLICATIONS_PER_TENANT; i += 1) await t.applications.save({ tenantId: t.tenant, actor: "seed" }, generateApplicationId(), referenceConfig({ name: `App ${i}` }));
    const res = await t.call("POST", "/api/admin/applications", "maintainer", referenceConfig());
    expect(res.status).toBe(409);
    expect(await t.submit("saveStudioApplication", { applicationId: generateApplicationId(), ...referenceConfig() })).toEqual({ outcome: "ALLOWED", category: "try_later" });
    expect(await t.applications.list(t.tenant)).toHaveLength(MAX_APPLICATIONS_PER_TENANT);
  }, 60_000);
});

describe("create application -> create workflow -> save -> publish -> published list (reference registry), end to end", () => {
  it("runs the whole flow over the real Gateway and PostgreSQL", async () => {
    const t = await start();
    const created = await t.call("POST", "/api/admin/applications", "maintainer", referenceConfig({ origin: "HTTP://LocalHost:5184/", allowedOrigins: ["HTTP://LocalHost:5184/"] }));
    expect(created.status).toBe(201);
    const appId = created.body.id as string;
    expect(appId).toMatch(/^app-[a-f0-9]{12}$/);
    expect(created.body).toMatchObject({ name: NAME, origin: "http://localhost:5184", allowedOrigins: ["http://localhost:5184"], registryId: "reference", enabled: true });

    const draft = await t.createWorkflow(appId);
    expect(draft.res.status).toBe(201);
    expect(draft.res.body).toMatchObject({ id: draft.id, status: "draft", applicationId: appId, definition: { id: draft.id, title: "Save your name" } });

    const edited = await t.call("PUT", `/api/admin/walkthroughs/${draft.id}`, "maintainer", { expectedRevision: 1, applicationId: appId, definition: profileDef({ title: "Edited title" }) });
    expect(edited.status).toBe(200);
    expect(edited.body).toMatchObject({ applicationId: appId, definition: { title: "Edited title" } });

    expect((await t.call("GET", "/api/walkthroughs/published", "user")).body).toEqual({ walkthroughs: [], external: [] });
    const published = await t.call("POST", `/api/admin/walkthroughs/${draft.id}/status`, "maintainer", { status: "published" });
    expect(published.status).toBe(200);
    expect(published.body).toMatchObject({ status: "published", applicationId: appId });
    const served = await t.call("GET", "/api/walkthroughs/published", "user");
    expect((served.body.walkthroughs as { id: string; title: string }[]).map((g) => [g.id, g.title])).toEqual([[draft.id, "Edited title"]]);
    expect((await t.call("GET", `/api/admin/walkthroughs/${draft.id}`, "maintainer")).body).toMatchObject({ applicationId: appId });
    expect(((await t.call("GET", "/api/admin/walkthroughs", "maintainer")).body.authored as { applicationId: string }[])[0]?.applicationId).toBe(appId);
    expect((await t.call("GET", "/api/admin/applications", "maintainer")).body).toMatchObject({ applications: [{ id: appId }], registries: [{ id: "reference" }, { id: "fixture" }, { id: "studio-managed" }] });
  });
  it("the audit trail shows one MEDIUM allowed execution per write, application writes carry only /applicationId, workflow writes only /walkthroughId", async () => {
    const t = await start();
    const appId = await t.createApplication();
    const draft = await t.createWorkflow(appId);
    await t.call("POST", `/api/admin/walkthroughs/${draft.id}/status`, "maintainer", { status: "published" });
    const allowed = (await t.rows()).filter((row) => row.event_type === "AI_ACTION_ALLOWED");
    expect(allowed.map((row) => [row.action_id, row.risk, row.params_view])).toEqual([
      ["saveStudioApplication", "MEDIUM", { "/applicationId": appId }], ["saveWalkthroughDraft", "MEDIUM", { "/walkthroughId": draft.id }], ["setWalkthroughStatus", "MEDIUM", { "/walkthroughId": draft.id, "/status": "published" }],
    ]);
    expect(JSON.stringify(await t.rows())).not.toContain(NAME);
  });
});

describe("tenant isolation", () => {
  it("another tenant's maintainer cannot read, update, enable or see an application, its registry or a workflow bound to it: every attempt is the same 404 with no data", async () => {
    const a = await start(); const b = await start();
    const appId = await a.createApplication();
    const wt = await a.createWorkflow(appId);
    const notFound = { kind: "not_found", message: "That application was not found.", code: "APPLICATION_NOT_FOUND" };
    for (const [method, url, body] of [
      ["GET", `/api/admin/applications/${appId}`], ["GET", `/api/admin/applications/${appId}/registry`], ["PUT", `/api/admin/applications/${appId}`, referenceConfig({ name: "Hijacked" })],
      ["POST", `/api/admin/applications/${appId}/status`, { enabled: false }],
    ] as const) {
      const res = await b.call(method, url, "maintainer", body);
      expect([method, url, res.status, res.body]).toEqual([method, url, 404, notFound]);
      expect(res.raw).not.toContain(NAME);
    }
    expect((await b.call("GET", "/api/admin/applications", "maintainer")).body.applications).toEqual([]);
    // B cannot bind a workflow to A's application, and cannot touch A's workflow.
    const bind = await b.call("POST", "/api/admin/walkthroughs", "maintainer", { applicationId: appId, definition: profileDef() });
    expect([bind.status, bind.body.code]).toEqual([404, "APPLICATION_NOT_FOUND"]);
    expect((await b.call("PUT", `/api/admin/walkthroughs/${wt.id}`, "maintainer", { expectedRevision: 1, applicationId: appId, definition: profileDef() })).status).toBe(404);
    expect((await b.call("POST", `/api/admin/walkthroughs/${wt.id}/status`, "maintainer", { status: "published" })).status).toBe(404);
    expect((await b.call("GET", `/api/admin/walkthroughs/${wt.id}`, "maintainer")).status).toBe(404);
    // A is untouched.
    expect((await a.call("GET", `/api/admin/applications/${appId}`, "maintainer")).body).toMatchObject({ name: NAME, enabled: true });
    expect(b.studioTrusted.executorCalls()).toBe(0);
    expect(b.trusted.executorCalls()).toBe(0);
  });
  it("the Gateway is a second lock: a direct save naming another tenant's application is ALLOWED by policy and fails in the executor (application_not_found), storing nothing", async () => {
    const a = await start(); const b = await start();
    const appId = await a.createApplication();
    const id = `wt-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    expect(await b.submit("saveWalkthroughDraft", { expectedRevision: 0, walkthroughId: id, applicationId: appId, definition: { ...profileDef(), id } })).toEqual({ outcome: "ALLOWED", category: "try_later" });
    expect(await b.store.list(b.tenant)).toEqual([]);
    expect(await a.store.list(a.tenant)).toEqual([]);
  });
});

describe("workflow <-> application binding", () => {
  it("the application is assigned once: update/save with another application is 409 APPLICATION_MISMATCH at the route, and the Gateway-level save is ALLOWED + try_later with the stored row unchanged", async () => {
    const t = await start();
    const [one, two] = [await t.createApplication(referenceConfig({ name: "One" })), await t.createApplication(referenceConfig({ name: "Two" }))];
    const wt = await t.createWorkflow(one, profileDef({ title: "Bound to one" }));
    const mismatch = await t.call("PUT", `/api/admin/walkthroughs/${wt.id}`, "maintainer", { expectedRevision: 1, applicationId: two, definition: profileDef({ title: "Moved" }) });
    expect(mismatch.status).toBe(409);
    expect(mismatch.body).toEqual({ kind: "conflict", message: AUTHORING_MESSAGES.applicationMismatch, code: "APPLICATION_MISMATCH" });
    const before = t.trusted.executorCalls();
    expect(before).toBe(1);
    expect(await t.submit("saveWalkthroughDraft", { expectedRevision: 0, walkthroughId: wt.id, applicationId: two, definition: { ...profileDef({ title: "Moved" }), id: wt.id } })).toEqual({ outcome: "ALLOWED", category: "try_later" });
    expect(await t.store.get(t.tenant, wt.id)).toMatchObject({ applicationId: one, definition: { title: "Bound to one" } });
    // The same application keeps updating.
    expect((await t.call("PUT", `/api/admin/walkthroughs/${wt.id}`, "maintainer", { expectedRevision: 1, applicationId: one, definition: profileDef({ title: "Still one" }) })).status).toBe(200);
    // The database refuses a raw change as well (the trigger).
    await expect(withTenant(t.pool, t.tenant, (c) => c.query("UPDATE public.walkthrough_definitions SET application_id=$2 WHERE walkthrough_id=$1", [wt.id, two]))).rejects.toThrow(/cannot be changed/);
  });
  it("publish re-validates the STORED definition against ITS application's registry: re-pointing the application at another registry makes the draft stale (422 at the route, try_later at the Gateway)", async () => {
    const t = await start();
    const appId = await t.createApplication();
    const wt = await t.createWorkflow(appId);
    const moved = await t.call("PUT", `/api/admin/applications/${appId}`, "maintainer", fixtureConfig({ name: "Now the second registry" }));
    expect(moved.status).toBe(200);
    expect(moved.body).toMatchObject({ registryId: "fixture" });
    const stale = await t.call("POST", `/api/admin/walkthroughs/${wt.id}/status`, "maintainer", { status: "published" });
    expect(stale.status).toBe(422);
    expect(await t.submit("setWalkthroughStatus", { walkthroughId: wt.id, status: "published" })).toEqual({ outcome: "ALLOWED", category: "try_later" });
    expect((await t.store.get(t.tenant, wt.id))?.status).toBe("draft");
    // Pointing it back makes the same stored draft publishable again.
    await t.call("PUT", `/api/admin/applications/${appId}`, "maintainer", referenceConfig());
    expect((await t.call("POST", `/api/admin/walkthroughs/${wt.id}/status`, "maintainer", { status: "published" })).status).toBe(200);
  });
  it("a second registry proves validation uses the APPLICATION's registry: a target valid for registry B is refused for application A and vice versa, at create, update and publish", async () => {
    const t = await start();
    const [reference, second] = [await t.createApplication(), await t.createApplication(fixtureConfig())];
    expect((await t.call("POST", "/api/admin/walkthroughs", "maintainer", { applicationId: reference, definition: ordersDef() })).status).toBe(422);
    expect((await t.call("POST", "/api/admin/walkthroughs", "maintainer", { applicationId: second, definition: profileDef() })).status).toBe(422);
    const ok = await t.createWorkflow(second, ordersDef());
    const refOk = await t.createWorkflow(reference, profileDef());
    expect([ok.res.status, refOk.res.status]).toEqual([201, 201]);
    expect((await t.call("PUT", `/api/admin/walkthroughs/${ok.id}`, "maintainer", { expectedRevision: 1, applicationId: second, definition: profileDef() })).status).toBe(422);
    expect((await t.call("PUT", `/api/admin/walkthroughs/${refOk.id}`, "maintainer", { expectedRevision: 1, applicationId: reference, definition: ordersDef() })).status).toBe(422);
    // The Gateway-level executor applies the same rule (defence in depth): a wrong-registry save is ALLOWED by policy and FAILS.
    expect(await t.submit("saveWalkthroughDraft", { expectedRevision: 0, walkthroughId: refOk.id, applicationId: reference, definition: { ...ordersDef(), id: refOk.id } })).toEqual({ outcome: "ALLOWED", category: "try_later" });
    expect((await t.store.get(t.tenant, refOk.id))?.definition).toMatchObject({ title: "Save your name" });
    for (const id of [ok.id, refOk.id]) expect((await t.call("POST", `/api/admin/walkthroughs/${id}/status`, "maintainer", { status: "published" })).status).toBe(200);
    const served = await t.call("GET", "/api/walkthroughs/published", "user");
    expect((served.body.walkthroughs as { id: string }[]).map((g) => g.id).sort()).toEqual([ok.id, refOk.id].sort());
  });
  it("the published list validates each guide against its own application's registry: a stored guide that no longer fits is left out while the others still load, and a draft never appears", async () => {
    const t = await start();
    const [reference, second] = [await t.createApplication(), await t.createApplication(fixtureConfig())];
    const a = await t.createWorkflow(reference, profileDef({ title: "Reference guide" }));
    const b = await t.createWorkflow(second, ordersDef({ title: "Second guide" }));
    const draft = await t.createWorkflow(second, ordersDef({ title: "Only a draft" }));
    for (const id of [a.id, b.id]) await t.call("POST", `/api/admin/walkthroughs/${id}/status`, "maintainer", { status: "published" });
    const titles = async () => ((await t.call("GET", "/api/walkthroughs/published", "user")).body.walkthroughs as { title: string }[]).map((g) => g.title).sort();
    expect(await titles()).toEqual(["Reference guide", "Second guide"]);
    expect(draft.res.status).toBe(201);
    // Re-point the second application at the reference registry: its published guide no longer validates and is left out; the reference guide still loads.
    await t.call("PUT", `/api/admin/applications/${second}`, "maintainer", referenceConfig({ name: "Second, repointed" }));
    expect(await titles()).toEqual(["Reference guide"]);
  });
  it("a DISABLED application refuses create, update and publish (409 APPLICATION_DISABLED), the Gateway refuses the same save in the executor, published guides keep running, unpublishing stays allowed, and re-enabling restores authoring", async () => {
    const t = await start();
    const appId = await t.createApplication();
    const published = await t.createWorkflow(appId, profileDef({ title: "Live" }));
    const open = await t.createWorkflow(appId, profileDef({ title: "Open draft" }));
    await t.call("POST", `/api/admin/walkthroughs/${published.id}/status`, "maintainer", { status: "published" });
    const off = await t.call("POST", `/api/admin/applications/${appId}/status`, "maintainer", { enabled: false });
    expect(off.body).toMatchObject({ enabled: false });
    const disabled = { kind: "conflict", message: AUTHORING_MESSAGES.applicationDisabled, code: "APPLICATION_DISABLED" };
    expect((await t.call("POST", "/api/admin/walkthroughs", "maintainer", { applicationId: appId, definition: profileDef() })).body).toEqual(disabled);
    expect((await t.call("PUT", `/api/admin/walkthroughs/${open.id}`, "maintainer", { expectedRevision: 1, applicationId: appId, definition: profileDef({ title: "Edit" }) })).body).toEqual(disabled);
    expect((await t.call("POST", `/api/admin/walkthroughs/${open.id}/status`, "maintainer", { status: "published" })).body).toEqual(disabled);
    expect(await t.submit("saveWalkthroughDraft", { expectedRevision: 0, walkthroughId: open.id, applicationId: appId, definition: { ...profileDef({ title: "Edit" }), id: open.id } })).toEqual({ outcome: "ALLOWED", category: "try_later" });
    expect(await t.submit("setWalkthroughStatus", { walkthroughId: open.id, status: "published" })).toEqual({ outcome: "ALLOWED", category: "try_later" });
    expect((await t.store.get(t.tenant, open.id))).toMatchObject({ status: "draft", definition: { title: "Open draft" } });
    expect(((await t.call("GET", "/api/walkthroughs/published", "user")).body.walkthroughs as { id: string }[]).map((g) => g.id)).toEqual([published.id]);
    expect((await t.call("POST", `/api/admin/walkthroughs/${published.id}/status`, "maintainer", { status: "draft" })).status).toBe(200);
    expect((await t.call("POST", `/api/admin/applications/${appId}/status`, "maintainer", { enabled: true })).body).toMatchObject({ enabled: true });
    expect((await t.call("PUT", `/api/admin/walkthroughs/${open.id}`, "maintainer", { expectedRevision: 1, applicationId: appId, definition: profileDef({ title: "Edit" }) })).status).toBe(200);
  });
  it("a LEGACY guide (written before Studio, application_id NULL) stays readable, takes an application on its first save, publishes as the reference application and is served", async () => {
    const t = await start();
    const legacyDraft = `wt-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const legacyLive = `wt-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    for (const [id, title] of [[legacyDraft, "Legacy draft"], [legacyLive, "Legacy live"]] as const) {
      await withTenant(t.pool, t.tenant, (c) => c.query(
        "INSERT INTO public.walkthrough_definitions (tenant_id, walkthrough_id, status, definition, created_by, updated_by) VALUES ($1::uuid,$2,'draft',$3::jsonb,'old','old')", [t.tenant, id, JSON.stringify({ ...profileDef({ title }), id })]));
    }
    expect((await t.call("POST", `/api/admin/walkthroughs/${legacyLive}/status`, "maintainer", { status: "published" })).status).toBe(200);
    // No application exists at all, yet the legacy published guide is served (it resolves to the reference registry).
    expect(((await t.call("GET", "/api/walkthroughs/published", "user")).body.walkthroughs as { id: string }[]).map((g) => g.id)).toEqual([legacyLive]);
    expect((await t.call("GET", `/api/admin/walkthroughs/${legacyDraft}`, "maintainer")).body).toMatchObject({ id: legacyDraft, status: "draft", applicationId: null });
    expect(((await t.call("GET", "/api/admin/walkthroughs", "maintainer")).body.authored as { id: string; applicationId: unknown }[]).map((g) => [g.id, g.applicationId]).sort()).toEqual([[legacyDraft, null], [legacyLive, null]].sort());
    // Legacy published: unpublish needs no application; legacy draft publishes without any application record.
    expect((await t.call("POST", `/api/admin/walkthroughs/${legacyDraft}/status`, "maintainer", { status: "published" })).status).toBe(200);
    expect((await t.call("POST", `/api/admin/walkthroughs/${legacyLive}/status`, "maintainer", { status: "draft" })).status).toBe(200);
    // The first save assigns the application; afterwards it is bound.
    const [x, y] = [await t.createApplication(referenceConfig({ name: "X" })), await t.createApplication(referenceConfig({ name: "Y" }))];
    expect((await t.call("PUT", `/api/admin/walkthroughs/${legacyLive}`, "maintainer", { expectedRevision: 3, applicationId: x, definition: profileDef({ title: "Now bound" }) })).body).toMatchObject({ applicationId: x, definition: { title: "Now bound" } });
    expect((await t.call("PUT", `/api/admin/walkthroughs/${legacyLive}`, "maintainer", { expectedRevision: 1, applicationId: y, definition: profileDef() })).body).toMatchObject({ code: "APPLICATION_MISMATCH" });
  });
  it("an application's registry endpoint returns the public-eligible registry, and previewable only for the reference registry", async () => {
    const t = await start();
    const [reference, second] = [await t.createApplication(), await t.createApplication(fixtureConfig())];
    const a = await t.call("GET", `/api/admin/applications/${reference}/registry`, "maintainer");
    expect(a.body).toMatchObject({ routes: ["dashboard", "profile", "settings"], previewable: true });
    expect(a.raw).not.toContain("emailInput");
    const b = await t.call("GET", `/api/admin/applications/${second}/registry`, "maintainer");
    expect(b.body).toMatchObject({ routes: ["home", "orders"], previewable: false, postconditionNames: ["orders.exported"] });
    expect((b.body.elements as { id: string }[]).map((e) => e.id)).toEqual(["orders.exportButton"]);
  });
});

describe("the longest origin the validator accepts is storable (validator and database CHECK agree)", () => {
  const dns = (n: number): string => `${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(n - 128)}`;
  it("enrolls five origins of 190 characters after the scheme (https, one with a port) through the real route, stores them and reads them back; 191 is a 422, never a 503", async () => {
    const t = await start();
    const longest = [`https://${dns(190)}`, `https://${dns(184)}:65535`, `https://${dns(189)}`, `https://${dns(188)}`, `https://${dns(187)}`];
    const created = await t.call("POST", "/api/admin/applications", "maintainer", referenceConfig({ origin: longest[0]!, allowedOrigins: longest }));
    expect(created.status).toBe(201);
    expect((created.body.allowedOrigins as string[]).map((o) => o.length - "https://".length)).toEqual([190, 190, 189, 188, 187]);
    const read = await t.call("GET", `/api/admin/applications/${created.body.id as string}`, "maintainer");
    expect(read.body).toMatchObject({ origin: longest[0], allowedOrigins: longest });
    const tooLong = `https://${dns(191)}`;
    const refused = await t.call("POST", "/api/admin/applications", "maintainer", referenceConfig({ origin: tooLong, allowedOrigins: [tooLong] }));
    expect(refused.status).toBe(422);
    expect(refused.raw).not.toContain("aaaaaaaa");
    // The same through the store directly (the database CHECK is the last line of defence).
    const direct = createPostgresApplicationStore(t.pool);
    expect(await direct.save({ tenantId: t.tenant, actor: "maya" }, generateApplicationId(), referenceConfig({ origin: longest[0]!, allowedOrigins: longest }))).toBe("created");
  });
  it("hosts with wildcard or list characters are a 422 through the real route and are never stored", async () => {
    const t = await start();
    for (const origin of ["https://*.example.com", "https://a,b.example.com", "https://a.com,evil.com"]) {
      const res = await t.call("POST", "/api/admin/applications", "maintainer", referenceConfig({ origin, allowedOrigins: [origin] }));
      expect([origin, res.status]).toEqual([origin, 422]);
      expect(res.raw).not.toContain("evil");
    }
    expect(await t.applications.list(t.tenant)).toEqual([]);
  });
});

describe("the executors' application checks are enforced by the executor itself (DB-backed; the foreign key and the routes are second locks)", () => {
  const wt = () => `wt-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
  it("a Gateway save naming an unknown, another tenant's or a DISABLED application is ALLOWED + try_later and NEVER reaches the walkthrough store", async () => {
    const a = await start(); const b = await start();
    const appId = await a.createApplication();
    const disabled = await a.createApplication(referenceConfig({ name: "Disabled" }));
    await a.call("POST", `/api/admin/applications/${disabled}/status`, "maintainer", { enabled: false });
    for (const [t, applicationId] of [[a, "app-ffffffffffff"], [b, appId], [a, disabled]] as const) {
      const id = wt();
      expect(await t.submit("saveWalkthroughDraft", { expectedRevision: 0, walkthroughId: id, applicationId, definition: { ...profileDef(), id } }), applicationId).toEqual({ outcome: "ALLOWED", category: "try_later" });
      expect(await t.store.get(t.tenant, id)).toBeNull();
    }
    expect(a.saveDraft).not.toHaveBeenCalled();
    expect(b.saveDraft).not.toHaveBeenCalled();
    // The positive control: the same call for an enabled application of the caller's own tenant does reach the store.
    const id = wt();
    expect(await a.submit("saveWalkthroughDraft", { expectedRevision: 0, walkthroughId: id, applicationId: appId, definition: { ...profileDef(), id } })).toEqual({ outcome: "ALLOWED", category: "ok" });
    expect(a.saveDraft).toHaveBeenCalledOnce();
  });
  it("publish re-checks, inside the transaction, that the guide still belongs to the application the executor resolved: a legacy guide that takes an application between the executor's read and the lock is NOT published", async () => {
    const x = { applicationId: "" };
    const t = await start({ wrapStore: (real) => ({ ...real, get: async (tenantId, id) => {
      const found = await real.get(tenantId, id);
      // Right after the executor's read of the (legacy, unbound) guide, another request assigns it an application whose registry is the same, so the definition would still validate.
      if (x.applicationId !== "" && found !== null && found.applicationId === null) await real.saveDraft({ tenantId, actor: "other" }, id, { ...(found.definition as object) } as never, x.applicationId, undefined, found.revision);
      return found;
    } }) });
    x.applicationId = "";
    const legacy = wt();
    const definition = { ...profileDef(), id: legacy };
    await withTenant(t.pool, t.tenant, (c) => c.query("INSERT INTO public.walkthrough_definitions (tenant_id, walkthrough_id, status, definition, created_by, updated_by) VALUES ($1::uuid,$2,'draft',$3::jsonb,'old','old')", [t.tenant, legacy, JSON.stringify(definition)]));
    const appId = await t.createApplication();
    x.applicationId = appId;
    expect(await t.submit("setWalkthroughStatus", { walkthroughId: legacy, status: "published" })).toEqual({ outcome: "ALLOWED", category: "try_later" });
    expect(await t.realStore.get(t.tenant, legacy)).toMatchObject({ status: "draft", applicationId: appId });
    // Control: without the interleaved assignment the same guide publishes (as the reference application's legacy guide).
    x.applicationId = "";
    expect(await t.submit("setWalkthroughStatus", { walkthroughId: legacy, status: "published" })).toEqual({ outcome: "ALLOWED", category: "ok" });
  });
});
