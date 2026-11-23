/**
 * Studio COMPLETION migration 077 (text/heading roles, markers, health, revision, the repair gate and the append-only change history) on PostgreSQL, every defence proved by DIRECT SQL as
 * dap_app (DAP_DATABASE_URL), dap_owner (DAP_MIGRATE_DATABASE_URL) only for ownership checks and the rolled-back replay. There is NO SECURITY DEFINER function: a repair is an ordinary transaction
 * that names the target in `studio.repair_target`, raises the revision by exactly one and writes its change row before COMMIT. Fresh tenants and ids per test.
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { assertStateAcl, openStatePools } from "../../packages/security/src/state/conformance/state-pg-fixtures.js";

const MIGRATION = new URL("../../db/migrations/077_studio_target_health.sql", import.meta.url);
let app: Pool; let owner: Pool;
beforeAll(async () => { ({ app, owner } = await openStatePools(Pool)); });
afterAll(async () => { await Promise.all([app?.end(), owner?.end()]); });

type Query = (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
async function asTenant<T>(pool: Pool, tenant: string, run: (query: Query) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenant]);
    const result = await run((sql, params) => client.query(sql, params as never) as never);
    await client.query("COMMIT");
    return result;
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}
const newApp = () => `app-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
const INSERT_APP = "INSERT INTO public.studio_applications (tenant_id, application_id, name, origin, allowed_origins, environment, registry_id, created_by, updated_by) VALUES ($1,$2,'App','http://localhost:5184',ARRAY['http://localhost:5184'],'test','studio-managed','seed','seed')";
const INSERT_ROUTE = "INSERT INTO public.studio_registry_routes (tenant_id, application_id, route, page, created_by) VALUES ($1,$2,'orders','/#/orders','maya')";
const INSERT_TARGET = "INSERT INTO public.studio_registry_targets (tenant_id, application_id, target_id, route, role, label, description, operations, privacy, created_by, updated_by) VALUES ($1,$2,$3,'orders',$4,$5,'Desc',$6::text[],'public','maya','maya')";
interface T { id?: string; role?: string; label?: string; ops?: string[] }
const addTarget = (tenant: string, app_: string, over: T = {}) => asTenant(app, tenant, (q) => q(INSERT_TARGET, [tenant, app_, over.id ?? "orders.submit", over.role ?? "button", over.label ?? "Submit", over.ops ?? ["highlight", "click"]]));
async function ready(): Promise<{ tenant: string; id: string }> {
  const tenant = randomUUID(); const id = newApp();
  await asTenant(app, tenant, async (q) => { await q(INSERT_APP, [tenant, id]); await q(INSERT_ROUTE, [tenant, id]); });
  await addTarget(tenant, id);
  return { tenant, id };
}
interface Repair { marker?: string; role?: string; ops?: string[]; label?: string; description?: string; revision?: number; flagFor?: string | null; change?: "ok" | "none" | "wrongBefore" | "wrongAfter"; changeRevision?: number; target?: string }
/** One repair transaction, exactly as the host's executor writes it (the pieces can be sabotaged one by one). */
async function repair(tenant: string, id: string, over: Repair = {}): Promise<void> {
  const target = over.target ?? "orders.submit";
  const before = (await asTenant(app, tenant, (q) => q("SELECT marker, role, operations, label, description, revision FROM public.studio_registry_targets WHERE application_id=$1 AND target_id=$2", [id, target]))).rows[0]!;
  const after = { marker: over.marker ?? before.marker, role: over.role ?? before.role, operations: over.ops ?? before.operations, label: over.label ?? before.label, description: over.description ?? before.description };
  const revision = over.revision ?? Number(before.revision) + 1;
  const beforeJson = { marker: before.marker, role: before.role, operations: before.operations, label: before.label, description: before.description };
  const client = await app.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenant]);
    if (over.flagFor !== null) await client.query("SELECT set_config('studio.repair_target', $1, true)", [over.flagFor ?? `${tenant}/${id}/${target}`]);
    await client.query("UPDATE public.studio_registry_targets SET marker=$4, role=$5, operations=$6::text[], label=$7, description=$8, revision=$9, health='healthy', health_checked_at=now(), updated_by='maya', updated_at=now() WHERE tenant_id=$1::uuid AND application_id=$2 AND target_id=$3",
      [tenant, id, target, after.marker, after.role, after.operations, after.label, after.description, revision]);
    const mode = over.change ?? "ok";
    if (mode !== "none") {
      await client.query("INSERT INTO public.studio_registry_target_changes (tenant_id, application_id, target_id, revision, changed_by, before, after, reason) VALUES ($1::uuid,$2,$3,$4,'maya',$5::jsonb,$6::jsonb,'repair')",
        [tenant, id, target, over.changeRevision ?? revision, JSON.stringify(mode === "wrongBefore" ? { ...beforeJson, label: "Forged" } : beforeJson), JSON.stringify(mode === "wrongAfter" ? { ...after, label: "Forged" } : after)]);
    }
    await client.query("COMMIT");
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}
const row = async (tenant: string, id: string, target = "orders.submit") => (await asTenant(app, tenant, (q) => q("SELECT * FROM public.studio_registry_targets WHERE application_id=$1 AND target_id=$2", [id, target]))).rows[0]!;
const changes = async (tenant: string, id: string) => (await asTenant(app, tenant, (q) => q("SELECT revision, changed_by, before, after, reason FROM public.studio_registry_target_changes WHERE application_id=$1 ORDER BY revision", [id]))).rows;

