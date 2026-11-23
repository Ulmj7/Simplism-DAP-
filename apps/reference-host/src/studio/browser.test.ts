/**
 * The Studio browser boundary (Studio V1A) with a FAKE BrowserRuntime (deterministic, no Chrome) and focused fake stores. They prove the HOST's behaviour: tenant-scoped application
 * loading, per-application policy, session binding, the inspector's classification, highlight/capture verification, session lifecycle and the closed error mapping. The adapter's own
 * policy (origins, routes, labels) is tested in packages/browser-runtime; the PostgreSQL-backed proof is tests/integration/studio-browser.test.ts.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserRuntimeError } from "@dap/browser-runtime";
import type { BrowserRuntime, BrowserSnapshot, ElementRef } from "@dap/browser-runtime";
import { createGuidanceTransport } from "../http/transport.js";
import { createProposalStore } from "../http/proposal-store.js";
import type { StoredWalkthrough } from "../authoring/store.js";
import { FakeApplicationStore } from "./fake-application-store.js";
import { FIXTURE_ENTRY } from "./fixture-registry.js";
import { createRegistryCatalog } from "./registries.js";
import type { RegistryEntry } from "./registries.js";
import type { ApplicationConfig } from "./applications.js";
import { registerStudioBrowser } from "./browser.js";
import type { BrowserRuntimeConfig } from "./browser.js";

const TENANT_A = "1111aaaa-2222-4333-8444-5555bbbb5555";
const TENANT_B = "2222bbbb-3333-4444-8555-6666cccc6666";
const APP_A = "app-0000000000a1"; // the reference application (reference registry), tenant A
const APP_B = "app-0000000000b1"; // the second application (fixture registry, another origin), tenant A
const APP_OTHER = "app-0000000000c1"; // an application of tenant B
const WT = "wt-0000000000a1";
const SECRET = "SECRET /home/dev/agent-browser stderr http://blocked.example/leak?token=abc";

const configA: ApplicationConfig = { name: "Reference application", origin: "http://127.0.0.1:5173", allowedOrigins: ["http://127.0.0.1:5173"], environment: "development", registryId: "reference" };
const configB: ApplicationConfig = { name: "Second application", origin: "http://127.0.0.1:5185", allowedOrigins: ["http://127.0.0.1:5185", "http://localhost:5185"], environment: "test", registryId: "fixture" };

const profileSnapshot: BrowserSnapshot = {
  url: "http://127.0.0.1:5173/#/profile",
  elements: [{ ref: "@e21", name: "Display name", role: "textbox" }, { ref: "@e22", name: "Save", role: "button" }],
};
const ordersSnapshot: BrowserSnapshot = { url: "http://127.0.0.1:5185/#/orders", elements: [{ ref: "@e5", name: "Export", role: "button" }] };

interface FakeRuntime extends BrowserRuntime {
  snapshotValue: BrowserSnapshot;
  ids: Record<string, string | null>;
}
function fakeRuntime(snapshot: BrowserSnapshot = profileSnapshot, ids: Record<string, string | null> = { "@e21": "profile.nameInput", "@e22": "profile.saveButton" }): FakeRuntime {
  const runtime: FakeRuntime = {
    snapshotValue: snapshot, ids,
    start: vi.fn(async () => {}),
    snapshot: vi.fn(async () => runtime.snapshotValue),
    inspectSemanticId: vi.fn(async (ref: ElementRef) => runtime.ids[ref] ?? null),
    inspectSemanticIds: vi.fn(async (from: BrowserSnapshot) => new Map(from.elements.map((element) => [element.ref, runtime.ids[element.ref] ?? null] as const))),
    highlight: vi.fn(async () => {}), clearHighlight: vi.fn(async () => {}), getUrl: vi.fn(async () => runtime.snapshotValue.url), waitForChange: vi.fn(async () => ({ status: "timeout" as const })),
    close: vi.fn(async () => {}),
  };
  return runtime;
}

type Role = "maintainer" | "another-maintainer" | "tenant-b" | "user" | "expired";
interface Harness { app: ReturnType<typeof createGuidanceTransport>; runtime: FakeRuntime; runtimes: FakeRuntime[]; configs: BrowserRuntimeConfig[]; applications: FakeApplicationStore;
  walkthroughs: Map<string, { applicationId: string | null; tenantId: string }>; command: (payload: unknown, role?: Role) => Promise<{ status: number; body: Record<string, unknown>; raw: string }>; connect: (applicationId?: string) => Promise<string> }

const open: Harness[] = [];
afterEach(async () => { vi.useRealTimers(); await Promise.all(open.splice(0).map((h) => h.app.close())); });

async function harness(options: { createRuntime?: (config: BrowserRuntimeConfig) => BrowserRuntime; first?: FakeRuntime; ids?: string[]; walkthroughFailure?: Error; extra?: RegistryEntry[] } = {}): Promise<Harness> {
  const app = createGuidanceTransport({
    ask: async () => ({ kind: "clarify", message: "Unused" }), catalog: { list: () => [] },
    resolveSession: async () => null, proposals: createProposalStore({ now: Date.now, newId: () => "unused" }),
  });
  const runtimes: FakeRuntime[] = [];
  const configs: BrowserRuntimeConfig[] = [];
  const runtime = options.first ?? fakeRuntime();
  const applications = new FakeApplicationStore();
  await applications.save({ tenantId: TENANT_A, actor: "seed" }, APP_A, configA);
  await applications.save({ tenantId: TENANT_A, actor: "seed" }, APP_B, configB);
  await applications.save({ tenantId: TENANT_B, actor: "seed" }, APP_OTHER, { ...configA, name: "Other tenant's application" });
  const walkthroughs = new Map<string, { applicationId: string | null; tenantId: string }>();
  const ids = [...(options.ids ?? [])];
  registerStudioBrowser(app, {
    applications, catalog: createRegistryCatalog(options.extra ?? [FIXTURE_ENTRY]),
    authoring: { get: async (tenantId, id): Promise<StoredWalkthrough | null> => {
      if (options.walkthroughFailure) throw options.walkthroughFailure;
      const row = walkthroughs.get(id);
      return row === undefined || row.tenantId !== tenantId ? null : { id, status: "draft", applicationId: row.applicationId, definition: {}, updatedAt: "2026-01-01T00:00:00.000Z" };
    } },
    createRuntime: options.createRuntime ?? ((config) => {
      configs.push(config);
      const made = configs.length === 1 ? runtime : fakeRuntime(config.origins[0]?.endsWith(":5185") ? ordersSnapshot : profileSnapshot, { "@e5": "orders.exportButton" });
      runtimes.push(made);
      return made;
    }),
    makeId: () => ids.shift() ?? "session",
    resolvePrincipal: async (headers) => {
      const key = String(headers["x-demo-role"]);
      if (key === "expired") return null;
      return { key, tenantId: key === "tenant-b" ? TENANT_B : TENANT_A, actor: "author", submit: vi.fn(), permissions: new Set(key === "user" ? [] : ["perm.walkthrough.maintain"]) };
    },
  });
  const command = async (payload: unknown, role: Role = "maintainer") => {
    const res = await app.inject({ method: "POST", url: "/api/studio/browser", headers: { "x-demo-role": role }, payload: payload as never });
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(res.body) as Record<string, unknown>; } catch { /* not JSON */ }
    return { status: res.statusCode, body, raw: res.body };
  };
  const connect = async (applicationId = APP_A) => { const res = await command({ action: "connect", applicationId }); if (res.status !== 200) throw new Error(`connect failed: ${res.status} ${res.raw}`); return res.body.sessionId as string; };
  const built = { app, runtime, runtimes, configs, applications, walkthroughs, command, connect };
  open.push(built);
  return built;
}

