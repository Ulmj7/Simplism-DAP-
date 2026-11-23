/**
 * T095: the REAL Policy Gateway with a REAL PostgreSQL audit sink, and the two chains it exists for:
 *   (A) ALLOWED -> the allow-event is durably committed -> only then does the executor run (once);
 *   (B) the required audit write fails -> fail closed -> the executor never runs.
 * Plus the tenant-scoped reviewer reading (ATK-XTENANT-09), secret scrubbing of the stored rows, and the SC-008 reconstruction read back from PostgreSQL.
 * Needs the PostgreSQL of deploy/compose.yaml (DAP_DATABASE_URL / DAP_MIGRATE_DATABASE_URL): like the other PostgreSQL tests it fails loudly, never skips.
 * Audit rows are append-only, so nothing is cleaned up: every test uses its own seed (request ids) and its own instant, and reads only its own.
 */
import { randomUUID } from "node:crypto";
import { assemble } from "../../packages/security/src/gateway/create-gateway.js";
import { createPipeline } from "../../packages/security/src/gateway/pipeline.js";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import type { AuditAppendOptions, AuditEvent, AuditSink } from "@dap/contracts";
import { PostgresAuditStore, createAuditReader, createPolicyGateway } from "@dap/security";
import { ALICE, SECRET_CANARIES, TENANT_A, TENANT_B, WIDE_GATEWAY_CONFIG, secretFindings, withGateway } from "@dap/testkit";
import type { GatewayWorld, WorldUser } from "@dap/testkit";
import { withTenant } from "../../packages/security/src/state/postgres/tenant-tx.js";
import { openStatePools } from "../../packages/security/src/state/conformance/state-pg-fixtures.js";
import { A_ALICE, A_CAROL, EXPECTED, reconstruct, sample } from "./audit-trail.support.js";

let app: Pool; let owner: Pool; let store: PostgresAuditStore;
beforeAll(async () => { ({ app, owner } = await openStatePools(Pool)); store = new PostgresAuditStore(app); });
afterAll(async () => { await Promise.all([app?.end(), owner?.end()]); });

let tick = Date.now();
/** A world of its own: unique request ids (seed) and a unique instant, writing to PostgreSQL through `sink`. */
const fresh = (sink: AuditSink = store, extra: Record<string, unknown> = {}) => {
  const seed = (tick++ % 0xffff_fff0) + 1;
  const startAt = new Date(tick).toISOString();
  return { startAt, seed, world: withGateway({ config: WIDE_GATEWAY_CONFIG, auditSink: sink, startAt, seed, ...extra }) };
};
const JUSTIFICATION = "Test-only scratch document in a disposable world; the recorded mutation is bounded and reversible.";
const B_ALICE: WorldUser = { tenant: "B", user: ALICE };
/** The rows of some requests as dap_owner sees them (a tenant transaction: the table forces row level security even for its owner). */
const rowsOf = async (tenantId: string, requestIds: readonly string[]) =>
  (await withTenant(owner, tenantId, (client) => client.query("SELECT * FROM public.sec_audit_events WHERE request_id = ANY($1::text[]) ORDER BY seq", [requestIds]))).rows as Record<string, unknown>[];
const typesOf = async (tenantId: string, requestId: string) => (await rowsOf(tenantId, [requestId])).map((row) => row.event_type as string);
const reviewer = async (world: GatewayWorld, tenant: "A" | "B") => (await world.submitterFor({ tenant, user: "reviewer" })).context;

