/**
 * The per-turn execution cap (Constitution XV, bounded execution) on the REAL gateway: every stage composed, the real limiter, in-memory adapters,
 * fresh state per test. One execution slot is claimed (Limiter.claimExecution, `executionsPerTurn`) immediately before the allow-event, after
 * authorization, risk and confirmation, so only proposals that are about to execute spend one; a slot is never refunded.
 */
import { describe, expect, it, vi } from "vitest";
import type { AuditEvent, ExecutionResult, GatewayConfig } from "@dap/contracts";
import { DEFAULT_GATEWAY_CONFIG, validateGatewayConfig } from "@dap/security";
import { actor } from "../../packages/testkit/src/attacks/sequence-scenario.js";
import { gatewaySequence } from "./rate-replay-support.js";

const CAP = DEFAULT_GATEWAY_CONFIG.limits.executionsPerTurn; // 8
const allowed = { outcome: "ALLOWED", category: "ok" };
const retry = { outcome: "DENIED", category: "try_later" };
const confirm = { outcome: "REQUIRES_CONFIRMATION", category: "needs_user_confirmation" };
const safe = (id: string) => ({ callId: id, raw: { action: "testSafeEcho", params: { message: "benign" } } });
const types = (events: readonly AuditEvent[]) => events.map((event) => event.type);

/** Every other limit is raised well above what a test needs, so that only the execution cap can be the one that bites. */
function config(over: { executionsPerTurn?: number } = {}): GatewayConfig {
  const base = DEFAULT_GATEWAY_CONFIG.limits;
  return validateGatewayConfig({
    ...DEFAULT_GATEWAY_CONFIG,
    limits: {
      ...base, executionsPerTurn: over.executionsPerTurn ?? base.executionsPerTurn, proposalsPerTurn: 1000,
      perUserPerMinute: { limit: 1000, windowSeconds: 60 }, perTenantPerMinute: { limit: 1000, windowSeconds: 60 },
      perUserPerCapabilityPerMinute: { limit: 1000, windowSeconds: 60 }, highRiskPerUserPerHour: { limit: 1000, windowSeconds: 3600 },
      denialThrottle: { denials: 1000, windowSeconds: 60, blockSeconds: 60 },
    },
  });
}
const run = (h: ReturnType<typeof gatewaySequence>, count: number, who = actor(), prefix = "p") =>
  (async () => { const out: unknown[] = []; for (let index = 0; index < count; index++) out.push(await h.target.submitAs(who, safe(`${prefix}-${who.session}-${who.turn}-${index}`))); return out; })();
const count = (answers: readonly unknown[], expected: unknown) => answers.filter((answer) => JSON.stringify(answer) === JSON.stringify(expected)).length;
const countOf = (h: ReturnType<typeof gatewaySequence>, type: string) => h.target.audit.events.filter((event) => event.type === type).length;

