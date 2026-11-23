import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import type { TenantId } from "@dap/contracts";
import { PostgresRateLimiter } from "../postgres/rate-limiter.js";
import { PostgresReplayGuard } from "../postgres/replay.js";
import { purgeExpiredState } from "../postgres/purge.js";
import { withTenant } from "../postgres/tenant-tx.js";
import { openStatePools } from "./state-pg-fixtures.js";
import { rollbackTenantPolicyProbe } from "./tenant-policy-fixtures.js";

let app: Pool; let owner: Pool;
const tenants = new Set<string>();
const newTenant = (): TenantId => { const id = randomUUID() as TenantId; tenants.add(id); return id; };
beforeAll(async () => { ({ app, owner } = await openStatePools(Pool)); });
afterAll(async () => {
  try {
    if (owner) for (const tenantId of tenants) await withTenant(owner, tenantId, async (client) => {
      for (const table of ["sec_replay_claims", "sec_rate_counters", "sec_rate_blocks"]) await client.query(`DELETE FROM public.${table} WHERE tenant_id=$1`, [tenantId]);
    });
  } finally { await Promise.all([app?.end(), owner?.end()]); }
});

const EXPIRED = -3600;
const LIVE = 3600;
async function seed(tenantId: TenantId, key: string, offsetSeconds: number): Promise<void> {
  await withTenant(owner, tenantId, async (client) => {
    await client.query("INSERT INTO public.sec_replay_claims (tenant_id,namespace,claim_key,claimed_at,expires_at) VALUES ($1,'proposal',$2,clock_timestamp()-interval '2 hours',clock_timestamp()+$3*interval '1 second')", [tenantId, key, offsetSeconds]);
    await client.query("INSERT INTO public.sec_rate_counters (tenant_id,bucket_key,window_start,count,expires_at,limit_count,window_seconds) VALUES ($1,$2,clock_timestamp()-interval '2 hours',1,clock_timestamp()+$3*interval '1 second',1,60)", [tenantId, key, offsetSeconds]);
    await client.query("INSERT INTO public.sec_rate_blocks (tenant_id,bucket_key,expires_at) VALUES ($1,$2,clock_timestamp()+$3*interval '1 second')", [tenantId, key, offsetSeconds]);
  });
}
async function present(tenantId: TenantId, key?: string): Promise<{ claims: number; counters: number; blocks: number }> {
  return withTenant(owner, tenantId, async (client) => {
    const count = async (table: string, column: string): Promise<number> => Number((await client.query(`SELECT count(*) AS n FROM public.${table} WHERE tenant_id=$1 AND ($2::text IS NULL OR ${column}=$2)`, [tenantId, key ?? null])).rows[0].n);
    return { claims: await count("sec_replay_claims", "claim_key"), counters: await count("sec_rate_counters", "bucket_key"), blocks: await count("sec_rate_blocks", "bucket_key") };
  });
}
/** Scoped to the test's own tenants: purging database-wide would delete rows other test files rely on. */
async function drain(...scope: TenantId[]): Promise<void> {
  for (let round = 0; round < 1000; round++) {
    const result = await purgeExpiredState(owner, { batchSize: 10_000, tenantIds: scope });
    if (result.replayClaims + result.rateCounters + result.rateBlocks === 0) return;
  }
  throw new Error("purge did not drain");
}

