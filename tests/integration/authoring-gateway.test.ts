/**
 * T405 (Feature 004): the authoring capabilities through the REAL Policy Gateway and PostgreSQL (the pattern of tests/integration/c01-guidance-transport.test.ts):
 * a maintainer (perm.walkthrough.maintain) saves and publishes with the exact PROPOSED / ALLOWED / EXECUTED trail at risk MEDIUM; a session without the permission is
 * UNAUTHORIZED with zero executor runs and nothing stored; spoofed fields are refused by the strict schema; an invalid definition fails INSIDE the executor while the
 * policy decision stays ALLOWED (the two stay distinct in the trail); a registry-drifted stale draft cannot be published; a published guide cannot be saved over;
 * unpublish restores editability; built-in, preview and mismatched ids are refused; the definition never appears in the audit rows; default deny holds.
 * NEEDS the PostgreSQL of deploy/compose.yaml on a FRESH database; each test uses a tenant of its own.
 */
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { composeReferenceHost } from "../../apps/reference-host/src/index.js";
import type { AiSession, ReferenceHost } from "../../apps/reference-host/src/index.js";
import { createAuthoringExtension } from "../../apps/reference-host/src/authoring/capabilities.js";
import { generateWalkthroughId } from "../../apps/reference-host/src/authoring/ids.js";
import { createPostgresWalkthroughStore } from "../../apps/reference-host/src/authoring/postgres-store.js";
import { TRUSTED_REGISTRY } from "../../apps/reference-host/src/authoring/trusted-registry.js";
import type { TrustedRegistryData } from "../../apps/reference-host/src/authoring/trusted-registry.js";
import { createPostgresApplicationStore } from "../../apps/reference-host/src/studio/postgres-application-store.js";
import { createRegistryCatalog } from "../../apps/reference-host/src/studio/registries.js";
import { createPostgresPool } from "../../packages/security/src/index.js";
import { withTenant } from "../../packages/security/src/state/postgres/tenant-tx.js";
import { openStatePools } from "../../packages/security/src/state/conformance/state-pg-fixtures.js";

let owner: Pool; let probe: Pool;
const hosts: ReferenceHost[] = [];
const pools: { end(): Promise<void> }[] = [];
beforeAll(async () => { ({ app: probe, owner } = await openStatePools(Pool)); });
afterAll(async () => { await Promise.all([probe?.end(), owner?.end()]); });
afterEach(async () => { await Promise.all([...hosts.splice(0).map((host) => host.close()), ...pools.splice(0).map((pool) => pool.end())]); });

const SECRET_TITLE = "Distinctive-Title-9137";
const SECRET_TEXT = "Distinctive-Step-Text-4471";
const definitionFor = (id: string, over: Record<string, unknown> = {}) => ({
  id, title: SECRET_TITLE, description: "Change your display name and save it.", start: "n1",
  steps: [{ id: "n1", kind: "navigate", route: "profile", next: "s1" }, { id: "s1", kind: "guide", target: "profile.saveButton", text: SECRET_TEXT, wait: "click", verify: "profile.saved", next: "done" }, { id: "done", kind: "complete", text: "Done." }],
  ...over,
});

