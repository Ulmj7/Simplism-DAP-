import { describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { assertCrossTenantStores } from "./cross-tenant-store.js";

/** Synthetic catalog evidence tests probe sensitivity; the separate DB suite proves actual isolation. */
function evidence(options: { enabled?: boolean; forced?: boolean; noTables?: boolean; leakA?: boolean; leakUnscoped?: boolean; acceptWrite?: boolean; missingFixture?: boolean; unsafeRole?: boolean; roleName?: string; bypassRls?: boolean; columns?: object[]; leakUpdate?: boolean; leakDelete?: boolean; leakRekey?: boolean; denyUpdateWithPrivilegeError?: boolean; rollbackFails?: boolean; failOtherError?: boolean; tables?: object[] } = {}, released: unknown[] = [], statements: string[] = []): Pool {
  let tenant = ""; let seeded = false;
  const client = {
    release(destroy?: unknown) { released.push(destroy); },
    async query(sql: string, values: unknown[] = []) {
      statements.push(sql);
      if (sql === "BEGIN") seeded = false;
      if (sql === "ROLLBACK" && options.rollbackFails) throw new Error("connection lost");
      if (sql.startsWith("UPDATE")) {
        const rekey = sql.includes("SET tenant_id = $1");
        if (options.denyUpdateWithPrivilegeError) throw Object.assign(new Error("permission denied"), { code: "42501" });
        if (options.failOtherError) throw Object.assign(new Error("boom"), { code: "XX000" });
        return { rows: [], rowCount: (rekey ? options.leakRekey : tenant === "A" && options.leakUpdate) ? 1 : 0 };
      }
      if (sql.startsWith("DELETE")) return { rows: [], rowCount: tenant === "A" && options.leakDelete ? 1 : 0 };
      if (sql.includes("current_user")) return { rows: [{ name: options.roleName ?? "dap_app", rolsuper: options.unsafeRole ?? false, rolbypassrls: options.bypassRls ?? false }] };
      if (sql.includes("FROM pg_class")) return { rows: options.noTables ? [] : options.tables ?? [{ oid: 1, schema: "public", name: "sec_probe", relrowsecurity: options.enabled ?? true, relforcerowsecurity: options.forced ?? true }] };
      if (sql.includes("FROM pg_attribute")) return { rows: options.columns ?? [{ name: "tenant_id", type: "uuid", nullable: false, generated: false, enum_value: null }] };
      if (sql.startsWith("SELECT set_config")) { tenant = values[0] as string ?? ""; return { rows: [] }; }
      if (sql.startsWith("INSERT")) {
        if (seeded && !options.acceptWrite) throw Object.assign(new Error("RLS"), { code: "42501" });
        seeded = true; return { rows: [] };
      }
      if (sql.startsWith("SELECT tenant_id")) {
        const visible = !options.missingFixture && (tenant === "B" || (tenant === "A" && options.leakA) || (tenant === "" && options.leakUnscoped));
        return { rows: visible ? [{ tenant_id: "B" }] : [] };
      }
      if (["BEGIN", "ROLLBACK", ...["foreign_write", "foreign_update", "foreign_delete", "foreign_rekey"].flatMap((name) => [`SAVEPOINT ${name}`, `ROLLBACK TO SAVEPOINT ${name}`])].includes(sql)) return { rows: [] };
      throw new Error(`Unexpected probe SQL: ${sql}`);
    },
  };
  return { connect: async () => client } as unknown as Pool;
}
const tenants = { tenantA: "A", tenantB: "B" };
describe("ATK-XTENANT-05 probe sensitivity", () => {
  it("accepts complete good evidence and discovers its table", async () => {
    const report = await assertCrossTenantStores(evidence(), tenants);
    expect(report).toEqual({ tables: ["public.sec_probe"], violations: [] });
    expect(Object.isFrozen(report)).toBe(true);
    expect(Object.isFrozen(report.tables)).toBe(true);
    expect(Object.isFrozen(report.violations)).toBe(true);
  });
  it.each([
    [{ enabled: false }, "RLS must be enabled AND forced"],
    [{ forced: false }, "RLS must be enabled AND forced"],
    [{ leakA: true }, "foreign row visible as A"],
    [{ leakUnscoped: true }, "row visible without tenant"],
    [{ acceptWrite: true }, "foreign write accepted"],
    [{ missingFixture: true }, "missing positive B fixture"],
    [{ leakUpdate: true }, "foreign update touched a row"],
    [{ leakDelete: true }, "foreign delete touched a row"],
    [{ leakRekey: true }, "row can be re-keyed to another tenant"],
  ] as const)("rejects corrupted evidence %j", async (options, violation) => {
    expect((await assertCrossTenantStores(evidence(options), tenants)).violations).toContain(`public.sec_probe: ${violation}`);
  });
  it("accepts a privilege error (42501) as a refusal of the update, and fails loudly on any other error", async () => {
    expect((await assertCrossTenantStores(evidence({ denyUpdateWithPrivilegeError: true }), tenants)).violations).toEqual([]);
    await expect(assertCrossTenantStores(evidence({ failOtherError: true }), tenants)).rejects.toThrow("boom");
  });
  it("never leaves a probe uncommitted-looking: every probe ends in ROLLBACK, and a failed ROLLBACK destroys the connection instead of pooling it", async () => {
    const released: unknown[] = []; const statements: string[] = [];
    await assertCrossTenantStores(evidence({}, released, statements), tenants);
    expect(statements.filter((sql) => sql === "BEGIN")).toHaveLength(1);
    expect(statements.filter((sql) => sql === "ROLLBACK")).toHaveLength(1);
    expect(statements.some((sql) => sql === "COMMIT")).toBe(false);
    expect(released).toEqual([false]);
    const broken: unknown[] = [];
    await expect(assertCrossTenantStores(evidence({ rollbackFails: true }, broken), tenants)).rejects.toThrow("connection lost");
    expect(broken).toEqual([true]);
  });
  it("probes EVERY table the catalog returns (any schema, including ones that did not exist when this was written) and names the exact one that is weak", async () => {
    const statements: string[] = [];
    const tables = [
      { oid: 1, schema: "public", name: "sec_old", relrowsecurity: true, relforcerowsecurity: true },
      { oid: 2, schema: "tenant_data", name: "sec_future_table", relrowsecurity: true, relforcerowsecurity: false },
      { oid: 3, schema: "public", name: "sec_partition_1", relrowsecurity: true, relforcerowsecurity: true },
    ];
    const report = await assertCrossTenantStores(evidence({ tables }, [], statements), tenants);
    expect(report.tables).toEqual(["public.sec_old", "tenant_data.sec_future_table", "public.sec_partition_1"]);
    expect(report.violations).toEqual(["tenant_data.sec_future_table: RLS must be enabled AND forced"]);
    expect(statements.filter((sql) => sql === "BEGIN")).toHaveLength(3);
    expect(statements.filter((sql) => sql === "ROLLBACK")).toHaveLength(3);
    const discovery = statements.find((sql) => sql.includes("FROM pg_class"));
    expect(discovery).toContain(String.raw`LIKE 'sec\_%' ESCAPE '\'`);
  });
  it("refuses each unsafe role attribute independently and unsupported required columns", async () => {
    for (const options of [{ roleName: "dap_owner" }, { unsafeRole: true }, { bypassRls: true }]) {
      await expect(assertCrossTenantStores(evidence(options), tenants)).rejects.toThrow("dap_app");
    }
    await expect(assertCrossTenantStores(evidence({ columns: [] }), tenants)).rejects.toThrow("missing tenant_id");
    const columns = [
      { name: "tenant_id", type: "uuid", nullable: false, generated: false, enum_value: null },
      { name: "unsupported", type: "bytea", nullable: false, generated: false, enum_value: null },
    ];
    await expect(assertCrossTenantStores(evidence({ columns }), tenants)).rejects.toThrow("fixture support for column unsupported (bytea)");
  });
  it("fails loudly with no tables, unsafe role, or identical scopes", async () => {
    await expect(assertCrossTenantStores(evidence({ noTables: true }), tenants)).rejects.toThrow("no sec_* tables");
    await expect(assertCrossTenantStores(evidence({ unsafeRole: true }), tenants)).rejects.toThrow("dap_app");
    await expect(assertCrossTenantStores(evidence(), { tenantA: "A", tenantB: "A" })).rejects.toThrow("distinct tenants");
  });
});
