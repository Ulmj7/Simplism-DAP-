/** The DEV demo role mapping (principal.ts): a convenience that picks between two server-held sessions, never the authority. */
import { describe, expect, it, vi } from "vitest";
import { createGuidanceTransport } from "../http/transport.js";
import { createProposalStore } from "../http/proposal-store.js";
import { demoCatalogView } from "../guidance/walkthrough-summaries.js";
import type { DevSession } from "../dev-auth/index.js";
import type { AiSession } from "../compose.js";
import { createDemoPrincipalResolver, demoRoleFromHeaders } from "./principal.js";
import { registerAuthoringRoutes } from "./routes.js";
import type { RequestHeaders } from "./routes.js";
import { FakeApplicationStore } from "../studio/fake-application-store.js";
import { createRegistryCatalog } from "../studio/registries.js";

const TENANT = "1111aaaa-2222-4333-8444-5555bbbb5555";
const USER_TOKEN = "tok-user-0123456789abcdef";
const MAINT_TOKEN = "tok-maint-0123456789abcdef";
const session = (token: string, userId: string, permissions: readonly string[]): DevSession => ({ token, userId, tenantId: TENANT, sessionId: `s-${userId}`, validUntil: new Date(Date.now() + 3_600_000).toISOString(), permissions });
const SESSIONS = [session(USER_TOKEN, "ula", ["perm.demo.lookup"]), session(MAINT_TOKEN, "maya", ["perm.walkthrough.maintain"])];
const headers = (role?: unknown): RequestHeaders => (role === undefined ? {} : { "x-demo-role": role as string });

describe("demoRoleFromHeaders", () => {
  it("is maintainer ONLY for the exact string 'maintainer'; everything else, including absence, is user", () => {
    expect(demoRoleFromHeaders(headers("maintainer"))).toBe("maintainer");
    for (const value of [undefined, "user", "admin", "Maintainer", "MAINTAINER", " maintainer", "maintainer ", "maintainer,user", "", "root", "1", ["maintainer"], ["maintainer", "maintainer"], 5, null]) {
      expect(demoRoleFromHeaders(headers(value)), JSON.stringify(value)).toBe("user");
    }
  });
});