const refresh = (applicationId = APP_A, sessionId = "session") => ({ action: "refresh", sessionId, applicationId });
const target = (action: "highlight" | "capture", ref: string, applicationId = APP_A, sessionId = "session") => ({ action, sessionId, applicationId, ref });
const disconnect = (applicationId: string | undefined = APP_A, sessionId = "session") => ({ action: "disconnect", sessionId, ...(applicationId === undefined ? {} : { applicationId }) });
const expectNoLeak = (raw: string) => {
  for (const word of ["SECRET", "/home/dev", "stderr", "blocked.example", "token=abc", "5173", "5185", "127.0.0.1", "localhost", "Reference application", "Display name", "Export", "data-ai-id", "profile.nameInput"]) expect(raw, word).not.toContain(word);
};

// --- the first Studio's regression tests, kept at the same strength ---------------------------------------------------------------------------------------
describe("Studio browser boundary", () => {
  it("captures a public registry ID using a current snapshot and closes the browser", async () => {
    const { runtime, command, configs } = await harness();
    expect((await command({ action: "connect", applicationId: APP_A })).body).toEqual({ sessionId: "session", applicationId: APP_A, application: "Reference application", origin: "http://127.0.0.1:5173" });
    expect(runtime.start).toHaveBeenCalledWith({ url: "http://127.0.0.1:5173/", headed: true });
    expect(configs).toHaveLength(1);
    const refreshed = (await command(refresh())).body;
    expect(refreshed).toEqual({
      url: "http://127.0.0.1:5173/#/profile", route: "profile",
      elements: [
        { ref: "@e21", name: "Display name", role: "textbox", route: "profile", status: "trusted", targetId: "profile.nameInput", operations: ["highlight", "input", "focus"], privacy: "public" },
        { ref: "@e22", name: "Save", role: "button", route: "profile", status: "trusted", targetId: "profile.saveButton", operations: ["highlight", "click"], privacy: "public" },
      ],
    });
    expect((await command(target("capture", "@e21"))).body).toEqual({ targetId: "profile.nameInput", route: "profile", role: "textbox", name: "Display name", operations: ["highlight", "input", "focus"] });
    expect(runtime.highlight).toHaveBeenCalledWith("@e21", runtime.snapshotValue);
    expect((await command(disconnect())).body).toEqual({ closed: true });
    expect(runtime.close).toHaveBeenCalledOnce();
  });

  it("refuses unauthorized sessions, arbitrary routes, request-supplied origins and private targets", async () => {
    const { app, runtime, command } = await harness();
    expect((await command({ action: "connect", applicationId: APP_A }, "user")).status).toBe(403);
    expect((await command({ action: "connect", applicationId: APP_A }, "expired")).status).toBe(401);
    for (const body of [
      { action: "connect", applicationId: APP_A, url: "https://example.invalid/" }, { action: "connect", url: "https://example.invalid/" }, { action: "connect", applicationId: APP_A, origin: "https://example.invalid" },
      { action: "connect", applicationId: APP_A, allowedOrigins: ["https://example.invalid"] }, { action: "connect", applicationId: APP_A, registryId: "fixture" }, { action: "connect" },
    ]) expect((await command(body)).body, JSON.stringify(body)).toEqual({ error: "INVALID_REQUEST" });
    expect(runtime.start).not.toHaveBeenCalled();
    await command({ action: "connect", applicationId: APP_A });
    expect((await command(refresh(), "another-maintainer")).status).toBe(404);
    await command(refresh());
    expect((await command(target("capture", "@e999"))).body).toEqual({ error: "REF_NOT_FOUND" });
    runtime.ids["@e21"] = "profile.emailInput"; // a registered but PRIVATE element
    await command(refresh());
    expect((await command(target("capture", "@e21"))).body).toEqual({ error: "TARGET_UNAVAILABLE" });
    expect(runtime.highlight).not.toHaveBeenCalled();
    await app.close();
    expect(runtime.close).toHaveBeenCalledOnce();
  });

  it("fails closed when the application's registry is not in the catalog or the adapter refuses the configuration", async () => {
    const missing = await harness();
    await missing.applications.save({ tenantId: TENANT_A, actor: "seed" }, "app-0000000000d1", { ...configA, registryId: "gone" } as never);
    expect((await missing.command({ action: "connect", applicationId: "app-0000000000d1" })).body).toEqual({ error: "BROWSER_UNAVAILABLE" });
    expect(missing.runtimes).toEqual([]);
    const refused = await harness({ createRuntime: () => { throw new TypeError("origins must be normalized http or https origins"); } });
    const res = await refused.command({ action: "connect", applicationId: APP_A });
    expect([res.status, res.body]).toEqual([503, { error: "BROWSER_UNAVAILABLE" }]);
    expectNoLeak(res.raw);
    expect((await refused.command({ action: "connect", applicationId: APP_A })).status, "no half-open session was left behind").toBe(503);
  });

  it("binds a session to its owner: another maintainer, another tenant and an unknown session id see SESSION_CLOSED, and the owner's session is untouched", async () => {
    const { command, runtime } = await harness();
    await command({ action: "connect", applicationId: APP_A });
    for (const [role, body] of [["another-maintainer", refresh()], ["tenant-b", refresh(APP_OTHER)], ["another-maintainer", disconnect()], ["maintainer", refresh(APP_A, "not-the-session")], ["maintainer", disconnect(APP_A, "other")]] as const) {
      expect((await command(body, role)).body, JSON.stringify([role, body])).toEqual({ error: "SESSION_CLOSED" });
    }
    expect(runtime.close).not.toHaveBeenCalled();
    expect((await command(refresh())).status).toBe(200);
  });

  it("allows ONE session at a time: connect while any session exists is BROWSER_BUSY (even the same principal and application), and one command at a time", async () => {
    const { command, runtime, configs } = await harness();
    await command({ action: "connect", applicationId: APP_A });
    for (const [role, app] of [["maintainer", APP_A], ["maintainer", APP_B], ["another-maintainer", APP_A], ["tenant-b", APP_OTHER]] as const) {
      expect((await command({ action: "connect", applicationId: app }, role)).body, `${role} ${app}`).toEqual({ error: "BROWSER_BUSY" });
    }
    expect(configs).toHaveLength(1);
    let release: () => void = () => {};
    vi.mocked(runtime.snapshot).mockImplementationOnce(() => new Promise<BrowserSnapshot>((resolve) => { release = () => resolve(profileSnapshot); }));
    const slow = command(refresh());
    await vi.waitFor(() => expect(runtime.snapshot).toHaveBeenCalledOnce());
    expect((await command(refresh())).body).toEqual({ error: "BROWSER_BUSY" });
    expect((await command(disconnect())).body).toEqual({ error: "BROWSER_BUSY" });
    release();
    expect((await slow).status).toBe(200);
    expect((await command(disconnect())).body).toEqual({ closed: true });
  });

  it("closes the browser when connecting fails (the start error is mapped, never forwarded), and a later connect is possible", async () => {
    const first = fakeRuntime();
    first.start = vi.fn(async () => { throw new BrowserRuntimeError("NAVIGATION_FAILED"); });
    const { command } = await harness({ first });
    const failed = await command({ action: "connect", applicationId: APP_A });
    expect([failed.status, failed.body]).toEqual([503, { error: "NAVIGATION_FAILED" }]);
    expect(first.close).toHaveBeenCalledOnce();
    expect((await command({ action: "connect", applicationId: APP_A })).status).toBe(200);
    const leaky = fakeRuntime();
    leaky.start = vi.fn(async () => { throw new Error(SECRET); });
    const raw = await harness({ first: leaky });
    const leaked = await raw.command({ action: "connect", applicationId: APP_A });
    expect([leaked.status, leaked.body]).toEqual([503, { error: "BROWSER_UNAVAILABLE" }]);
    expectNoLeak(leaked.raw);
    expect(leaky.close).toHaveBeenCalledOnce();
  });

  it("closes an idle session after five minutes (fake timers) and keeps it while commands arrive; the refs die with it", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const { command, runtime } = await harness();
    await command({ action: "connect", applicationId: APP_A });
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    expect(runtime.close).not.toHaveBeenCalled();
    expect((await command(refresh())).status).toBe(200); // activity restarts the idle clock
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    expect(runtime.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_001);
    expect(runtime.close).toHaveBeenCalledOnce();
    expect((await command(refresh())).body).toEqual({ error: "SESSION_CLOSED" });
    expect((await command(target("highlight", "@e21"))).body).toEqual({ error: "SESSION_CLOSED" });
    expect((await command({ action: "connect", applicationId: APP_A })).status, "a new session can be opened after the idle close").toBe(200);
  });

  it("closes the live session when the host shuts down (onClose)", async () => {
    const { command, runtimes, app } = await harness();
    await command({ action: "connect", applicationId: APP_A });
    await app.close();
    expect(runtimes[0]!.close).toHaveBeenCalledOnce();
  });
});

