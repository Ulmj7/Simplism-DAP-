/**
 * Studio V1B end to end on PostgreSQL: a Studio-managed application is enrolled, a maintainer connects the Studio browser (a SCRIPTED fake runtime, no Chrome), refreshes, registers targets from the
 * live pages THROUGH THE REAL HTTP ROUTES (`POST /api/studio/browser`, the only way a target is created) and the REAL Gateway/executor/PostgreSQL stores; then reads the registry, writes a workflow,
 * publishes it, reads it as external metadata and as a bundle, disables and re-enables a target, and checks that the built-in reference application, a second tenant and `@e` refs are untouched.
 * NEEDS the PostgreSQL of deploy/compose.yaml on a FRESH database; every test uses tenants of its own.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { BrowserRuntimeError } from "../../packages/browser-runtime/src/index.js";
import type { BrowserRuntime, BrowserSnapshot, ElementFacts, ElementRef } from "../../packages/browser-runtime/src/index.js";
import type { ReferenceHost } from "../../apps/reference-host/src/index.js";
import { registerStudioBrowser } from "../../apps/reference-host/src/studio/browser.js";
import type { BrowserRuntimeConfig } from "../../apps/reference-host/src/studio/browser.js";
import { openStatePools } from "../../packages/security/src/state/conformance/state-pg-fixtures.js";
import { managedConfig, managedDef, referenceConfig, startHost } from "./studio-registry.support.js";

let owner: Pool; let probe: Pool;
const closers: (() => Promise<unknown>)[] = [];
const hosts: ReferenceHost[] = [];
beforeAll(async () => { ({ app: probe, owner } = await openStatePools(Pool)); });
afterAll(async () => { await Promise.all([probe?.end(), owner?.end()]); });
afterEach(async () => { await Promise.all([...closers.splice(0).map((close) => close()), ...hosts.splice(0).map((host) => host.close())]); });

const ORIGIN = "http://127.0.0.1:5187";
const PUBLIC: ElementFacts = { tagName: null, inputType: null, autocomplete: null, dataAiPrivate: false, dataAiIgnore: false, dataAiRedact: false };
interface Control { name: string; role: string; id: string | null; facts: ElementFacts | null }
const control = (name: string, role: string, id: string | null, facts: ElementFacts | null = PUBLIC): Control => ({ name, role, id, facts });

/** The page the scripted browser shows: `/#/orders` and `/#/profile` of the managed application. */
const PAGES: Record<string, Control[]> = {
  "/#/orders": [control("Submit order", "button", "orders.submitButton"), control("Order note", "textbox", "orders.note"), control("Card number", "textbox", "orders.card"), control("Reveal", "button", "dap.internal")],
  "/#/profile": [control("Save", "button", "profile.saveButton"), control("Newsletter", "checkbox", null)],
};
interface Scripted extends BrowserRuntime { url: string }
function scripted(): Scripted {
  const controls = (): Control[] => PAGES[new URL(runtime.url).hash === "" ? "/" : `/${new URL(runtime.url).hash}`] ?? [];
  const runtime: Scripted = {
    url: `${ORIGIN}/#/orders`,
    start: vi.fn(async () => {}),
    snapshot: vi.fn(async (): Promise<BrowserSnapshot> => ({ url: runtime.url, elements: controls().map((c, i) => ({ ref: `@e${i + 1}` as ElementRef, name: c.name, role: c.role })) })),
    inspectSemanticId: vi.fn(async (ref: ElementRef, from: BrowserSnapshot) => {
      const control = controls()[Number(ref.slice(2)) - 1];
      if (from.url !== runtime.url || control === undefined) throw new BrowserRuntimeError("REF_NOT_FOUND");
      return control.id;
    }),
    inspectSemanticIds: vi.fn(async (from: BrowserSnapshot) => new Map(from.elements.map((e) => [e.ref, controls()[Number(e.ref.slice(2)) - 1]?.id ?? null] as const))),
    inspectElementFacts: vi.fn(async (refs: readonly ElementRef[]) => new Map(refs.map((ref) => [ref, controls()[Number(ref.slice(2)) - 1]?.facts ?? null] as const))),
    highlight: vi.fn(async () => {}), clearHighlight: vi.fn(async () => {}), getUrl: vi.fn(async () => runtime.url), waitForChange: vi.fn(async () => ({ status: "timeout" as const })),
    close: vi.fn(async () => {}),
  };
  return runtime;
}

