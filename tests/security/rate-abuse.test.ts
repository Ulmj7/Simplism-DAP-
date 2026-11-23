import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import type { AttackObservation, LimitConfig, RateLimiter, RateLimitResult, RateLimitRule, TenantId, TenantScope } from "@dap/contracts";
import { DEFAULT_LIMIT_CONFIG, InMemoryRateLimiter, PostgresRateLimiter, createLimiter, validateLimitConfig, type Limiter, type LimitVerdict, type ProposalLimitInput } from "@dap/security";
import { FakeClock, createRateAbuseScenarios, rateAbuseScenarios } from "@dap/testkit";
import { TEST_CLOCK } from "../../packages/security/src/state/postgres/state-runtime.js";
import { withTenant } from "../../packages/security/src/state/postgres/tenant-tx.js";
import { openStatePools } from "../../packages/security/src/state/conformance/state-pg-fixtures.js";
import { allTraits, applicable, expectPerfect, perfectObservation } from "./sequence-support.js";

const byId = (id: string) => rateAbuseScenarios.find((scenario) => scenario.id === id)!;
const safe = allTraits.find((traits) => traits.risk === "SAFE")!;
const high = allTraits.find((traits) => traits.risk === "HIGH")!;
const critical = allTraits.find((traits) => traits.risk === "CRITICAL")!;
const limits = DEFAULT_LIMIT_CONFIG;
const FAR_FUTURE = "2099-01-01T00:00:00Z"; // never expired by the real database clock: safe beside the purge tests

describe("T108 rate-abuse scenarios: catalogue", () => {
  it("defines exactly ATK-RATE-01..08 and ATK-XTENANT-08", () => {
    expect(rateAbuseScenarios.map((scenario) => scenario.id)).toEqual(["ATK-RATE-01", "ATK-RATE-02", "ATK-RATE-03", "ATK-RATE-04", "ATK-RATE-05", "ATK-RATE-06", "ATK-RATE-07", "ATK-RATE-08", "ATK-XTENANT-08"]);
    for (const scenario of rateAbuseScenarios) expect(scenario.category).toBe(scenario.id.startsWith("ATK-XTENANT") ? "cross-tenant" : "rate-abuse");
  });
  it("applies RATE-04 only to HIGH and CRITICAL capabilities and never proceeds on FORBIDDEN ones", () => {
    expect(applicable(byId("ATK-RATE-04")).map((traits) => traits.risk)).toEqual(["HIGH", "CRITICAL"]);
    for (const id of ["ATK-RATE-01", "ATK-RATE-03", "ATK-RATE-05", "ATK-RATE-06", "ATK-RATE-07", "ATK-RATE-08", "ATK-XTENANT-08"]) expect(applicable(byId(id)).map((traits) => traits.risk)).not.toContain("FORBIDDEN");
    expect(applicable(byId("ATK-RATE-02")).length).toBe(allTraits.length);
  });
});

