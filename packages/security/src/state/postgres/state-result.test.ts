import { describe, expect, it } from "vitest";
import type { Pool } from "pg";
import type { TenantScope } from "@dap/contracts";
import { PostgresReplayGuard } from "./replay.js";
import { PostgresRateLimiter } from "./rate-limiter.js";
import { databaseNow, TEST_CLOCK } from "./state-runtime.js";

const scope: TenantScope = { tenantId: "11111111-1111-4111-8111-111111111111" as TenantScope["tenantId"] };
const clock = { [TEST_CLOCK]: async () => new Date("2020-01-01T00:00:00Z") };
const rule = { limit: 1, windowSeconds: 60 };

/** Fault the SQL dependency, never the policy. Every call still runs the real adapter and transaction wrapper. */
function poolFor(marker: string, answer: unknown) {
  const queries: string[] = [];
  let released = 0;
  const client = {
    async query(sql: string) {
      queries.push(sql);
      if (sql.includes(marker)) return answer;
      if (sql.startsWith("SELECT limit_count")) return { command: "SELECT", rowCount: 0, rows: [] };
      if (sql.includes("INSERT INTO public.sec_rate_counters")) return { command: "INSERT", rowCount: 1, rows: [{ count: "1" }] };
      return { command: sql.split(" ")[0], rowCount: 1, rows: [] };
    },
    release() { released++; },
  };
  return { pool: { connect: async () => client } as unknown as Pool, client, queries, released: () => released };
}

