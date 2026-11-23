/**
 * The shared suites are only worth running against PostgreSQL if a broken PostgreSQL adapter can fail them. Each entry
 * below runs the REAL adapter against the REAL database through a pool that rewrites one statement (or one parameter) to
 * introduce a single defect; the named case must fail. A faithful run must pass every case, and every property that a
 * defect can break must be failed by at least one.
 *
 * A changed window may use a different primary key, so the live-rule pre-check and per-key lock are essential even though
 * the upsert has another rule guard. The shared live-rule case exercises different primary-key windows.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool, type PoolClient } from "pg";
import type { TenantScope } from "@dap/contracts";
import { PostgresRateLimiter } from "../postgres/rate-limiter.js";
import { PostgresReplayGuard } from "../postgres/replay.js";
import { TEST_CLOCK } from "../postgres/state-runtime.js";
import { withTenant } from "../postgres/tenant-tx.js";
import { rateLimiterConformanceCases, type RateLimiterConformanceCase } from "./rate-limiter.conformance.js";
import { replayConformanceCases, type ReplayConformanceCase } from "./replay.conformance.js";
import { openStatePools } from "./state-pg-fixtures.js";

/** The concurrent cases run 100 trials of 32-64 parallel statements; give them more than the default five seconds. */
const LONG = 60_000;
type Rewrite = (sql: string, params: unknown[] | undefined) => [string, unknown[] | undefined];
const find = <T extends { readonly name: string }>(cases: readonly T[], prefix: string): T => {
  const matches = cases.filter((entry) => entry.name.startsWith(prefix));
  if (matches.length !== 1) throw new Error(`expected exactly one case starting with "${prefix}", found ${matches.length}`);
  return matches[0]!;
};
/** null when the case passed; otherwise the error it failed with. */
const failure = async <C extends { run: (ctx: never) => Promise<void> }>(conformanceCase: C, ctx: Parameters<C["run"]>[0]): Promise<Error | null> => {
  try { await conformanceCase.run(ctx as never); return null; } catch (error) { return error as Error; }
};
/**
 * How a defect is caught. Normally by an ASSERTION about the property (never by a bind error or a typo in the rewrite);
 * "database" when a privilege or trigger of the schema itself refuses the broken statement (42501); "adapter" when the
 * adapter's own result check refuses it (a TypeError). Both of the latter are defence in depth, and are named as such.
 */
type Via = "assertion" | "database" | "adapter";
const caught = (error: Error | null, via: Via): boolean => {
  if (error === null) return false;
  if (via === "assertion") return error.name === "AssertionError";
  if (via === "database") return (error as { code?: unknown }).code === "42501";
  return error instanceof TypeError;
};

let app: Pool; let owner: Pool;
const tenants = new Set<string>();
const track = (scope: TenantScope | undefined): void => { const id = scope?.tenantId; if (typeof id === "string" && /^[0-9a-f-]{36}$/i.test(id)) tenants.add(id.toLowerCase()); };
beforeAll(async () => { ({ app, owner } = await openStatePools(Pool)); });
afterAll(async () => {
  try {
    if (owner) for (const tenantId of tenants) {
      await withTenant(owner, tenantId, async (client) => {
        await client.query("DELETE FROM public.sec_rate_counters WHERE tenant_id=$1", [tenantId]);
        await client.query("DELETE FROM public.sec_rate_blocks WHERE tenant_id=$1", [tenantId]);
        await client.query("DELETE FROM public.sec_replay_claims WHERE tenant_id=$1 AND expires_at <= clock_timestamp()", [tenantId]);
      });
    }
  } finally { await Promise.all([app?.end(), owner?.end()]); }
});

/** A pool whose clients run every statement through `rewrite`: the adapter under test is the real one. */
function rewritingPool(rewrite: Rewrite): Pool {
  return { connect: async () => {
    const client = await app.connect();
    return new Proxy(client, { get: (target, key) => {
      if (key === "query") return (sql: string, params?: unknown[]) => target.query(...rewrite(sql, params) as [string, unknown[]]);
      const value = Reflect.get(target, key) as unknown;
      return typeof value === "function" ? (value as (...args: unknown[]) => unknown).bind(target) : value;
    } }) as PoolClient;
  } } as unknown as Pool;
}
const swap = (from: string | RegExp, to: string): Rewrite => (sql, params) => [sql.replace(from, to), params];
const when = (marker: string, change: (params: unknown[]) => unknown[]): Rewrite => (sql, params) => [sql, sql.includes(marker) && params ? change([...params]) : params];