// --- strict bodies -----------------------------------------------------------------------------------------------------------------------------------
describe("strict request bodies", () => {
  const bad: [unknown][] = [
    [{}], [{ action: "nope" }], [{ action: 5 }], [[]], [null],
    [{ action: "connect", applicationId: APP_A, extra: 1 }], [{ action: "connect", applicationId: "app-0000000000A1" }], [{ action: "connect", applicationId: "app-0000000000a" }], [{ action: "connect", applicationId: 7 }],
    [{ action: "connect", applicationId: APP_A, walkthroughId: "profileUpdate" }], [{ action: "connect", applicationId: APP_A, walkthroughId: "wt-preview" }], [{ action: "connect", applicationId: APP_A, walkthroughId: "wt-0000000000A1" }],
    [{ action: "connect", applicationId: APP_A, walkthroughId: 5 }], [{ action: "connect", applicationId: APP_A, walkthroughId: null }],
    [{ action: "refresh", sessionId: "session" }], [{ action: "refresh", applicationId: APP_A }], [{ action: "refresh", sessionId: "session", applicationId: APP_A, ref: "@e1" }], [{ action: "refresh", sessionId: "", applicationId: APP_A }],
    [{ action: "refresh", sessionId: "a".repeat(65), applicationId: APP_A }], [{ action: "refresh", sessionId: "bad session", applicationId: APP_A }], [{ action: "refresh", sessionId: 1, applicationId: APP_A }],
    [{ action: "highlight", sessionId: "session", applicationId: APP_A }], [{ action: "capture", sessionId: "session", applicationId: APP_A, ref: "e21" }], [{ action: "capture", sessionId: "session", applicationId: APP_A, ref: "@e0" }],
    [{ action: "capture", sessionId: "session", applicationId: APP_A, ref: "@e01" }], [{ action: "capture", sessionId: "session", applicationId: APP_A, ref: "@e1234567890" }], [{ action: "capture", sessionId: "session", applicationId: APP_A, ref: `@e${"9".repeat(5000)}` }],
    [{ action: "capture", sessionId: "session", applicationId: APP_A, ref: ["@e1"] }], [{ action: "capture", sessionId: "session", ref: "@e1" }],
    [{ action: "disconnect" }], [{ action: "disconnect", sessionId: "session", applicationId: "nope" }], [{ action: "disconnect", sessionId: "session", extra: true }],
    [{ action: "connect", applicationId: "a".repeat(10_000) }], [{ action: "refresh", sessionId: "s".repeat(10_000), applicationId: APP_A }],
  ];
  it.each(bad.map(([body]) => [JSON.stringify(body)?.slice(0, 70) ?? "undefined", body] as const))("%s is 400 INVALID_REQUEST and nothing runs", async (_label, body) => {
    const { command, runtime, configs } = await harness();
    const res = await command(body);
    expect([res.status, res.body]).toEqual([400, { error: "INVALID_REQUEST" }]);
    expect(configs).toEqual([]);
    expect(runtime.start).not.toHaveBeenCalled();
  });
  it("a malformed body on a live session never reaches the runtime", async () => {
    const { command, runtime } = await harness();
    await command({ action: "connect", applicationId: APP_A });
    for (const body of [{ action: "refresh", sessionId: "session" }, { action: "capture", sessionId: "session", applicationId: APP_A, ref: "@e01" }, { action: "disconnect", sessionId: "session", applicationId: "x" }]) {
      expect((await command(body)).status).toBe(400);
    }
    expect(runtime.snapshot).not.toHaveBeenCalled();
    expect(runtime.close).not.toHaveBeenCalled();
  });
  it("the permission and session checks come before the body is looked at: no principal is 401, a user is 403, with a fixed body each", async () => {
    const { command } = await harness();
    expect((await command({ action: "garbage" }, "expired")).body).toEqual({ error: "SESSION_CLOSED" });
    expect((await command({ action: "garbage" }, "user")).body).toEqual({ error: "FORBIDDEN" });
    expect((await command({ action: "garbage" })).body).toEqual({ error: "INVALID_REQUEST" });
  });
});

