import { z } from "zod";
import type { Pool } from "pg";

/**
 * Scheduled maintenance (T118): deletes expired replay claims and rate counters/blocks. It must run
 * on the dap_owner pool: migration 060 gives that role, and only that role, an expired-rows-only
 * policy across tenants (the application role never purges). Expiry is judged by the DATABASE clock
 * inside the statement, never by a caller-supplied time.
 *
 * Each call deletes at most `batchSize` rows per table, oldest first, skipping rows another
 * transaction has locked (a concurrent claim or purge), so it never waits for or fights a claim.
 * Live rows can never match. Call repeatedly until it reports zero.
 */
export interface PurgeOptions {
  readonly batchSize?: number;
  /** Optional maintenance scope (1 to 1000 tenant UUIDs). It only narrows the purge; omitted means every tenant. */
  readonly tenantIds?: readonly string[];
}
export type PurgeResult = Readonly<{ replayClaims: number; rateCounters: number; rateBlocks: number }>;

const DEFAULT_BATCH = 1000;
const MAX_BATCH = 10_000;
const statement = (table: string): string =>
  `WITH doomed AS (SELECT ctid FROM public.${table} WHERE expires_at <= now() AND ($2::uuid[] IS NULL OR tenant_id = ANY($2::uuid[])) ORDER BY expires_at LIMIT $1 FOR UPDATE SKIP LOCKED)
   DELETE FROM public.${table} AS target USING doomed WHERE target.ctid = doomed.ctid`;
// Fixed table identifiers only; nothing caller-controlled reaches the SQL text.
const REPLAY = statement("sec_replay_claims");
const COUNTERS = statement("sec_rate_counters");
const BLOCKS = statement("sec_rate_blocks");

const uuid = z.uuid();
function captureScope(value: unknown): string[] | null {
  if (value === undefined) return null;
  if (!Array.isArray(value) || value.length < 1 || value.length > 1000) throw new TypeError("Invalid purge tenant scope");
  return value.map((item: unknown) => {
    if (!uuid.safeParse(item).success) throw new TypeError("Invalid purge tenant scope");
    return item as string;
  });
}

export async function purgeExpiredState(owner: Pool, options: PurgeOptions = {}): Promise<PurgeResult> {
  const requested: unknown = options?.batchSize;
  const batchSize = requested === undefined ? DEFAULT_BATCH : (requested as number);
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > MAX_BATCH) throw new TypeError("Invalid purge batch size");
  const scope = captureScope(options?.tenantIds);
  const client = await owner.connect();
  try {
    const role = await client.query("SELECT current_user AS name");
    if (role.rows[0]?.name !== "dap_owner") throw new Error("Purge must run as dap_owner");
    const deleted = async (sql: string): Promise<number> => {
      const result = await client.query(sql, [batchSize, scope]);
      return result.rowCount ?? 0;
    };
    return Object.freeze({ replayClaims: await deleted(REPLAY), rateCounters: await deleted(COUNTERS), rateBlocks: await deleted(BLOCKS) });
  } finally { client.release(); }
}
