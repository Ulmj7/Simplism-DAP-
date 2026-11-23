/**
 * Studio V1B migration 074 (`studio_registry_routes`, `studio_registry_targets`) on a FRESH PostgreSQL database, every defence proved by DIRECT SQL as dap_app (DAP_DATABASE_URL) with dap_owner
 * (DAP_MIGRATE_DATABASE_URL) only for fixtures that dap_app may not create: ownership, forced RLS and the exact grants (no DELETE, no TRUNCATE); tenant isolation incl. cross-tenant writes; the
 * composite foreign keys (a built-in application or another tenant's application can never own a route or target; a managed application cannot be re-pointed); every shape CHECK; the
 * 20-route and 200-target caps UNDER CONCURRENCY; the immutability triggers; idempotence.
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { assertStateAcl, openStatePools } from "../../packages/security/src/state/conformance/state-pg-fixtures.js";

const MIGRATION = new URL("../../db/migrations/074_studio_registry.sql", import.meta.url);
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
const INSERT_APP = "INSERT INTO public.studio_applications (tenant_id, application_id, name, origin, allowed_origins, environment, registry_id, created_by, updated_by) VALUES ($1,$2,'App','http://localhost:5184',ARRAY['http://localhost:5184'],'test',$3,'seed','seed')";
const enroll = (tenant: string, registry = "studio-managed") => { const id = newApp(); return asTenant(app, tenant, (q) => q(INSERT_APP, [tenant, id, registry])).then(() => id); };
const INSERT_ROUTE = "INSERT INTO public.studio_registry_routes (tenant_id, application_id, route, page, created_by) VALUES ($1,$2,$3,$4,'maya')";
const route = (tenant: string, application: string, name = "orders", page = "/#/orders") => asTenant(app, tenant, (q) => q(INSERT_ROUTE, [tenant, application, name, page]));
interface T { id?: string; route?: string; role?: string; label?: string; description?: string; operations?: string[]; privacy?: string; status?: string; actor?: string }
const INSERT_TARGET = "INSERT INTO public.studio_registry_targets (tenant_id, application_id, target_id, route, role, label, description, operations, privacy, status, created_by, updated_by) VALUES ($1,$2,$3,$4,$5,$6,$7,$8::text[],$9,$10,$11,$11)";
const target = (tenant: string, application: string, over: T = {}) => asTenant(app, tenant, (q) => q(INSERT_TARGET, [
  tenant, application, over.id ?? "orders.submit", over.route ?? "orders", over.role ?? "button", over.label ?? "Submit", over.description ?? "Submits", over.operations ?? ["highlight", "click"], over.privacy ?? "public", over.status ?? "active", over.actor ?? "maya"]));
/** A managed application with the route `orders` already registered. */
async function ready(): Promise<{ tenant: string; id: string }> { const tenant = randomUUID(); const id = await enroll(tenant); await route(tenant, id); return { tenant, id }; }