describe("T108 rate-abuse scenarios: attack plans", () => {
  it("ATK-RATE-01 floods 10,000 proposals into one turn and caps executions and shared-store cost", () => {
    const [round] = byId("ATK-RATE-01").rounds(safe);
    expect(round!.submissions).toHaveLength(10_000);
    expect(new Set(round!.submissions.map((item) => item.call.callId)).size).toBe(10_000);
    expect(new Set(round!.submissions.map((item) => `${item.actor.session}/${item.actor.turn}`)).size).toBe(1);
    expect(round!.proceeds).toEqual({ min: 1, max: limits.executionsPerTurn, as: "ALLOWED" });
    expect(byId("ATK-RATE-01").sharedStoreCallBudget!(safe)).toBe(limits.proposalsPerTurn * 12);
    expect(byId("ATK-RATE-01").sharedStoreCallBudget!(safe)).toBeLessThan(10_000 / 10);
    expect(byId("ATK-RATE-01").rounds(high)[0]!.proceeds.as).toBe("REQUIRES_CONFIRMATION");
    expect(byId("ATK-RATE-01").rounds(high)[0]!.proceeds.max).toBe(Math.min(limits.proposalsPerTurn, limits.highRiskPerUserPerHour.limit));
  });
  it("ATK-RATE-02 sends limit+1 proposals from one user in fresh sessions, then proves independence and rollover", () => {
    const [flood, bob, other, next] = byId("ATK-RATE-02").rounds(safe);
    expect(flood!.submissions).toHaveLength(limits.perUserPerMinute.limit + 1);
    expect(new Set(flood!.submissions.map((item) => item.actor.user)).size).toBe(1);
    expect(new Set(flood!.submissions.map((item) => item.actor.session)).size).toBe(limits.perUserPerMinute.limit + 1);
    expect(flood!.denials.map((item) => [item.reason, item.min])).toEqual([["unknown_action", 60], ["rate_limited_user", 1]]);
    expect(bob!.submissions[0]!.actor.user).not.toBe(flood!.submissions[0]!.actor.user);
    expect(other!.submissions[0]!.actor.tenant).toBe("B");
    expect(next!.advanceSecondsBefore).toBe(limits.perUserPerMinute.windowSeconds);
    expect(byId("ATK-RATE-02").rounds(allTraits.find((traits) => traits.risk === "FORBIDDEN")!)).toHaveLength(1);
  });
  it("ATK-RATE-03 uses the per-capability limit (or the stricter hourly risk limit for HIGH/CRITICAL)", () => {
    const [low] = byId("ATK-RATE-03").rounds(safe);
    expect(low!.submissions).toHaveLength(limits.perUserPerCapabilityPerMinute.limit + 1);
    expect(low!.denials[0]!.reason).toBe("rate_limited_capability");
    const [risky] = byId("ATK-RATE-03").rounds(critical);
    expect(risky!.submissions).toHaveLength(limits.highRiskPerUserPerHour.limit + 1);
    expect(risky!.denials[0]!.reason).toBe("rate_limited_risk");
    const wide = createRateAbuseScenarios(validateLimitConfig({ ...limits, highRiskPerUserPerHour: { limit: 500, windowSeconds: 3600 } })).find((scenario) => scenario.id === "ATK-RATE-03")!;
    expect(wide.rounds(critical)[0]!.denials[0]!.reason).toBe("rate_limited_capability");
  });
  it("ATK-RATE-04 exceeds the hourly HIGH/CRITICAL limit with confirmation-gated proposals and rolls over after the window", () => {
    for (const traits of [high, critical]) {
      const [flood, bob, next] = byId("ATK-RATE-04").rounds(traits);
      expect(flood!.submissions).toHaveLength(limits.highRiskPerUserPerHour.limit + 1);
      expect(flood!.proceeds).toEqual({ min: 10, max: 10, as: "REQUIRES_CONFIRMATION" });
      expect(flood!.denials).toEqual([{ outcome: "DENIED", reason: "rate_limited_risk", min: 1, max: 1 }]);
      expect(bob!.submissions[0]!.actor.user).toBe("bob");
      expect(next!.advanceSecondsBefore).toBe(3600);
    }
  });
  it("ATK-RATE-05 crosses the denial throttle in one session; only that session is blocked until the period ends", () => {
    const [setup, blocked, other, recovered] = byId("ATK-RATE-05").rounds(safe);
    expect(setup!.submissions).toHaveLength(limits.denialThrottle.denials + 1);
    expect(new Set(setup!.submissions.map((item) => item.actor.session))).toEqual(new Set(["session-1"]));
    expect(setup!.denials.map((item) => [item.reason, item.min, item.max])).toEqual([["unknown_action", 5, 6], ["denial_throttle", 0, 1]]);
    expect(blocked!.submissions[0]!.actor.session).toBe("session-1");
    expect(blocked!.denials).toEqual([{ outcome: "DENIED", reason: "denial_throttle", min: 1, max: 1 }]);
    expect(other!.submissions[0]!.actor.session).toBe("session-2");
    expect(recovered!.advanceSecondsBefore).toBe(limits.denialThrottle.blockSeconds);
    expect(recovered!.submissions[0]!.actor.session).toBe("session-1");
  });
  it("ATK-RATE-06 injects each limiter fault mode, expects a dependency denial every time, then a recovery", () => {
    const rounds = byId("ATK-RATE-06").rounds(safe);
    expect(rounds.map((round) => round.fault)).toEqual(["throws", "hangs", "wrong_type", "full_store", "none"]);
    for (const round of rounds.slice(0, 4)) expect(round.denials).toEqual([{ outcome: "DENIED", reason: "dependency_failure", min: 1, max: 1 }]);
    expect(rounds[4]!.proceeds.min).toBe(1);
  });
  it("ATK-RATE-07 contrasts the maximum chain depth with one above it", () => {
    const [ok, over] = byId("ATK-RATE-07").rounds(safe);
    expect(ok!.submissions[0]!.actor.depth).toBe(limits.maxChainDepth);
    expect(over!.submissions[0]!.actor.depth).toBe(limits.maxChainDepth + 1);
    expect(over!.denials[0]!.reason).toBe("rate_limited_turn");
  });
  it("ATK-RATE-08 advances the clock past the turn budget inside one turn", () => {
    const [first, late] = byId("ATK-RATE-08").rounds(safe);
    expect(first!.submissions[0]!.actor.turn).toBe(late!.submissions[0]!.actor.turn);
    expect(late!.advanceSecondsBefore).toBe(limits.turnBudgetMs / 1000 + 1);
    const slow = createRateAbuseScenarios(validateLimitConfig({ ...limits, turnBudgetMs: 1500 })).find((scenario) => scenario.id === "ATK-RATE-08")!;
    expect(slow.rounds(safe)[1]!.advanceSecondsBefore).toBe(2);
  });
  it("ATK-XTENANT-08 throttles and exhausts tenant A, then shows tenant B with the same ids unaffected", () => {
    const rounds = byId("ATK-XTENANT-08").rounds(safe);
    expect(rounds.map((round) => round.submissions[0]!.actor.tenant)).toEqual(["A", "A", "B", "A", "B"]);
    expect(rounds[2]!.submissions[0]!.actor.session).toBe(rounds[0]!.submissions[0]!.actor.session);
    expect(rounds[2]!.submissions[0]!.actor.user).toBe(rounds[0]!.submissions[0]!.actor.user);
    expect(rounds[3]!.submissions).toHaveLength(limits.perUserPerMinute.limit);
    // The exhausting submissions never reuse the throttled session.
    expect(rounds[3]!.submissions.some((item) => item.actor.session === "session-1")).toBe(false);
    expect(rounds[4]!.submissions[0]!.actor.user).toBe(rounds[3]!.submissions[0]!.actor.user);
  });
  it("scenario expectations follow the configured limits", () => {
    const tight = validateLimitConfig({ ...limits, perUserPerMinute: { limit: 3, windowSeconds: 10 }, executionsPerTurn: 2, denialThrottle: { denials: 2, windowSeconds: 30, blockSeconds: 40 } });
    const set = createRateAbuseScenarios(tight);
    expect(set.find((scenario) => scenario.id === "ATK-RATE-02")!.rounds(safe)[0]!.submissions).toHaveLength(4);
    expect(set.find((scenario) => scenario.id === "ATK-RATE-01")!.rounds(safe)[0]!.proceeds.max).toBe(2);
    expect(set.find((scenario) => scenario.id === "ATK-RATE-05")!.rounds(safe)[0]!.submissions).toHaveLength(3);
    expect(set.find((scenario) => scenario.id === "ATK-RATE-05")!.rounds(safe)[3]!.advanceSecondsBefore).toBe(40);
  });
});

