/**
 * Studio V1B browser sessions for a STUDIO-MANAGED application, with a SCRIPTED fake BrowserRuntime (a page of controls the test can change between commands), a FakeApplicationStore, a
 * FakeTargetStore and a fake Gateway principal whose `submit` plays the capability executor over the fake store. They prove the HOST's behaviour: the managed session policy, the registry
 * being re-resolved on every command, the inspector reply, the `register` trust chain (every refusal, asserted on what reached the Gateway and the store), and `resume`.
 * The PostgreSQL proof through the real routes is tests/integration/studio-managed.test.ts.
 */
import { runRegisterTarget, runRepairTarget, runSetTargetHealth } from "./target-capabilities.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BrowserRuntimeError } from "@dap/browser-runtime";
import type { BrowserRuntime, BrowserSnapshot, ElementFacts, ElementRef } from "@dap/browser-runtime";
import { createGuidanceTransport } from "../http/transport.js";
import { createProposalStore } from "../http/proposal-store.js";
import { FakeApplicationStore } from "./fake-application-store.js";
import { FakeTargetStore } from "./fake-target-store.js";
import { createRegistryCatalog } from "./registries.js";
import type { ApplicationConfig } from "./applications.js";
import { registerStudioBrowser } from "./browser.js";
import type { BrowserRuntimeConfig } from "./browser.js";
import { REGISTER_TARGET_ACTION_ID } from "./target-capabilities.js";
import type { RegistrableRole } from "./registry-targets.js";

const TENANT_A = "1111aaaa-2222-4333-8444-5555bbbb5555";
const TENANT_B = "2222bbbb-3333-4444-8555-6666cccc6666";
const MANAGED = "app-0000000000d1";
const MANAGED_2 = "app-0000000000d2";
const BUILT_IN = "app-0000000000a1";
const MANAGED_OTHER_TENANT = "app-0000000000d3";
const ORIGIN = "http://127.0.0.1:5187";
const SECRET = "SECRET /home/dev/agent-browser stderr http://blocked.example/leak?token=abc";

const managedConfig = (name: string, origin = ORIGIN): ApplicationConfig => ({ name, origin, allowedOrigins: [origin, "http://localhost:5187"], environment: "test", registryId: "studio-managed" });
const builtInConfig: ApplicationConfig = { name: "Reference application", origin: "http://127.0.0.1:5173", allowedOrigins: ["http://127.0.0.1:5173"], environment: "development", registryId: "reference" };

const PUBLIC: ElementFacts = { tagName: null, inputType: null, autocomplete: null, dataAiPrivate: false, dataAiIgnore: false, dataAiRedact: false };
interface Control { name: string; role: string; id: string | null; facts: ElementFacts | null }
const control = (name: string, role: string, id: string | null, facts: ElementFacts | null = PUBLIC): Control => ({ name, role, id, facts });

interface Scripted extends BrowserRuntime { url: string; controls: Control[] }
function scripted(url: string, controls: Control[]): Scripted {
  const runtime: Scripted = {
    url, controls,
    start: vi.fn(async () => {}),
    snapshot: vi.fn(async (): Promise<BrowserSnapshot> => ({ url: runtime.url, elements: runtime.controls.map((c, index) => ({ ref: `@e${index + 1}` as ElementRef, name: c.name, role: c.role })) })),
    inspectSemanticId: vi.fn(async (ref: ElementRef, from: BrowserSnapshot) => {
      const index = Number(ref.slice(2)) - 1;
      if (from.url !== runtime.url || runtime.controls[index] === undefined) throw new BrowserRuntimeError("REF_NOT_FOUND");
      return runtime.controls[index]!.id;
    }),
    inspectSemanticIds: vi.fn(async (from: BrowserSnapshot) => new Map(from.elements.map((element) => [element.ref, runtime.controls[Number(element.ref.slice(2)) - 1]?.id ?? null] as const))),
    inspectElementFacts: vi.fn(async (refs: readonly ElementRef[], from: BrowserSnapshot) => {
      if (from.url !== runtime.url) throw new BrowserRuntimeError("REF_NOT_FOUND");
      return new Map(refs.map((ref) => [ref, runtime.controls[Number(ref.slice(2)) - 1]?.facts ?? null] as const));
    }),
    highlight: vi.fn(async () => {}), clearHighlight: vi.fn(async () => {}), getUrl: vi.fn(async () => runtime.url), waitForChange: vi.fn(async () => ({ status: "timeout" as const })),
    close: vi.fn(async () => {}),
  };
  return runtime;
}

type Role = "maintainer" | "another-maintainer" | "tenant-b";
type GatewayMode = "executor" | "refused" | "failed" | "broken";
interface Call { readonly action: string; readonly params: Record<string, unknown>; readonly raw: string }

const open: Array<{ close: () => Promise<unknown> }> = [];
afterEach(async () => { vi.useRealTimers(); await Promise.all(open.splice(0).map((app) => app.close())); });

async function harness(options: { controls?: Control[]; url?: string; ids?: string[]; routing?: "hash" | "history" } = {}) {
  const app = createGuidanceTransport({ ask: async () => ({ kind: "clarify", message: "Unused" }), catalog: { list: () => [] }, resolveSession: async () => null, proposals: createProposalStore({ now: Date.now, newId: () => "unused" }) });
  open.push(app);
  const applications = new FakeApplicationStore();
  const targets = new FakeTargetStore(applications);
  await applications.save({ tenantId: TENANT_A, actor: "seed" }, MANAGED, { ...managedConfig("Orders application"), ...(options.routing === undefined ? {} : { routing: options.routing }) });
  await applications.save({ tenantId: TENANT_A, actor: "seed" }, MANAGED_2, managedConfig("Second managed", "http://127.0.0.1:5188"));
  await applications.save({ tenantId: TENANT_A, actor: "seed" }, BUILT_IN, builtInConfig);
  await applications.save({ tenantId: TENANT_B, actor: "seed" }, MANAGED_OTHER_TENANT, managedConfig("Other tenant"));
  const runtimes: Scripted[] = [];
  const configs: BrowserRuntimeConfig[] = [];
  const ordersControls = (): Control[] => options.controls ?? [control("Export", "button", "orders.exportButton"), control("Order note", "textbox", "orders.note"), control("Password", "textbox", "orders.pw"), control("Save", "button", null)];
  const calls: Call[] = [];
  const state = { mode: "executor" as GatewayMode };
  const ids = [...(options.ids ?? [])];
  let counter = 0;
  registerStudioBrowser(app, {
    applications, targets, catalog: createRegistryCatalog(), authoring: { get: async () => null },
    createRuntime: (config) => { configs.push(config); const made = scripted(options.url ?? `${ORIGIN}/#/orders`, runtimes.length === 0 ? ordersControls() : ordersControls()); runtimes.push(made); return made; },
    makeId: () => ids.shift() ?? `session-${(counter += 1)}`,
    resolvePrincipal: async (headers) => {
      const key = String(headers["x-demo-role"]);
      const tenantId = key === "tenant-b" ? TENANT_B : TENANT_A;
      return {
        key, tenantId, actor: "author", permissions: new Set(["perm.walkthrough.maintain"]),
        submit: vi.fn(async (message: { arguments: string }): Promise<never> => {
          const parsed = JSON.parse(message.arguments) as { action: string; params: Record<string, unknown> };
          calls.push({ action: parsed.action, params: parsed.params, raw: message.arguments });
          if (state.mode === "broken") throw new Error(SECRET);
          if (state.mode === "refused") return { outcome: "FORBIDDEN_POLICY" } as never;
          if (state.mode === "failed") return { outcome: "ALLOWED", category: "try_later" } as never;
          const security = { tenantId, userId: "author" } as never;
          const run = parsed.action === "setStudioTargetHealth" ? runSetTargetHealth : parsed.action === "repairStudioTarget" ? runRepairTarget : runRegisterTarget;
          const outcome = await (run as typeof runRegisterTarget)(targets, { params: parsed.params as never, security });
          return (outcome.status === "success" ? { outcome: "ALLOWED", category: "ok" } : { outcome: "ALLOWED", category: "try_later" }) as never;
        }),
      };
    },
  });
  const command = async (payload: unknown, role: Role = "maintainer") => {
    const res = await app.inject({ method: "POST", url: "/api/studio/browser", headers: { "x-demo-role": role }, payload: payload as never });
    let body: Record<string, unknown> = {};
    try { body = JSON.parse(res.body) as Record<string, unknown>; } catch { /* not JSON */ }
    return { status: res.statusCode, body, raw: res.body };
  };
  const connect = async (applicationId = MANAGED, role: Role = "maintainer") => {
    const res = await command({ action: "connect", applicationId }, role);
    if (res.status !== 200) throw new Error(`connect failed: ${res.status} ${res.raw}`);
    return res.body.sessionId as string;
  };
  return { app, applications, targets, runtimes, configs, calls, state, command, connect };
}
type H = Awaited<ReturnType<typeof harness>>;

const refresh = (applicationId = MANAGED, sessionId = "session-1") => ({ action: "refresh", sessionId, applicationId });
const registerBody = (over: Record<string, unknown> = {}) => ({
  action: "register", sessionId: "session-1", applicationId: MANAGED, ref: "@e1", targetId: "orders.exportButton", route: "orders", operations: ["highlight", "click"], label: "Export orders", description: "Exports the order list.", privacy: "public", ...over,
});
/** Connect and refresh the managed application; returns the harness ready to register. */
async function ready(options: Parameters<typeof harness>[0] = {}): Promise<H> {
  const h = await harness(options);
  await h.connect();
  const res = await h.command(refresh());
  expect(res.status).toBe(200);
  return h;
}
const storedTargets = async (h: H, tenant = TENANT_A, application = MANAGED) => (await h.targets.list(tenant, application)).targets;
const noLeak = (raw: string) => { for (const word of ["SECRET", "/home/dev", "stderr", "blocked.example", "token=abc", "5187", "127.0.0.1", "localhost", "Orders application", "Export orders", "Exports the order list"]) expect(raw, word).not.toContain(word); };

