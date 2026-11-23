/**
 * The injected clock is a TEST seam. A production composition root must not be able to reach it by accident (or by a
 * config object a model or a tenant could influence): it is a symbol that the package barrel does not export, and an
 * ordinary `now` option is refused instead of being quietly honoured.
 */
import { describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import type { TenantScope } from "@dap/contracts";
import * as api from "../../index.js";
import { PostgresRateLimiter } from "./rate-limiter.js";
import { PostgresReplayGuard } from "./replay.js";
import { TEST_CLOCK } from "./state-runtime.js";

const scope = { tenantId: "00000000-0000-4000-8000-0000000000aa" } as TenantScope;
const FIXED = new Date("2020-01-01T00:00:00.000Z");
function recordingPool() {
  const statements: { sql: string; params: unknown[] }[] = [];
  const client = { query: async (sql: string, params: unknown[] = []) => {
    statements.push({ sql, params });
    if (/^BEGIN/.test(sql)) return { command: "BEGIN", rowCount: null, rows: [] };
    if (/^COMMIT/.test(sql)) return { command: "COMMIT", rowCount: null, rows: [] };
    if (/clock_timestamp\(\) AS now/.test(sql)) return { command: "SELECT", rowCount: 1, rows: [{ now: new Date() }] };
    if (/^INSERT INTO public.sec_replay_claims/.test(sql)) return { command: "INSERT", rowCount: 1, rows: [] };
    return { command: "DELETE", rowCount: 0, rows: [] };
  }, release: () => undefined } as unknown as PoolClient;
  return { pool: { connect: async () => client } as unknown as Pool, statements };
}

describe("the clock seam", () => {
  it("is not exported by the package barrel, and neither is its options type's name as a value", () => {
    expect(Object.keys(api)).not.toContain("TEST_CLOCK");
    expect(typeof TEST_CLOCK).toBe("symbol");
  });
  it.each([
    ["replay guard", (options: object) => new PostgresReplayGuard(recordingPool().pool, options as never)],
    ["rate limiter", (options: object) => new PostgresRateLimiter(recordingPool().pool, options as never)],
  ])("%s refuses an ordinary `now` option and any other unknown option", (_name, build) => {
    expect(() => build({ now: async () => FIXED })).toThrow(TypeError);
    expect(() => build({ clock: async () => FIXED })).toThrow(TypeError);
    expect(() => build(JSON.parse('{"__proto__":{"now":1}}'))).toThrow(TypeError);
    expect(() => build({})).not.toThrow();
    expect(() => build(Object.create(null) as object)).not.toThrow();
    expect(() => build(new (class Options {})())).toThrow("Invalid state options");
    expect(() => build(Object.create({}) as object)).toThrow("Invalid state options");
    for (const value of [null, [], 1, "options"]) {
      expect(() => build(value as never)).toThrow("Invalid state options");
    }
    for (const value of [null, 1, "clock", {}]) expect(() => build({ [TEST_CLOCK]: value })).toThrow("Invalid state clock");
  });
  it("uses the injected clock only through the symbol key", async () => {
    const injected = recordingPool();
    await new PostgresReplayGuard(injected.pool, { [TEST_CLOCK]: async () => FIXED }).claim(scope, "k", 60);
    expect(injected.statements.some((entry) => /clock_timestamp\(\) AS now/.test(entry.sql))).toBe(false);
    expect(injected.statements.some((entry) => entry.params.some((param) => param instanceof Date && param.getTime() === FIXED.getTime()))).toBe(true);
    const production = recordingPool();
    await new PostgresReplayGuard(production.pool).claim(scope, "k", 60);
    expect(production.statements.some((entry) => /clock_timestamp\(\) AS now/.test(entry.sql))).toBe(true);
  });
  it.each([new Date(Number.NaN), "2020-01-01T00:00:00Z", 1577836800000, null, undefined])("refuses an injected clock answer of %s before writing anything", async (answer) => {
    const probe = recordingPool();
    await expect(new PostgresReplayGuard(probe.pool, { [TEST_CLOCK]: async () => answer as never }).claim(scope, "k", 60)).rejects.toThrow("Invalid database clock");
    await expect(new PostgresRateLimiter(probe.pool, { [TEST_CLOCK]: async () => answer as never }).block(scope, "k", 60)).rejects.toThrow("Invalid database clock");
    expect(probe.statements.some((entry) => /^INSERT/.test(entry.sql))).toBe(false);
  });
});
