import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import type { ActionId, TenantId, TenantScope } from "@dap/contracts";
import { withTenant } from "../postgres/tenant-tx.js";
import { PostgresTenantActionPolicyStore } from "../postgres/tenant-policy.js";
import { assertTenantPolicyIsolation, assertTenantPolicyFreshness } from "./tenant-policy.conformance.js";
import { cleanupTenantPolicyFixtures, rollbackTenantPolicyProbe } from "./tenant-policy-fixtures.js";

const migration = readFileSync(new URL("../../../../../db/migrations/010_sec_tenant_action_policy.sql", import.meta.url), "utf8");
const hardening = readFileSync(new URL("../../../../../db/migrations/011_sec_tenant_action_policy_grants.sql", import.meta.url), "utf8");

describe("tenant policy conformance detects broken implementations", () => {
  it("the real shared isolation check fails an adapter that ignores the tenant", async () => {
    const values = new Map<ActionId, boolean>();
    const ctx = { store: { async isDisabled(_scope: TenantScope, id: ActionId) { void _scope; return values.get(id) ?? false; } }, async setDisabled(_scope: TenantScope, id: ActionId, value: boolean) { void _scope; values.set(id, value); } };
    await expect(assertTenantPolicyIsolation(ctx)).rejects.toThrow();
  });
  it("the real shared freshness check fails a stale caching adapter", async () => {
    const values = new Map<string, boolean>();
    const cache = new Map<string, boolean>();
    const key = (scope: TenantScope, id: ActionId) => JSON.stringify([scope.tenantId, id]);
    const ctx = { store: { async isDisabled(scope: TenantScope, id: ActionId) { const k = key(scope, id); if (!cache.has(k)) cache.set(k, values.get(k) ?? false); return cache.get(k)!; } }, async setDisabled(scope: TenantScope, id: ActionId, flag: boolean) { values.set(key(scope, id), flag); } };
    await expect(assertTenantPolicyFreshness(ctx)).rejects.toThrow();
  });
});

