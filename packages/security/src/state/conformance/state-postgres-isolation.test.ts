/**
 * Cross-connection behaviour the single-pool conformance cannot show: atomicity between independent pools (two replicas),
 * per-(tenant, key) lock scope (no cross-tenant lock sharing), and migrations that are ordered, checksummed and idempotent.
 */
import { createHash, randomUUID } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import type { TenantScope } from "@dap/contracts";
import { PostgresRateLimiter } from "../postgres/rate-limiter.js";
import { PostgresReplayGuard } from "../postgres/replay.js";
import { withTenant } from "../postgres/tenant-tx.js";
import { openStatePools } from "./state-pg-fixtures.js";

let app: Pool; let owner: Pool; let second: Pool;
const tenants = new Set<string>();
const fresh = (): TenantScope => { const tenantId = randomUUID(); tenants.add(tenantId); return { tenantId: tenantId as TenantScope["tenantId"] }; };
beforeAll(async () => { ({ app, owner } = await openStatePools(Pool)); second = new Pool({ connectionString: process.env.DAP_DATABASE_URL, max: 8 }); });
afterAll(async () => {
  try {
    if (owner) for (const tenantId of tenants) await withTenant(owner, tenantId, async (client) => {
      await client.query("DELETE FROM public.sec_rate_counters WHERE tenant_id=$1", [tenantId]);
      await client.query("DELETE FROM public.sec_rate_blocks WHERE tenant_id=$1", [tenantId]);
      await client.query("DELETE FROM public.sec_replay_claims WHERE tenant_id=$1 AND expires_at <= clock_timestamp()", [tenantId]);
    });
  } finally { await Promise.all([app?.end(), owner?.end(), second?.end()]); }
});

describe("two independent connection pools (two replicas) agree", () => {
  it("exactly one of 50 parallel claims across both pools wins, and the loser stays a duplicate", async () => {
    const scope = fresh(); const key = randomUUID();
    const guards = [new PostgresReplayGuard(app), new PostgresReplayGuard(second)];
    const results = await Promise.all(Array.from({ length: 50 }, (_, index) => guards[index % 2]!.claim(scope, key, 30)));
    expect(results.filter((result) => result === "claimed")).toHaveLength(1);
    expect(await guards[1]!.claim(scope, key, 30)).toBe("duplicate");
  });
  it("exactly `limit` of 40 parallel hits across both pools are allowed; both pools see the same block", async () => {
    const scope = fresh(); const key = randomUUID(); const rule = { limit: 10, windowSeconds: 31_536_000 };
    const limiters = [new PostgresRateLimiter(app), new PostgresRateLimiter(second)];
    const results = await Promise.all(Array.from({ length: 40 }, (_, index) => limiters[index % 2]!.hit(scope, key, rule)));
    expect(results.filter((result) => result.allowed)).toHaveLength(10);
    await limiters[0]!.block(scope, key, 60);
    expect(await limiters[1]!.isBlocked(scope, key)).toBe(true);
  });
});

describe("the per-key advisory lock is scoped to (tenant, key)", () => {
  const lockId = (tenantId: string, key: string) => owner.query("SELECT hashtextextended($1,0)::text AS id", [JSON.stringify([tenantId, key])]).then((result) => result.rows[0].id as string);
  const waiting = async (id: string): Promise<number> => (await owner.query("SELECT count(*)::int AS n FROM pg_locks WHERE locktype='advisory' AND NOT granted AND classid=(($1::bigint >> 32) & 4294967295)::oid AND objid=($1::bigint & 4294967295)::oid AND objsubid=1", [id])).rows[0].n as number;

  it("serializes hits on the same tenant and key, and never makes another tenant's identical key wait", async () => {
    const a = fresh(); const b = fresh(); const key = randomUUID(); const rule = { limit: 5, windowSeconds: 31_536_000 };
    const holder = await owner.connect();
    try {
      await holder.query("BEGIN");
      const id = await lockId(a.tenantId.toLowerCase(), key);
      await holder.query("SELECT pg_advisory_xact_lock($1::bigint)", [id]);
      const limiter = new PostgresRateLimiter(app);
      const before = await waiting(id);
      const pending = limiter.hit(a, key, rule);
      // Tenant B's identical key must complete while A's lock is still held (a shared lock would hang here).
      expect((await limiter.hit(b, key, rule)).allowed).toBe(true);
      for (let attempt = 0; attempt < 100 && (await waiting(id)) <= before; attempt++) await new Promise((resolve) => setTimeout(resolve, 20));
      expect(await waiting(id)).toBeGreaterThan(before);
      await holder.query("COMMIT");
      expect((await pending).allowed).toBe(true);
    } finally { await holder.query("ROLLBACK").catch(() => undefined); holder.release(); }
  });
});