describe("T118 purge: deletes only expired rows, across tenants, through the owner path", () => {
  it("removes expired claims, counters and blocks of every tenant and keeps live rows", async () => {
    const a = newTenant(); const b = newTenant(); const c = newTenant();
    for (const tenant of [a, b, c]) { await seed(tenant, "expired", EXPIRED); await seed(tenant, "live", LIVE); }
    await drain(a, b, c);
    for (const tenant of [a, b, c]) {
      expect(await present(tenant, "expired")).toEqual({ claims: 0, counters: 0, blocks: 0 });
      expect(await present(tenant, "live")).toEqual({ claims: 1, counters: 1, blocks: 1 });
    }
  });

  it("reports what it deleted per table and is idempotent", async () => {
    const tenant = newTenant();
    for (let index = 0; index < 3; index++) await seed(tenant, `expired-${index}`, EXPIRED);
    expect(await purgeExpiredState(owner, { tenantIds: [tenant] })).toEqual({ replayClaims: 3, rateCounters: 3, rateBlocks: 3 });
    expect(await purgeExpiredState(owner, { tenantIds: [tenant] })).toEqual({ replayClaims: 0, rateCounters: 0, rateBlocks: 0 });
  });

  it("is bounded per call by the batch size", async () => {
    const tenant = newTenant();
    for (let index = 0; index < 25; index++) await seed(tenant, `bulk-${index}`, EXPIRED);
    const first = await purgeExpiredState(owner, { batchSize: 10, tenantIds: [tenant] });
    expect(first).toEqual({ replayClaims: 10, rateCounters: 10, rateBlocks: 10 });
    expect(await present(tenant)).toEqual({ claims: 15, counters: 15, blocks: 15 });
    await purgeExpiredState(owner, { batchSize: 1, tenantIds: [tenant] });
    expect(await present(tenant)).toEqual({ claims: 14, counters: 14, blocks: 14 });
    await drain(tenant);
    expect(await present(tenant)).toEqual({ claims: 0, counters: 0, blocks: 0 });
  });

  it("a tenant scope purges only those tenants", async () => {
    const mine = newTenant(); const other = newTenant();
    await seed(mine, "dead", EXPIRED); await seed(other, "dead", EXPIRED);
    expect(await purgeExpiredState(owner, { tenantIds: [mine] })).toEqual({ replayClaims: 1, rateCounters: 1, rateBlocks: 1 });
    expect(await present(mine, "dead")).toEqual({ claims: 0, counters: 0, blocks: 0 });
    expect(await present(other, "dead")).toEqual({ claims: 1, counters: 1, blocks: 1 });
    await drain(other);
  });

  it.each([[[]], [["not-a-uuid"]], ["11111111-1111-4111-8111-111111111111"], [[5]], [[null]], [Array.from({ length: 1001 }, () => "11111111-1111-4111-8111-111111111111")]])("rejects tenant scope %j", async (tenantIds) => {
    const tenant = newTenant();
    await seed(tenant, "kept", EXPIRED);
    await expect(purgeExpiredState(owner, { tenantIds: tenantIds as never })).rejects.toThrow("Invalid purge");
    expect(await present(tenant, "kept")).toEqual({ claims: 1, counters: 1, blocks: 1 });
    await drain(tenant);
  });

  it("without a scope it purges every tenant (the scheduled job)", async () => {
    const a = newTenant(); const b = newTenant();
    await seed(a, "dead", EXPIRED); await seed(b, "dead", EXPIRED); await seed(b, "live", LIVE);
    for (let round = 0; round < 1000; round++) {
      const result = await purgeExpiredState(owner, { batchSize: 10_000 });
      if (result.replayClaims + result.rateCounters + result.rateBlocks === 0) break;
    }
    expect(await present(a, "dead")).toEqual({ claims: 0, counters: 0, blocks: 0 });
    expect(await present(b, "dead")).toEqual({ claims: 0, counters: 0, blocks: 0 });
    expect(await present(b, "live")).toEqual({ claims: 1, counters: 1, blocks: 1 });
  });

  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 10_001, "5", null])("rejects batch size %j without touching the database", async (batchSize) => {
    const tenant = newTenant();
    await seed(tenant, "kept", EXPIRED);
    await expect(purgeExpiredState(owner, { batchSize: batchSize as number, tenantIds: [tenant] })).rejects.toThrow("Invalid purge");
    expect(await present(tenant, "kept")).toEqual({ claims: 1, counters: 1, blocks: 1 });
    await drain(tenant);
  });

  it("refuses to run as the application role and deletes nothing", async () => {
    const tenant = newTenant();
    await seed(tenant, "kept", EXPIRED);
    await expect(purgeExpiredState(app, { tenantIds: [tenant] })).rejects.toThrow(/dap_owner/);
    expect(await present(tenant, "kept")).toEqual({ claims: 1, counters: 1, blocks: 1 });
    await drain(tenant);
  });

  it("skips rows locked by a concurrent transaction instead of waiting for them", async () => {
    const tenant = newTenant();
    await seed(tenant, "locked", EXPIRED); await seed(tenant, "free", EXPIRED);
    const holder = await owner.connect();
    const purger = new Pool({ connectionString: process.env.DAP_MIGRATE_DATABASE_URL, max: 1, statement_timeout: 1000 });
    try {
      await holder.query("BEGIN");
      await holder.query("SELECT set_config('app.tenant_id',$1,true)", [tenant]);
      for (const [table, column] of [["sec_replay_claims", "claim_key"], ["sec_rate_counters", "bucket_key"], ["sec_rate_blocks", "bucket_key"]] as const) {
        expect((await holder.query(`SELECT 1 FROM public.${table} WHERE tenant_id=$1 AND ${column}='locked' FOR UPDATE`, [tenant])).rowCount).toBe(1);
      }
      expect(await purgeExpiredState(purger, { batchSize: 10_000, tenantIds: [tenant] })).toEqual({ replayClaims: 1, rateCounters: 1, rateBlocks: 1 });
      expect(await present(tenant, "locked")).toEqual({ claims: 1, counters: 1, blocks: 1 });
      expect(await present(tenant, "free")).toEqual({ claims: 0, counters: 0, blocks: 0 });
    } finally { await holder.query("ROLLBACK"); holder.release(); await purger.end(); }
    await drain(tenant);
    expect(await present(tenant, "locked")).toEqual({ claims: 0, counters: 0, blocks: 0 });
  });
});