// --- application loading: tenant only --------------------------------------------------------------------------------------------------------------------
describe("the application comes from the principal's tenant, never from the request", () => {
  it("another tenant's application id, an unknown id and a malformed-but-well-shaped id are the same 404 APPLICATION_NOT_FOUND, and no runtime is created", async () => {
    const { command, configs } = await harness();
    for (const [role, app] of [["maintainer", APP_OTHER], ["tenant-b", APP_A], ["tenant-b", APP_B], ["maintainer", "app-ffffffffffff"]] as const) {
      const res = await command({ action: "connect", applicationId: app }, role);
      expect([role, app, res.status, res.body]).toEqual([role, app, 404, { error: "APPLICATION_NOT_FOUND" }]);
    }
    expect(configs).toEqual([]);
  });
  it("the tenant that owns the application connects; the runtime is configured only from the stored record and the catalog", async () => {
    const { command, configs, runtime } = await harness();
    expect((await command({ action: "connect", applicationId: APP_OTHER }, "tenant-b")).status).toBe(200);
    expect(configs).toHaveLength(1);
    expect(configs[0]!.origins).toEqual(["http://127.0.0.1:5173"]);
    expect(runtime.start).toHaveBeenCalledWith({ url: "http://127.0.0.1:5173/", headed: true });
  });
  it("a DISABLED application is 409 APPLICATION_DISABLED at connect, with no runtime; enabling it makes it connectable", async () => {
    const { command, applications, configs } = await harness();
    await applications.setEnabled({ tenantId: TENANT_A, actor: "seed" }, APP_A, false);
    expect((await command({ action: "connect", applicationId: APP_A })).body).toEqual({ error: "APPLICATION_DISABLED" });
    expect(configs).toEqual([]);
    await applications.setEnabled({ tenantId: TENANT_A, actor: "seed" }, APP_A, true);
    expect((await command({ action: "connect", applicationId: APP_A })).status).toBe(200);
  });
  it("an application store that fails is 503 BROWSER_UNAVAILABLE at connect and on a live session's next command (refused, session kept), with no leak", async () => {
    const down = await harness();
    down.applications.failWith = new Error(SECRET);
    const refused = await down.command({ action: "connect", applicationId: APP_A });
    expect([refused.status, refused.body]).toEqual([503, { error: "BROWSER_UNAVAILABLE" }]);
    expectNoLeak(refused.raw);
    expect(down.configs).toEqual([]);
    const { command, applications, runtime } = await harness();
    await command({ action: "connect", applicationId: APP_A });
    applications.failWith = new Error(SECRET);
    const res = await command(refresh());
    expect([res.status, res.body]).toEqual([503, { error: "BROWSER_UNAVAILABLE" }]);
    expectNoLeak(res.raw);
    expect(runtime.snapshot).not.toHaveBeenCalled();
    expect(runtime.close).not.toHaveBeenCalled();
    applications.failWith = null;
    expect((await command(refresh())).status).toBe(200);
  });
  it.each([["refresh", refresh()], ["highlight", target("highlight", "@e21")], ["capture", target("capture", "@e21")]] as const)(
    "a session whose application is DISABLED mid-session is closed and a %s is refused with APPLICATION_DISABLED; the next command sees SESSION_CLOSED", async (_name, body) => {
      const h = await harness();
      await h.command({ action: "connect", applicationId: APP_A });
      await h.command(refresh());
      await h.applications.setEnabled({ tenantId: TENANT_A, actor: "seed" }, APP_A, false);
      expect((await h.command(body)).body).toEqual({ error: "APPLICATION_DISABLED" });
      expect(h.runtime.close).toHaveBeenCalledOnce();
      expect(h.runtime.highlight).not.toHaveBeenCalled();
      expect((await h.command(refresh())).body).toEqual({ error: "SESSION_CLOSED" });
    });
  it("a session whose application was REMOVED is closed with 404 APPLICATION_NOT_FOUND", async () => {
    const { command, applications, runtime } = await harness();
    await command({ action: "connect", applicationId: APP_A });
    applications.rows.splice(0, applications.rows.length, ...applications.rows.filter((row) => row.id !== APP_A));
    expect((await command(refresh())).body).toEqual({ error: "APPLICATION_NOT_FOUND" });
    expect(runtime.close).toHaveBeenCalledOnce();
    expect((await command(refresh())).body).toEqual({ error: "SESSION_CLOSED" });
  });
  it("a session whose policy changed (another origin or registry) is closed and refused: the live adapter's policy would be stale; a rename does not", async () => {
    const { command, applications, runtime } = await harness();
    await command({ action: "connect", applicationId: APP_A });
    await applications.save({ tenantId: TENANT_A, actor: "seed" }, APP_A, { ...configA, name: "Renamed" });
    expect((await command(refresh())).status).toBe(200);
    await applications.save({ tenantId: TENANT_A, actor: "seed" }, APP_A, { ...configA, allowedOrigins: ["http://127.0.0.1:5173", "http://localhost:5173"] });
    expect((await command(refresh())).body).toEqual({ error: "APPLICATION_MISMATCH" });
    expect(runtime.close).toHaveBeenCalledOnce();
    expect((await command(refresh())).body).toEqual({ error: "SESSION_CLOSED" });
  });
  it("disconnect works for the owner even when the application was disabled or removed", async () => {
    const { command, applications, runtime } = await harness();
    await command({ action: "connect", applicationId: APP_A });
    await applications.setEnabled({ tenantId: TENANT_A, actor: "seed" }, APP_A, false);
    expect((await command(disconnect())).body).toEqual({ closed: true });
    expect(runtime.close).toHaveBeenCalledOnce();
  });
});

