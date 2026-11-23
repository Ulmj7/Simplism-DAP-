import type { Pool } from "pg";
import type { RateLimiter, RateLimitResult, RateLimitRule, TenantScope } from "@dap/contracts";
import { withTenant } from "./tenant-tx.js";
import { snapshotAnswer } from "../../gateway/answer-snapshot.js";
import { captureStateInput, checkedDate, resolveStateClock, stateInteger, type PostgresStateTestOptions } from "./state-runtime.js";

export class PostgresRateLimiter implements RateLimiter {
  private readonly now: ReturnType<typeof resolveStateClock>;
  constructor(private readonly pool: Pool, options: PostgresStateTestOptions = {}) { this.now = resolveStateClock(options); }

  async hit(scope: TenantScope, bucketKey: string, rule: RateLimitRule): Promise<RateLimitResult> {
    const input = captureStateInput(scope, bucketKey);
    const limit = stateInteger(rule?.limit, 1_000_000);
    const windowSeconds = stateInteger(rule?.windowSeconds, 31_536_000);
    return withTenant(this.pool, input.tenantId, async (client) => {
      // Serialize rule checks as well as increments. Hash collisions only narrow throughput.
      await client.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [JSON.stringify([input.tenantId, input.key])]);
      const now = checkedDate(await this.now(client));
      const live = await client.query("SELECT limit_count,window_seconds FROM public.sec_rate_counters WHERE tenant_id=$1 AND bucket_key=$2 AND expires_at > $3", [input.tenantId, input.key, now]);
      const { command: liveCommand, rowCount: liveCount, rows: rawLiveRows } = live;
      const liveRows = snapshotAnswer(rawLiveRows);
      if (liveCommand !== "SELECT" || !Array.isArray(liveRows) || liveCount !== liveRows.length || liveRows.length > 1 || liveRows.some((row) => row.limit_count !== limit || row.window_seconds !== windowSeconds)) throw new TypeError("Cannot change a live rate limit rule");
      const windowMs = windowSeconds * 1000;
      const start = new Date(Math.floor(now.getTime() / windowMs) * windowMs);
      const expiresAt = new Date(start.getTime() + windowMs);
      checkedDate(start); checkedDate(expiresAt);
      const result = await client.query(
        `INSERT INTO public.sec_rate_counters (tenant_id,bucket_key,window_start,count,expires_at,limit_count,window_seconds)
         VALUES ($1,$2,$3,1,$4,$5,$6)
         ON CONFLICT (tenant_id,bucket_key,window_start)
         DO UPDATE SET count=CASE WHEN sec_rate_counters.expires_at <= $7 THEN 1 ELSE sec_rate_counters.count+1 END,
           expires_at=EXCLUDED.expires_at, limit_count=EXCLUDED.limit_count, window_seconds=EXCLUDED.window_seconds
         WHERE sec_rate_counters.expires_at <= $7 OR (sec_rate_counters.limit_count=EXCLUDED.limit_count AND sec_rate_counters.window_seconds=EXCLUDED.window_seconds)
         RETURNING count`,
        [input.tenantId, input.key, start, expiresAt, limit, windowSeconds, now],
      );
      const { command, rowCount, rows } = result;
      const raw: unknown = Array.isArray(rows) && rows.length === 1 ? rows[0]?.count : undefined;
      if (command !== "INSERT" || rowCount !== 1 || typeof raw !== "string" || !/^[1-9][0-9]*$/.test(raw)) throw new TypeError("Invalid rate count result");
      const allowed = BigInt(raw) <= BigInt(limit);
      return Object.freeze({ allowed, retryAfterSeconds: allowed ? 0 : Math.ceil((expiresAt.getTime() - now.getTime()) / 1000) });
    });
  }

  async isBlocked(scope: TenantScope, bucketKey: string): Promise<boolean> {
    const input = captureStateInput(scope, bucketKey);
    return withTenant(this.pool, input.tenantId, async (client) => {
      const now = checkedDate(await this.now(client));
      const result = await client.query("SELECT EXISTS (SELECT 1 FROM public.sec_rate_blocks WHERE tenant_id=$1 AND bucket_key=$2 AND expires_at > $3) AS blocked", [input.tenantId, input.key, now]);
      const { command, rowCount, rows } = result;
      const blocked: unknown = Array.isArray(rows) && rows.length === 1 ? rows[0]?.blocked : undefined;
      if (command !== "SELECT" || rowCount !== 1 || typeof blocked !== "boolean") throw new TypeError("Invalid rate block result");
      return blocked;
    });
  }

  async block(scope: TenantScope, bucketKey: string, seconds: number): Promise<void> {
    const input = captureStateInput(scope, bucketKey);
    const duration = stateInteger(seconds, 31_536_000);
    await withTenant(this.pool, input.tenantId, async (client) => {
      const now = checkedDate(await this.now(client));
      const result = await client.query(
        `INSERT INTO public.sec_rate_blocks (tenant_id,bucket_key,expires_at)
         VALUES ($1,$2,$3::timestamptz + $4 * interval '1 second')
         ON CONFLICT (tenant_id,bucket_key)
         DO UPDATE SET expires_at=GREATEST(sec_rate_blocks.expires_at,EXCLUDED.expires_at)`,
        [input.tenantId, input.key, now, duration],
      );
      if (result.command !== "INSERT" || result.rowCount !== 1) throw new TypeError("Invalid rate block write result");
    });
  }
}
