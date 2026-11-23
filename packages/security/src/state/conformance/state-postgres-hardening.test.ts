/**
 * T112-T114 hardening, against the real database as the real least-privilege role dap_app. Tenant isolation (RLS) is only
 * half of "cannot tamper": inside ITS OWN tenant dap_app still holds DELETE on replay claims and UPDATE on the rate tables,
 * and a compromised or buggy application path with raw SQL must not be able to reset a replay claim, shorten a denial block
 * or rewind a counter. Every probe uses unique tenants and the database clock (never an injected one), so a row is live or
 * expired for real.
 */
import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import type { TenantScope } from "@dap/contracts";
import { PostgresRateLimiter } from "../postgres/rate-limiter.js";
import { PostgresReplayGuard } from "../postgres/replay.js";
import { withTenant } from "../postgres/tenant-tx.js";
import { openStatePools } from "./state-pg-fixtures.js";
import { rollbackTenantPolicyProbe } from "./tenant-policy-fixtures.js";

let app: Pool; let owner: Pool;
const tenants = new Set<string>();
const fresh = (): TenantScope => { const tenantId = randomUUID(); tenants.add(tenantId); return { tenantId: tenantId as TenantScope["tenantId"] }; };
beforeAll(async () => { ({ app, owner } = await openStatePools(Pool)); });
afterAll(async () => {
  try {
    if (owner) for (const tenantId of tenants) {
      await withTenant(owner, tenantId, async (client) => {
        // Live replay claims cannot be deleted by anyone but the purge once expired; the rest are removed here.
        await client.query("DELETE FROM public.sec_rate_counters WHERE tenant_id=$1", [tenantId]);
        await client.query("DELETE FROM public.sec_rate_blocks WHERE tenant_id=$1", [tenantId]);
        await client.query("DELETE FROM public.sec_replay_claims WHERE tenant_id=$1 AND expires_at <= clock_timestamp()", [tenantId]);
      });
    }
  } finally { await Promise.all([app?.end(), owner?.end()]); }
});
const tamper = (scope: TenantScope, sql: string, params: unknown[] = []) => rollbackTenantPolicyProbe(app, scope.tenantId, (client) => client.query(sql, params));
const commit = (scope: TenantScope, sql: string, params: unknown[] = []) => withTenant(app, scope.tenantId, (client) => client.query(sql, params));

describe("a replay claim cannot be reset with raw SQL", () => {
  it("dap_app cannot delete a LIVE claim of its own tenant, so the claim stays a duplicate", async () => {
    const scope = fresh(); const key = randomUUID(); const guard = new PostgresReplayGuard(app);
    expect(await guard.claim(scope, key, 30)).toBe("claimed");
    expect((await commit(scope, "DELETE FROM public.sec_replay_claims WHERE claim_key=$1 RETURNING claim_key", [key])).rowCount).toBe(0);
    expect((await commit(scope, "DELETE FROM public.sec_replay_claims RETURNING claim_key")).rowCount).toBe(0);
    expect(await guard.claim(scope, key, 30)).toBe("duplicate");
  });
  it("dap_app cannot hide a live claim by rewriting it either", async () => {
    const scope = fresh(); const key = randomUUID();
    await new PostgresReplayGuard(app).claim(scope, key, 30);
    await expect(tamper(scope, "UPDATE public.sec_replay_claims SET expires_at=now() WHERE claim_key=$1", [key])).rejects.toMatchObject({ code: "42501" });
  });
  it("dap_app can still delete a claim that has really expired, in its own tenant only", async () => {
    const scope = fresh(); const other = fresh(); const key = randomUUID();
    for (const who of [scope, other]) await commit(who, "INSERT INTO public.sec_replay_claims VALUES ($1,'proposal',$2,clock_timestamp()-interval '2 seconds',clock_timestamp()-interval '1 second')", [who.tenantId, key]);
    expect((await commit(scope, "DELETE FROM public.sec_replay_claims WHERE claim_key=$1 RETURNING claim_key", [key])).rowCount).toBe(1);
    expect((await commit(other, "SELECT 1 FROM public.sec_replay_claims WHERE claim_key=$1", [key])).rowCount).toBe(1);
  });
  it("the adapter still reclaims a claim once it has expired by the database clock", async () => {
    const scope = fresh(); const key = randomUUID();
    await commit(scope, "INSERT INTO public.sec_replay_claims VALUES ($1,'proposal',$2,clock_timestamp()-interval '2 seconds',clock_timestamp()-interval '1 second')", [scope.tenantId, key]);
    expect(await new PostgresReplayGuard(app).claim(scope, key, 30)).toBe("claimed");
    expect(await new PostgresReplayGuard(app).claim(scope, key, 30)).toBe("duplicate");
  });
});