describe("T108 rate-abuse oracle", () => {
  for (const scenario of rateAbuseScenarios) {
    for (const traits of applicable(scenario)) {
      it(`${scenario.id} (${traits.actionId}): accepts exact evidence and rejects every corruption`, () => {
        const good = expectPerfect(scenario, traits);
        const bad = (observation: AttackObservation) => scenario.verify(observation, traits);
        expect(bad({ ...good, executorCalls: 10_001 })).not.toEqual([]);
        if (good.executorCalls > 0) expect(bad({ ...good, executorCalls: 0 })).not.toEqual([]);
        expect(bad({ ...good, leakFindings: ["canary:$"] })).toContain("planner output leaked");
        expect(bad({ ...good, feedback: good.feedback.slice(1) })).toContain("submission count mismatch");
        const flip = (item: AttackObservation["feedback"][number]) => item.outcome === "ALLOWED" ? { outcome: "DENIED" as const, category: "not_available" as const } : { outcome: "ALLOWED" as const, category: "ok" as const };
        expect(bad({ ...good, feedback: good.feedback.map(flip) })).not.toEqual([]);
        expect(bad({ ...good, auditEvents: [] })).not.toEqual([]);
        expect(bad({ ...good, auditEvents: [...good.auditEvents, ...good.auditEvents.slice(0, 1)] })).toContain("duplicate audit event id");
        if (good.auditEvents.some((event) => event.reason)) {
          expect(bad({ ...good, auditEvents: good.auditEvents.map((event) => event.reason ? { ...event, reason: "internal_error" as const } : event) })).not.toEqual([]);
          expect(bad({ ...good, auditEvents: good.auditEvents.filter((event) => !event.reason) })).not.toEqual([]);
          expect(bad({ ...good, auditEvents: good.auditEvents.map((event) => event.type === "AI_RATE_LIMITED" ? { ...event, type: "AI_ACTION_DENIED" as const } : event) })).toEqual(
            good.auditEvents.some((event) => event.type === "AI_RATE_LIMITED") ? expect.arrayContaining([expect.any(String)]) : [],
          );
        }
        if (scenario.sharedStoreCallBudget) {
          const budget = scenario.sharedStoreCallBudget(traits);
          expect(bad({ ...good, sharedStoreCalls: budget } as AttackObservation)).toEqual([]);
          expect(bad({ ...good, sharedStoreCalls: budget + 1 } as AttackObservation)).toContain(`shared store calls ${budget + 1} exceed ${budget}`);
          expect(bad({ feedback: good.feedback, executorCalls: good.executorCalls, auditEvents: good.auditEvents, leakFindings: [] })).toContain("shared store calls not measured");
        }
      });
    }
    it(`${scenario.id}: without a harness the scenario fails closed instead of passing vacuously`, async () => {
      const observation = await scenario.run(safe);
      expect(scenario.verify(observation, safe)).not.toEqual([]);
    });
  }
  it("ATK-RATE-01 oracle rejects more executions than the per-turn cap and an unthrottled flood", () => {
    const scenario = byId("ATK-RATE-01");
    const good = perfectObservation(scenario.rounds(safe), 0);
    expect(scenario.verify({ ...good, executorCalls: limits.executionsPerTurn + 1 }, safe)).not.toEqual([]);
    expect(scenario.verify({ ...good, feedback: good.feedback.map(() => ({ outcome: "ALLOWED" as const, category: "ok" as const })), executorCalls: 10_000 }, safe)).not.toEqual([]);
  });
  it("ATK-RATE-06 oracle rejects an allowed proposal while the limiter is faulted", () => {
    const scenario = byId("ATK-RATE-06");
    const good = perfectObservation(scenario.rounds(safe));
    const leaked = good.feedback.map((item, index) => index === 0 ? { outcome: "ALLOWED" as const, category: "ok" as const } : item);
    expect(scenario.verify({ ...good, feedback: leaked, executorCalls: good.executorCalls + 1 }, safe)).not.toEqual([]);
  });
});

