/**
 * T406 transport tests through Fastify `inject`, with a clearly labelled FOCUSED FAKE: an in-memory store and a fake Gateway `submit` that applies the same rules the
 * trusted executors apply (permission, validation, draft-only updates, publish re-validation). They exist to test the ROUTES (guards, authorization, strict bodies, status
 * codes, closed replies). The proof that the real Gateway, the real executors and PostgreSQL behave is tests/integration/authoring-gateway.test.ts and
 * tests/integration/authoring-routes.test.ts.
 */
import { describe, expect, it } from "vitest";
import { createGuidanceTransport } from "../http/transport.js";
import { createProposalStore } from "../http/proposal-store.js";
import { demoCatalogView } from "../guidance/walkthrough-summaries.js";
import { MAINTAIN_PERMISSION, SAVE_ACTION_ID, STATUS_ACTION_ID } from "./capabilities.js";
import { AUTHORING_MESSAGES, registerAuthoringRoutes } from "./routes.js";
import type { AuthoringPrincipal } from "./routes.js";
import { MAX_PUBLISHED_PER_TENANT } from "./store.js";
import type { PublishCheck, SaveOutcome, StatusOutcome, StoredSummary, StoredWalkthrough, UsageEvent, WalkthroughStore } from "./store.js";
import { isAuthoredId } from "./ids.js";
import { TRUSTED_REGISTRY } from "./trusted-registry.js";
import type { TrustedRegistryData } from "./trusted-registry.js";
import { validateAuthoredDefinition } from "./validate.js";
import { FakeApplicationStore } from "../studio/fake-application-store.js";
import { createRegistryCatalog, registryDataFor } from "../studio/registries.js";
import type { RegistryEntry } from "../studio/registries.js";
import { FIXTURE_ENTRY } from "../studio/fixture-registry.js";

const TENANT_A = "1111aaaa-2222-4333-8444-5555bbbb5555";
const TENANT_B = "2222bbbb-3333-4444-8555-6666cccc6666";
const SECRET = "SECRET-SQL-select-from-walkthrough_definitions";
/** The enrolled reference application of each tenant (Studio V1A: every draft belongs to an application). */
const APP_A = "app-aaaaaaaaaaaa";
const APP_B = "app-bbbbbbbbbbbb";

// --- the focused fakes -------------------------------------------------------------------------------------------------------------------------------
interface Row { tenantId: string; id: string; status: "draft" | "published"; definition: unknown; updatedAt: string; applicationId?: string | null }
class FakeStore implements WalkthroughStore {
  readonly rows: Row[] = [];
  readonly events: (UsageEvent & { tenantId: string })[] = [];
  async recordEvent(tenantId: string, event: UsageEvent) {
    this.check();
    if (isAuthoredId(event.walkthroughId) && (await this.get(tenantId, event.walkthroughId))?.status !== "published") return false;
    if (event.event !== "started" && !this.events.some(row => row.tenantId === tenantId && row.walkthroughId === event.walkthroughId
      && row.runId === event.runId && row.event === "started")) return true;
    if (!this.events.some(row => row.tenantId === tenantId && row.runId === event.runId
      && (row.event === event.event || (row.event !== "started" && event.event !== "started")))) this.events.push({ ...event, tenantId });
    return true;
  }
  async summary(tenantId: string) {
    this.check();
    return tenantId === TENANT_A ? [{ id: "profileUpdate", title: null, started: 3, completed: 2, cancelled: 1 }] : [];
  }
  failWith: Error | null = null;
  private check(): void { if (this.failWith !== null) throw this.failWith; }
  async list(tenantId: string): Promise<readonly StoredSummary[]> {
    this.check();
    return this.rows.filter((r) => r.tenantId === tenantId).map((r) => ({ id: r.id, title: String((r.definition as { title?: unknown }).title), description: String((r.definition as { description?: unknown }).description), status: r.status, stepCount: ((r.definition as { steps?: { kind?: string }[] }).steps ?? []).filter(step => step.kind === "guide").length, updatedAt: r.updatedAt, applicationId: r.applicationId ?? null }));
  }
  async get(tenantId: string, id: string): Promise<StoredWalkthrough | null> {
    this.check();
    const row = this.rows.find((r) => r.tenantId === tenantId && r.id === id);
    return row === undefined ? null : { id: row.id, status: row.status, definition: row.definition, updatedAt: row.updatedAt, applicationId: row.applicationId ?? null };
  }
  async saveDraft(scope: { tenantId: string; actor: string }, id: string, definition: unknown, applicationId: string): Promise<SaveOutcome> {
    this.check();
    const row = this.rows.find((r) => r.tenantId === scope.tenantId && r.id === id);
    if (row === undefined) { this.rows.push({ tenantId: scope.tenantId, id, status: "draft", definition, updatedAt: new Date().toISOString(), applicationId }); return "created"; }
    if (row.status !== "draft") return "not_a_draft";
    if (row.applicationId != null && row.applicationId !== applicationId) return "application_mismatch";
    row.definition = definition;
    row.applicationId = applicationId;
    return "updated";
  }
  async setStatus(scope: { tenantId: string; actor: string }, id: string, status: "draft" | "published", isValid: PublishCheck): Promise<StatusOutcome> {
    this.check();
    const row = this.rows.find((r) => r.tenantId === scope.tenantId && r.id === id);
    if (row === undefined) return "not_found";
    if (row.status === status) return "unchanged";
    if (status === "published") {
      if (!(await isValid(row.definition, row.applicationId ?? null, undefined as never, null))) return "invalid_definition";
      if (this.rows.filter((r) => r.tenantId === scope.tenantId && r.status === "published").length >= MAX_PUBLISHED_PER_TENANT) return "limit_reached";
    }
    row.status = status;
    return "changed";
  }
  async listPublished(tenantId: string): Promise<readonly StoredWalkthrough[]> {
    this.check();
    return this.rows.filter((r) => r.tenantId === tenantId && r.status === "published").slice(0, MAX_PUBLISHED_PER_TENANT).map((r) => ({ id: r.id, status: r.status, definition: r.definition, updatedAt: r.updatedAt, applicationId: r.applicationId ?? null }));
  }
}

type Who = "maintainer" | "user" | "maintainerB" | "none" | "throws";
interface Submitted { who: Who; action: string; params: Record<string, unknown> }
function build(over: { registryData?: TrustedRegistryData; feedback?: (action: string) => unknown; newIds?: string[]; extraRegistries?: RegistryEntry[] } = {}) {
  const store = new FakeStore();
  const applications = new FakeApplicationStore();
  const catalog = createRegistryCatalog(over.extraRegistries ?? []);
  const reference = { name: "Reference application", origin: "http://localhost:5184", allowedOrigins: ["http://localhost:5184"], environment: "development" as const, registryId: "reference" };
  void applications.save({ tenantId: TENANT_A, actor: "seed" }, APP_A, reference);
  void applications.save({ tenantId: TENANT_B, actor: "seed" }, APP_B, reference);
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
        if (action === SAVE_ACTION_ID) {
          const application = await applications.get(tenant, params.applicationId as string);
          if (application === null || !application.enabled) return { outcome: "ALLOWED", category: "try_later" };
          const checked = validateAuthoredDefinition(params.walkthroughId, params.definition, registryDataFor(catalog, application.registryId, over.registryData));
          if (!checked.ok) return { outcome: "ALLOWED", category: "try_later" };
          const outcome = await store.saveDraft(scope, params.walkthroughId as string, checked.definition, application.id);
          return { outcome: "ALLOWED", category: outcome === "created" || outcome === "updated" ? "ok" : "try_later" };
        }
        if (action === STATUS_ACTION_ID) {
          const stored = await store.get(tenant, params.walkthroughId as string);
          const application = stored?.applicationId == null ? null : await applications.get(tenant, stored.applicationId);
          const registryData = registryDataFor(catalog, application?.registryId ?? "reference", over.registryData);
          const outcome = await store.setStatus(scope, params.walkthroughId as string, params.status as "draft" | "published", (d) => registryData !== undefined && validateAuthoredDefinition(params.walkthroughId, d, registryData).ok);
          return { outcome: "ALLOWED", category: outcome === "changed" || outcome === "unchanged" ? "ok" : "try_later" };
        }
        return { outcome: "INVALID_ACTION", category: "not_available" };
      },
    });
  }
  const app = createGuidanceTransport({ ask: async () => ({ kind: "clarify", message: "x" }), catalog: demoCatalogView, resolveSession: async () => null, proposals: createProposalStore({ now: Date.now, newId: () => "proposal-id-0000000000000000" }) });
  const ids = [...(over.newIds ?? [])];
  registerAuthoringRoutes(app, {
    store, applications, catalog,
    resolvePrincipal: async (headers) => {
      const who = String(headers["x-test-principal"] ?? "none") as Who;
      if (who === "throws") throw new Error(SECRET);
      return principals.get(who) ?? null;
    },
    ...(over.registryData === undefined ? {} : { registryData: over.registryData }),
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
    return { status: res.statusCode, body, raw: res.body, headers: res.headers };
  };
  return { app, store, applications, catalog, submitted, call };
}