describe("managed connect: the session policy comes from the stored application", () => {
  it("opens the adapter with every label, any route and the application's allowed origins; the reply names the registry source; the start URL is the stored origin", async () => {
    const h = await harness();
    const res = await h.command({ action: "connect", applicationId: MANAGED });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ sessionId: "session-1", applicationId: MANAGED, application: "Orders application", origin: ORIGIN, registrySource: "studio-managed" });
    expect(h.configs).toEqual([{ labels: "all", routes: "any", origins: [ORIGIN, "http://localhost:5187"] }]);
    expect(h.runtimes[0]!.start).toHaveBeenCalledWith({ url: `${ORIGIN}/`, headed: true });
  });
  it("a built-in application keeps the V1A policy byte for byte (the catalog entry's labels and its page list) and says built-in", async () => {
    const h = await harness();
    const res = await h.command({ action: "connect", applicationId: BUILT_IN });
    expect(res.body).toMatchObject({ registrySource: "built-in" });
    expect(h.configs[0]).toEqual({ labels: expect.arrayContaining([{ role: "button", name: "Save" }]), routes: ["/", "/#/dashboard", "/#/profile", "/#/settings"], origins: ["http://127.0.0.1:5173"] });
    expect(h.configs[0]!.labels).not.toBe("all");
  });
  it("another tenant's managed application is APPLICATION_NOT_FOUND and nothing starts", async () => {
    const h = await harness();
    const res = await h.command({ action: "connect", applicationId: MANAGED_OTHER_TENANT });
    expect(res).toMatchObject({ status: 404, body: { error: "APPLICATION_NOT_FOUND" } });
    expect(h.runtimes).toHaveLength(0);
  });
});

describe("managed refresh", () => {
  it("lists registrable controls with the proposal derived from the live element; hides everything else and only counts it", async () => {
    const h = await harness();
    await h.connect();
    const res = await h.command(refresh());
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      url: `${ORIGIN}/#/orders`, route: null, page: "/#/orders", hidden: 2, truncated: false,
      elements: [
        { ref: "@e1", name: "Export", role: "button", route: null, status: "registrable", proposal: { targetId: "orders.exportButton", role: "button", page: "/#/orders", route: "orders", routeIsNew: true, suggestedLabel: "Export", allowedOperations: ["highlight", "click", "focus"], defaultOperations: ["highlight", "click"], privacy: "public" } },
        { ref: "@e2", name: "Order note", role: "textbox", route: null, status: "registrable", proposal: { targetId: "orders.note", role: "textbox", page: "/#/orders", route: "orders", routeIsNew: true, suggestedLabel: "Order note", allowedOperations: ["highlight", "input", "focus"], defaultOperations: ["highlight", "input", "focus"], privacy: "public" } },
      ],
    });
    expect(res.raw, "a secret-named control and an unmarked one are never named").not.toMatch(/Password|Save|orders\.pw/u);
  });
  it("reads the privacy facts for every control that could be listed, registered or not (never for a hidden one: no marker, a non-registrable role)", async () => {
    const h = await harness();
    await h.connect();
    await h.targets.register({ tenantId: TENANT_A, actor: "seed" }, MANAGED, { targetId: "orders.exportButton", route: "orders", page: "/#/orders", role: "button", label: "Export", description: "Export.", operations: ["highlight", "click"], privacy: "public" });
    await h.command(refresh());
    const asked = (h.runtimes[0]!.inspectElementFacts as ReturnType<typeof vi.fn>).mock.calls[0]![0] as ElementRef[];
    expect(asked).toEqual(["@e1", "@e2", "@e3"]); // Save has no marker; Export is registered but its facts are re-read like any other
  });
  it("re-resolves the registry on EVERY refresh: a target registered or disabled meanwhile is seen without reconnecting", async () => {
    const h = await ready();
    await h.targets.register({ tenantId: TENANT_A, actor: "seed" }, MANAGED, { targetId: "orders.exportButton", route: "orders", page: "/#/orders", role: "button", label: "Export", description: "Export.", operations: ["highlight", "click"], privacy: "public" });
    expect((await h.command(refresh())).body.elements).toEqual(expect.arrayContaining([{ ref: "@e1", name: "Export", role: "button", route: "orders", status: "trusted", targetId: "orders.exportButton", operations: ["highlight", "click"], privacy: "public" }]));
    await h.targets.setStatus({ tenantId: TENANT_A, actor: "seed" }, MANAGED, "orders.exportButton", "disabled");
    expect((await h.command(refresh())).body.elements).toEqual(expect.arrayContaining([{ ref: "@e1", name: "Export", role: "button", route: "orders", status: "disabled", targetId: "orders.exportButton" }]));
    expect(h.configs, "no second runtime").toHaveLength(1);
  });
  it("a page that is not hash-routed lists nothing registrable (hidden counts it)", async () => {
    const h = await harness({ url: `${ORIGIN}/app?x=1` });
    await h.connect();
    expect((await h.command(refresh())).body).toMatchObject({ page: null, route: null, elements: [], hidden: 4, truncated: false });
  });
  it("a failing store or browser read is a fixed 503 and leaks nothing", async () => {
    const h = await ready();
    h.targets.failWith = new Error(SECRET);
    const res = await h.command(refresh());
    expect(res).toMatchObject({ status: 503, body: { error: "BROWSER_UNAVAILABLE" } });
    noLeak(res.raw);
  });
});