describe("P1 chain A: the allow-event is committed in PostgreSQL BEFORE the executor body runs", () => {
  it.each(["testSafeEcho", "testLowNavigate", "testMediumDraft"] as const)("%s executes exactly once; at the moment its body runs the ALLOWED row is already committed (read by another connection), and PROPOSED, ALLOWED, EXECUTED follow in order", async (action) => {
    const { world } = fresh(store, { mediumConfirmationJustification: JUSTIFICATION });
    expect(world.deps.registry.get(action as never)!.definition.changesState).toBe(action === "testMediumDraft");
    let stateChanges = 0;
    const atRun: string[][] = [];
    world.executor(action).onRun(async (call) => { atRun.push(await typesOf(TENANT_A, call.requestId)); if (action === "testMediumDraft") stateChanges++; });
    expect(await world.submit(A_ALICE, world.proposal(action))).toEqual({ outcome: "ALLOWED", category: "ok" });
    expect(world.executor(action).calls).toBe(1);
    expect(world.executorCalls()).toBe(1);
    expect(stateChanges).toBe(action === "testMediumDraft" ? 1 : 0);
    expect(atRun).toEqual([["AI_ACTION_PROPOSED", "AI_ACTION_ALLOWED"]]); // the EXECUTED row cannot exist yet, and the ALLOWED row must
    const [requestId] = world.requestIds();
    const rows = await rowsOf(TENANT_A, [requestId!]);
    expect(rows.map((row) => row.event_type)).toEqual(["AI_ACTION_PROPOSED", "AI_ACTION_ALLOWED", "AI_ACTION_EXECUTED"]);
    expect(rows.map((row) => [row.tenant_id, row.user_id, row.action_id, row.request_id])).toEqual(rows.map(() => [TENANT_A, ALICE, action, requestId]));
    expect(rows[2]).toMatchObject({ outcome: "ALLOWED", reason: "allowed", execution_result: "success" });
    expect(world.events().map((event) => event.type)).toEqual(["AI_ACTION_PROPOSED", "AI_ACTION_ALLOWED", "AI_ACTION_EXECUTED"]);
  });
});

describe("AUDIT-01 / TEST-03: raw malformed names persist consistently", () => {
  it("empty action is INVALID_ACTION, with a persisted PROPOSED and one denial carrying NULL action_id", async () => {
    const { world } = fresh();
    expect(await world.submit(A_ALICE, { callId: "empty-action", raw: '{"action":"","params":{}}' })).toEqual({ outcome: "INVALID_ACTION", category: "not_available" });
    expect(world.executorCalls()).toBe(0);
    const [requestId] = world.requestIds();
    const rows = await rowsOf(TENANT_A, [requestId!]);
    expect(rows.map(row => row.event_type)).toEqual(["AI_ACTION_PROPOSED", "AI_ACTION_DENIED"]);
    expect(rows.map(row => row.action_id)).toEqual([null, null]);
    expect(rows[1]).toMatchObject({ outcome: "INVALID_ACTION", reason: "malformed_envelope" });
    expect(world.events().map(e => e.actionId)).toEqual([null, null]);
  });
});