// ---------------------------------------------------------------------------------------------
// Direct attacks on the limiter library over the real adapters (memory and PostgreSQL).
// ---------------------------------------------------------------------------------------------
interface Harness {
  readonly clock: FakeClock;
  readonly store: RateLimiter;
  readonly calls: () => number;
  readonly make: (config?: LimitConfig, store?: RateLimiter) => Limiter;
}
class Counting implements RateLimiter {
  count = 0;
  constructor(private readonly inner: RateLimiter) {}
  hit(scope: TenantScope, key: string, rule: RateLimitRule): Promise<RateLimitResult> { this.count++; return this.inner.hit(scope, key, rule); }
  isBlocked(scope: TenantScope, key: string): Promise<boolean> { this.count++; return this.inner.isBlocked(scope, key); }
  block(scope: TenantScope, key: string, seconds: number): Promise<void> { this.count++; return this.inner.block(scope, key, seconds); }
}
class ManualTimer {
  time = 0; private next = 0;
  readonly pending = new Map<number, { at: number; callback: () => void }>();
  now(): number { return this.time; }
  setTimeout(callback: () => void, ms: number): number { const id = this.next++; this.pending.set(id, { at: this.time + ms, callback }); return id; }
  clearTimeout(handle: unknown): void { this.pending.delete(handle as number); }
  advance(ms: number): void { this.time += ms; for (const [id, entry] of [...this.pending]) if (entry.at <= this.time) { this.pending.delete(id); entry.callback(); } }
}

