/**
 * T136: ONE focused end-to-end test through the ASSEMBLED reference host (apps/reference-host), not through withGateway():
 *
 *   dev session -> trusted context -> AI-facing `submit` -> real Policy Gateway -> rate/replay -> resolve -> validate -> authorize -> risk ->
 *   confirmation placeholder -> execution-cap claim -> durable PostgreSQL ALLOWED audit -> trusted executor -> EXECUTED audit.
 *
 * It needs the PostgreSQL of deploy/compose.yaml on a FRESH database (DAP_DATABASE_URL as dap_app, DAP_MIGRATE_DATABASE_URL as dap_owner)
 * and fails loudly instead of skipping. Audit rows are append-only, so nothing is cleaned up: every test uses a tenant of its own (a new UUID)
 * and reads only that tenant's rows, so the file can run again and again on the same database and never depends on a global row count.
 */
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { composeReferenceHost } from "../../apps/reference-host/src/index.js";
import type { AiSession, ReferenceHost, TrustedHandle } from "../../apps/reference-host/src/index.js";
import { withTenant } from "../../packages/security/src/state/postgres/tenant-tx.js";
import { openStatePools } from "../../packages/security/src/state/conformance/state-pg-fixtures.js";

let app: Pool; let owner: Pool;
beforeAll(async () => { ({ app, owner } = await openStatePools(Pool)); });
afterAll(async () => { await Promise.all([app?.end(), owner?.end()]); });

const ALL = ["perm.demo.lookup", "perm.demo.save-note", "perm.demo.publish-note"];
const hosts: ReferenceHost[] = [];
afterEach(async () => { await Promise.all(hosts.splice(0).map((host) => host.close())); });

interface Run {
  readonly host: ReferenceHost;
  readonly trusted: TrustedHandle;
  readonly tenant: string;
  readonly token: Readonly<Record<"alice" | "bob" | "carol" | "expired", string>>;
  readonly sessionId: Readonly<Record<"alice" | "bob" | "carol" | "expired", string>>;
}
/** A host of its own over a tenant of its own: alice holds every demo permission, bob only the SAFE read, carol nothing, and `expired` once held everything. */
async function start(extraEnv: Record<string, string> = {}): Promise<Run> {
  const tenant = randomUUID();
  const suffix = tenant.slice(0, 8);
  const sessionId = { alice: `s-alice-${suffix}`, bob: `s-bob-${suffix}`, carol: `s-carol-${suffix}`, expired: `s-expired-${suffix}` } as const;
  const token = { alice: `tok-${randomUUID()}`, bob: `tok-${randomUUID()}`, carol: `tok-${randomUUID()}`, expired: `tok-${randomUUID()}` } as const;
  const future = new Date(Date.now() + 3_600_000).toISOString();
  const past = new Date(Date.now() - 60_000).toISOString();
  const sessions = [
    { token: token.alice, userId: "alice", tenantId: tenant, sessionId: sessionId.alice, validUntil: future, permissions: ALL },
    { token: token.bob, userId: "bob", tenantId: tenant, sessionId: sessionId.bob, validUntil: future, permissions: ["perm.demo.lookup"] },
    { token: token.carol, userId: "carol", tenantId: tenant, sessionId: sessionId.carol, validUntil: future, permissions: [] },
    { token: token.expired, userId: "alice", tenantId: tenant, sessionId: sessionId.expired, validUntil: past, permissions: ALL },
  ];
  const { host, trusted } = await composeReferenceHost({
    NODE_ENV: "test", DAP_ALLOW_DEV_AUTH: "1", DAP_DATABASE_URL: process.env.DAP_DATABASE_URL, DAP_ENABLED_ACTIONS: "demoLookup,demoSaveNote,demoPublishNote",
    DEV_SESSIONS: JSON.stringify(sessions), ...extraEnv,
  });
  hosts.push(host);
  return { host, trusted, tenant, token, sessionId };
}
const open = async (run: Run, who: keyof Run["token"]): Promise<AiSession> => {
  const session = await run.host.openSession(run.token[who]);
  if (session === null) throw new Error(`the session of ${who} was refused`);
  return session;
};
const proposal = (action: string, params: unknown, extra: Record<string, unknown> = {}) => ({ providerCallId: `call-${randomUUID()}`, arguments: JSON.stringify({ action, params, ...extra }) });
const SAVE = { noteId: "note-1", text: "buy milk" };
/** Everything persisted for one tenant, in order, as dap_owner reads it (a tenant transaction: the table forces row level security even for its owner). */
const rows = async (tenant: string) => (await withTenant(owner, tenant, (client) => client.query("SELECT * FROM public.sec_audit_events ORDER BY seq"))).rows as Record<string, unknown>[];
const kinds = async (tenant: string) => (await rows(tenant)).map((row) => row.event_type);