interface Options { readonly enabled?: string; readonly registryData?: TrustedRegistryData; readonly tenant?: string; readonly sharedStore?: ReturnType<typeof createPostgresWalkthroughStore> }
async function start(options: Options = {}) {
  const tenant = options.tenant ?? randomUUID();
  const suffix = tenant.slice(0, 8);
  const future = new Date(Date.now() + 3_600_000).toISOString();
  const token = { maya: `tok-${randomUUID()}`, ula: `tok-${randomUUID()}` };
  // maya is a maintainer; ula an ordinary user. The permission is declared in THIS test's sessions only.
  const sessions = [
    { token: token.maya, userId: "maya", tenantId: tenant, sessionId: `s-maya-${suffix}-${randomUUID().slice(0, 4)}`, validUntil: future, permissions: ["perm.walkthrough.maintain", "perm.demo.lookup"] },
    { token: token.ula, userId: "ula", tenantId: tenant, sessionId: `s-ula-${suffix}-${randomUUID().slice(0, 4)}`, validUntil: future, permissions: ["perm.demo.lookup"] },
  ];
  const pool = createPostgresPool(process.env.DAP_DATABASE_URL!, { max: 4 });
  pools.push(pool);
  const store = options.sharedStore ?? createPostgresWalkthroughStore(pool);
  // Studio V1A: every draft belongs to an enrolled application. One per tenant, with a stable id so a second host of the same tenant sees the same application.
  const applications = createPostgresApplicationStore(pool);
  const appId = `app-${tenant.replace(/-/g, "").slice(0, 12)}`;
  await applications.save({ tenantId: tenant, actor: "seed" }, appId, { name: "Reference application", origin: "http://localhost:5184", allowedOrigins: ["http://localhost:5184"], environment: "development", registryId: "reference" });
  const authoring = createAuthoringExtension({ store, applications, catalog: createRegistryCatalog(), ...(options.registryData === undefined ? {} : { registryData: options.registryData }) });
  const { host } = await composeReferenceHost(
    { NODE_ENV: "test", DAP_ALLOW_DEV_AUTH: "1", DAP_DATABASE_URL: process.env.DAP_DATABASE_URL, DAP_ENABLED_ACTIONS: options.enabled ?? "demoLookup,saveWalkthroughDraft,setWalkthroughStatus", DEV_SESSIONS: JSON.stringify(sessions) },
    { extensions: [authoring.extension] },
  );
  hosts.push(host);
  /** A FRESH Gateway session per call: each write is its own turn (as the dev server does), so per-turn limits cannot interfere. */
  const open = async (who: "maya" | "ula"): Promise<AiSession> => { const session = await host.openSession(token[who]); if (session === null) throw new Error("session refused"); return session; };
  const submit = async (who: "maya" | "ula", action: string, params: unknown) => (await open(who)).submit({ providerCallId: `call-${randomUUID()}`, arguments: JSON.stringify({ action, params }) });
  const save = (who: "maya" | "ula", walkthroughId: string, definition: unknown, applicationId: string = appId, expectedRevision = 0) => submit(who, "saveWalkthroughDraft", { expectedRevision, walkthroughId, applicationId, definition });
  const setStatus = (who: "maya" | "ula", walkthroughId: string, status: string) => submit(who, "setWalkthroughStatus", { walkthroughId, status });
  const rows = async () => (await withTenant(owner, tenant, (client) => client.query("SELECT event_type, action_id, outcome, reason, risk, params_view, execution_result, resource_type, resource_id, user_id FROM public.sec_audit_events ORDER BY seq"))).rows as Record<string, unknown>[];
  const stored = async (id: string) => (await store.get(tenant, id));
  return { tenant, store, applications, appId, trusted: authoring.trusted, host, open, save, setStatus, submit, rows, stored, scope: (actor = "maya") => ({ tenantId: tenant, actor }) };
}