describe("columns, defaults and the roles", () => {
  it("a new target is revision 1, health unverified, never checked, with marker = target_id", async () => {
    const { tenant, id } = await ready();
    expect(await row(tenant, id)).toMatchObject({ marker: "orders.submit", health: "unverified", health_checked_at: null, revision: 1 });
  });
  it("registers text and heading targets with exactly {highlight}, and refuses any other operation set or an unknown role", async () => {
    const { tenant, id } = await ready();
    await addTarget(tenant, id, { id: "orders.saved", role: "text", ops: ["highlight"] });
    await addTarget(tenant, id, { id: "orders.title", role: "heading", ops: ["highlight"] });
    for (const ops of [["highlight", "click"], ["highlight", "focus"], ["highlight", "input"], ["click"]]) {
      await expect(addTarget(tenant, id, { id: "orders.bad", role: "text", ops }), ops.join()).rejects.toThrow(/check constraint/);
      await expect(addTarget(tenant, id, { id: "orders.bad", role: "heading", ops }), ops.join()).rejects.toThrow(/check constraint/);
    }
    for (const role of ["panel", "nav", "searchbox", "status", "Text", ""]) await expect(addTarget(tenant, id, { id: "orders.bad", role, ops: ["highlight"] }), role).rejects.toThrow(/check constraint/);
    // the V1B roles keep their operation rules
    await expect(addTarget(tenant, id, { id: "orders.bad", role: "textbox", ops: ["highlight", "click"] })).rejects.toThrow(/check constraint/);
    await expect(addTarget(tenant, id, { id: "orders.ok", role: "textbox", ops: ["highlight", "input"] })).resolves.toBeDefined();
  });
  it("a NEW target cannot be inserted with another marker, another revision or another health state's evidence: marker = id and revision 1 only", async () => {
    const { tenant, id } = await ready();
    const insert = (marker: string | null, revision: number) => asTenant(app, tenant, (q) => q(
      "INSERT INTO public.studio_registry_targets (tenant_id, application_id, target_id, marker, route, role, label, description, operations, privacy, revision, created_by, updated_by) VALUES ($1,$2,'orders.two',$3,'orders','button','L','D',ARRAY['highlight'],'public',$4,'m','m')", [tenant, id, marker, revision]));
    await expect(insert("orders.other", 1)).rejects.toThrow(/new_identity/);
    await expect(insert("orders.two", 2)).rejects.toThrow(/new_identity/);
    await insert("orders.two", 1);
    expect((await row(tenant, id, "orders.two")).marker).toBe("orders.two");
  });
  it.each([["an upper-case first letter", "Orders.x"], ["no dot", "ordersx"], ["a reserved prefix", "dap.thing"], ["81 characters", `orders.${"a".repeat(74)}`], ["a space", "orders. x"]])("the marker grammar is the target-id grammar: refuses %s", async (_name, marker) => {
    const { tenant, id } = await ready();
    await expect(asTenant(app, tenant, (q) => q("UPDATE public.studio_registry_targets SET marker=$2 WHERE application_id=$1", [id, marker]))).rejects.toThrow(/check constraint|only by a repair/);
  });
  it("health is one of unverified, healthy, broken and changes freely, with its timestamp, and the owner-restored FORCE RLS is on", async () => {
    const { tenant, id } = await ready();
    for (const health of ["broken", "healthy", "unverified"]) {
      await asTenant(app, tenant, (q) => q("UPDATE public.studio_registry_targets SET health=$2, health_checked_at=now() WHERE application_id=$1", [id, health]));
      expect((await row(tenant, id)).health).toBe(health);
    }
    await expect(asTenant(app, tenant, (q) => q("UPDATE public.studio_registry_targets SET health='fine' WHERE application_id=$1", [id]))).rejects.toThrow(/check constraint/);
    expect((await app.query("SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid='public.studio_registry_targets'::regclass")).rows).toEqual([{ relrowsecurity: true, relforcerowsecurity: true }]);
  });
});