// --- policy per application --------------------------------------------------------------------------------------------------------------------------
describe("the policy is derived per application", () => {
  it("application A and application B get different origins, labels, routes and start URLs from the stored record and the catalog entry", async () => {
    const { command, configs, runtimes } = await harness({ ids: ["session-a", "session-b"] });
    expect((await command({ action: "connect", applicationId: APP_A })).body).toMatchObject({ sessionId: "session-a", origin: "http://127.0.0.1:5173" });
    await command(disconnect(APP_A, "session-a"));
    expect((await command({ action: "connect", applicationId: APP_B })).body).toEqual({ sessionId: "session-b", applicationId: APP_B, application: "Second application", origin: "http://127.0.0.1:5185" });
    expect(configs).toHaveLength(2);
    expect(configs[0]).toEqual({
      origins: ["http://127.0.0.1:5173"], routes: ["/", "/#/dashboard", "/#/profile", "/#/settings"],
      labels: [{ role: "link", name: "Profile" }, { role: "link", name: "Settings" }, { role: "textbox", name: "Display name" }, { role: "button", name: "Save" }, { role: "button", name: "Advanced" }, { role: "button", name: "Set up two-factor authentication" }],
    });
    expect(configs[1]).toEqual({ origins: ["http://127.0.0.1:5185", "http://localhost:5185"], routes: ["/", "/#/orders"], labels: [{ role: "button", name: "Export" }] });
    expect(runtimes[0]!.start).toHaveBeenCalledWith({ url: "http://127.0.0.1:5173/", headed: true });
    expect(runtimes[1]!.start).toHaveBeenCalledWith({ url: "http://127.0.0.1:5185/", headed: true });
  });
  it("A's session cannot run any command with B's application id (APPLICATION_MISMATCH, session stays open); the same id works", async () => {
    const { command, runtime } = await harness({ ids: ["session-a"] });
    await command({ action: "connect", applicationId: APP_A });
    await command(refresh(APP_A, "session-a"));
    for (const body of [refresh(APP_B, "session-a"), target("highlight", "@e21", APP_B, "session-a"), target("capture", "@e21", APP_B, "session-a"), disconnect(APP_B, "session-a")]) {
      expect((await command(body)).body, JSON.stringify(body)).toEqual({ error: "APPLICATION_MISMATCH" });
    }
    expect(runtime.close).not.toHaveBeenCalled();
    expect(runtime.highlight).not.toHaveBeenCalled();
    expect((await command(refresh(APP_A, "session-a"))).status).toBe(200);
  });
  it("switching application needs disconnect and a new connect, and B's session sees none of A's candidates or refs", async () => {
    const { command, runtimes } = await harness({ ids: ["session-a", "session-b"] });
    await command({ action: "connect", applicationId: APP_A });
    expect(((await command(refresh(APP_A, "session-a"))).body.elements as unknown[]).length).toBe(2);
    expect((await command({ action: "connect", applicationId: APP_B })).body).toEqual({ error: "BROWSER_BUSY" });
    await command(disconnect(APP_A, "session-a"));
    expect((await command({ action: "connect", applicationId: APP_B })).status).toBe(200);
    // A's old session id and its refs are dead.
    expect((await command(refresh(APP_A, "session-a"))).body).toEqual({ error: "SESSION_CLOSED" });
    expect((await command(target("highlight", "@e21", APP_B, "session-b"))).body, "@e21 was A's candidate; B has not refreshed").toEqual({ error: "REF_NOT_FOUND" });
    const b = (await command(refresh(APP_B, "session-b"))).body;
    expect(b).toEqual({ url: "http://127.0.0.1:5185/#/orders", route: "orders", elements: [{ ref: "@e5", name: "Export", role: "button", route: "orders", status: "trusted", targetId: "orders.exportButton", operations: ["highlight", "click"], privacy: "public" }] });
    expect((await command(target("highlight", "@e21", APP_B, "session-b"))).body, "A's ref is still not one of B's candidates").toEqual({ error: "REF_NOT_FOUND" });
    expect(runtimes[0]!.close).toHaveBeenCalledOnce();
    expect(runtimes[1]!.highlight).not.toHaveBeenCalled();
  });
  it("B's inspector classifies against B's registry: a reference id on B's page is unregistered, B's id is trusted", async () => {
    const { command } = await harness({ first: fakeRuntime(ordersSnapshot, { "@e5": "profile.saveButton" }) });
    await command({ action: "connect", applicationId: APP_B });
    expect((await command(refresh(APP_B))).body.elements).toEqual([{ ref: "@e5", name: "Export", role: "button", route: "orders", status: "unregistered" }]);
  });
});

// --- the walkthrough binding ---------------------------------------------------------------------------------------------------------------------------
describe("connect with a walkthroughId", () => {
  it("opens when the stored walkthrough belongs to the application, or has none (legacy)", async () => {
    const h = await harness({ ids: ["s1", "s2"] });
    h.walkthroughs.set(WT, { applicationId: APP_A, tenantId: TENANT_A });
    expect((await h.command({ action: "connect", applicationId: APP_A, walkthroughId: WT })).body).toMatchObject({ sessionId: "s1", applicationId: APP_A });
    await h.command(disconnect(APP_A, "s1"));
    h.walkthroughs.set(WT, { applicationId: null, tenantId: TENANT_A });
    expect((await h.command({ action: "connect", applicationId: APP_A, walkthroughId: WT })).status).toBe(200);
  });
  it("a guide bound to ANOTHER application is 409 APPLICATION_MISMATCH and no runtime is created", async () => {
    const h = await harness();
    h.walkthroughs.set(WT, { applicationId: APP_B, tenantId: TENANT_A });
    expect((await h.command({ action: "connect", applicationId: APP_A, walkthroughId: WT })).body).toEqual({ error: "APPLICATION_MISMATCH" });
    expect(h.configs).toEqual([]);
  });
  it("an unknown, foreign-tenant or store-failing walkthrough is the generic 400 INVALID_REQUEST (a store failure is 503), and nothing is opened", async () => {
    const h = await harness();
    h.walkthroughs.set(WT, { applicationId: APP_OTHER, tenantId: TENANT_B });
    for (const walkthroughId of [WT, "wt-0000000000ff"]) expect((await h.command({ action: "connect", applicationId: APP_A, walkthroughId })).body).toEqual({ error: "INVALID_REQUEST" });
    expect(h.configs).toEqual([]);
    const broken = await harness({ walkthroughFailure: new Error(SECRET) });
    const res = await broken.command({ action: "connect", applicationId: APP_A, walkthroughId: WT });
    expect([res.status, res.body]).toEqual([503, { error: "BROWSER_UNAVAILABLE" }]);
    expectNoLeak(res.raw);
  });
  it("the application is checked first: an unknown application wins over a walkthrough problem", async () => {
    const h = await harness();
    expect((await h.command({ action: "connect", applicationId: "app-ffffffffffff", walkthroughId: "wt-0000000000ff" })).body).toEqual({ error: "APPLICATION_NOT_FOUND" });
  });
});