const defOf = (over: Record<string, unknown> = {}) => ({
  title: "Save your name", description: "Change your display name and save it.", start: "n1",
  steps: [{ id: "n1", kind: "navigate", route: "profile", next: "s1" }, { id: "s1", kind: "guide", target: "profile.saveButton", text: "Press Save.", wait: "click", verify: "profile.saved", next: "done" }, { id: "done", kind: "complete", text: "Done." }],
  ...over,
});
const ID1 = "wt-0000000000a1";
const ID2 = "wt-0000000000a2";
/** Nothing internal ever leaves. */
function expectNoLeak(raw: string) {
  for (const word of [SECRET, "SECRET", "perm.", "walkthrough.maintain", "saveWalkthroughDraft", "setWalkthroughStatus", "ex.authoring", "Error", "stack", "    at ", "Zod", "zod", "invalid_type", "UNAUTHORIZED", "ALLOWED", "outcome", "category", "stage", "MEDIUM", "tenantId", TENANT_A, TENANT_B, "SELECT", "sec_audit", "walkthrough_definitions"]) expect(raw, word).not.toContain(word);
}

describe("inherited transport guards (an authoring route is on the C01 instance)", () => {
  it("a Host that is not loopback is refused before routing", async () => {
    const t = build();
    for (const host of ["evil.example", "127.0.0.1.evil.example", "localhost.evil.example:8787", "evil.example:8787"]) {
      const res = await t.call("GET", "/api/admin/walkthroughs", { who: "maintainer", headers: { host } });
      expect(res.status, host).toBe(403);
    }
    expect((await t.call("GET", "/api/admin/walkthroughs", { who: "maintainer", headers: { host: "localhost:5173" } })).status).toBe(200);
    expect((await t.call("GET", "/api/admin/walkthroughs", { who: "maintainer", headers: { host: "127.0.0.1:8787" } })).status).toBe(200);
  });
  it("a cross-site Sec-Fetch-Site is refused on reads and writes; same-origin and none pass", async () => {
    const t = build();
    for (const site of ["cross-site", "same-site"]) {
      expect((await t.call("GET", "/api/admin/walkthroughs", { who: "maintainer", headers: { "sec-fetch-site": site } })).status, site).toBe(403);
      expect((await t.call("POST", "/api/admin/walkthroughs", { who: "maintainer", body: { applicationId: APP_A, definition: defOf() }, headers: { "sec-fetch-site": site } })).status, site).toBe(403);
    }
    for (const site of ["same-origin", "none"]) expect((await t.call("GET", "/api/admin/walkthroughs", { who: "maintainer", headers: { "sec-fetch-site": site } })).status, site).toBe(200);
    expect(t.submitted).toEqual([]);
  });
  it("a non-JSON content type on a write is 415, with a fixed message", async () => {
    const t = build();
    const res = await t.call("POST", "/api/admin/walkthroughs", { who: "maintainer", raw: JSON.stringify({ applicationId: APP_A, definition: defOf() }), headers: { "content-type": "text/plain" } });
    expect(res.status).toBe(415);
    expectNoLeak(res.raw);
    expect((await t.call("POST", "/api/admin/walkthroughs", { who: "maintainer", raw: "definition=x", headers: { "content-type": "application/x-www-form-urlencoded" } })).status).toBe(415);
    expect(t.submitted).toEqual([]);
  });
  it("a body over 64 KiB is 413", async () => {
    const t = build();
    const res = await t.call("POST", "/api/admin/walkthroughs", { who: "maintainer", raw: JSON.stringify({ applicationId: APP_A, definition: defOf({ description: "d".repeat(70_000) }) }) });
    expect(res.status).toBe(413);
    expectNoLeak(res.raw);
    expect(t.submitted).toEqual([]);
  });
  it("malformed JSON is a fixed 400, and prototype-poisoning keys are refused", async () => {
    const t = build();
    for (const raw of ["{", "[]", '{"definition":', '{"__proto__":{"x":1},"definition":{}}', '{"constructor":{"prototype":{}},"definition":{}}']) {
      const res = await t.call("POST", "/api/admin/walkthroughs", { who: "maintainer", raw });
      expect(res.status, raw).toBe(400);
      expectNoLeak(res.raw);
    }
  });
  it("every reply carries no-store and nosniff, errors included", async () => {
    const t = build();
    for (const res of [await t.call("GET", "/api/walkthroughs/published", { who: "user" }), await t.call("GET", "/api/admin/walkthroughs", { who: "user" }), await t.call("GET", "/api/admin/walkthroughs"), await t.call("GET", "/api/admin/walkthroughs/wt-aaaaaaaaaaaa", { who: "maintainer" })]) {
      expect(res.headers["cache-control"]).toBe("no-store");
      expect(res.headers["x-content-type-options"]).toBe("nosniff");
      expect(String(res.headers["content-type"])).toContain("application/json");
    }
  });
  it("no route offers DELETE, PATCH or audit: they are 404 with the fixed message", async () => {
    const t = build();
    for (const [method, url] of [["DELETE", `/api/admin/walkthroughs/${ID1}`], ["PATCH", `/api/admin/walkthroughs/${ID1}`], ["GET", "/api/admin/audit"], ["GET", "/api/admin"]] as const) {
      const res = await t.call(method, url, { who: "maintainer" });
      expect(res.status, `${method} ${url}`).toBe(404);
    }
  });
});

describe("authentication and the maintainer gate", () => {
  const ADMIN: readonly [string, string, unknown?][] = [
    ["GET", "/api/admin/walkthroughs"], ["GET", `/api/admin/walkthroughs/${ID1}`], ["POST", "/api/admin/walkthroughs", { applicationId: APP_A, definition: defOf() }],
    ["PUT", `/api/admin/walkthroughs/${ID1}`, { expectedRevision: 1, applicationId: APP_A, definition: defOf() }], ["POST", `/api/admin/walkthroughs/${ID1}/status`, { status: "published" }],
  ];
  const run = (t: ReturnType<typeof build>, method: string, url: string, who: Who, body?: unknown) => t.call(method as "GET", url, { who, ...(body === undefined ? {} : { body }) });
  it.each(ADMIN)("%s %s: no session is 401", async (method, url, body) => {
    const t = build();
    const res = await run(t, method, url, "none", body);
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ kind: "unauthenticated", message: AUTHORING_MESSAGES.noSession });
    expect(t.submitted).toEqual([]);
  });
  it("GET published without a session is 401 too, and a resolver that throws is 401 (fail closed)", async () => {
    const t = build();
    expect((await t.call("GET", "/api/walkthroughs/published")).status).toBe(401);
    const res = await t.call("GET", "/api/admin/walkthroughs", { who: "throws" });
    expect(res.status).toBe(401);
    expectNoLeak(res.raw);
  });
  it.each(ADMIN)("%s %s: an ordinary user (no maintain permission) is 403 with a fixed body, the Gateway is never asked and nothing is stored", async (method, url, body) => {
    const t = build();
    const res = await run(t, method, url, "user", body);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ kind: "forbidden", message: AUTHORING_MESSAGES.forbidden });
    expectNoLeak(res.raw);
    expect(t.submitted).toEqual([]);
    expect(t.store.rows).toEqual([]);
  });
  it("the maintainer gate comes BEFORE body and id checks: a user probing a bad id or body learns nothing but 403", async () => {
    const t = build();
    expect((await t.call("POST", "/api/admin/walkthroughs", { who: "user", body: { tenantId: "x" } })).status).toBe(403);
    expect((await t.call("GET", "/api/admin/walkthroughs/profileUpdate", { who: "user" })).status).toBe(403);
    expect((await t.call("PUT", "/api/admin/walkthroughs/not-an-id", { who: "user", body: {} })).status).toBe(403);
  });
  it("an ordinary user CAN read the published list (any valid session), and it holds no draft", async () => {
    const t = build();
    await t.call("POST", "/api/admin/walkthroughs", { who: "maintainer", body: { applicationId: APP_A, definition: defOf() } });
    const res = await t.call("GET", "/api/walkthroughs/published", { who: "user" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ walkthroughs: [], external: [] });
  });
});

