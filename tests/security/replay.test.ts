import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import type { AttackObservation, TenantId } from "@dap/contracts";
import { DEFAULT_GATEWAY_CONFIG, InMemoryReplayGuard, PostgresReplayGuard, validateGatewayConfig } from "@dap/security";
import { FakeClock, createReplayScenarios, replayScenarios } from "@dap/testkit";
import { TEST_CLOCK } from "../../packages/security/src/state/postgres/state-runtime.js";
import { withTenant } from "../../packages/security/src/state/postgres/tenant-tx.js";
import { openStatePools } from "../../packages/security/src/state/conformance/state-pg-fixtures.js";
import { allTraits, applicable, expectPerfect, perfectObservation } from "./sequence-support.js";

const byId = (id: string) => replayScenarios.find((scenario) => scenario.id === id)!;
const safe = allTraits.find((traits) => traits.risk === "SAFE")!;
const high = allTraits.find((traits) => traits.risk === "HIGH")!;
const FAR_FUTURE = "2099-01-01T00:00:00Z"; // never expired by the real database clock: safe beside the purge tests

describe("T107 replay scenarios: catalogue", () => {
  it("defines exactly ATK-REPLAY-01..04,06..08 and ATK-XTENANT-06 (05 is ATK-CONFIRM-05)", () => {
    expect(replayScenarios.map((scenario) => scenario.id)).toEqual(["ATK-REPLAY-01", "ATK-REPLAY-02", "ATK-REPLAY-03", "ATK-REPLAY-04", "ATK-REPLAY-06", "ATK-REPLAY-07", "ATK-REPLAY-08", "ATK-XTENANT-06"]);
    expect(new Set(replayScenarios.map((scenario) => scenario.id)).size).toBe(replayScenarios.length);
    for (const scenario of replayScenarios) expect(scenario.category).toBe(scenario.id.startsWith("ATK-XTENANT") ? "cross-tenant" : "replay");
  });
  it("applies to every capability that can proceed and never to FORBIDDEN ones", () => {
    for (const scenario of replayScenarios) {
      expect(applicable(scenario).map((traits) => traits.risk)).not.toContain("FORBIDDEN");
      expect(applicable(scenario).length).toBe(allTraits.length - 1);
    }
  });
  it("ATK-REPLAY-05 is delegated to the confirmation family", () => {
    expect(replayScenarios.map((scenario) => scenario.id)).not.toContain("ATK-REPLAY-05");
  });
});