// --- the inspector -------------------------------------------------------------------------------------------------------------------------------------
describe("refresh: the inspector", () => {
  const classes = async (snapshot: BrowserSnapshot, ids: Record<string, string | null>) => {
    const h = await harness({ first: fakeRuntime(snapshot, ids) });
    await h.command({ action: "connect", applicationId: APP_A });
    return h.command(refresh());
  };
  const page = (hash: string, elements: BrowserSnapshot["elements"]): BrowserSnapshot => ({ url: `http://127.0.0.1:5173/${hash}`, elements });
  it("a trusted candidate needs the id read from the live element, a public registry element of THIS route and role with the highlight operation", async () => {
    const res = await classes(page("#/profile", [{ ref: "@e1", name: "Display name", role: "textbox" }]), { "@e1": "profile.nameInput" });
    expect(res.body.elements).toEqual([{ ref: "@e1", name: "Display name", role: "textbox", route: "profile", status: "trusted", targetId: "profile.nameInput", operations: ["highlight", "input", "focus"], privacy: "public" }]);
  });
  it.each([
    ["no data-ai-id", { "@e1": null }, "textbox"],
    ["an unknown id", { "@e1": "profile.unknown" }, "textbox"],
    ["a PRIVATE registry element", { "@e1": "profile.emailInput" }, "textbox"],
    ["an id of another route", { "@e1": "settings.advancedToggle" }, "textbox"],
    ["a wrong role", { "@e1": "profile.nameInput" }, "button"],
  ])("is UNREGISTERED for %s, with no target id, no operations and no echo of the id read", async (_name, ids, role) => {
    const res = await classes(page("#/profile", [{ ref: "@e1", name: "Display name", role }]), ids);
    expect(res.body.elements).toEqual([{ ref: "@e1", name: "Display name", role, route: "profile", status: "unregistered" }]);
    for (const word of ["targetId", "operations", "privacy", "profile.", "settings.", "data-ai-id"]) expect(res.raw, word).not.toContain(word);
  });
  it("is UNREGISTERED for a registry element that lacks the highlight operation, even when everything else matches", async () => {
    const noHighlight: RegistryEntry = { ...FIXTURE_ENTRY, id: "nohighlight", registry: { ...FIXTURE_ENTRY.registry, elements: [{ ...FIXTURE_ENTRY.registry.elements[0]!, operations: ["click"] }] } };
    const h = await harness({ extra: [noHighlight], first: fakeRuntime(ordersSnapshot, { "@e5": "orders.exportButton" }) });
    await h.applications.save({ tenantId: TENANT_A, actor: "seed" }, "app-0000000000e1", { ...configB, registryId: "nohighlight" });
    await h.command({ action: "connect", applicationId: "app-0000000000e1" });
    const res = await h.command(refresh("app-0000000000e1"));
    expect(res.body.elements).toEqual([{ ref: "@e5", name: "Export", role: "button", route: "orders", status: "unregistered" }]);
  });
  it("a page that is not one of the application's pages has route null and EVERY candidate is unregistered, even with a registered id", async () => {
    const res = await classes({ url: "http://127.0.0.1:5173/#/not-a-page", elements: [{ ref: "@e1", name: "Display name", role: "textbox" }] }, { "@e1": "profile.nameInput" });
    expect(res.body).toEqual({ url: "http://127.0.0.1:5173/#/not-a-page", route: null, elements: [{ ref: "@e1", name: "Display name", role: "textbox", route: null, status: "unregistered" }] });
  });
  it("a URL with a query string is not a page either (route null)", async () => {
    const res = await classes({ url: "http://127.0.0.1:5173/?x=1#/profile", elements: [{ ref: "@e1", name: "Display name", role: "textbox" }] }, { "@e1": "profile.nameInput" });
    expect((res.body as { route: unknown }).route).toBeNull();
  });
  it("lists at most 64 candidates and leaves out one whose name or role is out of bounds; the runtime is asked ONCE for all ids", async () => {
    const elements = Array.from({ length: 80 }, (_v, index) => ({ ref: `@e${index + 1}` as ElementRef, name: "Display name", role: "textbox" }));
    elements[3] = { ref: "@e4", name: "n".repeat(121), role: "textbox" };
    elements[5] = { ref: "@e6", name: "Display name", role: "r".repeat(41) };
    const h = await harness({ first: fakeRuntime(page("#/profile", elements), Object.fromEntries(elements.map((e) => [e.ref, "profile.nameInput"]))) });
    await h.command({ action: "connect", applicationId: APP_A });
    const res = await h.command(refresh());
    const refs = (res.body.elements as { ref: string }[]).map((e) => e.ref);
    expect(refs).toHaveLength(62);
    expect(refs[0]).toBe("@e1");
    expect(refs).not.toContain("@e4");
    expect(refs).not.toContain("@e6");
    expect(refs).not.toContain("@e65");
    expect(h.runtime.inspectSemanticIds).toHaveBeenCalledOnce();
    expect(h.runtime.inspectSemanticId).not.toHaveBeenCalled();
  });
  it("refresh replaces the snapshot and the candidates wholesale: a ref of the previous refresh is gone, and a failed refresh leaves no candidates", async () => {
    const h = await harness();
    await h.connect();
    await h.command(refresh());
    h.runtime.snapshotValue = { url: "http://127.0.0.1:5173/#/settings", elements: [{ ref: "@e30", name: "Advanced", role: "button" }] };
    h.runtime.ids = { "@e30": "settings.advancedToggle" };
    expect((await h.command(refresh())).body).toMatchObject({ route: "settings", elements: [{ ref: "@e30", status: "trusted", targetId: "settings.advancedToggle" }] });
    expect((await h.command(target("highlight", "@e21"))).body).toEqual({ error: "REF_NOT_FOUND" });
    vi.mocked(h.runtime.snapshot).mockRejectedValueOnce(new BrowserRuntimeError("SNAPSHOT_FAILED"));
    expect((await h.command(refresh())).body).toEqual({ error: "SNAPSHOT_FAILED" });
    expect((await h.command(target("highlight", "@e30"))).body, "the failed refresh dropped the previous candidates").toEqual({ error: "REF_NOT_FOUND" });
  });
  it("the reply holds only the contract fields: no snapshot text, no observation, no labels list, no origins", async () => {
    const h = await harness({ first: fakeRuntime({ ...profileSnapshot, observation: "profile.saved" } as BrowserSnapshot) });
    await h.connect();
    const res = await h.command(refresh());
    expect(Object.keys(res.body).sort()).toEqual(["elements", "route", "url"]);
    expect(res.raw).not.toContain("observation");
    expect(res.raw).not.toContain("allowedOrigins");
    expect(res.raw).not.toContain("labels");
  });
});