describe("a maintainer saves and publishes through the real Gateway", () => {
  it("saveWalkthroughDraft: ALLOWED, the exact PROPOSED/ALLOWED/EXECUTED trail at risk MEDIUM, a walkthrough resource, and the executor got exactly the validated parameters", async () => {
    const t = await start();
    const id = generateWalkthroughId();
    expect(await t.save("maya", id, definitionFor(id))).toEqual({ outcome: "ALLOWED", category: "ok" });
    expect(t.trusted.executorCalls()).toBe(1);
    expect(t.trusted.executorCalls("saveWalkthroughDraft")).toBe(1);
    expect(t.trusted.receivedCalls("saveWalkthroughDraft")).toEqual([{ walkthroughId: id, applicationId: t.appId, definition: definitionFor(id), expectedRevision: 0 }]);
    expect(await t.stored(id)).toMatchObject({ id, status: "draft", definition: definitionFor(id) });
    const trail = await t.rows();
    expect(trail.map((row) => row.event_type)).toEqual(["AI_ACTION_PROPOSED", "AI_ACTION_ALLOWED", "AI_ACTION_EXECUTED"]);
    expect(trail.map((row) => row.action_id)).toEqual(Array(3).fill("saveWalkthroughDraft"));
    expect(trail[1]).toMatchObject({ outcome: "ALLOWED", reason: "allowed", risk: "MEDIUM", user_id: "maya", resource_type: "walkthrough", resource_id: id });
    expect(trail[2]).toMatchObject({ execution_result: "success", resource_type: "walkthrough", resource_id: id });
  });
  it("the audit rows hold the walkthrough id and NEVER the definition: no title, step text, registry data or definition JSON anywhere", async () => {
    const t = await start();
    const id = generateWalkthroughId();
    await t.save("maya", id, definitionFor(id));
    await t.setStatus("maya", id, "published");
    const trail = await t.rows();
    expect(trail.find((row) => row.event_type === "AI_ACTION_ALLOWED" && row.action_id === "saveWalkthroughDraft")!.params_view).toEqual({ "/walkthroughId": id });
    const text = JSON.stringify(trail);
    for (const word of [SECRET_TITLE, SECRET_TEXT, "profile.saveButton", "profile.saved", "navigate", "steps", "definition", "Change your display name"]) expect(text, word).not.toContain(word);
  });
  it("setWalkthroughStatus publishes a valid draft (status published, audited with the closed /status value) and the guide appears in the published list", async () => {
    const t = await start();
    const id = generateWalkthroughId();
    await t.save("maya", id, definitionFor(id));
    expect(await t.setStatus("maya", id, "published")).toEqual({ outcome: "ALLOWED", category: "ok" });
    expect(await t.stored(id)).toMatchObject({ status: "published" });
    expect((await t.store.listPublished(t.tenant)).map((g) => g.id)).toEqual([id]);
    const allowed = (await t.rows()).filter((row) => row.event_type === "AI_ACTION_ALLOWED" && row.action_id === "setWalkthroughStatus");
    expect(allowed).toHaveLength(1);
    expect(allowed[0]).toMatchObject({ risk: "MEDIUM", params_view: { "/walkthroughId": id, "/status": "published" } });
  });
  it("a draft can be saved again (update in place), keeping its id", async () => {
    const t = await start();
    const id = generateWalkthroughId();
    await t.save("maya", id, definitionFor(id));
    expect(await t.save("maya", id, definitionFor(id, { title: "Second title" }), t.appId, 1)).toEqual({ outcome: "ALLOWED", category: "ok" });
    expect((await t.stored(id))?.definition).toMatchObject({ title: "Second title" });
    expect(await t.store.list(t.tenant)).toHaveLength(1);
  });
});

describe("a session WITHOUT perm.walkthrough.maintain", () => {
  it("is UNAUTHORIZED on both capabilities: an UNAUTHORIZED trail, zero executor runs, nothing stored", async () => {
    const t = await start();
    const id = generateWalkthroughId();
    expect(await t.save("ula", id, definitionFor(id))).toEqual({ outcome: "UNAUTHORIZED", category: "not_available" });
    expect(await t.setStatus("ula", id, "published")).toEqual({ outcome: "UNAUTHORIZED", category: "not_available" });
    expect(t.trusted.executorCalls()).toBe(0);
    expect(await t.store.list(t.tenant)).toEqual([]);
    const trail = await t.rows();
    expect(trail.map((row) => row.event_type)).toEqual(["AI_ACTION_PROPOSED", "AI_ACTION_DENIED", "AI_ACTION_PROPOSED", "AI_ACTION_DENIED"]);
    expect(trail.filter((row) => row.event_type === "AI_ACTION_DENIED").map((row) => [row.user_id, row.outcome, row.reason])).toEqual([["ula", "UNAUTHORIZED", "permission_missing"], ["ula", "UNAUTHORIZED", "permission_missing"]]);
  });
  it("cannot publish or unpublish a maintainer's guide, and the guide is untouched", async () => {
    const t = await start();
    const id = generateWalkthroughId();
    await t.save("maya", id, definitionFor(id));
    await t.setStatus("maya", id, "published");
    expect((await t.setStatus("ula", id, "draft")).outcome).toBe("UNAUTHORIZED");
    expect(await t.stored(id)).toMatchObject({ status: "published" });
  });
});

