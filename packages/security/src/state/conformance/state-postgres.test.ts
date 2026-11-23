import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import type { TenantScope } from "@dap/contracts";
import { PostgresReplayGuard } from "../postgres/replay.js";
import { PostgresRateLimiter } from "../postgres/rate-limiter.js";
import { TEST_CLOCK } from "../postgres/state-runtime.js";
import { withTenant } from "../postgres/tenant-tx.js";
import { runReplayConformance } from "./replay.conformance.js";
import { runRateLimiterConformance } from "./rate-limiter.conformance.js";
import { openStatePools } from "./state-pg-fixtures.js";
import { rollbackTenantPolicyProbe } from "./tenant-policy-fixtures.js";

let app: Pool; let owner: Pool;
const written = new Map<string, Set<string>>();
const a = { tenantId: randomUUID() as TenantScope["tenantId"] };
const b = { tenantId: randomUUID() as TenantScope["tenantId"] };
function track(scope: TenantScope, key: string): void {
  const tenantId = scope.tenantId.toLowerCase();
  if (!/^[a-f0-9-]{36}$/.test(tenantId) || key.includes("\u0000") || Buffer.byteLength(key) > 1024) return;
  let keys = written.get(tenantId);
  if (!keys) { keys = new Set(); written.set(tenantId, keys); }
  keys.add(key);
}
// Unique keys/scopes are recorded, not selected by a broad prefix, for fixture cleanup.
beforeAll(async () => { ({ app, owner } = await openStatePools(Pool)); });
afterAll(async () => {
  try {
    if (owner) for (const [tenantId, keys] of written) {
      await withTenant(owner, tenantId, async (client) => {
        await client.query("DELETE FROM public.sec_replay_claims WHERE tenant_id=$1 AND namespace='proposal' AND claim_key=ANY($2::text[])", [tenantId, [...keys]]);
        await client.query("DELETE FROM public.sec_rate_counters WHERE tenant_id=$1 AND bucket_key=ANY($2::text[])", [tenantId, [...keys]]);
        await client.query("DELETE FROM public.sec_rate_blocks WHERE tenant_id=$1 AND bucket_key=ANY($2::text[])", [tenantId, [...keys]]);
      });
    }
  } finally { await Promise.all([app?.end(), owner?.end()]); }
});

describe("PostgreSQL state shared conformance", () => {
  runReplayConformance(async () => {
    let now = Date.parse("2020-01-01T00:00:00Z");
    const store = new PostgresReplayGuard(app, { [TEST_CLOCK]: async () => new Date(now) });
    return { store: { claim: (scope, key, seconds) => { if (scope?.tenantId && typeof key === "string") track(scope, key); return store.claim(scope, key, seconds); } }, advanceSeconds: async (seconds) => { now += seconds * 1000; } };
  });
  runRateLimiterConformance(async () => {
    let now = Date.parse("2020-01-01T00:00:00Z");
    const store = new PostgresRateLimiter(app, { [TEST_CLOCK]: async () => new Date(now) });
    return {
      store: {
        hit: (scope, key, rule) => { if (scope?.tenantId && typeof key === "string") track(scope, key); return store.hit(scope, key, rule); },
        block: (scope, key, seconds) => { if (scope?.tenantId && typeof key === "string") track(scope, key); return store.block(scope, key, seconds); },
        isBlocked: (scope, key) => store.isBlocked(scope, key),
      },
      advanceSeconds: async (seconds) => { now += seconds * 1000; },
    };
  });
});