// --- highlight and capture ---------------------------------------------------------------------------------------------------------------------------
describe("highlight and capture (\"Use\")", () => {
  const ready = async () => { const h = await harness(); await h.connect(); await h.command(refresh()); return h; };
  it("highlight re-verifies, highlights and persists NOTHING: no store write, no capture fields", async () => {
    const h = await ready();
    const writes = vi.spyOn(h.applications, "save");
    const enable = vi.spyOn(h.applications, "setEnabled");
    const res = await h.command(target("highlight", "@e21"));
    expect(res.body).toEqual({ highlighted: true, ref: "@e21" });
    expect(h.runtime.inspectSemanticId).toHaveBeenCalledWith("@e21", h.runtime.snapshotValue);
    expect(h.runtime.highlight).toHaveBeenCalledWith("@e21", h.runtime.snapshotValue);
    expect(writes).not.toHaveBeenCalled();
    expect(enable).not.toHaveBeenCalled();
    for (const word of ["targetId", "operations", "route", "role", "name", "profile.nameInput"]) expect(res.raw, word).not.toContain(word);
  });
  it("capture returns the registry id, route, name, role and operations of a trusted candidate only, after re-verifying and highlighting", async () => {
    const h = await ready();
    const res = await h.command(target("capture", "@e22"));
    expect(res.body).toEqual({ targetId: "profile.saveButton", route: "profile", name: "Save", role: "button", operations: ["highlight", "click"] });
    expect(h.runtime.inspectSemanticId).toHaveBeenCalledWith("@e22", h.runtime.snapshotValue);
    expect(h.runtime.highlight).toHaveBeenCalledWith("@e22", h.runtime.snapshotValue);
    expect(JSON.stringify(res.body)).not.toContain("@e22");
  });
  it.each(["highlight", "capture"] as const)("%s of an UNREGISTERED candidate is 409 TARGET_UNAVAILABLE and never touches the runtime", async (action) => {
    const h = await harness({ first: fakeRuntime(profileSnapshot, { "@e21": null, "@e22": "profile.emailInput" }) });
    await h.connect();
    await h.command(refresh());
    for (const ref of ["@e21", "@e22"]) {
      const res = await h.command(target(action, ref));
      expect([res.status, res.body]).toEqual([409, { error: "TARGET_UNAVAILABLE" }]);
      for (const word of ["profile.", "@e22", "emailInput", "data-ai-id"]) expect(res.raw, word).not.toContain(word);
    }
    expect(h.runtime.inspectSemanticId).not.toHaveBeenCalled();
    expect(h.runtime.highlight).not.toHaveBeenCalled();
  });
  it.each(["highlight", "capture"] as const)("%s of a ref that is not in the last refresh (or before any refresh) is 409 REF_NOT_FOUND", async (action) => {
    const fresh = await harness();
    await fresh.connect();
    expect((await fresh.command(target(action, "@e21"))).body, "before any refresh").toEqual({ error: "REF_NOT_FOUND" });
    const h = await ready();
    expect((await h.command(target(action, "@e999"))).body).toEqual({ error: "REF_NOT_FOUND" });
    expect(h.runtime.inspectSemanticId).not.toHaveBeenCalled();
    expect(h.runtime.highlight).not.toHaveBeenCalled();
  });
  it.each(["highlight", "capture"] as const)("%s re-verifies: a stale snapshot (the adapter says REF_NOT_FOUND) is 409 REF_NOT_FOUND, a CHANGED id is 409 TARGET_UNAVAILABLE, and neither highlights", async (action) => {
    const stale = await ready();
    vi.mocked(stale.runtime.inspectSemanticId).mockRejectedValueOnce(new BrowserRuntimeError("REF_NOT_FOUND"));
    expect((await stale.command(target(action, "@e21"))).body).toEqual({ error: "REF_NOT_FOUND" });
    const changed = await ready();
    changed.runtime.ids["@e21"] = "profile.emailInput";
    expect((await changed.command(target(action, "@e21"))).body).toEqual({ error: "TARGET_UNAVAILABLE" });
    changed.runtime.ids["@e21"] = null;
    expect((await changed.command(target(action, "@e21"))).body).toEqual({ error: "TARGET_UNAVAILABLE" });
    changed.runtime.ids["@e21"] = "profile.saveButton"; // a different, valid id is still a change
    expect((await changed.command(target(action, "@e21"))).body).toEqual({ error: "TARGET_UNAVAILABLE" });
    expect(stale.runtime.highlight).not.toHaveBeenCalled();
    expect(changed.runtime.highlight).not.toHaveBeenCalled();
    // The session stays open after these refusals.
    changed.runtime.ids["@e21"] = "profile.nameInput";
    expect((await changed.command(target(action, "@e21"))).status).toBe(200);
  });
  it("a highlight failure is 503 HIGHLIGHT_FAILED with the session kept, and a stale element at highlight time is 409 REF_NOT_FOUND", async () => {
    const h = await ready();
    vi.mocked(h.runtime.highlight).mockRejectedValueOnce(new BrowserRuntimeError("HIGHLIGHT_FAILED"));
    expect((await h.command(target("capture", "@e21"))).body).toEqual({ error: "HIGHLIGHT_FAILED" });
    vi.mocked(h.runtime.highlight).mockRejectedValueOnce(new BrowserRuntimeError("REF_NOT_FOUND"));
    expect((await h.command(target("capture", "@e21"))).body).toEqual({ error: "REF_NOT_FOUND" });
    expect((await h.command(target("capture", "@e21"))).status).toBe(200);
    expect(h.runtime.close).not.toHaveBeenCalled();
  });
  it("refs are dropped when the session is disconnected: a later command is SESSION_CLOSED, and a new session starts with none", async () => {
    const h = await harness({ ids: ["one", "two"] });
    await h.connect();
    await h.command(refresh(APP_A, "one"));
    await h.command(disconnect(APP_A, "one"));
    for (const body of [refresh(APP_A, "one"), target("highlight", "@e21", APP_A, "one"), target("capture", "@e21", APP_A, "one")]) expect((await h.command(body)).body).toEqual({ error: "SESSION_CLOSED" });
    await h.connect();
    expect((await h.command(target("highlight", "@e21", APP_A, "two"))).body, "a new session has no candidates until it refreshes").toEqual({ error: "REF_NOT_FOUND" });
  });
});

// --- the closed error mapping ------------------------------------------------------------------------------------------------------------------------
describe("error mapping", () => {
  const CODES = ["BROWSER_NOT_STARTED", "BROWSER_BUSY", "BROWSER_TIMEOUT", "SNAPSHOT_FAILED", "REF_NOT_FOUND", "HIGHLIGHT_FAILED", "NAVIGATION_FAILED", "DOMAIN_BLOCKED", "SESSION_CLOSED", "CLOSE_FAILED", "INVALID_BROWSER_OUTPUT"] as const;
  const expected = (code: (typeof CODES)[number]): [number, string] => (code === "REF_NOT_FOUND" || code === "BROWSER_BUSY" ? [409, code] : code === "SESSION_CLOSED" ? [404, code] : [503, code]);
  it.each(CODES)("a runtime error %s maps to its fixed status and code, never its text", async (code) => {
    const h = await harness();
    await h.connect();
    vi.mocked(h.runtime.snapshot).mockRejectedValueOnce(new BrowserRuntimeError(code));
    const res = await h.command(refresh());
    expect([res.status, res.body]).toEqual([expected(code)[0], { error: expected(code)[1] }]);
    expectNoLeak(res.raw);
    expect(res.raw).not.toMatch(/approved|origin|closed\.|timed out/i);
    // The session stays open for everything except SESSION_CLOSED (which clears the host session).
    const next = await h.command(refresh());
    if (code === "SESSION_CLOSED") expect(next.body).toEqual({ error: "SESSION_CLOSED" });
    else { expect(next.status).toBe(200); expect(h.runtime.close).not.toHaveBeenCalled(); }
  });
  it("any other exception (CLI text, a path, a blocked URL) is 503 BROWSER_UNAVAILABLE with nothing of it in the reply, on every command", async () => {
    for (const action of ["refresh", "highlight", "capture"] as const) {
      const h = await harness();
      await h.connect();
      await h.command(refresh());
      vi.mocked(h.runtime.snapshot).mockRejectedValue(new Error(SECRET));
      vi.mocked(h.runtime.inspectSemanticId).mockRejectedValue(new Error(SECRET));
      const res = await h.command(action === "refresh" ? refresh() : target(action, "@e21"));
      expect([res.status, res.body]).toEqual([503, { error: "BROWSER_UNAVAILABLE" }]);
      expectNoLeak(res.raw);
    }
  });
  it("an inspector failure during refresh (the batch read drifts) is 409 REF_NOT_FOUND and leaves no candidates", async () => {
    const h = await harness();
    await h.connect();
    vi.mocked(h.runtime.inspectSemanticIds).mockRejectedValueOnce(new BrowserRuntimeError("REF_NOT_FOUND"));
    expect((await h.command(refresh())).body).toEqual({ error: "REF_NOT_FOUND" });
    expect((await h.command(target("highlight", "@e21"))).body).toEqual({ error: "REF_NOT_FOUND" });
    expect((await h.command(refresh())).status).toBe(200);
  });
  it("a failing close on disconnect is mapped (CLOSE_FAILED) and the session is kept for a retry by the idle timer or a new disconnect", async () => {
    const h = await harness();
    await h.connect();
    vi.mocked(h.runtime.close).mockRejectedValueOnce(new BrowserRuntimeError("CLOSE_FAILED"));
    expect((await h.command(disconnect())).body).toEqual({ error: "CLOSE_FAILED" });
    expect((await h.command(disconnect())).body).toEqual({ closed: true });
  });
  it("replies never carry the allowed origins list or the registry labels, on any command", async () => {
    const h = await harness();
    const connected = await h.command({ action: "connect", applicationId: APP_B });
    const everything = JSON.stringify([connected.body]);
    for (const word of ["localhost:5185", "allowedOrigins", "labels", "pages", "routes"]) expect(everything, word).not.toContain(word);
  });
});