describe("GET /api/admin/walkthroughs and /:id", () => {
  it("returns { authored, builtIn } with the exact closed fields; built-in guides are a SEPARATE read-only array and never stored", async () => {
    const t = build({ newIds: [ID1] });
    await t.call("POST", "/api/admin/walkthroughs", { who: "maintainer", body: { applicationId: APP_A, definition: defOf() } });
    const res = await t.call("GET", "/api/admin/walkthroughs", { who: "maintainer" });
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(["authored", "builtIn"]);
    const authored = res.body.authored as Record<string, unknown>[];
    expect(authored).toHaveLength(1);
    expect(Object.keys(authored[0]!).sort()).toEqual(["applicationId", "description", "id", "status", "stepCount", "title", "updatedAt"]);
    expect(authored[0]).toMatchObject({ id: ID1, title: "Save your name", status: "draft", stepCount: 1 });
    const builtIn = res.body.builtIn as Record<string, unknown>[];
    expect(builtIn.map((b) => b.id)).toEqual(["profileUpdate", "findSecuritySettings", "findTwoFactorSettings"]);
    for (const guide of builtIn) expect(Object.keys(guide).sort()).toEqual(["description", "id", "title"]);
    expect(authored.map((a) => a.id)).not.toContain("profileUpdate");
    expect(t.store.rows.map((r) => r.id)).toEqual([ID1]);
  });
  it("an absurdly long id is refused by the framework with a fixed 4xx and no leak", async () => {
    const t = build();
    const res = await t.call("GET", `/api/admin/walkthroughs/${"x".repeat(300)}`, { who: "maintainer" });
    expect([400, 404, 414]).toContain(res.status);
    expectNoLeak(res.raw);
  });
  it("only the caller's tenant: another tenant's maintainer sees none of it", async () => {
    const t = build({ newIds: [ID1] });
    await t.call("POST", "/api/admin/walkthroughs", { who: "maintainer", body: { applicationId: APP_A, definition: defOf() } });
    expect(((await t.call("GET", "/api/admin/walkthroughs", { who: "maintainerB" })).body.authored as unknown[])).toEqual([]);
    expect((await t.call("GET", `/api/admin/walkthroughs/${ID1}`, { who: "maintainerB" })).status).toBe(404);
  });
  it("GET :id returns { id, status, applicationId, definition } for an authored guide; a built-in id, an unknown id and junk are 404", async () => {
    const t = build({ newIds: [ID1] });
    await t.call("POST", "/api/admin/walkthroughs", { who: "maintainer", body: { applicationId: APP_A, definition: defOf() } });
    const res = await t.call("GET", `/api/admin/walkthroughs/${ID1}`, { who: "maintainer" });
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(["applicationId", "definition", "id", "status"]);
    expect(res.body).toMatchObject({ id: ID1, status: "draft", definition: { id: ID1, title: "Save your name" } });
    for (const id of ["profileUpdate", "findSecuritySettings", "wt-preview", "wt-ffffffffffff", "__proto__", "..%2Fetc", "wt-ABCDEF012345", "x".repeat(90)]) {
      const miss = await t.call("GET", `/api/admin/walkthroughs/${id}`, { who: "maintainer" });
      expect(miss.status, id).toBe(404);
      expect(miss.body).toEqual({ kind: "not_found", message: AUTHORING_MESSAGES.notFound });
    }
  });
});

