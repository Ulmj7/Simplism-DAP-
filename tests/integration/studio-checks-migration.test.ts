import { readFile } from "node:fs/promises";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import type { ReferenceHost } from "../../apps/reference-host/src/index.js";
import { checkName } from "../../apps/reference-host/src/studio/registry-checks.js";
import type { CheckContent } from "../../apps/reference-host/src/studio/registry-checks.js";
import { openStatePools } from "../../packages/security/src/state/conformance/state-pg-fixtures.js";
import { referenceConfig, startHost } from "./studio-registry.support.js";

let owner: Pool;
let probe: Pool;
const closers: (() => Promise<unknown>)[] = [];
const hosts: ReferenceHost[] = [];
beforeAll(async () => { ({ app: probe, owner } = await openStatePools(Pool)); });
afterAll(async () => { await Promise.all([probe?.end(), owner?.end()]); });
afterEach(async () => { await Promise.all([...closers.splice(0).map((close) => close()), ...hosts.splice(0).map((host) => host.close())]); });

const start = () => startHost(closers, hosts, owner);
const visible: CheckContent = { kind: "element.visible", targetId: "orders.submitButton", route: null, attribute: null, expected: null };

async function ready() {
  const host = await start();
  const appId = await host.createApplication();
  await host.registerOk(appId);
  const insert = (content: CheckContent = visible, options: { applicationId?: string; name?: string; tenantId?: string } = {}) =>
    host.sql((db) => db.query(
      `INSERT INTO public.studio_registry_checks (tenant_id, application_id, name, kind, target_id, route, attribute, expected, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,'maya','maya') RETURNING name, status`,
      [options.tenantId ?? host.tenant, options.applicationId ?? appId, options.name ?? checkName(content), content.kind, content.targetId, content.route, content.attribute, content.expected]));
  return { host, appId, insert };
}

describe("migration 078 in PostgreSQL", () => {
  it("reapplies as owner and retains forced RLS and column-level grants", async () => {
    const sql = await readFile(new URL("../../db/migrations/078_studio_checks.sql", import.meta.url), "utf8");
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await client.query(sql);
      const privileges = await client.query(`SELECT relrowsecurity, relforcerowsecurity,
        has_table_privilege('dap_app', oid, 'SELECT') AS can_read,
        has_table_privilege('dap_app', oid, 'INSERT') AS can_insert,
        has_table_privilege('dap_app', oid, 'DELETE') AS can_delete,
        has_column_privilege('dap_app', oid, 'status', 'UPDATE') AS can_set_status,
        has_column_privilege('dap_app', oid, 'expected', 'UPDATE') AS can_set_expected
        FROM pg_class WHERE oid = 'public.studio_registry_checks'::regclass`);
      expect(privileges.rows).toEqual([{ relrowsecurity: true, relforcerowsecurity: true, can_read: true, can_insert: true, can_delete: false, can_set_status: true, can_set_expected: false }]);
    } finally { await client.query("ROLLBACK"); client.release(); }
  });

  it("stores a canonical check and permits status changes only", async () => {
    const t = await ready();
    // Quotes and Unicode in ordinary content must hash identically in Node and PostgreSQL.
    const check: CheckContent = { ...visible, kind: "element.text.equals", expected: 'Order "ready" ✓' };
    const name = checkName(check);
    expect((await t.insert(check)).rows).toEqual([{ name, status: "active" }]);
    await expect(t.insert(check)).rejects.toMatchObject({ code: "23505" });
    expect((await t.host.sql((q) => q.query("UPDATE public.studio_registry_checks SET status='disabled' WHERE name=$1 RETURNING status", [name]))).rows).toEqual([{ status: "disabled" }]);
    await expect(t.host.sql((q) => q.query("UPDATE public.studio_registry_checks SET expected='Changed' WHERE name=$1", [name]))).rejects.toMatchObject({ code: "42501" });
    await expect(t.host.sql((q) => q.query("DELETE FROM public.studio_registry_checks WHERE name=$1", [name]))).rejects.toMatchObject({ code: "42501" });
  });

  it("enforces the canonical name, required and forbidden fields, expected lengths and characters", async () => {
    const t = await ready();
    await expect(t.insert(visible, { name: "check.v0000000000" })).rejects.toMatchObject({ constraint: "studio_registry_checks_name" });
    const attribute = { ...visible, kind: "element.attribute.equals" as const, expected: "true" };
    const invalid: CheckContent[] = [
      { ...visible, targetId: null }, { ...visible, expected: "Extra" },
      { ...visible, kind: "route.equals", targetId: null },
      { ...attribute, attribute: null },
      { ...attribute, attribute: "aria-selected", expected: "x".repeat(41) },
      { ...visible, kind: "element.text.equals", expected: "x".repeat(121) },
    ];
    for (const value of invalid) await expect(t.insert(value)).rejects.toMatchObject({ constraint: "studio_registry_checks_shape" });
    for (const expected of ["   ", "a\nb", "a\u2028b", "a\u202eb"]) {
      await expect(t.insert({ ...visible, kind: "element.text.equals", expected })).rejects.toMatchObject({ code: "23514" });
    }
  });

  it("binds checks to managed applications and to their own active targets and routes", async () => {
    const t = await ready();
    const other = await t.host.createApplication();
    const builtIn = await t.host.createApplication(referenceConfig());
    await expect(t.insert(visible, { applicationId: other })).rejects.toMatchObject({ constraint: "studio_registry_checks_target_fk" });
    await expect(t.insert({ ...visible, kind: "route.equals", targetId: null, route: "orders" }, { applicationId: other })).rejects.toMatchObject({ constraint: "studio_registry_checks_route_fk" });
    await expect(t.insert(visible, { applicationId: builtIn })).rejects.toMatchObject({ constraint: "studio_registry_checks_application_fk" });
    await expect(t.insert({ ...visible, kind: "element.value.equals", expected: "Ready" })).rejects.toMatchObject({ constraint: "studio_registry_checks_value_role" });
    await t.host.targets.setStatus({ tenantId: t.host.tenant, actor: "maya" }, t.appId, "orders.submitButton", "disabled");
    await expect(t.insert()).rejects.toMatchObject({ constraint: "studio_registry_checks_target_active" });
  });

  it("isolates checks by tenant and enforces the cap with concurrent inserts", async () => {
    const t = await ready();
    const elsewhere = await start();
    const text = (n: number): CheckContent => ({ ...visible, kind: "element.text.equals", expected: `Order ${n}` });
    await t.insert();
    expect((await elsewhere.sql((q) => q.query("SELECT name FROM public.studio_registry_checks WHERE application_id=$1", [t.appId]))).rows).toEqual([]);
    for (let index = 0; index < 98; index += 1) await t.insert(text(index));
    const results = await Promise.allSettled([t.insert(text(98)), t.insert(text(99))]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(results.find((result) => result.status === "rejected")).toMatchObject({ reason: { constraint: "studio_registry_checks_cap" } });
    expect((await t.host.sql((q) => q.query("SELECT count(*)::int AS count FROM public.studio_registry_checks WHERE application_id=$1", [t.appId]))).rows).toEqual([{ count: 100 }]);
  });
});
