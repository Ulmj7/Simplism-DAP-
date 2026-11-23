/**
 * Studio V1B, D14 — atomicity of "the application is enabled" and the write (PostgreSQL, REAL concurrent connections).
 *
 * THE RACE (V1A logic). The save and publish executors read the application (`enabled`) in one transaction and wrote in another. A disable that committed between the two could not stop the write: a
 * disabled application then got a new draft or a publication. (Proved below by interleaving a committed disable between the executor's read and its write.)
 * THE FIX. The write transaction itself locks the application row FOR SHARE and re-reads `enabled` (`application-lock.ts`), in the walkthrough store (save, publish) and in the target store (register,
 * status). A concurrent disable is an UPDATE of that row and must wait for the writer to commit; a write that starts after the disable committed reads `enabled = false`. The lock tests hold the
 * writer INSIDE its transaction right after the lock statement and show, from a second connection, that the disable cannot complete until the writer commits.
 * NEEDS the PostgreSQL of deploy/compose.yaml on a FRESH database.
 */
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import type { ReferenceHost } from "../../apps/reference-host/src/index.js";
import { createPostgresWalkthroughStore } from "../../apps/reference-host/src/authoring/postgres-store.js";
import { createPostgresApplicationStore } from "../../apps/reference-host/src/studio/postgres-application-store.js";
import { createPostgresTargetStore } from "../../apps/reference-host/src/studio/postgres-target-store.js";
import { createPostgresPool } from "../../packages/security/src/index.js";
import { openStatePools } from "../../packages/security/src/state/conformance/state-pg-fixtures.js";
import { referenceConfig, startHost } from "./studio-registry.support.js";

let owner: Pool; let probe: Pool;
const closers: (() => Promise<unknown>)[] = [];
const hosts: ReferenceHost[] = [];
beforeAll(async () => { ({ app: probe, owner } = await openStatePools(Pool)); });
afterAll(async () => { await Promise.all([probe?.end(), owner?.end()]); });
afterEach(async () => { await Promise.all([...closers.splice(0).map((close) => close()), ...hosts.splice(0).map((host) => host.close())]); });
const start = (options: Parameters<typeof startHost>[3] = {}) => startHost(closers, hosts, owner, options);
const REJECTED = { outcome: "ALLOWED", category: "try_later" };
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const profileDef = () => ({
  title: "Save your name", description: "Change your display name and save it.", start: "n1",
  steps: [{ id: "n1", kind: "navigate", route: "profile", next: "s1" }, { id: "s1", kind: "guide", target: "profile.saveButton", text: "Press Save.", wait: "click", verify: "profile.saved", next: "done" }, { id: "done", kind: "complete", text: "Done." }],
});

type RealApplications = ReturnType<typeof createPostgresApplicationStore>;
/** An application store whose first `get` pauses AFTER it read the (enabled) record, and runs `between` before answering: the window between the executor's read and its write. */
function interleave(between: () => Promise<void>, onlyOnce = true) {
  let fired = false;
  return (real: RealApplications): RealApplications => Object.freeze({ ...real, get: async (tenantId: string, id: string) => {
    const record = await real.get(tenantId, id);
    if (record !== null && (!onlyOnce || !fired)) { fired = true; await between(); }
    return record;
  } });
}