async function start(options: Parameters<typeof startHost>[3] = {}) {
  const t = await startHost(closers, hosts, owner, options);
  const runtimes: Scripted[] = [];
  const configs: BrowserRuntimeConfig[] = [];
  let n = 0;
  registerStudioBrowser(t.app, {
    resolvePrincipal: t.resolvePrincipal, applications: t.applications, catalog: t.catalog, authoring: t.store, targets: t.targets, resolver: t.resolver,
    createRuntime: (config) => { configs.push(config); const made = scripted(); runtimes.push(made); return made; },
    makeId: () => `session-${(n += 1)}`,
  });
  const studio = (body: unknown, role: "user" | "maintainer" = "maintainer") => t.call("POST", "/api/studio/browser", role, body);
  return { ...t, studio, runtimes, configs };
}
type T = Awaited<ReturnType<typeof start>>;

const registerBody = (session: string, applicationId: string, over: Record<string, unknown>) => ({
  action: "register", sessionId: session, applicationId, ref: "@e1", targetId: "orders.submitButton", route: "orders", operations: ["highlight", "click"], label: "Submit order", description: "Submits the order.", privacy: "public", ...over,
});
const OK = 200;

/** Connect, refresh and register the three targets of the story on two pages through the real routes. */
async function registerStory(t: T, appId: string): Promise<string> {
  const connected = await t.studio({ action: "connect", applicationId: appId });
  expect(connected).toMatchObject({ status: OK, body: { registrySource: "studio-managed", applicationId: appId } });
  const session = connected.body.sessionId as string;
  const runtime = t.runtimes[0]!;
  const first = await t.studio({ action: "refresh", sessionId: session, applicationId: appId });
  expect(first.body).toMatchObject({ route: null, page: "/#/orders", hidden: 2, truncated: false });
  expect((first.body.elements as { name: string; status: string }[]).map((e) => [e.name, e.status])).toEqual([["Submit order", "registrable"], ["Order note", "registrable"]]);
  const a = await t.studio(registerBody(session, appId, {}));
  expect(a).toMatchObject({ status: OK, body: { route: { route: "orders", page: "/#/orders", created: true }, target: { id: "orders.submitButton", status: "active" } } });
  const b = await t.studio(registerBody(session, appId, { ref: "@e2", targetId: "orders.note", operations: ["highlight", "input"], label: "Order note", description: "The note field." }));
  expect(b.body).toMatchObject({ route: { route: "orders", page: "/#/orders", created: false } });
  runtime.url = `${ORIGIN}/#/profile`;
  await t.studio({ action: "refresh", sessionId: session, applicationId: appId });
  const c = await t.studio(registerBody(session, appId, { targetId: "profile.saveButton", route: "profile", label: "Save", description: "Saves the profile." }));
  expect(c.body).toMatchObject({ route: { route: "profile", page: "/#/profile", created: true } });
  return session;
}