describe("createDemoPrincipalResolver", () => {
  const open = vi.fn<(token: string) => Promise<AiSession | null>>(async () => ({ submit: async () => ({ outcome: "ALLOWED", category: "ok" }) }));
  const resolver = (over: Partial<Parameters<typeof createDemoPrincipalResolver>[0]> = {}) => createDemoPrincipalResolver({ sessions: SESSIONS, userToken: USER_TOKEN, maintainerToken: MAINT_TOKEN, openSession: open, ...over });

  it("no header or an unknown one is the ordinary user; the maintainer header selects the maintainer session", async () => {
    const r = resolver();
    expect(await r(headers())).toMatchObject({ key: "dev-demo-user", actor: "ula", tenantId: TENANT });
    expect(await r(headers("admin"))).toMatchObject({ key: "dev-demo-user" });
    expect(await r(headers("maintainer"))).toMatchObject({ key: "dev-demo-maintainer", actor: "maya", tenantId: TENANT });
  });
  it("without a configured maintainer token the maintainer header means USER (never an unauthenticated maintainer)", async () => {
    for (const maintainerToken of [undefined, ""]) {
      const principal = await resolver({ maintainerToken })(headers("maintainer"));
      expect(principal).toMatchObject({ key: "dev-demo-user" });
      expect(principal?.permissions.has("perm.walkthrough.maintain")).toBe(false);
    }
  });
  it("permissions come from the host's own session table, NOT from the header: the header alone grants nothing", async () => {
    const r = resolver();
    expect((await r(headers()))?.permissions.has("perm.walkthrough.maintain")).toBe(false);
    expect((await r(headers("maintainer")))?.permissions.has("perm.walkthrough.maintain")).toBe(true);
    // a maintainer TOKEN whose session lacks the permission yields a principal without it: the routes then refuse it
    const weak = resolver({ sessions: [SESSIONS[0]!, session(MAINT_TOKEN, "maya", [])] });
    expect((await weak(headers("maintainer")))?.permissions.has("perm.walkthrough.maintain")).toBe(false);
  });
  it("a token that is not in the session table yields no principal (401), not a default one", async () => {
    expect(await resolver({ userToken: "tok-unknown-0123456789abcdef" })(headers())).toBeNull();
    expect(await resolver({ maintainerToken: "tok-unknown-0123456789abcdef" })(headers("maintainer"))).toMatchObject({ key: "dev-demo-user" });
  });
  it("a selected principal is refused at expiry even if it was valid at startup", async () => {
    vi.useFakeTimers();
    try {
      const expiry = Date.now() + 1000;
      const r = resolver({ sessions: [SESSIONS[0]!, { ...SESSIONS[1]!, validUntil: new Date(expiry).toISOString() }] });
      expect(await r(headers("maintainer"))).toMatchObject({ actor: "maya" });
      vi.setSystemTime(expiry);
      expect(await r(headers("maintainer"))).toBeNull();
      expect(await r(headers())).toMatchObject({ actor: "ula" });
    } finally { vi.useRealTimers(); }
  });
  it("submit opens a FRESH Gateway session for every call (each write is its own turn) and never exposes the token", async () => {
    open.mockClear();
    const principal = (await resolver()(headers("maintainer")))!;
    await principal.submit({ providerCallId: "a", arguments: "{}" });
    await principal.submit({ providerCallId: "b", arguments: "{}" });
    expect(open).toHaveBeenCalledTimes(2);
    expect(open).toHaveBeenNthCalledWith(1, MAINT_TOKEN);
    expect(JSON.stringify({ ...principal, permissions: [...principal.permissions] })).not.toContain(MAINT_TOKEN);
  });
  it("submit rejects when the session cannot be opened (the route turns that into a 503)", async () => {
    const principal = (await resolver({ openSession: async () => null })(headers()))!;
    await expect(principal.submit({ providerCallId: "a", arguments: "{}" })).rejects.toThrow();
  });
  it("the principal is frozen and its permission set is a copy", async () => {
    const principal = (await resolver()(headers("maintainer")))!;
    expect(Object.isFrozen(principal)).toBe(true);
    expect(principal.permissions).toBeInstanceOf(Set);
  });
});

describe("the role header through the routes: a user session stays a user, whatever the header says", () => {
  const app = (maintainerToken: string | undefined) => {
    const instance = createGuidanceTransport({ ask: async () => ({ kind: "clarify", message: "x" }), catalog: demoCatalogView, resolveSession: async () => null, proposals: createProposalStore({ now: Date.now, newId: () => "proposal-id-0000000000000000" }) });
    registerAuthoringRoutes(instance, {
      store: { recordEvent: async () => true, summary: async () => [], list: async () => [], get: async () => null, saveDraft: async () => "created", setStatus: async () => "changed", listPublished: async () => [] },
      applications: new FakeApplicationStore(), catalog: createRegistryCatalog(),
      resolvePrincipal: createDemoPrincipalResolver({ sessions: SESSIONS, userToken: USER_TOKEN, maintainerToken, openSession: async () => null }),
    });
    return instance;
  };
  it("X-Demo-Role: maintainer is 403 when no maintainer token is configured, 200 when one is; no header is 403", async () => {
    const without = app(undefined);
    const withToken = app(MAINT_TOKEN);
    const get = (instance: ReturnType<typeof app>, role?: string) => instance.inject({ method: "GET", url: "/api/admin/walkthroughs", headers: role === undefined ? {} : { "x-demo-role": role } });
    expect((await get(without, "maintainer")).statusCode).toBe(403);
    expect((await get(without)).statusCode).toBe(403);
    expect((await get(withToken)).statusCode).toBe(403);
    expect((await get(withToken, "maintainer")).statusCode).toBe(200);
    expect((await get(withToken, "admin")).statusCode).toBe(403);
  });
});