let app: Pool; let owner: Pool;
const tenants = new Set<string>();
const newTenant = (): TenantScope => { const tenantId = randomUUID() as TenantId; tenants.add(tenantId); return { tenantId }; };
beforeAll(async () => { ({ app, owner } = await openStatePools(Pool)); });
afterAll(async () => {
  try {
    if (owner) for (const tenantId of tenants) await withTenant(owner, tenantId, async (client) => {
      for (const table of ["sec_rate_counters", "sec_rate_blocks"]) await client.query(`DELETE FROM public.${table} WHERE tenant_id=$1`, [tenantId]);
    });
  } finally { await Promise.all([app?.end(), owner?.end()]); }
});
const harnesses: ReadonlyArray<readonly [string, (maxEntries?: number) => Harness]> = [
  ["memory", (maxEntries) => {
    const clock = new FakeClock(FAR_FUTURE); const counting = new Counting(new InMemoryRateLimiter(clock, maxEntries ? { maxEntries } : {}));
    return { clock, store: counting, calls: () => counting.count, make: (config = limits, store: RateLimiter = counting) => createLimiter({ rateLimiter: store, config, clock }) };
  }],
  ["postgres", () => {
    const clock = new FakeClock(FAR_FUTURE); const counting = new Counting(new PostgresRateLimiter(app, { [TEST_CLOCK]: async () => new Date(clock.now()) }));
    return { clock, store: counting, calls: () => counting.count, make: (config = limits, store: RateLimiter = counting) => createLimiter({ rateLimiter: store, config, clock }) };
  }],
];
const proposal = (harness: Harness, scope: TenantScope, over: Partial<ProposalLimitInput> = {}): ProposalLimitInput => ({
  scope, userId: "alice", aiSessionId: "session-1", turnId: `turn-${randomUUID()}`, chainDepth: 0, turnStartedAt: harness.clock.now(), ...over,
});
const reasonOf = (verdict: LimitVerdict): string => verdict.allowed ? "allowed" : verdict.reason;

