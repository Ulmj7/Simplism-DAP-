import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import type { ReferenceHost } from "../../apps/reference-host/src/index.js";
import { registerRuntimeRoutes } from "../../apps/reference-host/src/studio/runtime-routes.js";
import { assertStateAcl, openStatePools } from "../../packages/security/src/state/conformance/state-pg-fixtures.js";
import { managedConfig, managedDef, startHost } from "./studio-registry.support.js";

let owner: Pool;
let probe: Pool;
const closers: (() => Promise<unknown>)[] = [];
const hosts: ReferenceHost[] = [];
beforeAll(async () => { ({ app: probe, owner } = await openStatePools(Pool)); });
afterAll(async () => { await Promise.all([probe?.end(), owner?.end()]); });
afterEach(async () => { await Promise.all([...closers.splice(0).map((close) => close()), ...hosts.splice(0).map((host) => host.close())]); });

async function ready(options?: Parameters<typeof startHost>[3]) {
  const host = await startHost(closers, hosts, owner, options);
  registerRuntimeRoutes(host.app, { applications: host.applications, store: host.store, catalog: host.catalog, resolver: host.resolver });
  const applicationId = await host.createApplication(managedConfig({ runtimeAccess: true }));
  await host.registerOk(applicationId);
  await host.registerOk(applicationId, { targetId: "orders.other" });
  const version1 = managedDef(undefined, undefined, { title: "First version" });
  const { res, id } = await host.createWorkflow(applicationId, version1);
  expect(res).toMatchObject({ status: 201, body: { id, revision: 1, liveVersion: null, latestVersion: 0 } });
  const path = `/api/admin/walkthroughs/${id}`;
  const post = (suffix: string, body?: unknown) => host.call("POST", `${path}/${suffix}`, "maintainer", body);
  const get = (suffix?: string, role: "maintainer" | "user" = "maintainer") => host.call("GET", suffix ? `${path}/${suffix}` : path, role);
  const save = (expectedRevision: number, definition: unknown) => host.call("PUT", path, "maintainer", { applicationId, definition, expectedRevision });
  const publish = (expectedRevision: number) => post("status", { status: "published", expectedRevision });
  const application = (await host.applications.get(host.tenant, applicationId))!;
  const runtime = (subpath = "") => host.app.inject({ method: "GET", url: `/api/runtime/${application.runtimeKey}/guides${subpath}`, headers: { origin: application.origin } });
  return { host, applicationId, id, path, version1, post, get, save, publish, runtime };
}