describe("a managed application end to end through the real routes", () => {
  it("connect -> refresh -> register three targets on two pages -> registry -> workflow -> publish -> external + bundle -> disable one target -> drops -> re-enable restores", async () => {
    const t = await start();
    const appId = await t.createApplication(managedConfig());
    const session = await registerStory(t, appId);
    expect(t.configs).toEqual([{ labels: "all", routes: "any", origins: [ORIGIN] }]);

    const targets = await t.call("GET", `/api/admin/applications/${appId}/targets`, "maintainer");
    expect(targets.status).toBe(200);
    expect((targets.body.targets as { id: string; route: string; page: string; role: string; status: string }[]).map((x) => [x.id, x.route, x.page, x.role, x.status])).toEqual([
      ["orders.submitButton", "orders", "/#/orders", "button", "active"], ["orders.note", "orders", "/#/orders", "textbox", "active"], ["profile.saveButton", "profile", "/#/profile", "button", "active"],
    ]);
    expect(targets.body.routes).toEqual([{ route: "orders", page: "/#/orders" }, { route: "profile", page: "/#/profile" }]);
    const registry = await t.call("GET", `/api/admin/applications/${appId}/registry`, "maintainer");
    expect(registry.body).toMatchObject({ routes: ["orders", "profile"], postconditionNames: ["route.orders", "route.profile"] });
    expect((registry.body.elements as { id: string }[]).map((e) => e.id)).toEqual(["orders.submitButton", "orders.note", "profile.saveButton"]);

    // The browser now shows the registered controls as trusted, on a fresh refresh (the registry is read on every command).
    t.runtimes[0]!.url = `${ORIGIN}/#/orders`;
    const trusted = await t.studio({ action: "refresh", sessionId: session, applicationId: appId });
    expect(trusted.body).toMatchObject({ route: "orders", page: "/#/orders" });
    expect((trusted.body.elements as { name: string; status: string }[]).map((e) => [e.name, e.status])).toEqual([["Submit order", "trusted"], ["Order note", "trusted"]]);
    expect((await t.studio({ action: "capture", sessionId: session, applicationId: appId, ref: "@e1" })).body).toEqual({ targetId: "orders.submitButton", route: "orders", name: "Submit order", role: "button", operations: ["highlight", "click"] });

    const live = await t.createWorkflow(appId, managedDef());
    const draft = await t.createWorkflow(appId, managedDef(undefined, undefined, { title: "A draft" }));
    expect(live.res.status).toBe(201);
    expect((await t.call("POST", `/api/admin/walkthroughs/${live.id}/status`, "maintainer", { status: "published" })).status).toBe(200);
    const external = async () => ((await t.call("GET", "/api/walkthroughs/published", "user")).body.external as { id: string }[]).map((g) => g.id);
    expect(await external()).toEqual([live.id]);
    const bundle = await t.call("GET", `/api/walkthroughs/published/${live.id}/bundle`, "user");
    expect(bundle.status).toBe(200);
    expect((bundle.body.registry as { elements: { id: string }[]; pages: Record<string, string> }).elements.map((e) => e.id)).toEqual(["orders.submitButton", "orders.note", "profile.saveButton"]);
    expect((bundle.body.registry as { pages: Record<string, string> }).pages).toEqual({ "/#/orders": "orders", "/#/profile": "profile" });

    // Disabling a target removes it from every registry a validator or a player sees ...
    expect((await t.call("POST", `/api/admin/applications/${appId}/targets/orders.submitButton/status`, "maintainer", { status: "disabled" })).status).toBe(200);
    expect(await external()).toEqual([]);
    expect((await t.call("GET", `/api/walkthroughs/published/${live.id}/bundle`, "user")).status).toBe(404);
    expect((await t.call("PUT", `/api/admin/walkthroughs/${draft.id}`, "maintainer", { applicationId: appId, definition: managedDef() })).status).toBe(422);
    expect((await t.call("POST", `/api/admin/walkthroughs/${draft.id}/status`, "maintainer", { status: "published" })).status).toBe(422);
    // ... and the open browser session sees it disabled at once, with no reconnect.
    const shown = await t.studio({ action: "refresh", sessionId: session, applicationId: appId });
    expect((shown.body.elements as { name: string; status: string }[]).map((e) => [e.name, e.status])).toEqual([["Submit order", "disabled"], ["Order note", "trusted"]]);
    expect((await t.studio({ action: "highlight", sessionId: session, applicationId: appId, ref: "@e1" })).body).toEqual({ error: "TARGET_UNAVAILABLE" });
    // The same id cannot be registered again while it is disabled.
    expect((await t.studio(registerBody(session, appId, {}))).body).toEqual({ error: "TARGET_NOT_REGISTRABLE" });

    // Re-enabling restores everything.
    expect((await t.call("POST", `/api/admin/applications/${appId}/targets/orders.submitButton/status`, "maintainer", { status: "active" })).status).toBe(200);
    expect(await external()).toEqual([live.id]);
    expect((await t.call("GET", `/api/walkthroughs/published/${live.id}/bundle`, "user")).status).toBe(200);
    expect((await t.call("POST", `/api/admin/walkthroughs/${draft.id}/status`, "maintainer", { status: "published" })).status).toBe(200);
    expect((await t.studio({ action: "highlight", sessionId: session, applicationId: appId, ref: "@e1" })).body, "the candidate list is from the refresh while it was disabled").toEqual({ error: "TARGET_UNAVAILABLE" });
    await t.studio({ action: "refresh", sessionId: session, applicationId: appId });
    expect((await t.studio({ action: "highlight", sessionId: session, applicationId: appId, ref: "@e1" })).body).toEqual({ highlighted: true, ref: "@e1" });
  });

  it("nothing but the three public targets was stored: no @e ref in the registry, the audit trail or the capability trail; secrets, reserved ids and unmarked controls never appeared", async () => {
    const t = await start();
    const appId = await t.createApplication(managedConfig());
    await registerStory(t, appId);
    const listing = JSON.stringify((await t.targets.list(t.tenant, appId)));
    expect(listing).not.toMatch(/@e\d/u);
    for (const word of ["Card number", "orders.card", "dap.internal", "Reveal", "Newsletter"]) expect(listing, word).not.toContain(word);
    const audit = await t.rows();
    expect(JSON.stringify(audit)).not.toMatch(/@e\d/u);
    const trail = audit.filter((row) => row.action_id === "registerStudioTarget");
    expect(trail.filter((row) => row.event_type === "AI_ACTION_EXECUTED")).toHaveLength(3);
    expect(trail.filter((row) => row.event_type === "AI_ACTION_ALLOWED").map((row) => [row.risk, row.user_id, row.resource_id])).toEqual([["MEDIUM", "maya", appId], ["MEDIUM", "maya", appId], ["MEDIUM", "maya", appId]]);
    expect([...new Set(trail.map((row) => (row.params_view as Record<string, string> | null)?.["/targetId"]).filter((id) => id !== undefined))].sort()).toEqual(["orders.note", "orders.submitButton", "profile.saveButton"]);
  });

  it("the Gateway is the only door: with the capability switched off nothing registers and the browser says so without leaking; the registry stays empty", async () => {
    const t = await startHost(closers, hosts, owner, { enabled: "demoLookup,saveWalkthroughDraft,setWalkthroughStatus,saveStudioApplication,setStudioApplicationEnabled" });
    const runtime = scripted();
    registerStudioBrowser(t.app, { resolvePrincipal: t.resolvePrincipal, applications: t.applications, catalog: t.catalog, authoring: t.store, targets: t.targets, resolver: t.resolver, createRuntime: () => runtime, makeId: () => "session-1" });
    const appId = await t.createApplication(managedConfig());
    await t.call("POST", "/api/studio/browser", "maintainer", { action: "connect", applicationId: appId });
    await t.call("POST", "/api/studio/browser", "maintainer", { action: "refresh", sessionId: "session-1", applicationId: appId });
    const res = await t.call("POST", "/api/studio/browser", "maintainer", registerBody("session-1", appId, {}));
    expect([403, 503]).toContain(res.status);
    expect(res.raw).not.toMatch(/registerStudioTarget|DAP_ENABLED|perm\./u);
    expect((await t.targets.list(t.tenant, appId)).targets).toEqual([]);
  });

  it("an ordinary user (no maintain permission) cannot drive the browser or register: 403 and nothing stored", async () => {
    const t = await start();
    const appId = await t.createApplication(managedConfig());
    const res = await t.studio({ action: "connect", applicationId: appId }, "user");
    expect(res).toMatchObject({ status: 403, body: { error: "FORBIDDEN" } });
    expect(t.runtimes).toHaveLength(0);
  });

  it("resume through the real routes: the same maintainer re-adopts the session under a new id and can register with it; the old id is dead", async () => {
    const t = await start();
    const appId = await t.createApplication(managedConfig());
    const connected = await t.studio({ action: "connect", applicationId: appId });
    const old = connected.body.sessionId as string;
    await t.studio({ action: "refresh", sessionId: old, applicationId: appId });
    const resumed = await t.studio({ action: "resume", applicationId: appId });
    expect(resumed).toMatchObject({ status: 200, body: { resumed: true, registrySource: "studio-managed" } });
    const fresh = resumed.body.sessionId as string;
    expect(fresh).not.toBe(old);
    expect((await t.studio({ action: "refresh", sessionId: old, applicationId: appId })).body).toEqual({ error: "SESSION_CLOSED" });
    expect((await t.studio(registerBody(fresh, appId, {}))).status).toBe(200);
    expect(t.runtimes).toHaveLength(1);
  });
});

