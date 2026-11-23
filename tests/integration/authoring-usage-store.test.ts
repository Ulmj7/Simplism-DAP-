import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { Pool } from "pg";
import { afterAll, beforeAll, expect, it } from "vitest";
import { completionRate, usageReport } from "../../apps/reference-host/src/authoring/analytics.js";
import { createPostgresWalkthroughStore } from "../../apps/reference-host/src/authoring/postgres-store.js";
import { withTenant } from "../../apps/reference-host/src/authoring/tenant-tx.js";
import { openStatePools } from "../../packages/security/src/state/conformance/state-pg-fixtures.js";

let app: Pool;
let owner: Pool;
beforeAll(async () => { ({ app, owner } = await openStatePools(Pool)); });
afterAll(async () => { await Promise.all([app?.end(), owner?.end()]); });
const guide = "profileUpdate";
const insert = "INSERT INTO public.walkthrough_events (tenant_id, walkthrough_id, run_id, event_type) VALUES ($1,$2,$3,$4)";
const read = "SELECT walkthrough_id, event_type, run_id FROM public.walkthrough_events ORDER BY event_type";

it("can reapply 071 and keeps a minimal, forced-tenant table", async () => {
  await owner.query(await readFile(new URL("../../db/migrations/071_walkthrough_events.sql", import.meta.url), "utf8"));
  const table = await owner.query("SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid = 'public.walkthrough_events'::regclass");
  expect(table.rows).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);
  const columns = await owner.query("SELECT column_name FROM information_schema.columns WHERE table_schema = 'public' AND table_name = 'walkthrough_events' ORDER BY ordinal_position");
  expect(columns.rows.map(row => row.column_name)).toEqual(["tenant_id", "walkthrough_id", "run_id", "event_type", "occurred_at"]);
});

it("refuses modifications from both dap_app and the table owner and constrains event shapes", async () => {
  const tenant = randomUUID();
  const run = randomUUID();
  await withTenant(app, tenant, client => client.query(insert, [tenant, guide, run, "started"]));
  const grants = await owner.query("SELECT privilege_type FROM information_schema.role_table_grants WHERE table_name = 'walkthrough_events' AND grantee = 'dap_app' ORDER BY privilege_type");
  expect(grants.rows.map(row => row.privilege_type)).toEqual(["INSERT", "SELECT"]);
  for (const sql of ["UPDATE public.walkthrough_events SET event_type = 'cancelled'", "DELETE FROM public.walkthrough_events", "TRUNCATE public.walkthrough_events"]) {
    await expect(withTenant(app, tenant, client => client.query(sql))).rejects.toMatchObject({ code: "42501" });
    await expect(withTenant(owner, tenant, client => client.query(sql))).rejects.toThrow(/append-only/);
  }
  for (const [id, runId, kind, code] of [["bad id", randomUUID(), "started", "23514"], [guide, "invalid-run", "started", "22P02"], [guide, randomUUID(), "failed", "23514"]]) {
    await expect(withTenant(app, tenant, client => client.query(insert, [tenant, id, runId, kind]))).rejects.toMatchObject({ code });
  }
});

it("deduplicates reports, joins only same-tenant same-guide runs and protects totals from orphan terminals", async () => {
  const [tenant, other] = [randomUUID(), randomUUID()];
  const store = createPostgresWalkthroughStore(app);
  const [complete, cancel, mismatch, orphan] = Array.from({ length: 4 }, () => randomUUID()) as [string, string, string, string];
  const report = (runId: string, event: "started" | "completed" | "cancelled", walkthroughId = guide) =>
    store.recordEvent(tenant, { walkthroughId, runId, event });
  await report(complete, "started"); await report(complete, "started");
  await report(complete, "completed"); await report(complete, "completed"); await report(complete, "cancelled");
  await report(cancel, "started"); await report(cancel, "cancelled");
  await report(mismatch, "started"); await report(mismatch, "completed", "findSecuritySettings");
  await report(mismatch, "completed");
  await report(orphan, "completed");
  // Bypass the store to prove the query defends against legacy or directly inserted orphan and cross-guide terminals.
  const mismatchedInsert = randomUUID();
  await withTenant(app, tenant, async client => {
    await client.query(insert, [tenant, guide, mismatchedInsert, "started"]);
    await client.query(insert, [tenant, "findSecuritySettings", mismatchedInsert, "completed"]);
    await client.query(insert, [tenant, guide, orphan, "completed"]);
  });
  await withTenant(app, other, client => client.query(insert, [other, guide, mismatch, "completed"]));
  await expect(withTenant(app, tenant, client => client.query(insert, [other, guide, randomUUID(), "started"]))).rejects.toMatchObject({ code: "42501" });
  const actual = (await withTenant(owner, tenant, client => client.query(read))).rows;
  expect(actual).toHaveLength(9);
  expect(actual.filter(row => row.run_id === complete).map(row => row.event_type)).toEqual(["completed", "started"]);
  expect(await store.summary(tenant)).toEqual([{ id: guide, title: null, started: 4, completed: 2, cancelled: 1 }]);
  expect(await store.summary(other)).toEqual([]);
  expect((await app.query(read)).rows).toEqual([]);
});

it("rounds whole rates, returns no rate without starts and clamps invalid proportions", () => {
  expect([completionRate(0, 0), completionRate(3, 1), completionRate(3, 2), completionRate(1, 1)]).toEqual([null, 33, 67, 100]);
  expect([completionRate(1, 3), completionRate(1, -1), completionRate(Infinity, 1), completionRate(1, NaN)]).toEqual([100, 0, null, null]);
});


it("orders equal starts by title, falls back to the guide ID and derives totals from the rows", () => {
  const usage = usageReport([
    { id: "legacyGuide", title: null, started: 2, completed: 1, cancelled: 0 },
    { id: "knownBuiltin", title: null, started: 2, completed: 2, cancelled: 0 },
    { id: "wt-777777777777", title: "Release guide", started: 3, completed: 2, cancelled: 1 },
  ], [{ id: "knownBuiltin", title: "Guide built in" }]);
  expect(usage.guides.map(row => [row.title, row.completionRate])).toEqual([["Release guide", 67], ["Guide built in", 100], ["legacyGuide", 50]]);
  expect(usage.totals).toEqual({ started: 7, completed: 5, cancelled: 1, completionRate: 71 });
});