describe("POST /api/admin/walkthroughs (create)", () => {
  it("validates, generates the id on the host, goes through the Gateway once, reads the record back and replies 201", async () => {
    const t = build({ newIds: [ID1] });
    const res = await t.call("POST", "/api/admin/walkthroughs", { who: "maintainer", body: { applicationId: APP_A, definition: defOf() } });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: ID1, status: "draft", definition: { id: ID1, title: "Save your name" } });
    expect(t.submitted).toHaveLength(1);
    expect(t.submitted[0]).toMatchObject({ who: "maintainer", action: "saveWalkthroughDraft" });
    expect(Object.keys(t.submitted[0]!.params).sort()).toEqual(["applicationId", "definition", "expectedRevision", "walkthroughId"]);
    expect(t.submitted[0]!.params.walkthroughId).toBe(ID1);
  });
  it("refuses every supplied create id and leaves server-generated ids to the host", async () => {
    const t = build({ newIds: [ID2] });
    for (const id of ["someGuide", "profileUpdate", "findSecuritySettings", "findTwoFactorSettings", "wt-preview", ID1, 7, null]) {
      expect((await t.call("POST", "/api/admin/walkthroughs", { who: "maintainer", body: { applicationId: APP_A, definition: defOf({ id }) } })).status).toBe(422);
    }
    expect(t.submitted).toEqual([]);
    expect(t.store.rows).toEqual([]);
    const res = await t.call("POST", "/api/admin/walkthroughs", { who: "maintainer", body: { applicationId: APP_A, definition: defOf() } });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ id: ID2, definition: { id: ID2 } });
  });
  it("a collision of the generated id with an existing guide is NOT a silent overwrite of a published guide (the draft-only rule holds)", async () => {
    const t = build({ newIds: [ID1, ID1] });
    await t.call("POST", "/api/admin/walkthroughs", { who: "maintainer", body: { applicationId: APP_A, definition: defOf({ title: "First" }) } });
    await t.call("POST", `/api/admin/walkthroughs/${ID1}/status`, { who: "maintainer", body: { status: "published" } });
    const again = await t.call("POST", "/api/admin/walkthroughs", { who: "maintainer", body: { applicationId: APP_A, definition: defOf({ title: "Second" }) } });
    expect(again.status).toBe(503);
    expect((t.store.rows[0]!.definition as { title: string }).title).toBe("First");
  });
  it.each([
    ["tenantId"], ["permissions"], ["id"], ["status"], ["actor"], ["extra"],
  ])("a body with the extra key %s next to { definition } is 400 and nothing is submitted", async (key) => {
    const t = build();
    const res = await t.call("POST", "/api/admin/walkthroughs", { who: "maintainer", body: { applicationId: APP_A, definition: defOf(), [key]: key === "permissions" ? [MAINTAIN_PERMISSION] : "x" } });
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ kind: "malformed", message: AUTHORING_MESSAGES.malformed });
    expect(t.submitted).toEqual([]);
  });
  it.each([[{}], [{ definition: "x" }], [{ definition: null }], [{ definition: [] }], [{ definition: 5 }], [[]], [null], ["x"]])("the malformed body %j is 400", async (body) => {
    const t = build();
    expect((await t.call("POST", "/api/admin/walkthroughs", { who: "maintainer", body })).status).toBe(400);
    expect(t.submitted).toEqual([]);
  });
  it("an invalid definition is 422 { kind: 'invalid', issues } with the validator's wording, and the Gateway is never asked", async () => {
    const t = build();
    const bad = defOf({ steps: [{ id: "n1", kind: "navigate", route: "admin", next: "s1" }, { id: "s1", kind: "guide", target: "#save", text: "x", wait: "hover", verify: "eval", next: "done" }, { id: "done", kind: "complete", text: "Done." }] });
    const res = await t.call("POST", "/api/admin/walkthroughs", { who: "maintainer", body: { applicationId: APP_A, definition: bad } });
    expect(res.status).toBe(422);
    expect(Object.keys(res.body).sort()).toEqual(["issues", "kind", "message"]);
    expect(res.body).toMatchObject({ kind: "invalid", message: AUTHORING_MESSAGES.invalid });
    const text = (res.body.issues as string[]).join(" | ");
    expect(text).toMatch(/unknown route/);
    expect(text).toMatch(/unknown target/);
    expect(t.submitted).toEqual([]);
    expect(t.store.rows).toEqual([]);
  });
  it("422 diagnostics identify the problem without reflecting arbitrary field names or step ids", async () => {
    const t = build();
    const extra = await t.call("POST", "/api/admin/walkthroughs", { who: "maintainer", body: { applicationId: APP_A, definition: defOf({ [SECRET]: "ignored" }) } });
    expect(extra.status).toBe(422);
    expect(extra.body.issues).toEqual([expect.stringContaining("unknown field")]);
    expect(extra.raw).not.toContain(SECRET);
    const sensitiveId = "SecretTokenCanary123";
    const bad = defOf({ start: sensitiveId, steps: [
      { id: sensitiveId, kind: "guide", target: "unknown", text: "x", wait: "click", next: "done" },
      { id: "done", kind: "complete", text: "Done." },
    ] });
    const semantic = await t.call("POST", "/api/admin/walkthroughs", { who: "maintainer", body: { applicationId: APP_A, definition: bad } });
    expect(semantic.status).toBe(422);
    expect(semantic.body.issues).toEqual([expect.stringContaining("unknown target")]);
    expect(semantic.raw).not.toContain(sensitiveId);
    expect(t.submitted).toEqual([]);
  });

  it("issues are capped at 20 of at most 200 characters, with control characters removed", async () => {
    const t = build();
    const many = Array.from({ length: 8 }, (_v, i) => ({ id: `s${i}`, kind: "guide", target: `bad.target${i}`, text: "x", wait: "click", next: i === 7 ? "done" : `s${i + 1}`, ["k\n" + "y".repeat(300)]: 1 }));
    const res = await t.call("POST", "/api/admin/walkthroughs", { who: "maintainer", body: { applicationId: APP_A, definition: defOf({ start: "s0", steps: [...many, { id: "done", kind: "complete", text: "x" }] }) } });
    expect(res.status).toBe(422);
    const issues = res.body.issues as string[];
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.length).toBeLessThanOrEqual(20);
    for (const issue of issues) { expect(issue.length).toBeLessThanOrEqual(200); expect(issue).not.toMatch(/[\r\n\u0000-\u001f]/); }
  });
  it("shape violations the authoring bounds catch (zero guide steps, markup, 25 steps) are 422 too", async () => {
    const t = build();
    expect((await t.call("POST", "/api/admin/walkthroughs", { who: "maintainer", body: { applicationId: APP_A, definition: defOf({ start: "done", steps: [{ id: "done", kind: "complete", text: "x" }] }) } })).status).toBe(422);
    expect((await t.call("POST", "/api/admin/walkthroughs", { who: "maintainer", body: { applicationId: APP_A, definition: defOf({ title: "<b>x</b>" }) } })).status).toBe(422);
    const many = Array.from({ length: 25 }, (_v, i) => ({ id: `p${i}`, kind: "navigate", route: "profile", next: i === 24 ? "done" : `p${i + 1}` }));
    expect((await t.call("POST", "/api/admin/walkthroughs", { who: "maintainer", body: { applicationId: APP_A, definition: defOf({ start: "p0", steps: [...many, { id: "done", kind: "complete", text: "x" }] }) } })).status).toBe(422);
    expect(t.submitted).toEqual([]);
  });
});

describe("PUT /api/admin/walkthroughs/:id (edit a draft)", () => {
  it("rejects mismatched edit ids without writing and accepts a matching id", async () => {
    const t = build({ newIds: [ID1] });
    await t.call("POST", "/api/admin/walkthroughs", { who: "maintainer", body: { applicationId: APP_A, definition: defOf({ title: "First" }) } });
    const rejected = await t.call("PUT", `/api/admin/walkthroughs/${ID1}`, { who: "maintainer", body: { expectedRevision: 1, applicationId: APP_A, definition: defOf({ title: "Wrong", id: ID2 }) } });
    expect(rejected.status).toBe(422);
    expect(t.submitted).toHaveLength(1);
    expect(t.store.rows[0]?.definition).toMatchObject({ title: "First" });
    const res = await t.call("PUT", `/api/admin/walkthroughs/${ID1}`, { who: "maintainer", body: { expectedRevision: 1, applicationId: APP_A, definition: defOf({ title: "Second", id: ID1 }) } });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ id: ID1, status: "draft", definition: { id: ID1, title: "Second" } });
    expect(t.store.rows).toHaveLength(1);
  });
  it("a PUBLISHED guide is 409 (nothing submitted); an unknown id is 404; a built-in id is 404; another tenant's id is 404", async () => {
    const t = build({ newIds: [ID1] });
    await t.call("POST", "/api/admin/walkthroughs", { who: "maintainer", body: { applicationId: APP_A, definition: defOf() } });
    await t.call("POST", `/api/admin/walkthroughs/${ID1}/status`, { who: "maintainer", body: { status: "published" } });
    const before = t.submitted.length;
    const conflict = await t.call("PUT", `/api/admin/walkthroughs/${ID1}`, { who: "maintainer", body: { expectedRevision: 1, applicationId: APP_A, definition: defOf({ title: "Nope" }) } });
    expect(conflict.status).toBe(409);
    expect(conflict.body).toEqual({ kind: "conflict", message: AUTHORING_MESSAGES.published });
    expect(t.submitted).toHaveLength(before);
    expect((await t.call("PUT", `/api/admin/walkthroughs/${ID2}`, { who: "maintainer", body: { expectedRevision: 1, applicationId: APP_A, definition: defOf() } })).status).toBe(404);
    expect((await t.call("PUT", "/api/admin/walkthroughs/profileUpdate", { who: "maintainer", body: { expectedRevision: 1, applicationId: APP_A, definition: defOf() } })).status).toBe(404);
    expect((await t.call("PUT", `/api/admin/walkthroughs/${ID1}`, { who: "maintainerB", body: { expectedRevision: 1, applicationId: APP_A, definition: defOf() } })).status).toBe(404);
  });
  it("an invalid edit is 422 and leaves the stored draft unchanged", async () => {
    const t = build({ newIds: [ID1] });
    await t.call("POST", "/api/admin/walkthroughs", { who: "maintainer", body: { applicationId: APP_A, definition: defOf({ title: "Good" }) } });
    const res = await t.call("PUT", `/api/admin/walkthroughs/${ID1}`, { who: "maintainer", body: { expectedRevision: 1, applicationId: APP_A, definition: defOf({ start: "nowhere" }) } });
    expect(res.status).toBe(422);
    expect((t.store.rows[0]!.definition as { title: string }).title).toBe("Good");
  });
  it("strict body: extra keys are 400", async () => {
    const t = build({ newIds: [ID1] });
    await t.call("POST", "/api/admin/walkthroughs", { who: "maintainer", body: { applicationId: APP_A, definition: defOf() } });
    for (const key of ["tenantId", "permissions", "id", "status"]) expect((await t.call("PUT", `/api/admin/walkthroughs/${ID1}`, { who: "maintainer", body: { expectedRevision: 1, applicationId: APP_A, definition: defOf(), [key]: "x" } })).status, key).toBe(400);
  });
  it("a guide published between the read and the write is still a 409 (the executor refused: re-read)", async () => {
    const t = build({ newIds: [ID1] });
    await t.call("POST", "/api/admin/walkthroughs", { who: "maintainer", body: { applicationId: APP_A, definition: defOf() } });
    const realGet = t.store.get.bind(t.store);
    let reads = 0;
    t.store.get = async (tenant, id) => { const row = await realGet(tenant, id); reads += 1; if (reads === 1 && row !== null) { t.store.rows[0]!.status = "published"; return { ...row, status: "draft" }; } return row; };
    const res = await t.call("PUT", `/api/admin/walkthroughs/${ID1}`, { who: "maintainer", body: { expectedRevision: 1, applicationId: APP_A, definition: defOf({ title: "Late" }) } });
    expect(res.status).toBe(409);
  });
});