describe("spoofed fields are refused by the strict schema and have no effect", () => {
  it.each([[["permissions", "tenantId", "actorId", "userId"]], [["sessionId", "role", "isAdmin", "confirmed"]]])("top-level %j -> INVALID_PARAMETERS, executor not run, nothing stored", async (keys) => {
    const t = await start();
    const id = generateWalkthroughId();
    for (const key of keys) {
      const value = key === "permissions" ? ["perm.walkthrough.maintain"] : key === "tenantId" ? randomUUID() : key === "isAdmin" || key === "confirmed" ? true : "x";
      expect((await t.submit("maya", "saveWalkthroughDraft", { expectedRevision: 0, walkthroughId: id, applicationId: t.appId, definition: definitionFor(id), [key]: value })).outcome, key).toBe("INVALID_PARAMETERS");
    }
    expect(t.trusted.executorCalls()).toBe(0);
    expect(await t.store.list(t.tenant)).toEqual([]);
  });
  it("a spoofed tenant or actor INSIDE the definition, a spoofed field on a step, and an unknown field on the status capability are refused too", async () => {
    const t = await start();
    const id = generateWalkthroughId();
    const other = randomUUID();
    expect((await t.save("maya", id, definitionFor(id, { tenantId: other }))).outcome).toBe("INVALID_PARAMETERS");
    expect((await t.save("maya", id, definitionFor(id, { createdBy: "mallory" }))).outcome).toBe("INVALID_PARAMETERS");
    expect((await t.save("maya", id, definitionFor(id, { steps: [{ id: "done", kind: "complete", text: "x", permissions: [] }] }))).outcome).toBe("INVALID_PARAMETERS");
    expect((await t.submit("maya", "setWalkthroughStatus", { walkthroughId: id, status: "published", tenantId: other })).outcome).toBe("INVALID_PARAMETERS");
    expect(t.trusted.executorCalls()).toBe(0);
  });
  it("a tenant id smuggled next to a VALID save changes nothing: the row is owned by the session's trusted tenant and actor", async () => {
    const t = await start();
    const id = generateWalkthroughId();
    const other = randomUUID();
    expect((await t.submit("maya", "saveWalkthroughDraft", { expectedRevision: 0, walkthroughId: id, applicationId: t.appId, definition: definitionFor(id) })).outcome).toBe("ALLOWED");
    expect(await t.store.get(other, id)).toBeNull();
    const row = (await withTenant(owner, t.tenant, (client) => client.query("SELECT created_by, updated_by FROM public.walkthrough_definitions"))).rows;
    expect(row).toEqual([{ created_by: "maya", updated_by: "maya" }]);
  });
  it("an envelope with an identity next to the action (userId, tenantId, permissions) is refused by the Gateway before any executor", async () => {
    const t = await start();
    const id = generateWalkthroughId();
    const session = await t.open("maya");
    const feedback = await session.submit({ providerCallId: `call-${randomUUID()}`, arguments: JSON.stringify({ action: "saveWalkthroughDraft", params: { expectedRevision: 0, walkthroughId: id, applicationId: t.appId, definition: definitionFor(id) }, userId: "bob", tenantId: randomUUID(), permissions: ["perm.walkthrough.maintain"] }) });
    expect(feedback).toEqual({ outcome: "INVALID_ACTION", category: "not_available" });
    expect(t.trusted.executorCalls()).toBe(0);
    expect(await t.store.list(t.tenant)).toEqual([]);
  });
});