describe("T107 replay scenarios: attack plans", () => {
  const first = (id: string, traits = safe) => byId(id).rounds(traits);
  it("ATK-REPLAY-01 submits the same session and callId twice: one proceeds, then a replay", () => {
    const [a, b] = first("ATK-REPLAY-01");
    expect(a!.submissions[0]!.call.callId).toBe(b!.submissions[0]!.call.callId);
    expect(a!.submissions[0]!.actor).toEqual(b!.submissions[0]!.actor);
    expect(a!.proceeds).toEqual({ min: 1, max: 1, as: "ALLOWED" });
    expect(b!.denials).toEqual([{ outcome: "DENIED", reason: "replayed_request", min: 1, max: 1 }]);
    expect(b!.proceeds.max).toBe(0);
  });
  it("ATK-REPLAY-02 replays through a different gateway instance", () => {
    const [a, b] = first("ATK-REPLAY-02");
    expect(a!.submissions[0]!.actor.instance).toBe(1);
    expect(b!.submissions[0]!.actor).toEqual({ ...a!.submissions[0]!.actor, instance: 2 });
    expect(b!.submissions[0]!.call.callId).toBe(a!.submissions[0]!.call.callId);
  });
  it("ATK-REPLAY-03 races 50 submissions of one callId across both instances: exactly one proceeds", () => {
    const [round, ...rest] = first("ATK-REPLAY-03");
    expect(rest).toEqual([]);
    expect(round!.mode).toBe("parallel");
    expect(round!.submissions).toHaveLength(50);
    expect(new Set(round!.submissions.map((item) => item.call.callId)).size).toBe(1);
    expect(round!.submissions.filter((item) => item.actor.instance === 1)).toHaveLength(25);
    expect(round!.submissions.filter((item) => item.actor.instance === 2)).toHaveLength(25);
    expect(new Set(round!.submissions.map((item) => `${item.actor.tenant}/${item.actor.session}`)).size).toBe(1);
    expect(round!.proceeds.min).toBe(1); expect(round!.proceeds.max).toBe(1);
    expect(round!.denials).toEqual([{ outcome: "DENIED", reason: "replayed_request", min: 49, max: 49 }]);
  });
  it("ATK-REPLAY-04 crosses the configured retention boundary exactly (one second short, then the second)", () => {
    for (const retention of [86_400, 120, 7]) {
      const rounds = createReplayScenarios(validateGatewayConfig({ ...DEFAULT_GATEWAY_CONFIG, replayRetentionSeconds: retention })).find((scenario) => scenario.id === "ATK-REPLAY-04")!.rounds(safe);
      expect(rounds.map((round) => round.advanceSecondsBefore ?? 0)).toEqual([0, retention - 1, 1]);
      expect(rounds[1]!.denials[0]!.reason).toBe("replayed_request");
      expect(rounds[2]!.proceeds).toEqual({ min: 1, max: 1, as: "ALLOWED" });
    }
  });
  it("ATK-REPLAY-06 and ATK-XTENANT-06 differ only by tenant", () => {
    for (const id of ["ATK-REPLAY-06", "ATK-XTENANT-06"]) {
      const [a, b, ...rest] = first(id);
      const { tenant: ta, ...restA } = a!.submissions[0]!.actor; const { tenant: tb, ...restB } = b!.submissions[0]!.actor;
      expect([ta, tb]).toEqual(["A", "B"]);
      expect(restA).toEqual(restB);
      expect(a!.submissions[0]!.call).toEqual(b!.submissions[0]!.call);
      expect([a!.proceeds.min, b!.proceeds.min]).toEqual([1, 1]);
      expect(rest.length).toBe(id === "ATK-XTENANT-06" ? 2 : 0);
    }
    const rounds = first("ATK-XTENANT-06");
    expect(rounds.slice(2).map((round) => [round.submissions[0]!.actor.tenant, round.denials[0]!.reason])).toEqual([["A", "replayed_request"], ["B", "replayed_request"]]);
  });
  it("ATK-REPLAY-07 puts model-chosen callId/requestId in the envelope, then proves the trusted ids were never claimed", () => {
    const [hostile, control] = first("ATK-REPLAY-07");
    const keys = hostile!.submissions.map((item) => Object.keys(item.call.raw as object).filter((key) => key === "callId" || key === "requestId"));
    expect(keys.flat().sort()).toEqual(["callId", "callId", "requestId", "requestId"]);
    expect(hostile!.denials).toEqual([{ outcome: "INVALID_ACTION", reason: "malformed_envelope", min: 4, max: 4 }]);
    expect(hostile!.proceeds.max).toBe(0);
    const used = new Set(hostile!.submissions.map((item) => item.call.callId));
    expect(control!.submissions.every((item) => used.has(item.call.callId))).toBe(true);
    expect(control!.submissions.every((item) => !("callId" in (item.call.raw as object)))).toBe(true);
    expect(control!.proceeds.min).toBe(2);
  });
  it.each(allTraits.filter((traits) => traits.risk !== "FORBIDDEN"))("ATK-REPLAY-08 invalid then corrected proposal share one callId for $actionId", (traits) => {
    const [invalid, corrected] = first("ATK-REPLAY-08", traits);
    expect(invalid!.submissions[0]!.call.callId).toBe(corrected!.submissions[0]!.call.callId);
    expect(invalid!.denials).toEqual([{ outcome: "INVALID_PARAMETERS", reason: "invalid_parameters", min: 1, max: 1 }]);
    expect(corrected!.denials).toEqual([{ outcome: "DENIED", reason: "replayed_request", min: 1, max: 1 }]);
    expect(invalid!.submissions[0]!.call.raw).not.toEqual(corrected!.submissions[0]!.call.raw);
    expect((corrected!.submissions[0]!.call.raw as { action: string }).action).toBe(traits.actionId);
  });
  it("expects the planner-visible confirmation outcome for capabilities that require one", () => {
    expect(byId("ATK-REPLAY-01").rounds(high)[0]!.proceeds.as).toBe("REQUIRES_CONFIRMATION");
    expect(byId("ATK-REPLAY-01").rounds(safe)[0]!.proceeds.as).toBe("ALLOWED");
  });
});