describe("T118 purge: privileges stay minimal", () => {
  it("pins the exact policy set: tenant isolation for everyone, expired-only select/lock/delete for dap_owner", async () => {
    const { rows } = await app.query("SELECT tablename, policyname, cmd, roles::text AS roles, qual, with_check FROM pg_policies WHERE schemaname='public' AND tablename IN ('sec_replay_claims','sec_rate_counters','sec_rate_blocks') ORDER BY tablename, policyname");
    const isolation = "(tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)";
    const expired = "(expires_at <= now())";
    expect(rows).toEqual(["sec_rate_blocks", "sec_rate_counters", "sec_replay_claims"].flatMap((tablename) => [
      { tablename, policyname: "purge_expired_delete", cmd: "DELETE", roles: "{dap_owner}", qual: expired, with_check: null },
      { tablename, policyname: "purge_expired_lock", cmd: "UPDATE", roles: "{dap_owner}", qual: expired, with_check: "false" },
      { tablename, policyname: "purge_expired_select", cmd: "SELECT", roles: "{dap_owner}", qual: expired, with_check: null },
      ...(tablename === "sec_replay_claims" ? [
        { tablename, policyname: "tenant_delete_expired", cmd: "DELETE", roles: "{public}", qual: `(${isolation} AND (expires_at <= clock_timestamp()))`, with_check: null },
        { tablename, policyname: "tenant_insert", cmd: "INSERT", roles: "{public}", qual: null, with_check: isolation },
        { tablename, policyname: "tenant_select", cmd: "SELECT", roles: "{public}", qual: isolation, with_check: null },
      ] : [{ tablename, policyname: "tenant_isolation", cmd: "ALL", roles: "{public}", qual: isolation, with_check: isolation }]),
    ]));
  });

  it("the SQL expiry predicate also protects live rate rows when an owner connection already has tenant scope", async () => {
    const tenant = newTenant(); await seed(tenant, "live-scoped", LIVE); await seed(tenant, "dead-scoped", EXPIRED);
    const scoped = new Pool({ connectionString: process.env.DAP_MIGRATE_DATABASE_URL, max: 1, connectionTimeoutMillis: 2000 });
    try {
      await scoped.query("SELECT set_config('app.tenant_id',$1,false)", [tenant]);
      expect(await purgeExpiredState(scoped, { tenantIds: [tenant] })).toEqual({ replayClaims: 1, rateCounters: 1, rateBlocks: 1 });
      expect(await present(tenant, "live-scoped")).toEqual({ claims: 1, counters: 1, blocks: 1 });
    } finally { await scoped.query("RESET app.tenant_id"); await scoped.end(); }
  });

  it("the owner path cannot read, change or delete live rows, or insert without a tenant", async () => {
    const tenant = newTenant();
    await seed(tenant, "live", LIVE); await seed(tenant, "dead", EXPIRED);
    for (const [table, column] of [["sec_replay_claims", "claim_key"], ["sec_rate_counters", "bucket_key"], ["sec_rate_blocks", "bucket_key"]] as const) {
      const client = await owner.connect();
      try {
        await client.query("BEGIN");
        expect((await client.query(`SELECT ${column} FROM public.${table} WHERE tenant_id=$1 AND ${column}='live'`, [tenant])).rows).toEqual([]);
        expect((await client.query(`DELETE FROM public.${table} WHERE tenant_id=$1 AND ${column}='live' RETURNING 1`, [tenant])).rows).toEqual([]);
        expect((await client.query(`UPDATE public.${table} SET expires_at=expires_at WHERE tenant_id=$1 AND ${column}='live' RETURNING 1`, [tenant])).rows).toEqual([]);
        // Expired rows may be read and deleted, never modified.
        expect((await client.query(`SELECT ${column} FROM public.${table} WHERE tenant_id=$1 AND ${column}='dead'`, [tenant])).rows).toHaveLength(1);
        await expect(client.query(`UPDATE public.${table} SET expires_at=expires_at WHERE tenant_id=$1 AND ${column}='dead'`, [tenant])).rejects.toMatchObject({ code: "42501" });
      } finally { await client.query("ROLLBACK"); client.release(); }
    }
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await expect(client.query("INSERT INTO public.sec_rate_blocks VALUES ($1,'x',now()-interval '1 minute')", [tenant])).rejects.toMatchObject({ code: "42501" });
    } finally { await client.query("ROLLBACK"); client.release(); }
    await drain(tenant);
  });

  it("the owner-only purge policies never let dap_app reset its own live replay claim", async () => {
    const tenant = newTenant();
    await seed(tenant, "live-replay", LIVE);
    const deleted = await rollbackTenantPolicyProbe(app, tenant, (client) => client.query("DELETE FROM public.sec_replay_claims WHERE tenant_id=$1 AND claim_key=$2 RETURNING 1", [tenant, "live-replay"]));
    expect(deleted.rows).toEqual([]);
    expect(await present(tenant, "live-replay")).toEqual({ claims: 1, counters: 1, blocks: 1 });
    expect(await new PostgresReplayGuard(app).claim({ tenantId: tenant }, "live-replay", 60)).toBe("duplicate");
  });

  it("dap_app can never purge another tenant's expired rows, or read them", async () => {
    const a = newTenant(); const b = newTenant();
    await seed(b, "dead", EXPIRED);
    expect((await rollbackTenantPolicyProbe(app, a, (client) => client.query("DELETE FROM public.sec_replay_claims WHERE claim_key='dead' RETURNING 1"))).rows).toEqual([]);
    expect((await rollbackTenantPolicyProbe(app, a, (client) => client.query("SELECT 1 FROM public.sec_replay_claims WHERE claim_key='dead'"))).rows).toEqual([]);
    expect((await rollbackTenantPolicyProbe(app, a, (client) => client.query("SELECT 1 FROM public.sec_rate_counters WHERE bucket_key='dead'"))).rows).toEqual([]);
    const noTenant = await app.connect();
    try { expect((await noTenant.query("SELECT 1 FROM public.sec_replay_claims WHERE claim_key='dead'")).rows).toEqual([]); } finally { noTenant.release(); }
    expect(await present(b, "dead")).toEqual({ claims: 1, counters: 1, blocks: 1 });
    await drain(b);
  });
});