describe("POST /api/admin/walkthroughs/:id/status (publish, unpublish)", () => {
  const withDraft = async (over: Parameters<typeof build>[0] = {}) => { const t = build({ newIds: [ID1], ...over }); await t.call("POST", "/api/admin/walkthroughs", { who: "maintainer", body: { applicationId: APP_A, definition: defOf() } }); return t; };
  it("publish then unpublish: 200 with the stored record each time; the published list follows", async () => {
    const t = await withDraft();
    const published = await t.call("POST", `/api/admin/walkthroughs/${ID1}/status`, { who: "maintainer", body: { status: "published" } });
    expect(published.status).toBe(200);
    expect(published.body).toMatchObject({ id: ID1, status: "published" });
    const list = await t.call("GET", "/api/walkthroughs/published", { who: "user" });
    expect((list.body.walkthroughs as { id: string }[]).map((g) => g.id)).toEqual([ID1]);
    const draft = await t.call("POST", `/api/admin/walkthroughs/${ID1}/status`, { who: "maintainer", body: { status: "draft" } });
    expect(draft.status).toBe(200);
    expect(draft.body).toMatchObject({ status: "draft" });
    expect((await t.call("GET", "/api/walkthroughs/published", { who: "user" })).body).toEqual({ walkthroughs: [], external: [] });
    expect(t.submitted.filter((s) => s.action === "setWalkthroughStatus").map((s) => s.params)).toEqual([{ walkthroughId: ID1, status: "published" }, { walkthroughId: ID1, status: "draft" }]);
  });
  it("publish pre-validates the STORED definition against the CURRENT registry: a stale draft is 422 and the Gateway is not asked", async () => {
    const drifted: TrustedRegistryData = { ...TRUSTED_REGISTRY, elements: TRUSTED_REGISTRY.elements.filter((e) => e.id !== "profile.saveButton") };
    const t = await withDraft();
    // a second route table over the SAME store, with a registry that has changed
    const second = build({ registryData: drifted });
    second.store.rows.push(...t.store.rows);
    const res = await second.call("POST", `/api/admin/walkthroughs/${ID1}/status`, { who: "maintainer", body: { status: "published" } });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ kind: "invalid" });
    expect((res.body.issues as string[]).join(" ")).toMatch(/unknown target/);
    expect(second.submitted).toEqual([]);
    expect(second.store.rows[0]!.status).toBe("draft");
  });
  it("unpublishing never needs a valid definition (a stale published guide can always be taken down)", async () => {
    const t = await withDraft();
    await t.call("POST", `/api/admin/walkthroughs/${ID1}/status`, { who: "maintainer", body: { status: "published" } });
    const drifted: TrustedRegistryData = { ...TRUSTED_REGISTRY, postconditionNames: ["profile.saved2", "route.profile", "route.settings", "settings.advancedOpen"] };
    const second = build({ registryData: drifted });
    second.store.rows.push(...t.store.rows);
    expect((await second.call("POST", `/api/admin/walkthroughs/${ID1}/status`, { who: "maintainer", body: { status: "draft" } })).status).toBe(200);
  });
  it(`the limit of ${MAX_PUBLISHED_PER_TENANT} published guides is a 409 with a fixed message`, async () => {
    const t = await withDraft();
    const valid = t.store.rows[0]!.definition;
    for (let i = 0; i < MAX_PUBLISHED_PER_TENANT; i++) t.store.rows.push({ tenantId: TENANT_A, id: `wt-${String(i).padStart(12, "0")}`, status: "published", definition: valid, updatedAt: new Date().toISOString() });
    const res = await t.call("POST", `/api/admin/walkthroughs/${ID1}/status`, { who: "maintainer", body: { status: "published" } });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({ kind: "conflict", message: AUTHORING_MESSAGES.limit });
  });
  it.each([[{ status: "archived" }], [{ status: "Published" }], [{ status: 5 }], [{ status: null }], [{}], [{ status: "draft", tenantId: "x" }], [{ status: "draft", id: ID2 }], [{ status: ["draft"] }], [[]], [null]])("the malformed body %j is 400", async (body) => {
    const t = await withDraft();
    const before = t.submitted.length;
    expect((await t.call("POST", `/api/admin/walkthroughs/${ID1}/status`, { who: "maintainer", body })).status).toBe(400);
    expect(t.submitted).toHaveLength(before);
  });
  it("an unknown, built-in, malformed or other-tenant id is 404", async () => {
    const t = await withDraft();
    for (const [id, who] of [[ID2, "maintainer"], ["profileUpdate", "maintainer"], ["wt-preview", "maintainer"], ["junk", "maintainer"], [ID1, "maintainerB"]] as const) {
      expect((await t.call("POST", `/api/admin/walkthroughs/${id}/status`, { who, body: { status: "published" } })).status, `${id} ${who}`).toBe(404);
    }
  });
});

describe("GET /api/walkthroughs/published", () => {
  it("returns published guides only (never a draft), as validated definitions, for the session's own tenant", async () => {
    const t = build({ newIds: [ID1, ID2, "wt-0000000000a3"] });
    for (const title of ["One", "Two", "Three"]) await t.call("POST", "/api/admin/walkthroughs", { who: "maintainer", body: { applicationId: APP_A, definition: defOf({ title }) } });
    await t.call("POST", `/api/admin/walkthroughs/${ID1}/status`, { who: "maintainer", body: { status: "published" } });
    await t.call("POST", `/api/admin/walkthroughs/${ID2}/status`, { who: "maintainer", body: { status: "published" } });
    const res = await t.call("GET", "/api/walkthroughs/published", { who: "user" });
    expect(res.status).toBe(200);
    expect(Object.keys(res.body)).toEqual(["walkthroughs", "external"]);
    const guides = res.body.walkthroughs as { id: string; title: string }[];
    expect(guides.map((g) => g.title).sort()).toEqual(["One", "Two"]);
    expect(res.raw).not.toContain("Three");
    expect(res.raw).not.toContain("wt-0000000000a3");
    expect(((await t.call("GET", "/api/walkthroughs/published", { who: "maintainerB" })).body.walkthroughs as unknown[])).toEqual([]);
  });
  it("re-validates each stored definition: one that is no longer valid is left out, the others still load", async () => {
    const t = build({ newIds: [ID1] });
    await t.call("POST", "/api/admin/walkthroughs", { who: "maintainer", body: { applicationId: APP_A, definition: defOf() } });
    await t.call("POST", `/api/admin/walkthroughs/${ID1}/status`, { who: "maintainer", body: { status: "published" } });
    t.store.rows.push({ tenantId: TENANT_A, id: ID2, status: "published", definition: { id: ID2, title: "Broken", description: "x", start: "nope", steps: [] }, updatedAt: "x" });
    t.store.rows.push({ tenantId: TENANT_A, id: "wt-0000000000a3", status: "published", definition: { ...(t.store.rows[0]!.definition as object), id: "wt-0000000000a3", steps: [{ id: "s1", kind: "guide", target: "#evil", text: "x", wait: "click", next: "done" }, { id: "done", kind: "complete", text: "x" }], start: "s1" }, updatedAt: "x" });
    t.store.rows.push({ tenantId: TENANT_A, id: "wt-0000000000a4", status: "published", definition: { ...(t.store.rows[0]!.definition as object), id: "wt-ffffffffffff" }, updatedAt: "x" }); // id mismatch
    const res = await t.call("GET", "/api/walkthroughs/published", { who: "user" });
    expect((res.body.walkthroughs as { id: string }[]).map((g) => g.id)).toEqual([ID1]);
  });
  it("a published guide whose registry data drifted disappears from the list (it is not served unvalidated)", async () => {
    const t = build({ newIds: [ID1] });
    await t.call("POST", "/api/admin/walkthroughs", { who: "maintainer", body: { applicationId: APP_A, definition: defOf() } });
    await t.call("POST", `/api/admin/walkthroughs/${ID1}/status`, { who: "maintainer", body: { status: "published" } });
    const drifted: TrustedRegistryData = { ...TRUSTED_REGISTRY, elements: TRUSTED_REGISTRY.elements.filter((e) => e.id !== "profile.saveButton") };
    const second = build({ registryData: drifted });
    second.store.rows.push(...t.store.rows);
    expect((await second.call("GET", "/api/walkthroughs/published", { who: "user" })).body).toEqual({ walkthroughs: [], external: [] });
  });
});

