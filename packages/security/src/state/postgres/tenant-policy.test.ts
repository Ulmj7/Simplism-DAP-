import { describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { defineAction } from "@dap/contracts";
import type { ActionId, TenantId } from "@dap/contracts";
import { z } from "zod";
import { PostgresTenantActionPolicyStore } from "./tenant-policy.js";
import { buildRegistry } from "../../registry/build-registry.js";
import { createEnablementPolicy } from "../../registry/enablement.js";
import { wrapHook } from "../../gateway/hook-wrapper.js";

const A = "aaaaaaaa-1111-4111-8111-111111111111" as TenantId;
const B = "bbbbbbbb-2222-4222-8222-222222222222" as TenantId;
const id = "tenantProbeAction" as ActionId;
function poolFor(answer: unknown | ((tenant: unknown, values: readonly unknown[]) => unknown), writeResult: () => unknown = () => ({ command: "INSERT", rowCount: 1, rows: [] })) {
  const calls: { sql: string; values: readonly unknown[] }[] = [];
  let connects = 0;
  let released = 0;
  let tenant: unknown;
  const pool = { async connect() {
    connects++;
    return {
      async query(sql: string, values: readonly unknown[] = []) {
        calls.push({ sql, values });
        if (sql.includes("set_config")) { tenant = values[0]; return { command: "SELECT", rows: [] }; }
        if (sql.startsWith("SELECT disabled")) return typeof answer === "function" ? (answer as (tenant: unknown, values: readonly unknown[]) => unknown)(tenant, values) : answer;
        if (sql.startsWith("INSERT")) return writeResult();
        return { command: sql, rows: [] };
      },
      release() { released++; },
    };
  } } as unknown as Pool;
  return { pool, calls, get connects() { return connects; }, get released() { return released; } };
}
const result = (disabled: boolean) => ({ command: "SELECT", rowCount: 1, rows: [{ disabled }] });

describe("Postgres tenant policy trust boundary", () => {
  it.each([
    undefined, null, {}, { rows: [] }, { command: "SELECT", rowCount: 1, rows: [] },
    { command: "UPDATE", rowCount: 0, rows: [] },
    ...[undefined, null, "true", "false", 0, 1, {}].map((disabled) => ({ command: "SELECT", rowCount: 1, rows: [{ disabled }] })),
    { command: "SELECT", rowCount: 1, rows: [Object.create({ disabled: false }) as object] },
    { command: "SELECT", rowCount: 2, rows: [{ disabled: false }, { disabled: false }] },
  ])("rejects malformed database answer %j instead of enabling", async (answer) => {
    const fake = poolFor(answer);
    await expect(new PostgresTenantActionPolicyStore(fake.pool).isDisabled({ tenantId: A }, id)).rejects.toBeInstanceOf(TypeError);
    expect(fake.released).toBe(1);
  });

  it("distinguishes an absent row from literal boolean flags and never caches", async () => {
    const answers = [{ command: "SELECT", rowCount: 0, rows: [] }, result(true), result(false)];
    const fake = poolFor(() => answers.shift());
    const store = new PostgresTenantActionPolicyStore(fake.pool);
    expect(await store.isDisabled({ tenantId: A }, id)).toBe(false);
    expect(await store.isDisabled({ tenantId: A }, id)).toBe(true);
    expect(await store.isDisabled({ tenantId: A }, id)).toBe(false);
    expect(fake.connects).toBe(3);
    expect(fake.calls.filter((call) => call.sql === "COMMIT")).toHaveLength(3);
  });

  it("reads database getters only once before returning a primitive flag", async () => {
    const reads = new Map<string, number>();
    const once = (key: string): void => { reads.set(key, (reads.get(key) ?? 0) + 1); if (reads.get(key)! > 1) throw new Error("repeat"); };
    const answer = {
      get command() { once("command"); return "SELECT"; },
      get rowCount() { once("count"); return 1; },
      get rows() { once("rows"); return [{ get disabled() { once("disabled"); return false; } }]; },
    };
    expect(await new PostgresTenantActionPolicyStore(poolFor(answer).pool).isDisabled({ tenantId: A }, id)).toBe(false);
    expect([...reads.values()]).toEqual([1, 1, 1, 1]);
  });

  it("rolls back writes unless the backend confirms exactly one inserted/upserted row", async () => {
    for (const answer of [undefined, null, { command: "INSERT", rowCount: 0 }, { command: "INSERT", rowCount: 2 }, { command: "UPDATE", rowCount: 1 }]) {
      const fake = poolFor(result(false), () => answer);
      await expect(new PostgresTenantActionPolicyStore(fake.pool).setDisabled({ tenantId: A }, id, true, "operator")).rejects.toThrow();
      expect(fake.calls.some((call) => call.sql === "ROLLBACK")).toBe(true);
      expect(fake.calls.some((call) => call.sql === "COMMIT")).toBe(false);
    }
  });

  it("uses one validated tenant snapshot for both RLS and SQL", async () => {
    let reads = 0;
    const scope = { get tenantId() { return ++reads === 1 ? A : B; } };
    const fake = poolFor((tenant: unknown, values: readonly unknown[]) => values[0] === tenant ? result(true) : { command: "SELECT", rowCount: 0, rows: [] });
    expect(await new PostgresTenantActionPolicyStore(fake.pool).isDisabled(scope, id)).toBe(true);
    expect(reads).toBe(1);
    expect(fake.calls.find((call) => call.sql.includes("set_config"))?.values).toEqual([A]);
    expect(fake.calls.find((call) => call.sql.startsWith("SELECT disabled"))?.values).toEqual([A, id]);
  });

  it.each(["", "not-a-uuid", " ' OR 1=1 --", null, undefined])("rejects invalid tenant %j before connecting", async (tenantId) => {
    const fake = poolFor(result(false));
    const store = new PostgresTenantActionPolicyStore(fake.pool);
    await expect(store.isDisabled({ tenantId } as never, id)).rejects.toBeInstanceOf(TypeError);
    await expect(store.setDisabled({ tenantId } as never, id, true, "operator")).rejects.toBeInstanceOf(TypeError);
    expect(fake.connects).toBe(0);
  });

  it.each([undefined, null, "", 7, {}, { length: 1, includes: () => false }, "operator\u0000id"])("rejects the operator id %j before connecting, as the memory store does", async (operator) => {
    const fake = poolFor(result(false));
    await expect(new PostgresTenantActionPolicyStore(fake.pool).setDisabled({ tenantId: A }, id, true, operator as never)).rejects.toBeInstanceOf(TypeError);
    expect(fake.connects).toBe(0);
  });

  it("parameterizes text, snapshots write scope once, and rejects non-boolean writes", async () => {
    const fake = poolFor(result(false));
    const store = new PostgresTenantActionPolicyStore(fake.pool);
    let reads = 0;
    const scope = { get tenantId() { reads++; return A; } };
    const action = "quote' OR 1=1 --" as ActionId;
    await store.setDisabled(scope, action, true, "operator'payload");
    expect(reads).toBe(1);
    const query = fake.calls.find((call) => call.sql.startsWith("INSERT"))!;
    expect(query.values).toEqual([A, action, true, "operator'payload"]);
    expect(query.sql).not.toContain(action);
    await expect(store.setDisabled({ tenantId: A }, id, "false" as never, "operator")).rejects.toBeInstanceOf(TypeError);
  });

  it("propagates DB errors and prevents malformed rows from granting enablement", async () => {
    const definition = defineAction({ id, version: 1, description: "Probe", inputSchema: z.strictObject({}), risk: "SAFE", requiredPermission: "probe" as never, allowedPages: "any", confirmation: { kind: "not-required" }, changesState: false, audit: { params: [] }, executorId: "probe" as never });
    for (const answer of [() => { throw new Error("DB_CANARY"); }, { command: "SELECT", rowCount: 1, rows: [{ disabled: "false" }] }]) {
      const fake = poolFor(answer);
      const tenantPolicy = new PostgresTenantActionPolicyStore(fake.pool);
      const policy = createEnablementPolicy({ registry: buildRegistry([definition]), globalAllowlist: new Set([id]), tenantPolicy });
      await expect(policy.isEnabled({ tenantId: A }, id)).rejects.toThrow();
      expect(await wrapHook(() => policy.isEnabled({ tenantId: A }, id), "boolean")()).toEqual({ ok: false, reason: "dependency_failure" });
    }
  });
});