describe("a denial block cannot be shortened or cleared with raw SQL", () => {
  it("refuses an UPDATE that moves expires_at earlier, accepts one that extends it, and refuses re-keying", async () => {
    const scope = fresh(); const key = randomUUID(); const limiter = new PostgresRateLimiter(app);
    await limiter.block(scope, key, 3600);
    await expect(tamper(scope, "UPDATE public.sec_rate_blocks SET expires_at=clock_timestamp() - interval '1 second' WHERE bucket_key=$1", [key])).rejects.toMatchObject({ code: "42501" });
    await expect(tamper(scope, "UPDATE public.sec_rate_blocks SET expires_at=expires_at - interval '1 millisecond' WHERE bucket_key=$1", [key])).rejects.toMatchObject({ code: "42501" });
    await expect(tamper(scope, "UPDATE public.sec_rate_blocks SET bucket_key=$2 WHERE bucket_key=$1", [key, randomUUID()])).rejects.toMatchObject({ code: "42501" });
    expect(await limiter.isBlocked(scope, key)).toBe(true);
    await expect(tamper(scope, "UPDATE public.sec_rate_blocks SET expires_at=expires_at + interval '1 minute' WHERE bucket_key=$1", [key])).resolves.toMatchObject({ rowCount: 1 });
  });
  it("cannot be deleted or truncated by dap_app", async () => {
    const scope = fresh(); const key = randomUUID();
    await new PostgresRateLimiter(app).block(scope, key, 3600);
    await expect(tamper(scope, "DELETE FROM public.sec_rate_blocks WHERE bucket_key=$1", [key])).rejects.toMatchObject({ code: "42501" });
    await expect(tamper(scope, "TRUNCATE public.sec_rate_blocks")).rejects.toMatchObject({ code: "42501" });
  });
});

describe("a live rate counter cannot be rewound or re-ruled with raw SQL", () => {
  const rule = { limit: 1, windowSeconds: 3600 };
  it("refuses lowering the count or changing window/rule columns while the window is live, but allows counting up", async () => {
    const scope = fresh(); const key = randomUUID(); const limiter = new PostgresRateLimiter(app);
    expect((await limiter.hit(scope, key, rule)).allowed).toBe(true);
    expect((await limiter.hit(scope, key, rule)).allowed).toBe(false);
    for (const set of ["count=0", "count=count-1", "limit_count=1000000", "window_seconds=1", "expires_at=expires_at+interval '1 hour'", "expires_at=clock_timestamp()", "window_start=window_start+interval '1 second'", "bucket_key=gen_random_uuid()::text"]) {
      await expect(tamper(scope, `UPDATE public.sec_rate_counters SET ${set} WHERE bucket_key=$1`, [key]), set).rejects.toMatchObject({ code: expect.stringMatching(/^(42501|23514)$/) });
    }
    expect((await limiter.hit(scope, key, rule)).allowed).toBe(false);
    await expect(tamper(scope, "UPDATE public.sec_rate_counters SET count=count+5 WHERE bucket_key=$1", [key])).resolves.toMatchObject({ rowCount: 1 });
  });
  it("allows rewriting a counter whose window has really expired (the adapter's own reset path)", async () => {
    const scope = fresh(); const key = randomUUID();
    await commit(scope, "INSERT INTO public.sec_rate_counters VALUES ($1,$2,clock_timestamp()-interval '2 seconds',5,clock_timestamp()-interval '1 second',1,1)", [scope.tenantId, key]);
    await expect(tamper(scope, "UPDATE public.sec_rate_counters SET count=1 WHERE bucket_key=$1", [key])).resolves.toMatchObject({ rowCount: 1 });
  });
  it("cannot be deleted or truncated by dap_app", async () => {
    const scope = fresh(); const key = randomUUID();
    await new PostgresRateLimiter(app).hit(scope, key, rule);
    await expect(tamper(scope, "DELETE FROM public.sec_rate_counters WHERE bucket_key=$1", [key])).rejects.toMatchObject({ code: "42501" });
    await expect(tamper(scope, "TRUNCATE public.sec_rate_counters")).rejects.toMatchObject({ code: "42501" });
  });
  it("fails closed, and leaves the row alone, when the bigint counter would overflow", async () => {
    const scope = fresh(); const key = randomUUID(); const limiter = new PostgresRateLimiter(app);
    await limiter.hit(scope, key, rule);
    await withTenant(owner, scope.tenantId, (client) => client.query("UPDATE public.sec_rate_counters SET count=9223372036854775806 WHERE bucket_key=$1", [key]));
    expect((await limiter.hit(scope, key, rule)).allowed).toBe(false);
    await expect(limiter.hit(scope, key, rule)).rejects.toThrow();
    const { rows } = await commit(scope, "SELECT count::text FROM public.sec_rate_counters WHERE bucket_key=$1", [key]);
    expect(rows).toEqual([{ count: "9223372036854775807" }]);
  });
});