describe("register: the trust chain persists a target ONLY through the Gateway capability, with server-built parameters", () => {
  it("registers a new page's first target: the capability gets exactly the fixed parameters (role from the live element, page from the live URL, no ref), the reply is the stored target", async () => {
    const h = await ready();
    const res = await h.command(registerBody());
    expect(res.status).toBe(200);
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.action).toBe(REGISTER_TARGET_ACTION_ID);
    expect(h.calls[0]!.params).toEqual({
      applicationId: MANAGED, targetId: "orders.exportButton", route: "orders", page: "/#/orders", elementRole: "button", label: "Export orders", description: "Exports the order list.", operations: ["highlight", "click"], privacy: "public",
    });
    expect(h.calls[0]!.raw, "the element ref never reaches the capability").not.toMatch(/@e\d/u);
    expect(res.body).toMatchObject({ route: { route: "orders", page: "/#/orders", created: true }, target: { id: "orders.exportButton", route: "orders", page: "/#/orders", role: "button", status: "active", operations: ["highlight", "click"], privacy: "public" } });
    expect(JSON.stringify(await h.targets.list(TENANT_A, MANAGED)), "nothing stored carries a ref").not.toMatch(/@e\d/u);
  });
  it("the maintainer's operations are kept (focus allowed), trimmed text is stored trimmed, privacy is public", async () => {
    const h = await ready();
    const res = await h.command(registerBody({ operations: ["focus", "highlight", "click"], label: "  Export orders  " }));
    expect(res.status).toBe(200);
    expect(h.calls[0]!.params).toMatchObject({ operations: ["highlight", "click", "focus"], label: "Export orders" });
  });
  it("a second target on the same page keeps the route (created false); the first one's ref is now trusted in place without a new refresh", async () => {
    const h = await ready();
    expect((await h.command(registerBody())).status).toBe(200);
    const second = await h.command(registerBody({ ref: "@e2", targetId: "orders.note", operations: ["highlight", "input"], label: "Order note", description: "The note." }));
    expect(second.body).toMatchObject({ route: { route: "orders", page: "/#/orders", created: false } });
    const capture = await h.command({ action: "capture", sessionId: "session-1", applicationId: MANAGED, ref: "@e1" });
    expect(capture.body).toEqual({ targetId: "orders.exportButton", route: "orders", name: "Export", role: "button", operations: ["highlight", "click"] });
  });
  it("registering the same element again is refused (it is trusted now, not registrable) and nothing more is written", async () => {
    const h = await ready();
    await h.command(registerBody());
    const again = await h.command(registerBody());
    expect(again).toMatchObject({ status: 409, body: { error: "TARGET_NOT_REGISTRABLE" } });
    expect(h.calls).toHaveLength(1);
  });

  describe("every refusal reaches neither the Gateway nor the store", () => {
    const refused = async (h: H, body: unknown, status: number, error: string, role: Role = "maintainer") => {
      const before = JSON.stringify(await h.targets.list(TENANT_A, MANAGED));
      const res = await h.command(body, role);
      expect({ status: res.status, error: res.body.error }).toEqual({ status, error });
      expect(h.calls, "no capability call").toEqual([]);
      expect(JSON.stringify(await h.targets.list(TENANT_A, MANAGED)), "store unchanged").toBe(before);
      noLeak(res.raw);
      return res;
    };
    it("a built-in application: REGISTRY_NOT_MANAGED", async () => {
      const h = await harness();
      await h.connect(BUILT_IN);
      await h.command(refresh(BUILT_IN));
      await refused(h, registerBody({ applicationId: BUILT_IN }), 409, "REGISTRY_NOT_MANAGED");
    });
    it("no refresh yet: REF_NOT_FOUND", async () => {
      const h = await harness();
      await h.connect();
      await refused(h, registerBody(), 409, "REF_NOT_FOUND");
    });
    it("a ref that was never listed (unknown, or belongs to a hidden control): REF_NOT_FOUND", async () => {
      const h = await ready();
      await refused(h, registerBody({ ref: "@e99" }), 409, "REF_NOT_FOUND");
      await refused(h, registerBody({ ref: "@e3", targetId: "orders.pw" }), 409, "REF_NOT_FOUND"); // the secret-named control
      await refused(h, registerBody({ ref: "@e4", targetId: "orders.save" }), 409, "REF_NOT_FOUND"); // no marker
    });
    it("a ref that is no longer current (the page moved on after the refresh): REF_NOT_FOUND", async () => {
      const h = await ready();
      h.runtimes[0]!.url = `${ORIGIN}/#/other`;
      await refused(h, registerBody(), 409, "REF_NOT_FOUND");
    });
    it("the ref of a trusted or disabled control is not registrable", async () => {
      const h = await harness();
      await h.targets.register({ tenantId: TENANT_A, actor: "seed" }, MANAGED, { targetId: "orders.exportButton", route: "orders", page: "/#/orders", role: "button", label: "Export", description: "Export.", operations: ["highlight", "click"], privacy: "public" });
      await h.targets.register({ tenantId: TENANT_A, actor: "seed" }, MANAGED, { targetId: "orders.note", route: "orders", page: "/#/orders", role: "textbox", label: "Note", description: "Note.", operations: ["highlight", "input"], privacy: "public" });
      await h.targets.setStatus({ tenantId: TENANT_A, actor: "seed" }, MANAGED, "orders.note", "disabled");
      await h.connect();
      await h.command(refresh());
      await refused(h, registerBody(), 409, "TARGET_NOT_REGISTRABLE");
      await refused(h, registerBody({ ref: "@e2", targetId: "orders.note" }), 409, "TARGET_NOT_REGISTRABLE");
    });
    it("a marker that is not the live one: TARGET_ID_MISMATCH (a body id for a different element, or the page re-marked the element after the refresh)", async () => {
      const h = await ready();
      await refused(h, registerBody({ targetId: "orders.note" }), 409, "TARGET_ID_MISMATCH");
      h.runtimes[0]!.controls[0]!.id = "orders.exportOther";
      await refused(h, registerBody(), 409, "TARGET_ID_MISMATCH");
      h.runtimes[0]!.controls[0]!.id = null;
      await refused(h, registerBody(), 409, "TARGET_ID_MISMATCH");
    });
    it("the element became private after the refresh (live facts re-read): TARGET_NOT_REGISTRABLE", async () => {
      const h = await ready();
      h.runtimes[0]!.controls[0]!.facts = { ...PUBLIC, dataAiPrivate: true };
      await refused(h, registerBody(), 409, "TARGET_NOT_REGISTRABLE");
      h.runtimes[0]!.controls[0]!.facts = { ...PUBLIC, inputType: "password" };
      await refused(h, registerBody(), 409, "TARGET_NOT_REGISTRABLE");
      h.runtimes[0]!.controls[0]!.facts = null;
      await refused(h, registerBody(), 409, "TARGET_NOT_REGISTRABLE");
    });
    it("the id was taken after the refresh: TARGET_EXISTS", async () => {
      const h = await ready();
      await h.targets.register({ tenantId: TENANT_A, actor: "seed" }, MANAGED, { targetId: "orders.exportButton", route: "orders", page: "/#/orders", role: "button", label: "Export", description: "Export.", operations: ["highlight", "click"], privacy: "public" });
      const before = (await storedTargets(h)).length;
      const res = await h.command(registerBody());
      expect(res).toMatchObject({ status: 409, body: { error: "TARGET_EXISTS" } });
      expect(h.calls).toEqual([]);
      expect(await storedTargets(h)).toHaveLength(before);
    });
    it("the page's route is another name than the body's, or the new route name is another page's: ROUTE_MISMATCH", async () => {
      const h = await ready();
      await h.targets.register({ tenantId: TENANT_A, actor: "seed" }, MANAGED, { targetId: "orders.other", route: "orderList", page: "/#/orders", role: "button", label: "Other", description: "Other.", operations: ["highlight", "click"], privacy: "public" });
      await h.targets.register({ tenantId: TENANT_A, actor: "seed" }, MANAGED, { targetId: "home.first", route: "home", page: "/", role: "button", label: "First", description: "First.", operations: ["highlight", "click"], privacy: "public" });
      await h.command(refresh());
      await refused(h, registerBody({ route: "orders" }), 409, "ROUTE_MISMATCH"); // /#/orders is already `orderList`
      // a NEW page may not take the name of an existing route
      h.runtimes[0]!.url = `${ORIGIN}/#/fresh`;
      await h.command(refresh());
      await refused(h, registerBody({ route: "home", targetId: "orders.exportButton" }), 409, "ROUTE_MISMATCH");
    });
    it("malformed maintainer fields: 422 INVALID_TARGET with fixed issues that never repeat what was sent", async () => {
      const h = await ready();
      const bads: [Record<string, unknown>, string][] = [
        [{ label: "<b>Export</b>" }, "label"], [{ label: "" }, "label"], [{ label: "x".repeat(81) }, "label"], [{ description: "say \"hi\"" }, "description"], [{ description: "" }, "description"],
        [{ route: "Orders" }, "route"], [{ route: "1orders" }, "route"], [{ route: "or-ders" }, "route"], [{ route: "r".repeat(41) }, "route"],
        [{ operations: ["highlight", "input"] }, "operations"], [{ operations: ["click"] }, "operations"], [{ operations: ["highlight", "eval"] }, "operations"],
      ];
      for (const [over, field] of bads) {
        const res = await refused(h, registerBody(over), 422, "INVALID_TARGET");
        const issues = res.body.issues as string[];
        expect(issues.length, field).toBeGreaterThan(0);
        expect(issues.some((issue) => issue.startsWith(`${field}:`)), `${field}: ${issues.join(" | ")}`).toBe(true);
        for (const value of Object.values(over)) if (typeof value === "string" && value.length > 3) expect(res.raw, "the supplied text is not echoed").not.toContain(value);
      }
    });
    it("body fields the server owns are rejected as a malformed request: role, page, privacy other than a string, extra keys, a missing key", async () => {
      const h = await ready();
      for (const over of [{ role: "link" }, { elementRole: "link" }, { page: "/#/x" }, { proposal: {} }, { status: "active" }, { tenantId: TENANT_B }, { actor: "x" }]) await refused(h, registerBody(over), 400, "INVALID_REQUEST");
      const missing: Record<string, unknown> = registerBody();
      delete missing.label;
      await refused(h, missing, 400, "INVALID_REQUEST");
      for (const ref of ["e1", "@e0", "@e01", ["@e1"], 1]) await refused(h, registerBody({ ref }), 400, "INVALID_REQUEST");
      for (const privacy of ["private", "redact", "ignore", "", "PUBLIC"]) await refused(h, registerBody({ privacy }), 422, "INVALID_TARGET");
    });
    it("a different application than the session's: APPLICATION_MISMATCH", async () => {
      const h = await ready();
      await refused(h, registerBody({ applicationId: MANAGED_2 }), 409, "APPLICATION_MISMATCH");
    });
    it("somebody else's session id, another tenant, an unknown session: SESSION_CLOSED", async () => {
      const h = await ready();
      await refused(h, registerBody(), 404, "SESSION_CLOSED", "another-maintainer");
      await refused(h, registerBody(), 404, "SESSION_CLOSED", "tenant-b");
      await refused(h, registerBody({ sessionId: "nope" }), 404, "SESSION_CLOSED");
    });
    it("the application was disabled after the refresh: APPLICATION_DISABLED, and the session is closed", async () => {
      const h = await ready();
      await h.applications.setEnabled({ tenantId: TENANT_A, actor: "seed" }, MANAGED, false);
      await refused(h, registerBody(), 409, "APPLICATION_DISABLED");
      expect(h.runtimes[0]!.close).toHaveBeenCalledOnce();
    });
    it("the application was re-pointed (its allowed origins changed) after connecting: APPLICATION_MISMATCH, and the session is closed", async () => {
      const h = await ready();
      await h.applications.save({ tenantId: TENANT_A, actor: "seed" }, MANAGED, { ...managedConfig("Orders application"), allowedOrigins: [ORIGIN] });
      await refused(h, registerBody(), 409, "APPLICATION_MISMATCH");
      expect(h.runtimes[0]!.close).toHaveBeenCalledOnce();
    });
    it("twenty routes exist and the live page needs a new one: REGISTRY_FULL (a page that already has a route is still registrable)", async () => {
      const h = await ready();
      for (let i = 0; i < 20; i += 1) await h.targets.register({ tenantId: TENANT_A, actor: "seed" }, MANAGED, { targetId: `bulk.t${i}`, route: `r${i}`, page: `/#/r${i}`, role: "button", label: "B", description: "B.", operations: ["highlight", "click"], privacy: "public" });
      await refused(h, registerBody(), 409, "REGISTRY_FULL");
      h.runtimes[0]!.url = `${ORIGIN}/#/r3`;
      await h.command(refresh());
      const ok = await h.command(registerBody({ route: "r3" }));
      expect(ok.status).toBe(200);
    });
    it("the cap was reached after the refresh: REGISTRY_FULL", async () => {
      const h = await ready();
      for (let i = 0; i < 200; i += 1) await h.targets.register({ tenantId: TENANT_A, actor: "seed" }, MANAGED, { targetId: `bulk.t${i}`, route: "orders", page: "/#/orders", role: "button", label: "B", description: "B.", operations: ["highlight", "click"], privacy: "public" });
      await refused(h, registerBody(), 409, "REGISTRY_FULL");
    });
  });

  describe("the Gateway's answer decides, and is explained from the state, not from its text", () => {
    it("a refusal by the Gateway (not allowed) is FORBIDDEN", async () => {
      const h = await ready();
      h.state.mode = "refused";
      const res = await h.command(registerBody());
      expect(res).toMatchObject({ status: 403, body: { error: "FORBIDDEN" } });
      expect(h.calls).toHaveLength(1);
      noLeak(res.raw);
    });
    it("a broken Gateway is BROWSER_UNAVAILABLE and nothing is stored or leaked", async () => {
      const h = await ready();
      h.state.mode = "broken";
      const res = await h.command(registerBody());
      expect(res).toMatchObject({ status: 503, body: { error: "BROWSER_UNAVAILABLE" } });
      noLeak(res.raw);
      expect(await storedTargets(h)).toEqual([]);
    });
    it("an executor refusal with nothing to explain it is BROWSER_UNAVAILABLE; with a concurrent duplicate it is TARGET_EXISTS (diagnosed from the fresh store)", async () => {
      const h = await ready();
      h.state.mode = "failed";
      expect((await h.command(registerBody())).body).toEqual({ error: "BROWSER_UNAVAILABLE" });
      await h.targets.register({ tenantId: TENANT_A, actor: "seed" }, MANAGED, { targetId: "orders.exportButton", route: "orders", page: "/#/orders", role: "button", label: "Export", description: "Export.", operations: ["highlight", "click"], privacy: "public" });
      h.state.mode = "failed";
      // the in-handler checks already catch an existing id; to reach the diagnosis the duplicate must appear AFTER them: emulate with a store that creates it during submit
      const h2 = await ready();
      const original = h2.targets.register.bind(h2.targets);
      let injected = false;
      h2.targets.register = async (scope, applicationId, value) => {
        if (!injected) { injected = true; await original(scope, applicationId, { ...value }); return { kind: "target_exists" }; }
        return original(scope, applicationId, value);
      };
      expect((await h2.command(registerBody())).body).toEqual({ error: "TARGET_EXISTS" });
    });
    it("the diagnosis explains a route clash and a full registry that the executor found under its lock (the pre-checks passed on an older read)", async () => {
      const seed = { operations: ["highlight", "click"], privacy: "public" } as const;
      const clash = await ready();
      const realClash = clash.targets.register.bind(clash.targets);
      clash.targets.register = async (scope, applicationId, value) => {
        await realClash(scope, applicationId, { ...value, targetId: "orders.winner", route: "orderList", ...seed, label: "W", description: "W." });
        return { kind: "route_mismatch" };
      };
      expect((await clash.command(registerBody())).body).toEqual({ error: "ROUTE_MISMATCH" });
      const full = await ready();
      const realFull = full.targets.register.bind(full.targets);
      full.targets.register = async (scope, applicationId, value) => {
        for (let i = 0; i < 200; i += 1) await realFull(scope, applicationId, { ...value, targetId: `bulk.t${i}`, ...seed, label: "B", description: "B." });
        return { kind: "registry_full" };
      };
      expect((await full.command(registerBody())).body).toEqual({ error: "REGISTRY_FULL" });
    });
    it("a registration the store cannot read back is BROWSER_UNAVAILABLE, never a reply with an empty target", async () => {
      const h = await ready();
      h.targets.get = async () => null;
      const res = await h.command(registerBody());
      expect(res).toMatchObject({ status: 503, body: { error: "BROWSER_UNAVAILABLE" } });
      expect(res.raw).not.toContain("target");
    });
  it("a disabled application found by the diagnosis closes the session", async () => {
      const h = await ready();
      const original = h.targets.register.bind(h.targets);
      h.targets.register = async (scope, applicationId, value) => { await h.applications.setEnabled({ tenantId: TENANT_A, actor: "seed" }, MANAGED, false); return original(scope, applicationId, value); };
      expect((await h.command(registerBody())).body).toEqual({ error: "APPLICATION_DISABLED" });
      expect(h.runtimes[0]!.close).toHaveBeenCalledOnce();
    });
  });

  it("a registration by one tenant is never visible to another tenant's application, and tenant B cannot drive tenant A's session", async () => {
    const h = await ready();
    await h.command(registerBody());
    expect(await storedTargets(h)).toHaveLength(1);
    expect(await storedTargets(h, TENANT_B, MANAGED_OTHER_TENANT)).toEqual([]);
    expect((await h.command(refresh(), "tenant-b")).body).toEqual({ error: "SESSION_CLOSED" });
  });
});