describe("the execution cap", () => {
  it("the first 8 executable SAFE proposals in one turn execute, each with an ALLOWED and an EXECUTED record", async () => {
    const h = gatewaySequence({ config: config() });
    const answers = await run(h, CAP);
    expect(count(answers, allowed)).toBe(CAP);
    expect(h.target.executor.calls).toBe(CAP);
    expect(countOf(h, "AI_ACTION_ALLOWED")).toBe(CAP);
    expect(countOf(h, "AI_ACTION_EXECUTED")).toBe(CAP);
  });

  it("the 9th does not execute: one PROPOSED and one AI_RATE_LIMITED, no ALLOWED, no EXECUTED, executor still at 8", async () => {
    const h = gatewaySequence({ config: config() });
    await run(h, CAP);
    const before = h.target.audit.events.length;
    expect(await h.target.submitAs(actor(), safe("ninth"))).toEqual(retry);
    expect(h.target.executor.calls).toBe(CAP);
    const fresh = h.target.audit.events.slice(before);
    expect(types(fresh)).toEqual(["AI_ACTION_PROPOSED", "AI_RATE_LIMITED"]);
    expect(fresh[1]).toMatchObject({ outcome: "DENIED", reason: "rate_limited_turn", actionId: "testSafeEcho" });
    expect(new Set(fresh.map((event) => event.requestId)).size).toBe(1);
    expect(countOf(h, "AI_ACTION_ALLOWED")).toBe(CAP);
  });

  it("every proposal after the cap in the same turn is denied the same way and never executes", async () => {
    const h = gatewaySequence({ config: config() });
    const answers = await run(h, CAP + 20);
    expect(count(answers, allowed)).toBe(CAP);
    expect(count(answers, retry)).toBe(20);
    expect(h.target.executor.calls).toBe(CAP);
    expect(countOf(h, "AI_RATE_LIMITED")).toBe(20);
    expect(countOf(h, "AI_ACTION_PROPOSED")).toBe(CAP + 20);
  });

  it("DENIED proposals (unknown action, invalid parameters, unauthorized user) do not spend execution slots", async () => {
    const h = gatewaySequence({ config: config() });
    const bad = [
      (id: string) => ({ callId: id, raw: { action: "deleteEverything", params: {} } }),
      (id: string) => ({ callId: id, raw: { action: "testSafeEcho", params: { message: "x", extra: 1 } } }),
      (id: string) => ({ callId: id, raw: { action: "testSafeEcho", params: {} } }),
    ];
    for (let index = 0; index < CAP; index++) {
      const answer = await h.target.submitAs(actor(), bad[index % bad.length]!(`bad-${index}`));
      expect(answer).not.toEqual(allowed);
    }
    h.world.setPermissionAnswer(false);
    for (let index = 0; index < CAP; index++) expect(await h.target.submitAs(actor(), safe(`unauthorized-${index}`))).toEqual({ outcome: "UNAUTHORIZED", category: "not_available" });
    h.world.clearPermissionAnswer();
    expect(h.target.executor.calls).toBe(0);
    const answers = await run(h, CAP, actor(), "good");
    expect(count(answers, allowed)).toBe(CAP);
    expect(h.target.executor.calls).toBe(CAP);
  });

  it("REQUIRES_CONFIRMATION proposals (HIGH and CRITICAL) do not spend execution slots", async () => {
    const h = gatewaySequence({ config: config() });
    const high = { action: "testHighPublish", params: { documentId: "doc-1", audience: ["team"] } };
    const critical = { action: "testCriticalDelete", params: { documentId: "doc-1" } };
    for (let index = 0; index < CAP; index++) expect(await h.target.submitAs(actor(), { callId: `c-${index}`, raw: index % 2 ? critical : high })).toEqual(confirm);
    expect(h.target.executor.calls).toBe(0);
    expect(countOf(h, "AI_ACTION_ALLOWED")).toBe(0);
    const answers = await run(h, CAP, actor(), "after");
    expect(count(answers, allowed)).toBe(CAP);
  });

  it("a proposal that replay refuses does not spend a slot, and replay is still decided before the cap", async () => {
    const h = gatewaySequence({ config: config() });
    for (let index = 0; index < CAP * 2; index++) await h.target.submitAs(actor(), safe("same"));
    expect(h.target.executor.calls).toBe(1);
    const rest = await run(h, CAP - 1, actor(), "other");
    expect(count(rest, allowed)).toBe(CAP - 1);
    expect(await h.target.submitAs(actor(), safe("same"))).toEqual({ outcome: "DENIED", category: "not_available" });
    expect(await h.target.submitAs(actor(), safe("fresh"))).toEqual(retry);
    expect(h.target.executor.calls).toBe(CAP);
  });

  it.each(["throws", "full_store", "wrong_type"] as const)("a limiter that %s when the slot is claimed prevents execution: denial, executor at zero, no allow-event", async (mode) => {
    const h = gatewaySequence({ config: config() });
    h.faultOnly("turn:executions", mode);
    const before = h.target.audit.events.length;
    expect(await h.target.submitAs(actor(), safe("fault"))).toEqual(retry);
    expect(h.target.executor.calls).toBe(0);
    const fresh = h.target.audit.events.slice(before);
    expect(types(fresh)).toEqual(["AI_ACTION_PROPOSED", "AI_ACTION_DENIED"]);
    expect(fresh[1]).toMatchObject({ outcome: "DENIED", reason: "dependency_failure" });
    expect(countOf(h, "AI_ACTION_ALLOWED")).toBe(0);
  });

  it("a limiter that hangs when the slot is claimed is bounded and prevents execution", async () => {
    vi.useFakeTimers();
    try {
      const h = gatewaySequence({ config: config() });
      h.faultOnly("turn:executions", "hangs");
      const pending = h.target.submitAs(actor(), safe("hang"));
      await vi.advanceTimersByTimeAsync(10_000);
      expect(await pending).toEqual(retry);
      expect(h.target.executor.calls).toBe(0);
      expect(countOf(h, "AI_ACTION_ALLOWED")).toBe(0);
    } finally { vi.useRealTimers(); }
  });

  it("a fresh turn has its full budget after recovery from a limiter fault in an earlier turn", async () => {
    const h = gatewaySequence({ config: config() });
    h.faultOnly("turn:executions", "throws");
    await h.target.submitAs(actor({ turn: "t-other" }), safe("fault"));
    h.faultOnly("turn:executions", null);
    const answers = await run(h, CAP, actor({ turn: "t-clean" }), "ok");
    expect(count(answers, allowed)).toBe(CAP);
  });
});