describe("the V1A race, interleaved deterministically: a disable that commits between the executor's read and its write", () => {
  it("cannot let a SAVE through: the write transaction reads enabled = false and refuses (try_later); nothing is stored", async () => {
    let disable: () => Promise<void> = async () => {};
    const t = await start({ wrapApplications: interleave(() => disable()) });
    const appId = await t.createApplication(referenceConfig());
    disable = async () => { await t.applications.setEnabled({ tenantId: t.tenant, actor: "racer" }, appId, false); };
    const id = `wt-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    expect(await t.submit("saveWalkthroughDraft", { expectedRevision: 0, walkthroughId: id, applicationId: appId, definition: { ...profileDef(), id } })).toEqual(REJECTED);
    expect((await t.applications.get(t.tenant, appId))?.enabled).toBe(false); // the disable did commit in the window
    expect(await t.realStore.get(t.tenant, id)).toBeNull();
  });
  it("cannot let a PUBLISH through: the draft stays a draft", async () => {
    let disable: () => Promise<void> = async () => {};
    let armed = false;
    const t = await start({ wrapApplications: (real) => Object.freeze({ ...real, get: async (tenantId: string, id: string) => { const record = await real.get(tenantId, id); if (armed && record !== null) { armed = false; await disable(); } return record; } }) });
    const appId = await t.createApplication(referenceConfig());
    const draft = await t.createWorkflow(appId, profileDef());
    disable = async () => { await t.applications.setEnabled({ tenantId: t.tenant, actor: "racer" }, appId, false); };
    armed = true;
    expect(await t.submit("setWalkthroughStatus", { walkthroughId: draft.id, status: "published" })).toEqual(REJECTED);
    expect((await t.applications.get(t.tenant, appId))?.enabled).toBe(false);
    expect((await t.realStore.get(t.tenant, draft.id))?.status).toBe("draft");
  });
  it("controls: the same save and publish succeed when nothing is disabled in the window", async () => {
    const t = await start({ wrapApplications: interleave(async () => {}) });
    const appId = await t.createApplication(referenceConfig());
    const draft = await t.createWorkflow(appId, profileDef());
    expect(draft.res.status).toBe(201);
    expect(await t.submit("setWalkthroughStatus", { walkthroughId: draft.id, status: "published" })).toEqual({ outcome: "ALLOWED", category: "ok" });
  });
});

/** A pool whose connections pause, once, right AFTER the statement that locks the application row has run inside the transaction. */
function pausingPool(real: ReturnType<typeof createPostgresPool>, onLocked: () => Promise<void>) {
  let paused = false;
  return {
    connect: async () => {
      const client = await real.connect();
      return {
        query: async (sql: string, params?: unknown[]) => {
          const result = await client.query(sql, params as never);
          if (!paused && /FROM public\.studio_applications/.test(sql)) { paused = true; await onLocked(); }
          return result;
        },
        release: (discard?: boolean) => client.release(discard),
      };
    },
    end: () => real.end(),
  } as never;
}

/** Runs `writer` with its transaction paused right after the application lock; from another connection starts a disable and shows it WAITS, then releases the writer. */
async function lockedWriter<T>(fixture: { tenant: string; appId: string; applications: RealApplications; makeWriter: (pool: never) => () => Promise<T> }) {
  let release: () => void = () => {};
  const gate = new Promise<void>((resolve) => { release = resolve; });
  let reached: () => void = () => {};
  const atLock = new Promise<void>((resolve) => { reached = resolve; });
  const real = createPostgresPool(process.env.DAP_DATABASE_URL!, { max: 4 });
  closers.push(() => real.end());
  const writer = fixture.makeWriter(pausingPool(real, async () => { reached(); await gate; }));
  const running = writer();
  await atLock;
  let disabled = false;
  const disabling = fixture.applications.setEnabled({ tenantId: fixture.tenant, actor: "racer" }, fixture.appId, false).then((outcome) => { disabled = true; return outcome; });
  await sleep(400);
  const disableWaitedWhileWriterHeldTheLock = !disabled;
  release();
  const written = await running;
  await disabling;
  return { disableWaitedWhileWriterHeldTheLock, written, enabledAfter: (await fixture.applications.get(fixture.tenant, fixture.appId))?.enabled };
}

describe("the lock itself: a concurrent disable waits for the writer's transaction (real two-connection test)", () => {
  it("SAVE: the disable cannot complete while the save transaction holds the application lock; the save commits, then the disable lands", async () => {
    const t = await start();
    const appId = await t.createApplication(referenceConfig());
    const id = `wt-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    const outcome = await lockedWriter({ tenant: t.tenant, appId, applications: t.applications, makeWriter: (pool) => () =>
      createPostgresWalkthroughStore(pool).saveDraft({ tenantId: t.tenant, actor: "maya" }, id, { ...profileDef(), id } as never, appId) });
    expect(outcome.disableWaitedWhileWriterHeldTheLock).toBe(true);
    expect(outcome.written).toBe("created");
    expect(outcome.enabledAfter).toBe(false);
    expect((await t.realStore.get(t.tenant, id))?.status).toBe("draft");
  });
  it("PUBLISH: the disable waits for the publishing transaction", async () => {
    const t = await start();
    const appId = await t.createApplication(referenceConfig());
    const draft = await t.createWorkflow(appId, profileDef());
    const outcome = await lockedWriter({ tenant: t.tenant, appId, applications: t.applications, makeWriter: (pool) => () =>
      createPostgresWalkthroughStore(pool).setStatus({ tenantId: t.tenant, actor: "maya" }, draft.id, "published", () => true) });
    expect(outcome.disableWaitedWhileWriterHeldTheLock).toBe(true);
    expect(outcome.written).toBe("changed");
    expect(outcome.enabledAfter).toBe(false);
  });
  it("REGISTER: the disable waits for the registering transaction", async () => {
    const t = await start();
    const appId = await t.createApplication();
    const outcome = await lockedWriter({ tenant: t.tenant, appId, applications: t.applications, makeWriter: (pool) => () =>
      createPostgresTargetStore(pool).register({ tenantId: t.tenant, actor: "maya" }, appId, { targetId: "orders.submit", route: "orders", page: "/#/orders", role: "button", label: "Submit", description: "Submits", operations: ["highlight", "click"], privacy: "public" }) });
    expect(outcome.disableWaitedWhileWriterHeldTheLock).toBe(true);
    expect(outcome.written).toMatchObject({ kind: "created" });
    expect(outcome.enabledAfter).toBe(false);
    expect((await t.targets.get(t.tenant, appId, "orders.submit"))?.status).toBe("active");
  });
  it("TARGET STATUS (enable): the disable waits for the enabling transaction", async () => {
    const t = await start();
    const appId = await t.createApplication();
    await t.registerOk(appId);
    await t.targets.setStatus({ tenantId: t.tenant, actor: "maya" }, appId, "orders.submitButton", "disabled");
    const outcome = await lockedWriter({ tenant: t.tenant, appId, applications: t.applications, makeWriter: (pool) => () =>
      createPostgresTargetStore(pool).setStatus({ tenantId: t.tenant, actor: "maya" }, appId, "orders.submitButton", "active") });
    expect(outcome.disableWaitedWhileWriterHeldTheLock).toBe(true);
    expect(outcome.written).toBe("changed");
    expect(outcome.enabledAfter).toBe(false);
  });
  it("AFTER the disable committed every writer reads enabled = false and writes nothing (save, publish, register, enable)", async () => {
    const t = await start();
    const appId = await t.createApplication();
    const reference = await t.createApplication(referenceConfig());
    const draft = await t.createWorkflow(reference, profileDef());
    await t.registerOk(appId);
    await t.targets.setStatus({ tenantId: t.tenant, actor: "maya" }, appId, "orders.submitButton", "disabled");
    for (const id of [appId, reference]) await t.applications.setEnabled({ tenantId: t.tenant, actor: "racer" }, id, false);
    const scope = { tenantId: t.tenant, actor: "maya" };
    const id = `wt-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
    expect(await t.realStore.saveDraft(scope, id, { ...profileDef(), id } as never, reference)).toBe("application_disabled");
    expect(await t.realStore.setStatus(scope, draft.id, "published", () => true)).toBe("application_disabled");
    expect(await t.targets.register(scope, appId, { targetId: "orders.other", route: "orders", page: "/#/orders", role: "button", label: "x", description: "y", operations: ["highlight"], privacy: "public" })).toEqual({ kind: "application_disabled" });
    expect(await t.targets.setStatus(scope, appId, "orders.submitButton", "active")).toBe("application_disabled");
    expect(await t.targets.setStatus(scope, appId, "orders.submitButton", "disabled")).toBe("unchanged"); // the lever stays usable
    expect(await t.realStore.get(t.tenant, id)).toBeNull();
    expect((await t.realStore.get(t.tenant, draft.id))?.status).toBe("draft");
  });
  it("concurrent disable and save: whichever order PostgreSQL picks, every save is either stored (it ran before the disable) or refused with application_disabled (after it); never a stored draft for a refused save", async () => {
    const t = await start();
    const appId = await t.createApplication(referenceConfig());
    const scope = { tenantId: t.tenant, actor: "maya" };
    const results = await Promise.all(Array.from({ length: 12 }, async (_v, i) => {
      const id = `wt-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
      const [saved] = await Promise.all([t.realStore.saveDraft(scope, id, { ...profileDef(), id } as never, appId), i === 6 ? t.applications.setEnabled({ tenantId: t.tenant, actor: "racer" }, appId, false) : Promise.resolve("n/a")]);
      return { id, saved };
    }));
    const stored = (await t.sql((c) => c.query("SELECT walkthrough_id, created_at FROM public.walkthrough_definitions"))).rows.map((row) => String(row.walkthrough_id));
    for (const { id, saved } of results) expect(stored.includes(id), `${id} ${saved}`).toBe(saved === "created");
    for (const { saved } of results) expect(["created", "application_disabled"]).toContain(saved);
    expect((await t.applications.get(t.tenant, appId))?.enabled).toBe(false);
  });
});
