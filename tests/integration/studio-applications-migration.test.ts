/**
 * Studio V1A migrations 072 (`studio_applications`) and 073 (`walkthrough_definitions.application_id`) on a FRESH PostgreSQL database (DAP_DATABASE_URL as dap_app,
 * DAP_MIGRATE_DATABASE_URL as dap_owner). Proves: ownership, forced RLS and the exact grants (no DELETE, no TRUNCATE); tenant isolation; the id, origin, origins, environment,
 * registry and name checks; the composite foreign key (a guide can only point at an application of its OWN tenant); the assign-once trigger; both files are idempotent.
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { assertStateAcl, openStatePools } from "../../packages/security/src/state/conformance/state-pg-fixtures.js";

const M072 = new URL("../../db/migrations/072_studio_applications.sql", import.meta.url);
const M073 = new URL("../../db/migrations/073_walkthrough_application.sql", import.meta.url);
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
const newWt = () => `wt-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
const INSERT_APP = "INSERT INTO public.studio_applications (tenant_id, application_id, name, origin, allowed_origins, environment, registry_id, created_by, updated_by) VALUES ($1,$2,$3,$4,$5::text[],$6,$7,$8,$8)";
interface AppOver { id?: string; name?: string; origin?: string; allowed?: string[]; environment?: string; registry?: string; actor?: string }
const insertApp = (tenant: string, over: AppOver = {}) => asTenant(app, tenant, (q) => q(INSERT_APP, [
  tenant, over.id ?? newApp(), over.name ?? "Reference application", over.origin ?? "http://localhost:5184", over.allowed ?? [over.origin ?? "http://localhost:5184"], over.environment ?? "development", over.registry ?? "reference", over.actor ?? "alice",
]));
const insertWalkthrough = (tenant: string, applicationId: string | null, id = newWt()) => asTenant(app, tenant, (q) => q(
  "INSERT INTO public.walkthrough_definitions (tenant_id, walkthrough_id, status, definition, created_by, updated_by, application_id) VALUES ($1,$2,'draft','{}'::jsonb,'alice','alice',$3)", [tenant, id, applicationId]));

describe("migration 072: studio_applications", () => {
  it("is owned by dap_owner with forced RLS and SELECT, INSERT, UPDATE only for dap_app (nothing for PUBLIC, no DELETE, no TRUNCATE)", async () => {
    await assertStateAcl(app, "studio_applications", ["SELECT", "INSERT", "UPDATE"]);
  });
  it("has the planned columns, nullability and primary key", async () => {
    expect((await app.query("SELECT column_name,data_type,is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name='studio_applications' ORDER BY ordinal_position")).rows).toEqual([
      { column_name: "tenant_id", data_type: "uuid", is_nullable: "NO" },
      { column_name: "application_id", data_type: "text", is_nullable: "NO" },
      { column_name: "name", data_type: "text", is_nullable: "NO" },
      { column_name: "origin", data_type: "text", is_nullable: "NO" },
      { column_name: "allowed_origins", data_type: "ARRAY", is_nullable: "NO" },
      { column_name: "environment", data_type: "text", is_nullable: "NO" },
      { column_name: "registry_id", data_type: "text", is_nullable: "NO" },
      { column_name: "enabled", data_type: "boolean", is_nullable: "NO" },
      { column_name: "created_by", data_type: "text", is_nullable: "NO" },
      { column_name: "created_at", data_type: "timestamp with time zone", is_nullable: "NO" },
      { column_name: "updated_by", data_type: "text", is_nullable: "NO" },
      { column_name: "updated_at", data_type: "timestamp with time zone", is_nullable: "NO" },
    ]);
    expect((await app.query("SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='public.studio_applications'::regclass AND contype='p'")).rows).toEqual([{ definition: "PRIMARY KEY (tenant_id, application_id)" }]);
    expect((await app.query("SELECT indexname FROM pg_indexes WHERE schemaname='public' AND tablename='studio_applications' ORDER BY indexname")).rows).toEqual([
      { indexname: "studio_applications_pkey" }, { indexname: "studio_applications_tenant_updated_idx" },
    ]);
    expect((await app.query("SELECT column_default FROM information_schema.columns WHERE table_name='studio_applications' AND column_name='enabled'")).rows).toEqual([{ column_default: "true" }]);
  });
  it("RLS isolates tenants: a row written in A is invisible in B, and without a tenant setting the table is empty", async () => {
    const [a, b] = [randomUUID(), randomUUID()];
    const id = newApp();
    await insertApp(a, { id });
    expect((await asTenant(app, a, (q) => q("SELECT 1 FROM public.studio_applications"))).rows).toHaveLength(1);
    expect((await asTenant(app, b, (q) => q("SELECT 1 FROM public.studio_applications"))).rows).toHaveLength(0);
    expect((await app.query("SELECT 1 FROM public.studio_applications")).rows).toHaveLength(0);
    // The same id may exist in two tenants as two separate rows.
    await insertApp(b, { id });
  });
  it("a tenant cannot write, update or take over another tenant's row (the policy's WITH CHECK / USING refuses it)", async () => {
    const [a, b] = [randomUUID(), randomUUID()];
    const id = newApp();
    await insertApp(a, { id });
    await expect(asTenant(app, a, (q) => q(INSERT_APP, [b, newApp(), "x", "http://localhost:1", ["http://localhost:1"], "development", "reference", "x"]))).rejects.toThrow(/row-level security/);
    expect((await asTenant(app, b, (q) => q("UPDATE public.studio_applications SET name='Hijacked' WHERE application_id=$1", [id]))).rowCount).toBe(0);
    expect((await asTenant(app, a, (q) => q("SELECT name FROM public.studio_applications WHERE application_id=$1", [id]))).rows).toEqual([{ name: "Reference application" }]);
  });
  it("dap_app can neither DELETE nor TRUNCATE (an application is only ever disabled)", async () => {
    const tenant = randomUUID();
    await insertApp(tenant);
    await expect(asTenant(app, tenant, (q) => q("DELETE FROM public.studio_applications"))).rejects.toThrow(/permission denied/);
    await expect(app.query("TRUNCATE public.studio_applications")).rejects.toThrow(/permission denied/);
  });
  it.each([
    ["an id that is not app- + 12 hex", { id: "app-0123456789AB" }], ["a short id", { id: "app-0123456789a" }], ["a walkthrough-shaped id", { id: "wt-0123456789ab" }], ["an empty name", { name: "" }], ["an oversize name", { name: "n".repeat(81) }],
    ["a javascript origin", { origin: "javascript:alert(1)", allowed: ["javascript:alert(1)"] }], ["an origin with a path", { origin: "https://example.com/app", allowed: ["https://example.com/app"] }],
    ["an origin with credentials", { origin: "https://u:p@example.com", allowed: ["https://u:p@example.com"] }], ["an origin with a space", { origin: "https://exa mple.com", allowed: ["https://exa mple.com"] }],
    ["an empty origin list", { allowed: [] }], ["six allowed origins", { origin: "https://a0.example", allowed: Array.from({ length: 6 }, (_v, i) => `https://a${i}.example`) }],
    ["an origin that is not among the allowed origins", { allowed: ["http://localhost:5185"] }], ["an allowed origin with a path", { allowed: ["http://localhost:5184", "https://example.com/x"] }],
    ["the production environment", { environment: "production" }], ["a malformed registry id", { registry: "Reference" }], ["an empty actor", { actor: "" }], ["an oversize actor", { actor: "a".repeat(257) }],
  ] as const)("the database itself refuses %s", async (_name, over) => {
    await expect(insertApp(randomUUID(), over as AppOver)).rejects.toThrow(/check constraint/);
  });
  it("accepts the shapes the host produces: https hosts with ports, loopback, IPv6 loopback, punycode, five origins, an 80-character name", async () => {
    const tenant = randomUUID();
    await expect(insertApp(tenant, { origin: "https://app.example.com:8443", allowed: ["https://app.example.com:8443", "https://xn--bcher-kva.example", "http://[::1]:5184", "http://127.0.0.1:5185", "http://localhost"], name: "n".repeat(80), environment: "test", registry: "fixture" })).resolves.toBeDefined();
  });
  it("refuses a duplicate id inside a tenant", async () => {
    const tenant = randomUUID();
    const id = newApp();
    await insertApp(tenant, { id });
    await expect(insertApp(tenant, { id })).rejects.toThrow(/duplicate key/);
  });
  it("is idempotent and applies only as dap_owner", async () => {
    const sql = await readFile(M072, "utf8");
    const before = (await app.query("SELECT relacl::text AS acl, relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid='public.studio_applications'::regclass")).rows;
    await owner.query(sql);
    await owner.query(sql);
    expect((await app.query("SELECT relacl::text AS acl, relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid='public.studio_applications'::regclass")).rows).toEqual(before);
    expect((await app.query("SELECT count(*)::int AS n FROM pg_policies WHERE tablename='studio_applications'")).rows).toEqual([{ n: 1 }]);
    await assertStateAcl(app, "studio_applications", ["SELECT", "INSERT", "UPDATE"]);
    await expect(app.query(sql)).rejects.toThrow(/requires dap_owner/);
  });
});

describe("migration 073: walkthrough_definitions.application_id", () => {
  it("adds one nullable text column, a format check, a composite foreign key and an index, and keeps the grants", async () => {
    expect((await app.query("SELECT is_nullable, data_type FROM information_schema.columns WHERE table_name='walkthrough_definitions' AND column_name='application_id'")).rows).toEqual([{ is_nullable: "YES", data_type: "text" }]);
    expect((await app.query("SELECT conname, pg_get_constraintdef(oid) AS def FROM pg_constraint WHERE conrelid='public.walkthrough_definitions'::regclass AND conname LIKE 'walkthrough_definitions_application%' ORDER BY conname")).rows).toEqual([
      { conname: "walkthrough_definitions_application_fk", def: "FOREIGN KEY (tenant_id, application_id) REFERENCES studio_applications(tenant_id, application_id)" },
      { conname: "walkthrough_definitions_application_id_format", def: "CHECK (((application_id IS NULL) OR (application_id ~ '^app-[a-f0-9]{12}$'::text)))" },
    ]);
    expect((await app.query("SELECT indexname FROM pg_indexes WHERE tablename='walkthrough_definitions' AND indexname='walkthrough_definitions_application_idx'")).rows).toHaveLength(1);
    await assertStateAcl(app, "walkthrough_definitions", ["SELECT", "INSERT", "UPDATE"]);
  });
  it("a guide without an application (legacy) is valid; a guide of tenant A may point at A's application only", async () => {
    const [a, b] = [randomUUID(), randomUUID()];
    const id = newApp();
    await insertApp(a, { id });
    await insertWalkthrough(a, null);
    await insertWalkthrough(a, id);
    await expect(insertWalkthrough(b, id), "another tenant's application").rejects.toThrow(/foreign key/);
    await expect(insertWalkthrough(a, newApp()), "an application that does not exist").rejects.toThrow(/foreign key/);
    await expect(insertWalkthrough(a, "app-0123456789AB"), "a malformed application id").rejects.toThrow(/check constraint/);
  });
  it("the application is assigned once: NULL may take one, a bound guide can never change it (the trigger enforces it even for a raw UPDATE)", async () => {
    const tenant = randomUUID();
    const [first, second] = [newApp(), newApp()];
    await insertApp(tenant, { id: first });
    await insertApp(tenant, { id: second });
    const legacy = newWt();
    await insertWalkthrough(tenant, null, legacy);
    await asTenant(app, tenant, (q) => q("UPDATE public.walkthrough_definitions SET application_id=$2 WHERE walkthrough_id=$1", [legacy, first]));
    await expect(asTenant(app, tenant, (q) => q("UPDATE public.walkthrough_definitions SET application_id=$2 WHERE walkthrough_id=$1", [legacy, second]))).rejects.toThrow(/cannot be changed/);
    await expect(asTenant(app, tenant, (q) => q("UPDATE public.walkthrough_definitions SET application_id=NULL WHERE walkthrough_id=$1", [legacy]))).rejects.toThrow(/cannot be changed/);
    await asTenant(app, tenant, (q) => q("UPDATE public.walkthrough_definitions SET application_id=$2, status='published' WHERE walkthrough_id=$1", [legacy, first])); // the same value is not a change
    expect((await asTenant(app, tenant, (q) => q("SELECT application_id FROM public.walkthrough_definitions WHERE walkthrough_id=$1", [legacy]))).rows).toEqual([{ application_id: first }]);
  });
  it("is idempotent and applies only as dap_owner", async () => {
    const sql = await readFile(M073, "utf8");
    const before = (await app.query("SELECT relacl::text AS acl FROM pg_class WHERE oid='public.walkthrough_definitions'::regclass")).rows;
    await owner.query(sql);
    await owner.query(sql);
    expect((await app.query("SELECT relacl::text AS acl FROM pg_class WHERE oid='public.walkthrough_definitions'::regclass")).rows).toEqual(before);
    expect((await app.query("SELECT count(*)::int AS n FROM pg_trigger WHERE tgrelid='public.walkthrough_definitions'::regclass AND tgname='walkthrough_application_immutable'")).rows).toEqual([{ n: 1 }]);
    await expect(app.query(sql)).rejects.toThrow(/requires dap_owner/);
  });
});