describe("T107 replay oracle", () => {
  for (const scenario of replayScenarios) {
    for (const traits of applicable(scenario)) {
      it(`${scenario.id} (${traits.actionId}): accepts exact evidence and rejects every corruption`, () => {
        const good = expectPerfect(scenario, traits);
        const bad = (observation: AttackObservation) => scenario.verify(observation, traits);
        expect(bad({ ...good, executorCalls: good.executorCalls + 1 })).not.toEqual([]);
        expect(bad({ ...good, executorCalls: Math.max(0, good.executorCalls - 1) }).length > 0 || good.executorCalls === 0).toBe(true);
        expect(bad({ ...good, leakFindings: ["canary:$"] })).toContain("planner output leaked");
        expect(bad({ ...good, feedback: good.feedback.slice(1) })).toContain("submission count mismatch");
        expect(bad({ ...good, feedback: [...good.feedback, good.feedback[0]!] })).toContain("submission count mismatch");
        const flip = (item: AttackObservation["feedback"][number]) => item.outcome === "ALLOWED" ? { outcome: "DENIED" as const, category: "not_available" as const } : { outcome: "ALLOWED" as const, category: "ok" as const };
        expect(bad({ ...good, feedback: good.feedback.map(flip) })).not.toEqual([]);
        expect(bad({ ...good, feedback: good.feedback.map((item, index) => index === 0 ? flip(item) : item) })).not.toEqual([]);
        expect(bad({ ...good, auditEvents: [] })).not.toEqual([]);
        expect(bad({ ...good, auditEvents: good.auditEvents.filter((event) => event.type === "AI_ACTION_PROPOSED") }).length > 0 || good.auditEvents.every((event) => event.type === "AI_ACTION_PROPOSED")).toBe(true);
        expect(bad({ ...good, auditEvents: good.auditEvents.map((event) => event.reason ? { ...event, reason: "internal_error" as const } : event) }).length > 0 || good.auditEvents.every((event) => !event.reason)).toBe(true);
        expect(bad({ ...good, auditEvents: [...good.auditEvents, ...good.auditEvents.slice(0, 1)] })).toContain("duplicate audit event id");
      });
    }
    it(`${scenario.id}: without a harness the scenario fails closed instead of passing vacuously`, async () => {
      const observation = await scenario.run(safe);
      expect(scenario.verify(observation, safe)).not.toEqual([]);
    });
  }
  it("rejects an empty fixture and wrong planner feedback for ALLOWED vs confirmation", () => {
    const scenario = byId("ATK-REPLAY-01");
    const good = perfectObservation(scenario.rounds(high));
    expect(scenario.verify(good, high)).toEqual([]);
    expect(scenario.verify({ ...good, feedback: [{ outcome: "ALLOWED", category: "ok" }, good.feedback[1]!] }, high)).not.toEqual([]);
    expect(scenario.verify({ feedback: [], executorCalls: 0, auditEvents: [], leakFindings: [] }, safe)).toContain("submission count mismatch");
  });
  it("ATK-REPLAY-03 oracle detects two winners and zero winners", () => {
    const scenario = byId("ATK-REPLAY-03");
    const good = perfectObservation(scenario.rounds(safe));
    const winner = good.feedback.findIndex((item) => item.outcome === "ALLOWED");
    const twoWinners = good.feedback.map((item, index) => index === (winner + 1) % good.feedback.length ? { outcome: "ALLOWED" as const, category: "ok" as const } : item);
    expect(scenario.verify({ ...good, feedback: twoWinners, executorCalls: 2 }, safe)).not.toEqual([]);
    expect(scenario.verify({ ...good, feedback: good.feedback.map(() => ({ outcome: "DENIED" as const, category: "not_available" as const })), executorCalls: 0 }, safe)).not.toEqual([]);
  });
});