describe("closed replies: the Gateway's answers and failures never leak", () => {
  const create = (t: ReturnType<typeof build>) => t.call("POST", "/api/admin/walkthroughs", { who: "maintainer", body: { applicationId: APP_A, definition: defOf() } });
  it.each([["UNAUTHORIZED"], ["DENIED"], ["FORBIDDEN_POLICY"], ["INVALID_PARAMETERS"], ["INVALID_ACTION"], ["REQUIRES_CONFIRMATION"]])("a Gateway outcome of %s is a 403 with the fixed refusal and no detail", async (outcome) => {
    const t = build({ feedback: () => ({ outcome, category: "not_available", issues: [{ path: "/definition", code: "format" }] }) });
    const res = await create(t);
    expect(res.status).toBe(403);
    expect(res.body).toEqual({ kind: "forbidden", message: AUTHORING_MESSAGES.refused });
    expectNoLeak(res.raw);
    expect(t.store.rows).toEqual([]);
  });
  it("ALLOWED + try_later (the executor refused or failed) is a 503 with a fixed message", async () => {
    const t = build({ feedback: () => ({ outcome: "ALLOWED", category: "try_later" }) });
    const res = await create(t);
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ kind: "unavailable", message: AUTHORING_MESSAGES.unavailable });
    expectNoLeak(res.raw);
  });
  it.each([[null], [undefined], ["ALLOWED"], [{}], [{ outcome: "ALLOWED" }], [{ outcome: "ALLOWED", category: "ok" }]])("a malformed or incomplete Gateway answer (%j) never yields a success", async (feedback) => {
    const t = build({ feedback: () => feedback });
    const res = await create(t);
    expect([403, 503]).toContain(res.status === 201 ? 0 : res.status);
    expect(res.status).not.toBe(201);
    expectNoLeak(res.raw);
  });
  it("a Gateway that throws is a 503 with no leak", async () => {
    const t = build({ feedback: () => { throw new Error(SECRET); } });
    const res = await create(t);
    expect(res.status).toBe(503);
    expectNoLeak(res.raw);
  });
  it("a store that throws (SQL text in the error) is a 503 on every route, with no leak", async () => {
    const t = build();
    t.store.failWith = new Error(SECRET);
    for (const [method, url, body] of [["GET", "/api/admin/walkthroughs"], ["GET", `/api/admin/walkthroughs/${ID1}`], ["GET", "/api/walkthroughs/published"], ["PUT", `/api/admin/walkthroughs/${ID1}`, { expectedRevision: 1, applicationId: APP_A, definition: defOf() }], ["POST", `/api/admin/walkthroughs/${ID1}/status`, { status: "published" }]] as const) {
      const res = await t.call(method, url, { who: "maintainer", ...(body === undefined ? {} : { body }) });
      expect(res.status, `${method} ${url}`).toBe(503);
      expect(res.body).toEqual({ kind: "unavailable", message: AUTHORING_MESSAGES.unavailable });
      expectNoLeak(res.raw);
    }
  });
  it("a write that the Gateway allowed but whose read-back finds nothing is a 503, never a made-up 201", async () => {
    const t = build({ feedback: () => ({ outcome: "ALLOWED", category: "ok" }) }); // says ok, stores nothing
    const res = await create(t);
    expect(res.status).toBe(503);
  });
  it("every error body has exactly the closed keys: kind and message (plus issues only on 422)", async () => {
    const t = build();
    const bodies = [
      (await t.call("GET", "/api/admin/walkthroughs")).body, (await t.call("GET", "/api/admin/walkthroughs", { who: "user" })).body,
      (await t.call("GET", `/api/admin/walkthroughs/${ID1}`, { who: "maintainer" })).body, (await t.call("POST", "/api/admin/walkthroughs", { who: "maintainer", body: {} })).body,
    ];
    for (const body of bodies) expect(Object.keys(body).sort()).toEqual(["kind", "message"]);
  });
  it("tenant and actor are never taken from the request: a tenant id or actor header changes nothing", async () => {
    const t = build({ newIds: [ID1] });
    const res = await t.call("POST", "/api/admin/walkthroughs", { who: "maintainer", body: { applicationId: APP_A, definition: defOf() }, headers: { "x-tenant-id": TENANT_B, "x-actor": "mallory", "x-user-id": "mallory", authorization: "Bearer x" } });
    expect(res.status).toBe(201);
    expect(t.store.rows.map((r) => r.tenantId)).toEqual([TENANT_A]);
    expect(t.submitted[0]!.who).toBe("maintainer");
  });
});