describe("ownership, row-level security and grants", () => {
  it("both tables are owned by dap_owner with forced RLS; targets grant SELECT, INSERT, UPDATE, routes only SELECT, INSERT; nothing for PUBLIC; no DELETE, no TRUNCATE", async () => {
    await assertStateAcl(app, "studio_registry_targets", ["SELECT", "INSERT", "UPDATE"]);
    await assertStateAcl(app, "studio_registry_routes", ["SELECT", "INSERT"]);
  });
  it("has the planned columns and primary keys", async () => {
    const columns = (table: string) => app.query("SELECT column_name, is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name=$1 ORDER BY ordinal_position", [table]);
    expect((await columns("studio_registry_routes")).rows.map((row) => row.column_name)).toEqual(["tenant_id", "application_id", "registry_id", "route", "page", "created_by", "created_at"]);
    expect((await columns("studio_registry_targets")).rows.map((row) => row.column_name)).toEqual(
      ["tenant_id", "application_id", "registry_id", "target_id", "route", "role", "label", "description", "operations", "privacy", "status", "created_by", "created_at", "updated_by", "updated_at"]);
    const keys = (table: string) => app.query("SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid=$1::regclass AND contype IN ('p','u','f') ORDER BY conname", [`public.${table}`]);
    expect((await keys("studio_registry_targets")).rows.map((row) => row.def)).toEqual([
      "FOREIGN KEY (tenant_id, application_id, registry_id) REFERENCES studio_applications(tenant_id, application_id, registry_id)",
      "PRIMARY KEY (tenant_id, application_id, target_id)",
      "FOREIGN KEY (tenant_id, application_id, route) REFERENCES studio_registry_routes(tenant_id, application_id, route)",
    ]);
    expect((await keys("studio_registry_routes")).rows.map((row) => row.def)).toEqual([
      "FOREIGN KEY (tenant_id, application_id, registry_id) REFERENCES studio_applications(tenant_id, application_id, registry_id)",
      "UNIQUE (tenant_id, application_id, page)",
      "PRIMARY KEY (tenant_id, application_id, route)",
    ]);
  });
  it("tenants are isolated: rows of A are invisible in B and without a tenant setting both tables are empty", async () => {
    const { tenant, id } = await ready();
    await target(tenant, id);
    const other = randomUUID();
    for (const table of ["studio_registry_routes", "studio_registry_targets"]) {
      expect((await asTenant(app, tenant, (q) => q(`SELECT 1 FROM public.${table}`))).rows.length).toBeGreaterThan(0);
      expect((await asTenant(app, other, (q) => q(`SELECT 1 FROM public.${table}`))).rows).toHaveLength(0);
      expect((await app.query(`SELECT 1 FROM public.${table}`)).rows).toHaveLength(0);
    }
  });
  it("a tenant cannot write a row of another tenant (WITH CHECK) nor update one (USING)", async () => {
    const a = await ready(); const b = await ready();
    await target(a.tenant, a.id);
    await expect(asTenant(app, b.tenant, (q) => q(INSERT_ROUTE, [a.tenant, a.id, "other", "/#/other"]))).rejects.toThrow(/row-level security/);
    await expect(asTenant(app, b.tenant, (q) => q(INSERT_TARGET, [a.tenant, a.id, "x.y", "orders", "button", "L", "D", ["highlight"], "public", "active", "m"]))).rejects.toThrow(/row-level security/);
    expect((await asTenant(app, b.tenant, (q) => q("UPDATE public.studio_registry_targets SET status='disabled' WHERE application_id=$1", [a.id]))).rowCount).toBe(0);
    expect((await asTenant(app, a.tenant, (q) => q("SELECT status FROM public.studio_registry_targets WHERE application_id=$1", [a.id]))).rows).toEqual([{ status: "active" }]);
  });
  it("dap_app can neither DELETE nor TRUNCATE either table", async () => {
    const { tenant, id } = await ready();
    await target(tenant, id);
    for (const table of ["studio_registry_routes", "studio_registry_targets"]) {
      await expect(asTenant(app, tenant, (q) => q(`DELETE FROM public.${table}`))).rejects.toThrow(/permission denied/);
      await expect(app.query(`TRUNCATE public.${table}`)).rejects.toThrow(/permission denied/);
    }
  });
  it("even the owner cannot delete a route that a target references, or an application that has routes (no cascade)", async () => {
    const { tenant, id } = await ready();
    await target(tenant, id);
    await expect(asTenant(owner, tenant, (q) => q("DELETE FROM public.studio_registry_routes WHERE application_id=$1", [id]))).rejects.toThrow(/foreign key/);
    await expect(asTenant(owner, tenant, (q) => q("DELETE FROM public.studio_applications WHERE application_id=$1", [id]))).rejects.toThrow(/foreign key/);
  });
});

