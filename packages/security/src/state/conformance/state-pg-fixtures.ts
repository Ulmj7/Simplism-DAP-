import { expect } from "vitest";
import type { Pool } from "pg";

/** Fail loudly: these security probes must never silently skip a missing database. */
export async function openStatePools(PoolClass: typeof Pool): Promise<{ app: Pool; owner: Pool }> {
  if (!process.env.DAP_DATABASE_URL || !process.env.DAP_MIGRATE_DATABASE_URL) throw new Error("PostgreSQL conformance requires DAP_DATABASE_URL and DAP_MIGRATE_DATABASE_URL; start deploy/compose.yaml postgres and run npm run db:migrate.");
  const app = new PoolClass({ connectionString: process.env.DAP_DATABASE_URL, max: 8, connectionTimeoutMillis: 2000 });
  const owner = new PoolClass({ connectionString: process.env.DAP_MIGRATE_DATABASE_URL, max: 2, connectionTimeoutMillis: 2000 });
  try {
    expect((await app.query("SELECT current_user AS name, rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user")).rows).toEqual([{ name: "dap_app", rolsuper: false, rolbypassrls: false }]);
    expect((await owner.query("SELECT current_user AS name")).rows).toEqual([{ name: "dap_owner" }]);
    return { app, owner };
  } catch (error) { await Promise.all([app.end(), owner.end()]); throw error; }
}

/** Pins ownership, forced RLS and all seven table-level privileges, including PUBLIC. */
export async function assertStateAcl(app: Pool, table: string, allowed: readonly string[]): Promise<void> {
  const relation = `public.${table}`;
  expect((await app.query("SELECT pg_get_userbyid(relowner) AS owner, relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid=$1::regclass", [relation])).rows).toEqual([{ owner: "dap_owner", relrowsecurity: true, relforcerowsecurity: true }]);
  for (const privilege of ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER"]) {
    expect((await app.query("SELECT has_table_privilege('dap_app',$1,$2) AS allowed", [relation, privilege])).rows).toEqual([{ allowed: allowed.includes(privilege) }]);
  }
  expect((await app.query("SELECT privilege_type FROM pg_class c, LATERAL aclexplode(c.relacl) a WHERE c.oid=$1::regclass AND a.grantee=0", [relation])).rows).toEqual([]);
}