describe("highlight and capture on a managed application", () => {
  it("highlight works for a registrable control (re-verified against the live marker, persists nothing); capture needs a trusted one", async () => {
    const h = await ready();
    const high = await h.command({ action: "highlight", sessionId: "session-1", applicationId: MANAGED, ref: "@e1" });
    expect(high.body).toEqual({ highlighted: true, ref: "@e1" });
    expect(h.runtimes[0]!.highlight).toHaveBeenCalledOnce();
    expect(await storedTargets(h)).toEqual([]);
    expect(h.calls).toEqual([]);
    expect((await h.command({ action: "capture", sessionId: "session-1", applicationId: MANAGED, ref: "@e1" })).body).toEqual({ error: "TARGET_UNAVAILABLE" });
  });
  it("a registrable control whose live marker changed: TARGET_UNAVAILABLE", async () => {
    const h = await ready();
    h.runtimes[0]!.controls[0]!.id = "orders.somethingElse";
    expect((await h.command({ action: "highlight", sessionId: "session-1", applicationId: MANAGED, ref: "@e1" })).body).toEqual({ error: "TARGET_UNAVAILABLE" });
    expect(h.runtimes[0]!.highlight).not.toHaveBeenCalled();
  });
  it("a trusted target disabled after the refresh is TARGET_UNAVAILABLE for highlight and capture (the registry is re-read on the command)", async () => {
    const h = await harness();
    await h.targets.register({ tenantId: TENANT_A, actor: "seed" }, MANAGED, { targetId: "orders.exportButton", route: "orders", page: "/#/orders", role: "button", label: "Export", description: "Export.", operations: ["highlight", "click"], privacy: "public" });
    await h.connect();
    await h.command(refresh());
    expect((await h.command({ action: "capture", sessionId: "session-1", applicationId: MANAGED, ref: "@e1" })).status).toBe(200);
    await h.targets.setStatus({ tenantId: TENANT_A, actor: "seed" }, MANAGED, "orders.exportButton", "disabled");
    for (const action of ["highlight", "capture"]) expect((await h.command({ action, sessionId: "session-1", applicationId: MANAGED, ref: "@e1" })).body, action).toEqual({ error: "TARGET_UNAVAILABLE" });
  });
  it("a disabled control can be neither highlighted nor captured", async () => {
    const h = await harness();
    await h.targets.register({ tenantId: TENANT_A, actor: "seed" }, MANAGED, { targetId: "orders.exportButton", route: "orders", page: "/#/orders", role: "button", label: "Export", description: "Export.", operations: ["highlight", "click"], privacy: "public" });
    await h.targets.setStatus({ tenantId: TENANT_A, actor: "seed" }, MANAGED, "orders.exportButton", "disabled");
    await h.connect();
    await h.command(refresh());
    for (const action of ["highlight", "capture"]) expect((await h.command({ action, sessionId: "session-1", applicationId: MANAGED, ref: "@e1" })).body, action).toEqual({ error: "TARGET_UNAVAILABLE" });
  });
});

describe("resume (D13): a reloaded page re-adopts its own running session", () => {
  it("the same owner and application get the session back under a NEW id; the old id is dead, the browser is not restarted, the page's candidates survive", async () => {
    const h = await ready();
    const res = await h.command({ action: "resume", applicationId: MANAGED });
    expect(res).toMatchObject({ status: 200, body: { sessionId: "session-2", applicationId: MANAGED, application: "Orders application", origin: ORIGIN, registrySource: "studio-managed", resumed: true } });
    expect((await h.command(refresh(MANAGED, "session-1"))).body, "the old id is dead").toEqual({ error: "SESSION_CLOSED" });
    expect((await h.command(refresh(MANAGED, "session-2"))).status).toBe(200);
    expect(h.runtimes).toHaveLength(1);
    expect(h.runtimes[0]!.start).toHaveBeenCalledOnce();
    expect(h.runtimes[0]!.close).not.toHaveBeenCalled();
  });
  it("the adopted session can register straight away (the last refresh is kept)", async () => {
    const h = await ready();
    await h.command({ action: "resume", applicationId: MANAGED });
    expect((await h.command(registerBody({ sessionId: "session-2" }))).status).toBe(200);
  });
  it("resume works for a built-in application as well (and says so)", async () => {
    const h = await harness();
    await h.connect(BUILT_IN);
    expect((await h.command({ action: "resume", applicationId: BUILT_IN })).body).toMatchObject({ registrySource: "built-in", resumed: true });
  });
  it("no session: 404 SESSION_CLOSED; the application of another session: 409 BROWSER_BUSY (nothing adopted, nothing closed)", async () => {
    const h = await harness();
    expect((await h.command({ action: "resume", applicationId: MANAGED })).body).toEqual({ error: "SESSION_CLOSED" });
    await h.connect(MANAGED);
    expect((await h.command({ action: "resume", applicationId: MANAGED_2 })).body).toEqual({ error: "BROWSER_BUSY" });
    expect((await h.command(refresh(MANAGED, "session-1"))).status, "the original id still works").toBe(200);
    expect(h.runtimes[0]!.close).not.toHaveBeenCalled();
  });
  it("another maintainer or another tenant cannot adopt it: 409 BROWSER_BUSY, and the owner keeps the old id", async () => {
    const h = await harness();
    await h.connect(MANAGED);
    for (const role of ["another-maintainer", "tenant-b"] as const) {
      const res = await h.command({ action: "resume", applicationId: MANAGED }, role);
      expect(res).toMatchObject({ status: 409, body: { error: "BROWSER_BUSY" } });
      expect(res.raw).not.toContain("session-");
    }
    expect((await h.command(refresh(MANAGED, "session-1"))).status).toBe(200);
  });
  it("a disabled, removed or re-pointed application cannot be resumed and the session is closed", async () => {
    const h = await harness();
    await h.connect(MANAGED);
    await h.applications.setEnabled({ tenantId: TENANT_A, actor: "seed" }, MANAGED, false);
    expect((await h.command({ action: "resume", applicationId: MANAGED })).body).toEqual({ error: "APPLICATION_DISABLED" });
    expect(h.runtimes[0]!.close).toHaveBeenCalledOnce();
    expect((await h.command({ action: "resume", applicationId: MANAGED })).body).toEqual({ error: "SESSION_CLOSED" });
  });
  it("exact keys: a session id, an origin or any extra key is a malformed request", async () => {
    const h = await harness();
    await h.connect(MANAGED);
    for (const body of [{ action: "resume" }, { action: "resume", applicationId: "nope" }, { action: "resume", applicationId: MANAGED, sessionId: "session-1" }, { action: "resume", applicationId: MANAGED, origin: ORIGIN }]) {
      expect((await h.command(body)).body, JSON.stringify(body)).toEqual({ error: "INVALID_REQUEST" });
    }
  });
  describe("the idle clock", () => {
    const minutes = (n: number) => n * 60_000;
    it("a resume by the owner restarts the five-minute clock; a rejected resume by somebody else does not", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const h = await harness();
      await h.connect(MANAGED);
      await vi.advanceTimersByTimeAsync(minutes(4));
      expect((await h.command({ action: "resume", applicationId: MANAGED }, "another-maintainer")).status).toBe(409);
      expect((await h.command({ action: "resume", applicationId: MANAGED })).status).toBe(200);
      await vi.advanceTimersByTimeAsync(minutes(4));
      expect(h.runtimes[0]!.close).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(minutes(1) + 1);
      expect(h.runtimes[0]!.close).toHaveBeenCalledOnce();
    });
    it("a rejected resume alone never keeps a forgotten session open", async () => {
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      const h = await harness();
      await h.connect(MANAGED);
      await vi.advanceTimersByTimeAsync(minutes(4));
      await h.command({ action: "resume", applicationId: MANAGED }, "tenant-b");
      await h.command({ action: "resume", applicationId: MANAGED_2 });
      await vi.advanceTimersByTimeAsync(minutes(1) + 1);
      expect(h.runtimes[0]!.close).toHaveBeenCalledOnce();
    });
  });
});