describe("the repair gate: marker, role, operations, label and description change only through a repair", () => {
  it("the legal path: flag + revision+1 + a matching change row in one transaction changes the target, records the history and marks it healthy", async () => {
    const { tenant, id } = await ready();
    await repair(tenant, id, { marker: "orders.submitNew", label: "Send", description: "Sends it" });
    expect(await row(tenant, id)).toMatchObject({ target_id: "orders.submit", marker: "orders.submitNew", label: "Send", description: "Sends it", revision: 2, health: "healthy", route: "orders" });
    const history = await changes(tenant, id);
    expect(history).toEqual([{ revision: 2, changed_by: "maya", reason: "repair",
      before: { marker: "orders.submit", role: "button", operations: ["highlight", "click"], label: "Submit", description: "Desc" }, after: { marker: "orders.submitNew", role: "button", operations: ["highlight", "click"], label: "Send", description: "Sends it" } }]);
    await repair(tenant, id, { marker: "orders.submitThird", role: "link" });
    expect((await row(tenant, id)).revision).toBe(3);
    expect((await changes(tenant, id)).map((change) => change.revision)).toEqual([2, 3]);
  });
  it("a repair can change the role and the operations together (the table's role/operations rules still apply) and can move the marker back to the id", async () => {
    const { tenant, id } = await ready();
    await repair(tenant, id, { role: "textbox", ops: ["highlight", "input"], marker: "orders.nameInput" });
    expect(await row(tenant, id)).toMatchObject({ role: "textbox", operations: ["highlight", "input"] });
    await expect(repair(tenant, id, { role: "text", ops: ["highlight", "input"] })).rejects.toThrow(/check constraint/);
    await expect(repair(tenant, id, { role: "button", ops: ["highlight", "input"] })).rejects.toThrow(/check constraint/);
    await repair(tenant, id, { marker: "orders.submit", role: "button", ops: ["highlight", "click"] });
    expect((await row(tenant, id)).marker).toBe("orders.submit");
  });
  it.each(["label = 'Other'", "description = 'Other'", "role = 'link'", "operations = ARRAY['highlight']", "marker = 'orders.moved'"])("%s WITHOUT the flag is refused, with or without a revision bump", async (set) => {
    const { tenant, id } = await ready();
    await expect(asTenant(app, tenant, (q) => q(`UPDATE public.studio_registry_targets SET ${set} WHERE application_id=$1`, [id]))).rejects.toThrow(/only by a repair/);
    await expect(asTenant(app, tenant, (q) => q(`UPDATE public.studio_registry_targets SET ${set}, revision = revision + 1 WHERE application_id=$1`, [id]))).rejects.toThrow(/only by a repair/);
    expect(await row(tenant, id)).toMatchObject({ label: "Submit", marker: "orders.submit", revision: 1 });
  });
  it("the flag must name THIS target (another target's key, another application's or another tenant's does nothing) and must be transaction-local", async () => {
    const { tenant, id } = await ready();
    await addTarget(tenant, id, { id: "orders.note", role: "textbox", ops: ["highlight", "input"] });
    await expect(repair(tenant, id, { label: "X", flagFor: `${tenant}/${id}/orders.note` })).rejects.toThrow(/only by a repair/);
    await expect(repair(tenant, id, { label: "X", flagFor: `${randomUUID()}/${id}/orders.submit` })).rejects.toThrow(/only by a repair/);
    await expect(repair(tenant, id, { label: "X", flagFor: `${tenant}/app-000000000000/orders.submit` })).rejects.toThrow(/only by a repair/);
    await expect(repair(tenant, id, { label: "X", flagFor: null })).rejects.toThrow(/only by a repair/);
    // a flag set in an earlier, finished transaction is gone
    await asTenant(app, tenant, (q) => q("SELECT set_config('studio.repair_target', $1, true)", [`${tenant}/${id}/orders.submit`]));
    await expect(asTenant(app, tenant, (q) => q("UPDATE public.studio_registry_targets SET label='X', revision=2 WHERE application_id=$1 AND target_id='orders.submit'", [id]))).rejects.toThrow(/only by a repair/);
  });
  it("the revision must rise by exactly one: a skip, a repeat, a decrease and a bare bump are refused", async () => {
    const { tenant, id } = await ready();
    for (const revision of [3, 1, 0, 100]) await expect(repair(tenant, id, { label: "X", revision }), String(revision)).rejects.toThrow(/revision|check constraint/);
    await expect(asTenant(app, tenant, (q) => q("UPDATE public.studio_registry_targets SET revision = 2 WHERE application_id=$1", [id]))).rejects.toThrow(/revision moves only with a repair/);
    expect((await row(tenant, id)).revision).toBe(1);
  });
  it("without a matching change row at COMMIT the repair is refused and rolled back; a row that lies about before or after, or names another revision, does not count", async () => {
    const { tenant, id } = await ready();
    for (const over of [{ change: "none" }, { change: "wrongBefore" }, { change: "wrongAfter" }, { change: "ok", changeRevision: 3 }] as Repair[]) {
      await expect(repair(tenant, id, { label: "Changed", ...over }), JSON.stringify(over)).rejects.toThrow(/matching change row|has not reached/);
      expect(await row(tenant, id)).toMatchObject({ label: "Submit", revision: 1 });
      expect(await changes(tenant, id)).toEqual([]);
    }
  });
  it("id, application, route, page, privacy and creation data stay immutable even inside a legal-looking repair", async () => {
    const { tenant, id } = await ready();
    for (const set of ["target_id = 'orders.other'", "route = 'orders'", "created_by = 'mallory'", "privacy = 'public'", "application_id = 'app-000000000000'", "tenant_id = '00000000-0000-4000-8000-000000000000'"]) {
      const client = await app.connect();
      try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenant]);
        await client.query("SELECT set_config('studio.repair_target', $1, true)", [`${tenant}/${id}/orders.submit`]);
        await expect(client.query(`UPDATE public.studio_registry_targets SET label='Z', revision=2, ${set} WHERE application_id=$1`, [id]), set).rejects.toThrow(/permission denied|cannot be changed|row-level security/);
      } finally { await client.query("ROLLBACK"); client.release(); }
    }
  });
});

