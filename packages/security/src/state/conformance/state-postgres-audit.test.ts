import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import { mintAuthorizationContext } from "@dap/contracts/mint";
import { createAuditReader } from "../../audit/audit-reader.js";
import { createAuditWriter } from "../../audit/audit-writer.js";
import { PostgresAuditStore } from "../postgres/audit.js";
import { withTenant } from "../postgres/tenant-tx.js";
import { auditEvent, runAuditConformance } from "./audit.conformance.js";
import { openStatePools } from "./state-pg-fixtures.js";

let app: Pool; let owner: Pool;
beforeAll(async () => { ({ app, owner } = await openStatePools(Pool)); });
// Audit rows are append-only: nothing is cleaned up, every test uses its own random tenants.
afterAll(async () => { await Promise.all([app?.end(), owner?.end()]); });

describe("PostgreSQL audit store, shared conformance", () => {
  runAuditConformance(async () => ({ store: new PostgresAuditStore(app) }));
});

describe("T094 PostgreSQL audit store: append-only and tenant isolation at the database", () => {
  it("as dap_app, UPDATE, DELETE and TRUNCATE all fail, and the stored row is untouched", async () => {
    const t = randomUUID(); const event = auditEvent(t);
    await new PostgresAuditStore(app).append(event);
    await withTenant(app, t, async (client) => {
      for (const statement of ["UPDATE public.sec_audit_events SET model='tampered'", "DELETE FROM public.sec_audit_events"]) {
        await client.query("SAVEPOINT s");
        await expect(client.query(statement), statement).rejects.toThrow(/permission denied/);
        await client.query("ROLLBACK TO SAVEPOINT s");
      }
      await client.query("SAVEPOINT s");
      await expect(client.query("TRUNCATE public.sec_audit_events")).rejects.toThrow(/permission denied/);
      await client.query("ROLLBACK TO SAVEPOINT s");
    });
    expect(await new PostgresAuditStore(app).listForTenant(t)).toEqual([event]);
  });

  it("even the table owner cannot rewrite or remove a row or truncate: the triggers refuse", async () => {
    const t = randomUUID(); const event = auditEvent(t);
    await new PostgresAuditStore(app).append(event);
    await withTenant(owner, t, async (client) => {
      await client.query("SAVEPOINT s");
      await expect(client.query("UPDATE public.sec_audit_events SET model='tampered' WHERE tenant_id=$1", [t])).rejects.toThrow(/append-only/);
      await client.query("ROLLBACK TO SAVEPOINT s");
      await expect(client.query("DELETE FROM public.sec_audit_events WHERE tenant_id=$1", [t])).rejects.toThrow(/append-only/);
      await client.query("ROLLBACK TO SAVEPOINT s");
    });
    expect(await new PostgresAuditStore(app).listForTenant(t)).toEqual([event]);
  });

  it("dap_app cannot bypass append-only controls through role, trigger, replication, truncate or upsert privileges", async () => {
    expect((await app.query("SELECT pg_has_role(current_user,'dap_owner','MEMBER') AS member, rolsuper, rolbypassrls FROM pg_roles WHERE rolname=current_user")).rows).toEqual([{ member: false, rolsuper: false, rolbypassrls: false }]);
    expect((await app.query("SELECT prosecdef, has_function_privilege('dap_app',oid,'EXECUTE') AS executable FROM pg_proc WHERE oid='public.sec_audit_events_refuse()'::regprocedure")).rows).toEqual([{ prosecdef: false, executable: false }]);
    const t = randomUUID(); const event = auditEvent(t); await new PostgresAuditStore(app).append(event);
    await withTenant(app, t, async (client) => {
      for (const sql of ["SET ROLE dap_owner", "SET LOCAL session_replication_role='replica'", "ALTER TABLE public.sec_audit_events DISABLE TRIGGER ALL", "ALTER TABLE public.sec_audit_events DISABLE ROW LEVEL SECURITY", "TRUNCATE public.sec_audit_events CASCADE", "INSERT INTO public.sec_audit_events (id) VALUES ('" + event.id + "') ON CONFLICT (id) DO UPDATE SET model='changed'"]) {
        await client.query("SAVEPOINT s");
        await expect(client.query(sql)).rejects.toMatchObject({ code: "42501" });
        await client.query("ROLLBACK TO SAVEPOINT s");
      }
      await client.query("SAVEPOINT s");
      await expect(client.query("COPY public.sec_audit_events FROM STDIN")).rejects.toMatchObject({ code: "0A000" });
      await client.query("ROLLBACK TO SAVEPOINT s");
    });
    expect(await new PostgresAuditStore(app).listForTenant(t)).toEqual([event]);
  });

  it("row-level security: with tenant A's setting, or none, dap_app sees no tenant B row, whatever the WHERE clause says", async () => {
    const a = randomUUID(); const b = randomUUID();
    const store = new PostgresAuditStore(app);
    const [ea, eb] = [auditEvent(a), auditEvent(b)];
    await store.append(ea); await store.append(eb);
    const asA = await withTenant(app, a, (client) => client.query("SELECT id, tenant_id FROM public.sec_audit_events WHERE tenant_id IN ($1,$2) OR id=$3", [a, b, eb.id]));
    expect(asA.rows).toEqual([{ id: ea.id, tenant_id: a }]);
    const none = await app.query("SELECT id FROM public.sec_audit_events WHERE tenant_id IN ($1,$2)", [a, b]);
    expect(none.rows).toEqual([]);
    const empty = await withTenant(app, "", (client) => client.query("SELECT id FROM public.sec_audit_events WHERE tenant_id=$1", [a]));
    expect(empty.rows).toEqual([]);
  });

  it("an insert for another tenant than the transaction's is refused by the policy, and with no tenant setting too", async () => {
    const a = randomUUID(); const b = randomUUID(); const event = auditEvent(b);
    const insert = "INSERT INTO public.sec_audit_events (id,tenant_id,occurred_at,event_type,request_id,decision_id,user_id,ai_session_id,turn_id,model,params_view,outcome,reason) VALUES ($1,$2,now(),'AI_ACTION_DENIED','r','d','u','s','t','m','{}','DENIED','permission_missing')";
    await expect(withTenant(app, a, (client) => client.query(insert, [event.id, b]))).rejects.toThrow(/row-level security/);
    await expect(app.query(insert, [event.id, b])).rejects.toThrow(/row-level security/);
    expect(await new PostgresAuditStore(app).listForTenant(b)).toEqual([]);
  });

  it("the database refuses a malformed row on its own (closed enums, a decision without an outcome, an oversized view)", async () => {
    const t = randomUUID();
    const base = "id,tenant_id,occurred_at,event_type,request_id,decision_id,user_id,ai_session_id,turn_id,model,params_view,outcome,reason";
    const insert = (type: string, outcome: string | null, reason: string | null, view = "{}") => withTenant(app, t, (client) => client.query(`INSERT INTO public.sec_audit_events (${base}) VALUES ($1,$2,now(),$3,'r','d','u','s','t','m',$4::jsonb,$5,$6)`, [randomUUID(), t, type, view, outcome, reason]));
    await expect(insert("AI_SOMETHING_ELSE", null, null)).rejects.toThrow(/check constraint/);
    await expect(insert("AI_ACTION_DENIED", "MAYBE", "permission_missing")).rejects.toThrow(/check constraint/);
    await expect(insert("AI_ACTION_DENIED", null, null)).rejects.toThrow(/check constraint/);
    await expect(insert("AI_ACTION_PROPOSED", "DENIED", "permission_missing")).rejects.toThrow(/check constraint/);
    await expect(insert("AI_ACTION_DENIED", "DENIED", "permission_missing", "[]")).rejects.toThrow(/check constraint/);
    await expect(insert("AI_ACTION_DENIED", "DENIED", "permission_missing", JSON.stringify({ k: "x".repeat(70_000) }))).rejects.toThrow(/check constraint/);
    await expect(insert("AI_ACTION_PROPOSED", null, null)).resolves.toBeDefined(); // the control: a well-formed row goes in
  });

  it("a decision cannot omit only one of outcome/reason or use an unknown reason", async () => {
    const t = randomUUID();
    for (const [outcome, reason] of [[null, "permission_missing"], ["DENIED", null], ["DENIED", "made_up_reason"]]) {
      await expect(withTenant(app, t, (client) => client.query("INSERT INTO public.sec_audit_events (id,tenant_id,occurred_at,event_type,request_id,decision_id,user_id,ai_session_id,turn_id,model,params_view,outcome,reason) VALUES ($1,$2,now(),'AI_ACTION_DENIED','r','d','u','s','t','m','{}',$3,$4)", [randomUUID(), t, outcome, reason]))).rejects.toThrow(/check constraint/);
    }
  });

  it("refuses non-finite PostgreSQL timestamps that are not ISO instants", async () => {
    const t = randomUUID();
    for (const instant of ["infinity", "-infinity"]) await expect(withTenant(app, t, (client) => client.query("INSERT INTO public.sec_audit_events (id,tenant_id,occurred_at,event_type,request_id,decision_id,user_id,ai_session_id,turn_id,model,params_view,outcome,reason) VALUES ($1,$2,$3,'AI_ACTION_DENIED','r','d','u','s','t','m','{}','DENIED','permission_missing')", [randomUUID(), t, instant]))).rejects.toThrow(/check constraint/);
  });

  it("preserves microseconds: a retry succeeds, but a distinct instant in the same millisecond is not the same body", async () => {
    const t = randomUUID(); const id = randomUUID(); const store = new PostgresAuditStore(app);
    const event = auditEvent(t, { id, occurredAt: "2026-01-01T00:00:10.123456Z" });
    await store.append(event);
    await expect(store.append(event)).resolves.toBeUndefined();
    expect((await store.listForTenant(t))[0]!.occurredAt).toBe(event.occurredAt);
    await expect(store.append(auditEvent(t, { id, occurredAt: "2026-01-01T00:00:10.123999Z" }))).rejects.toThrow("Audit store unavailable");
  });

  it("does not equate a different jsonb number after the JS parser rounds it", async () => {
    const t = randomUUID(); const event = auditEvent(t, { paramsView: { n: 9007199254740992 } });
    await withTenant(app, t, (client) => client.query("INSERT INTO public.sec_audit_events (id,tenant_id,occurred_at,event_type,request_id,decision_id,user_id,ai_session_id,turn_id,model,action_id,definition_version,params_view,risk,outcome,reason) VALUES ($1,$2,$3,'AI_ACTION_DENIED','req-1','dec-1','alice','session-1','turn-1','scripted','testSafeEcho',1,'{\"n\":9007199254740993}','SAFE','DENIED','permission_missing')", [event.id,t,event.occurredAt]));
    await expect(new PostgresAuditStore(app).append(event)).rejects.toThrow("Audit store unavailable");
  });

  it("replays JSON numeric negative zero in its jsonb normal form", async () => {
    const store = new PostgresAuditStore(app); const event = auditEvent(randomUUID(), { paramsView: { n: -0 } });
    await store.append(event);
    await expect(store.append(event)).resolves.toBeUndefined();
  });

  it("round-trips builder-valid versions above the PostgreSQL int4 range", async () => {
    const t = randomUUID(); const store = new PostgresAuditStore(app);
    const event = auditEvent(t, { action: { kind: "registered", id: "testSafeEcho", version: 2147483648 } });
    await store.append(event);
    expect(await store.listForTenant(t)).toEqual([event]);
  });

  it("handles idle-pool errors without throwing driver text or adding a listener per store", async () => {
    const pool = new Pool({ connectionString: process.env.DAP_DATABASE_URL, max: 1 });
    try {
      new PostgresAuditStore(pool); new PostgresAuditStore(pool);
      expect(pool.listenerCount("error")).toBe(1);
      expect(() => pool.emit("error", new Error("CANARY driver host password"))).not.toThrow();
      expect((await pool.query("SELECT 1 AS ok")).rows).toEqual([{ ok: 1 }]);
    } finally { await pool.end(); }
  });

  it("read-only failures do not exhaust a one-client pool", async () => {
    const pool = new Pool({ connectionString: process.env.DAP_DATABASE_URL, options: "-c default_transaction_read_only=on", max: 1, connectionTimeoutMillis: 500 });
    try {
      const store = new PostgresAuditStore(pool);
      for (let i = 0; i < 12; i++) await expect(store.append(auditEvent(randomUUID()))).rejects.toThrow("Audit store unavailable");
      expect(pool.waitingCount).toBe(0); expect(pool.idleCount).toBe(1); expect(pool.totalCount).toBe(1);
      expect((await pool.query("SELECT 1 AS ok")).rows).toEqual([{ ok: 1 }]);
    } finally { await pool.end(); }
  });

  it("the reviewer uses SQL filters BEFORE a bounded limit, never the full-history source", async () => {
    const t = randomUUID(); const store = new PostgresAuditStore(app);
    const earlier = auditEvent(t, { user: "bob" });
    const match = auditEvent(t, { user: "alice", requestId: "needle", occurredAt: "2026-01-01T00:00:11.000Z" });
    await store.append(earlier); await store.append(match); await store.append(auditEvent(t, { user: "alice", requestId: "needle", occurredAt: "2026-01-01T00:00:12.000Z" }));
    const ctx = mintAuthorizationContext({ tenantId: t, userId: "reviewer", sessionId: "s", authenticatedAt: "2026-01-01T00:00:00Z", validUntil: "2026-01-01T01:00:00Z" });
    const reader = createAuditReader({ listForTenant: () => { throw new Error("unbounded path must not run"); }, queryForTenant: store.queryForTenant.bind(store) });
    expect(await reader.query(ctx, { requestId: "needle" as never, userId: "alice" as never, types: ["AI_ACTION_DENIED"], from: "2026-01-01T00:00:11Z" as never, to: "2026-01-01T00:00:12Z" as never, limit: 1 })).toEqual([match]);
    await expect(store.queryForTenant(t, { limit: 0 })).rejects.toThrow();
  });

  it("every database failure is a generic error: no host, database, user or SQL text comes out of append or listForTenant", async () => {
    const dead = new Pool({ connectionString: "postgresql://canary_user_x:canary_pw_x@127.0.0.1:1/canary_db_x", connectionTimeoutMillis: 500 });
    try {
      const store = new PostgresAuditStore(dead);
      for (const attempt of [store.append(auditEvent(randomUUID())), store.listForTenant(randomUUID())]) {
        const error = await attempt.then(() => undefined, (thrown: unknown) => thrown as Error);
        expect(error).toBeInstanceOf(Error);
        const text = `${error!.name} ${error!.message} ${error!.stack ?? ""} ${JSON.stringify(Object.getOwnPropertyNames(error!).map((name) => String((error as unknown as Record<string, unknown>)[name])))}`;
        for (const secret of ["canary_user_x", "canary_pw_x", "canary_db_x", "127.0.0.1", "ECONNREFUSED", "sec_audit_events", "INSERT"]) expect(text, secret).not.toContain(secret);
      }
    } finally { await dead.end().catch(() => undefined); }
  });
});