function replayContext(rewrite: Rewrite) {
  let now = Date.parse("2020-01-01T00:00:00Z");
  const store = new PostgresReplayGuard(rewritingPool(rewrite), { [TEST_CLOCK]: async () => new Date(now) });
  return { store: { claim: (scope: TenantScope, key: string, seconds: number) => { track(scope); return store.claim(scope, key, seconds); } }, advanceSeconds: async (seconds: number) => { now += seconds * 1000; } };
}
function limiterContext(rewrite: Rewrite) {
  let now = Date.parse("2020-01-01T00:00:00Z");
  const store = new PostgresRateLimiter(rewritingPool(rewrite), { [TEST_CLOCK]: async () => new Date(now) });
  return {
    store: {
      hit: (scope: TenantScope, key: string, rule: { limit: number; windowSeconds: number }) => { track(scope); return store.hit(scope, key, rule); },
      block: (scope: TenantScope, key: string, seconds: number) => { track(scope); return store.block(scope, key, seconds); },
      isBlocked: (scope: TenantScope, key: string) => { track(scope); return store.isBlocked(scope, key); },
    },
    advanceSeconds: async (seconds: number) => { now += seconds * 1000; },
  };
}
const faithful: Rewrite = (sql, params) => [sql, params];

// defect -> [case that must fail, rewrite]
const REPLAY: Record<string, [string, Rewrite, Via?]> = {
  "reclaims a claim that has NOT expired (DELETE without the expiry predicate)": ["uses a fixed retention boundary", swap(" AND expires_at <= $3", " AND $3::timestamptz IS NOT NULL")],
  "never reclaims an expired claim (DELETE is a no-op)": ["uses a fixed retention boundary", swap(/^DELETE FROM public\.sec_replay_claims.*$/s, "SELECT $1::text, $2::text, $3::timestamptz")],
  "treats the expiry instant as still live (< instead of <=)": ["uses a fixed retention boundary", swap("expires_at <= $3", "expires_at < $3")],
  "ignores the requested retention": ["honours the retention each claim asked for", when("INSERT INTO public.sec_replay_claims", (params) => { params[3] = 60; return params; })],
  "claims under a key that is never the same twice": ["exactly one of 32", when("INSERT INTO public.sec_replay_claims", (params) => { params[1] = `${String(params[1])}:${Math.random()}`; return params; })],
  "overwrites on conflict (the schema grants no UPDATE, so the database refuses)": ["exactly one of 32", swap("DO NOTHING", "DO UPDATE SET claimed_at=EXCLUDED.claimed_at"), "database"],
};
const LIMITER: Record<string, [string, Rewrite, Via?]> = {
  "ignores a different live rule at another primary-key window": ["rejects changing rules inside a live window", swap(/SELECT limit_count,window_seconds FROM public\.sec_rate_counters WHERE tenant_id=\$1 AND bucket_key=\$2 AND expires_at > \$3/, "SELECT limit_count,window_seconds FROM public.sec_rate_counters WHERE tenant_id=$1 AND bucket_key=$2 AND expires_at > $3 AND false")],
  "never counts (count+1 became count)": ["admits exactly `limit` sequential hits", swap("sec_rate_counters.count+1", "sec_rate_counters.count")],
  "anchors the window to the first hit": ["anchors every window to the epoch", (sql, params) => [sql, sql.includes("INSERT INTO public.sec_rate_counters") && params ? [params[0], params[1], params[6], new Date((params[6] as Date).getTime() + (params[5] as number) * 1000), ...params.slice(4)] : params]],
  "treats the block's expiry instant as still blocked (>= instead of >)": ["blocks only the scoped key", swap("expires_at > $3", "expires_at >= $3")],
  "replaces a block instead of extending it (GREATEST removed; the 051 trigger refuses the shortening)": ["blocks only the scoped key", swap("GREATEST(sec_rate_blocks.expires_at,EXCLUDED.expires_at)", "EXCLUDED.expires_at"), "database"],
  "reports an expired block as still blocked (no expiry test)": ["blocks only the scoped key", swap(" AND expires_at > $3) AS blocked", " AND $3::timestamptz IS NOT NULL) AS blocked")],
  "never extends a live block (DO NOTHING; the adapter's own row-count check refuses it)": ["concurrent blocks preserve", swap(/DO UPDATE SET expires_at=GREATEST\(sec_rate_blocks\.expires_at,EXCLUDED\.expires_at\)/, "DO NOTHING"), "adapter"],
};

describe("PostgreSQL replay conformance has teeth", () => {
  it.each(replayConformanceCases.map((entry) => [entry.name, entry] as [string, ReplayConformanceCase]))("a faithful run passes: %s", async (_name, conformanceCase) => {
    await conformanceCase.run(replayContext(faithful));
  }, LONG);
  it.each(Object.entries(REPLAY))("a replay adapter that %s fails its case", async (_defect, [prefix, rewrite, via = "assertion"]) => {
    expect(caught(await failure(find(replayConformanceCases, prefix), replayContext(rewrite)), via)).toBe(true);
  }, LONG);
});

describe("PostgreSQL rate limiter conformance has teeth", () => {
  it.each(rateLimiterConformanceCases.map((entry) => [entry.name, entry] as [string, RateLimiterConformanceCase]))("a faithful run passes: %s", async (_name, conformanceCase) => {
    await conformanceCase.run(limiterContext(faithful));
  }, LONG);
  it.each(Object.entries(LIMITER))("a rate limiter that %s fails its case", async (_defect, [prefix, rewrite, via = "assertion"]) => {
    expect(caught(await failure(find(rateLimiterConformanceCases, prefix), limiterContext(rewrite)), via)).toBe(true);
  }, LONG);
});