describe("markers never collide with ids or each other", () => {
  it("a repair cannot take another target's id or marker; a new target cannot take another target's marker as its id", async () => {
    const { tenant, id } = await ready();
    await addTarget(tenant, id, { id: "orders.note", role: "textbox", ops: ["highlight", "input"] });
    await expect(repair(tenant, id, { marker: "orders.note" })).rejects.toThrow(/marker_in_use/);
    await repair(tenant, id, { marker: "orders.submitNew" });
    await expect(repair(tenant, id, { target: "orders.note", marker: "orders.submitNew" })).rejects.toThrow(/marker_in_use|duplicate key|marker_key/);
    await expect(addTarget(tenant, id, { id: "orders.submitNew", role: "button", ops: ["highlight"] })).rejects.toThrow(/marker_in_use/);
    // the id of a target that moved is not free either: another target may not claim it as a marker, nor register it as an id
    await expect(repair(tenant, id, { target: "orders.note", marker: "orders.submit" })).rejects.toThrow(/marker_in_use/);
    // and a target may take its own id back
    await repair(tenant, id, { marker: "orders.submit" });
  });
  it("two applications of one tenant, and two tenants, may use the same markers independently", async () => {
    const a = await ready(); const b = await ready();
    await repair(a.tenant, a.id, { marker: "shared.marker" });
    await repair(b.tenant, b.id, { marker: "shared.marker" });
    const second = newApp();
    await asTenant(app, a.tenant, async (q) => { await q(INSERT_APP, [a.tenant, second]); await q(INSERT_ROUTE, [a.tenant, second]); });
    await addTarget(a.tenant, second);
    await repair(a.tenant, second, { marker: "shared.marker" });
  });
  it("two concurrent repairs to the same marker cannot both succeed", async () => {
    const { tenant, id } = await ready();
    await addTarget(tenant, id, { id: "orders.note", role: "textbox", ops: ["highlight", "input"] });
    const outcomes = await Promise.allSettled([repair(tenant, id, { marker: "orders.contested" }), repair(tenant, id, { target: "orders.note", marker: "orders.contested" })]);
    expect(outcomes.filter((outcome) => outcome.status === "fulfilled")).toHaveLength(1);
    expect((await asTenant(app, tenant, (q) => q("SELECT count(*)::int AS n FROM public.studio_registry_targets WHERE application_id=$1 AND marker='orders.contested'", [id]))).rows).toEqual([{ n: 1 }]);
  });
});

