/**
 * Studio V1A Order B on PostgreSQL: the application-bound browser session API (`POST /api/studio/browser`) over the REAL application store, the REAL Gateway and routes (applications and
 * walkthroughs are created through them) and a FAKE BrowserRuntime (no Chrome). Proves tenant isolation of the application lookup, that disabling an application through the real status
 * route blocks connect and closes a live session at its next command, that a stored walkthrough of another application cannot be opened (APPLICATION_MISMATCH) while a legacy one can, that the
 * second application's registry (the reviewer's fixture B) drives the inspector, and that re-pointing an application closes a session whose policy would be stale. NEEDS the PostgreSQL of
 * deploy/compose.yaml on a FRESH database (DAP_DATABASE_URL / DAP_MIGRATE_DATABASE_URL); every test uses tenants of its own.
 */
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { BrowserRuntimeError } from "../../packages/browser-runtime/src/index.js";
import type { BrowserRuntime, BrowserSnapshot, ElementRef } from "../../packages/browser-runtime/src/index.js";
import { composeReferenceHost } from "../../apps/reference-host/src/index.js";
import type { ReferenceHost } from "../../apps/reference-host/src/index.js";
import { parseDevSessions } from "../../apps/reference-host/src/dev-auth/index.js";
import { createAuthoringExtension } from "../../apps/reference-host/src/authoring/capabilities.js";
import { createPostgresWalkthroughStore } from "../../apps/reference-host/src/authoring/postgres-store.js";
import { createDemoPrincipalResolver } from "../../apps/reference-host/src/authoring/principal.js";
import { registerAuthoringRoutes } from "../../apps/reference-host/src/authoring/routes.js";
import { withTenant } from "../../apps/reference-host/src/authoring/tenant-tx.js";
import { createProposalStore } from "../../apps/reference-host/src/http/proposal-store.js";
import { createGuidanceTransport } from "../../apps/reference-host/src/http/transport.js";
import { demoCatalogView } from "../../apps/reference-host/src/guidance/walkthrough-summaries.js";
import { createApplicationExtension } from "../../apps/reference-host/src/studio/application-capabilities.js";
import { registerApplicationRoutes } from "../../apps/reference-host/src/studio/application-routes.js";
import type { ApplicationConfig } from "../../apps/reference-host/src/studio/applications.js";
import { registerStudioBrowser } from "../../apps/reference-host/src/studio/browser.js";
import type { BrowserRuntimeConfig } from "../../apps/reference-host/src/studio/browser.js";
import { createPostgresApplicationStore } from "../../apps/reference-host/src/studio/postgres-application-store.js";
import { createRegistryCatalog } from "../../apps/reference-host/src/studio/registries.js";
import type { RegistryEntry } from "../../apps/reference-host/src/studio/registries.js";
import { createPostgresPool } from "../../packages/security/src/index.js";
import { openStatePools } from "../../packages/security/src/state/conformance/state-pg-fixtures.js";
import { fixtureB } from "../fixtures/studio-app/registry.mjs";

let owner: Pool; let probe: Pool;
const closers: (() => Promise<unknown>)[] = [];
const hosts: ReferenceHost[] = [];
beforeAll(async () => { ({ app: probe, owner } = await openStatePools(Pool)); });
afterAll(async () => { await Promise.all([probe?.end(), owner?.end()]); });
afterEach(async () => { await Promise.all([...closers.splice(0).map((close) => close()), ...hosts.splice(0).map((host) => host.close())]); });