describe("the wrong registry and the wrong tenant (foreign keys)", () => {
  it("a built-in application cannot own a route or a target: the insert is refused by the database", async () => {
    const tenant = randomUUID();
    const builtIn = await enroll(tenant, "reference");
    await expect(route(tenant, builtIn)).rejects.toThrow(/foreign key/);
    await expect(target(tenant, builtIn)).rejects.toThrow(/foreign key/);
    // Naming another registry id in the row is refused by the CHECK before any key is consulted.
    await expect(asTenant(app, tenant, (q) => q("INSERT INTO public.studio_registry_routes (tenant_id, application_id, registry_id, route, page, created_by) VALUES ($1,$2,'reference','orders','/#/orders','m')", [tenant, builtIn]))).rejects.toThrow(/check constraint/);
    await expect(asTenant(app, tenant, (q) => q("INSERT INTO public.studio_registry_targets (tenant_id, application_id, registry_id, target_id, route, role, label, description, operations, privacy, created_by, updated_by) VALUES ($1,$2,'reference','a.b','orders','button','L','D',ARRAY['highlight'],'public','m','m')", [tenant, builtIn]))).rejects.toThrow(/check constraint/);
  });
  it("an unknown application, another tenant's application and a route that does not exist are refused", async () => {
    const a = await ready(); const b = await ready();
    await expect(route(a.tenant, newApp())).rejects.toThrow(/foreign key/);
    await expect(route(b.tenant, a.id, "orders2", "/#/orders2")).rejects.toThrow(/foreign key/); // tenant B writing A's application id
    await expect(target(a.tenant, a.id, { route: "missing" })).rejects.toThrow(/foreign key/);
  });
  it("a managed application cannot be re-pointed at another registry while it has routes or targets, and the re-pointing is possible only when empty", async () => {
    const { tenant, id } = await ready();
    await expect(asTenant(app, tenant, (q) => q("UPDATE public.studio_applications SET registry_id='reference' WHERE application_id=$1", [id]))).rejects.toThrow(/foreign key/);
    const empty = await enroll(tenant);
    await asTenant(app, tenant, (q) => q("UPDATE public.studio_applications SET registry_id='reference' WHERE application_id=$1", [empty]));
  });
});

describe("route checks", () => {
  it.each([
    ["an empty route", "", "/#/x"], ["an upper-case first letter", "Orders", "/#/x"], ["a hyphen", "order-list", "/#/x"], ["a dot", "orders.list", "/#/x"], ["41 characters", `a${"b".repeat(40)}`, "/#/x"], ["a digit first", "1a", "/#/x"],
    ["a page without a slash", "orders", "#/orders"], ["a page with a query", "orders", "/#/orders?x=1"], ["a page with a path", "orders", "/app/#/orders"], ["an empty hash route", "orders", "/#/"], ["a page with spaces", "orders", "/#/or ders"],
    ["a page that is a URL", "orders", "https://x.example/#/orders"], ["a page over 120 characters", "orders", `/#/${"a".repeat(119)}`], ["a double slash", "orders", "/#//orders"], ["a trailing slash", "orders", "/#/orders/"],
  ])("refuses %s", async (_name, name, page) => {
    const tenant = randomUUID(); const id = await enroll(tenant);
    await expect(route(tenant, id, name, page)).rejects.toThrow(/check constraint/);
  });
  it("accepts the home page, nested pages and the longest route and page", async () => {
    const tenant = randomUUID(); const id = await enroll(tenant);
    await route(tenant, id, "home", "/");
    await route(tenant, id, "nested", "/#/a/b-c/d.e_f~g");
    await route(tenant, id, `a${"b".repeat(39)}`, `/#/${"a".repeat(117)}`);
    expect((await asTenant(app, tenant, (q) => q("SELECT route FROM public.studio_registry_routes WHERE application_id=$1", [id]))).rows).toHaveLength(3);
  });
  it("a route name and a page are each unique per application (and may repeat in another application)", async () => {
    const { tenant, id } = await ready();
    await expect(route(tenant, id, "orders", "/#/other")).rejects.toThrow(/duplicate key/);
    await expect(route(tenant, id, "other", "/#/orders")).rejects.toThrow(/duplicate key/);
    const second = await enroll(tenant);
    await route(tenant, second);
  });
  it("a route row cannot be changed by anyone: dap_app has no UPDATE grant and the trigger refuses even the owner", async () => {
    const { tenant, id } = await ready();
    await expect(asTenant(app, tenant, (q) => q("UPDATE public.studio_registry_routes SET page='/#/moved' WHERE application_id=$1", [id]))).rejects.toThrow(/permission denied/);
    await expect(asTenant(owner, tenant, (q) => q("UPDATE public.studio_registry_routes SET page='/#/moved' WHERE application_id=$1", [id]))).rejects.toThrow(/cannot be changed/);
  });
});

