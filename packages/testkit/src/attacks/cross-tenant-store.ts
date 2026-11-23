import { randomUUID } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import type { ResolvedResource, TenantId } from "@dap/contracts";

const quote = (identifier: string): string => `"${identifier.replaceAll('"', '""')}"`;
interface Column { name: string; type: string; nullable: boolean; generated: boolean; enum_value: string | null }

/** Catalog-only identifiers are quoted; all fixture data is parameterized. Unknown schemas fail loudly. */
function fixtureValue(column: Column, tenant: string): unknown {
  if (column.name === "tenant_id") return tenant;
  const text: Record<string, string> = {
    namespace: "proposal", outcome: "DENIED", reason: "permission_missing", risk: "HIGH",
    event_type: "AI_ACTION_PROPOSED", status: "pending", execution_status: "not_started",
    params_digest: "a".repeat(64), definition_hash: "b".repeat(64), model: "scripted",
  };
  if (column.enum_value !== null) return column.enum_value;
  if (column.type === "uuid") return randomUUID();
  if (["text", "varchar", "bpchar"].includes(column.type)) return text[column.name] ?? `probe-${randomUUID()}`;
  if (["int2", "int4", "int8", "numeric", "float4", "float8"].includes(column.type)) return 1;
  if (column.type === "bool") return false;
  if (["json", "jsonb"].includes(column.type)) return JSON.stringify({});
  if (["timestamp", "timestamptz", "date"].includes(column.type)) return column.name.includes("expir") ? "2100-01-01T00:00:00Z" : "2099-01-01T00:00:00Z";
  throw new Error(`ATK-XTENANT-05 needs fixture support for column ${column.name} (${column.type}); table is NOT silently omitted`);
}

export interface CrossTenantStoreReport { readonly tables: readonly string[]; readonly violations: readonly string[] }
/**
 * Every probe uses a SINGLE application transaction and always rolls back. Seed as B, prove the
 * row exists, then read as A/unscoped and try a B write. Works for append-only tables too.
 */
export async function assertCrossTenantStores(pool: Pool, tenants: { readonly tenantA: string; readonly tenantB: string }): Promise<CrossTenantStoreReport> {
  if (tenants.tenantA === tenants.tenantB) throw new TypeError("Isolation probe needs distinct tenants");
  const client = await pool.connect();
  const violations: string[] = [];
  const names: string[] = [];
  // A probe that cannot even roll back leaves an unknown connection state: it is destroyed, never returned to the pool.
  const health = { rollbackFailed: false };
  try {
    const role = await client.query("SELECT current_user AS name,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user");
    if (role.rows[0]?.name !== "dap_app" || role.rows[0]?.rolsuper !== false || role.rows[0]?.rolbypassrls !== false) throw new Error("Isolation probes require dap_app without SUPERUSER/BYPASSRLS");
    const tables = await client.query("SELECT c.oid,n.nspname AS schema,c.relname AS name,c.relrowsecurity,c.relforcerowsecurity FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN ('r','p') AND c.relname LIKE 'sec\\_%' ESCAPE '\\' AND n.nspname NOT IN ('pg_catalog','information_schema') ORDER BY n.nspname,c.relname");
    if (tables.rows.length === 0) throw new Error("ATK-XTENANT-05 discovered no sec_* tables; run database migrations");
    for (const table of tables.rows) {
      const label = `${table.schema}.${table.name}`; names.push(label);
      if (table.relrowsecurity !== true || table.relforcerowsecurity !== true) violations.push(`${label}: RLS must be enabled AND forced`);
      const columns = await client.query<Column>("SELECT a.attname AS name,t.typname AS type,NOT a.attnotnull AS nullable,(a.atthasdef OR a.attidentity<>'' OR a.attgenerated<>'') AS generated,(SELECT e.enumlabel FROM pg_enum e WHERE e.enumtypid=t.oid ORDER BY e.enumsortorder LIMIT 1) AS enum_value FROM pg_attribute a JOIN pg_type t ON t.oid=a.atttypid WHERE a.attrelid=$1 AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum", [table.oid]);
      if (!columns.rows.some((column) => column.name === "tenant_id")) throw new Error(`${label}: missing tenant_id`);
      const required = columns.rows.filter((column) => column.name === "tenant_id" || (!column.nullable && !column.generated));
      const values = required.map((column) => fixtureValue(column, tenants.tenantB));
      const relation = `${quote(table.schema)}.${quote(table.name)}`;
      const insert = `INSERT INTO ${relation} (${required.map((column) => quote(column.name)).join(",")}) VALUES (${values.map((_, index) => `$${index + 1}`).join(",")})`;
      await probeTable(client, relation, insert, values, tenants, label, violations, health);
    }
    return Object.freeze({ tables: Object.freeze(names), violations: Object.freeze(violations) });
  } finally { client.release(health.rollbackFailed); }
}
/**
 * One write that must NOT reach a row of another tenant: refused outright (42501, no privilege or policy) or matching no
 * row. Any other error is unexpected and fails loudly; a statement that touched a row is a violation.
 */
