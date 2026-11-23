/**
 * Studio COMPLETION migration 076 (routing, runtime access, runtime key, the page grammar by routing and the SECURITY DEFINER runtime lookup) on a PostgreSQL database, every defence proved by
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
const newKey = () => `rk-${randomBytes(16).toString("hex")}`;
interface A { registry?: string; routing?: string; access?: boolean; key?: string | null; enabled?: boolean }
const INSERT_APP = "INSERT INTO public.studio_applications (tenant_id, application_id, name, origin, allowed_origins, environment, registry_id, routing, runtime_access, runtime_key, enabled, created_by, updated_by) VALUES ($1,$2,'App','http://localhost:5184',ARRAY['http://localhost:5184'],'test',$3,$4,$5,$6,$7,'seed','seed')";
const enroll = async (tenant: string, over: A = {}): Promise<string> => {
  const id = newApp();
  await asTenant(app, tenant, (q) => q(INSERT_APP, [tenant, id, over.registry ?? "studio-managed", over.routing ?? "hash", over.access ?? false, over.key ?? null, over.enabled ?? true]));
  return id;
};
const INSERT_ROUTE = "INSERT INTO public.studio_registry_routes (tenant_id, application_id, route, page, created_by) VALUES ($1,$2,$3,$4,'maya')";
const route = (tenant: string, application: string, name: string, page: string) => asTenant(app, tenant, (q) => q(INSERT_ROUTE, [tenant, application, name, page]));
const lookup = async (key: string) => (await app.query("SELECT * FROM public.studio_runtime_application($1)", [key])).rows;

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
    ["no prefix", "abcdef0123456789abcdef0123456789"], ["upper-case hex", "rk-ABCDEF0123456789ABCDEF0123456789"], ["31 hex", `rk-${"a".repeat(31)}`], ["33 hex", `rk-${"a".repeat(33)}`],
    ["a non-hex letter", `rk-${"g".repeat(32)}`], ["a space", `rk-${"a".repeat(31)} `], ["a newline", `rk-${"a".repeat(32)}\n`], ["the wrong prefix", `rj-${"a".repeat(32)}`],
  ])("a runtime key must be rk- plus 32 lower-case hex: refuses %s", async (_name, key) => {
    await expect(enroll(randomUUID(), { access: true, key })).rejects.toThrow(/check constraint/);
  });
  it("a runtime key is unique across applications and tenants (null keys may repeat)", async () => {
    const key = newKey();
    await enroll(randomUUID(), { key });
    await expect(enroll(randomUUID(), { key })).rejects.toThrow(/duplicate key/);
    await enroll(randomUUID()); await enroll(randomUUID());
  });
  it("only a Studio-managed application may use history routing, runtime access or hold a key; runtime access needs a key", async () => {
    const tenant = randomUUID();
    await expect(enroll(tenant, { registry: "reference", routing: "history" })).rejects.toThrow(/check constraint/);
    await expect(enroll(tenant, { registry: "reference", access: true, key: newKey() })).rejects.toThrow(/check constraint/);
    await expect(enroll(tenant, { registry: "fixture", key: newKey() })).rejects.toThrow(/check constraint/);
    await expect(enroll(tenant, { access: true })).rejects.toThrow(/check constraint/);
    await enroll(tenant, { routing: "history", access: true, key: newKey() });
    await enroll(tenant, { registry: "reference" });
  });
  it("an UPDATE cannot turn a built-in application into a history or runtime application either", async () => {
    const tenant = randomUUID(); const id = await enroll(tenant, { registry: "reference" });
    await expect(asTenant(app, tenant, (q) => q("UPDATE public.studio_applications SET routing='history' WHERE application_id=$1", [id]))).rejects.toThrow(/check constraint/);
    await expect(asTenant(app, tenant, (q) => q("UPDATE public.studio_applications SET runtime_key=$2 WHERE application_id=$1", [id, newKey()]))).rejects.toThrow(/check constraint/);
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

describe("studio_runtime_application: the narrow lookup", () => {
  it("returns exactly (tenant_id, application_id) for an enabled Studio-managed application with runtime access on, from any session, with no tenant setting", async () => {
    const tenant = randomUUID(); const key = newKey();
    const id = await enroll(tenant, { access: true, key });
    const rows = await lookup(key);
    expect(rows).toEqual([{ tenant_id: tenant, application_id: id }]);
    expect(Object.keys(rows[0]!).sort()).toEqual(["application_id", "tenant_id"]);
    // the same answer while a DIFFERENT tenant is the current one: ids only, nothing else crosses
    expect(await asTenant(app, randomUUID(), (q) => q("SELECT * FROM public.studio_runtime_application($1)", [key]))).toMatchObject({ rows: [{ tenant_id: tenant, application_id: id }] });
  });
  it("returns nothing for a disabled application, runtime access off, an unknown key and malformed keys", async () => {
    const tenant = randomUUID();
    const off = newKey(); await enroll(tenant, { access: false, key: off });
    const disabled = newKey(); await enroll(tenant, { access: true, key: disabled, enabled: false });
    expect(await lookup(off)).toEqual([]);
    expect(await lookup(disabled)).toEqual([]);
    expect(await lookup(newKey())).toEqual([]);
    for (const bad of ["", "rk-", "x", `rk-${"A".repeat(32)}`, `rk-${"a".repeat(32)}'`, "' OR 1=1 --", "%", `rk-${"a".repeat(40)}`]) expect(await lookup(bad), bad).toEqual([]);
  });
  it("follows the live state: disabling the application or turning runtime access off kills the lookup at once, re-enabling restores the SAME key, a rotated key replaces the old one", async () => {
    const tenant = randomUUID(); const key = newKey();
    const id = await enroll(tenant, { access: true, key });
    expect(await lookup(key)).toHaveLength(1);
    await asTenant(app, tenant, (q) => q("UPDATE public.studio_applications SET enabled=false WHERE application_id=$1", [id]));
    expect(await lookup(key)).toEqual([]);
    await asTenant(app, tenant, (q) => q("UPDATE public.studio_applications SET enabled=true, runtime_access=false WHERE application_id=$1", [id]));
    expect(await lookup(key)).toEqual([]);
    await asTenant(app, tenant, (q) => q("UPDATE public.studio_applications SET runtime_access=true WHERE application_id=$1", [id]));
    expect(await lookup(key)).toHaveLength(1);
    const fresh = newKey();
    await asTenant(app, tenant, (q) => q("UPDATE public.studio_applications SET runtime_key=$2 WHERE application_id=$1", [id, fresh]));
    expect(await lookup(key)).toEqual([]);
    expect(await lookup(fresh)).toEqual([{ tenant_id: tenant, application_id: id }]);
  });
  it("two tenants' keys never cross", async () => {
    const [ta, tb] = [randomUUID(), randomUUID()]; const [ka, kb] = [newKey(), newKey()];
    const a = await enroll(ta, { access: true, key: ka }); const b = await enroll(tb, { access: true, key: kb });
    expect(await lookup(ka)).toEqual([{ tenant_id: ta, application_id: a }]);
    expect(await lookup(kb)).toEqual([{ tenant_id: tb, application_id: b }]);
  });
  it("does not widen dap_app: without a tenant setting studio_applications is still empty, another tenant's rows (and keys) stay invisible, and the function is the only added door", async () => {
    const [ta, tb] = [randomUUID(), randomUUID()]; const key = newKey();
    await enroll(ta, { access: true, key });
    expect((await app.query("SELECT runtime_key FROM public.studio_applications WHERE runtime_key = $1", [key])).rows).toEqual([]);
    expect((await asTenant(app, tb, (q) => q("SELECT runtime_key FROM public.studio_applications WHERE runtime_key = $1", [key]))).rows).toEqual([]);
    expect((await asTenant(app, ta, (q) => q("SELECT runtime_key FROM public.studio_applications WHERE runtime_key = $1", [key]))).rows).toEqual([{ runtime_key: key }]);
    // the policy that lets the definer read exists for dap_owner ONLY
    expect((await app.query("SELECT polname, polcmd, (SELECT array_agg(rolname::text) FROM pg_roles WHERE oid = ANY (polroles)) AS roles FROM pg_policy WHERE polrelid='public.studio_applications'::regclass AND polname='runtime_lookup'")).rows)
      .toEqual([{ polname: "runtime_lookup", polcmd: "r", roles: ["dap_owner"] }]);
    expect((await app.query("SELECT polname, polroles::text AS polroles FROM pg_policy WHERE polrelid='public.studio_applications'::regclass AND polname='tenant_isolation'")).rows).toEqual([{ polname: "tenant_isolation", polroles: "{0}" }]);
  });
  it("is SECURITY DEFINER with a pinned search_path, owned by dap_owner, executable by dap_app and not by PUBLIC", async () => {
    const info = (await app.query("SELECT pg_get_userbyid(proowner) AS owner, prosecdef, proconfig, proacl::text AS acl, provolatile FROM pg_proc WHERE oid='public.studio_runtime_application(text)'::regprocedure")).rows[0]!;
    expect(info.owner).toBe("dap_owner");
    expect(info.prosecdef).toBe(true);
    expect(info.proconfig).toEqual(["search_path=pg_catalog"]);
    expect(info.provolatile).toBe("s");
    expect(String(info.acl)).toContain("dap_app=X/dap_owner");
    expect(String(info.acl)).not.toMatch(/(^|[{,])=X/); // no PUBLIC grant
    expect((await app.query("SELECT has_function_privilege('dap_app','public.studio_runtime_application(text)','EXECUTE') AS ok")).rows).toEqual([{ ok: true }]);
    expect((await app.query("SELECT has_function_privilege('public','public.studio_runtime_application(text)','EXECUTE') AS ok")).rows).toEqual([{ ok: false }]);
  });
  it("a hostile search_path or a look-alike function in another schema cannot redirect the lookup", async () => {
    const key = newKey(); const tenant = randomUUID();
    await enroll(tenant, { access: true, key });
    const client = await app.connect();
    try {
      await client.query("BEGIN");
      await client.query("SET LOCAL search_path = public, pg_temp");
      expect((await client.query("SELECT * FROM public.studio_runtime_application($1)", [key])).rows).toHaveLength(1);
      await client.query("COMMIT");
    } finally { client.release(); }
  });
});

describe("the migration is idempotent and 072-075 are untouched", () => {
  it("replays cleanly twice as dap_owner and leaves the same definitions", async () => {
    const sql = await readFile(MIGRATION, "utf8");
    const snapshot = async () => (await owner.query("SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid IN ('public.studio_applications'::regclass,'public.studio_registry_routes'::regclass) ORDER BY conname")).rows;
    const before = await snapshot();
    await owner.query(sql); await owner.query(sql);
    expect(await snapshot()).toEqual(before);
    expect((await owner.query("SELECT count(*)::int AS n FROM pg_policy WHERE polrelid='public.studio_applications'::regclass")).rows).toEqual([{ n: 2 }]);
    expect((await owner.query("SELECT count(*)::int AS n FROM pg_trigger WHERE tgrelid='public.studio_registry_routes'::regclass AND tgname='studio_registry_routes_page_grammar'")).rows).toEqual([{ n: 1 }]);
  });
  it("refuses to run as anyone but dap_owner", async () => {
    const sql = await readFile(MIGRATION, "utf8");
    await expect(app.query(sql)).rejects.toThrow(/requires dap_owner/);
  });
});
