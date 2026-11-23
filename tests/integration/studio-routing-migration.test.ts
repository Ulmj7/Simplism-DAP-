/**
 * Studio COMPLETION migration 076 (routing, runtime access, the tenant-embedded runtime key, the page grammar by routing; NO SECURITY DEFINER function and no extra policy) on a PostgreSQL database, every defence proved by
 * DIRECT SQL as dap_app (DAP_DATABASE_URL), dap_owner (DAP_MIGRATE_DATABASE_URL) only for ownership checks and the idempotence replay. Fresh tenants and ids per test.
 */
import { randomBytes, randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { assertStateAcl, openStatePools } from "../../packages/security/src/state/conformance/state-pg-fixtures.js";

const MIGRATION = new URL("../../db/migrations/076_studio_routing_runtime.sql", import.meta.url);
let app: Pool; let owner: Pool;
beforeAll(async () => { ({ app, owner } = await openStatePools(Pool)); });
afterAll(async () => { await Promise.all([app?.end(), owner?.end()]); });

type Query = (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>;
async function asTenant<T>(pool: Pool, tenant: string | null, run: (query: Query) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    if (tenant !== null) await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenant]);
    const result = await run((sql, params) => client.query(sql, params as never) as never);
    await client.query("COMMIT");
    return result;
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}
const newApp = () => `app-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
/** A runtime key of `tenant`: rk- + the tenant id without dashes + - + 32 random hex. */
const newKey = (tenant: string) => `rk-${tenant.replace(/-/g, "")}-${randomBytes(16).toString("hex")}`;
interface A { registry?: string; routing?: string; access?: boolean; key?: string | null; enabled?: boolean }
const INSERT_APP = "INSERT INTO public.studio_applications (tenant_id, application_id, name, origin, allowed_origins, environment, registry_id, routing, runtime_access, runtime_key, enabled, created_by, updated_by) VALUES ($1,$2,'App','http://localhost:5184',ARRAY['http://localhost:5184'],'test',$3,$4,$5,$6,$7,'seed','seed')";
const enroll = async (tenant: string, over: A = {}): Promise<string> => {
  const id = newApp();
  await asTenant(app, tenant, (q) => q(INSERT_APP, [tenant, id, over.registry ?? "studio-managed", over.routing ?? "hash", over.access ?? false, over.key ?? null, over.enabled ?? true]));
  return id;
};
const INSERT_ROUTE = "INSERT INTO public.studio_registry_routes (tenant_id, application_id, route, page, created_by) VALUES ($1,$2,$3,$4,'maya')";
const route = (tenant: string, application: string, name: string, page: string) => asTenant(app, tenant, (q) => q(INSERT_ROUTE, [tenant, application, name, page]));

describe("the new columns, their defaults and their checks", () => {
  it("studio_applications keeps its owner, forced RLS and its exact V1A grants; the new columns default to hash, no runtime access and no key", async () => {
    await assertStateAcl(app, "studio_applications", ["SELECT", "INSERT", "UPDATE"]);
    const tenant = randomUUID();
    const id = newApp();
    await asTenant(app, tenant, (q) => q("INSERT INTO public.studio_applications (tenant_id, application_id, name, origin, allowed_origins, environment, registry_id, created_by, updated_by) VALUES ($1,$2,'A','http://localhost:1',ARRAY['http://localhost:1'],'test','reference','s','s')", [tenant, id]));
    expect((await asTenant(app, tenant, (q) => q("SELECT routing, runtime_access, runtime_key FROM public.studio_applications WHERE application_id=$1", [id]))).rows).toEqual([{ routing: "hash", runtime_access: false, runtime_key: null }]);
  });
  it("routing is hash or history only", async () => {
    const tenant = randomUUID();
    await enroll(tenant, { routing: "history" });
    for (const routing of ["History", "path", "", "hash ", "HASH"]) await expect(enroll(tenant, { routing })).rejects.toThrow(/check constraint/);
  });
  it.each([
    ["the old 32-hex format", () => `rk-${"a".repeat(32)}`], ["no prefix", (t: string) => `${t.replace(/-/g, "")}-${"a".repeat(32)}`],
    ["upper-case hex in the random part", (t: string) => `rk-${t.replace(/-/g, "")}-${"A".repeat(32)}`], ["31 random hex", (t: string) => `rk-${t.replace(/-/g, "")}-${"a".repeat(31)}`],
    ["33 random hex", (t: string) => `rk-${t.replace(/-/g, "")}-${"a".repeat(33)}`], ["a non-hex letter", (t: string) => `rk-${t.replace(/-/g, "")}-${"g".repeat(32)}`],
    ["a wrong separator", (t: string) => `rk-${t.replace(/-/g, "")}_${"a".repeat(32)}`], ["a trailing newline", (t: string) => `rk-${t.replace(/-/g, "")}-${"a".repeat(32)}\n`],
    ["the wrong prefix", (t: string) => `rj-${t.replace(/-/g, "")}-${"a".repeat(32)}`], ["a dashed tenant part", (t: string) => `rk-${t}-${"a".repeat(32)}`],
  ])("a runtime key must be rk- + tenant(32 hex) + - + 32 lower-case hex: refuses %s", async (_name, make) => {
    const tenant = randomUUID();
    await expect(enroll(tenant, { access: true, key: make(tenant) })).rejects.toThrow(/check constraint/);
  });
  it("the key's embedded tenant must be the row's OWN tenant: a well-formed key naming another tenant is refused on INSERT and on UPDATE, and the matching key is accepted", async () => {
    const [tenant, other] = [randomUUID(), randomUUID()];
    await expect(enroll(tenant, { access: true, key: newKey(other) })).rejects.toThrow(/studio_applications_runtime_key_tenant/);
    const id = await enroll(tenant, { access: true, key: newKey(tenant) });
    await expect(asTenant(app, tenant, (q) => q("UPDATE public.studio_applications SET runtime_key=$2 WHERE application_id=$1", [id, newKey(other)]))).rejects.toThrow(/studio_applications_runtime_key_tenant/);
    await asTenant(app, tenant, (q) => q("UPDATE public.studio_applications SET runtime_key=$2 WHERE application_id=$1", [id, newKey(tenant)]));
    // the case-sensitive uuid text of Postgres is lower-case; an upper-case tenant part cannot match
    await expect(enroll(tenant, { access: true, key: `rk-${tenant.replace(/-/g, "").toUpperCase()}-${"a".repeat(32)}` })).rejects.toThrow(/check constraint/);
  });
  it("a runtime key is unique across applications and tenants (null keys may repeat)", async () => {
    const tenant = randomUUID(); const key = newKey(tenant);
    await enroll(tenant, { key });
    await expect(enroll(tenant, { key })).rejects.toThrow(/duplicate key/);
    await enroll(randomUUID()); await enroll(randomUUID());
  });
  it("only a Studio-managed application may use history routing, runtime access or hold a key; runtime access needs a key", async () => {
    const tenant = randomUUID();
    await expect(enroll(tenant, { registry: "reference", routing: "history" })).rejects.toThrow(/check constraint/);
    await expect(enroll(tenant, { registry: "reference", access: true, key: newKey(tenant) })).rejects.toThrow(/check constraint/);
    await expect(enroll(tenant, { registry: "fixture", key: newKey(tenant) })).rejects.toThrow(/check constraint/);
    await expect(enroll(tenant, { access: true })).rejects.toThrow(/check constraint/);
    await enroll(tenant, { routing: "history", access: true, key: newKey(tenant) });
    await enroll(tenant, { registry: "reference" });
  });
  it("an UPDATE cannot turn a built-in application into a history or runtime application either", async () => {
    const tenant = randomUUID(); const id = await enroll(tenant, { registry: "reference" });
    await expect(asTenant(app, tenant, (q) => q("UPDATE public.studio_applications SET routing='history' WHERE application_id=$1", [id]))).rejects.toThrow(/check constraint/);
    await expect(asTenant(app, tenant, (q) => q("UPDATE public.studio_applications SET runtime_key=$2 WHERE application_id=$1", [id, newKey(tenant)]))).rejects.toThrow(/check constraint/);
  });
});

describe("routing is locked once routes exist, and the page grammar follows the routing", () => {
  it("routing can change while the application has no routes and never after the first route", async () => {
    const tenant = randomUUID(); const id = await enroll(tenant);
    await asTenant(app, tenant, (q) => q("UPDATE public.studio_applications SET routing='history' WHERE application_id=$1", [id]));
    await route(tenant, id, "home", "/");
    await expect(asTenant(app, tenant, (q) => q("UPDATE public.studio_applications SET routing='hash' WHERE application_id=$1", [id]))).rejects.toThrow(/studio_applications_routing_locked/);
    // other columns still change, and re-sending the same routing is fine
    await asTenant(app, tenant, (q) => q("UPDATE public.studio_applications SET name='Renamed', routing='history' WHERE application_id=$1", [id]));
  });
  it("a hash application keeps the V1B page grammar (and refuses history pages); a history application takes pathnames and refuses hash pages", async () => {
    const tenant = randomUUID();
    const hash = await enroll(tenant); const history = await enroll(tenant, { routing: "history" });
    await route(tenant, hash, "home", "/");
    await route(tenant, hash, "orders", "/#/orders");
    await expect(route(tenant, hash, "users", "/users/123")).rejects.toThrow(/check constraint/);
    await expect(route(tenant, hash, "long", `/#/${"a".repeat(118)}`)).rejects.toThrow(/check constraint/);
    await route(tenant, history, "home", "/");
    await route(tenant, history, "users123", "/users/123");
    await route(tenant, history, "nested", "/a/b-c/d.e_f~g");
    await route(tenant, history, "longest", `/${"a".repeat(199)}`);
    await expect(route(tenant, history, "hashy", "/#/orders")).rejects.toThrow(/check constraint/);
  });
  it.each([
    ["a trailing slash", "/users/"], ["a query", "/users?x=1"], ["a fragment", "/users#x"], ["a double slash", "/a//b"], ["a dot segment", "/a/./b"], ["a parent segment", "/a/../b"], ["a leading parent segment", "/../a"],
    ["a space", "/a b"], ["a percent escape", "/a%20b"], ["no leading slash", "users"], ["an empty page", ""], ["a URL", "https://x.example/users"], ["201 characters", `/${"a".repeat(200)}`],
    ["a backslash", "/a\\b"], ["a colon", "/a:b"], ["a non-ASCII letter", "/café"], ["a newline", "/a\nb"], ["a dot only segment at the end", "/a/.."],
  ])("a history application refuses a page with %s", async (_name, page) => {
    const tenant = randomUUID(); const id = await enroll(tenant, { routing: "history" });
    await expect(route(tenant, id, "bad", page)).rejects.toThrow(/check constraint/);
  });
  it("a route can never be inserted for an unknown application or by the wrong tenant (grammar trigger and foreign key agree)", async () => {
    const tenant = randomUUID();
    await expect(route(tenant, newApp(), "home", "/")).rejects.toThrow(/check constraint|foreign key/);
  });
  it("the replaced hash-only CHECK is gone and the routing-neutral shape CHECK is in place", async () => {
    const names = (await app.query("SELECT conname FROM pg_constraint WHERE conrelid='public.studio_registry_routes'::regclass AND contype='c' ORDER BY conname")).rows.map((row) => row.conname);
    expect(names).not.toContain("studio_registry_routes_page_check");
    expect(names).toContain("studio_registry_routes_page_shape");
    expect(((await app.query("SELECT tgname FROM pg_trigger WHERE tgrelid='public.studio_registry_routes'::regclass AND NOT tgisinternal ORDER BY tgname")).rows).map((row) => row.tgname)).toContain("studio_registry_routes_page_grammar");
  });
  it("a route insert and a routing change racing for one application cannot both succeed: the share lock serialises them", async () => {
    const tenant = randomUUID(); const id = await enroll(tenant);
    const insert = await app.connect(); const change = await app.connect();
    try {
      await insert.query("BEGIN"); await insert.query("SELECT set_config('app.tenant_id', $1, true)", [tenant]);
      await insert.query(INSERT_ROUTE, [tenant, id, "orders", "/#/orders"]); // holds a share lock on the application row, uncommitted
      await change.query("BEGIN"); await change.query("SELECT set_config('app.tenant_id', $1, true)", [tenant]);
      const update = change.query("UPDATE public.studio_applications SET routing='history' WHERE application_id=$1", [id]).then(() => "updated", (error: Error) => `refused: ${error.message}`);
      const early = await Promise.race([update, new Promise((resolve) => setTimeout(() => resolve("waiting"), 400))]);
      expect(early, "the update waits for the route insert's transaction").toBe("waiting");
      await insert.query("COMMIT");
      expect(await update).toMatch(/studio_applications_routing_locked/);
    } finally { await insert.query("ROLLBACK").catch(() => {}); await change.query("ROLLBACK").catch(() => {}); insert.release(); change.release(); }
  });
});