async function mustTouchNothing(client: PoolClient, savepoint: string, sql: string, params: readonly unknown[], violation: string, label: string, violations: string[]): Promise<void> {
  await client.query(`SAVEPOINT ${savepoint}`);
  try {
    const result = await client.query(sql, [...params]);
    if ((result.rowCount ?? 0) > 0) violations.push(`${label}: ${violation}`);
  } catch (error) { if (!error || typeof error !== "object" || Reflect.get(error, "code") !== "42501") throw error; }
  finally { await client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`); }
}
async function probeTable(client: PoolClient, relation: string, insert: string, values: readonly unknown[], tenants: { tenantA: string; tenantB: string }, label: string, violations: string[], health: { rollbackFailed: boolean }): Promise<void> {
  await client.query("BEGIN");
  try {
    await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenants.tenantB]);
    await client.query(insert, [...values]);
    const positive = await client.query(`SELECT tenant_id FROM ${relation} WHERE tenant_id=$1`, [tenants.tenantB]);
    if (positive.rows.length !== 1) violations.push(`${label}: missing positive B fixture`);
    await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenants.tenantA]);
    if ((await client.query(`SELECT tenant_id FROM ${relation}`)).rows.some((row) => row.tenant_id !== tenants.tenantA)) violations.push(`${label}: foreign row visible as A`);
    await client.query("SELECT set_config('app.tenant_id','',true)");
    if ((await client.query(`SELECT tenant_id FROM ${relation}`)).rows.length !== 0) violations.push(`${label}: row visible without tenant`);
    await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenants.tenantA]);
    await client.query("SAVEPOINT foreign_write");
    try { await client.query(insert, [...values]); violations.push(`${label}: foreign write accepted`); }
    catch (error) { if (!error || typeof error !== "object" || Reflect.get(error, "code") !== "42501") throw error; }
    finally { await client.query("ROLLBACK TO SAVEPOINT foreign_write"); }
    // The same tenant-A scope must not change or remove B's row either.
    await mustTouchNothing(client, "foreign_update", `UPDATE ${relation} SET tenant_id = tenant_id WHERE tenant_id = $1`, [tenants.tenantB], "foreign update touched a row", label, violations);
    await mustTouchNothing(client, "foreign_delete", `DELETE FROM ${relation} WHERE tenant_id = $1`, [tenants.tenantB], "foreign delete touched a row", label, violations);
    // And the owner of a row (B) must not be able to hand it to another tenant.
    await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenants.tenantB]);
    await mustTouchNothing(client, "foreign_rekey", `UPDATE ${relation} SET tenant_id = $1 WHERE tenant_id = $2`, [tenants.tenantA, tenants.tenantB], "row can be re-keyed to another tenant", label, violations);
  } finally {
    try { await client.query("ROLLBACK"); } catch (error) { health.rollbackFailed = true; throw error; }
  }
}

export function testCrossTenantCanary(tenantId: TenantId): { readonly canary: string; readonly resource: ResolvedResource } {
  const canary = "FOREIGN_RESOURCE_NAME_CANARY";
  return { canary, resource: { tenantId, ref: { type: "document", id: "foreign-canary-document" }, displayName: canary } };
}