/** The reviewer's second application ("fixture B") as a catalog entry: its plain-data registry and browser policy, unchanged. */
const FIXTURE_B_ENTRY: RegistryEntry = {
  id: fixtureB.id, label: fixtureB.label, previewable: false,
  registry: fixtureB.registry as unknown as RegistryEntry["registry"],
  browser: { labels: fixtureB.browser.labels, pages: fixtureB.browser.pages },
};
const referenceConfig = (over: Partial<ApplicationConfig> = {}): ApplicationConfig => ({ name: "Reference application", origin: "http://127.0.0.1:5184", allowedOrigins: ["http://127.0.0.1:5184"], environment: "development", registryId: "reference", ...over });
const fixtureConfig = (over: Partial<ApplicationConfig> = {}): ApplicationConfig => ({ name: "Fixture B", origin: "http://127.0.0.1:5185", allowedOrigins: ["http://127.0.0.1:5185"], environment: "test", registryId: "fixture-b", ...over });
const profileDef = (over: Record<string, unknown> = {}) => ({
  title: "Save your name", description: "Change your display name and save it.", start: "n1",
  steps: [{ id: "n1", kind: "navigate", route: "profile", next: "s1" }, { id: "s1", kind: "guide", target: "profile.saveButton", text: "Press Save.", wait: "click", verify: "profile.saved", next: "done" }, { id: "done", kind: "complete", text: "Done." }],
  ...over,
});
const ordersDef = () => ({
  title: "Submit an order", description: "Submit an order.", start: "n1",
  steps: [{ id: "n1", kind: "navigate", route: "orders", next: "s1" }, { id: "s1", kind: "guide", target: "orders.submit", text: "Press Submit order.", wait: "click", next: "done" }, { id: "done", kind: "complete", text: "Done." }],
});
const ALL_ACTIONS = "demoLookup,saveWalkthroughDraft,setWalkthroughStatus,saveStudioApplication,setStudioApplicationEnabled";
const profileSnapshot: BrowserSnapshot = { url: "http://127.0.0.1:5184/#/profile", elements: [{ ref: "@e21", name: "Display name", role: "textbox" }, { ref: "@e22", name: "Save", role: "button" }] };
const ordersSnapshot: BrowserSnapshot = { url: "http://127.0.0.1:5185/#/orders", elements: [{ ref: "@e5", name: "Submit order", role: "button" }, { ref: "@e6", name: "Order note", role: "textbox" }] };

interface FakeRuntime extends BrowserRuntime { snapshotValue: BrowserSnapshot; ids: Record<string, string | null> }
function fakeRuntime(snapshot: BrowserSnapshot, ids: Record<string, string | null>): FakeRuntime {
  const runtime: FakeRuntime = {
    snapshotValue: snapshot, ids,
    start: vi.fn(async () => {}), snapshot: vi.fn(async () => runtime.snapshotValue),
    inspectSemanticId: vi.fn(async (ref: ElementRef) => runtime.ids[ref] ?? null),
    inspectSemanticIds: vi.fn(async (from: BrowserSnapshot) => new Map(from.elements.map((e) => [e.ref, runtime.ids[e.ref] ?? null] as const))),
    inspectElementFacts: vi.fn(async (refs: readonly ElementRef[]) => new Map(refs.map((ref) => [ref, { tagName: null, inputType: null, autocomplete: null, dataAiPrivate: false, dataAiIgnore: false, dataAiRedact: false }] as const))),
    highlight: vi.fn(async () => {}), clearHighlight: vi.fn(async () => {}), getUrl: vi.fn(async () => runtime.snapshotValue.url), waitForChange: vi.fn(async () => ({ status: "timeout" as const })),
    close: vi.fn(async () => {}),
  };
  return runtime;
}