describe("target checks", () => {
  it.each([
    ["an id without a dot", { id: "submit" }], ["an upper-case id", { id: "Orders.submit" }], ["an id with a hyphen", { id: "orders.submit-it" }], ["an 81-character id", { id: `orders.${"a".repeat(74)}` }],
    ["a reserved first segment dap", { id: "dap.submit" }], ["studio", { id: "studio.submit" }], ["admin", { id: "admin.submit" }], ["system", { id: "system.submit" }], ["internal", { id: "internal.submit" }],
    ["an unregistrable role (panel)", { role: "panel" }], ["an unregistrable role (heading)", { role: "heading" }], ["an unknown role", { role: "slider" }],
    ["no operations", { operations: [] as string[] }], ["operations without highlight", { operations: ["click"] }], ["click on a textbox", { role: "textbox", operations: ["highlight", "click"] }],
    ["input on a button", { operations: ["highlight", "input"] }], ["an unknown operation", { operations: ["highlight", "drag"] }], ["four operations", { operations: ["highlight", "click", "input", "focus"] }],
    ["private privacy", { privacy: "private" }], ["redact privacy", { privacy: "redact" }], ["an empty privacy", { privacy: "" }],
    ["an empty label", { label: "" }], ["a blank label", { label: "   " }], ["a label with markup", { label: "a<b" }], ["a label with a quote", { label: "it's" }], ["a label with an ampersand", { label: "a&b" }],
    ["a label with a backtick", { label: "a`b" }], ["a label over 80 characters", { label: "x".repeat(81) }], ["an empty description", { description: "" }], ["a description with markup", { description: "<b>x</b>" }],
    ["a description over 240 characters", { description: "x".repeat(241) }], ["an unknown status", { status: "deleted" }], ["an empty actor", { actor: "" }], ["an oversize actor", { actor: "a".repeat(257) }],
  ] as const)("the database refuses %s", async (_name, over) => {
    const { tenant, id } = await ready();
    await expect(target(tenant, id, over as T)).rejects.toThrow(/check constraint/);
  });
  it("accepts every registrable role with its allowed operations, the longest id, label and description", async () => {
    const { tenant, id } = await ready();
    await target(tenant, id, { id: "a.button", role: "button", operations: ["highlight", "click", "focus"] });
    await target(tenant, id, { id: "a.link", role: "link", operations: ["highlight"] });
    await target(tenant, id, { id: "a.checkbox", role: "checkbox", operations: ["highlight", "focus"] });
    await target(tenant, id, { id: "a.select", role: "select", operations: ["highlight", "click"] });
    await target(tenant, id, { id: "a.textbox", role: "textbox", operations: ["highlight", "input", "focus"] });
    await target(tenant, id, { id: `orders.${"a".repeat(73)}`, label: "x".repeat(80), description: "y".repeat(240) });
    await target(tenant, id, { id: "studioOrders.submit" }); // only the exact first segment is reserved
    expect((await asTenant(app, tenant, (q) => q("SELECT target_id FROM public.studio_registry_targets WHERE application_id=$1", [id]))).rows).toHaveLength(7);
  });
  it("a target id is unique per application and may repeat in another (separate registries)", async () => {
    const { tenant, id } = await ready();
    await target(tenant, id);
    await expect(target(tenant, id)).rejects.toThrow(/duplicate key/);
    const second = await enroll(tenant);
    await route(tenant, second);
    await target(tenant, second);
  });
});

