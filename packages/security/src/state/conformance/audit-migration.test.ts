import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { readFile } from "node:fs/promises";
import { AUDIT_EVENT_TYPES, OUTCOMES, RISK_LEVELS, REASON_CODES } from "@dap/contracts";
import { assertStateAcl, openStatePools } from "./state-pg-fixtures.js";

const MIGRATION = new URL("../../../../../db/migrations/020_sec_audit_events.sql", import.meta.url);

/** T093: the audit table is append-only, tenant-isolated and holds exactly the AuditEvent contract (plus a commit-order column). */
describe("T093 audit migration", () => {
  let app: Pool; let owner: Pool;
  beforeAll(async () => { ({ app, owner } = await openStatePools(Pool)); });
  afterAll(async () => { await Promise.all([app?.end(), owner?.end()]); });

  it("pins ownership, forced RLS, and SELECT/INSERT only for dap_app (no UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER; nothing for PUBLIC)", async () => {
    await assertStateAcl(app, "sec_audit_events", ["SELECT", "INSERT"]);
  });

  it("has exactly the AuditEvent contract's columns, with the contract's nullability", async () => {
    expect((await app.query("SELECT column_name,data_type,is_nullable FROM information_schema.columns WHERE table_schema='public' AND table_name='sec_audit_events' ORDER BY ordinal_position")).rows).toEqual([
      { column_name: "seq", data_type: "bigint", is_nullable: "NO" },
      { column_name: "id", data_type: "uuid", is_nullable: "NO" },
      { column_name: "tenant_id", data_type: "uuid", is_nullable: "NO" },
      { column_name: "occurred_at", data_type: "timestamp with time zone", is_nullable: "NO" },
      { column_name: "event_type", data_type: "text", is_nullable: "NO" },
      { column_name: "request_id", data_type: "text", is_nullable: "NO" },
      { column_name: "decision_id", data_type: "text", is_nullable: "NO" },
      { column_name: "user_id", data_type: "text", is_nullable: "NO" },
      { column_name: "ai_session_id", data_type: "text", is_nullable: "NO" },
      { column_name: "turn_id", data_type: "text", is_nullable: "NO" },
      { column_name: "model", data_type: "text", is_nullable: "NO" },
      { column_name: "action_id", data_type: "text", is_nullable: "YES" },
      { column_name: "definition_version", data_type: "bigint", is_nullable: "YES" },
      { column_name: "params_view", data_type: "jsonb", is_nullable: "NO" },
      { column_name: "risk", data_type: "text", is_nullable: "YES" },
      { column_name: "outcome", data_type: "text", is_nullable: "YES" },
      { column_name: "reason", data_type: "text", is_nullable: "YES" },
      { column_name: "confirmation_id", data_type: "uuid", is_nullable: "YES" },
      { column_name: "confirmation_state", data_type: "text", is_nullable: "YES" },
      { column_name: "execution_result", data_type: "text", is_nullable: "YES" },
      { column_name: "resource_type", data_type: "text", is_nullable: "YES" },
      { column_name: "resource_id", data_type: "text", is_nullable: "YES" },
    ]);
  });

  it("uses the same forced tenant policy form as the other state tables, for every command", async () => {
    expect((await app.query("SELECT policyname, cmd, roles::text AS roles, qual, with_check FROM pg_policies WHERE schemaname='public' AND tablename='sec_audit_events'")).rows).toEqual([{
      policyname: "tenant_isolation", cmd: "ALL", roles: "{public}",
      qual: "(tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)",
      with_check: "(tenant_id = (NULLIF(current_setting('app.tenant_id'::text, true), ''::text))::uuid)",
    }]);
  });

  it("pins the primary key and the three reviewer indexes", async () => {
    expect((await app.query("SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='public.sec_audit_events'::regclass AND contype='p'")).rows).toEqual([{ definition: "PRIMARY KEY (id)" }]);
    const indexes = (await app.query("SELECT indexname, indexdef FROM pg_indexes WHERE schemaname='public' AND tablename='sec_audit_events' ORDER BY indexname")).rows as { indexname: string; indexdef: string }[];
    const columns = indexes.filter((index) => index.indexname !== "sec_audit_events_pkey").map((index) => /\((.*)\)/.exec(index.indexdef)![1]);
    expect(columns.sort()).toEqual(["tenant_id, occurred_at, seq", "tenant_id, request_id", "tenant_id, user_id, occurred_at"].sort());
  });

  it("closes the enums the contract closes (event type, outcome, risk, confirmation state, execution result)", async () => {
    const checks = (await app.query("SELECT pg_get_constraintdef(oid) AS definition FROM pg_constraint WHERE conrelid='public.sec_audit_events'::regclass AND contype='c'")).rows.map((row) => row.definition as string).join("\n");
    for (const value of [...AUDIT_EVENT_TYPES, ...OUTCOMES, ...RISK_LEVELS, ...REASON_CODES, "pending", "accepted", "rejected", "invalidated", "success", "failure"]) expect(checks, value).toContain(`'${value}'`);
  });

  it("refuses UPDATE, DELETE and TRUNCATE for everyone through triggers, the owner included (row changes are proven in state-postgres-audit.test.ts)", async () => {
    expect((await owner.query("SELECT tgname, tgtype::int AS type FROM pg_trigger WHERE tgrelid='public.sec_audit_events'::regclass AND NOT tgisinternal ORDER BY tgname")).rows.map((row) => row.tgname)).toEqual(["sec_audit_events_no_row_change", "sec_audit_events_no_truncate"]);
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await expect(client.query("TRUNCATE public.sec_audit_events")).rejects.toThrow(/append-only/);
    } finally { await client.query("ROLLBACK"); client.release(); }
  });

  it("is idempotent: reapplying restores a removed trigger, a widened grant and a dropped policy", async () => {
    const client = await owner.connect();
    try {
      await client.query("BEGIN");
      await client.query("DROP TRIGGER sec_audit_events_no_truncate ON public.sec_audit_events");
      await client.query("GRANT UPDATE, DELETE, TRUNCATE ON public.sec_audit_events TO dap_app");
      await client.query("DROP POLICY tenant_isolation ON public.sec_audit_events");
      await client.query(await readFile(MIGRATION, "utf8"));
      await expect(client.query("TRUNCATE public.sec_audit_events")).rejects.toThrow(/append-only/);
      await client.query("ROLLBACK"); await client.query("BEGIN");
      await client.query("GRANT UPDATE, DELETE, TRUNCATE ON public.sec_audit_events TO dap_app");
      await client.query(await readFile(MIGRATION, "utf8"));
      for (const privilege of ["UPDATE", "DELETE", "TRUNCATE"]) expect((await client.query("SELECT has_table_privilege('dap_app','public.sec_audit_events',$1) AS allowed", [privilege])).rows).toEqual([{ allowed: false }]);
      expect((await client.query("SELECT count(*)::int AS n FROM pg_policies WHERE tablename='sec_audit_events'")).rows).toEqual([{ n: 1 }]);
    } finally { await client.query("ROLLBACK"); client.release(); }
  });

  it("only dap_owner may apply it", async () => {
    const client = await app.connect();
    try { await expect(client.query(await readFile(MIGRATION, "utf8"))).rejects.toThrow(); } finally { client.release(); }
  });
});