describe("P2 chain B: a genuine PostgreSQL write failure fails closed and executes nothing", () => {
  /** Every statement of a connection from this pool runs in a read-only transaction, so each INSERT is refused BY THE DATABASE (not by a mock). */
  const readOnly = () => new Pool({ connectionString: process.env.DAP_DATABASE_URL, options: "-c default_transaction_read_only=on", max: 2, connectionTimeoutMillis: 2000 });
  /** A server that is not there: the connection itself fails (the error text names host and port, and these made-up user and database). */
  const unreachable = () => new Pool({ connectionString: "postgresql://canary_user_x:canary_pw_x@127.0.0.1:1/canary_db_x", max: 1, connectionTimeoutMillis: 500 });
  const LEAKS = ["read-only", "transaction", "sec_audit_events", "INSERT", "dap_app", "dap_owner", "canary_user_x", "canary_pw_x", "canary_db_x", "127.0.0.1", "54329", "ECONNREFUSED", "ECONNRESET", "password", "pg_", "SQLSTATE", "permission denied"];

  it.each([["the database refuses the INSERT (read-only transaction)", readOnly], ["the database cannot be reached", unreachable]] as const)("%s: the generic try-later answer, executor at zero, no ALLOWED or EXECUTED row anywhere, no driver text; the same request executes once after the failure is cleared", async (_label, makePool) => {
    const broken = makePool();
    try {
      let current: AuditSink = new PostgresAuditStore(broken);
      const attempted: AuditEvent[] = [];
      const { world } = fresh({ append: (event: AuditEvent, options?: AuditAppendOptions) => { attempted.push(event); return current.append(event, options); } }, { mediumConfirmationJustification: JUSTIFICATION });
      let mutations = 0;
      world.executor("testMediumDraft").onRun(() => { mutations++; });
      expect(world.deps.registry.get("testMediumDraft" as never)!.definition.changesState).toBe(true);
      const answer = await world.submit(A_ALICE, world.proposal("testMediumDraft"));
      expect(answer).toEqual({ outcome: "DENIED", category: "try_later" });
      expect(world.executorCalls()).toBe(0);
      expect(mutations).toBe(0);
      // The Gateway DID try to record the allow-event (and the proposal) and the database refused: nothing of that request exists in PostgreSQL.
      expect(attempted.map((event) => event.type)).toEqual(expect.arrayContaining(["AI_ACTION_PROPOSED", "AI_ACTION_ALLOWED", "AI_ACTION_DENIED"]));
      expect(attempted.some((event) => event.type === "AI_ACTION_EXECUTED")).toBe(false);
      expect(world.events()).toEqual([]); // the capture records only what was committed
      expect(await rowsOf(TENANT_A, [...new Set(attempted.map((event) => event.requestId))])).toEqual([]);
      // nothing the planner or a reviewer could read carries a driver, host, database, user or SQL fragment
      const surface = JSON.stringify([answer, world.events()]);
      for (const fragment of LEAKS) expect(surface, fragment).not.toContain(fragment);

      // The control: clear the failure and the very same request executes once, with its rows in PostgreSQL.
      current = store;
      expect(await world.submit(A_ALICE, world.proposal("testMediumDraft"))).toEqual({ outcome: "ALLOWED", category: "ok" });
      expect(world.executorCalls()).toBe(1);
      expect(mutations).toBe(1);
      const ids = world.requestIds();
      expect(await typesOf(TENANT_A, ids[0]!)).toEqual(["AI_ACTION_PROPOSED", "AI_ACTION_ALLOWED", "AI_ACTION_EXECUTED"]);
    } finally { await broken.end().catch(() => undefined); }
  });

  it("a blocked allow-write times out without execution and cannot commit ALLOWED after the denial", async () => {
    const locker = await owner.connect();
    const writes: Promise<void>[] = [];
    const attempted: AuditEvent[] = [];
    let locked = false;
    await locker.query("BEGIN");
    const sink: AuditSink = { append: async (event, options) => {
      attempted.push(event);
      if (event.type === "AI_ACTION_ALLOWED" && !locked) {
        await locker.query("LOCK TABLE public.sec_audit_events IN ACCESS EXCLUSIVE MODE");
        locked = true;
      }
      const writing = store.append(event, options); writes.push(writing); return writing;
    } };
    const { world } = fresh(sink, { mediumConfirmationJustification: JUSTIFICATION, config: { ...WIDE_GATEWAY_CONFIG, hookTimeoutMs: 50, proposalBudgetMs: 200 } });
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    try {
      const answer = await Promise.race([world.submit(A_ALICE, world.proposal("testMediumDraft")), new Promise<never>((_, reject) => { watchdog = setTimeout(() => reject(new Error("blocked audit exceeded the bounded response deadline")), 3000); })]);
      expect(locked).toBe(true);
      expect(answer).toEqual({ outcome: "DENIED", category: "try_later" });
      expect(world.executorCalls()).toBe(0);
    } finally {
      clearTimeout(watchdog);
      await locker.query("ROLLBACK"); locker.release();
      await Promise.allSettled(writes);
    }
    // A timeout is not cancellation: this must stay empty even after the database lock is released.
    const rows = await rowsOf(TENANT_A, [...new Set(attempted.map((event) => event.requestId))]);
    expect(rows.filter((row) => row.event_type === "AI_ACTION_ALLOWED" || row.event_type === "AI_ACTION_EXECUTED")).toEqual([]);
    // Every attempted event is accounted for: one request; a PROPOSED that committed, the ALLOWED that was abandoned, and the audit_unavailable denial the Gateway then
    // tried to record (also under the lock, also abandoned). So PROPOSED is the only row of the request.
    expect(new Set(attempted.map((event) => event.requestId)).size).toBe(1);
    expect(attempted.map((event) => event.type)).toEqual(["AI_ACTION_PROPOSED", "AI_ACTION_ALLOWED", "AI_ACTION_DENIED"]);
    expect(attempted[2]).toMatchObject({ outcome: "DENIED", reason: "audit_unavailable" });
    expect(rows.map((row) => row.event_type)).toEqual(["AI_ACTION_PROPOSED"]);
  });

  it("a denial still stands when only the denial's own record fails: the planner hears the denial, not the failure", async () => {
    const broken = readOnly();
    try {
      const { world } = fresh(new PostgresAuditStore(broken));
      expect(await world.submit(A_CAROL, world.proposal("testMediumDraft"))).toEqual({ outcome: "UNAUTHORIZED", category: "not_available" });
      expect(world.executorCalls()).toBe(0);
    } finally { await broken.end().catch(() => undefined); }
  });
});