describe("validation: the policy decision and the execution result stay distinct", () => {
  it("an INVALID definition (well-formed parameters, unknown target) is ALLOWED by policy and FAILS in the executor: ALLOWED + try_later, the trail says allowed then executed/failure, nothing stored", async () => {
    const t = await start();
    const id = generateWalkthroughId();
    const bad = definitionFor(id, { steps: [{ id: "n1", kind: "navigate", route: "profile", next: "s1" }, { id: "s1", kind: "guide", target: "#save", text: "x", wait: "click", next: "done" }, { id: "done", kind: "complete", text: "Done." }] });
    expect(await t.save("maya", id, bad)).toEqual({ outcome: "ALLOWED", category: "try_later" });
    expect(await t.store.list(t.tenant)).toEqual([]);
    const trail = await t.rows();
    expect(trail.map((row) => row.event_type)).toEqual(["AI_ACTION_PROPOSED", "AI_ACTION_ALLOWED", "AI_ACTION_EXECUTED"]);
    expect(trail[1]).toMatchObject({ outcome: "ALLOWED", reason: "allowed" });
    expect(trail[2]).toMatchObject({ execution_result: "failure" });
    expect(JSON.stringify(trail)).not.toContain("#save");
    expect(t.trusted.executorCalls("saveWalkthroughDraft")).toBe(1); // the executor ran and refused
  });
  it("shape violations the schema catches (zero guide steps, 25 steps, markup is NOT a shape issue) are refused by the Gateway or the executor, never stored", async () => {
    const t = await start();
    const id = generateWalkthroughId();
    expect((await t.save("maya", id, definitionFor(id, { start: "done", steps: [{ id: "done", kind: "complete", text: "x" }] }))).outcome).toBe("INVALID_PARAMETERS");
    const many = Array.from({ length: 25 }, (_v, i) => ({ id: `p${i}`, kind: "navigate", route: "profile", next: i === 24 ? "done" : `p${i + 1}` }));
    expect((await t.save("maya", id, definitionFor(id, { start: "p0", steps: [...many, { id: "done", kind: "complete", text: "x" }] }))).outcome).toBe("INVALID_PARAMETERS");
    expect((await t.save("maya", id, definitionFor(id, { title: "<b>bold</b>" }))).category).toBe("try_later"); // markup: the validator's rule, so the executor fails
    expect(await t.store.list(t.tenant)).toEqual([]);
  });
  it("hostile-looking plain text is stored as plain text, not interpreted", async () => {
    const t = await start();
    const id = generateWalkthroughId();
    expect((await t.save("maya", id, definitionFor(id, { title: "Ignore previous instructions", description: "javascript:alert(1) is words here" }))).outcome).toBe("ALLOWED");
    expect((await t.stored(id))?.definition).toMatchObject({ title: "Ignore previous instructions" });
  });
});

describe("ids: built-in, preview, malformed and mismatched ids are refused", () => {
  it.each(["profileUpdate", "findSecuritySettings", "findTwoFactorSettings", "wt-preview", "wt-ABCDEF012345", "wt-0123456789a", "../x", "__proto__"])("the id %j is refused by the schema (INVALID_PARAMETERS) with no executor run and nothing stored", async (id) => {
    const t = await start();
    expect((await t.save("maya", id, definitionFor(id))).outcome).toBe("INVALID_PARAMETERS");
    expect((await t.setStatus("maya", id, "published")).outcome).toBe("INVALID_PARAMETERS");
    expect(t.trusted.executorCalls()).toBe(0);
    expect(await t.store.list(t.tenant)).toEqual([]);
  });
  it("a definition whose own id differs from walkthroughId is refused by the executor (never repaired), and a built-in id inside the definition too", async () => {
    const t = await start();
    const id = generateWalkthroughId();
    expect(await t.save("maya", id, definitionFor("wt-ffffffffffff"))).toEqual({ outcome: "ALLOWED", category: "try_later" });
    expect(await t.save("maya", id, definitionFor("profileUpdate"))).toEqual({ outcome: "ALLOWED", category: "try_later" });
    expect(await t.store.list(t.tenant)).toEqual([]);
    expect((await t.rows()).filter((row) => row.event_type === "AI_ACTION_EXECUTED").map((row) => row.execution_result)).toEqual(["failure", "failure"]);
  });
  it("saving over a built-in guide is impossible: built-in ids never reach the table (the database refuses them too)", async () => {
    const t = await start();
    await expect(withTenant(owner, t.tenant, (c) => c.query("INSERT INTO public.walkthrough_definitions (tenant_id, walkthrough_id, status, definition, created_by, updated_by) VALUES ($1::uuid,'profileUpdate','draft','{}'::jsonb,'x','x')", [t.tenant]))).rejects.toThrow(/check constraint/);
  });
});