describe("T118 purge: safe to run concurrently with claims and counting", () => {
  it("expired claims are reclaimed by exactly one claimer per key while purges run, and live claims survive", async () => {
    const tenant = newTenant();
    const keys = Array.from({ length: 16 }, (_, index) => `race-${index}`);
    for (const key of keys) await seed(tenant, key, EXPIRED);
    const guards = [new PostgresReplayGuard(app), new PostgresReplayGuard(app)];
    const purgers = Array.from({ length: 3 }, async () => { for (let round = 0; round < 6; round++) await purgeExpiredState(owner, { batchSize: 8, tenantIds: [tenant] }); });
    const claims = keys.map((key) => Promise.all(Array.from({ length: 4 }, (_, index) => guards[index % 2]!.claim({ tenantId: tenant }, key, 3600))));
    const results = await Promise.all([...claims, ...purgers]);
    for (const result of results.slice(0, keys.length) as string[][]) {
      expect(result.filter((item) => item === "claimed")).toHaveLength(1);
      expect(result.filter((item) => item === "duplicate")).toHaveLength(3);
    }
    await drain(tenant);
    for (const key of keys) expect(await guards[0]!.claim({ tenantId: tenant }, key, 3600)).toBe("duplicate");
  });

  it("rate counts stay exact while expired rows are purged", async () => {
    const tenant = newTenant();
    const bucket = "race-rate";
    await seed(tenant, bucket, EXPIRED);
    const limiter = new PostgresRateLimiter(app);
    const purgers = Array.from({ length: 3 }, async () => { for (let round = 0; round < 6; round++) await purgeExpiredState(owner, { batchSize: 8, tenantIds: [tenant] }); });
    const hits = await Promise.all([...Array.from({ length: 24 }, () => limiter.hit({ tenantId: tenant }, bucket, { limit: 5, windowSeconds: 3600 })), ...purgers]);
    expect((hits.slice(0, 24) as Array<{ allowed: boolean }>).filter((item) => item.allowed)).toHaveLength(5);
    await limiter.block({ tenantId: tenant }, bucket, 3600);
    await drain(tenant);
    expect(await limiter.isBlocked({ tenantId: tenant }, bucket)).toBe(true);
    expect((await limiter.hit({ tenantId: tenant }, bucket, { limit: 5, windowSeconds: 3600 })).allowed).toBe(false);
  });

  it("concurrent purges never double count or lose a row", async () => {
    const tenant = newTenant();
    for (let index = 0; index < 40; index++) await seed(tenant, `dup-${index}`, EXPIRED);
    const results = await Promise.all(Array.from({ length: 4 }, () => purgeExpiredState(owner, { batchSize: 100, tenantIds: [tenant] })));
    expect(results.reduce((sum, item) => sum + item.replayClaims, 0)).toBe(40);
    expect(results.reduce((sum, item) => sum + item.rateCounters, 0)).toBe(40);
    expect(results.reduce((sum, item) => sum + item.rateBlocks, 0)).toBe(40);
  });
});
