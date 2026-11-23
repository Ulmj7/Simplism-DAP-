import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { readFile } from "node:fs/promises";
import { openStatePools, assertStateAcl } from "./state-pg-fixtures.js";

describe("T113 rate migration", () => {
  let app: Pool; let owner: Pool;
  beforeAll(async () => { ({ app, owner } = await openStatePools(Pool)); });
  afterAll(async () => { await Promise.all([app?.end(), owner?.end()]); });
  it("pins forced RLS, ownership and SELECT/INSERT/UPDATE only for counters and blocks", async () => {
    await assertStateAcl(app, "sec_rate_counters", ["SELECT", "INSERT", "UPDATE"]);
    await assertStateAcl(app, "sec_rate_blocks", ["SELECT", "INSERT", "UPDATE"]);
    expect((await app.query("SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='public.sec_rate_counters'::regclass AND contype='p'")).rows).toEqual([{ definition: "PRIMARY KEY (tenant_id, bucket_key, window_start)" }]);
    expect((await app.query("SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='public.sec_rate_blocks'::regclass AND contype='p'")).rows).toEqual([{ definition: "PRIMARY KEY (tenant_id, bucket_key)" }]);
  });
  it("reapplying removes unwanted DELETE/TRUNCATE grants", async () => {
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await client.query("GRANT DELETE, TRUNCATE ON public.sec_rate_counters, public.sec_rate_blocks TO dap_app");
      await client.query(await readFile(new URL("../../../../../db/migrations/050_sec_rate_counters.sql", import.meta.url), "utf8"));
      for (const table of ["public.sec_rate_counters", "public.sec_rate_blocks"]) {
        for (const privilege of ["DELETE", "TRUNCATE"]) expect((await client.query("SELECT has_table_privilege('dap_app',$1,$2) AS allowed", [table, privilege])).rows).toEqual([{ allowed: false }]);
      }
    } finally { await client.query("ROLLBACK"); client.release(); }
  });
});