describe("tenant policy migration, roles and fixture ownership", () => {
  let app: Pool;
  let owner: Pool;
  const tenantId = randomUUID() as TenantId;
  const otherTenant = randomUUID() as TenantId;
  const owned = `conformance-${randomUUID()}` as ActionId;
  const foreign = `conformance-${randomUUID()}` as ActionId;
  const marker = `qa-${randomUUID()}`;
  beforeAll(async () => {
    if (!process.env.DAP_DATABASE_URL || !process.env.DAP_MIGRATE_DATABASE_URL) throw new Error("Set local PostgreSQL test URLs before conformance tests");
    app = new Pool({ connectionString: process.env.DAP_DATABASE_URL, max: 2, connectionTimeoutMillis: 2000 });
    owner = new Pool({ connectionString: process.env.DAP_MIGRATE_DATABASE_URL, max: 1, connectionTimeoutMillis: 2000 });
    expect((await owner.query("SELECT current_user AS name")).rows).toEqual([{ name: "dap_owner" }]);
    expect((await app.query("SELECT current_user AS name, rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user")).rows).toEqual([{ name: "dap_app", rolsuper: false, rolbypassrls: false }]);
  });
  afterAll(async () => {
    try {
      if (owner) {
        await cleanupTenantPolicyFixtures(owner, [{ tenantId, actionId: owned }], marker);
        await cleanupTenantPolicyFixtures(owner, [{ tenantId, actionId: owned }, { tenantId, actionId: foreign }], `${marker}-other`);
      }
    } finally { await Promise.all([app?.end(), owner?.end()]); }
  });

  it("restores exactly the app grants and supports repeated migration execution", async () => {
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      // This extra privilege exists only in our uncommitted transaction and is always rolled back.
      await client.query("GRANT DELETE, TRUNCATE ON public.sec_tenant_action_policy TO dap_app");
      await client.query("GRANT SELECT ON public.sec_tenant_action_policy TO PUBLIC");
      for (let i = 0; i < 2; i++) { await client.query(migration); await client.query(hardening); }
      const grants = await client.query("SELECT privilege_type FROM information_schema.role_table_grants WHERE table_schema='public' AND table_name='sec_tenant_action_policy' AND grantee='dap_app' ORDER BY privilege_type");
      expect(grants.rows.map((row: { privilege_type: string }) => row.privilege_type)).toEqual(["INSERT", "SELECT", "UPDATE"]);
      const publicGrants = await client.query("SELECT count(*)::int AS count FROM pg_class c, LATERAL aclexplode(c.relacl) acl WHERE c.oid='public.sec_tenant_action_policy'::regclass AND acl.grantee=0");
      expect(publicGrants.rows).toEqual([{ count: 0 }]);
    } finally { await client.query("ROLLBACK"); client.release(); }
  });

  it("has dap_owner ownership, ENABLE/FORCE RLS and NULLIF in both policy predicates", async () => {
    const table = await app.query("SELECT pg_get_userbyid(relowner) AS owner, relrowsecurity, relforcerowsecurity FROM pg_class WHERE oid='public.sec_tenant_action_policy'::regclass");
    expect(table.rows).toEqual([{ owner: "dap_owner", relrowsecurity: true, relforcerowsecurity: true }]);
    const policy = await app.query("SELECT pg_get_expr(polqual,polrelid) AS using_expr, pg_get_expr(polwithcheck,polrelid) AS check_expr FROM pg_policy WHERE polrelid='public.sec_tenant_action_policy'::regclass");
    expect(policy.rows).toHaveLength(1);
    for (const expr of [policy.rows[0].using_expr, policy.rows[0].check_expr]) {
      expect(expr).toMatch(/NULLIF/i); expect(expr).toContain("app.tenant_id");
    }
    const roles = await app.query("SELECT rolsuper, rolbypassrls, pg_has_role(current_user,'dap_owner','MEMBER') AS member FROM pg_roles WHERE rolname=current_user");
    expect(roles.rows).toEqual([{ rolsuper: false, rolbypassrls: false, member: false }]);
  });

  it("does not let dap_app disable RLS, become owner, delete or truncate", async () => {
    for (const sql of ["ALTER TABLE public.sec_tenant_action_policy DISABLE ROW LEVEL SECURITY", "SET LOCAL ROLE dap_owner", "DELETE FROM public.sec_tenant_action_policy", "TRUNCATE public.sec_tenant_action_policy"]) {
      await expect(rollbackTenantPolicyProbe(app, tenantId, (client) => client.query(sql))).rejects.toMatchObject({ code: "42501" });
    }
    await expect(rollbackTenantPolicyProbe(app, tenantId, async (client) => {
      await client.query("SET LOCAL row_security=off");
      return client.query("SELECT * FROM public.sec_tenant_action_policy");
    })).rejects.toMatchObject({ code: "42501" });
  });

  it("rejects moving an existing row to another tenant", async () => {
    const store = new PostgresTenantActionPolicyStore(app);
    await store.setDisabled({ tenantId }, owned, true, marker);
    await expect(rollbackTenantPolicyProbe(app, tenantId, (client) => client.query("UPDATE public.sec_tenant_action_policy SET tenant_id=$1 WHERE tenant_id=$2 AND action_id=$3", [otherTenant, tenantId, owned]))).rejects.toMatchObject({ code: "42501" });
    expect(await store.isDisabled({ tenantId }, owned)).toBe(true);
  });

  it("observes updates made outside the adapter on the very next read", async () => {
    const store = new PostgresTenantActionPolicyStore(app);
    await store.setDisabled({ tenantId }, owned, true, marker);
    expect(await store.isDisabled({ tenantId }, owned)).toBe(true);
    await withTenant(app, tenantId, (client) => client.query("UPDATE public.sec_tenant_action_policy SET disabled=false WHERE tenant_id=$1 AND action_id=$2", [tenantId, owned]));
    expect(await store.isDisabled({ tenantId }, owned)).toBe(false);
    await withTenant(app, tenantId, (client) => client.query("UPDATE public.sec_tenant_action_policy SET disabled=true WHERE tenant_id=$1 AND action_id=$2", [tenantId, owned]));
    expect(await store.isDisabled({ tenantId }, owned)).toBe(true);
  });

  it("rolls back successful mutation probes instead of committing fixture changes", async () => {
    const store = new PostgresTenantActionPolicyStore(app);
    await store.setDisabled({ tenantId }, owned, true, marker);
    const result = await rollbackTenantPolicyProbe(app, tenantId, (client) => client.query("UPDATE public.sec_tenant_action_policy SET disabled=false WHERE tenant_id=$1 AND action_id=$2", [tenantId, owned]));
    expect(result.rowCount).toBe(1);
    expect(await store.isDisabled({ tenantId }, owned)).toBe(true);
  });

  it("cleans only exact rows and actor owned by this run, preserving prefix-sharing rows", async () => {
    const store = new PostgresTenantActionPolicyStore(app);
    await store.setDisabled({ tenantId }, owned, true, marker);
    await store.setDisabled({ tenantId }, foreign, true, `${marker}-other`);
    await cleanupTenantPolicyFixtures(owner, [{ tenantId, actionId: owned }], marker);
    expect(await store.isDisabled({ tenantId }, owned)).toBe(false);
    expect(await store.isDisabled({ tenantId }, foreign)).toBe(true);
    // A row with the same key but another actor is not ours to delete.
    await store.setDisabled({ tenantId }, owned, true, `${marker}-other`);
    await cleanupTenantPolicyFixtures(owner, [{ tenantId, actionId: owned }], marker);
    expect(await store.isDisabled({ tenantId }, owned)).toBe(true);
    await cleanupTenantPolicyFixtures(owner, [{ tenantId, actionId: owned }], `${marker}-other`);
  });
});