describe("T107 replay attacks against the real guards (ReplayGuard level)", () => {
  let appA: Pool; let appB: Pool; let owner: Pool;
  const tenants = new Set<string>();
  const tenant = (): { tenantId: TenantId } => { const tenantId = randomUUID() as TenantId; tenants.add(tenantId); return { tenantId }; };
  beforeAll(async () => {
    ({ app: appA, owner } = await openStatePools(Pool));
    ({ app: appB } = await openStatePools(Pool));
  });
  afterAll(async () => {
    try { if (owner) for (const tenantId of tenants) await withTenant(owner, tenantId, (client) => client.query("DELETE FROM public.sec_replay_claims WHERE tenant_id=$1", [tenantId])); }
    finally { await Promise.all([appA?.end(), appB?.end(), owner?.end()]); }
  });
  const pgClock = (epoch = FAR_FUTURE) => { const clock = new FakeClock(epoch); return { clock, options: { [TEST_CLOCK]: async () => new Date(clock.now()) } }; };
  const callKey = (session: string, callId: string) => `${session}:${callId}`;

  it("ATK-REPLAY-01/02 a duplicate is denied by the same guard, and by a second gateway instance (second pool) on the same database", async () => {
    const { options } = pgClock();
    const one = new PostgresReplayGuard(appA, options); const two = new PostgresReplayGuard(appB, options);
    const scope = tenant(); const key = callKey("ai-session", randomUUID());
    expect(await one.claim(scope, key, 86_400)).toBe("claimed");
    expect(await one.claim(scope, key, 86_400)).toBe("duplicate");
    expect(await two.claim(scope, key, 86_400)).toBe("duplicate");
    expect(await new PostgresReplayGuard(appB, options).claim(scope, key, 86_400)).toBe("duplicate");
  });
  it("ATK-REPLAY-03 50 parallel claims of one key across two instances: exactly one wins", async () => {
    for (let trial = 0; trial < 10; trial++) {
      const { options } = pgClock();
      const guards = [new PostgresReplayGuard(appA, options), new PostgresReplayGuard(appB, options)];
      const scope = tenant(); const key = callKey("ai-session", `race-${trial}`);
      const results = await Promise.all(Array.from({ length: 50 }, (_, index) => guards[index % 2]!.claim(scope, key, 86_400)));
      expect(results.filter((item) => item === "claimed")).toHaveLength(1);
      expect(results.filter((item) => item === "duplicate")).toHaveLength(49);
    }
  });
  it.each([["postgres", () => { const { clock, options } = pgClock("2020-01-01T00:00:00Z"); return { clock, guard: new PostgresReplayGuard(appA, options) }; }],
    ["memory", () => { const clock = new FakeClock(FAR_FUTURE); return { clock, guard: new InMemoryReplayGuard(clock) }; }]] as const)("ATK-REPLAY-04 (%s) the retention boundary is exact: duplicate one second short, processed again at the boundary", async (_name, make) => {
    const { clock, guard } = make(); const scope = tenant(); const key = callKey("ai-session", randomUUID());
    expect(await guard.claim(scope, key, 120)).toBe("claimed");
    clock.advance(119);
    expect(await guard.claim(scope, key, 120)).toBe("duplicate");
    clock.advance(1);
    expect(await guard.claim(scope, key, 120)).toBe("claimed");
    expect(await guard.claim(scope, key, 120)).toBe("duplicate");
  });
  it("ATK-REPLAY-06 / ATK-XTENANT-06 the same session and callId in tenants A and B claim independently and each replays only within its tenant", async () => {
    const { options } = pgClock();
    const guard = new PostgresReplayGuard(appA, options); const other = new PostgresReplayGuard(appB, options);
    const a = tenant(); const b = tenant(); const key = callKey("ai-session", randomUUID());
    expect(await guard.claim(a, key, 86_400)).toBe("claimed");
    expect(await other.claim(b, key, 86_400)).toBe("claimed");
    expect(await other.claim(a, key, 86_400)).toBe("duplicate");
    expect(await guard.claim(b, key, 86_400)).toBe("duplicate");
    // A tenant id smuggled inside the key text cannot reach another tenant's claim.
    expect(await guard.claim(a, callKey("ai-session", `${b.tenantId}:${randomUUID()}`), 86_400)).toBe("claimed");
  });
  it("ATK-REPLAY-08 the claim is taken per (session, callId) regardless of the proposal content that follows", async () => {
    const { options } = pgClock();
    const guard = new PostgresReplayGuard(appA, options); const scope = tenant(); const key = callKey("ai-session", randomUUID());
    expect(await guard.claim(scope, key, 86_400)).toBe("claimed"); // the invalid proposal consumes the id
    expect(await guard.claim(scope, key, 86_400)).toBe("duplicate"); // the corrected proposal is a replay
    expect(await guard.claim(scope, callKey("ai-session-2", key), 86_400)).toBe("claimed");
  });
});

describe("T107 end-to-end replay attacks (OPTIONAL as catalogue runs)", () => {
  const waiting = "the bounded representative real-gateway replay controls (duplicate callId, a new instance on the same store, 50 parallel submissions, model-supplied ids, per-tenant independence) are REQUIRED and run in rate-replay.gateway.test.ts; this catalogue verify() form is T107 (OPTIONAL)";
  for (const scenario of replayScenarios) it.todo(`${scenario.id} (OPTIONAL, T107) ${scenario.title}: run against the real gateway and verify(); ${waiting}`);
  it.todo("ATK-REPLAY-05 (OPTIONAL, T096): replay of a consumed confirmation; covered by ATK-CONFIRM-05 and needs the confirmation service, which Feature 001 M1 does not build");
});