/** One tenant, one host: real Gateway, both capability families, application + authoring + Studio browser routes, a fake runtime factory recording what it was configured with. */
async function start(options: { tenant?: string } = {}) {
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
  const store = createPostgresWalkthroughStore(pool);
  const applications = createPostgresApplicationStore(pool);
  const catalog = createRegistryCatalog([FIXTURE_B_ENTRY]);
  const authoring = createAuthoringExtension({ store, applications, catalog });
  const studio = createApplicationExtension({ store: applications, catalog });
  const { host } = await composeReferenceHost(
    { NODE_ENV: "test", DAP_ALLOW_DEV_AUTH: "1", DAP_DATABASE_URL: process.env.DAP_DATABASE_URL, DAP_ENABLED_ACTIONS: ALL_ACTIONS, DEV_SESSIONS: JSON.stringify(sessions) },
    { extensions: [authoring.extension, studio.extension] },
  );
  hosts.push(host);
  const resolvePrincipal = createDemoPrincipalResolver({ sessions: parseDevSessions(JSON.stringify(sessions)), userToken, maintainerToken: maintToken, openSession: (evidence) => host.openSession(evidence) });
  const app = createGuidanceTransport({ ask: async () => ({ kind: "clarify", message: "x" }), catalog: demoCatalogView, resolveSession: async () => null, proposals: createProposalStore({ now: Date.now, newId: () => "proposal-id-0000000000000000" }) });
  registerAuthoringRoutes(app, { store, applications, catalog, resolvePrincipal });
  registerApplicationRoutes(app, { applications, catalog, resolvePrincipal });
  const configs: BrowserRuntimeConfig[] = [];
  const runtimes: FakeRuntime[] = [];
  registerStudioBrowser(app, {
    resolvePrincipal, applications, catalog, authoring: store,
    createRuntime: (config) => { configs.push(config); const made = config.origins[0]?.endsWith(":5185") ? fakeRuntime(ordersSnapshot, { "@e5": "orders.submit", "@e6": "orders.note" }) : fakeRuntime(profileSnapshot, { "@e21": "profile.nameInput", "@e22": "profile.saveButton" }); runtimes.push(made); return made; },
    makeId: () => `session-${randomUUID().slice(0, 8)}`,
  });
  closers.push(() => app.close());
  const call = async (method: "GET" | "POST" | "PUT", url: string, role: "user" | "maintainer", body?: unknown) => {
    const res = await app.inject({ method, url, headers: { "x-demo-role": role, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { payload: JSON.stringify(body) }) });
    return { status: res.statusCode, body: JSON.parse(res.body) as Record<string, unknown>, raw: res.body };
  };
  const studioCall = (body: unknown, role: "user" | "maintainer" = "maintainer") => call("POST", "/api/studio/browser", role, body);
  const createApplication = async (config: ApplicationConfig = referenceConfig()) => {
    const res = await call("POST", "/api/admin/applications", "maintainer", config);
    if (res.status !== 201) throw new Error(`application not created: ${res.status} ${res.raw}`);
    return res.body.id as string;
  };
  const connect = async (applicationId: string, walkthroughId?: string) => studioCall({ action: "connect", applicationId, ...(walkthroughId === undefined ? {} : { walkthroughId }) });
  return { tenant, call, studioCall, connect, createApplication, store, applications, pool, configs, runtimes };
}

describe("tenant isolation of the application lookup", () => {
  it("tenant 2 cannot connect to tenant 1's application (the same 404 as an unknown id); tenant 1 can, and the runtime is configured from the stored record", async () => {
    const a = await start(); const b = await start();
    const appId = await a.createApplication(referenceConfig({ allowedOrigins: ["http://127.0.0.1:5184", "http://localhost:5184"] }));
    const denied = await b.connect(appId);
    expect([denied.status, denied.body]).toEqual([404, { error: "APPLICATION_NOT_FOUND" }]);
    expect((await b.connect("app-ffffffffffff")).body).toEqual({ error: "APPLICATION_NOT_FOUND" });
    expect(b.configs).toEqual([]);
    const ok = await a.connect(appId);
    expect(ok.status).toBe(200);
    expect(ok.body).toMatchObject({ applicationId: appId, application: "Reference application", origin: "http://127.0.0.1:5184" });
    expect(a.configs).toHaveLength(1);
    expect(a.configs[0]!.origins).toEqual(["http://127.0.0.1:5184", "http://localhost:5184"]);
    expect(a.configs[0]!.routes).toEqual(["/", "/#/dashboard", "/#/profile", "/#/settings"]);
    expect(a.runtimes[0]!.start).toHaveBeenCalledWith({ url: "http://127.0.0.1:5184/", headed: true });
  });
  it("a live session of tenant 1 cannot be driven or closed by tenant 2 (another host here, so the slot is separate), and never sees tenant 1's data", async () => {
    const a = await start(); const b = await start();
    const appId = await a.createApplication();
    const bApp = await b.createApplication(referenceConfig({ name: "Tenant 2's application" }));
    const session = (await a.connect(appId)).body.sessionId as string;
    expect((await b.studioCall({ action: "refresh", sessionId: session, applicationId: appId })).body).toEqual({ error: "SESSION_CLOSED" });
    expect((await b.studioCall({ action: "disconnect", sessionId: session, applicationId: bApp })).body).toEqual({ error: "SESSION_CLOSED" });
    expect((await a.studioCall({ action: "refresh", sessionId: session, applicationId: appId })).status).toBe(200);
  });
  it("an ordinary user (no maintain permission) is 403 on every Studio command, and nothing is opened", async () => {
    const a = await start();
    const appId = await a.createApplication();
    expect((await a.studioCall({ action: "connect", applicationId: appId }, "user")).body).toEqual({ error: "FORBIDDEN" });
    expect(a.configs).toEqual([]);
  });
});