describe("1. VALID EXECUTION through the assembled host", () => {
  it("a valid dev session and a registered state-changing proposal: ALLOWED, the executor runs exactly once with the trusted, validated and frozen inputs, and the trail links proposal, decision and execution", async () => {
    const run = await start();
    const session = await open(run, "alice");
    expect(await session.submit(proposal("demoSaveNote", SAVE))).toEqual({ outcome: "ALLOWED", category: "ok" });
    expect(run.trusted.executorCalls()).toBe(1);
    expect(run.trusted.executorCalls("demoSaveNote")).toBe(1);
    expect(run.trusted.effects()).toEqual([{ kind: "note-saved", tenantId: run.tenant, userId: "alice", noteId: "note-1" }]);
    const [received] = run.trusted.receivedCalls("demoSaveNote");
    expect(received!.params).toEqual(SAVE);
    expect(received!.paramsDeepFrozen, "the executor got the validated, deeply frozen parameters").toBe(true);
    expect(received!.security).toMatchObject({ userId: "alice", tenantId: run.tenant, sessionId: run.sessionId.alice });
    expect(received!.resource).toEqual({ type: "note", id: "note-1", tenantId: run.tenant });

    const trail = await rows(run.tenant);
    expect(trail.map((row) => row.event_type)).toEqual(["AI_ACTION_PROPOSED", "AI_ACTION_ALLOWED", "AI_ACTION_EXECUTED"]);
    expect(new Set(trail.map((row) => row.request_id))).toEqual(new Set([received!.requestId]));
    expect(new Set(trail.map((row) => row.decision_id)).size, "one decision links all three events").toBe(1);
    expect(trail.map((row) => [row.tenant_id, row.user_id, row.action_id])).toEqual(trail.map(() => [run.tenant, "alice", "demoSaveNote"]));
    expect(trail.map((row) => row.ai_session_id)).toEqual(trail.map(() => run.sessionId.alice));
    expect(trail[0]).toMatchObject({ outcome: null, reason: null, execution_result: null });
    expect(trail[1]).toMatchObject({ outcome: "ALLOWED", reason: "allowed", risk: "MEDIUM", execution_result: null });
    expect(trail[2]).toMatchObject({ outcome: "ALLOWED", reason: "allowed", execution_result: "success", resource_type: "note", resource_id: "note-1" });
    expect(trail[1]!.params_view).toEqual({ "/noteId": "note-1", "/text": "[masked]" });
    expect(trail.map((row) => Number(row.seq))).toEqual([...trail.map((row) => Number(row.seq))].sort((a, b) => a - b));
  });

  it("the SAFE read executes once and is audited the same way", async () => {
    const run = await start();
    const session = await open(run, "bob");
    expect(await session.submit(proposal("demoLookup", { topic: "weather" }))).toEqual({ outcome: "ALLOWED", category: "ok" });
    expect(run.trusted.executorCalls("demoLookup")).toBe(1);
    expect(run.trusted.effects()).toEqual([]);
    expect(await kinds(run.tenant)).toEqual(["AI_ACTION_PROPOSED", "AI_ACTION_ALLOWED", "AI_ACTION_EXECUTED"]);
  });

  it("an identity, tenant, session or page written INTO the proposal has no effect: nothing runs as anyone but the trusted session, and nothing is written under a smuggled tenant", async () => {
    const other = randomUUID();
    // Smuggled into the parameters: the strict schema refuses the unknown keys, so nothing runs. (Four denials stay under the denial throttle of five, so each answer is the pipeline's own.)
    const run = await start();
    const session = await open(run, "alice");
    for (const field of ["userId", "tenantId", "sessionId", "page"]) {
      expect((await session.submit(proposal("demoSaveNote", { ...SAVE, [field]: field === "tenantId" ? other : "bob" }))).outcome, field).toBe("INVALID_PARAMETERS");
    }
    expect(run.trusted.executorCalls()).toBe(0);
    // Smuggled into the envelope next to a VALID proposal.
    const second = await start();
    const feedback = await (await open(second, "alice")).submit(proposal("demoSaveNote", SAVE, { userId: "bob", tenantId: other, sessionId: "s-bob", page: "/admin", permissions: ["perm.demo.publish-note"] }));
    expect(feedback, "the envelope is exactly { action, params }: an identity beside them is refused, never honoured").toEqual({ outcome: "INVALID_ACTION", category: "not_available" });
    expect(second.trusted.executorCalls()).toBe(0);
    for (const checked of [run, second]) for (const row of await rows(checked.tenant)) expect([row.tenant_id, row.user_id, row.ai_session_id]).toEqual([checked.tenant, "alice", checked.sessionId.alice]);
    expect((await withTenant(owner, other, (client) => client.query("SELECT 1 FROM public.sec_audit_events"))).rowCount, "nothing was written under the smuggled tenant").toBe(0);
  });

  it("the same proposal replayed (same call id in the same turn) is refused and does not run twice", async () => {
    const run = await start();
    const session = await open(run, "alice");
    const call = proposal("demoSaveNote", SAVE);
    expect((await session.submit(call)).outcome).toBe("ALLOWED");
    expect((await session.submit(call)).outcome).toBe("DENIED");
    expect(run.trusted.executorCalls()).toBe(1);
  });
});