describe("what a managed registration never touches", () => {
  it("a built-in application keeps the V1A inspector and refuses to register; the registry of the reference application is the same before and after a managed registration", async () => {
    const t = await start();
    const reference = await t.createApplication(referenceConfig());
    const managed = await t.createApplication(managedConfig());
    const before = (await t.call("GET", `/api/admin/applications/${reference}/registry`, "maintainer")).raw;
    await registerStory(t, managed); // leaves its session open: close it to connect the reference application
    const open = (await t.studio({ action: "resume", applicationId: managed })).body.sessionId as string;
    expect((await t.studio({ action: "disconnect", sessionId: open })).body).toEqual({ closed: true });
    const connected = await t.studio({ action: "connect", applicationId: reference });
    expect(connected.body).toMatchObject({ registrySource: "built-in" });
    expect(t.configs[1]!.labels).not.toBe("all");
    const session = connected.body.sessionId as string;
    t.runtimes[1]!.url = "http://127.0.0.1:5184/#/profile";
    const refreshed = await t.studio({ action: "refresh", sessionId: session, applicationId: reference });
    expect(refreshed.body).toMatchObject({ hidden: 0, truncated: false });
    expect((refreshed.body.elements as { status: string }[]).every((e) => e.status === "trusted" || e.status === "unregistered")).toBe(true);
    const refused = await t.studio(registerBody(session, reference, { ref: "@e1" }));
    expect(refused).toMatchObject({ status: 409, body: { error: "REGISTRY_NOT_MANAGED" } });
    expect((await t.targets.list(t.tenant, reference))).toEqual({ targets: [], routes: [] });
    expect((await t.call("GET", `/api/admin/applications/${reference}/registry`, "maintainer")).raw).toBe(before);
    expect((await t.targets.list(t.tenant, managed)).targets).toHaveLength(3);
  });

  it("a second tenant sees nothing of the first tenant's managed application, targets or guides, and cannot connect to it", async () => {
    const one = await start();
    const two = await start();
    const appId = await one.createApplication(managedConfig());
    await registerStory(one, appId);
    const guide = await one.createWorkflow(appId, managedDef());
    await one.call("POST", `/api/admin/walkthroughs/${guide.id}/status`, "maintainer", { status: "published" });
    expect((await two.call("GET", `/api/admin/applications/${appId}/targets`, "maintainer")).status).toBe(404);
    expect((await two.call("GET", `/api/admin/applications/${appId}/registry`, "maintainer")).status).toBe(404);
    expect((await two.studio({ action: "connect", applicationId: appId })).body).toEqual({ error: "APPLICATION_NOT_FOUND" });
    expect(two.runtimes).toHaveLength(0);
    const list = (await two.call("GET", "/api/walkthroughs/published", "user")).body;
    expect(list).toEqual({ walkthroughs: expect.any(Array), external: [] });
    expect((await two.call("GET", `/api/walkthroughs/published/${guide.id}/bundle`, "user")).status).toBe(404);
    expect((await two.targets.list(two.tenant, appId))).toEqual({ targets: [], routes: [] });
    // and tenant two's own managed application with the same origin is independent
    const own = await two.createApplication(managedConfig());
    expect((await two.call("GET", `/api/admin/applications/${own}/targets`, "maintainer")).body).toMatchObject({ targets: [], routes: [] });
  });

  it("an application disabled while a session is open closes the session at the next command and registers nothing", async () => {
    const t = await start();
    const appId = await t.createApplication(managedConfig());
    const connected = await t.studio({ action: "connect", applicationId: appId });
    const session = connected.body.sessionId as string;
    await t.studio({ action: "refresh", sessionId: session, applicationId: appId });
    expect((await t.call("POST", `/api/admin/applications/${appId}/status`, "maintainer", { enabled: false })).status).toBe(200);
    expect((await t.studio(registerBody(session, appId, {}))).body).toEqual({ error: "APPLICATION_DISABLED" });
    expect(t.runtimes[0]!.close).toHaveBeenCalledOnce();
    expect((await t.targets.list(t.tenant, appId)).targets).toEqual([]);
  });
});