describe("P3 tenant-scoped reading (ATK-XTENANT-09), by the reader and by the database", () => {
  it("a reviewer in tenant A reads tenant A's rows and none of tenant B's, by listing and by B's request ids; row level security says the same without the reader", async () => {
    const { world, startAt } = fresh();
    await world.submit(A_ALICE, world.proposal("testSafeEcho"));
    await world.submit(A_CAROL, world.proposal("testSafeEcho"));
    await world.submit(B_ALICE, world.proposal("testLowNavigate"));
    const [a1, a2, b1] = world.requestIds() as [string, string, string];
    expect(world.events().filter((event) => event.requestId === b1).length).toBeGreaterThan(0); // tenant B's rows exist: the absence below is not an empty store
    const reader = createAuditReader(store);
    const asA = await reader.query(await reviewer(world, "A"), { from: startAt as never, limit: 500 });
    expect(asA.length).toBeGreaterThan(0);
    expect(new Set(asA.map((event) => event.tenantId))).toEqual(new Set([TENANT_A]));
    expect(new Set(asA.map((event) => event.requestId))).toEqual(new Set([a1, a2]));
    expect(await reader.query(await reviewer(world, "A"), { requestId: b1 as never, limit: 500 })).toEqual([]);
    expect(await reader.query(await reviewer(world, "A"), { userId: ALICE as never, from: startAt as never, limit: 500 })).toEqual(asA.filter((event) => event.userId === ALICE));
    const asB = await reader.query(await reviewer(world, "B"), { from: startAt as never, limit: 500 });
    expect(new Set(asB.map((event) => event.requestId))).toEqual(new Set([b1]));
    expect(new Set(asB.map((event) => event.tenantId))).toEqual(new Set([TENANT_B]));

    // The database itself, as dap_app: tenant A's setting, or none, returns no tenant B row whatever the query asks for.
    expect((await withTenant(app, TENANT_A, (client) => client.query("SELECT 1 FROM public.sec_audit_events WHERE request_id=$1 OR tenant_id=$2", [b1, TENANT_B]))).rowCount).toBe(0);
    expect((await app.query("SELECT 1 FROM public.sec_audit_events WHERE request_id=$1", [b1])).rowCount).toBe(0);
    expect((await withTenant(app, TENANT_B, (client) => client.query("SELECT 1 FROM public.sec_audit_events WHERE request_id=$1", [b1]))).rowCount).toBe(3);
  });
});