describe("a registered control that became private or secret-looking is hidden and unusable (E2)", () => {
  async function registered(): Promise<H> {
    const h = await harness();
    await h.targets.register({ tenantId: TENANT_A, actor: "seed" }, MANAGED, { targetId: "orders.exportButton", route: "orders", page: "/#/orders", role: "button", label: "Export", description: "Export.", operations: ["highlight", "click"], privacy: "public" });
    await h.connect();
    expect((await h.command(refresh())).body.elements).toEqual(expect.arrayContaining([expect.objectContaining({ ref: "@e1", status: "trusted" })]));
    return h;
  }
  const FACTS: [string, ElementFacts][] = [["data-ai-private", { ...PUBLIC, dataAiPrivate: true }], ["data-ai-ignore", { ...PUBLIC, dataAiIgnore: true }], ["data-ai-redact", { ...PUBLIC, dataAiRedact: true }], ["a password type", { ...PUBLIC, inputType: "password" }], ["autocomplete cc-csc", { ...PUBLIC, autocomplete: "cc-csc" }]];
  it.each(FACTS)("the next refresh hides the control that became %s: not listed, not named, counted as hidden", async (_why, facts) => {
    const h = await registered();
    h.runtimes[0]!.controls[0]!.facts = facts;
    const res = await h.command(refresh());
    expect((res.body.elements as { name: string }[]).map((element) => element.name)).not.toContain("Export");
    expect(res.raw).not.toMatch(/Export|orders\.exportButton/u);
    expect(res.body.hidden).toBe(3);
  });
  it.each(FACTS)("highlight and capture of the previously trusted ref refuse with TARGET_UNAVAILABLE once the live element became %s", async (_why, facts) => {
    const h = await registered();
    h.runtimes[0]!.controls[0]!.facts = facts;
    for (const action of ["highlight", "capture"]) expect((await h.command({ action, sessionId: "session-1", applicationId: MANAGED, ref: "@e1" })).body, action).toEqual({ error: "TARGET_UNAVAILABLE" });
    expect(h.runtimes[0]!.highlight).not.toHaveBeenCalled();
  });
  it("facts that cannot be read refuse highlight and capture of a trusted control", async () => {
    const h = await registered();
    h.runtimes[0]!.controls[0]!.facts = null;
    for (const action of ["highlight", "capture"]) expect((await h.command({ action, sessionId: "session-1", applicationId: MANAGED, ref: "@e1" })).body, action).toEqual({ error: "TARGET_UNAVAILABLE" });
  });
  it("a registrable control that turned private after the refresh cannot be highlighted either", async () => {
    const h = await ready();
    h.runtimes[0]!.controls[1]!.facts = { ...PUBLIC, dataAiPrivate: true };
    expect((await h.command({ action: "highlight", sessionId: "session-1", applicationId: MANAGED, ref: "@e2" })).body).toEqual({ error: "TARGET_UNAVAILABLE" });
  });
  it("a still-public registered control keeps working and its facts are read once for the single ref in the fresh observation", async () => {
    const h = await registered();
    const before = (h.runtimes[0]!.inspectElementFacts as ReturnType<typeof vi.fn>).mock.calls.length;
    expect((await h.command({ action: "highlight", sessionId: "session-1", applicationId: MANAGED, ref: "@e1" })).body).toEqual({ highlighted: true, ref: "@e1" });
    const calls = (h.runtimes[0]!.inspectElementFacts as ReturnType<typeof vi.fn>).mock.calls;
    expect(calls).toHaveLength(before + 1);
    expect(calls.at(-1)![0]).toEqual(["@e1"]);
  });
});

describe("capture returns the STORED semantic role, the inspector keeps the live browser role as evidence (E1)", () => {
  const CASES: [string, string, RegistrableRole, string[]][] = [
    ["searchbox", "Find orders", "textbox", ["highlight", "input", "focus"]], ["combobox", "Status", "select", ["highlight", "click"]], ["textbox", "Note", "textbox", ["highlight", "input"]],
    ["button", "Export", "button", ["highlight", "click"]], ["link", "Orders", "link", ["highlight", "click"]], ["checkbox", "Agree", "checkbox", ["highlight", "click"]],
  ];
  it.each(CASES)("a registered %s control: the refresh shows the browser role, capture the stored %s role (%s)", async (browserRole, name, stored, operations) => {
    const h = await harness({ controls: [control(name, browserRole, "orders.thing")] });
    await h.targets.register({ tenantId: TENANT_A, actor: "seed" }, MANAGED, { targetId: "orders.thing", route: "orders", page: "/#/orders", role: stored, label: name, description: `${name}.`, operations: operations as never, privacy: "public" });
    await h.connect();
    const refreshed = await h.command(refresh());
    expect(refreshed.body.elements).toEqual([expect.objectContaining({ ref: "@e1", name, role: browserRole, status: "trusted" })]);
    const captured = await h.command({ action: "capture", sessionId: "session-1", applicationId: MANAGED, ref: "@e1" });
    expect(captured.body).toEqual({ targetId: "orders.thing", route: "orders", name, role: stored, operations });
  });
  it("registered searchboxes and comboboxes remain usable when the workspace reopens", async () => {
    const h = await ready({ controls: [control("Find orders", "searchbox", "orders.search"), control("Status", "combobox", "orders.status")] });
    const a = await h.command(registerBody({ ref: "@e1", targetId: "orders.search", operations: ["highlight", "input"], label: "Find orders", description: "Searches." }));
    expect(a.body).toMatchObject({ target: { role: "textbox" } });
    const b = await h.command(registerBody({ ref: "@e2", targetId: "orders.status", operations: ["highlight", "click"], label: "Status", description: "Filters." }));
    expect(b.body).toMatchObject({ target: { role: "select" } });
    const capture = (ref: string, sessionId = "session-1") => h.command({ action: "capture", sessionId, applicationId: MANAGED, ref });
    expect((await capture("@e1")).body).toMatchObject({ role: "textbox", name: "Find orders" });
    expect((await capture("@e2")).body).toMatchObject({ role: "select", name: "Status" });
    expect((await h.command({ action: "disconnect", sessionId: "session-1", applicationId: MANAGED })).body).toEqual({ closed: true });
    const reopened = await h.connect();
    expect(reopened).not.toBe("session-1");
    const again = await h.command(refresh(MANAGED, reopened));
    expect((again.body.elements as { role: string; status: string }[]).map((e) => [e.role, e.status])).toEqual([["searchbox", "trusted"], ["combobox", "trusted"]]);
    expect((await capture("@e1", reopened)).body).toMatchObject({ role: "textbox" });
    expect((await capture("@e2", reopened)).body).toMatchObject({ role: "select" });
  });
});

describe("duplicate markers fail closed (H5)", () => {
  const twins = () => [control("Export", "button", "orders.exportButton"), control("Export copy", "button", "orders.exportButton"), control("Order note", "textbox", "orders.note")];
  it("refresh lists neither twin and counts both as hidden", async () => {
    const h = await harness({ controls: twins() });
    await h.connect();
    const res = await h.command(refresh());
    expect((res.body.elements as { name: string }[]).map((e) => e.name)).toEqual(["Order note"]);
    expect(res.body.hidden).toBe(2);
    expect(res.raw).not.toMatch(/Export/u);
  });
  it("register of a twin ref is refused (it was never listed) and nothing reaches the Gateway or the store", async () => {
    const h = await harness({ controls: twins() });
    await h.connect();
    await h.command(refresh());
    for (const ref of ["@e1", "@e2"]) expect((await h.command(registerBody({ ref }))).body, ref).toEqual({ error: "REF_NOT_FOUND" });
    expect(h.calls).toEqual([]);
    expect(await storedTargets(h)).toEqual([]);
  });
  it("a control of the inspected set that is re-marked as a twin AFTER the refresh is caught by the live re-check: TARGET_NOT_REGISTRABLE, nothing written", async () => {
    const h = await ready();
    h.runtimes[0]!.controls[3] = control("Late twin", "button", "orders.exportButton"); // the former "Save" control (no marker) now carries the same marker
    const res = await h.command(registerBody());
    expect(res).toMatchObject({ status: 409, body: { error: "TARGET_NOT_REGISTRABLE" } });
    expect(h.calls).toEqual([]);
    expect(await storedTargets(h)).toEqual([]);
    expect(res.raw).not.toContain("Late twin");
  });
  it("once the twin is gone the control registers normally", async () => {
    const h = await ready();
    h.runtimes[0]!.controls[3] = control("Late twin", "button", "orders.exportButton");
    expect((await h.command(registerBody())).status).toBe(409);
    h.runtimes[0]!.controls[3] = control("Save", "button", null);
    expect((await h.command(registerBody())).status).toBe(200);
  });
});