describe("S5 workflow versions and concurrency", () => {
  it("publishes, revises, publishes again, restores and unpublishes without rewriting any earlier snapshot", async () => {
    const t = await ready();
    expect(await t.publish(1)).toMatchObject({ status: 200, body: { revision: 2, liveVersion: 1, latestVersion: 1, version: 1 } });
    const first = (await t.get("versions/1")).body;
    expect(first).toMatchObject({ version: 1, stepCount: 3, live: true, publishedBy: "maya", definition: { title: "First version" } });
    expect(await t.post("revise", {})).toMatchObject({ status: 200, body: { revision: 3, status: "draft", liveVersion: 1, latestVersion: 1 } });
    expect((await t.post("revise", {})).status).toBe(409);
    const second = managedDef("orders.other", undefined, { title: "Second version" });
    expect(await t.save(3, second)).toMatchObject({ status: 200, body: { revision: 4, liveVersion: 1 } });
    expect((await t.runtime(`/${t.id}`)).json()).toMatchObject({ version: 1, definition: { title: "First version" } });
    expect((await t.runtime()).json()).toMatchObject({ guides: [{ id: t.id, title: "First version" }] });
    const catalog = await t.host.call("GET", "/api/walkthroughs/published", "user");
    expect(catalog.body).toMatchObject({ external: [{ id: t.id, title: "First version" }] });
    expect((await t.host.call("GET", `/api/walkthroughs/published/${t.id}/bundle`, "user")).body).toMatchObject({ version: 1, definition: { title: "First version" } });
    expect(await t.post("review", {})).toMatchObject({ status: 200, body: {
      revision: 4, ok: true, warnings: expect.arrayContaining([expect.objectContaining({ code: "SUPERSEDES_LIVE_VERSION" })]),
      summary: { currentVersion: 1, nextVersion: 2, title: "Second version" },
    } });
    expect(await t.publish(4)).toMatchObject({ status: 200, body: { revision: 5, liveVersion: 2, latestVersion: 2, version: 2 } });
    expect((await t.get("versions/1")).body).toEqual({ ...first, live: false });
    expect((await t.get("versions")).body).toMatchObject({ versions: [{ version: 2, live: true }, { version: 1, live: false }] });
    expect(await t.post("restore", { version: 999 })).toMatchObject({ status: 404 });
    expect(await t.post("restore", { version: 1 })).toMatchObject({ status: 200, body: {
      status: "draft", revision: 6, liveVersion: 2, latestVersion: 2, definition: { title: "First version" },
    } });
    expect((await t.runtime(`/${t.id}`)).json()).toMatchObject({ version: 2, definition: { title: "Second version" } });
    expect(await t.post("status", { status: "draft" })).toMatchObject({ status: 200, body: { revision: 7, liveVersion: null, latestVersion: 2 } });
    expect((await t.runtime(`/${t.id}`)).statusCode).toBe(404);
    expect((await t.get("versions/1")).body).toEqual({ ...first, live: false });
    expect((await t.get("versions", "user")).status).toBe(403);
    const other = await startHost(closers, hosts, owner);
    expect((await other.call("GET", `${t.path}/versions/1`, "maintainer")).status).toBe(404);
  });

  it("permits exactly one competing save and rejects publishing a stale reviewed revision", async () => {
    const t = await ready();
    const outcomes = await Promise.all([t.save(1, managedDef(undefined, undefined, { title: "Writer A" })),
      t.save(1, managedDef(undefined, undefined, { title: "Writer B" }))]);
    const winner = outcomes.find((result) => result.status === 200);
    expect(winner?.body).toMatchObject({ revision: 2, liveVersion: null });
    expect(outcomes.find((result) => result.status === 409)?.body).toEqual({ kind: "conflict", code: "REVISION_CONFLICT", currentRevision: 2 });
    expect((await t.get()).body.definition).toEqual(winner?.body.definition);
    expect(await t.publish(1)).toMatchObject({ status: 409, body: { code: "REVISION_CONFLICT", currentRevision: 2 } });
    expect((await t.get()).body.liveVersion).toBeNull();
    expect((await t.get("versions")).body).toEqual({ versions: [] });
    const publications = await Promise.all([t.publish(2), t.publish(2)]);
    expect(publications.map(({ status }) => status).sort()).toEqual([200, 409]);
    expect((await t.get("versions")).body).toMatchObject({ versions: [{ version: 1, live: true }] });
    expect((await t.get("versions/1")).body.definition).toEqual(winner?.body.definition);
  });

  it("rejects a stale review after a new save without replacing the already-live snapshot", async () => {
    const t = await ready();
    expect((await t.publish(1)).status).toBe(200);
    expect((await t.post("revise")).status).toBe(200);
    const review = await t.post("review");
    expect(review).toMatchObject({ status: 200, body: { revision: 3, ok: true, summary: { currentVersion: 1 } } });
    expect((await t.save(3, managedDef("orders.other", undefined, { title: "Saved after review" }))).status).toBe(200);
    expect(await t.publish(review.body.revision as number)).toMatchObject({
      status: 409, body: { code: "REVISION_CONFLICT", currentRevision: 4 },
    });
    expect((await t.runtime(`/${t.id}`)).json()).toMatchObject({ version: 1, definition: { title: "First version" } });
    expect((await t.get("versions")).body).toMatchObject({ versions: [{ version: 1, live: true }] });
  });

  it("checks the reviewed revision again inside the publish transaction after an intervening save", async () => {
    let beforePublish: (() => Promise<void>) | undefined;
    const t = await ready({ wrapStore: (store) => ({
      ...store,
      setStatus: async (...args) => { await beforePublish?.(); return store.setStatus(...args); },
    }) });
    expect((await t.publish(1)).status).toBe(200);
    expect((await t.post("revise")).status).toBe(200);
    const review = await t.post("review");
    expect(review.body.revision).toBe(3);
    beforePublish = async () => {
      const saved = await t.save(3, managedDef("orders.other", undefined, { title: "Intervening save" }));
      expect(saved).toMatchObject({ status: 200, body: { revision: 4 } });
    };
    expect(await t.publish(3)).toMatchObject({ status: 409, body: { code: "REVISION_CONFLICT", currentRevision: 4 } });
    expect((await t.get()).body).toMatchObject({ revision: 4, liveVersion: 1, latestVersion: 1, definition: { title: "Intervening save" } });
    expect((await t.runtime(`/${t.id}`)).json()).toMatchObject({ version: 1, definition: { title: "First version" } });
  });

  it("includes the live snapshot in repair impact after its target has been removed from the working copy", async () => {
    const t = await ready();
    expect((await t.publish(1)).status).toBe(200);
    expect((await t.post("revise")).status).toBe(200);
    expect((await t.save(3, managedDef("orders.other"))).status).toBe(200);
    const target = "orders.submitButton";
    expect(await t.host.targets.definitionsUsing(t.host.tenant, t.applicationId, target)).toMatchObject([{ id: t.id, status: "published", version: 1 }]);
    expect(await t.host.submit("repairStudioTarget", {
      applicationId: t.applicationId, targetId: target, marker: "orders.replacement", elementRole: "text",
      operations: ["highlight"], label: "Order status", description: "Shows order status.",
    })).toEqual({ outcome: "ALLOWED", category: "try_later" });
    expect(await t.host.targets.get(t.host.tenant, t.applicationId, target)).toMatchObject({ revision: 1, marker: target });
    expect((await t.runtime(`/${t.id}`)).statusCode).toBe(200);
  });

  it("reports an unavailable verification and rechecks it if it changes after the HTTP publish preflight", async () => {
    let beforePublish: (() => Promise<void>) | undefined;
    const t = await ready({ wrapStore: (store) => ({
      ...store,
      setStatus: async (...args) => { await beforePublish?.(); return store.setStatus(...args); },
    }) });
    const checks = `/api/admin/applications/${t.applicationId}/checks`;
    const registered = await t.host.call("POST", checks, "maintainer", { kind: "element.visible", targetId: "orders.submitButton" });
    expect(registered.status).toBe(200);
    const name = registered.body.name;
    const definition = managedDef();
    Object.assign(definition.steps[1]!, { verify: name });
    expect((await t.save(1, definition)).status).toBe(200);
    expect(await t.post("review")).toMatchObject({ status: 200, body: { revision: 2, ok: true } });
    beforePublish = async () => {
      expect((await t.host.call("POST", `${checks}/${name}/status`, "maintainer", { status: "disabled" })).status).toBe(200);
    };
    expect(await t.publish(2)).toMatchObject({ status: 422, body: { kind: "invalid" } });
    expect(await t.post("review")).toMatchObject({ status: 200, body: {
      revision: 2, ok: false, blockers: expect.arrayContaining([expect.objectContaining({ code: "INVALID_VERIFICATION", stepIndex: 1 })]),
    } });
    expect((await t.get("versions")).body).toEqual({ versions: [] });
  });

  it("uses review warnings for target health and verification, and publication blocks disabled targets", async () => {
    const t = await ready();
    const target = "orders.submitButton";
    const targetPath = `/api/admin/applications/${t.applicationId}/targets/${target}`;
    expect((await t.host.call("POST", `${targetPath}/health`, "maintainer", { state: "broken" })).status).toBe(200);
    const review = await t.post("review");
    expect(review).toMatchObject({ status: 200, body: {
      ok: true, blockers: [], warnings: [{ code: "TARGET_BROKEN", stepIndex: 1, targetId: target }],
      summary: { targets: { healthy: 0, broken: 1, unverified: 0, disabled: 0 }, verification: { steps: 1, withVerify: 1 }, steps: 3 },
    } });
    expect((await t.get()).body.revision).toBe(1);
    expect((await t.host.call("POST", `${targetPath}/status`, "maintainer", { status: "disabled" })).status).toBe(200);
    expect(await t.post("review")).toMatchObject({ status: 200, body: {
      ok: false, blockers: expect.arrayContaining([expect.objectContaining({ code: "TARGET_DISABLED", targetId: target })]),
      summary: { targets: { disabled: 1 } },
    } });
    expect((await t.publish(1)).status).toBe(422);
    expect((await t.get("versions")).body).toEqual({ versions: [] });
  });
});