describe("scoping, authorship and the in-transaction re-check (mutation pass D16)", () => {
  it("two managed applications of ONE tenant with the same target id and route name keep separate registries: get, list and the validator registry never cross", async () => {
    const t = await start();
    const one = await t.createApplication(managedConfig({ name: "One" }));
    const two = await t.createApplication(managedConfig({ name: "Two", origin: "http://127.0.0.1:5188", allowedOrigins: ["http://127.0.0.1:5188"] }));
    await t.registerOk(one, { label: "First one", route: "orders", page: "/#/orders" });
    await t.registerOk(two, { label: "Second one", route: "orders", page: "/#/other" });
    await t.registerOk(two, { targetId: "extra.only", route: "extra", page: "/#/extra", label: "Extra" });
    expect((await t.targets.get(t.tenant, one, "orders.submitButton"))?.label).toBe("First one");
    expect((await t.targets.get(t.tenant, two, "orders.submitButton"))?.label).toBe("Second one");
    expect(await t.targets.get(t.tenant, one, "extra.only")).toBeNull();
    expect((await t.targets.list(t.tenant, one)).targets.map((x) => x.id)).toEqual(["orders.submitButton"]);
    const registry = await t.targets.registry(t.tenant, one);
    expect(registry.routes).toEqual([{ route: "orders", page: "/#/orders" }]);
    expect((registry.elements as unknown as { id: string }[]).map((e) => e.id)).toEqual(["orders.submitButton"]);
    expect((await t.targets.registry(t.tenant, two)).routes).toEqual([{ route: "orders", page: "/#/other" }, { route: "extra", page: "/#/extra" }]);
    // a status change names ONE application's target
    expect(await t.targets.setStatus({ tenantId: t.tenant, actor: "maya" }, one, "orders.submitButton", "disabled")).toBe("changed");
    expect((await t.targets.get(t.tenant, two, "orders.submitButton"))?.status).toBe("active");
  });
  it("the actor of a registration is the trusted session's user, on the route and on the target; a status change records its own actor", async () => {
    const t = await start();
    const appId = await t.createApplication(managedConfig());
    await t.registerOk(appId);
    const rows = await t.sql((client) => client.query("SELECT r.created_by AS route_by, t.created_by AS target_by, t.updated_by AS updated_by FROM public.studio_registry_targets t JOIN public.studio_registry_routes r ON r.tenant_id = t.tenant_id AND r.application_id = t.application_id AND r.route = t.route"));
    expect(rows.rows).toEqual([{ route_by: "maya", target_by: "maya", updated_by: "maya" }]);
  });
  it("saving a draft re-validates against the registry INSIDE the write transaction: a target disabled after the executor's first read refuses the save and stores nothing", async () => {
    let armed = false;
    let disable: (() => Promise<unknown>) | null = null;
    const t = await startHost(closers, hosts, owner, { wrapTargets: (real) => ({ ...real, registry: async (tenantId, applicationId) => {
      const answer = await real.registry(tenantId, applicationId);
      if (armed && disable !== null) { armed = false; await disable(); }
      return answer;
    } }) });
    const appId = await t.createApplication(managedConfig());
    await t.registerOk(appId);
    disable = () => t.targets.setStatus({ tenantId: t.tenant, actor: "maya" }, appId, "orders.submitButton", "disabled");
    armed = true;
    const feedback = await t.submit("saveWalkthroughDraft", { walkthroughId: "wt-0000000000f1", applicationId: appId, definition: { ...managedDef(), id: "wt-0000000000f1" } });
    expect(feedback).toEqual({ outcome: "ALLOWED", category: "try_later" });
    expect(await t.realStore.get(t.tenant, "wt-0000000000f1")).toBeNull();
  });
});