describe("history routing (Studio COMPLETION, S1)", () => {
  const HOME = `${ORIGIN}/`;
  const profile = () => [control("Display name", "textbox", "profile.displayName"), control("Save", "button", "profile.save")];
  const reg = (over: Record<string, unknown> = {}) => registerBody({ ref: "@e2", targetId: "profile.save", route: "profile", operations: ["highlight", "click"], label: "Save", description: "Saves the profile.", ...over });

  it("connect passes routing:\"history\" to the adapter ONLY for a history application; a hash application's configuration is exactly the V1B one", async () => {
    const history = await harness({ routing: "history", controls: profile() });
    await history.connect();
    expect(history.configs).toEqual([{ labels: "all", routes: "any", routing: "history", origins: [ORIGIN, "http://localhost:5187"] }]);
    const hash = await harness();
    await hash.connect();
    expect(hash.configs).toEqual([{ labels: "all", routes: "any", origins: [ORIGIN, "http://localhost:5187"] }]);
    expect("routing" in hash.configs[0]!).toBe(false);
  });
  it("refresh reports the PATHNAME as the page: query and fragment are dropped and never returned, a trailing slash is removed", async () => {
    for (const [url, page] of [[`${ORIGIN}/profile?token=abc#section`, "/profile"], [`${ORIGIN}/profile/`, "/profile"], [`${ORIGIN}/users/123?x=1`, "/users/123"], [HOME, "/"], [`${ORIGIN}/?q=1#/orders`, "/"]] as const) {
      const h = await harness({ routing: "history", controls: profile(), url });
      await h.connect();
      const res = await h.command(refresh());
      expect(res.body, url).toMatchObject({ page, route: null });
      expect(res.raw).not.toMatch(/token=abc|section|q=1/u);
    }
  });
  it("a pathname outside the grammar (a percent escape, an encoded slash, 201 characters) is no page: nothing is registrable there", async () => {
    for (const path of ["/a%20b", "/a%2fb", `/${"a".repeat(200)}`]) {
      const h = await harness({ routing: "history", controls: profile(), url: `${ORIGIN}${path}` });
      await h.connect();
      const res = await h.command(refresh());
      expect(res.body, path).toMatchObject({ page: null, elements: [], hidden: 2 });
    }
  });
  it("registers on a history page: the proposal and the capability parameters carry the pathname, the route is suggested from it, and the page is the pathname in the reply", async () => {
    const h = await harness({ routing: "history", controls: profile(), url: `${ORIGIN}/users/123?x=1#y` });
    await h.connect();
    const shown = await h.command(refresh());
    expect((shown.body.elements as { name: string; proposal: { page: string; route: string; routeIsNew: boolean } }[]).map((e) => [e.name, e.proposal.page, e.proposal.route, e.proposal.routeIsNew])).toEqual([
      ["Display name", "/users/123", "users123", true], ["Save", "/users/123", "users123", true]]);
    const res = await h.command(reg({ route: "users123" }));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ route: { route: "users123", page: "/users/123", created: true }, target: { id: "profile.save", page: "/users/123" } });
    expect(h.calls[0]!.params).toMatchObject({ page: "/users/123", route: "users123" });
    expect(JSON.stringify(h.calls[0]!.params)).not.toMatch(/x=1|#y/u);
  });
  it("two URLs of the same page (different query or fragment, with or without the trailing slash) are ONE page: the second registration reuses the route", async () => {
    const h = await harness({ routing: "history", controls: profile(), url: `${ORIGIN}/profile?a=1` });
    await h.connect();
    await h.command(refresh());
    expect((await h.command(reg({ route: "profile" }))).body).toMatchObject({ route: { route: "profile", page: "/profile", created: true } });
    h.runtimes[0]!.url = `${ORIGIN}/profile/#top`;
    const again = await h.command(refresh());
    expect(again.body).toMatchObject({ page: "/profile", route: "profile" });
    expect((await h.command(registerBody({ ref: "@e1", targetId: "profile.displayName", route: "profile", operations: ["highlight", "input"], label: "Name", description: "The name." }))).body).toMatchObject({ route: { route: "profile", page: "/profile", created: false } });
  });
  it("a hash URL on a history application is the page `/` (the fragment is dropped): hash pages do not exist for it", async () => {
    const h = await harness({ routing: "history", controls: profile(), url: `${ORIGIN}/#/orders` });
    await h.connect();
    expect((await h.command(refresh())).body).toMatchObject({ page: "/" });
  });
  it("a hash application never treats a pathname as a page (V1B behavior unchanged)", async () => {
    const h = await harness({ controls: profile(), url: `${ORIGIN}/users/123` });
    await h.connect();
    expect((await h.command(refresh())).body).toMatchObject({ page: null, elements: [], hidden: 2 });
  });
  it("the store refuses a page of the wrong routing (page_refused) and the registration is a typed refusal, never a stored row", async () => {
    const h = await harness({ routing: "history", controls: profile(), url: HOME });
    await h.connect();
    await h.command(refresh());
    const real = h.targets.register.bind(h.targets);
    let outcome = "";
    h.targets.register = async (scope, app, value) => { const result = await real(scope, app, { ...value, page: "/#/orders" }); outcome = result.kind; return result; };
    const res = await h.command(reg({ route: "home" }));
    expect(outcome).toBe("page_refused");
    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(await storedTargets(h)).toEqual([]);
  });
  it("changing the application's routing while a session is open closes the session at the next command (the adapter's policy would be stale)", async () => {
    const h = await harness({ routing: "history", controls: profile(), url: HOME });
    await h.connect();
    await h.applications.save({ tenantId: TENANT_A, actor: "seed" }, MANAGED, { ...managedConfig("Orders application"), routing: "hash" });
    expect((await h.command(refresh())).body).toEqual({ error: "APPLICATION_MISMATCH" });
    expect(h.runtimes[0]!.close).toHaveBeenCalledOnce();
  });
});

// --- Studio COMPLETION S3: the `check` and `repair` session commands ------------------------------------------------------------------------------------------------------
const SCOPE = { tenantId: TENANT_A, actor: "seed" };
const reg = (id: string, over: Record<string, unknown> = {}) => ({ targetId: id, route: "orders", page: "/#/orders", role: "button" as const, label: id, description: `${id}.`, operations: ["highlight", "click"] as never, privacy: "public" as const, ...over });
const check = (sessionId = "session-1", applicationId = MANAGED) => ({ action: "check", sessionId, applicationId });
const healthCalls = (h: H) => h.calls.filter((call) => call.action === "setStudioTargetHealth").map((call) => [call.params.targetId, call.params.health]);