describe("migrations are ordered, checksummed and idempotent", () => {
  const directory = new URL("../../../../../db/migrations/", import.meta.url);
  const sql = async (name: string) => readFile(new URL(name, directory), "utf8");
  it("applies in numeric order, with the hardening migrations after the tables they harden", async () => {
    const names = (await readdir(directory)).filter((name) => /^\d+_[a-z0-9_]+\.sql$/i.test(name)).sort((left, right) => left.localeCompare(right, "en", { numeric: true }));
    const at = (name: string) => names.indexOf(name);
    expect(at("040_sec_replay_claims.sql")).toBeGreaterThan(at("011_sec_tenant_action_policy_grants.sql"));
    expect(at("041_sec_replay_claims_delete_expired_only.sql")).toBe(at("040_sec_replay_claims.sql") + 1);
    expect(at("050_sec_rate_counters.sql")).toBeGreaterThan(at("041_sec_replay_claims_delete_expired_only.sql"));
    expect(at("051_sec_rate_state_monotonic.sql")).toBe(at("050_sec_rate_counters.sql") + 1);
  });
  it("every applied migration file still matches its recorded checksum", async () => {
    const { rows } = await owner.query("SELECT name, sha256 FROM dap_schema_migrations");
    const recorded = new Map(rows.map((row) => [row.name as string, row.sha256 as string]));
    for (const name of ["040_sec_replay_claims.sql", "041_sec_replay_claims_delete_expired_only.sql", "050_sec_rate_counters.sql", "051_sec_rate_state_monotonic.sql"]) {
      expect(recorded.get(name), name).toBe(createHash("sha256").update(await sql(name)).digest("hex"));
    }
  });
  it("re-applying 040, 041, 050 and 051 in order changes nothing: same policies, same triggers, same grants", async () => {
    const snapshot = async (client: import("pg").PoolClient) => ({
      policies: (await client.query("SELECT tablename, policyname, cmd, roles::text, qual, with_check FROM pg_policies WHERE tablename IN ('sec_replay_claims','sec_rate_counters','sec_rate_blocks') ORDER BY 1,2")).rows,
      triggers: (await client.query("SELECT tgrelid::regclass::text AS t, tgname FROM pg_trigger WHERE NOT tgisinternal AND tgrelid::regclass::text IN ('public.sec_rate_counters','public.sec_rate_blocks') ORDER BY 1,2")).rows,
      grants: (await client.query("SELECT table_name, privilege_type FROM information_schema.role_table_grants WHERE grantee='dap_app' AND table_name IN ('sec_replay_claims','sec_rate_counters','sec_rate_blocks') ORDER BY 1,2")).rows,
    });
    const client = await owner.connect();
    try {
      const before = await snapshot(client);
      await client.query("BEGIN");
      for (const name of ["040_sec_replay_claims.sql", "041_sec_replay_claims_delete_expired_only.sql", "050_sec_rate_counters.sql", "051_sec_rate_state_monotonic.sql"]) await client.query(await sql(name));
      expect(await snapshot(client)).toEqual(before);
    } finally { await client.query("ROLLBACK"); client.release(); }
  });
  it("refuses to run as anyone but dap_owner", async () => {
    for (const name of ["040_sec_replay_claims.sql", "041_sec_replay_claims_delete_expired_only.sql", "050_sec_rate_counters.sql", "051_sec_rate_state_monotonic.sql"]) {
      const client = await app.connect();
      try { await client.query("BEGIN"); await expect(client.query(await sql(name)), name).rejects.toThrow(); } finally { await client.query("ROLLBACK"); client.release(); }
    }
  });
});