describe("P4 secret scrubbing: no stored column of any row holds a canary, an encoded canary, a secret-shaped value or a stack", () => {
  const TOKEN = "sk-abcdefghijklmnopqrstuvwx";
  const STACK = [/\bat [\w.<>$ ]+ \(/, /\.(?:ts|js|mjs):\d+/, /\bnode_modules\b/, /\b(?:Type|Range|Reference|Syntax)?Error:/];
  const toObservation = (rows: Record<string, unknown>[]) => ({ feedback: [], executorCalls: 0, leakFindings: [], auditEvents: JSON.parse(JSON.stringify(rows)) as never });
  const scan = (rows: Record<string, unknown>[]) => {
    const text = JSON.stringify(rows);
    const found = secretFindings(toObservation(rows), ["hunter2", TOKEN, ...SECRET_CANARIES.map((canary) => Buffer.from(canary).toString("base64")), ...SECRET_CANARIES.map((canary) => Buffer.from(canary).toString("hex"))]);
    return [...found, ...SECRET_CANARIES.filter((canary) => text.includes(canary)), ...STACK.filter((pattern) => pattern.test(text.replaceAll("\\n", "\n"))).map(String)];
  };

  it("canaries in untrusted params, in a thrown dependency or executor error and in a secret-shaped parameter never reach a column; params_view holds only the projected view", async () => {
    const { world } = fresh();
    const alice = await world.submitterFor(A_ALICE);
    const [A, B, C] = SECRET_CANARIES as readonly [string, string, string];
    const go = (raw: unknown, callId: string) => alice.submit({ callId, raw });
    await go({ action: "testSafeEcho", params: { message: "ok", extra: A } }, "k1");
    await go({ action: "testSafeEcho", params: { message: "ok", [B]: 1 } }, "k2");
    await go({ action: "testSafeEcho", params: { message: { deep: { c: C } } } }, "k3");
    await go({ action: "testSafeEcho", params: { message: `use ${TOKEN} now` } }, "k4"); // a secret-shaped value in an audited parameter
    await go({ action: "testMediumDraft", params: { documentId: "doc-1", draft: `notes ${A} password=hunter2` } }, "k5"); // a masked parameter
    world.executor("testLowNavigate").failWith(`db connection failed: password=hunter2 ${B}`);
    await go(world.proposal("testLowNavigate").raw, "k6"); // a thrown executor error with a canary
    world.executor("testLowNavigate").failWith(undefined);
    world.failPermissionsWith(`hook failed: ${C} password=hunter2`);
    await go(world.proposal("testSafeEcho").raw, "k7"); // a thrown dependency error with a canary
    world.failPermissionsWith(undefined);
    expect((await go(world.proposal("testSafeEcho").raw, "ok")).outcome).toBe("ALLOWED"); // the control: clean traffic is stored and executes

    const rows = await rowsOf(TENANT_A, world.requestIds());
    expect(world.requestIds()).toHaveLength(8);
    expect(rows).toHaveLength(19);
    expect(new Set(rows.map((row) => row.request_id))).toEqual(new Set(world.requestIds()));
    expect(rows.some((row) => row.execution_result === "failure")).toBe(true); // the failing executor really ran and was recorded
    expect(Object.keys(rows[0]!)).toHaveLength(22); // every column is in the scan, and there is no column for raw parameters
    expect(scan(rows)).toEqual([]);
    const draft = rows.find((row) => row.event_type === "AI_CONFIRMATION_REQUIRED")!;
    expect(draft.params_view).toEqual({ "/documentId": "doc-1", "/draft": "[masked]" });
    const echoed = rows.find((row) => row.event_type === "AI_ACTION_ALLOWED" && JSON.stringify(row.params_view).includes("redacted"))!;
    expect(String((echoed.params_view as Record<string, unknown>)["/message"])).toContain("[redacted");
  });

  it("the scan is able to fail: the same rows with a canary, an encoded canary, a token or a stack spliced into any one column are reported", async () => {
    const { world } = fresh();
    await world.submit(A_ALICE, world.proposal("testSafeEcho"));
    const rows = await rowsOf(TENANT_A, world.requestIds());
    expect(rows.length).toBe(3);
    expect(scan(rows)).toEqual([]);
    const columns = Object.keys(rows[0]!);
    expect(columns).toHaveLength(22);
    for (const column of columns) {
      for (const poison of [SECRET_CANARIES[0]!, Buffer.from(SECRET_CANARIES[1]!).toString("base64"), TOKEN, "Error: x\n    at run (/srv/app/x.ts:1:2)"]) {
        const spliced = rows.map((row, index) => index === 1 ? { ...row, [column]: `${String(row[column])} ${poison}` } : row);
        expect(scan(spliced).length, `${column} ← ${poison.slice(0, 12)}`).toBeGreaterThan(0);
      }
    }
    const inView = rows.map((row, index) => index === 1 ? { ...row, params_view: { "/message": SECRET_CANARIES[2] } } : row);
    expect(scan(inView).length).toBeGreaterThan(0);
  });
});

describe("P5 reconstruction (SC-008) from events read BACK from PostgreSQL through the tenant-scoped reader", () => {
  it("the mixed sample gives the same answers from PostgreSQL as from the in-memory capture, and both match what the test sent", async () => {
    const startAt = new Date(++tick).toISOString();
    const world = await sample({ auditSink: store, startAt, seed: tick % 0xffff_fff0 });
    expect(world.executorCalls()).toBe(2);
    const readBack = await createAuditReader(store).query(await reviewer(world, "A"), { from: startAt as never, limit: 500 });
    expect(readBack).toHaveLength(world.events().length);
    expect(readBack).toEqual(world.events()); // the same events, field for field, in the same order
    expect(reconstruct(readBack)).toEqual(EXPECTED);
    expect(reconstruct(world.events())).toEqual(reconstruct(readBack));
  });
});

/** LOGIC-01: persistent rows, not only the in-memory capture, retain one committed policy. */
describe("QA16 post-ALLOW PostgreSQL evidence", () => {
  it.each(["before", "after"] as const)("executor binding absent %s ALLOW", async phase => {
    let committed = false;
    const { world } = fresh({ append: async (event, options) => { await store.append(event, options); if (event.type === "AI_ACTION_ALLOWED") committed = true; } });
    const bound = await world.submitterFor(A_ALICE); let unavailable = true;
    const gateway = createPolicyGateway({ ...world.deps, executors: { executorFor: id => unavailable && (phase === "before" || committed) ? undefined : world.deps.executors.executorFor(id) } });
    const answer = await gateway.proposals.forSession(bound.context, bound.run).submit(world.proposal("testSafeEcho"));
    expect(answer).toEqual({ outcome: phase === "before" ? "DENIED" : "ALLOWED", category: "try_later" });
    expect(world.executorCalls()).toBe(0);
    expect((await rowsOf(TENANT_A, world.requestIds())).map(row => row.event_type)).toEqual(phase === "before" ? ["AI_ACTION_PROPOSED", "AI_ACTION_DENIED"] : ["AI_ACTION_PROPOSED", "AI_ACTION_ALLOWED"]);
    unavailable = false;
    expect(await gateway.proposals.forSession(bound.context, bound.run).submit(world.proposal("testSafeEcho"))).toEqual({ outcome: "ALLOWED", category: "ok" });
    expect(world.executorCalls()).toBe(1);
  });
  it("budget exhaustion after the PG commit does not add a contradictory denial", async () => {
    let time = 0;
    const { world } = fresh({ append: async (event, options) => { await store.append(event, options); if (event.type === "AI_ACTION_ALLOWED") time = 10000; } });
    const bound = await world.submitterFor(A_ALICE); const { stages, auditor } = assemble(world.deps);
    const result = await createPipeline(stages, { timer: { now: () => time, setTimeout: () => 0, clearTimeout: () => {} }, audit: auditor }).evaluate({ context: bound.context, run: bound.run, decisionId: randomUUID(), requestId: randomUUID() as never, readProposal: () => world.proposal("testSafeEcho") });
    expect(result.decision.outcome).toBe("ALLOWED"); expect(result.executionStatus).toBe("failure"); expect(world.executorCalls()).toBe(0);
    expect((await rowsOf(TENANT_A, world.requestIds())).map(row => row.event_type)).toEqual(["AI_ACTION_PROPOSED", "AI_ACTION_ALLOWED"]);
  });
  it.each([false, true])("executor hangs=%s; a real blocked EXECUTED write cannot reverse policy or known status", async hangs => {
    const locker = await owner.connect(); let held = false;
    let signal: AuditAppendOptions["signal"];
    const writes: Promise<void>[] = [];
    const { world } = fresh({ append: async (event, options) => {
      if (event.type === "AI_ACTION_EXECUTED") {
        await locker.query("BEGIN"); held = true;
        await locker.query("SELECT set_config('app.tenant_id',$1,true)", [event.tenantId]);
        // A unique-id conflict blocks this one INSERT; other tests' rows stay independent.
        await locker.query("INSERT INTO public.sec_audit_events (id,tenant_id,occurred_at,event_type,request_id,decision_id,user_id,ai_session_id,turn_id,model,params_view) VALUES ($1,$2,$3,'AI_ACTION_PROPOSED','executed-blocker','d','u','s','t','m','{}')", [event.id, event.tenantId, event.occurredAt]);
        signal = options?.signal;
      }
      const writing = store.append(event, options); writes.push(writing); return writing;
    } }, { config: { ...WIDE_GATEWAY_CONFIG, hookTimeoutMs: 100, proposalBudgetMs: 400 } });
    if (hangs) world.executor("testSafeEcho").onRun(() => new Promise(() => {}));
    try {
      expect(await world.submit(A_ALICE, world.proposal("testSafeEcho"))).toEqual({ outcome: "ALLOWED", category: hangs ? "try_later" : "ok" });
      expect(world.executorCalls()).toBe(1);
      const until = Date.now() + 2000;
      while (signal?.aborted !== true && Date.now() < until) await new Promise(resolve => setTimeout(resolve, 5));
      expect(signal?.aborted).toBe(true);
    } finally {
      if (held) await locker.query("ROLLBACK"); locker.release(); await Promise.allSettled(writes);
    }
    expect((await rowsOf(TENANT_A, world.requestIds())).map(row => row.event_type)).toEqual(["AI_ACTION_PROPOSED", "AI_ACTION_ALLOWED"]);
  });
});
