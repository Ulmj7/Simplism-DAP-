import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { readFile } from "node:fs/promises";
import { openStatePools, assertStateAcl } from "./state-pg-fixtures.js";

describe("T112 replay migration", () => {
  let app: Pool; let owner: Pool;
  beforeAll(async () => { ({ app, owner } = await openStatePools(Pool)); });
  afterAll(async () => { await Promise.all([app?.end(), owner?.end()]); });
  it("pins replay ownership, forced RLS, and SELECT/INSERT/DELETE only", async () => {
    await assertStateAcl(app, "sec_replay_claims", ["SELECT", "INSERT", "DELETE"]);
  });
  it("pins the composite primary key and column types", async () => {
    expect((await app.query("SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='public.sec_replay_claims'::regclass AND contype='p'")).rows).toEqual([{ definition: "PRIMARY KEY (tenant_id, namespace, claim_key)" }]);
    expect((await app.query("SELECT column_name,data_type,is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name='sec_replay_claims' ORDER BY ordinal_position")).rows).toEqual([
      { column_name: "tenant_id", data_type: "uuid", is_nullable: "NO" },
      { column_name: "namespace", data_type: "text", is_nullable: "NO" },
      { column_name: "claim_key", data_type: "text", is_nullable: "NO" },
      { column_name: "claimed_at", data_type: "timestamp with time zone", is_nullable: "NO" },
      { column_name: "expires_at", data_type: "timestamp with time zone", is_nullable: "NO" },
    ]);
  });
  it("reapplying preserves forced isolation when a transaction-local tenant setting becomes empty", async () => {
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await client.query(await readFile(new URL("../../../../../db/migrations/040_sec_replay_claims.sql", import.meta.url), "utf8"));
      await client.query("SELECT set_config('app.tenant_id','11111111-1111-4111-8111-111111111111',true)");
      await client.query("INSERT INTO public.sec_replay_claims VALUES ('11111111-1111-4111-8111-111111111111','mutation-probe','claim',now(),now()+interval '1 minute') ON CONFLICT DO NOTHING");
      await client.query("SELECT set_config('app.tenant_id','',true)");
      expect((await client.query("SELECT * FROM public.sec_replay_claims WHERE namespace='mutation-probe'")).rows).toEqual([]);
    } finally { await client.query("ROLLBACK"); client.release(); }
  });
  it("reapplying the migration removes accidental widened application grants", async () => {
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await client.query("GRANT UPDATE, TRUNCATE ON public.sec_replay_claims TO dap_app");
      await client.query(await readFile(new URL("../../../../../db/migrations/040_sec_replay_claims.sql", import.meta.url), "utf8"));
      for (const privilege of ["UPDATE", "TRUNCATE"]) expect((await client.query("SELECT has_table_privilege('dap_app','public.sec_replay_claims',$1) AS allowed", [privilege])).rows).toEqual([{ allowed: false }]);
    } finally { await client.query("ROLLBACK"); client.release(); }
  });
});