describe("1b. the global allowlist and the call-id scope", () => {
  it("a capability that DAP_ENABLED_ACTIONS does not list is default-denied even for a user who holds its permission, while an enabled one still runs", async () => {
    const run = await start({ DAP_ENABLED_ACTIONS: "demoLookup" });
    const session = await open(run, "alice");
    expect((await session.submit(proposal("demoSaveNote", SAVE))).outcome).not.toBe("ALLOWED");
    expect((await session.submit(proposal("demoLookup", { topic: "weather" }))).outcome).toBe("ALLOWED");
    expect(run.trusted.executorCalls("demoSaveNote")).toBe(0);
    expect(run.trusted.executorCalls("demoLookup")).toBe(1);
  });
  it("the host scopes a call id to its session and turn: the same provider call id in another turn is a different proposal, within one turn it is a replay", async () => {
    const run = await start();
    const first = await open(run, "alice");
    const second = await open(run, "alice");
    const call = proposal("demoLookup", { topic: "weather" });
    expect((await first.submit(call)).outcome).toBe("ALLOWED");
    expect((await second.submit(call)).outcome).toBe("ALLOWED");
    expect((await second.submit(call)).outcome).toBe("DENIED");
    expect(run.trusted.executorCalls("demoLookup")).toBe(2);
  });
});

describe("2. MISSING, INVALID and EXPIRED sessions fail closed", () => {
  it.each<[string, (run: Run) => unknown]>([
    ["undefined", () => undefined],
    ["null", () => null],
    ["an empty token", () => ""],
    ["an unknown token", () => `tok-${randomUUID()}`],
    ["__proto__", () => "__proto__"],
    ["constructor", () => "constructor"],
    ["an object that claims a user, a tenant and a session", (run) => ({ userId: "alice", tenantId: run.tenant, sessionId: run.sessionId.alice })],
    ["an object holding a real token", (run) => ({ token: run.token.alice })],
    ["the token of an EXPIRED session", (run) => run.token.expired],
  ])("%s: no AI session exists to submit through, no executor runs, nothing is audited", async (_name, evidence) => {
    const run = await start();
    expect(await run.host.openSession(evidence(run))).toBeNull();
    expect(run.trusted.executorCalls()).toBe(0);
    expect(await rows(run.tenant)).toEqual([]);
  });
  it("the model cannot invent an identity: with no session there is nothing to submit through, and a proposal that names alice runs only as the session it is bound to", async () => {
    const run = await start();
    expect(await run.host.openSession(undefined)).toBeNull();
    const asCarol = await open(run, "carol");
    const feedback = await asCarol.submit(proposal("demoSaveNote", SAVE, { userId: "alice" }));
    expect(feedback.outcome).not.toBe("ALLOWED");
    expect(run.trusted.executorCalls()).toBe(0);
    for (const row of await rows(run.tenant)) expect(row.user_id).toBe("carol");
  });
});

