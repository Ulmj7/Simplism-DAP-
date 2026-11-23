/**
 * T401 (Feature 004): migration 070, `walkthrough_definitions`, on a FRESH PostgreSQL database (DAP_DATABASE_URL as dap_app, DAP_MIGRATE_DATABASE_URL as dap_owner).
 * Proves: ownership, forced RLS and the exact grants; tenant isolation; no DELETE or TRUNCATE; the status, id, size and shape checks (a built-in id and the
 * reserved preview id are refused by the database itself); the migration is idempotent (the file can run again without error or change).
 */
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { assertStateAcl, openStatePools } from "../../packages/security/src/state/conformance/state-pg-fixtures.js";

const MIGRATION = new URL("../../db/migrations/070_walkthrough_definitions.sql", import.meta.url);
let app: Pool; let owner: Pool;
beforeAll(async () => { ({ app, owner } = await openStatePools(Pool)); });
afterAll(async () => { await Promise.all([app?.end(), owner?.end()]); });

/** One transaction with the tenant setting, exactly how the store does it (a raw copy here so this test depends on no host code). */
async function asTenant<T>(pool: Pool, tenant: string, run: (query: (sql: string, params?: unknown[]) => Promise<{ rows: Record<string, unknown>[]; rowCount: number | null }>) => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenant]);
    const result = await run((sql, params) => client.query(sql, params as never) as never);
    await client.query("COMMIT");
    return result;
  } catch (error) { await client.query("ROLLBACK"); throw error; } finally { client.release(); }
}
const newId = () => `wt-${randomUUID().replace(/-/g, "").slice(0, 12)}`;
const DEFINITION = (id: string) => ({ id, title: "T", description: "D", start: "done", steps: [{ id: "done", kind: "complete", text: "Done." }] });
const INSERT = "INSERT INTO public.walkthrough_definitions (tenant_id, walkthrough_id, status, definition, created_by, updated_by) VALUES ($1,$2,$3,$4::jsonb,$5,$5)";
const insert = (tenant: string, id: string, over: { status?: string; definition?: unknown; actor?: string } = {}) =>
  asTenant(app, tenant, (q) => q(INSERT, [tenant, id, over.status ?? "draft", JSON.stringify("definition" in over ? over.definition : DEFINITION(id)), over.actor ?? "alice"]));