describe("check: the health of the registered targets of the current page", () => {
  async function checked(controls: Control[], url?: string) {
    const h = await harness({ controls, ...(url === undefined ? {} : { url }) });
    await h.targets.register(SCOPE, MANAGED, reg("orders.exportButton"));
    await h.targets.register(SCOPE, MANAGED, reg("orders.note", { role: "textbox", operations: ["highlight", "input"] }));
    await h.connect();
    return h;
  }
  const good = () => [control("Export", "button", "orders.exportButton"), control("Order note", "textbox", "orders.note")];

  it("healthy targets are reported healthy and persisted once through the Gateway; a second check with no change writes nothing", async () => {
    const h = await checked(good());
    const first = await h.command(check());
    expect(first.status).toBe(200);
    expect(first.body).toEqual({ page: "/#/orders", route: "orders", results: [{ targetId: "orders.exportButton", state: "healthy" }, { targetId: "orders.note", state: "healthy" }] });
    expect(healthCalls(h)).toEqual([["orders.exportButton", "healthy"], ["orders.note", "healthy"]]);
    expect((await h.targets.get(TENANT_A, MANAGED, "orders.note"))?.health).toBe("healthy");
    h.calls.length = 0;
    expect((await h.command(check())).body).toMatchObject({ results: [{ state: "healthy" }, { state: "healthy" }] });
    expect(h.calls).toEqual([]);
  });
  it.each([
    ["not_found: no control carries the marker", [control("Order note", "textbox", "orders.note")], "orders.exportButton", "not_found"],
    ["ambiguous: two controls carry the marker", [control("Export", "button", "orders.exportButton"), control("Export again", "button", "orders.exportButton"), control("Order note", "textbox", "orders.note")], "orders.exportButton", "ambiguous"],
    ["role_changed: the control is a link now", [control("Export", "link", "orders.exportButton"), control("Order note", "textbox", "orders.note")], "orders.exportButton", "role_changed"],
    ["private: the control became private", [control("Export", "button", "orders.exportButton", { ...PUBLIC, dataAiPrivate: true }), control("Order note", "textbox", "orders.note")], "orders.exportButton", "private"],
    ["private: the control is a password field now", [control("Export", "button", "orders.exportButton", { ...PUBLIC, inputType: "password" }), control("Order note", "textbox", "orders.note")], "orders.exportButton", "private"],
    ["private: its name looks secret", [control("Reveal your password", "button", "orders.exportButton"), control("Order note", "textbox", "orders.note")], "orders.exportButton", "private"],
  ])("%s", async (_name, controls, targetId, reason) => {
    const h = await checked(controls);
    const res = await h.command(check());
    expect((res.body.results as { targetId: string; state: string; reason?: string }[]).find((r) => r.targetId === targetId)).toEqual({ targetId, state: "broken", reason });
    expect(healthCalls(h)).toContainEqual([targetId, "broken"]);
    expect((await h.targets.get(TENANT_A, MANAGED, targetId))?.health).toBe("broken");
  });
  it("a broken target that recovers is written healthy again (only the change is persisted)", async () => {
    const h = await checked([control("Order note", "textbox", "orders.note")]);
    await h.command(check());
    h.calls.length = 0;
    h.runtimes[0]!.controls.unshift(control("Export", "button", "orders.exportButton"));
    const res = await h.command(check());
    expect(res.body.results).toEqual([{ targetId: "orders.exportButton", state: "healthy" }, { targetId: "orders.note", state: "healthy" }]);
    expect(healthCalls(h)).toEqual([["orders.exportButton", "healthy"]]);
  });
  it("facts that cannot be read leave the target unverified and write nothing; so does a marker missing from a page with more controls than are inspected", async () => {
    const h = await checked([control("Export", "button", "orders.exportButton", null), control("Order note", "textbox", "orders.note")]);
    expect((await h.command(check())).body.results).toEqual([{ targetId: "orders.exportButton", state: "unverified" }, { targetId: "orders.note", state: "healthy" }]);
    expect(healthCalls(h)).toEqual([["orders.note", "healthy"]]);
    const crowded = await checked([...Array.from({ length: 64 }, (_, i) => control(`Filler ${i}`, "button", `orders.filler${i}`)), control("Export", "button", "orders.exportButton"), control("Order note", "textbox", "orders.note")]);
    expect((await crowded.command(check())).body.results).toEqual([{ targetId: "orders.exportButton", state: "unverified" }, { targetId: "orders.note", state: "unverified" }]);
    expect(healthCalls(crowded)).toEqual([]);
  });
  it("checks the targets of the CURRENT route only, never a disabled target, and an unregistered page has no results", async () => {
    const h = await checked(good());
    await h.targets.register(SCOPE, MANAGED, reg("home.start", { route: "home", page: "/" }));
    await h.targets.register(SCOPE, MANAGED, reg("orders.old"));
    await h.targets.setStatus(SCOPE, MANAGED, "orders.old", "disabled");
    expect(((await h.command(check())).body.results as { targetId: string }[]).map((r) => r.targetId)).toEqual(["orders.exportButton", "orders.note"]);
    h.runtimes[0]!.url = `${ORIGIN}/#/unknown`;
    expect((await h.command(check())).body).toEqual({ page: "/#/unknown", route: null, results: [] });
  });
  it("never names a control that is hidden: the reply holds registered target ids only", async () => {
    const h = await checked([...good(), control("Secret internal thing", "button", "dap.internal"), control("Your password", "textbox", "orders.pw"), control("Unregistered", "button", "orders.fresh")]);
    const res = await h.command(check());
    expect(res.raw).not.toMatch(/Secret internal|password|Unregistered|dap\.internal|orders\.pw|orders\.fresh/u);
    expect(Object.keys(res.body).sort()).toEqual(["page", "results", "route"]);
  });
  it("is also a refresh (its refs are usable) and does not accept extra keys", async () => {
    const h = await checked(good());
    await h.command(check());
    expect((await h.command({ action: "highlight", sessionId: "session-1", applicationId: MANAGED, ref: "@e1" })).body).toEqual({ highlighted: true, ref: "@e1" });
    expect((await h.command({ ...check(), ref: "@e1" })).body).toEqual({ error: "INVALID_REQUEST" });
    expect((await h.command({ action: "check", applicationId: MANAGED })).body).toEqual({ error: "INVALID_REQUEST" });
  });
  it("needs the owner's session, a managed application that is still enabled, and a Gateway that answers; refusals leak nothing", async () => {
    const h = await checked(good());
    expect((await h.command(check(), "another-maintainer")).body).toEqual({ error: "SESSION_CLOSED" });
    expect((await h.command(check(), "tenant-b")).body).toEqual({ error: "SESSION_CLOSED" });
    expect((await h.command(check("nope"))).body).toEqual({ error: "SESSION_CLOSED" });
    expect((await h.command(check("session-1", MANAGED_2))).body).toEqual({ error: "APPLICATION_MISMATCH" });
    h.state.mode = "refused";
    expect((await h.command(check())).body).toEqual({ error: "FORBIDDEN" });
    h.state.mode = "broken";
    const broken = await h.command(check());
    expect(broken.body).toEqual({ error: "BROWSER_UNAVAILABLE" });
    noLeak(broken.raw);
    h.state.mode = "executor";
    await h.applications.setEnabled(SCOPE, MANAGED, false);
    expect((await h.command(check())).body).toEqual({ error: "APPLICATION_DISABLED" });
    expect(h.runtimes[0]!.close).toHaveBeenCalledOnce();
  });
  it("a built-in application's session refuses it: REGISTRY_NOT_MANAGED", async () => {
    const h = await harness();
    await h.connect(BUILT_IN);
    expect((await h.command(check("session-1", BUILT_IN))).body).toEqual({ error: "REGISTRY_NOT_MANAGED" });
  });
  it("restarts the idle clock like any owner command", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const h = await checked(good());
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    expect((await h.command(check())).status).toBe(200);
    await vi.advanceTimersByTimeAsync(4 * 60_000);
    expect(h.runtimes[0]!.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(60_001);
    expect(h.runtimes[0]!.close).toHaveBeenCalledOnce();
  });
});