describe("3. an UNAUTHORIZED user is denied", () => {
  it("a valid session without the required permission: DENIED, executor calls 0, the denial is audited", async () => {
    const run = await start();
    const bob = await open(run, "bob");
    expect(await bob.submit(proposal("demoSaveNote", SAVE))).toEqual({ outcome: "UNAUTHORIZED", category: "not_available" });
    const carol = await open(run, "carol");
    expect(await carol.submit(proposal("demoLookup", { topic: "weather" }))).toEqual({ outcome: "UNAUTHORIZED", category: "not_available" });
    expect(run.trusted.executorCalls()).toBe(0);
    const trail = await rows(run.tenant);
    expect(trail.map((row) => row.event_type)).toEqual(["AI_ACTION_PROPOSED", "AI_ACTION_DENIED", "AI_ACTION_PROPOSED", "AI_ACTION_DENIED"]);
    expect(trail.filter((row) => row.event_type === "AI_ACTION_DENIED").map((row) => [row.user_id, row.outcome, row.reason])).toEqual([["bob", "UNAUTHORIZED", "permission_missing"], ["carol", "UNAUTHORIZED", "permission_missing"]]);
  });
});

describe("4. a persistent AUDIT failure on the state-changing capability fails closed", () => {
  it("the REAL durable ALLOWED append fails inside PostgreSQL: nothing executes, nothing is ALLOWED, no EXECUTED event exists", async () => {
    const run = await start();
    const fault = `host_t136_fail_${randomUUID().replaceAll("-", "")}`;
    // A genuine PostgreSQL-level fault for THIS test's tenant only: a BEFORE INSERT trigger, installed by the table owner, refuses the ALLOWED event.
    await owner.query(`CREATE FUNCTION public.${fault}() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.tenant_id = '${run.tenant}'::uuid AND NEW.event_type = 'AI_ACTION_ALLOWED' THEN RAISE EXCEPTION 'injected audit failure'; END IF; RETURN NEW; END $$`);
    await owner.query(`CREATE TRIGGER ${fault} BEFORE INSERT ON public.sec_audit_events FOR EACH ROW EXECUTE FUNCTION public.${fault}()`);
    try {
      const session = await open(run, "alice");
      const feedback = await session.submit(proposal("demoSaveNote", SAVE));
      expect(feedback, "fail closed: never ALLOWED, and the planner is told only to try later").toEqual({ outcome: "DENIED", category: "try_later" });
      expect(run.trusted.executorCalls()).toBe(0);
      expect(run.trusted.effects()).toEqual([]);
      const types = await kinds(run.tenant);
      expect(types).not.toContain("AI_ACTION_ALLOWED");
      expect(types).not.toContain("AI_ACTION_EXECUTED");
    } finally {
      await owner.query(`DROP TRIGGER IF EXISTS ${fault} ON public.sec_audit_events`);
      await owner.query(`DROP FUNCTION IF EXISTS public.${fault}()`);
    }
  });
});

describe("5. a CONFIRMATION-REQUIRED capability stops at REQUIRES_CONFIRMATION", () => {
  it("HIGH: REQUIRES_CONFIRMATION, executor calls 0 (no confirmation service exists), and the planner learns no confirmation handle", async () => {
    const run = await start();
    const session = await open(run, "alice");
    const feedback = await session.submit(proposal("demoPublishNote", { noteId: "note-1" }));
    expect(feedback).toEqual({ outcome: "REQUIRES_CONFIRMATION", category: "needs_user_confirmation" });
    expect(run.trusted.executorCalls()).toBe(0);
    expect(run.trusted.effects()).toEqual([]);
    const types = await kinds(run.tenant);
    expect(types).not.toContain("AI_ACTION_ALLOWED");
    expect(types).not.toContain("AI_ACTION_EXECUTED");
  });
});