describe("product usage endpoints", () => {
  const eventPath = "/api/walkthrough-events";
  const summaryPath = "/api/admin/analytics";
  const body = { walkthroughId: "profileUpdate", runId: "aaaaaaaa-0000-4000-8000-000000000000", event: "started" };

  it("inherits transport guards and records valid sessions without submitting to the Gateway", async () => {
    const t = build();
    for (const [headers, expected] of [[{ host: "other.example" }, 403], [{ "sec-fetch-site": "cross-site" }, 403], [{ "content-type": "text/plain" }, 415]] as const) {
      expect((await t.call("POST", eventPath, { who: "user", headers, body })).status).toBe(expected);
    }
    expect((await t.call("POST", eventPath, { body })).status).toBe(401);
    const accepted = await t.call("POST", eventPath, { who: "user", body });
    expect(accepted).toMatchObject({ status: 204, raw: "", headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } });
    expect((await t.call("POST", eventPath, { who: "maintainer", body })).status).toBe(204);
    const mismatched = { ...body, walkthroughId: "findSecuritySettings", event: "completed" };
    expect((await t.call("POST", eventPath, { who: "user", body: mismatched })).status).toBe(204);
    for (const event of ["completed", "completed", "cancelled"]) {
      expect((await t.call("POST", eventPath, { who: "user", body: { ...body, event } })).status).toBe(204);
    }
    expect(t.store.events).toEqual([{ tenantId: TENANT_A, ...body }, { tenantId: TENANT_A, ...body, event: "completed" }]);
    expect(t.submitted).toEqual([]);
  });

  it("refuses draft, preview, unknown, other-tenant and invalid reports with identical copy", async () => {
    const t = build({ newIds: [ID1] });
    expect((await t.call("POST", "/api/admin/walkthroughs", { who: "maintainer", body: { applicationId: APP_A, definition: defOf() } })).status).toBe(201);
    const invalid = [
      { ...body, walkthroughId: ID1 }, { ...body, walkthroughId: ID2 }, { ...body, walkthroughId: "wt-preview" },
      { ...body, runId: "bad" }, { ...body, runId: body.runId.toUpperCase() }, { ...body, event: "failed" }, { ...body, forbidden: SECRET },
    ];
    for (const bad of invalid) {
      const response = await t.call("POST", eventPath, { who: "user", body: bad });
      expect(response).toMatchObject({ status: 400, body: { kind: "malformed", message: AUTHORING_MESSAGES.invalidEvent } });
      expectNoLeak(response.raw);
    }
    expect(t.store.events).toEqual([]);
    expect((await t.call("POST", `/api/admin/walkthroughs/${ID1}/status`, { who: "maintainer", body: { status: "published" } })).status).toBe(200);
    expect((await t.call("POST", eventPath, { who: "maintainerB", body: { ...body, walkthroughId: ID1 } })).status).toBe(400);
    expect((await t.call("POST", eventPath, { who: "user", body: { ...body, walkthroughId: ID1 } })).status).toBe(204);
  });

  it("protects analytics with the maintainer gate and returns only the closed usage report", async () => {
    const t = build();
    for (const [who, status] of [["none", 401], ["user", 403]] as const) {
      expect((await t.call("GET", summaryPath, { who })).status).toBe(status);
    }
    const sample = { started: 3, completed: 2, cancelled: 1, completionRate: 67 };
    const allowed = await t.call("GET", summaryPath, { who: "maintainer" });
    expect(allowed.status).toBe(200);
    expect(allowed.body).toEqual({ totals: sample, guides: [{ id: "profileUpdate", title: "Update your profile name", ...sample }] });
    expectNoLeak(allowed.raw);
    expect((await t.call("GET", summaryPath, { who: "maintainerB" })).body).toEqual({
      totals: { started: 0, completed: 0, cancelled: 0, completionRate: null }, guides: [],
    });
    t.store.failWith = new Error(SECRET);
    const error = await t.call("GET", summaryPath, { who: "maintainer" });
    expect(error.status).toBe(503);
    expectNoLeak(error.raw);
  });
});


// --- Studio V1A: the workflow <-> application binding through the routes -------------------------------------------------------------------------------
const FIXTURE_APP = "app-cccccccccccc";
const fixtureConfig = { name: "Second application", origin: "http://127.0.0.1:5185", allowedOrigins: ["http://127.0.0.1:5185"], environment: "test" as const, registryId: "fixture" };
const ordersDef = (over: Record<string, unknown> = {}) => ({
  title: "Export orders", description: "Export the orders list.", start: "n1",
  steps: [{ id: "n1", kind: "navigate", route: "orders", next: "s1" }, { id: "s1", kind: "guide", target: "orders.exportButton", text: "Press Export.", wait: "click", next: "done" }, { id: "done", kind: "complete", text: "Done." }],
  ...over,
});
const withSecond = () => {
  const t = build({ newIds: [ID1, ID2], extraRegistries: [FIXTURE_ENTRY] });
  void t.applications.save({ tenantId: TENANT_A, actor: "seed" }, FIXTURE_APP, fixtureConfig);
  return t;
};