describe("T114 PostgreSQL durability and isolation", () => {
  it("claims survive a new adapter instance; one winner on expired-key reclamation", async () => {
    let now = Date.parse("2020-01-01T00:00:00Z");
    const options = { [TEST_CLOCK]: async () => new Date(now) };
    const key = randomUUID(); track(a, key);
    const first = new PostgresReplayGuard(app, options); const second = new PostgresReplayGuard(app, options);
    expect(await first.claim(a, key, 10)).toBe("claimed");
    expect(await second.claim(a, key, 10)).toBe("duplicate");
    now += 10000;
    const results = await Promise.all(Array.from({ length: 32 }, (_, index) => (index % 2 ? first : second).claim(a, key, 10)));
    expect(results.filter((item) => item === "claimed")).toHaveLength(1);
    expect(results.filter((item) => item === "duplicate")).toHaveLength(31);
  });
  it("rate counts and blocks persist across adapter instances and use database time by default", async () => {
    const key = randomUUID(); track(a, key);
    const rule = { limit: 1, windowSeconds: 31_536_000 };
    expect((await new PostgresRateLimiter(app).hit(a, key, rule)).allowed).toBe(true);
    expect((await new PostgresRateLimiter(app).hit(a, key, rule)).allowed).toBe(false);
    await new PostgresRateLimiter(app).block(a, key, 60);
    expect(await new PostgresRateLimiter(app).isBlocked(a, key)).toBe(true);
    const { rows: [row] } = await withTenant(app, a.tenantId, (client) => client.query("SELECT window_start <= clock_timestamp() AND expires_at > clock_timestamp() AS current FROM public.sec_rate_counters WHERE tenant_id=$1 AND bucket_key=$2", [a.tenantId, key]));
    expect(row.current).toBe(true);
  });
  it("allows a rule change after expiry even when the larger window reuses a historical primary key", async () => {
    let now = Date.parse("2020-01-01T00:00:00Z");
    const store = new PostgresRateLimiter(app, { [TEST_CLOCK]: async () => new Date(now) });
    const key = randomUUID(); track(a, key);
    expect((await store.hit(a, key, { limit: 1, windowSeconds: 1 })).allowed).toBe(true);
    now += 1000;
    expect((await store.hit(a, key, { limit: 1, windowSeconds: 60 })).allowed).toBe(true);
    expect((await store.hit(a, key, { limit: 1, windowSeconds: 60 })).allowed).toBe(false);
  });
  it("production clock is obtained from PostgreSQL, not the process or injected test time", async () => {
    const key = randomUUID(); track(a, key);
    const before = (await app.query("SELECT clock_timestamp() AS now")).rows[0].now as Date;
    expect(await new PostgresReplayGuard(app).claim(a, key, 60)).toBe("claimed");
    const after = (await app.query("SELECT clock_timestamp() AS now")).rows[0].now as Date;
    const { rows: [row] } = await withTenant(app, a.tenantId, (client) => client.query("SELECT claimed_at,expires_at FROM public.sec_replay_claims WHERE tenant_id=$1 AND namespace='proposal' AND claim_key=$2", [a.tenantId, key]));
    expect(row.claimed_at.getTime()).toBeGreaterThanOrEqual(before.getTime());
    expect(row.claimed_at.getTime()).toBeLessThanOrEqual(after.getTime());
    expect(row.expires_at.getTime() - row.claimed_at.getTime()).toBe(60000);
  });
  it("dap_app sees no tenant B rows as A or without a tenant, and cannot insert/update/delete foreign state", async () => {
    const key = randomUUID(); track(b, key);
    await new PostgresReplayGuard(app).claim(b, key, 60);
    const limiter = new PostgresRateLimiter(app);
    await limiter.hit(b, key, { limit: 1, windowSeconds: 60 }); await limiter.block(b, key, 60);
    const tables = ["sec_replay_claims", "sec_rate_counters", "sec_rate_blocks"] as const;
    const selects = [
      "SELECT * FROM public.sec_replay_claims WHERE claim_key=$1",
      "SELECT * FROM public.sec_rate_counters WHERE bucket_key=$1",
      "SELECT * FROM public.sec_rate_blocks WHERE bucket_key=$1",
    ];
    const client = await app.connect();
    try {
      await client.query("BEGIN"); await client.query("SELECT set_config('app.tenant_id',$1,true)", [a.tenantId]); await client.query("COMMIT");
      // The same connection now has app.tenant_id='', which requires NULLIF before UUID cast.
      for (const sql of selects) expect((await client.query(sql, [key])).rows).toEqual([]);
    } finally { client.release(); }
    for (const sql of selects) expect((await withTenant(app, a.tenantId, (client) => client.query(sql, [key]))).rows).toEqual([]);
    const inserts = [
      "INSERT INTO public.sec_replay_claims VALUES ($1,'proposal',$2,now(),now()+interval '1 minute')",
      "INSERT INTO public.sec_rate_counters VALUES ($1,$2,now(),1,now()+interval '1 minute',1,60)",
      "INSERT INTO public.sec_rate_blocks VALUES ($1,$2,now()+interval '1 minute')",
    ];
    for (const sql of inserts) await expect(rollbackTenantPolicyProbe(app, a.tenantId, (client) => client.query(sql, [b.tenantId, randomUUID()]))).rejects.toMatchObject({ code: "42501" });
    expect((await withTenant(app, a.tenantId, (client) => client.query("DELETE FROM public.sec_replay_claims WHERE claim_key=$1 RETURNING *", [key]))).rows).toEqual([]);
    for (const sql of ["UPDATE public.sec_rate_counters SET count=count+1 WHERE bucket_key=$1 RETURNING *", "UPDATE public.sec_rate_blocks SET expires_at=expires_at+interval '1 minute' WHERE bucket_key=$1 RETURNING *"]) expect((await withTenant(app, a.tenantId, (client) => client.query(sql, [key]))).rows).toEqual([]);
    for (const table of tables) {
      // Fixed SQL literals only: do not interpolate caller-controlled identifiers.
      const sql = { sec_replay_claims: "TRUNCATE public.sec_replay_claims", sec_rate_counters: "TRUNCATE public.sec_rate_counters", sec_rate_blocks: "TRUNCATE public.sec_rate_blocks" }[table];
      await expect(rollbackTenantPolicyProbe(app, a.tenantId, (client) => client.query(sql))).rejects.toMatchObject({ code: "42501" });
    }
    expect(await new PostgresReplayGuard(app).claim(b, key, 60)).toBe("duplicate");
    expect((await limiter.hit(b, key, { limit: 1, windowSeconds: 60 })).allowed).toBe(false);
    expect(await limiter.isBlocked(b, key)).toBe(true);
  });
});