describe("6. the AI-facing handle (the call boundary; the import and type boundary is in tests/architecture/graph.test.ts)", () => {
  it("is ONE frozen function: no registry, executor table, executors, stores, audit reader, mint API, confirmation service or context can be reached through it", async () => {
    const run = await start();
    const session = await open(run, "alice");
    expect(Object.getPrototypeOf(session)).toBe(Object.prototype);
    expect(Reflect.ownKeys(session)).toEqual(["submit"]);
    expect(Object.isFrozen(session)).toBe(true);
    expect(Object.isFrozen(session.submit)).toBe(true);
    expect(Reflect.ownKeys(session.submit).sort()).toEqual(["length", "name"]);
    // The host side is two methods; the executors' view is a different object, and neither is a member of the other.
    expect(Reflect.ownKeys(run.host).sort()).toEqual(["close", "openSession"]);
    expect(Reflect.ownKeys(run.trusted).sort()).toEqual(["effects", "executorCalls", "receivedCalls"]);
    for (const name of ["trusted", "executors", "registry", "executorFor", "audit", "reader", "pool", "stores", "confirmations", "decide", "context", "security"]) {
      expect(name in session, name).toBe(false);
    }
  });
});

describe("QA host boundary probes",()=>{
 it("throwing accessors and object call ids never escape/coerce, and a clean control executes",async()=>{
  const run=await start(); const session=await open(run,"alice");let coerced=0;
  for(const call of [
   {get providerCallId(){throw new Error("SECRET provider getter");},arguments:"{}"},
   {providerCallId:"getter",get arguments(){throw new Error("SECRET argument getter");}},
   {providerCallId:{toString(){coerced++;return "forged";}},arguments:JSON.stringify({action:"demoSaveNote",params:SAVE})},
   new Proxy({}, {get(){throw new Error("SECRET proxy");}}),
  ]){
   const pending=session.submit(call as never);await expect(pending).resolves.toEqual({outcome:"DENIED",category:"try_later"});const answer=await pending;expect(JSON.stringify(answer)).not.toContain("SECRET");
  }
  expect(coerced).toBe(0);expect(run.trusted.executorCalls()).toBe(0);
  const cyclic:Record<string,unknown>={};cyclic.self=cyclic;
  for(const raw of [cyclic, {__proto__:null}, "x".repeat(20000)])expect((await session.submit({providerCallId:randomUUID(),arguments:raw} as never)).outcome).not.toBe("ALLOWED");
  // New trusted turn avoids a local turn limit; same authenticated user's permission still works.
  expect((await (await open(run,"alice")).submit(proposal("demoSaveNote",SAVE))).outcome).toBe("ALLOWED");
 });
 it("an already opened session expires at the Gateway on a later submit",async()=>{
  const run=await start();const session=await open(run,"alice");
  expect((await session.submit(proposal("demoLookup",{topic:"before"}))).outcome).toBe("ALLOWED");
  vi.useFakeTimers({toFake:["Date"]});
  try{vi.setSystemTime(Date.now()+7200000);expect(await session.submit(proposal("demoSaveNote",SAVE))).toEqual({outcome:"UNAUTHORIZED",category:"not_available"});expect(run.trusted.executorCalls()).toBe(1);}finally{vi.useRealTimers();}
 });
 it("submit is bound by closure, not this, and reflective access reveals no captured state",async()=>{
  const run=await start();const session=await open(run,"bob");const submit=session.submit;
  expect(await Reflect.apply(submit,{userId:"alice",trusted:run.trusted},[proposal("demoSaveNote",SAVE)])).toEqual({outcome:"UNAUTHORIZED",category:"not_available"});
  expect(run.trusted.executorCalls()).toBe(0);
  expect(Function.prototype.toString.call(submit)).not.toContain(run.token.bob);
  expect(Object.getOwnPropertyDescriptors(session).submit?.value).toBe(submit);
  // Function constructors have global scope, never the submit closure. This is not a JS sandbox.
  const constructor=Reflect.get(Object.getPrototypeOf(submit),"constructor");
  expect(await constructor("return typeof bound")()).toBe("undefined");
  expect(await submit(proposal("demoLookup",{topic:"control"}))).toEqual({outcome:"ALLOWED",category:"ok"});
 });
});