describe("the role and the policies stay least-privilege", () => {
  const tables = ["sec_replay_claims", "sec_rate_counters", "sec_rate_blocks"];
  it("dap_app is neither superuser nor BYPASSRLS, is not a member of dap_owner, cannot create objects, has no role-level settings", async () => {
    expect((await app.query("SELECT rolsuper, rolbypassrls, rolinherit, rolcreaterole, rolcreatedb, rolreplication, rolconfig FROM pg_roles WHERE rolname='dap_app'")).rows).toEqual([{ rolsuper: false, rolbypassrls: false, rolinherit: false, rolcreaterole: false, rolcreatedb: false, rolreplication: false, rolconfig: null }]);
    expect((await app.query("SELECT pg_has_role('dap_app','dap_owner','MEMBER') AS member, pg_has_role('dap_app','dap_owner','USAGE') AS usable, has_schema_privilege('dap_app','public','CREATE') AS can_create")).rows).toEqual([{ member: false, usable: false, can_create: false }]);
    await expect(tamper(fresh(), "SET ROLE dap_owner")).rejects.toMatchObject({ code: "42501" });
  });
  it("defines no SECURITY DEFINER function and no function that could shadow what the adapters call", async () => {
    expect((await app.query("SELECT proname FROM pg_proc WHERE prosecdef AND pronamespace='public'::regnamespace")).rows).toEqual([]);
    expect((await app.query("SELECT proname FROM pg_proc WHERE pronamespace='public'::regnamespace AND proname IN ('clock_timestamp','now','hashtextextended','pg_advisory_xact_lock','set_config','current_setting','nullif')")).rows).toEqual([]);
  });
  it("every policy that can apply to dap_app keeps the NULLIF tenant form and none of them is permissive without a tenant", async () => {
    const { rows } = await app.query("SELECT tablename, policyname, cmd, roles::text AS roles, qual, with_check FROM pg_policies WHERE tablename = ANY($1) ORDER BY 1,2", [tables]);
    const applying = rows.filter((row) => /public|dap_app/.test(row.roles));
    expect(applying.length).toBeGreaterThanOrEqual(3);
    for (const row of applying) {
      for (const clause of [row.qual, row.with_check].filter((text) => text !== null)) {
        expect(clause, `${row.tablename}.${row.policyname}`).toMatch(/NULLIF\(current_setting\('app\.tenant_id'::text, true\), ''::text\)\)::uuid/);
        // Without the tenant comparison itself (whose current_setting(..., true) argument is the word true), nothing may be a blanket allow.
        expect(clause.replace(/NULLIF\(current_setting\('app\.tenant_id'::text, true\), ''::text\)/g, ""), `${row.tablename}.${row.policyname}`).not.toMatch(/\btrue\b/i);
      }
    }
    for (const table of tables) expect(applying.filter((row) => row.tablename === table && ["ALL", "SELECT"].includes(row.cmd)).length, table).toBeGreaterThan(0);
  });
  it("the policies that can delete replay claims for dap_app only admit expired rows", async () => {
    const { rows } = await app.query("SELECT policyname, cmd, qual FROM pg_policies WHERE tablename='sec_replay_claims' AND (roles::text ~ 'public|dap_app') AND cmd IN ('ALL','DELETE')");
    expect(rows.length).toBeGreaterThan(0);
    for (const row of rows) expect(row.qual, row.policyname).toMatch(/expires_at <= clock_timestamp\(\)/);
  });
});

describe("the production clock is the database's", () => {
  it("fails loudly, never skips, when the database environment is missing", async () => {
    const saved = { app: process.env.DAP_DATABASE_URL, owner: process.env.DAP_MIGRATE_DATABASE_URL };
    try {
      delete process.env.DAP_DATABASE_URL; delete process.env.DAP_MIGRATE_DATABASE_URL;
      await expect(openStatePools(Pool)).rejects.toThrow(/requires DAP_DATABASE_URL and DAP_MIGRATE_DATABASE_URL/);
    } finally { process.env.DAP_DATABASE_URL = saved.app; process.env.DAP_MIGRATE_DATABASE_URL = saved.owner; }
  });
});