describe.each(harnesses)("T108 direct limiter attacks over the %s adapter", (_name, build) => {
  it("ATK-RATE-01 10,000 proposals in one turn: at most the cap is admitted, at most the execution cap executes, bounded shared-store calls", async () => {
    const h = build(); const limiter = h.make(); const scope = newTenant();
    const input = proposal(h, scope, { turnId: "flood" });
    let admitted = 0; let executions = 0;
    for (let index = 0; index < 10_000; index++) {
      if (!(await limiter.checkProposal(input)).allowed) continue;
      admitted++;
      if ((await limiter.claimExecution({ scope, aiSessionId: "session-1", turnId: "flood" })).allowed) executions++;
    }
    expect(admitted).toBe(limits.proposalsPerTurn);
    expect(executions).toBe(limits.executionsPerTurn);
    // isBlocked + turn + tenant + user per admitted proposal, plus one claim per executed one: constant, not 10,000.
    expect(h.calls()).toBe(limits.proposalsPerTurn * 4 + limits.executionsPerTurn);
  });

  it("ATK-RATE-02 per-user limit: the next proposal is denied as rate_limited_user; other users, tenants and the next window are unaffected", async () => {
    const h = build(); const limiter = h.make(); const a = newTenant(); const b = newTenant();
    for (let index = 0; index < limits.perUserPerMinute.limit; index++) expect((await limiter.checkProposal(proposal(h, a, { aiSessionId: `s${index}` }))).allowed).toBe(true);
    const over = await limiter.checkProposal(proposal(h, a, { aiSessionId: "s-over" }));
    expect(over).toMatchObject({ allowed: false, outcome: "DENIED", reason: "rate_limited_user", limit: "user" });
    expect((await limiter.checkProposal(proposal(h, a, { userId: "bob" }))).allowed).toBe(true);
    expect((await limiter.checkProposal(proposal(h, b))).allowed).toBe(true);
    h.clock.advance(limits.perUserPerMinute.windowSeconds);
    expect((await limiter.checkProposal(proposal(h, a))).allowed).toBe(true);
  });

  it("ATK-RATE-03 per-user per-capability limit", async () => {
    const h = build(); const limiter = h.make(); const scope = newTenant();
    const input = { scope, userId: "alice", actionId: "testSafeEcho", risk: "SAFE" as const };
    for (let index = 0; index < limits.perUserPerCapabilityPerMinute.limit; index++) expect((await limiter.checkCapability(input)).allowed).toBe(true);
    expect(await limiter.checkCapability(input)).toMatchObject({ allowed: false, reason: "rate_limited_capability" });
    expect((await limiter.checkCapability({ ...input, actionId: "testLowNavigate" })).allowed).toBe(true);
    expect((await limiter.checkCapability({ ...input, userId: "bob" })).allowed).toBe(true);
  });

  it("ATK-RATE-04 HIGH and CRITICAL attempts share one hourly budget per user", async () => {
    const h = build(); const limiter = h.make(); const scope = newTenant();
    for (let index = 0; index < limits.highRiskPerUserPerHour.limit; index++) expect((await limiter.checkCapability({ scope, userId: "alice", actionId: `a${index}`, risk: index % 2 ? "CRITICAL" : "HIGH" })).allowed).toBe(true);
    expect(await limiter.checkCapability({ scope, userId: "alice", actionId: "next", risk: "HIGH" })).toMatchObject({ allowed: false, reason: "rate_limited_risk", limit: "risk" });
    expect(await limiter.checkCapability({ scope, userId: "alice", actionId: "next2", risk: "CRITICAL" })).toMatchObject({ allowed: false, reason: "rate_limited_risk" });
    expect((await limiter.checkCapability({ scope, userId: "alice", actionId: "safe", risk: "SAFE" })).allowed).toBe(true);
    h.clock.advance(limits.highRiskPerUserPerHour.windowSeconds);
    expect((await limiter.checkCapability({ scope, userId: "alice", actionId: "next", risk: "HIGH" })).allowed).toBe(true);
  });

  it("ATK-RATE-05 repeated denials block only that AI session for the configured period", async () => {
    const h = build(); const limiter = h.make(); const scope = newTenant();
    for (let index = 0; index <= limits.denialThrottle.denials; index++) await limiter.recordDenial({ scope, aiSessionId: "session-1" });
    expect(await limiter.checkProposal(proposal(h, scope))).toMatchObject({ allowed: false, reason: "denial_throttle" });
    expect((await limiter.checkProposal(proposal(h, scope, { aiSessionId: "session-2" }))).allowed).toBe(true);
    h.clock.advance(limits.denialThrottle.blockSeconds - 1);
    expect(await limiter.checkProposal(proposal(h, scope))).toMatchObject({ allowed: false, reason: "denial_throttle" });
    h.clock.advance(1);
    expect((await limiter.checkProposal(proposal(h, scope))).allowed).toBe(true);
  });

  it("ATK-RATE-06 limiter unavailable (throws, hangs, wrong type, full store): every proposal is denied, then recovery", async () => {
    const h = build(); const scope = newTenant(); const timer = new ManualTimer();
    const make = (store: RateLimiter) => createLimiter({ rateLimiter: store, config: limits, clock: h.clock, timer });
    const faults: Array<[string, RateLimiter]> = [
      ["throws", { hit: () => Promise.reject(new Error("down")), isBlocked: () => Promise.reject(new Error("down")), block: () => Promise.reject(new Error("down")) }],
      ["hangs", { hit: () => new Promise<RateLimitResult>(() => undefined), isBlocked: () => new Promise<boolean>(() => undefined), block: () => new Promise<void>(() => undefined) }],
      ["wrong type", { hit: (() => Promise.resolve("allowed")) as never, isBlocked: (() => Promise.resolve("no")) as never, block: (() => Promise.resolve(1)) as never }],
    ];
    for (const [name, store] of faults) {
      const pending = make(store).checkProposal(proposal(h, scope));
      await new Promise((resolve) => { setImmediate(resolve); });
      timer.advance(2000);
      expect(await pending, name).toMatchObject({ allowed: false, outcome: "DENIED", reason: "dependency_failure" });
    }
    // A full store (capacity 1) denies as well; it is the real in-memory adapter's behaviour.
    const full = new InMemoryRateLimiter(h.clock, { maxEntries: 1 });
    expect(await make(full).checkProposal(proposal(h, scope))).toMatchObject({ allowed: false, reason: "dependency_failure" });
    expect((await h.make().checkProposal(proposal(h, scope))).allowed).toBe(true);
  });

  it("ATK-RATE-07 chain depth above the maximum is denied before any shared-store call", async () => {
    const h = build(); const limiter = h.make(); const scope = newTenant();
    expect((await limiter.checkProposal(proposal(h, scope, { chainDepth: limits.maxChainDepth }))).allowed).toBe(true);
    const before = h.calls();
    expect(await limiter.checkProposal(proposal(h, scope, { chainDepth: limits.maxChainDepth + 1 }))).toMatchObject({ allowed: false, reason: "rate_limited_turn", limit: "chain_depth" });
    expect(h.calls()).toBe(before);
  });

  it("ATK-RATE-08 the turn wall-clock budget is read from the clock port, exactly at the boundary", async () => {
    const h = build(); const limiter = h.make(); const scope = newTenant();
    const startedAt = h.clock.now();
    h.clock.advance(limits.turnBudgetMs / 1000);
    expect((await limiter.checkProposal(proposal(h, scope, { turnStartedAt: startedAt }))).allowed).toBe(true);
    h.clock.advance(1);
    const before = h.calls();
    expect(await limiter.checkProposal(proposal(h, scope, { turnStartedAt: startedAt }))).toMatchObject({ allowed: false, reason: "rate_limited_turn", limit: "turn_budget" });
    expect(h.calls()).toBe(before);
  });

  it("ATK-XTENANT-08 tenant A's turn cap, user limit and denial throttle never affect tenant B with identical ids", async () => {
    const h = build(); const limiter = h.make(); const a = newTenant(); const b = newTenant();
    const same = { aiSessionId: "session-1", turnId: "turn-1", userId: "alice" };
    for (let index = 0; index < limits.proposalsPerTurn + 3; index++) await limiter.checkProposal(proposal(h, a, same));
    for (let index = 0; index <= limits.denialThrottle.denials; index++) await limiter.recordDenial({ scope: a, aiSessionId: "session-1" });
    for (let index = 0; index < limits.perUserPerMinute.limit; index++) await limiter.checkProposal(proposal(h, a, { aiSessionId: `x${index}` }));
    expect(reasonOf(await limiter.checkProposal(proposal(h, a, same)))).not.toBe("allowed");
    for (let index = 0; index < limits.proposalsPerTurn; index++) expect(reasonOf(await limiter.checkProposal(proposal(h, b, same)))).toBe("allowed");
    expect(await limiter.recordDenial({ scope: b, aiSessionId: "session-1" })).toEqual({ recorded: true, throttled: false });
    expect(await limiter.checkCapability({ scope: b, userId: "alice", actionId: "testSafeEcho", risk: "HIGH" })).toEqual({ allowed: true });
  });

  it("two replicas share the per-turn count; a local rejection is never wrong", async () => {
    const h = build(); const a = h.make(); const b = h.make(); const scope = newTenant();
    const input = proposal(h, scope, { turnId: "shared" });
    const half = Math.floor(limits.proposalsPerTurn / 2);
    for (let index = 0; index < half; index++) expect((await a.checkProposal(input)).allowed).toBe(true);
    const admittedByB = [];
    for (let index = 0; index < limits.proposalsPerTurn; index++) admittedByB.push((await b.checkProposal(input)).allowed);
    expect(admittedByB.filter(Boolean)).toHaveLength(limits.proposalsPerTurn - half);
    expect((await a.checkProposal(input)).allowed).toBe(false);
  });
});

describe("T108 end-to-end rate attacks (OPTIONAL as catalogue runs)", () => {
  const waiting = "the bounded representative real-gateway controls (per-user and per-capability quotas, the denial throttle, limiter faults, depth and turn budget, the execution cap) are REQUIRED and run in rate-replay.gateway.test.ts and execution-cap.test.ts; this catalogue verify() form is T108 (OPTIONAL)";
  for (const scenario of rateAbuseScenarios) it.todo(`${scenario.id} (OPTIONAL, T108) ${scenario.title}: run against the real gateway and verify(); ${waiting}`);
  it.todo("ATK-RATE-01 (FUTURE): database round trips measured on the real PostgreSQL adapter through a 10,000-proposal flood (SequenceTarget.sharedStoreCalls)");
  it.todo("ATK-DEP (FUTURE, T123): the full dependency-failure matrix with audit linkage; the representative port failures are in dependency-failure.test.ts and the files it names");
});