describe("the executor never runs more often than the cap", () => {
  it("with a custom cap of 3 and a flood of 100 proposals", async () => {
    const h = gatewaySequence({ config: config({ executionsPerTurn: 3 }) });
    const answers = await run(h, 100);
    expect(count(answers, allowed)).toBe(3);
    expect(count(answers, retry)).toBe(97);
    expect(h.target.executor.calls).toBe(3);
    expect(countOf(h, "AI_ACTION_ALLOWED")).toBe(3);
    expect(countOf(h, "AI_RATE_LIMITED")).toBe(97);
  });

  it("a failing executor still spends its slot: failures are never refunded and a retry cannot get round the cap", async () => {
    const failing: ExecutionResult = { status: "failure", code: "boom" };
    const h = gatewaySequence({ config: config({ executionsPerTurn: 3 }), executorResult: failing });
    const answers = await run(h, 100);
    expect(h.target.executor.calls).toBe(3);
    expect(count(answers, retry)).toBe(97); // the cap's refusals; the 3 failed executions are told apart (ALLOWED by policy, but try later)
    expect(count(answers, allowed)).toBe(0);
    expect(countOf(h, "AI_ACTION_EXECUTED")).toBe(3);
    expect(countOf(h, "AI_RATE_LIMITED")).toBe(97);
    // the same call retried as a fresh proposal does not get another slot
    expect(await h.target.submitAs(actor(), safe("retry-of-the-first"))).toEqual(retry);
    expect(h.target.executor.calls).toBe(3);
  });

  it("a new turn has a fresh budget, and the old turn stays exhausted", async () => {
    const h = gatewaySequence({ config: config() });
    await run(h, CAP + 2, actor({ turn: "turn-1" }));
    expect(h.target.executor.calls).toBe(CAP);
    const next = await run(h, CAP + 2, actor({ turn: "turn-2" }));
    expect(count(next, allowed)).toBe(CAP);
    expect(h.target.executor.calls).toBe(2 * CAP);
    expect(await h.target.submitAs(actor({ turn: "turn-1" }), safe("late"))).toEqual(retry);
    expect(h.target.executor.calls).toBe(2 * CAP);
  });

  it("different sessions and different users have independent budgets", async () => {
    const h = gatewaySequence({ config: config() });
    for (const who of [actor({ session: "s1" }), actor({ session: "s2" }), actor({ user: "bob", session: "s3" }), actor({ tenant: "B", session: "s4" })]) {
      expect(count(await run(h, CAP + 3, who), allowed)).toBe(CAP);
    }
    expect(h.target.executor.calls).toBe(4 * CAP);
  });

  it("two gateway instances over the same state share one budget", async () => {
    const h = gatewaySequence({ config: config() });
    const answers: unknown[] = [];
    for (let index = 0; index < CAP * 2; index++) answers.push(await h.target.submitAs(actor({ instance: index % 2 ? 1 : 2 }), safe(`two-${index}`)));
    expect(count(answers, allowed)).toBe(CAP);
    expect(h.target.executor.calls).toBe(CAP);
  });

  it("concurrent proposals in one turn execute at most the cap", async () => {
    const h = gatewaySequence({ config: config() });
    const answers = await Promise.all(Array.from({ length: 40 }, (_, index) => h.target.submitAs(actor({ instance: index % 2 ? 1 : 2 }), safe(`race-${index}`))));
    expect(count(answers, allowed)).toBe(CAP);
    expect(h.target.executor.calls).toBe(CAP);
    expect(countOf(h, "AI_ACTION_ALLOWED")).toBe(CAP);
  });
});

describe("a cap denial is counted toward the denial throttle like any limiter-owned denial", () => {
  it("a denial decided by the shared store counts, so repeated cap denials block the session; a replica's own local refusal does not", async () => {
    const h = gatewaySequence({ config: validateGatewayConfig({ ...config(), limits: { ...config().limits, executionsPerTurn: 2, denialThrottle: { denials: 1, windowSeconds: 60, blockSeconds: 60 } } }) });
    // Replica 1 spends the whole cap.
    expect(count(await run(h, 2, actor({ instance: 1 })), allowed)).toBe(2);
    // Replica 2 knows nothing of that locally, so its claims reach the shared store, which refuses them: those denials count (1 allowed, the 2nd crosses).
    expect(await h.target.submitAs(actor({ instance: 2 }), safe("shared-1"))).toEqual(retry);
    expect(h.target.audit.events.at(-1)).toMatchObject({ type: "AI_RATE_LIMITED", reason: "rate_limited_turn" });
    expect(await h.target.submitAs(actor({ instance: 2 }), safe("shared-2"))).toEqual(retry);
    // The session is now blocked by the throttle: the next proposal is stopped at stage 2, before any slot or execution.
    const calls = h.target.executor.calls;
    expect(await h.target.submitAs(actor({ instance: 2 }), safe("blocked"))).toEqual(retry);
    expect(h.target.audit.events.at(-1)).toMatchObject({ type: "AI_RATE_LIMITED", reason: "denial_throttle" });
    expect(h.target.executor.calls).toBe(calls);
  });

  it("a replica's own local refusals are free: they add no throttle writes however many there are", async () => {
    const h = gatewaySequence({ config: validateGatewayConfig({ ...config(), limits: { ...config().limits, executionsPerTurn: 2, denialThrottle: { denials: 1, windowSeconds: 60, blockSeconds: 60 } } }) });
    await run(h, 2);
    for (let index = 0; index < 20; index++) expect(await h.target.submitAs(actor(), safe(`local-${index}`))).toEqual(retry);
    // Never throttled: the last decision is still the cap's own, not denial_throttle.
    expect(h.target.audit.events.at(-1)).toMatchObject({ type: "AI_RATE_LIMITED", reason: "rate_limited_turn" });
  });
});