describe("immutability: only the status of a target can change", () => {
  const change = (set: string, params: unknown[] = []) => async () => {
    const { tenant, id } = await ready();
    await target(tenant, id);
    return asTenant(app, tenant, (q) => q(`UPDATE public.studio_registry_targets SET ${set} WHERE application_id = $1`, [id, ...params]));
  };
  it.each([
    ["label", "label = 'Other'"], ["description", "description = 'Other'"], ["role", "role = 'link'"], ["operations", "operations = ARRAY['highlight']"],
    ["target_id", "target_id = 'orders.other'"], ["created_by", "created_by = 'mallory'"], ["created_at", "created_at = now() - interval '1 day'"],
  ])("refuses a change of %s", async (_column, set) => {
    await expect(change(set)()).rejects.toThrow(/cannot be changed, only enabled or disabled/);
  });
  it("refuses moving a target to another route and re-targeting its application", async () => {
    const { tenant, id } = await ready();
    await route(tenant, id, "home", "/");
    await target(tenant, id);
    await expect(asTenant(app, tenant, (q) => q("UPDATE public.studio_registry_targets SET route='home' WHERE application_id=$1", [id]))).rejects.toThrow(/cannot be changed/);
    const other = await enroll(tenant);
    await expect(asTenant(app, tenant, (q) => q("UPDATE public.studio_registry_targets SET application_id=$2 WHERE application_id=$1", [id, other]))).rejects.toThrow(/cannot be changed/);
  });
  it("lets the status, updated_by and updated_at change (disable and re-enable)", async () => {
    const { tenant, id } = await ready();
    await target(tenant, id);
    await asTenant(app, tenant, (q) => q("UPDATE public.studio_registry_targets SET status='disabled', updated_by='bob', updated_at=now() WHERE application_id=$1", [id]));
    expect((await asTenant(app, tenant, (q) => q("SELECT status, updated_by, created_by FROM public.studio_registry_targets WHERE application_id=$1", [id]))).rows).toEqual([{ status: "disabled", updated_by: "bob", created_by: "maya" }]);
    await asTenant(app, tenant, (q) => q("UPDATE public.studio_registry_targets SET status='active' WHERE application_id=$1", [id]));
  });
  it("refuses a status update that smuggles a change into the same statement", async () => {
    const { tenant, id } = await ready();
    await target(tenant, id);
    await expect(asTenant(app, tenant, (q) => q("UPDATE public.studio_registry_targets SET status='disabled', label='Smuggled' WHERE application_id=$1", [id]))).rejects.toThrow(/cannot be changed/);
    expect((await asTenant(app, tenant, (q) => q("SELECT status, label FROM public.studio_registry_targets WHERE application_id=$1", [id]))).rows).toEqual([{ status: "active", label: "Submit" }]);
  });
});