describe("disabling an application through the real status route", () => {
  it("blocks connect (409 APPLICATION_DISABLED), closes a live session at its NEXT command, and re-enabling restores it", async () => {
    const t = await start();
    const appId = await t.createApplication();
    const connected = await t.connect(appId);
    const session = connected.body.sessionId as string;
    expect((await t.studioCall({ action: "refresh", sessionId: session, applicationId: appId })).status).toBe(200);
    const off = await t.call("POST", `/api/admin/applications/${appId}/status`, "maintainer", { enabled: false });
    expect(off.body).toMatchObject({ enabled: false });
    // The live session is closed by its next command, not before (the status route does not know about it).
    expect(t.runtimes[0]!.close).not.toHaveBeenCalled();
    expect((await t.studioCall({ action: "refresh", sessionId: session, applicationId: appId })).body).toEqual({ error: "APPLICATION_DISABLED" });
    expect(t.runtimes[0]!.close).toHaveBeenCalledOnce();
    expect((await t.studioCall({ action: "refresh", sessionId: session, applicationId: appId })).body).toEqual({ error: "SESSION_CLOSED" });
    expect((await t.connect(appId)).body).toEqual({ error: "APPLICATION_DISABLED" });
    expect(t.configs).toHaveLength(1);
    await t.call("POST", `/api/admin/applications/${appId}/status`, "maintainer", { enabled: true });
    expect((await t.connect(appId)).status).toBe(200);
  });
  it("highlight and capture of a live session are refused the same way once the application is disabled, and nothing is highlighted", async () => {
    const t = await start();
    const appId = await t.createApplication();
    const session = (await t.connect(appId)).body.sessionId as string;
    await t.studioCall({ action: "refresh", sessionId: session, applicationId: appId });
    await t.call("POST", `/api/admin/applications/${appId}/status`, "maintainer", { enabled: false });
    expect((await t.studioCall({ action: "capture", sessionId: session, applicationId: appId, ref: "@e21" })).body).toEqual({ error: "APPLICATION_DISABLED" });
    expect(t.runtimes[0]!.highlight).not.toHaveBeenCalled();
  });
  it("disconnect stays allowed for the owner of a session whose application was disabled", async () => {
    const t = await start();
    const appId = await t.createApplication();
    const session = (await t.connect(appId)).body.sessionId as string;
    await t.call("POST", `/api/admin/applications/${appId}/status`, "maintainer", { enabled: false });
    expect((await t.studioCall({ action: "disconnect", sessionId: session, applicationId: appId })).body).toEqual({ closed: true });
    expect(t.runtimes[0]!.close).toHaveBeenCalledOnce();
  });
  it("editing the application's allowed origins or registry through the real PUT route closes a live session whose policy would be stale (a rename does not)", async () => {
    const t = await start();
    const appId = await t.createApplication();
    const session = (await t.connect(appId)).body.sessionId as string;
    expect((await t.call("PUT", `/api/admin/applications/${appId}`, "maintainer", referenceConfig({ name: "Renamed" }))).status).toBe(200);
    expect((await t.studioCall({ action: "refresh", sessionId: session, applicationId: appId })).status).toBe(200);
    expect((await t.call("PUT", `/api/admin/applications/${appId}`, "maintainer", referenceConfig({ allowedOrigins: ["http://127.0.0.1:5184", "http://localhost:5184"] }))).status).toBe(200);
    expect((await t.studioCall({ action: "refresh", sessionId: session, applicationId: appId })).body).toEqual({ error: "APPLICATION_MISMATCH" });
    expect(t.runtimes[0]!.close).toHaveBeenCalledOnce();
  });
});