describe("the change history is append-only and tenant-isolated", () => {
  it("owned by dap_owner with forced RLS; dap_app has SELECT and INSERT only (no UPDATE, DELETE, TRUNCATE); nothing for PUBLIC", async () => {
    await assertStateAcl(app, "studio_registry_target_changes", ["SELECT", "INSERT"]);
    expect((await app.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='studio_registry_target_changes' ORDER BY ordinal_position")).rows.map((r) => r.column_name))
      .toEqual(["tenant_id", "application_id", "target_id", "revision", "changed_at", "changed_by", "before", "after", "reason"]);
  });
  it("a recorded change cannot be edited or removed, by dap_app", async () => {
    const { tenant, id } = await ready();
    await repair(tenant, id, { label: "Send" });
    await expect(asTenant(app, tenant, (q) => q("UPDATE public.studio_registry_target_changes SET changed_by='mallory' WHERE application_id=$1", [id]))).rejects.toThrow(/permission denied/);
    await expect(asTenant(app, tenant, (q) => q("DELETE FROM public.studio_registry_target_changes WHERE application_id=$1", [id]))).rejects.toThrow(/permission denied/);
    await expect(app.query("TRUNCATE public.studio_registry_target_changes")).rejects.toThrow(/permission denied/);
    expect(await changes(tenant, id)).toHaveLength(1);
  });
  it("shape checks: revision at least 2, reason exactly repair, before/after JSON objects within 2 KiB, a real target, the caller's own tenant", async () => {
    const { tenant, id } = await ready();
    const insert = (over: Partial<Record<"revision" | "reason" | "before" | "after" | "target" | "tenant" | "by", unknown>>) => asTenant(app, tenant, (q) => q(
      "INSERT INTO public.studio_registry_target_changes (tenant_id, application_id, target_id, revision, changed_by, before, after, reason) VALUES ($1::uuid,$2,$3,$4,$5,$6::jsonb,$7::jsonb,$8)",
      [over.tenant ?? tenant, id, over.target ?? "orders.submit", over.revision ?? 2, over.by ?? "maya", JSON.stringify(over.before ?? {}), JSON.stringify(over.after ?? {}), over.reason ?? "repair"]));
    await expect(insert({ revision: 1 })).rejects.toThrow(/check constraint/);
    await expect(insert({ reason: "edit" })).rejects.toThrow(/check constraint/);
    await expect(insert({ before: [1] })).rejects.toThrow(/check constraint/);
    await expect(insert({ after: "x" })).rejects.toThrow(/check constraint/);
    await expect(insert({ after: { big: "x".repeat(3000) } })).rejects.toThrow(/check constraint/);
    await expect(insert({ by: "" })).rejects.toThrow(/check constraint/);
    await expect(insert({ target: "orders.missing" })).rejects.toThrow(/foreign key/);
    await expect(insert({ tenant: randomUUID() })).rejects.toThrow(/row-level security/);
    await expect(insert({})).rejects.toThrow(/has not reached/); // a perfectly shaped row for a revision the target never reached
    expect(await changes(tenant, id)).toEqual([]);
  });
  it("rows are invisible to other tenants and without a tenant setting", async () => {
    const { tenant, id } = await ready();
    await repair(tenant, id, { label: "Send" });
    expect(await changes(randomUUID(), id)).toEqual([]);
    expect((await app.query("SELECT 1 FROM public.studio_registry_target_changes")).rows).toEqual([]);
  });
});

describe("grants and the absence of any SECURITY DEFINER", () => {
  it("dap_app may update exactly status, health, health_checked_at, marker, role, operations, label, description, revision, updated_by and updated_at of a target", async () => {
    const columns = (await app.query("SELECT column_name FROM information_schema.columns WHERE table_schema='public' AND table_name='studio_registry_targets'")).rows.map((r) => String(r.column_name));
    const allowed: string[] = []; const refused: string[] = [];
    for (const column of columns) {
      const ok = (await app.query("SELECT has_column_privilege('dap_app', 'public.studio_registry_targets', $1, 'UPDATE') AS ok", [column])).rows[0]!.ok === true;
      (ok ? allowed : refused).push(column);
    }
    expect(allowed.sort()).toEqual(["description", "health", "health_checked_at", "label", "marker", "operations", "revision", "role", "status", "updated_at", "updated_by"]);
    expect(refused.sort()).toEqual(["application_id", "created_at", "created_by", "privacy", "registry_id", "route", "target_id", "tenant_id"]);
    expect((await app.query("SELECT has_table_privilege('dap_app', 'public.studio_registry_targets', 'UPDATE') AS ok")).rows).toEqual([{ ok: false }]);
  });
  it("defines no SECURITY DEFINER function in public (the Feature 001 conformance query is empty)", async () => {
    expect((await app.query("SELECT proname FROM pg_proc WHERE prosecdef AND pronamespace='public'::regnamespace")).rows).toEqual([]);
    expect((await app.query("SELECT proname FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname LIKE 'studio_%' AND proname IN ('studio_runtime_application','studio_repair_target','studio_set_health')")).rows).toEqual([]);
  });
  it("replays cleanly as dap_owner (twice, in a rolled-back transaction) and applies only as dap_owner", async () => {
    const sql = await readFile(MIGRATION, "utf8");
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql); await client.query(sql);
      expect((await client.query("SELECT count(*)::int AS n FROM pg_trigger WHERE tgrelid='public.studio_registry_targets'::regclass AND tgname IN ('studio_registry_targets_marker_rules','studio_registry_targets_repair_history')")).rows).toEqual([{ n: 2 }]);
      expect((await client.query("SELECT relforcerowsecurity FROM pg_class WHERE oid='public.studio_registry_targets'::regclass")).rows).toEqual([{ relforcerowsecurity: true }]);
    } finally { await client.query("ROLLBACK"); client.release(); }
    await expect(app.query(sql)).rejects.toThrow(/requires dap_owner/);
  });
});