// --- the idle clock measures the OWNER's activity only -------------------------------------------------------------------------------------------------------
describe("idle clock", () => {
  const minutes = (n: number) => n * 60_000;
  const timers = () => vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });

  it("closes five idle minutes after the owner's last command, whatever another maintainer or tenant sends meanwhile (rejected connects do not extend it)", async () => {
    timers();
    const { command, runtime } = await harness();
    expect((await command({ action: "connect", applicationId: APP_A })).status).toBe(200);
    await vi.advanceTimersByTimeAsync(minutes(4));
    expect((await command({ action: "connect", applicationId: APP_A }, "tenant-b")).body).toEqual({ error: "BROWSER_BUSY" });
    expect((await command({ action: "connect", applicationId: APP_A }, "another-maintainer")).body).toEqual({ error: "BROWSER_BUSY" });
    await vi.advanceTimersByTimeAsync(minutes(1) + 1);
    expect(runtime.close).toHaveBeenCalledOnce();
  });
  it("a probe every four minutes by somebody else never keeps a forgotten session open", async () => {
    timers();
    const { command, runtime } = await harness();
    await command({ action: "connect", applicationId: APP_A });
    for (let round = 0; round < 3; round += 1) {
      await vi.advanceTimersByTimeAsync(minutes(4));
      await command({ action: "connect", applicationId: APP_A }, "tenant-b");
    }
    expect(runtime.close).toHaveBeenCalledOnce(); // closed at minute five, not extended by the probes at minutes four, eight and twelve
  });
  it("a command with somebody else's session id, an invalid body, a user without the permission and an unauthenticated request do not extend it", async () => {
    timers();
    const { command, runtime } = await harness();
    await command({ action: "connect", applicationId: APP_A });
    await vi.advanceTimersByTimeAsync(minutes(4));
    expect((await command(refresh(), "another-maintainer")).body).toEqual({ error: "SESSION_CLOSED" });
    expect((await command({ action: "refresh" })).status).toBe(400);
    expect((await command(refresh(), "user")).status).toBe(403);
    expect((await command(refresh(), "expired")).status).toBe(401);
    expect(runtime.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(minutes(1) + 1);
    expect(runtime.close).toHaveBeenCalledOnce();
  });
  it("the page-reload case: an owner who lost the session id can connect again once five minutes have passed since their last real command, even while clicking Connect every minute", async () => {
    timers();
    const { command } = await harness();
    await command({ action: "connect", applicationId: APP_A });
    for (let minute = 1; minute < 5; minute += 1) {
      await vi.advanceTimersByTimeAsync(minutes(1));
      expect((await command({ action: "connect", applicationId: APP_A })).body).toEqual({ error: "BROWSER_BUSY" });
    }
    await vi.advanceTimersByTimeAsync(minutes(1) + 1);
    expect((await command({ action: "connect", applicationId: APP_A })).status).toBe(200);
  });
  it("owner activity extends it: every command that matches owner, session and application restarts the five minutes (also one that the runtime then fails)", async () => {
    timers();
    const { command, runtime } = await harness();
    await command({ action: "connect", applicationId: APP_A });
    await vi.advanceTimersByTimeAsync(minutes(4));
    expect((await command(refresh())).status).toBe(200);
    await vi.advanceTimersByTimeAsync(minutes(4));
    vi.mocked(runtime.snapshot).mockRejectedValueOnce(new BrowserRuntimeError("SNAPSHOT_FAILED"));
    expect((await command(refresh())).status).toBe(503);
    await vi.advanceTimersByTimeAsync(minutes(4));
    expect((await command({ action: "refresh", sessionId: "session", applicationId: APP_B })).body, "a wrong application id is a mismatch, not activity").toEqual({ error: "APPLICATION_MISMATCH" });
    expect(runtime.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(minutes(1) + 1);
    expect(runtime.close).toHaveBeenCalledOnce();
  });
  it("a successful connect starts the clock; a connect that fails to open leaves no session and no timer to extend", async () => {
    timers();
    const first = fakeRuntime();
    first.start = vi.fn(async () => { throw new BrowserRuntimeError("NAVIGATION_FAILED"); });
    const { command } = await harness({ first });
    expect((await command({ action: "connect", applicationId: APP_A })).status).toBe(503);
    expect((await command({ action: "connect", applicationId: APP_A })).status, "the half-open session was cleaned up").toBe(200);
  });
  it("if a command is in flight when the clock runs out, the close is retried shortly instead of waiting another five minutes", async () => {
    timers();
    const { command, runtime } = await harness();
    await command({ action: "connect", applicationId: APP_A });
    await vi.advanceTimersByTimeAsync(minutes(4) + 59_000);
    let release: () => void = () => {};
    vi.mocked(runtime.snapshot).mockImplementationOnce(() => new Promise<BrowserSnapshot>((resolve) => { release = () => resolve(profileSnapshot); }));
    const slow = command(refresh()); // the owner's command, in flight when the old clock fires
    await vi.waitFor(() => expect(runtime.snapshot).toHaveBeenCalled());
    await vi.advanceTimersByTimeAsync(2_000);
    release();
    expect((await slow).status).toBe(200);
    expect(runtime.close).not.toHaveBeenCalled(); // the owner's command restarted the clock
    await vi.advanceTimersByTimeAsync(minutes(5) + 1);
    expect(runtime.close).toHaveBeenCalledOnce();
  });
});
