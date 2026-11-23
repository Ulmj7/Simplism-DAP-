import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { assertCrossTenantStores, FakeResourceAuthorizer, LeakScanner, TENANT_A, TENANT_B, ALICE, ctx, testCrossTenantCanary } from "@dap/testkit";

let app: Pool; let owner: Pool;
beforeAll(async () => {
  if (!process.env.DAP_DATABASE_URL || !process.env.DAP_MIGRATE_DATABASE_URL) throw new Error("ATK-XTENANT-05 requires DAP_DATABASE_URL and DAP_MIGRATE_DATABASE_URL; start postgres and run npm run db:migrate (no silent skip)");
  app = new Pool({ connectionString: process.env.DAP_DATABASE_URL, max: 1, connectionTimeoutMillis: 2000 });
  owner = new Pool({ connectionString: process.env.DAP_MIGRATE_DATABASE_URL, max: 1, connectionTimeoutMillis: 2000 });
  expect((await app.query("SELECT current_user AS name,rolsuper,rolbypassrls FROM pg_roles WHERE rolname=current_user")).rows).toEqual([{ name: "dap_app", rolsuper: false, rolbypassrls: false }]);
  expect((await owner.query("SELECT current_user AS name")).rows).toEqual([{ name: "dap_owner" }]);
});
afterAll(async () => { await Promise.all([app?.end(), owner?.end()]); });

describe("T124 store and resource isolation", () => {
  it("ATK-XTENANT-05 discovers EVERY sec_* table, forced RLS, positive B read, A/no-setting invisibility, and forbidden B write", async () => {
    const a = randomUUID(); const b = randomUUID();
    const report = await assertCrossTenantStores(app, { tenantA: a, tenantB: b });
    expect(report.tables.length).toBeGreaterThan(0);
    const catalog = await owner.query("SELECT n.nspname AS schema,c.relname AS name FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE c.relkind IN ('r','p') AND c.relname LIKE 'sec\\_%' ESCAPE '\\' AND n.nspname NOT IN ('pg_catalog','information_schema') ORDER BY n.nspname,c.relname");
    expect(report.tables).toEqual(catalog.rows.map((row) => `${row.schema}.${row.name}`));
    expect(report.violations).toEqual([]);
  });
  it("discovers a future sec_* table from the real catalog, excludes a look-alike prefix, and refuses unsupported column types", async () => {
    const suffix = randomUUID().replaceAll("-", "");
    const future = `sec_probe_${suffix}`;
    const lookalike = `secXprobe_${suffix}`;
    try {
      for (const table of [future, lookalike]) {
        // Identifiers consist only of the fixed prefix and UUID hex from the test runner.
        await owner.query(`CREATE TABLE public."${table}" (tenant_id uuid NOT NULL)`);
        await owner.query(`ALTER TABLE public."${table}" ENABLE ROW LEVEL SECURITY`);
        await owner.query(`ALTER TABLE public."${table}" FORCE ROW LEVEL SECURITY`);
        await owner.query(`CREATE POLICY scoped ON public."${table}" USING (tenant_id = NULLIF(current_setting('app.tenant_id',true),'')::uuid) WITH CHECK (tenant_id = NULLIF(current_setting('app.tenant_id',true),'')::uuid)`);
        await owner.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON public."${table}" TO dap_app`);
      }
      const tenants = { tenantA: randomUUID(), tenantB: randomUUID() };
      const report = await assertCrossTenantStores(app, tenants);
      expect(report.tables).toContain(`public.${future}`);
      expect(report.tables).not.toContain(`public.${lookalike}`);
      expect(report.violations).toEqual([]);
      await owner.query(`ALTER TABLE public."${future}" ADD COLUMN unsupported bytea NOT NULL`);
      await expect(assertCrossTenantStores(app, tenants)).rejects.toThrow("fixture support for column unsupported (bytea)");
    } finally {
      for (const table of [future, lookalike]) await owner.query(`DROP TABLE IF EXISTS public."${table}"`);
    }
  });
  it("the probes leave NO residue: after the run neither tenant owns a row in any sec_* table", async () => {
    const a = randomUUID(); const b = randomUUID();
    const report = await assertCrossTenantStores(app, { tenantA: a, tenantB: b });
    expect(report.violations).toEqual([]);
    const client = await owner.connect();
    try {
      for (const table of report.tables) {
        const [schema, name] = table.split(".") as [string, string];
        for (const tenant of [a, b]) {
          await client.query("BEGIN");
          try {
            await client.query("SELECT set_config('app.tenant_id',$1,true)", [tenant]);
            const { rows } = await client.query(`SELECT count(*)::int AS n FROM "${schema}"."${name}" WHERE tenant_id=$1`, [tenant]);
            expect(rows, `${table} for ${tenant}`).toEqual([{ n: 0 }]);
          } finally { await client.query("ROLLBACK"); }
        }
      }
    } finally { client.release(); }
  });
  it("ATK-XTENANT-10 foreign resource display-name canary is absent from A's host answer", async () => {
    const host = new FakeResourceAuthorizer();
    const { resource, canary } = testCrossTenantCanary(TENANT_B);
    host.registerResource(TENANT_B, resource.ref, resource);
    const foreign = await host.resolve(ctx(TENANT_A, ALICE), resource.ref, "perm.read" as never);
    const own = await host.resolve(ctx(TENANT_B, ALICE), resource.ref, "perm.read" as never);
    expect(foreign).toBeNull();
    expect(own?.displayName).toBe(canary);
    const scanner = new LeakScanner({ canaries: [canary] });
    expect(scanner.scan(foreign)).toEqual([]);
    expect(scanner.scan(own).some((item) => item.kind === "canary")).toBe(true);
  });
  // ATK-XTENANT-10 (a foreign resource never puts a display name in the response or the audit) is proven through the REAL gateway, for every kind and every resource capability,
  // in cross-tenant.test.ts ("no foreign display name, resource id or tenant id reaches the planner or the audit events"); reconciled in T071, no longer a todo.
});