describe("no cross-tenant lookup exists: the runtime key is read inside its own tenant, by row-level security alone", () => {
  const find = (tenant: string, key: string) => asTenant(app, tenant, (q) => q(
    "SELECT application_id FROM public.studio_applications WHERE tenant_id = $1::uuid AND runtime_key = $2 AND runtime_access AND enabled AND registry_id = 'studio-managed'", [tenant, key]));
  it("a key resolves only inside the tenant it names; the same key read from any other tenant, or from no tenant, finds nothing, even when the query asks for the other tenant explicitly", async () => {
    const [ta, tb] = [randomUUID(), randomUUID()]; const key = newKey(ta);
    const id = await enroll(ta, { access: true, key });
    expect((await find(ta, key)).rows).toEqual([{ application_id: id }]);
    expect((await find(tb, key)).rows).toEqual([]);
    expect((await asTenant(app, tb, (q) => q("SELECT application_id FROM public.studio_applications WHERE tenant_id = $1::uuid AND runtime_key = $2", [ta, key]))).rows).toEqual([]);
    expect((await asTenant(app, tb, (q) => q("SELECT application_id FROM public.studio_applications WHERE runtime_key = $1", [key]))).rows).toEqual([]);
    expect((await app.query("SELECT application_id FROM public.studio_applications WHERE runtime_key = $1", [key])).rows).toEqual([]);
  });
  it("a key whose tenant part names another tenant can never be stored, so it can never resolve: swapping the tenant part of a live key finds nothing in either tenant", async () => {
    const [ta, tb] = [randomUUID(), randomUUID()]; const key = newKey(ta);
    await enroll(ta, { access: true, key }); await enroll(tb, { access: true, key: newKey(tb) });
    const swapped = `rk-${tb.replace(/-/g, "")}-${key.slice(-32)}`;
    expect((await find(tb, swapped)).rows).toEqual([]);
    expect((await find(ta, swapped)).rows).toEqual([]);
  });
  it("the state follows the live row: disabling, access off and rotation change what resolves; re-enabling restores the SAME key", async () => {
    const tenant = randomUUID(); const key = newKey(tenant);
    const id = await enroll(tenant, { access: true, key });
    expect((await find(tenant, key)).rows).toHaveLength(1);
    await asTenant(app, tenant, (q) => q("UPDATE public.studio_applications SET enabled=false WHERE application_id=$1", [id]));
    expect((await find(tenant, key)).rows).toEqual([]);
    await asTenant(app, tenant, (q) => q("UPDATE public.studio_applications SET enabled=true, runtime_access=false WHERE application_id=$1", [id]));
    expect((await find(tenant, key)).rows).toEqual([]);
    await asTenant(app, tenant, (q) => q("UPDATE public.studio_applications SET runtime_access=true WHERE application_id=$1", [id]));
    expect((await find(tenant, key)).rows).toHaveLength(1);
    const fresh = newKey(tenant);
    await asTenant(app, tenant, (q) => q("UPDATE public.studio_applications SET runtime_key=$2 WHERE application_id=$1", [id, fresh]));
    expect((await find(tenant, key)).rows).toEqual([]);
    expect((await find(tenant, fresh)).rows).toEqual([{ application_id: id }]);
  });
  it("defines NO SECURITY DEFINER function in public (the Feature 001 conformance query is empty), no studio_runtime_application, and no policy beyond the tenant isolation one", async () => {
    expect((await app.query("SELECT proname FROM pg_proc WHERE prosecdef AND pronamespace='public'::regnamespace")).rows).toEqual([]);
    expect((await app.query("SELECT proname FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname = 'studio_runtime_application'")).rows).toEqual([]);
    expect((await app.query("SELECT polname, polroles::text AS roles, polcmd FROM pg_policy WHERE polrelid='public.studio_applications'::regclass")).rows).toEqual([{ polname: "tenant_isolation", roles: "{0}", polcmd: "*" }]);
    expect((await app.query("SELECT polname FROM pg_policy WHERE polrelid='public.studio_registry_routes'::regclass AND polname <> 'tenant_isolation'")).rows).toEqual([]);
  });
  it("widens no grant: dap_app keeps exactly SELECT, INSERT, UPDATE on studio_applications, and the migration's functions are trigger functions that nobody but their owner may call", async () => {
    await assertStateAcl(app, "studio_applications", ["SELECT", "INSERT", "UPDATE"]);
    const rows = (await app.query("SELECT proname, prosecdef, prorettype::regtype::text AS ret FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN ('studio_page_valid','studio_registry_routes_page_grammar','studio_applications_routing_locked') ORDER BY proname")).rows;
    expect(rows).toEqual([
      { proname: "studio_applications_routing_locked", prosecdef: false, ret: "trigger" }, { proname: "studio_page_valid", prosecdef: false, ret: "boolean" }, { proname: "studio_registry_routes_page_grammar", prosecdef: false, ret: "trigger" },
    ]);
    for (const fn of ["public.studio_registry_routes_page_grammar()", "public.studio_applications_routing_locked()"]) {
      expect((await app.query("SELECT has_function_privilege('public', $1, 'EXECUTE') AS ok", [fn])).rows).toEqual([{ ok: false }]);
    }
    expect((await app.query("SELECT has_function_privilege('public', 'public.studio_page_valid(text,text)', 'EXECUTE') AS ok")).rows).toEqual([{ ok: false }]);
  });
});

describe("the migration is idempotent and 072-075 are untouched", () => {
  it("replays cleanly twice as dap_owner and leaves the same definitions", async () => {
    const sql = await readFile(MIGRATION, "utf8");
    const snapshot = async () => (await owner.query("SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid IN ('public.studio_applications'::regclass,'public.studio_registry_routes'::regclass) ORDER BY conname")).rows;
    const before = await snapshot();
    await owner.query(sql); await owner.query(sql);
    expect(await snapshot()).toEqual(before);
    expect((await owner.query("SELECT count(*)::int AS n FROM pg_policy WHERE polrelid='public.studio_applications'::regclass")).rows).toEqual([{ n: 1 }]);
    expect((await owner.query("SELECT count(*)::int AS n FROM pg_trigger WHERE tgrelid='public.studio_registry_routes'::regclass AND tgname='studio_registry_routes_page_grammar'")).rows).toEqual([{ n: 1 }]);
  });
  it("refuses to run as anyone but dap_owner", async () => {
    const sql = await readFile(MIGRATION, "utf8");
    await expect(app.query(sql)).rejects.toThrow(/requires dap_owner/);
  });
});