describe("SQL result metadata is a checked, single-read boundary", () => {
  it("uses the same captured replay count for validation and claim classification", async () => {
    let reads = 0;
    const result = { command: "INSERT", get rowCount() { return ++reads === 1 ? 0 : 1; }, rows: [] };
    const fixture = poolFor("INSERT INTO public.sec_replay_claims", result);
    expect(await new PostgresReplayGuard(fixture.pool, clock).claim(scope, "key", 60)).toBe("duplicate");
    expect(reads).toBe(1);
    expect(fixture.released()).toBe(1);
  });

  it.each([
    undefined, null, {}, { command: "UPDATE", rowCount: 0, rows: [] },
    ...[undefined, null, "1", -1, 2].map((rowCount) => ({ command: "INSERT", rowCount, rows: [] })),
    { command: "INSERT", rowCount: 1, rows: [{}] },
  ])("rejects malformed replay result %j and rolls back", async (answer) => {
    const fixture = poolFor("INSERT INTO public.sec_replay_claims", answer);
    await expect(new PostgresReplayGuard(fixture.pool, clock).claim(scope, "key", 60)).rejects.toBeInstanceOf(TypeError);
    expect(fixture.queries).toContain("ROLLBACK");
    expect(fixture.queries).not.toContain("COMMIT");
    expect(fixture.released()).toBe(1);
  });

  it.each([
    { command: "UPDATE", rowCount: 0, rows: [] }, { command: "SELECT", rowCount: 1, rows: [] },
    { command: "SELECT", rowCount: 0, rows: [{ limit_count: 1, window_seconds: 60 }] },
    { command: "SELECT", rowCount: 2, rows: [{ limit_count: 1, window_seconds: 60 }, { limit_count: 1, window_seconds: 60 }] },
    { command: "SELECT", rowCount: 1, rows: [{ limit_count: 2, window_seconds: 60 }] },
    { command: "SELECT", rowCount: 1, rows: [{ limit_count: 1, window_seconds: 61 }] },
  ])("rejects malformed or changed live rule %j", async (answer) => {
    const fixture = poolFor("SELECT limit_count", answer);
    await expect(new PostgresRateLimiter(fixture.pool, clock).hit(scope, "key", rule)).rejects.toBeInstanceOf(TypeError);
    expect(fixture.queries.some((sql) => sql.includes("INSERT INTO public.sec_rate_counters"))).toBe(false);
  });

  it("cannot skip a live rule mismatch by rereading a changing rows getter", async () => {
    let reads = 0;
    const answer = { command: "SELECT", rowCount: 1, get rows() { return ++reads === 1 ? [{ limit_count: 99, window_seconds: 60 }] : []; } };
    const fixture = poolFor("SELECT limit_count", answer);
    await expect(new PostgresRateLimiter(fixture.pool, clock).hit(scope, "key", rule)).rejects.toBeInstanceOf(TypeError);
    expect(reads).toBe(1);
  });

  it("captures a changing live-row array before checking its length or rule fields", async () => {
    let reads = 0;
    const rows = new Proxy([{ limit_count: 99, window_seconds: 60 }], {
      get(target, key, receiver) { return key === "length" ? (++reads === 1 ? 1 : 0) : Reflect.get(target, key, receiver); },
    });
    const fixture = poolFor("SELECT limit_count", { command: "SELECT", rowCount: 1, rows });
    await expect(new PostgresRateLimiter(fixture.pool, clock).hit(scope, "key", rule)).rejects.toBeInstanceOf(TypeError);
    expect(reads).toBe(1);
  });

  it.each([
    { command: "UPDATE", rowCount: 1, rows: [{ count: "1" }] },
    { command: "INSERT", rowCount: 0, rows: [{ count: "1" }] },
    { command: "INSERT", rowCount: 1, rows: [{ count: "1" }, { count: "2" }] },
    ...[1, "0", "-1", "1.0", "01", undefined].map((count) => ({ command: "INSERT", rowCount: 1, rows: [{ count }] })),
  ])("rejects malformed count result %j rather than returning allowed", async (answer) => {
    await expect(new PostgresRateLimiter(poolFor("INSERT INTO public.sec_rate_counters", answer).pool, clock).hit(scope, "key", rule)).rejects.toBeInstanceOf(TypeError);
  });

  it.each([
    { command: "UPDATE", rowCount: 1, rows: [{ blocked: false }] },
    { command: "SELECT", rowCount: 0, rows: [{ blocked: false }] },
    { command: "SELECT", rowCount: 1, rows: [{ blocked: false }, { blocked: true }] },
    ...[undefined, 0, "false", {}].map((blocked) => ({ command: "SELECT", rowCount: 1, rows: [{ blocked }] })),
  ])("rejects malformed block read %j", async (answer) => {
    await expect(new PostgresRateLimiter(poolFor("SELECT EXISTS", answer).pool, clock).isBlocked(scope, "key")).rejects.toBeInstanceOf(TypeError);
  });

  it.each([{ command: "UPDATE", rowCount: 1, rows: [] }, { command: "INSERT", rowCount: 0, rows: [] }])("rejects unconfirmed block write %j", async (answer) => {
    await expect(new PostgresRateLimiter(poolFor("INSERT INTO public.sec_rate_blocks", answer).pool, clock).block(scope, "key", 60)).rejects.toBeInstanceOf(TypeError);
  });

  it("requires exactly one database clock row", async () => {
    const fixture = poolFor("clock_timestamp()", { command: "SELECT", rowCount: 1, rows: [{ now: new Date() }, { now: new Date() }] });
    await expect(databaseNow(fixture.client as never)).rejects.toBeInstanceOf(TypeError);
  });

  it("has positive controls for a valid live rule, counter and block answer", async () => {
    const fixture = poolFor("SELECT limit_count", { command: "SELECT", rowCount: 1, rows: [{ limit_count: 1, window_seconds: 60 }] });
    expect(await new PostgresRateLimiter(fixture.pool, clock).hit(scope, "key", rule)).toEqual({ allowed: true, retryAfterSeconds: 0 });
    for (const blocked of [true, false]) expect(await new PostgresRateLimiter(poolFor("SELECT EXISTS", { command: "SELECT", rowCount: 1, rows: [{ blocked }] }).pool, clock).isBlocked(scope, "key")).toBe(blocked);
    expect(await new PostgresReplayGuard(poolFor("INSERT INTO public.sec_replay_claims", { command: "INSERT", rowCount: 1, rows: [] }).pool, clock).claim(scope, "key", 60)).toBe("claimed");
    expect(await new PostgresRateLimiter(poolFor("INSERT INTO public.sec_rate_counters", { command: "INSERT", rowCount: 1, rows: [{ count: "2" }] }).pool, clock).hit(scope, "key", rule)).toEqual({ allowed: false, retryAfterSeconds: 60 });
    const block = poolFor("INSERT INTO public.sec_rate_blocks", { command: "INSERT", rowCount: 1, rows: [] });
    await expect(new PostgresRateLimiter(block.pool, clock).block(scope, "key", 60)).resolves.toBeUndefined();
    expect(block.queries).toContain("COMMIT");
  });

  it.each([
    { command: "UPDATE", rowCount: 1, rows: [{ now: new Date("2020-01-01T00:00:00Z") }] },
    { command: "SELECT", rowCount: 0, rows: [{ now: new Date("2020-01-01T00:00:00Z") }] },
  ])("rejects mismatched clock metadata independently: %j", async (answer) => {
    await expect(databaseNow(poolFor("clock_timestamp()", answer).client as never)).rejects.toThrow("Invalid database clock result");
  });
});
