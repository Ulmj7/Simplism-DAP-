import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { readFile } from "node:fs/promises";
import { openStatePools } from "./state-pg-fixtures.js";

describe("T118 purge migration", () => {
  let app: Pool; let owner: Pool;
  beforeAll(async () => { ({ app, owner } = await openStatePools(Pool)); });
  afterAll(async () => { await Promise.all([app?.end(), owner?.end()]); });
  const policies = "SELECT tablename, policyname, cmd, roles::text AS roles, qual, with_check FROM pg_policies WHERE schemaname='public' AND tablename IN ('sec_replay_claims','sec_rate_counters','sec_rate_blocks') ORDER BY tablename, policyname";
  it("is idempotent and restores widened or removed purge policies", async () => {
    const before = (await app.query(policies)).rows;
    expect(before).toHaveLength(14);
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await client.query("ALTER POLICY purge_expired_delete ON public.sec_replay_claims USING (true)");
      await client.query("DROP POLICY purge_expired_select ON public.sec_rate_blocks");
      await client.query(await readFile(new URL("../../../../../db/migrations/060_sec_state_purge.sql", import.meta.url), "utf8"));
      expect((await client.query(policies)).rows).toEqual(before);
    } finally { await client.query("ROLLBACK"); client.release(); }
  });
  it("refuses a state table without forced RLS", async () => {
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await client.query("ALTER TABLE public.sec_rate_blocks NO FORCE ROW LEVEL SECURITY");
      const migration = await readFile(new URL("../../../../../db/migrations/060_sec_state_purge.sql", import.meta.url), "utf8");
      await expect(client.query(migration)).rejects.toThrow("State tables must be owned by dap_owner with forced row level security");
    } finally { await client.query("ROLLBACK"); client.release(); }
  });
  it("only dap_owner may apply it", async () => {
    const client = await app.connect();
    try {
      await expect(client.query(await readFile(new URL("../../../../../db/migrations/060_sec_state_purge.sql", import.meta.url), "utf8"))).rejects.toThrow();
    } finally { client.release(); }
  });
});