describe("the caps are enforced in the database, race-safely", () => {
  it("at most 20 routes per application even when 30 inserts run concurrently; another application is unaffected", async () => {
    const tenant = randomUUID(); const id = await enroll(tenant);
    const outcomes = await Promise.all(Array.from({ length: 30 }, (_v, i) => route(tenant, id, `r${i}`, `/#/p${i}`).then(() => "ok" as const, (error: Error) => error.message)));
    expect(outcomes.filter((o) => o === "ok")).toHaveLength(20);
    expect(outcomes.filter((o) => o !== "ok").every((o) => /at most 20 routes/.test(String(o)))).toBe(true);
    expect((await asTenant(app, tenant, (q) => q("SELECT count(*)::int AS n FROM public.studio_registry_routes WHERE application_id=$1", [id]))).rows).toEqual([{ n: 20 }]);
    const other = await enroll(tenant);
    await route(tenant, other);
  }, 60_000);
  it("at most 200 targets per application even when 230 inserts run concurrently", async () => {
    const { tenant, id } = await ready();
    const outcomes = await Promise.all(Array.from({ length: 230 }, (_v, i) => target(tenant, id, { id: `orders.t${i}` }).then(() => "ok" as const, (error: Error) => error.message)));
    expect(outcomes.filter((o) => o === "ok")).toHaveLength(200);
    expect(outcomes.filter((o) => o !== "ok").every((o) => /at most 200 targets/.test(String(o)))).toBe(true);
    expect((await asTenant(app, tenant, (q) => q("SELECT count(*)::int AS n FROM public.studio_registry_targets WHERE application_id=$1", [id]))).rows).toEqual([{ n: 200 }]);
  }, 120_000);
});

describe("the migration file", () => {
  it("is idempotent (runs again as dap_owner without error or change) and applies only as dap_owner", async () => {
    const sql = await readFile(MIGRATION, "utf8");
    const snapshot = async () => (await app.query("SELECT c.relname, c.relacl::text AS acl, c.relrowsecurity, c.relforcerowsecurity FROM pg_class c WHERE c.relname IN ('studio_registry_routes','studio_registry_targets') ORDER BY 1")).rows;
    const before = await snapshot();
    await owner.query(sql);
    await owner.query(sql);
    expect(await snapshot()).toEqual(before);
    expect((await app.query("SELECT count(*)::int AS n FROM pg_policies WHERE tablename IN ('studio_registry_routes','studio_registry_targets')")).rows).toEqual([{ n: 2 }]);
    expect((await app.query("SELECT count(*)::int AS n FROM pg_trigger WHERE tgrelid IN ('public.studio_registry_routes'::regclass,'public.studio_registry_targets'::regclass) AND NOT tgisinternal")).rows).toEqual([{ n: 4 }]);
    await assertStateAcl(app, "studio_registry_targets", ["SELECT", "INSERT", "UPDATE"]);
    await assertStateAcl(app, "studio_registry_routes", ["SELECT", "INSERT"]);
    await expect(app.query(sql)).rejects.toThrow(/requires dap_owner/);
  });
  it("adds only the UNIQUE key to studio_applications (072 and 073 are otherwise untouched)", async () => {
    expect((await app.query("SELECT conname FROM pg_constraint WHERE conrelid='public.studio_applications'::regclass AND contype='u'")).rows).toEqual([{ conname: "studio_applications_registry_key" }]);
  });
});

describe("migration 075 registry array values", () => {
  it("rejects duplicate operations and origins on direct inserts as dap_app", async () => {
    const { tenant, id } = await ready();
    await expect(target(tenant, id, { operations: ["highlight", "highlight"] }))
      .rejects.toMatchObject({ code: "23514", constraint: "studio_registry_targets_distinct_operations" });
    await expect(asTenant(app, tenant, (q) => q(INSERT_APP.replace("ARRAY['http://localhost:5184']", "ARRAY['http://localhost:5184','http://localhost:5184']"),
      [tenant, newApp(), "studio-managed"])))
      .rejects.toMatchObject({ code: "23514", constraint: "studio_applications_distinct_origins" });
  });

  it("can be reapplied twice and preserves a valid target's stored operations", async () => {
    const { tenant, id } = await ready();
    await target(tenant, id, { operations: ["click", "highlight"] });
    const sql = await readFile(new URL("../../db/migrations/075_studio_registry_operations.sql", import.meta.url), "utf8");
    await owner.query(sql);
    await owner.query(sql);
    expect((await asTenant(app, tenant, (q) => q("SELECT operations FROM public.studio_registry_targets WHERE application_id=$1", [id]))).rows)
      .toEqual([{ operations: ["click", "highlight"] }]);
  });
});
