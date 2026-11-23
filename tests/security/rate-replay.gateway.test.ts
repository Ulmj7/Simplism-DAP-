import { randomUUID } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { Pool } from "pg";
import { PostgresReplayGuard, DEFAULT_GATEWAY_CONFIG, validateGatewayConfig } from "@dap/security";
import { actor } from "../../packages/testkit/src/attacks/sequence-scenario.js";
import { gatewaySequence } from "./rate-replay-support.js";
import { openStatePools } from "../../packages/security/src/state/conformance/state-pg-fixtures.js";
const raw = { action: "testSafeEcho", params: { message: "benign" } };
const call = (callId: string, params = raw.params) => ({ callId, raw: { ...raw, params } });
const unavailable = { outcome: "DENIED", category: "not_available" };
const retry = { outcome: "DENIED", category: "try_later" };
const allowed = { outcome: "ALLOWED", category: "ok" };
const confirm = { outcome: "REQUIRES_CONFIRMATION", category: "needs_user_confirmation" };
function configured(limits: Record<string, unknown>) { return validateGatewayConfig({ ...DEFAULT_GATEWAY_CONFIG, limits: { ...DEFAULT_GATEWAY_CONFIG.limits, ...limits } }); }

describe("T107 real gateway replay through the whole chain (no stand-ins)", () => {
  it("ATK-REPLAY-01/08 duplicate and corrected proposals cannot reuse a consumed claim", async () => {
    const h = gatewaySequence();
    expect(await h.target.submitAs(actor(), call("first"))).toEqual(allowed);
    expect(h.permissions).toBe(1); // a positive stage-3 control: the first claim proceeds all the way and executes once
    expect(await h.target.submitAs(actor(), call("first"))).toEqual(unavailable);
    expect(await h.target.submitAs(actor(), call("corrected", {} as never))).toMatchObject({ outcome: "INVALID_PARAMETERS" });
    expect(await h.target.submitAs(actor(), call("corrected"))).toEqual(unavailable);
    expect(h.claims.map((item) => item.answer)).toEqual(["claimed", "duplicate", "claimed", "duplicate"]);
    expect(h.permissions).toBe(1); expect(h.target.executor.calls).toBe(1); // only the first, un-replayed proposal ever executed
  });
  it("ATK-REPLAY-03 50 parallel submissions across two instances: exactly one passes stage 3", async () => {
    const h = gatewaySequence({ config: configured({ proposalsPerTurn: 100, perUserPerMinute: { limit: 100, windowSeconds: 60 } }) });
    const answers = await Promise.all(Array.from({ length: 50 }, (_, index) => h.target.submitAs(actor({ instance: index % 2 ? 1 : 2 }), call("parallel"))));
    expect(answers.filter((item) => item.category === "not_available")).toHaveLength(49);
    expect(answers.filter((item) => item.outcome === "ALLOWED")).toHaveLength(1);
    expect(h.claims.filter((item) => item.answer === "claimed")).toHaveLength(1);
    expect(h.permissions).toBe(1); expect(h.target.executor.calls).toBe(1); // exactly one execution for 50 submissions of one callId
  });
  it("ATK-REPLAY-07 model-supplied envelope ids are rejected without claiming the host id", async () => {
    const h = gatewaySequence();
    expect(await h.target.submitAs(actor(), { callId: "host", raw: { ...raw, callId: "model-id", requestId: "model-request" } })).toMatchObject({ outcome: "INVALID_ACTION" });
    expect(h.claims).toEqual([]);
    expect(await h.target.submitAs(actor(), call("host"))).toEqual(allowed);
    expect(h.claims).toMatchObject([{ key: "session-1:host", answer: "claimed" }]);
  });
  it("ATK-XTENANT-06 same ids claim independently in different minted tenants", async () => {
    const h = gatewaySequence();
    for (const tenant of ["A", "B"] as const) expect(await h.target.submitAs(actor({ tenant }), call("same"))).toEqual(allowed);
    expect(h.claims.map((item) => item.tenantId)).toEqual([h.tenants.A, h.tenants.B]);
    expect(h.claims.map((item) => item.answer)).toEqual(["claimed", "claimed"]);
    expect(h.permissions).toBe(2);
  });
});

describe("T107 PostgreSQL replay through actual gateway instances", () => {
  let app: Pool; let owner: Pool;
  beforeAll(async () => { ({ app, owner } = await openStatePools(Pool)); });
  afterAll(async () => { await Promise.all([app?.end(), owner?.end()]); });
  it("ATK-REPLAY-02 a newly constructed gateway on the same PostgreSQL store still rejects replay", async () => {
    const h = gatewaySequence({ replay: new PostgresReplayGuard(app) });
    const persisted = `persisted-${randomUUID()}`; // unique between runs, identical across the restart being tested
    expect(await h.target.submitAs(actor(), call(persisted))).toEqual(allowed);
    h.restart(1);
    expect(await h.target.submitAs(actor(), call(persisted))).toEqual(unavailable);
    expect(h.claims.map((item) => item.answer)).toEqual(["claimed", "duplicate"]);
    expect(h.permissions).toBe(1); expect(h.target.executor.calls).toBe(1); // the replay after the restart did not execute again
  });
});