it("reports route creation exactly once when another registration wins the transaction", async () => {
  let signalEntered!: () => void;
  let resume!: () => void;
  const entered = new Promise<void>(resolve => { signalEntered = resolve; });
  const held = new Promise<void>(resolve => { resume = resolve; });
  const t = await start({ wrapRegistration: (register) => async (...args) => {
    signalEntered();
    await held;
    return register(...args);
  } });
  const appId = await t.createApplication(managedConfig());
  const connected = await t.studio({ action: "connect", applicationId: appId });
  const sessionId = connected.body.sessionId as string;
  await t.studio({ action: "refresh", sessionId, applicationId: appId });
  const pending = t.studio(registerBody(sessionId, appId, {}));
  try {
    await Promise.race([entered, pending.then(() => { throw new Error("Registration returned before reaching the store"); })]);
    const winner = await t.realTargets.register({ tenantId: t.tenant, actor: "maya" }, appId, {
      targetId: "orders.competitor", route: "orders", page: "/#/orders", role: "button", label: "Competing target",
      description: "A second writer registers the same route.", operations: ["highlight", "click"], privacy: "public",
    });
    expect(winner).toEqual({ kind: "created", route: { route: "orders", page: "/#/orders", created: true } });
  } finally { resume(); }
  expect(await pending).toMatchObject({ status: 200, body: { route: { route: "orders", page: "/#/orders", created: false } } });
  expect(await t.targets.list(t.tenant, appId)).toMatchObject({ routes: [{ route: "orders", page: "/#/orders" }], targets: expect.arrayContaining([
    expect.objectContaining({ id: "orders.submitButton" }), expect.objectContaining({ id: "orders.competitor" }),
  ]) });
});