describe("draft and publish rules enforced by the executor", () => {
  it("a published guide cannot be saved over (ALLOWED + try_later; the stored definition is unchanged), and unpublishing makes it editable again", async () => {
    const t = await start();
    const id = generateWalkthroughId();
    await t.save("maya", id, definitionFor(id, { title: "Original" }));
    await t.setStatus("maya", id, "published");
    expect(await t.save("maya", id, definitionFor(id, { title: "Overwrite attempt" }))).toEqual({ outcome: "ALLOWED", category: "try_later" });
    expect(await t.stored(id)).toMatchObject({ status: "published", definition: { title: "Original" } });
    expect(await t.setStatus("maya", id, "draft")).toEqual({ outcome: "ALLOWED", category: "ok" });
    expect(await t.save("maya", id, definitionFor(id, { title: "Edited" }), t.appId, 3)).toEqual({ outcome: "ALLOWED", category: "ok" });
    expect(await t.stored(id)).toMatchObject({ status: "draft", definition: { title: "Edited" } });
  });
  it("publishing an unknown id fails closed (not_found: ALLOWED + try_later) and creates nothing", async () => {
    const t = await start();
    expect(await t.setStatus("maya", generateWalkthroughId(), "published")).toEqual({ outcome: "ALLOWED", category: "try_later" });
    expect(await t.store.list(t.tenant)).toEqual([]);
  });
  it("a registry-DRIFTED stale draft cannot be published: the stored definition is re-validated against the CURRENT registry data", async () => {
    const tenant = randomUUID();
    const first = await start({ tenant });
    const id = generateWalkthroughId();
    expect(await first.save("maya", id, definitionFor(id))).toEqual({ outcome: "ALLOWED", category: "ok" }); // valid today
    // The registry changes: the save button no longer exists (injected through the REAL validator).
    const drifted: TrustedRegistryData = { ...TRUSTED_REGISTRY, elements: TRUSTED_REGISTRY.elements.filter((e) => e.id !== "profile.saveButton") };
    const second = await start({ tenant, registryData: drifted });
    expect(await second.setStatus("maya", id, "published")).toEqual({ outcome: "ALLOWED", category: "try_later" });
    expect(await second.stored(id)).toMatchObject({ status: "draft" });
    expect((await second.store.listPublished(tenant))).toEqual([]);
    // and a postcondition renamed, or an operation removed, is caught the same way
    const noClick: TrustedRegistryData = { ...TRUSTED_REGISTRY, elements: TRUSTED_REGISTRY.elements.map((e) => (e.id === "profile.saveButton" ? { ...e, operations: ["highlight"] as const } : e)) };
    const third = await start({ tenant, registryData: noClick });
    expect((await third.setStatus("maya", id, "published")).category).toBe("try_later");
    expect(await third.stored(id)).toMatchObject({ status: "draft" });
    // the unchanged registry still publishes it
    expect(await first.setStatus("maya", id, "published")).toEqual({ outcome: "ALLOWED", category: "ok" });
  });
  it("a draft stored while valid but invalid under a drifted registry can still be UNPUBLISHED-edited: drift blocks only publishing", async () => {
    const tenant = randomUUID();
    const first = await start({ tenant });
    const id = generateWalkthroughId();
    await first.save("maya", id, definitionFor(id));
    await first.setStatus("maya", id, "published");
    const drifted: TrustedRegistryData = { ...TRUSTED_REGISTRY, postconditionNames: ["profile.saved2", "route.profile", "route.settings", "settings.advancedOpen"] };
    const second = await start({ tenant, registryData: drifted });
    expect(await second.setStatus("maya", id, "draft")).toEqual({ outcome: "ALLOWED", category: "ok" }); // unpublishing never needs validity
    expect((await second.setStatus("maya", id, "published")).category).toBe("try_later");
  });
  it("tenants are separate: another tenant's maintainer cannot publish a guide of this tenant (not_found) and its own guides do not appear here", async () => {
    const a = await start();
    const b = await start();
    const id = generateWalkthroughId();
    await a.save("maya", id, definitionFor(id));
    expect(await b.setStatus("maya", id, "published")).toEqual({ outcome: "ALLOWED", category: "try_later" });
    expect(await a.stored(id)).toMatchObject({ status: "draft" });
    expect(await b.store.list(b.tenant)).toEqual([]);
    expect(await b.stored(id)).toBeNull();
  });
});