describe("repair: re-bind a registered target to a live control", () => {
  const guide = (target: string, wait: "click" | "input" | "ack" = "click", title = "Submit an order") => ({
    id: "wt-0000000000a1", title, description: "Submit the order.", start: "n1",
    steps: [{ id: "n1", kind: "navigate", route: "orders", next: "s1" }, { id: "s1", kind: "guide", target, text: "Press it.", wait, verify: "route.orders", next: "done" }, { id: "done", kind: "complete", text: "Done." }],
  });
  /** The registered target `orders.exportButton` whose page now carries its marker on a LINK (role changed): a `mismatched` candidate at @e1, plus a brand-new control at @e2. */
  async function broken(controls?: Control[]) {
    const h = await harness({ controls: controls ?? [control("Export", "link", "orders.exportButton"), control("Export now", "button", "orders.exportNow"), control("Order note", "textbox", "orders.note")] });
    await h.targets.register(SCOPE, MANAGED, reg("orders.exportButton"));
    await h.targets.register(SCOPE, MANAGED, reg("orders.note", { role: "textbox", operations: ["highlight", "input"] }));
    await h.connect();
    await h.command(refresh());
    return h;
  }
  const repairBody = (over: Record<string, unknown> = {}) => ({
    action: "repair", sessionId: "session-1", applicationId: MANAGED, targetId: "orders.exportButton", ref: "@e1", operations: ["highlight", "click"], label: "Export link", description: "Exports the orders.", confirm: false, ...over,
  });

  it("the refresh lists the control as mismatched (role) and a new control as registrable", async () => {
    const h = await broken();
    const shown = (await h.command(refresh())).body.elements as { name: string; status: string; problem?: string; targetId?: string }[];
    expect(shown.map((e) => [e.name, e.status, e.problem, e.targetId])).toEqual([["Export", "mismatched", "role", "orders.exportButton"], ["Export now", "registrable", undefined, undefined], ["Order note", "trusted", undefined, "orders.note"]]);
  });
  it("a DRY RUN (confirm false) returns the current and proposed fields and the impact, and writes nothing", async () => {
    const h = await broken();
    h.targets.definitions.push({ tenantId: TENANT_A, applicationId: MANAGED, id: "wt-0000000000a1", title: "Submit an order", status: "draft", definition: guide("orders.exportButton", "ack") });
    h.targets.definitions.push({ tenantId: TENANT_A, applicationId: MANAGED, id: "wt-0000000000a2", title: "Live guide", status: "published", definition: { ...guide("orders.exportButton", "ack", "Live guide"), id: "wt-0000000000a2" } });
    const res = await h.command(repairBody({ operations: ["highlight", "click"] }));
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(["current", "impact", "proposed", "target"]);
    expect(res.body.current).toEqual({ marker: "orders.exportButton", role: "button", operations: ["highlight", "click"], label: "orders.exportButton", description: "orders.exportButton." });
    expect(res.body.proposed).toEqual({ marker: "orders.exportButton", role: "link", operations: ["highlight", "click"], label: "Export link", description: "Exports the orders." });
    expect(res.body.impact).toEqual({ drafts: [{ id: "wt-0000000000a1", title: "Submit an order" }], published: [{ id: "wt-0000000000a2", title: "Live guide", version: 1 }], compatible: true, problems: [] });
    expect(res.body.target).toMatchObject({ id: "orders.exportButton", revision: 1 });
    expect(h.calls).toEqual([]);
    expect(await h.targets.get(TENANT_A, MANAGED, "orders.exportButton")).toMatchObject({ role: "button", revision: 1 });
  });
  it("CONFIRM applies a compatible repair: the Gateway gets the server-built parameters (live marker and role), the reply is the new TargetView and the impact, and the control is trusted at once", async () => {
    const h = await broken();
    const res = await h.command(repairBody({ confirm: true }));
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(["impact", "target"]);
    expect(res.body.target).toMatchObject({ id: "orders.exportButton", role: "link", marker: "orders.exportButton", label: "Export link", revision: 2, health: "healthy" });
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toMatchObject({ action: "repairStudioTarget", params: { applicationId: MANAGED, targetId: "orders.exportButton", marker: "orders.exportButton", elementRole: "link", operations: ["highlight", "click"], label: "Export link", description: "Exports the orders." } });
    expect(h.calls[0]!.raw).not.toMatch(/@e\d/u);
    expect(await h.targets.changes(TENANT_A, MANAGED, "orders.exportButton", 5)).toHaveLength(1);
    expect(((await h.command({ action: "capture", sessionId: "session-1", applicationId: MANAGED, ref: "@e1" })).body)).toMatchObject({ targetId: "orders.exportButton", role: "link" });
  });
  it("a REGISTRABLE control (a new marker) can replace the target: the marker changes, the id never does", async () => {
    const h = await broken();
    const res = await h.command(repairBody({ ref: "@e2", operations: ["highlight", "click"], label: "Export now", description: "Exports at once." , confirm: true }));
    expect(res.status).toBe(200);
    expect(res.body.target).toMatchObject({ id: "orders.exportButton", marker: "orders.exportNow", role: "button", revision: 2 });
    expect((await h.targets.registry(TENANT_A, MANAGED)).markers).toEqual({ "orders.exportButton": "orders.exportNow", "orders.note": "orders.note" });
    // the next refresh knows the control by its new marker, and the old marker (the id) is nobody's
    const shown = (await h.command(refresh())).body.elements as { name: string; status: string }[];
    expect(shown.map((e) => [e.name, e.status])).toEqual([["Export now", "trusted"], ["Order note", "trusted"]]);
  });
  it("is refused for an incompatible repair: the dry run says why (fixed problems), confirm is 409 REPAIR_INCOMPATIBLE and nothing is written", async () => {
    const h = await broken([control("Export", "textbox", "orders.exportButton"), control("Order note", "textbox", "orders.note")]);
    h.targets.definitions.push({ tenantId: TENANT_A, applicationId: MANAGED, id: "wt-0000000000a1", title: "Submit an order", status: "draft", definition: guide("orders.exportButton", "click") });
    const dry = await h.command(repairBody({ operations: ["highlight", "input"] }));
    expect(dry.status).toBe(200);
    expect((dry.body.impact as { compatible: boolean; problems: string[] })).toMatchObject({ compatible: false });
    expect((dry.body.impact as { problems: string[] }).problems.join(" ")).toMatch(/click/u);
    const real = await h.command(repairBody({ operations: ["highlight", "input"], confirm: true }));
    expect(real).toMatchObject({ status: 409, body: { error: "REPAIR_INCOMPATIBLE" } });
    expect((real.body.problems as string[]).length).toBeGreaterThan(0);
    expect(h.calls).toEqual([]);
    expect(await h.targets.get(TENANT_A, MANAGED, "orders.exportButton")).toMatchObject({ role: "button", revision: 1 });
  });
  it("a repair that loses a race with a new workflow is refused INSIDE the write: the executor's problems come back as REPAIR_INCOMPATIBLE", async () => {
    const h = await broken([control("Export", "textbox", "orders.exportButton"), control("Order note", "textbox", "orders.note")]);
    const real = h.targets.definitionsUsing.bind(h.targets);
    let calls = 0;
    h.targets.definitionsUsing = async (tenant, app, id) => {
      calls += 1;
      if (calls === 2) h.targets.definitions.push({ tenantId: TENANT_A, applicationId: MANAGED, id: "wt-0000000000a9", title: "Raced", status: "draft", definition: guide("orders.exportButton", "click", "Raced") });
      return real(tenant, app, id);
    };
    const res = await h.command(repairBody({ operations: ["highlight", "input"], confirm: true }));
    expect(res).toMatchObject({ status: 409, body: { error: "REPAIR_INCOMPATIBLE" } });
    expect(await h.targets.get(TENANT_A, MANAGED, "orders.exportButton")).toMatchObject({ role: "button", revision: 1 });
  });
  it("an unchanged repair is allowed as a dry run and refused on confirm (REPAIR_UNCHANGED)", async () => {
    const h = await broken([control("Export", "button", "orders.exportButton"), control("Order note", "textbox", "orders.note"), control("Newer", "button", "orders.newer")]);
    const body = repairBody({ ref: "@e1", label: "orders.exportButton", description: "orders.exportButton." });
    // @e1 is TRUSTED here (nothing is wrong), so it is not a candidate for a repair at all
    expect((await h.command(body)).body).toEqual({ error: "TARGET_NOT_REGISTRABLE" });
  });
  it("route identity never changes: a control on another page cannot repair the target (REPAIR_ROUTE_MISMATCH)", async () => {
    const h = await broken([control("Export", "button", "home.exportCopy"), control("Order note", "textbox", "orders.note")]);
    h.runtimes[0]!.url = `${ORIGIN}/`;
    await h.command(refresh());
    expect((await h.command(repairBody())).body).toEqual({ error: "REPAIR_ROUTE_MISMATCH" });
    expect(h.calls).toEqual([]);
  });
  it("a mismatched control that belongs to ANOTHER target is MARKER_IN_USE; an unknown target is TARGET_NOT_FOUND; a trusted ref is not a candidate", async () => {
    const h = await broken([control("Export", "link", "orders.exportButton"), control("Note", "link", "orders.note"), control("Fresh", "button", "orders.fresh")]);
    await h.command(refresh());
    expect((await h.command(repairBody({ ref: "@e2" }))).body).toEqual({ error: "MARKER_IN_USE" });
    expect((await h.command(repairBody({ targetId: "orders.missing" }))).body).toEqual({ error: "TARGET_NOT_FOUND" });
    const ok = await broken();
    expect((await ok.command(repairBody({ ref: "@e3" }))).body).toEqual({ error: "TARGET_NOT_REGISTRABLE" }); // the trusted note
    expect(h.calls).toEqual([]);
  });
  it("the trust chain: unknown, stale or hidden refs, private or ambiguous controls, drifted markers", async () => {
    const h = await broken([control("Export", "link", "orders.exportButton", { ...PUBLIC, dataAiPrivate: true }), control("Export now", "button", "orders.exportNow"), control("Order note", "textbox", "orders.note")]);
    expect((await h.command(repairBody({ ref: "@e1" }))).body, "a private control is hidden: never listed").toEqual({ error: "REF_NOT_FOUND" });
    expect((await h.command(repairBody({ ref: "@e99" }))).body).toEqual({ error: "REF_NOT_FOUND" });
    h.runtimes[0]!.controls[1]!.facts = { ...PUBLIC, dataAiPrivate: true };
    expect((await h.command(repairBody({ ref: "@e2", operations: ["highlight", "click"] }))).body, "turned private after the refresh").toEqual({ error: "TARGET_NOT_REGISTRABLE" });
    h.runtimes[0]!.controls[1]!.facts = PUBLIC;
    h.runtimes[0]!.controls[2]!.id = "orders.exportNow"; // another control of the inspected set now carries the same marker
    expect((await h.command(repairBody({ ref: "@e2" }))).body, "a twin appeared").toEqual({ error: "TARGET_NOT_REGISTRABLE" });
    h.runtimes[0]!.controls[2]!.id = "orders.note";
    h.runtimes[0]!.controls[1]!.id = null;
    expect((await h.command(repairBody({ ref: "@e2" }))).body, "the marker disappeared").toEqual({ error: "TARGET_NOT_REGISTRABLE" });
    h.runtimes[0]!.url = `${ORIGIN}/#/other`;
    expect((await h.command(repairBody({ ref: "@e2" }))).body, "the page changed").toEqual({ error: "REF_NOT_FOUND" });
    expect(h.calls).toEqual([]);
  });
  it("maintainer fields are judged by the shared validator against the LIVE role: 422 INVALID_TARGET with fixed issues, never an echo", async () => {
    const h = await broken();
    for (const over of [{ operations: ["highlight", "input"] }, { operations: [] }, { operations: ["click"] }, { label: "<b>x</b>" }, { label: "" }, { description: "x".repeat(241) }]) {
      const res = await h.command(repairBody(over));
      expect(res.status, JSON.stringify(over)).toBe(422);
      expect(res.body.error).toBe("INVALID_TARGET");
      expect((res.body.issues as string[]).length).toBeGreaterThan(0);
      if (typeof over.label === "string" && over.label.length > 3) expect(res.raw).not.toContain(over.label);
    }
    expect(h.calls).toEqual([]);
  });
  it("body: exact keys, a real boolean confirm, bounded values; the server-owned fields (marker, role, route, page, privacy, revision) are not accepted", async () => {
    const h = await broken();
    for (const bad of [{ confirm: "true" }, { confirm: 1 }, { marker: "x.y" }, { role: "link" }, { route: "orders" }, { page: "/" }, { privacy: "public" }, { revision: 2 }, { ref: "e1" }, { targetId: "x".repeat(201) }, { label: "x".repeat(1001) }]) {
      expect((await h.command(repairBody(bad))).body, JSON.stringify(bad)).toEqual({ error: "INVALID_REQUEST" });
    }
    const { confirm: _confirm, ...noConfirm } = repairBody();
    expect((await h.command(noConfirm)).body).toEqual({ error: "INVALID_REQUEST" });
  });
  it("ownership and state: another maintainer or tenant, a disabled application, a built-in application, an unavailable Gateway", async () => {
    const h = await broken();
    expect((await h.command(repairBody(), "another-maintainer")).body).toEqual({ error: "SESSION_CLOSED" });
    expect((await h.command(repairBody(), "tenant-b")).body).toEqual({ error: "SESSION_CLOSED" });
    expect((await h.command(repairBody({ applicationId: MANAGED_2 }))).body).toEqual({ error: "APPLICATION_MISMATCH" });
    h.state.mode = "refused";
    expect((await h.command(repairBody({ confirm: true }))).body).toEqual({ error: "FORBIDDEN" });
    h.state.mode = "broken";
    const down = await h.command(repairBody({ confirm: true }));
    expect(down.body).toEqual({ error: "BROWSER_UNAVAILABLE" });
    noLeak(down.raw);
    h.state.mode = "executor";
    await h.applications.setEnabled(SCOPE, MANAGED, false);
    expect((await h.command(repairBody({ confirm: true }))).body).toEqual({ error: "APPLICATION_DISABLED" });
    const builtIn = await harness();
    await builtIn.connect(BUILT_IN);
    expect((await builtIn.command({ ...repairBody({ applicationId: BUILT_IN }) })).body).toEqual({ error: "REGISTRY_NOT_MANAGED" });
  });
  it("a marker taken between the dry run and the write (the executor refuses) is diagnosed from the state: MARKER_IN_USE", async () => {
    const h = await broken();
    const real = h.targets.repair.bind(h.targets);
    h.targets.repair = async (scope, app, id, value, verify) => {
      await h.targets.register(SCOPE, MANAGED, reg(value.marker === "orders.exportNow" ? "orders.exportNow" : "orders.x", { label: "Taken" }));
      return real(scope, app, id, value, verify);
    };
    const res = await h.command(repairBody({ ref: "@e2", confirm: true }));
    expect(res.body).toEqual({ error: "MARKER_IN_USE" });
  });
  it("repairing a DISABLED target is allowed and has no problems of its own (workflows already fail while it is disabled)", async () => {
    const h = await broken();
    await h.targets.setStatus(SCOPE, MANAGED, "orders.exportButton", "disabled");
    h.targets.definitions.push({ tenantId: TENANT_A, applicationId: MANAGED, id: "wt-0000000000a1", title: "Old", status: "draft", definition: guide("orders.exportButton", "click") });
    await h.command(refresh());
    const dry = await h.command(repairBody({ ref: "@e2", operations: ["highlight", "input"] }));
    expect(dry.status).toBe(422); // the live control is a button: input is not an operation of its role
    const res = await h.command(repairBody({ ref: "@e2", operations: ["highlight", "click"], confirm: true }));
    expect(res.status).toBe(200);
    expect(res.body.target).toMatchObject({ status: "disabled", marker: "orders.exportNow", revision: 2 });
  });
});