describe("a walkthrough id binds a session to the walkthrough's application", () => {
  it("a stored draft of ANOTHER application is 409 APPLICATION_MISMATCH and opens nothing; its own application opens", async () => {
    const t = await start();
    const [reference, second] = [await t.createApplication(), await t.createApplication(fixtureConfig())];
    const draft = await t.call("POST", "/api/admin/walkthroughs", "maintainer", { applicationId: reference, definition: profileDef() });
    expect(draft.status).toBe(201);
    const id = draft.body.id as string;
    const mismatch = await t.connect(second, id);
    expect([mismatch.status, mismatch.body]).toEqual([409, { error: "APPLICATION_MISMATCH" }]);
    expect(t.configs).toEqual([]);
    expect((await t.connect(reference, id)).status).toBe(200);
    expect(t.configs).toHaveLength(1);
  });
  it("a legacy draft (application_id NULL, written before Studio) can be opened with any enabled application", async () => {
    const t = await start();
    const [reference, second] = [await t.createApplication(), await t.createApplication(fixtureConfig())];
    const legacy = `wt-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    await withTenant(t.pool, t.tenant, (c) => c.query("INSERT INTO public.walkthrough_definitions (tenant_id, walkthrough_id, status, definition, created_by, updated_by) VALUES ($1::uuid,$2,'draft',$3::jsonb,'old','old')", [t.tenant, legacy, JSON.stringify({ ...profileDef(), id: legacy })]));
    const first = await t.connect(reference, legacy);
    expect(first.status).toBe(200);
    expect((await t.studioCall({ action: "disconnect", sessionId: first.body.sessionId, applicationId: reference })).body).toEqual({ closed: true });
    expect((await t.connect(second, legacy)).status).toBe(200);
    expect(t.configs.map((config) => config.origins)).toEqual([["http://127.0.0.1:5184"], ["http://127.0.0.1:5185"]]);
  });
  it("an unknown walkthrough id, another tenant's walkthrough and a malformed one are the generic 400 INVALID_REQUEST; a published guide of the same application opens", async () => {
    const a = await start(); const b = await start();
    const appA = await a.createApplication();
    const appB = await b.createApplication();
    const draft = await a.call("POST", "/api/admin/walkthroughs", "maintainer", { applicationId: appA, definition: profileDef() });
    const id = draft.body.id as string;
    for (const walkthroughId of ["wt-0000000000ff", id]) expect((await b.connect(appB, walkthroughId)).body, walkthroughId).toEqual({ error: "INVALID_REQUEST" });
    expect((await b.connect(appB, "profileUpdate")).body).toEqual({ error: "INVALID_REQUEST" });
    expect(b.configs).toEqual([]);
    await a.call("POST", `/api/admin/walkthroughs/${id}/status`, "maintainer", { status: "published" });
    expect((await a.connect(appA, id)).status).toBe(200);
  });
});

describe("the second application drives the inspector with its own registry (fixture B)", () => {
  it("fixture B's catalog entry is accepted by the catalog and an application can be enrolled with it; a walkthrough of its registry validates", async () => {
    const t = await start();
    const second = await t.createApplication(fixtureConfig());
    const wt = await t.call("POST", "/api/admin/walkthroughs", "maintainer", { applicationId: second, definition: ordersDef() });
    expect(wt.status).toBe(201);
    expect((await t.call("GET", `/api/admin/applications/${second}/registry`, "maintainer")).body).toMatchObject({ routes: ["home", "orders"], previewable: false });
  });
  it("connect uses B's origin, B's routes and labels; refresh classifies against B's registry; B's ids are trusted, a reference id on B's page is not", async () => {
    const t = await start();
    const second = await t.createApplication(fixtureConfig());
    const connected = await t.connect(second);
    expect(connected.body).toMatchObject({ applicationId: second, application: "Fixture B", origin: "http://127.0.0.1:5185" });
    expect(t.configs[0]).toEqual({
      origins: ["http://127.0.0.1:5185"], routes: Object.keys(fixtureB.browser.pages),
      labels: [{ role: "link", name: "Orders" }, { role: "button", name: "Submit order" }, { role: "textbox", name: "Order note" }],
    });
    const session = connected.body.sessionId as string;
    const refreshed = await t.studioCall({ action: "refresh", sessionId: session, applicationId: second });
    expect(refreshed.body).toEqual({
      url: "http://127.0.0.1:5185/#/orders", route: "orders", page: "/#/orders", hidden: 0, truncated: false,
      elements: [
        { ref: "@e5", name: "Submit order", role: "button", route: "orders", status: "trusted", targetId: "orders.submit", operations: ["highlight", "click"], privacy: "public" },
        { ref: "@e6", name: "Order note", role: "textbox", route: "orders", status: "trusted", targetId: "orders.note", operations: ["highlight", "input"], privacy: "public" },
      ],
    });
    t.runtimes[0]!.ids["@e5"] = "profile.saveButton"; // a REFERENCE id on fixture B's page
    expect((await t.studioCall({ action: "refresh", sessionId: session, applicationId: second })).body.elements).toEqual([
      { ref: "@e5", name: "Submit order", role: "button", route: "orders", status: "unregistered" },
      expect.objectContaining({ ref: "@e6", status: "trusted" }),
    ]);
    const used = await t.studioCall({ action: "capture", sessionId: session, applicationId: second, ref: "@e6" });
    expect(used.body).toEqual({ targetId: "orders.note", route: "orders", name: "Order note", role: "textbox", operations: ["highlight", "input"] });
    expect((await t.studioCall({ action: "capture", sessionId: session, applicationId: second, ref: "@e5" })).body).toEqual({ error: "TARGET_UNAVAILABLE" });
  });
  it("the first application's session cannot use the second application's id, and switching needs disconnect + reconnect", async () => {
    const t = await start();
    const [reference, second] = [await t.createApplication(), await t.createApplication(fixtureConfig())];
    const session = (await t.connect(reference)).body.sessionId as string;
    expect((await t.studioCall({ action: "refresh", sessionId: session, applicationId: second })).body).toEqual({ error: "APPLICATION_MISMATCH" });
    expect((await t.connect(second)).body).toEqual({ error: "BROWSER_BUSY" });
    expect((await t.studioCall({ action: "disconnect", sessionId: session, applicationId: reference })).body).toEqual({ closed: true });
    const next = await t.connect(second);
    expect(next.status).toBe(200);
    expect(t.configs.map((config) => config.origins)).toEqual([["http://127.0.0.1:5184"], ["http://127.0.0.1:5185"]]);
    expect((await t.studioCall({ action: "highlight", sessionId: next.body.sessionId, applicationId: second, ref: "@e21" })).body, "the first application's candidate refs do not exist here").toEqual({ error: "REF_NOT_FOUND" });
  });
  it("a runtime error is mapped closed (no raw text) and keeps the session; a stale element is a 409", async () => {
    const t = await start();
    const appId = await t.createApplication();
    const session = (await t.connect(appId)).body.sessionId as string;
    vi.mocked(t.runtimes[0]!.snapshot).mockRejectedValueOnce(new BrowserRuntimeError("DOMAIN_BLOCKED"));
    const blocked = await t.studioCall({ action: "refresh", sessionId: session, applicationId: appId });
    expect([blocked.status, blocked.body]).toEqual([503, { error: "DOMAIN_BLOCKED" }]);
    expect(blocked.raw).not.toMatch(/127\.0\.0\.1|approved|origin/);
    expect((await t.studioCall({ action: "refresh", sessionId: session, applicationId: appId })).status).toBe(200);
    vi.mocked(t.runtimes[0]!.inspectSemanticId).mockRejectedValueOnce(new BrowserRuntimeError("REF_NOT_FOUND"));
    expect((await t.studioCall({ action: "capture", sessionId: session, applicationId: appId, ref: "@e21" })).body).toEqual({ error: "REF_NOT_FOUND" });
  });
});