describe("migration 079", () => {
  it("backfills published rows once during a replay and leaves legacy drafts without a live version", async () => {
    const migration = await readFile(new URL("../../db/migrations/079_walkthrough_versions.sql", import.meta.url), "utf8");
    const client = await owner.connect();
    const tenant = randomUUID();
    try {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenant]);
      for (const [id, status] of [["wt-00000000f101", "published"], ["wt-00000000f102", "draft"]]) {
        await client.query("INSERT INTO public.walkthrough_definitions (tenant_id, walkthrough_id, status, definition, created_by, updated_by) VALUES ($1,$2,$3,$4,'seed','publisher')",
          [tenant, id, status, { ...managedDef(), id }]);
      }
      for (let pass = 0; pass < 2; pass += 1) {
        await client.query(migration);
        expect((await client.query("SELECT live_version, revision FROM public.walkthrough_definitions WHERE tenant_id=$1 ORDER BY walkthrough_id", [tenant])).rows).toEqual([
          { live_version: 1, revision: 1 }, { live_version: null, revision: 1 },
        ]);
        expect((await client.query("SELECT version, published_by, step_count FROM public.walkthrough_versions WHERE tenant_id=$1", [tenant])).rows).toEqual([
          { version: 1, published_by: "publisher", step_count: 1 },
        ]);
      }
    } finally { await client.query("ROLLBACK"); client.release(); }
  });

  it("gives the app role append-only access to its own snapshots and binds live pointers to the same walkthrough", async () => {
    await assertStateAcl(probe, "walkthrough_versions", ["SELECT", "INSERT"]);
    const t = await ready();
    expect((await t.publish(1)).status).toBe(200);
    await expect(t.host.sql((c) => c.query("UPDATE public.walkthrough_versions SET published_by='other'"))).rejects.toMatchObject({ code: "42501" });
    await expect(t.host.sql((c) => c.query("DELETE FROM public.walkthrough_versions"))).rejects.toMatchObject({ code: "42501" });
    await expect(t.host.sql((c) => c.query("UPDATE public.walkthrough_definitions SET live_version=99 WHERE walkthrough_id=$1", [t.id]))).rejects.toMatchObject({ code: "23503" });
    const other = await startHost(closers, hosts, owner);
    expect((await other.sql((c) => c.query("SELECT version FROM public.walkthrough_versions WHERE walkthrough_id=$1", [t.id]))).rows).toEqual([]);
  });
});