describe("T401 migration 070: walkthrough_definitions", () => {
  it("is owned by dap_owner with forced RLS and SELECT, INSERT, UPDATE only for dap_app (nothing for PUBLIC)", async () => {
    await assertStateAcl(app, "walkthrough_definitions", ["SELECT", "INSERT", "UPDATE"]);
  });
  it("has the planned columns, nullability and primary key", async () => {
    expect((await app.query("SELECT column_name,data_type,is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name='walkthrough_definitions' ORDER BY ordinal_position")).rows).toEqual([
      { column_name: "tenant_id", data_type: "uuid", is_nullable: "NO" },
      { column_name: "walkthrough_id", data_type: "text", is_nullable: "NO" },
      { column_name: "status", data_type: "text", is_nullable: "NO" },
      { column_name: "definition", data_type: "jsonb", is_nullable: "NO" },
      { column_name: "created_by", data_type: "text", is_nullable: "NO" },
      { column_name: "created_at", data_type: "timestamp with time zone", is_nullable: "NO" },
      { column_name: "updated_by", data_type: "text", is_nullable: "NO" },
      { column_name: "updated_at", data_type: "timestamp with time zone", is_nullable: "NO" },
      // Studio V1A, migration 073: the application a guide belongs to. Nullable: guides written before Studio have none and resolve to the built-in reference application.
      { column_name: "application_id", data_type: "text", is_nullable: "YES" },
      { column_name: "revision", data_type: "integer", is_nullable: "NO" },
      { column_name: "live_version", data_type: "integer", is_nullable: "YES" },
    ]);
    expect((await app.query("SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='public.walkthrough_definitions'::regclass AND contype='p'")).rows).toEqual([{ definition: "PRIMARY KEY (tenant_id, walkthrough_id)" }]);
  });
  it("uses the same forced tenant policy form as the other tenant tables, for every command", async () => {
    expect((await app.query("SELECT policyname, cmd, qual, with_check FROM pg_policies WHERE schemaname='public' AND tablename='walkthrough_definitions'")).rows).toEqual([{
      policyname: "tenant_isolation", cmd: "ALL",
      qual: "(tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)",
      with_check: "(tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)",
    }]);
  });

  it("isolates tenants: each tenant sees only its own rows, cannot read, update or insert another tenant's, and no tenant setting sees nothing", async () => {
    const [a, b] = [randomUUID(), randomUUID()];
    const [idA, idB] = [newId(), newId()];
    await insert(a, idA);
    await insert(b, idB, { status: "published" });
    expect((await asTenant(app, a, (q) => q("SELECT walkthrough_id FROM public.walkthrough_definitions"))).rows).toEqual([{ walkthrough_id: idA }]);
    expect((await asTenant(app, b, (q) => q("SELECT walkthrough_id FROM public.walkthrough_definitions"))).rows).toEqual([{ walkthrough_id: idB }]);
    expect((await asTenant(app, a, (q) => q("UPDATE public.walkthrough_definitions SET status='published' WHERE walkthrough_id=$1", [idB]))).rowCount).toBe(0);
    expect((await asTenant(app, b, (q) => q("SELECT status FROM public.walkthrough_definitions WHERE walkthrough_id=$1", [idB]))).rows).toEqual([{ status: "published" }]);
    await expect(asTenant(app, a, (q) => q(INSERT, [b, newId(), "draft", JSON.stringify(DEFINITION("x")), "alice"]))).rejects.toThrow();
    expect((await app.query("SELECT count(*)::int AS n FROM public.walkthrough_definitions")).rows).toEqual([{ n: 0 }]); // no tenant setting: zero rows
  });
  it("refuses DELETE and TRUNCATE for the application role (no privilege), even inside its own tenant", async () => {
    const tenant = randomUUID();
    const id = newId();
    await insert(tenant, id);
    await expect(asTenant(app, tenant, (q) => q("DELETE FROM public.walkthrough_definitions WHERE walkthrough_id=$1", [id]))).rejects.toThrow(/permission denied/);
    await expect(app.query("TRUNCATE public.walkthrough_definitions")).rejects.toThrow(/permission denied/);
    expect((await asTenant(app, tenant, (q) => q("SELECT 1 FROM public.walkthrough_definitions WHERE walkthrough_id=$1", [id]))).rowCount).toBe(1);
  });
  it("allows the status to change (draft -> published -> draft) and records who updated", async () => {
    const tenant = randomUUID();
    const id = newId();
    await insert(tenant, id);
    await asTenant(app, tenant, (q) => q("UPDATE public.walkthrough_definitions SET status='published', updated_by='bob', updated_at=now() WHERE walkthrough_id=$1", [id]));
    expect((await asTenant(app, tenant, (q) => q("SELECT status, created_by, updated_by FROM public.walkthrough_definitions WHERE walkthrough_id=$1", [id]))).rows).toEqual([{ status: "published", created_by: "alice", updated_by: "bob" }]);
  });

  it.each(["archived", "Draft", "PUBLISHED", "", "draft "])("refuses the status %j", async (status) => {
    await expect(insert(randomUUID(), newId(), { status })).rejects.toThrow(/check constraint/);
  });
  it.each([
    ["a built-in id", "profileUpdate"], ["another built-in id", "findSecuritySettings"], ["the reserved preview id", "wt-preview"], ["no prefix", "abcdef012345"],
    ["too short", "wt-abcdef01234"], ["too long", "wt-abcdef0123456"], ["upper-case hex", "wt-ABCDEF012345"], ["non-hex letters", "wt-ghijklmnopqr"], ["a trailing newline", "wt-abcdef012345\n"],
    ["a leading space", " wt-abcdef012345"], ["an empty id", ""], ["a prototype name", "__proto__"],
  ])("refuses %s as a walkthrough id", async (_name, id) => {
    await expect(insert(randomUUID(), id, { definition: DEFINITION("x") })).rejects.toThrow(/check constraint/);
  });
  it("accepts a well-formed generated id", async () => {
    await expect(insert(randomUUID(), "wt-0123456789ab")).resolves.toBeDefined();
  });
  it("refuses a definition that is not a JSON object, or is over 32 KiB, and accepts one right at the limit", async () => {
    for (const definition of [[], "text", 5, null]) await expect(insert(randomUUID(), newId(), { definition }), JSON.stringify(definition)).rejects.toThrow(/constraint|null value/);
    const id = newId();
    const padded = (n: number) => ({ id, pad: "x".repeat(n) });
    const base = Buffer.byteLength(JSON.stringify(padded(0)));
    // jsonb text form adds a space after ':' and ',' so measure what the database stores
    const tenant = randomUUID();
    await asTenant(app, tenant, (q) => q(INSERT, [tenant, id, "draft", JSON.stringify(padded(32768 - 40)), "alice"]));
    const stored = (await asTenant(app, tenant, (q) => q("SELECT octet_length(definition::text) AS n FROM public.walkthrough_definitions WHERE walkthrough_id=$1", [id]))).rows[0] as { n: number };
    expect(stored.n).toBeLessThanOrEqual(32768);
    expect(base).toBeLessThan(100);
    await expect(insert(randomUUID(), newId(), { definition: padded(32768 + 1) })).rejects.toThrow(/check constraint/);
  });
  it("refuses an empty or oversize actor", async () => {
    await expect(insert(randomUUID(), newId(), { actor: "" })).rejects.toThrow(/check constraint/);
    await expect(insert(randomUUID(), newId(), { actor: "a".repeat(257) })).rejects.toThrow(/check constraint/);
    await expect(insert(randomUUID(), newId(), { actor: "a".repeat(256) })).resolves.toBeDefined();
  });
  it("refuses a duplicate id inside a tenant, and allows the same id in another tenant only as that tenant's own row", async () => {
    const tenant = randomUUID();
    const id = newId();
    await insert(tenant, id);
    await expect(insert(tenant, id)).rejects.toThrow(/duplicate key/);
  });

  it("is idempotent: the migration file runs again as dap_owner without error and changes nothing", async () => {
    const sql = await readFile(MIGRATION, "utf8");
    const before = (await app.query("SELECT relacl::text AS acl, relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid='public.walkthrough_definitions'::regclass")).rows;
    await owner.query(sql);
    await owner.query(sql);
    expect((await app.query("SELECT relacl::text AS acl, relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid='public.walkthrough_definitions'::regclass")).rows).toEqual(before);
    expect((await app.query("SELECT count(*)::int AS n FROM pg_policies WHERE tablename='walkthrough_definitions'")).rows).toEqual([{ n: 1 }]);
    await assertStateAcl(app, "walkthrough_definitions", ["SELECT", "INSERT", "UPDATE"]);
  });
  it("applies only as dap_owner (another role is refused before anything is created)", async () => {
    const sql = await readFile(MIGRATION, "utf8");
    await expect(app.query(sql)).rejects.toThrow(/requires dap_owner/);
  });
});