describe("default deny and the document of limits", () => {
  it("the capabilities are OFF unless DAP_ENABLED_ACTIONS lists them, even for a maintainer", async () => {
    const t = await start({ enabled: "demoLookup" });
    const id = generateWalkthroughId();
    expect((await t.save("maya", id, definitionFor(id))).outcome).not.toBe("ALLOWED");
    expect((await t.setStatus("maya", id, "published")).outcome).not.toBe("ALLOWED");
    expect(t.trusted.executorCalls()).toBe(0);
    expect(await t.store.list(t.tenant)).toEqual([]);
  });
  it("one enabled and one not: only the enabled one runs", async () => {
    const t = await start({ enabled: "demoLookup,saveWalkthroughDraft" });
    const id = generateWalkthroughId();
    expect((await t.save("maya", id, definitionFor(id))).outcome).toBe("ALLOWED");
    expect((await t.setStatus("maya", id, "published")).outcome).not.toBe("ALLOWED");
    expect(await t.stored(id)).toMatchObject({ status: "draft" });
  });
  it("the same proposal replayed (same call id in the same turn) is refused and the executor runs once", async () => {
    const t = await start();
    const id = generateWalkthroughId();
    const session = await t.open("maya");
    const call = { providerCallId: `call-${randomUUID()}`, arguments: JSON.stringify({ action: "saveWalkthroughDraft", params: { expectedRevision: 0, walkthroughId: id, applicationId: t.appId, definition: definitionFor(id) } }) };
    expect((await session.submit(call)).outcome).toBe("ALLOWED");
    expect((await session.submit(call)).outcome).toBe("DENIED");
    expect(t.trusted.executorCalls()).toBe(1);
  });
  it("a maximum-size VALID definition (24 steps, 240-character texts, the longest real field values) fits the Gateway's 16 KiB payload limit, so authoring needs no DAP_GATEWAY_CONFIG change for size", async () => {
    const t = await start();
    const id = generateWalkthroughId();
    const many = [
      ...Array.from({ length: 8 }, (_v, i) => ({ id: `g${i}`, kind: "guide", target: "settings.advancedToggle", text: "x".repeat(240), wait: "click", verify: "settings.advancedOpen", next: i === 7 ? "p0" : `g${i + 1}`, targetWaitMs: 10_000, maxAttempts: 10 })),
      ...Array.from({ length: 15 }, (_v, i) => ({ id: `p${i}`, kind: "navigate", route: "settings", text: "y".repeat(240), next: i === 14 ? "done" : `p${i + 1}`, maxAttempts: 10 })),
      { id: "done", kind: "complete", text: "z".repeat(240) },
    ];
    const definition = definitionFor(id, { title: "t".repeat(80), description: "d".repeat(240), start: "g0", steps: many });
    const payload = Buffer.byteLength(JSON.stringify({ action: "saveWalkthroughDraft", params: { expectedRevision: 0, walkthroughId: id, applicationId: t.appId, definition } }));
    expect(payload).toBeLessThan(16 * 1024);
    expect(many).toHaveLength(24);
    expect(await t.save("maya", id, definition)).toEqual({ outcome: "ALLOWED", category: "ok" });
  });
});