describe("T108 real gateway rate controls through the whole chain", () => {
  it("ATK-RATE-01 10000 proposals make bounded shared-store calls; executions stop at the per-turn execution cap", async () => {
    const h = gatewaySequence();
    const answers: unknown[] = [];
    for (let index = 0; index < 10000; index++) answers.push(await h.target.submitAs(actor(), call(`flood-${index}`)));
    // Allowed proposals stop at the per-turn execution cap (8 by default); everything after it is denied. (The capability quota is 20.)
    const cap = h.config.limits.executionsPerTurn;
    expect(answers.filter((answer) => JSON.stringify(answer) === JSON.stringify(allowed))).toHaveLength(cap);
    expect(answers.filter((answer) => JSON.stringify(answer) === JSON.stringify(retry))).toHaveLength(10000 - cap);
    expect(h.claims).toHaveLength(25); expect(h.permissions).toBe(25);
    expect(h.target.sharedStoreCalls).toBeLessThanOrEqual(160 + cap); // the earlier bound plus one shared hit per execution; still independent of the 10000
    expect(h.target.audit.events.some((event) => event.type === "AI_RATE_LIMITED" && event.reason === "rate_limited_turn")).toBe(true);
    expect(h.target.executor.calls).toBe(cap);
  }, 30000);
  it("ATK-RATE-02/03 the per-capability quota still bites when the execution cap is raised above it", async () => {
    const h = gatewaySequence({ config: configured({ executionsPerTurn: 50, proposalsPerTurn: 100, denialThrottle: { denials: 1000, windowSeconds: 60, blockSeconds: 60 } }) });
    const answers: unknown[] = [];
    for (let index = 0; index < 30; index++) answers.push(await h.target.submitAs(actor(), call(`quota-${index}`)));
    const quota = h.config.limits.perUserPerCapabilityPerMinute.limit; // 20
    expect(answers.filter((answer) => JSON.stringify(answer) === JSON.stringify(allowed))).toHaveLength(quota);
    expect(h.target.executor.calls).toBe(quota);
    expect(h.target.audit.events.at(-1)).toMatchObject({ type: "AI_RATE_LIMITED", reason: "rate_limited_capability" });
  });
  it("ATK-RATE-05 counted limiter denials cross the throttle; local denials add no throttle writes", async () => {
    const h = gatewaySequence({ config: configured({ perUserPerMinute: { limit: 1, windowSeconds: 60 } }) });
    for (let index = 0; index < 7; index++) await h.target.submitAs(actor({ turn: `turn-${index}` }), call(`denial-${index}`));
    const before = h.target.sharedStoreCalls!;
    expect(await h.target.submitAs(actor({ turn: "blocked" }), call("blocked"))).toEqual(retry);
    expect(h.target.sharedStoreCalls! - before).toBe(1); // only the block lookup, no recordDenial hit
    expect(h.target.audit.events.at(-1)).toMatchObject({ type: "AI_RATE_LIMITED", reason: "denial_throttle" });
    expect(h.permissions).toBe(1);
  });
  it("ATK-RATE-05 EVERY final denial counts toward the throttle: unknown actions, malformed envelopes and replays block the session", async () => {
    const unknown = { action: "deleteEverything", params: {} };
    for (const denials of [[...Array(6)].map((_, index) => ({ callId: `u-${index}`, raw: unknown })),
      [...Array(6)].map((_, index) => ({ callId: `m-${index}`, raw: { action: "testSafeEcho", params: {}, callId: "model-chosen" } }))]) {
      const h = gatewaySequence();
      for (const [index, item] of denials.entries()) await h.target.submitAs(actor({ turn: `turn-${index}` }), item);
      expect(await h.target.submitAs(actor({ turn: "after" }), call("after"))).toEqual(retry);
      expect(h.target.audit.events.at(-1)).toMatchObject({ type: "AI_RATE_LIMITED", reason: "denial_throttle" });
      expect(h.permissions).toBe(0);
      // Only that AI session is blocked; the same user in a new session proceeds to stage 6.
      expect(await h.target.submitAs(actor({ session: "other-session", turn: "t" }), call("other"))).toEqual(allowed);
      expect(h.permissions).toBe(1);
    }
    const replays = gatewaySequence();
    await replays.target.submitAs(actor({ turn: "t0" }), call("same"));
    for (let index = 1; index <= 6; index++) await replays.target.submitAs(actor({ turn: `t${index}` }), call("same"));
    expect(await replays.target.submitAs(actor({ turn: "after" }), call("fresh"))).toEqual(retry);
    expect(replays.target.audit.events.at(-1)).toMatchObject({ type: "AI_RATE_LIMITED", reason: "denial_throttle" });
  });
  it("ATK-RATE-05 denials below the threshold do not block, and rate denials are not double counted", async () => {
    const h = gatewaySequence();
    for (let index = 0; index < 5; index++) await h.target.submitAs(actor({ turn: `turn-${index}` }), { callId: `u-${index}`, raw: { action: "deleteEverything", params: {} } });
    const before = h.permissions;
    await h.target.submitAs(actor({ turn: "ok" }), call("ok"));
    expect(h.permissions).toBe(before + 1);
    const tight = gatewaySequence({ config: configured({ perUserPerMinute: { limit: 1, windowSeconds: 60 } }) });
    await tight.target.submitAs(actor({ turn: "a" }), call("a"));
    for (let index = 0; index < 5; index++) await tight.target.submitAs(actor({ turn: `x${index}` }), call(`x${index}`));
    const writes = tight.target.sharedStoreCalls!;
    await tight.target.submitAs(actor({ turn: "y" }), call("y"));
    expect(tight.target.sharedStoreCalls! - writes).toBeLessThanOrEqual(8);
  });
  it("ATK-RATE-02/03 user and capability quotas emit the matching rate denial", async () => {
    for (const [control, reason] of [["perUserPerMinute", "rate_limited_user"], ["perUserPerCapabilityPerMinute", "rate_limited_capability"]] as const) {
      const h = gatewaySequence({ config: configured({ [control]: { limit: 1, windowSeconds: 60 } }) });
      expect(await h.target.submitAs(actor(), call("quota-first"))).toEqual(allowed);
      expect(await h.target.submitAs(actor(), call("quota-next"))).toEqual(retry);
      expect(h.target.audit.events.at(-1)).toMatchObject({ type: "AI_RATE_LIMITED", reason });
      expect(h.target.executor.calls).toBe(1); // only the first proposal ever executed
    }
  });
  it("ATK-RATE-04 HIGH and CRITICAL share a per-user risk quota after authorization", async () => {
    const h = gatewaySequence({ config: configured({ highRiskPerUserPerHour: { limit: 1, windowSeconds: 3600 } }) });
    expect(await h.target.submitAs(actor(), { callId: "high", raw: { action: "testHighPublish", params: { documentId: "doc-1", audience: ["team"] } } })).toEqual(confirm);
    expect(await h.target.submitAs(actor(), { callId: "critical", raw: { action: "testCriticalDelete", params: { documentId: "doc-1" } } })).toEqual(retry);
    expect(h.target.audit.events.at(-1)).toMatchObject({ type: "AI_RATE_LIMITED", reason: "rate_limited_risk" });
    expect(h.permissions).toBe(2); expect(h.target.executor.calls).toBe(0);
  });
  it.each(["throws", "full_store", "wrong_type"] as const)("ATK-RATE-06 limiter %s fails closed before replay", async (mode) => {
    const h = gatewaySequence(); await h.target.injectLimiterFault!(mode);
    expect(await h.target.submitAs(actor(), call("fault"))).toEqual(retry);
    expect(h.claims).toEqual([]); expect(h.permissions).toBe(0); expect(h.target.executor.calls).toBe(0);
  });
  it.each(["throws", "full_store", "wrong_type"] as const)("ATK-DEP replay %s never reaches authorization", async (mode) => {
    const h = gatewaySequence({ replay: { claim: async () => { if (mode === "wrong_type") return "yes" as never; throw new Error(mode === "full_store" ? "capacity exhausted" : "guard down"); } } });
    expect(await h.target.submitAs(actor(), call("replay-fault"))).toEqual(retry);
    expect(h.permissions).toBe(0); expect(h.target.executor.calls).toBe(0);
  });
  it("ATK-RATE-06 a hanging limiter is bounded using fake timers", async () => {
    vi.useFakeTimers();
    try {
      const h = gatewaySequence(); await h.target.injectLimiterFault!("hangs");
      const pending = h.target.submitAs(actor(), call("hang"));
      await vi.advanceTimersByTimeAsync(2000);
      expect(await pending).toEqual(retry); expect(h.claims).toEqual([]); expect(h.permissions).toBe(0);
    } finally { vi.useRealTimers(); }
  });
  it("ATK-RATE-07/08 depth and runner turn budget deny before any shared lookup", async () => {
    const h = gatewaySequence();
    expect(await h.target.submitAs(actor({ depth: 5 }), call("deep"))).toEqual(retry);
    expect(h.target.sharedStoreCalls).toBe(0);
    await h.target.submitAs(actor(), call("before-budget"));
    await h.target.advanceSeconds(31);
    const before = h.target.sharedStoreCalls;
    expect(await h.target.submitAs(actor(), call("late"))).toEqual(retry);
    expect(h.target.sharedStoreCalls).toBe(before);
    expect(h.target.audit.events.at(-1)).toMatchObject({ reason: "rate_limited_turn" });
  });
});