describe("a draft belongs to one application", () => {
  it("POST needs { applicationId, definition } EXACTLY: a missing id, an extra key and a non-string id are 400 and nothing is submitted", async () => {
    const t = build();
    for (const body of [{ definition: defOf() }, { applicationId: APP_A }, { applicationId: 7, definition: defOf() }, { applicationId: APP_A, definition: defOf(), tenantId: TENANT_B }, { applicationId: APP_A, definition: defOf(), status: "published" }]) {
      const res = await t.call("POST", "/api/admin/walkthroughs", { who: "maintainer", body });
      expect(res.status, JSON.stringify(Object.keys(body))).toBe(400);
      expect(res.body).toEqual({ kind: "malformed", message: AUTHORING_MESSAGES.malformed });
    }
    expect(t.submitted).toEqual([]);
  });
  it("an unknown, malformed or OTHER TENANT's application is 404 APPLICATION_NOT_FOUND on create and update, with no Gateway call", async () => {
    const t = build({ newIds: [ID1] });
    for (const applicationId of ["app-ffffffffffff", "not-an-app", APP_B, "wt-0123456789ab", ""]) {
      const created = await t.call("POST", "/api/admin/walkthroughs", { who: "maintainer", body: { applicationId, definition: defOf() } });
      expect([applicationId, created.status, created.body]).toEqual([applicationId, 404, { kind: "not_found", message: AUTHORING_MESSAGES.applicationNotFound, code: "APPLICATION_NOT_FOUND" }]);
      expectNoLeak(created.raw);
    }
    await t.call("POST", "/api/admin/walkthroughs", { who: "maintainer", body: { applicationId: APP_A, definition: defOf() } });
    t.submitted.length = 0;
    expect((await t.call("PUT", `/api/admin/walkthroughs/${ID1}`, { who: "maintainer", body: { expectedRevision: 1, applicationId: APP_B, definition: defOf() } })).body).toMatchObject({ kind: "conflict", code: "APPLICATION_MISMATCH" });
    expect(t.submitted).toEqual([]);
  });
  it("a DISABLED application refuses create, update and publish with 409 APPLICATION_DISABLED, but unpublishing stays possible and published guides are still served", async () => {
    const t = build({ newIds: [ID1, ID2] });
    await t.call("POST", "/api/admin/walkthroughs", { who: "maintainer", body: { applicationId: APP_A, definition: defOf({ title: "One" }) } });
    await t.call("POST", "/api/admin/walkthroughs", { who: "maintainer", body: { applicationId: APP_A, definition: defOf({ title: "Two" }) } });
    expect((await t.call("POST", `/api/admin/walkthroughs/${ID1}/status`, { who: "maintainer", body: { status: "published" } })).status).toBe(200);
    await t.applications.setEnabled({ tenantId: TENANT_A, actor: "seed" }, APP_A, false);
    t.submitted.length = 0;
    const disabled = { kind: "conflict", message: AUTHORING_MESSAGES.applicationDisabled, code: "APPLICATION_DISABLED" };
    expect((await t.call("POST", "/api/admin/walkthroughs", { who: "maintainer", body: { applicationId: APP_A, definition: defOf() } })).body).toEqual(disabled);
    expect((await t.call("PUT", `/api/admin/walkthroughs/${ID2}`, { who: "maintainer", body: { expectedRevision: 1, applicationId: APP_A, definition: defOf({ title: "Edit" }) } })).body).toEqual(disabled);
    expect((await t.call("POST", `/api/admin/walkthroughs/${ID2}/status`, { who: "maintainer", body: { status: "published" } })).body).toEqual(disabled);
    expect(t.submitted).toEqual([]);
    // Published guides keep running, and unpublishing is always allowed.
    expect(((await t.call("GET", "/api/walkthroughs/published", { who: "user" })).body.walkthroughs as { id: string }[]).map((g) => g.id)).toEqual([ID1]);
    expect((await t.call("POST", `/api/admin/walkthroughs/${ID1}/status`, { who: "maintainer", body: { status: "draft" } })).status).toBe(200);
    // Re-enabling makes it usable again.
    await t.applications.setEnabled({ tenantId: TENANT_A, actor: "seed" }, APP_A, true);
    expect((await t.call("PUT", `/api/admin/walkthroughs/${ID2}`, { who: "maintainer", body: { expectedRevision: 1, applicationId: APP_A, definition: defOf({ title: "Edit" }) } })).status).toBe(200);
  });
  it("create validates against the APPLICATION's registry: a target of the second registry is valid for it and refused (422) for the reference application, and vice versa", async () => {
    const t = build({ newIds: ["wt-0000000000a8", "wt-0000000000a9", ID1, ID2], extraRegistries: [FIXTURE_ENTRY] }); // the two refused attempts still draw an id
    void t.applications.save({ tenantId: TENANT_A, actor: "seed" }, FIXTURE_APP, fixtureConfig);
    const wrong = await t.call("POST", "/api/admin/walkthroughs", { who: "maintainer", body: { applicationId: APP_A, definition: ordersDef() } });
    expect(wrong.status).toBe(422);
    expect(wrong.body).toMatchObject({ kind: "invalid" });
    const wrongBack = await t.call("POST", "/api/admin/walkthroughs", { who: "maintainer", body: { applicationId: FIXTURE_APP, definition: defOf() } });
    expect(wrongBack.status).toBe(422);
    expect(t.submitted).toEqual([]);
    const right = await t.call("POST", "/api/admin/walkthroughs", { who: "maintainer", body: { applicationId: FIXTURE_APP, definition: ordersDef() } });
    expect(right.status).toBe(201);
    expect(right.body).toMatchObject({ id: ID1, status: "draft", applicationId: FIXTURE_APP, definition: { id: ID1, title: "Export orders" } });
    const reference = await t.call("POST", "/api/admin/walkthroughs", { who: "maintainer", body: { applicationId: APP_A, definition: defOf() } });
    expect(reference.body).toMatchObject({ id: ID2, applicationId: APP_A });
  });
  it("the application is assigned ONCE: updating with another application is 409 APPLICATION_MISMATCH and changes nothing; the same application updates", async () => {
    const t = withSecond();
    await t.call("POST", "/api/admin/walkthroughs", { who: "maintainer", body: { applicationId: APP_A, definition: defOf({ title: "First" }) } });
    t.submitted.length = 0;
    const mismatch = await t.call("PUT", `/api/admin/walkthroughs/${ID1}`, { who: "maintainer", body: { expectedRevision: 1, applicationId: FIXTURE_APP, definition: defOf({ title: "Moved" }) } });
    expect(mismatch.status).toBe(409);
    expect(mismatch.body).toEqual({ kind: "conflict", message: AUTHORING_MESSAGES.applicationMismatch, code: "APPLICATION_MISMATCH" });
    expectNoLeak(mismatch.raw);
    expect(t.submitted).toEqual([]);
    expect(t.store.rows[0]).toMatchObject({ applicationId: APP_A, definition: { title: "First" } });
    const same = await t.call("PUT", `/api/admin/walkthroughs/${ID1}`, { who: "maintainer", body: { expectedRevision: 1, applicationId: APP_A, definition: defOf({ title: "Second" }) } });
    expect(same.status).toBe(200);
    expect(same.body).toMatchObject({ applicationId: APP_A, definition: { title: "Second" } });
  });
  it("a LEGACY draft (no application) is readable with applicationId null and takes the application named on its first save; afterwards it is bound", async () => {
    const t = withSecond();
    t.store.rows.push({ tenantId: TENANT_A, id: ID1, status: "draft", definition: { ...defOf(), id: ID1 }, updatedAt: "2026-01-01T00:00:00.000Z" });
    expect((await t.call("GET", `/api/admin/walkthroughs/${ID1}`, { who: "maintainer" })).body).toMatchObject({ id: ID1, applicationId: null });
    expect(((await t.call("GET", "/api/admin/walkthroughs", { who: "maintainer" })).body.authored as { applicationId: unknown }[])[0]?.applicationId).toBeNull();
    const assigned = await t.call("PUT", `/api/admin/walkthroughs/${ID1}`, { who: "maintainer", body: { expectedRevision: 1, applicationId: APP_A, definition: defOf({ title: "Assigned" }) } });
    expect(assigned.status).toBe(200);
    expect(assigned.body).toMatchObject({ applicationId: APP_A });
    expect((await t.call("PUT", `/api/admin/walkthroughs/${ID1}`, { who: "maintainer", body: { expectedRevision: 1, applicationId: FIXTURE_APP, definition: ordersDef() } })).body).toMatchObject({ code: "APPLICATION_MISMATCH" });
  });
  it("a LEGACY draft publishes against the reference registry with no application record to disable", async () => {
    const t = withSecond();
    t.store.rows.push({ tenantId: TENANT_A, id: ID1, status: "draft", definition: { ...defOf(), id: ID1 }, updatedAt: "2026-01-01T00:00:00.000Z" });
    await t.applications.setEnabled({ tenantId: TENANT_A, actor: "seed" }, APP_A, false); // unrelated to a legacy guide
    expect((await t.call("POST", `/api/admin/walkthroughs/${ID1}/status`, { who: "maintainer", body: { status: "published" } })).status).toBe(200);
    expect(((await t.call("GET", "/api/walkthroughs/published", { who: "user" })).body.walkthroughs as { id: string }[]).map((g) => g.id)).toEqual([ID1]);
  });
  it("publish re-validates the STORED definition against ITS application: a draft whose registry is the second one cannot publish against the reference registry's data and vice versa", async () => {
    const t = withSecond();
    await t.call("POST", "/api/admin/walkthroughs", { who: "maintainer", body: { applicationId: FIXTURE_APP, definition: ordersDef() } });
    expect((await t.call("POST", `/api/admin/walkthroughs/${ID1}/status`, { who: "maintainer", body: { status: "published" } })).status).toBe(200);
    // Plant a draft bound to the reference application that holds a target only the second registry knows: publishing it is a 422 and never reaches the Gateway.
    t.store.rows.push({ tenantId: TENANT_A, id: ID2, status: "draft", definition: { ...ordersDef(), id: ID2 }, updatedAt: "2026-01-01T00:00:00.000Z", applicationId: APP_A });
    t.submitted.length = 0;
    const stale = await t.call("POST", `/api/admin/walkthroughs/${ID2}/status`, { who: "maintainer", body: { status: "published" } });
    expect(stale.status).toBe(422);
    expect(t.submitted).toEqual([]);
  });
  it("the published list validates each guide against its own application's registry, treats a missing application as the reference one, and never returns a draft", async () => {
    const t = withSecond();
    const fixtureGuide = { ...ordersDef(), id: "wt-0000000000b1" };
    const referenceGuide = { ...defOf(), id: "wt-0000000000b2" };
    const legacyGuide = { ...defOf({ title: "Legacy" }), id: "wt-0000000000b3" };
    const crossed = { ...ordersDef({ title: "Crossed" }), id: "wt-0000000000b4" }; // the second registry's target under the reference application: dropped
    const orphan = { ...defOf({ title: "Orphan" }), id: "wt-0000000000b5" }; // an application that does not exist in this tenant: dropped
    const draft = { ...ordersDef({ title: "Draft" }), id: "wt-0000000000b6" };
    for (const [id, definition, applicationId, status] of [
      ["wt-0000000000b1", fixtureGuide, FIXTURE_APP, "published"], ["wt-0000000000b2", referenceGuide, APP_A, "published"], ["wt-0000000000b3", legacyGuide, undefined, "published"],
      ["wt-0000000000b4", crossed, APP_A, "published"], ["wt-0000000000b5", orphan, "app-eeeeeeeeeeee", "published"], ["wt-0000000000b6", draft, FIXTURE_APP, "draft"],
    ] as const) t.store.rows.push({ tenantId: TENANT_A, id, status, definition, updatedAt: "2026-01-01T00:00:00.000Z", ...(applicationId === undefined ? {} : { applicationId }) });
    const served = await t.call("GET", "/api/walkthroughs/published", { who: "user" });
    expect((served.body.walkthroughs as { id: string }[]).map((g) => g.id)).toEqual(["wt-0000000000b1", "wt-0000000000b2", "wt-0000000000b3"]);
  });
  it("a store that cannot find the application's registry in the catalog answers 503, not a silent pass", async () => {
    const t = build({ newIds: [ID1] });
    await t.applications.save({ tenantId: TENANT_A, actor: "seed" }, "app-dddddddddddd", { ...fixtureConfig, registryId: "gone" });
    const res = await t.call("POST", "/api/admin/walkthroughs", { who: "maintainer", body: { applicationId: "app-dddddddddddd", definition: defOf() } });
    expect(res.status).toBe(503);
    expectNoLeak(res.raw);
  });
});