describe("duplicate markers fail closed through the real routes (H5)", () => {
  it("two controls sharing a marker are listed as neither registrable nor trusted, the register command refuses them, and the database stays empty", async () => {
    const saved = PAGES["/#/orders"]!;
    PAGES["/#/orders"] = [control("Twin one", "button", "orders.twin"), control("Twin two", "link", "orders.twin"), control("Order note", "textbox", "orders.note")];
    try {
      const t = await start();
      const appId = await t.createApplication(managedConfig());
      const session = (await t.studio({ action: "connect", applicationId: appId })).body.sessionId as string;
      const shown = await t.studio({ action: "refresh", sessionId: session, applicationId: appId });
      expect((shown.body.elements as { name: string }[]).map((e) => e.name)).toEqual(["Order note"]);
      expect(shown.body.hidden).toBe(2);
      expect(shown.raw).not.toMatch(/Twin/u);
      for (const ref of ["@e1", "@e2"]) expect((await t.studio(registerBody(session, appId, { ref, targetId: "orders.twin", label: "Twin", description: "Twin." }))).body, ref).toEqual({ error: "REF_NOT_FOUND" });
      expect((await t.targets.list(t.tenant, appId)).targets).toEqual([]);
      // a register the editor could not have offered is also refused when the marker turns ambiguous after the refresh
      PAGES["/#/orders"] = [control("Order note", "textbox", "orders.note"), control("Later", "button", null)];
      await t.studio({ action: "refresh", sessionId: session, applicationId: appId });
      PAGES["/#/orders"]![1] = control("Later twin", "textbox", "orders.note");
      expect((await t.studio(registerBody(session, appId, { ref: "@e1", targetId: "orders.note", operations: ["highlight", "input"], label: "Note", description: "Note." }))).body).toEqual({ error: "TARGET_NOT_REGISTRABLE" });
      expect((await t.targets.list(t.tenant, appId)).targets).toEqual([]);
    } finally { PAGES["/#/orders"] = saved; }
  });
});
