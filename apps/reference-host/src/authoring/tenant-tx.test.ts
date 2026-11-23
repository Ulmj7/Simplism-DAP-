/** The host-local tenant transaction helper, with a fake pool (no database): its semantics are those of the Feature 001 helper. The PostgreSQL proofs are tests/integration/authoring-store.test.ts. */
import { describe, expect, it } from "vitest";
import { withTenant } from "./tenant-tx.js";
import type { TenantPool } from "./tenant-tx.js";

const TENANT = "1111aaaa-2222-4333-8444-5555bbbb5555";
interface Script { readonly failOn?: string; readonly commitCommand?: string; readonly rollbackFails?: boolean }
function fakePool(script: Script = {}) {
  const log: string[] = [];
  const released: boolean[] = [];
  const client = {
    async query(sql: string, params?: unknown[]) {
      log.push(params === undefined ? sql : `${sql} ${JSON.stringify(params)}`);
      if (sql === "ROLLBACK" && script.rollbackFails) throw new Error("rollback failed SECRET");
      if (script.failOn !== undefined && sql.startsWith(script.failOn)) throw new Error("statement failed SECRET");
      return { command: sql === "COMMIT" ? (script.commitCommand ?? "COMMIT") : sql.split(" ")[0], rows: [], rowCount: 0 };
    },
    release(discard?: boolean) { released.push(discard === true); },
  };
  const pool = { connect: async () => client } as unknown as TenantPool;
  return { pool, log, released };
}

describe("withTenant (host-local)", () => {
  it("runs BEGIN, the transaction-local tenant setting, the body, COMMIT, and releases the connection normally", async () => {
    const t = fakePool();
    const result = await withTenant(t.pool, TENANT, async (client) => { await client.query("SELECT 1"); return "done"; });
    expect(result).toBe("done");
    expect(t.log).toEqual(["BEGIN", `SELECT set_config('app.tenant_id', $1, true) ["${TENANT}"]`, "SELECT 1", "COMMIT"]);
    expect(t.released).toEqual([false]);
  });
  it("the setting is transaction-local (the third argument of set_config is true), never session-wide", async () => {
    const t = fakePool();
    await withTenant(t.pool, TENANT, async () => undefined);
    expect(t.log[1]).toContain("set_config('app.tenant_id', $1, true)");
  });
  it("rolls back and rethrows when the body throws, and releases without discarding", async () => {
    const t = fakePool();
    await expect(withTenant(t.pool, TENANT, async () => { throw new Error("boom"); })).rejects.toThrow("boom");
    expect(t.log).toEqual(["BEGIN", `SELECT set_config('app.tenant_id', $1, true) ["${TENANT}"]`, "ROLLBACK"]);
    expect(t.released).toEqual([false]);
  });
  it("a COMMIT that comes back as ROLLBACK is an error, never a success", async () => {
    const t = fakePool({ commitCommand: "ROLLBACK" });
    await expect(withTenant(t.pool, TENANT, async () => "x")).rejects.toThrow(/rolled back instead of committed/);
    expect(t.log.at(-1)).toBe("ROLLBACK");
  });
  it("DISCARDS the connection when the ROLLBACK itself fails, and still surfaces the original error", async () => {
    const t = fakePool({ rollbackFails: true });
    await expect(withTenant(t.pool, TENANT, async () => { throw new Error("original"); })).rejects.toThrow("original");
    expect(t.released).toEqual([true]);
  });
  it("a failing BEGIN or setting is rolled back and released", async () => {
    const t = fakePool({ failOn: "SELECT set_config" });
    await expect(withTenant(t.pool, TENANT, async () => "x")).rejects.toThrow();
    expect(t.log).toContain("ROLLBACK");
    expect(t.released).toEqual([false]);
  });
  it.each(["", "not-a-uuid", "1111aaaa-2222-4333-8444-5555bbbb555", "1111aaaa-2222-4333-8444-5555bbbb55555", `${TENANT} `, "'; DROP TABLE x; --", TENANT.toUpperCase(), 5, null, undefined, {}])(
    "refuses the tenant id %j before touching the connection", async (tenant) => {
      const t = fakePool();
      await expect(withTenant(t.pool, tenant as never, async () => "x")).rejects.toThrow(TypeError);
      expect(t.log).toEqual([]);
      expect(t.released).toEqual([]);
    });
  it("exposes only `query` to the body: no release, no connection object", async () => {
    const t = fakePool();
    await withTenant(t.pool, TENANT, async (client) => { expect(Object.keys(client)).toEqual(["query"]); });
  });
});