/**
 * Cancellation (QA #14): an append the writer gave up on must never become a row. These blocks use a targeted blocker, never a table lock, so parallel tests
 * are not disturbed: another transaction holds an UNCOMMITTED row with the very same event id, and an INSERT of that id waits for that transaction to end.
 */
describe("T094 PostgreSQL audit store: an abandoned append never commits", () => {
  const settle = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
  const countRows = async (tenantId: string, id: string) => (await withTenant(owner, tenantId, (client) => client.query("SELECT 1 FROM public.sec_audit_events WHERE id=$1", [id]))).rowCount;
  /** Another session that has inserted the event's id but not committed: until it ends, an insert of the same id waits. */
  async function blocker(event: ReturnType<typeof auditEvent>) {
    const client = await owner.connect();
    await client.query("BEGIN");
    await client.query("SELECT set_config('app.tenant_id',$1,true)", [event.tenantId]);
    await client.query("INSERT INTO public.sec_audit_events (id,tenant_id,occurred_at,event_type,request_id,decision_id,user_id,ai_session_id,turn_id,model,params_view,outcome,reason) VALUES ($1,$2,now(),'AI_ACTION_DENIED','blocker','d','u','s','t','m','{}','DENIED','permission_missing')", [event.id, event.tenantId]);
    return { release: async (how: "COMMIT" | "ROLLBACK") => { await client.query(how); client.release(); } };
  }
  /** A pool that records every statement each of its connections is asked to run (a SQL spy), and can react to one. */
  function spied(max: number, after?: (sql: string) => void, rewrite?: (sql: string) => string) {
    const statements: string[] = [];
    const releases: unknown[] = [];
    const errors: unknown[] = [];
    const pool = new Pool({ connectionString: process.env.DAP_DATABASE_URL, max, connectionTimeoutMillis: 5000 });
    pool.on("release", (error) => { releases.push(error); });
    pool.on("connect", (client) => {
      const original = client.query.bind(client) as (...args: unknown[]) => unknown;
      (client as unknown as { query: unknown }).query = (...args: unknown[]) => {
        const raw = typeof args[0] === "string" ? args[0] : "";
        const sql = rewrite === undefined ? raw : rewrite(raw);
        statements.push(sql);
        const result = original(...(typeof args[0] === "string" ? [sql, ...args.slice(1)] : args));
        return !(result instanceof Promise) ? result : result.then((value) => { after?.(sql); return value; }, (error: unknown) => { errors.push(error !== null && typeof error === "object" ? Reflect.get(error, "code") : undefined); throw error; });
      };
    });
    return { pool, statements, releases, errors };
  }
  const generic = async (promise: Promise<unknown>) => {
    const error = await promise.then(() => undefined, (thrown: unknown) => thrown as Error);
    expect(error).toBeInstanceOf(Error);
    expect(error!.message).toBe("Audit store unavailable");
    return error!;
  };

  it("malformed or unreadable cancellation signals fail generically before borrowing a connection", async () => {
    const { pool, statements } = spied(1);
    try {
      const store = new PostgresAuditStore(pool);
      const throwing = Object.defineProperty({}, "signal", { get() { throw new Error("CANARY hidden option"); } });
      for (const options of [throwing, { signal: { aborted: "yes" } }, { signal: null }, { signal: { aborted: true } }]) await generic(store.append(auditEvent(randomUUID()), options as never));
      expect(statements).toEqual([]); expect(pool.totalCount).toBe(0);
    } finally { await pool.end(); }
  });

  it("success path is unaffected: with a signal that is never aborted it commits once, and replaying the event is a no-op", async () => {
    const t = randomUUID(); const event = auditEvent(t); const signal = { aborted: false };
    const store = new PostgresAuditStore(app);
    await store.append(event, { signal }); await store.append(event, { signal });
    expect(signal.aborted).toBe(false);
    expect(await store.listForTenant(t)).toEqual([event]);
    await store.append(auditEvent(t), undefined); // no options at all still works
  });

  it("aborted before it starts: no connection is used and NO statement is ever sent, even after the pool frees up", async () => {
    const { pool, statements } = spied(1);
    try {
      const t = randomUUID(); const event = auditEvent(t); const signal = { aborted: false };
      const store = new PostgresAuditStore(pool);
      const held = await pool.connect(); // the pool's only connection: the append has to wait for it
      const before = statements.length;
      const waiting = generic(store.append(event, { signal }));
      await settle(50);
      signal.aborted = true; // the writer gave up while the append was still waiting for a connection
      held.release();
      await waiting;
      expect(statements.length).toBe(before); // not even BEGIN
      expect(await countRows(t, event.id)).toBe(0);
      // the same store works afterwards (the connection went back to the pool, not lost)
      await store.append(auditEvent(t), { signal: { aborted: false } });
      expect(statements.length).toBeGreaterThan(before);
      // and an append whose signal is already aborted never takes a connection at all
      const mark = statements.length;
      await generic(store.append(auditEvent(t), { signal: { aborted: true } }));
      expect(statements.length).toBe(mark);
    } finally { await pool.end(); }
  });

  it("aborted after the INSERT and before COMMIT: ROLLBACK replaces COMMIT and no row exists (deterministic: the signal flips right after the INSERT returns)", async () => {
    const signal = { aborted: false };
    const { pool, statements } = spied(2, (sql) => { if (sql.startsWith("INSERT")) signal.aborted = true; });
    try {
      const t = randomUUID(); const event = auditEvent(t);
      await generic(new PostgresAuditStore(pool).append(event, { signal }));
      expect(statements.some((sql) => sql.startsWith("INSERT"))).toBe(true); // it really got that far
      expect(statements).toContain("ROLLBACK");
      expect(statements).not.toContain("COMMIT");
      expect(await countRows(t, event.id)).toBe(0);
    } finally { await pool.end(); }
  });

  it("a signal that flips while the append is blocked in the database is honored when the block ends: the INSERT completes, sees the flag and rolls back", async () => {
    const t = randomUUID(); const event = auditEvent(t); const signal = { aborted: false };
    const hold = await blocker(event);
    const pending = generic(new PostgresAuditStore(app, { writeTimeoutMs: 10_000 }).append(event, { signal }));
    await settle(150);
    signal.aborted = true;
    await hold.release("ROLLBACK"); // the blocked INSERT now proceeds
    await pending;
    expect(await countRows(t, event.id)).toBe(0);
  });

  it("the database bounds a blocked append by itself: with NO signal and writeTimeoutMs of 150 it is cancelled by the database, generically, and no row follows the release", async () => {
    const t = randomUUID(); const event = auditEvent(t);
    const hold = await blocker(event);
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const pending = generic(new PostgresAuditStore(app, { writeTimeoutMs: 150 }).append(event));
    try {
      const error = await Promise.race([pending, new Promise<never>((_, reject) => { watchdog = setTimeout(() => reject(new Error("database timeout did not bound the blocked INSERT")), 1500); })]);
      expect(`${error.message} ${error.stack ?? ""}`).not.toMatch(/lock_timeout|statement_timeout|canceling|sec_audit_events/);
    } finally {
      clearTimeout(watchdog);
      await hold.release("ROLLBACK");
      await pending.catch(() => undefined);
    }
    await settle(100);
    expect(await countRows(t, event.id)).toBe(0);
  });

  it("statement_timeout alone cancels a genuine slow INSERT without any lock or signal", async () => {
    let slow = true;
    const { pool, statements, errors } = spied(1, undefined, (sql) => {
      if (sql.includes("set_config('lock_timeout'")) return sql.replace("set_config('lock_timeout', $1, true)", "set_config('lock_timeout', '0', true)");
      return slow && sql.startsWith("INSERT") ? `${sql} RETURNING pg_sleep(0.4)` : sql;
    });
    try {
      const store = new PostgresAuditStore(pool, { writeTimeoutMs: 100 });
      const t = randomUUID(); const event = auditEvent(t);
      await generic(store.append(event)); // deliberately NO append options or signal
      expect(statements.some((sql) => sql.includes("RETURNING pg_sleep"))).toBe(true);
      expect(errors).toContain("57014"); // real server statement cancellation, not a lock error or a SQL syntax mistake
      expect(statements).toContain("ROLLBACK"); expect(statements).not.toContain("COMMIT");
      expect(await countRows(t, event.id)).toBe(0);
      expect(pool.idleCount).toBe(1); expect(pool.waitingCount).toBe(0);
      slow = false;
      await store.append(event); // the very same INSERT works once only the artificial SQL work is removed
      expect(await countRows(t, event.id)).toBe(1);
    } finally { await pool.end(); }
  });

  it("tenant and timeout settings are local to the transaction and absent for the next borrower", async () => {
    const { pool, statements } = spied(1);
    const read = () => pool.query("SELECT pg_backend_pid() AS pid, current_setting('lock_timeout') AS locks, current_setting('statement_timeout') AS statements, NULLIF(current_setting('app.tenant_id',true),'') AS tenant");
    try {
      const before = (await read()).rows;
      await new PostgresAuditStore(pool, { writeTimeoutMs: 97 }).append(auditEvent(randomUUID()));
      expect((await read()).rows).toEqual(before); // size 1: the SAME physical connection, no session pollution
      expect(statements).toContain("SELECT set_config('app.tenant_id', $1, true)");
      expect(statements).toContain("SELECT set_config('lock_timeout', $1, true), set_config('statement_timeout', $1, true)");
    } finally { await pool.end(); }
  });

  it("a replay abandoned after read-back rolls back a no-op and preserves the earlier committed event", async () => {
    const event = auditEvent(randomUUID()); await new PostgresAuditStore(app).append(event);
    const signal = { aborted: false };
    const { pool, statements, releases } = spied(1, (sql) => { if (sql.includes("WHERE id=$1")) signal.aborted = true; });
    try {
      await generic(new PostgresAuditStore(pool).append(event, { signal }));
      expect(signal.aborted).toBe(true); expect(statements.some((sql) => sql.includes("WHERE id=$1"))).toBe(true);
      expect(statements).toContain("ROLLBACK"); expect(statements).not.toContain("COMMIT");
      expect(releases).toHaveLength(1); expect(pool.idleCount).toBe(1);
      expect(await new PostgresAuditStore(app).listForTenant(event.tenantId)).toEqual([event]);
    } finally { await pool.end(); }
  });

  it.each(["INSERT", "read-back", "COMMIT", "ROLLBACK"] as const)("%s failure loops do not leak a one-client pool; failed rollback destroys it", async (point) => {
    let injecting = false;
    const { pool, releases } = spied(1, undefined, (sql) => {
      if (!injecting) return sql;
      if ((point === "INSERT" || point === "ROLLBACK") && sql.startsWith("INSERT")) return `${sql} RETURNING 1/0`;
      if (point === "read-back" && sql.includes("WHERE id=$1")) return "SELECT 1/0";
      if (point === "COMMIT" && sql === "COMMIT") return "SELECT 1/0";
      if (point === "ROLLBACK" && sql === "ROLLBACK") return "ROLLBACK broken";
      return sql;
    });
    try {
      const store = new PostgresAuditStore(pool);
      for (let i = 0; i < 4; i++) {
        const event = auditEvent(randomUUID());
        injecting = false;
        if (point === "read-back") await store.append(event);
        const mark = releases.length;
        injecting = true;
        await generic(store.append(event));
        expect(releases).toHaveLength(mark + 1);
        expect(Boolean(releases[mark])).toBe(point === "ROLLBACK");
        expect(pool.waitingCount).toBe(0); expect(pool.idleCount).toBe(point === "ROLLBACK" ? 0 : 1);
        if (point !== "ROLLBACK") expect(pool.totalCount).toBe(1);
        expect(await countRows(event.tenantId, event.id)).toBe(point === "read-back" ? 1 : 0);
      }
      injecting = false;
      await store.append(auditEvent(randomUUID()));
      expect(pool.idleCount).toBe(1); expect(pool.waitingCount).toBe(0);
    } finally { await pool.end(); }
  });

  it("queued and pre-COMMIT aborts repeatedly return a one-client pool without a row", async () => {
    let signal = { aborted: false }; let afterInsert = false;
    const { pool, statements } = spied(1, (sql) => { if (afterInsert && sql.startsWith("INSERT")) signal.aborted = true; });
    try {
      const store = new PostgresAuditStore(pool);
      for (let i = 0; i < 4; i++) {
        const event = auditEvent(randomUUID());
        const held = await pool.connect(); const mark = statements.length;
        signal = { aborted: false };
        const waiting = generic(store.append(event, { signal }));
        expect(pool.waitingCount).toBe(1);
        signal.aborted = true; held.release(); await waiting;
        expect(statements.length).toBe(mark); // acquired after abort, no SQL sent
        signal = { aborted: false }; afterInsert = true;
        await generic(store.append(event, { signal }));
        afterInsert = false;
        expect(statements.at(-1)).toBe("ROLLBACK");
        expect(await countRows(event.tenantId, event.id)).toBe(0);
        expect(pool.waitingCount).toBe(0); expect(pool.idleCount).toBe(1); expect(pool.totalCount).toBe(1);
      }
    } finally { await pool.end(); }
  });

  it("the residual window is honest: abort after the server COMMIT cannot erase a durable row", async () => {
    const controller = new AbortController();
    const { pool, statements } = spied(1, (sql) => { if (sql === "COMMIT") controller.abort(); });
    try {
      const event = auditEvent(randomUUID());
      await new PostgresAuditStore(pool).append(event, { signal: controller.signal });
      expect(controller.signal.aborted).toBe(true); expect(statements).toContain("COMMIT");
      expect(statements).not.toContain("ROLLBACK");
      expect(await countRows(event.tenantId, event.id)).toBe(1);
    } finally { await pool.end(); }
  });

  it("validates writeTimeoutMs: an integer from 1 to 10000", () => {
    for (const bad of [0, -1, 1.5, 10_001, NaN, Infinity, "100", null]) expect(() => new PostgresAuditStore(app, { writeTimeoutMs: bad as number }), String(bad)).toThrow(RangeError);
    for (const good of [1, 1500, 10_000]) expect(() => new PostgresAuditStore(app, { writeTimeoutMs: good })).not.toThrow();
  });

  it("through the writer, retried: attempt 1 is abandoned (and rolls back), attempt 2 uses a new signal and the same event, and exactly one row exists", async () => {
    const t = randomUUID(); const event = auditEvent(t, { type: "AI_ACTION_ALLOWED", outcome: "ALLOWED", reason: "allowed" });
    const hold = await blocker(event);
    const { pool, statements } = spied(1);
    const seen: { aborted: boolean }[] = [];
    const operations: Promise<void>[] = [];
    let secondStarted!: () => void;
    const second = new Promise<void>((resolve) => { secondStarted = resolve; });
    const store = new PostgresAuditStore(pool, { writeTimeoutMs: 10_000 });
    const sink = { append: (e: typeof event, options?: { signal?: { aborted: boolean } }) => {
      seen.push(options!.signal!);
      const operation = store.append(e, options); operations.push(operation);
      if (seen.length === 2) secondStarted();
      return operation;
    } };
    await pool.query("SELECT 1"); // warm the one connection before starting the attempt deadline
    const result = createAuditWriter({ sink }, { attempts: 2, hookTimeoutMs: 300 }).recordAllowedDurably(event);
    let released = false; let watchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([second, new Promise<never>((_, reject) => { watchdog = setTimeout(() => reject(new Error("retry did not start")), 1500); })]);
      await hold.release("ROLLBACK"); released = true;
      expect(await result).toEqual({ ok: true });
      expect((await Promise.allSettled(operations)).map((operation) => operation.status)).toEqual(["rejected", "fulfilled"]);
      expect(statements.filter((sql) => sql === "ROLLBACK")).toHaveLength(1);
      expect(statements.filter((sql) => sql === "COMMIT")).toHaveLength(1);
      expect(seen).toHaveLength(2); expect(seen[0]).not.toBe(seen[1]);
      expect(seen.map((signal) => signal.aborted)).toEqual([true, false]);
      expect(await countRows(t, event.id)).toBe(1);
      expect(await store.listForTenant(t)).toEqual([event]);
    } finally {
      clearTimeout(watchdog);
      if (!released) await hold.release("ROLLBACK");
      await Promise.allSettled(operations); await result; await pool.end();
    }
  });
});
