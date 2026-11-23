import { describe, expect, it } from "vitest";
import type { Clock, IsoInstant, RateLimiter, RateLimitResult, RateLimitRule, TenantId, TenantScope } from "@dap/contracts";
import { InMemoryRateLimiter } from "../state/memory/rate-limiter.js";
import { DEFAULT_LIMIT_CONFIG, validateLimitConfig } from "./limit-config.js";
import { createLimiter, type CapabilityLimitInput, type DenialInput, type Limiter, type LimitVerdict, type ProposalLimitInput, type TurnLimitInput } from "./limiter.js";

const A = "00000000-0000-4000-8000-00000000000a" as TenantId;
const B = "00000000-0000-4000-8000-00000000000b" as TenantId;
const START = Date.parse("2026-01-01T00:00:00Z");

class TestClock implements Clock {
  ms = START;
  now(): IsoInstant { return new Date(this.ms).toISOString() as IsoInstant; }
  advance(seconds: number): void { this.ms += seconds * 1000; }
}
class ManualTimer {
  time = 0; private next = 0;
  readonly pending = new Map<number, { at: number; callback: () => void }>();
  now(): number { return this.time; }
  setTimeout(callback: () => void, ms: number): number { const id = this.next++; this.pending.set(id, { at: this.time + ms, callback }); return id; }
  clearTimeout(handle: unknown): void { this.pending.delete(handle as number); }
  advance(ms: number): void { this.time += ms; for (const [id, entry] of [...this.pending]) if (entry.at <= this.time) { this.pending.delete(id); entry.callback(); } }
}
type Call = { op: "hit" | "isBlocked" | "block"; tenantId: string; key: string; rule?: RateLimitRule; seconds?: number };
class SpyStore implements RateLimiter {
  readonly calls: Call[] = [];
  constructor(private readonly inner: RateLimiter) {}
  hit(scope: TenantScope, key: string, rule: RateLimitRule): Promise<RateLimitResult> { this.calls.push({ op: "hit", tenantId: scope.tenantId, key, rule }); return this.inner.hit(scope, key, rule); }
  isBlocked(scope: TenantScope, key: string): Promise<boolean> { this.calls.push({ op: "isBlocked", tenantId: scope.tenantId, key }); return this.inner.isBlocked(scope, key); }
  block(scope: TenantScope, key: string, seconds: number): Promise<void> { this.calls.push({ op: "block", tenantId: scope.tenantId, key, seconds }); return this.inner.block(scope, key, seconds); }
}
function setup(overrides: Partial<typeof DEFAULT_LIMIT_CONFIG> = {}, options: { maxEntries?: number; maxLocalTurns?: number } = {}) {
  const clock = new TestClock(); const timer = new ManualTimer();
  const store = new SpyStore(new InMemoryRateLimiter(clock, options.maxEntries ? { maxEntries: options.maxEntries } : {}));
  const config = validateLimitConfig({ ...DEFAULT_LIMIT_CONFIG, ...overrides });
  const make = (rateLimiter: RateLimiter = store) => createLimiter({ rateLimiter, config, clock, timer, ...(options.maxLocalTurns ? { maxLocalTurns: options.maxLocalTurns } : {}) });
  return { clock, timer, store, config, limiter: make(), make };
}
let turnCounter = 0;
const flush = (): Promise<void> => new Promise((resolve) => { setImmediate(resolve); });
const proposal = (clock: TestClock, over: Partial<ProposalLimitInput> = {}): ProposalLimitInput => ({
  scope: { tenantId: A }, userId: "alice", aiSessionId: "session-1", turnId: `turn-${turnCounter++}`, chainDepth: 1, turnStartedAt: clock.now(), ...over,
});
const turnInput = (over: Partial<TurnLimitInput> = {}): TurnLimitInput => ({ scope: { tenantId: A }, aiSessionId: "session-1", turnId: "turn-x", ...over });
const capability = (over: Partial<CapabilityLimitInput> = {}): CapabilityLimitInput => ({ scope: { tenantId: A }, userId: "alice", actionId: "testSafeEcho", risk: "SAFE", ...over });
const denial = (over: Partial<DenialInput> = {}): DenialInput => ({ scope: { tenantId: A }, aiSessionId: "session-1", ...over });
const denied = (reason: string, limit: string) => expect.objectContaining({ allowed: false, outcome: "DENIED", reason, limit });
const fault = denied("dependency_failure", "dependency_failure");

describe("T116 limiter: configured buckets", () => {
  it("allows traffic within every limit and returns frozen verdicts", async () => {
    const { limiter, clock } = setup();
    const verdict = await limiter.checkProposal(proposal(clock));
    expect(verdict).toEqual({ allowed: true });
    expect(Object.isFrozen(verdict)).toBe(true);
    expect(await limiter.checkCapability(capability())).toEqual({ allowed: true });
  });

  it("caps proposals per turn from config and bounds shared round trips for a 10,000-proposal flood", async () => {
    const { limiter, clock, store, config } = setup();
    const input = proposal(clock, { turnId: "flood" });
    const verdicts: LimitVerdict[] = [];
    for (let index = 0; index < 10_000; index++) verdicts.push(await limiter.checkProposal(input));
    expect(verdicts.filter((item) => item.allowed)).toHaveLength(config.proposalsPerTurn);
    expect(verdicts.find((item) => !item.allowed)).toEqual(denied("rate_limited_turn", "turn_proposals"));
    // isBlocked + turn + tenant + user for each admitted proposal; the flood beyond the cap costs nothing.
    expect(store.calls.length).toBe(config.proposalsPerTurn * 4);
  });

  it("local pre-check never exceeds the shared count: a second replica still sees the shared total", async () => {
    const { make, store, clock, config } = setup();
    const replicaA = make(); const replicaB = make();
    const input = proposal(clock, { turnId: "shared-turn" });
    for (let index = 0; index < 20; index++) expect((await replicaA.checkProposal(input)).allowed).toBe(true);
    const before = store.calls.length;
    for (let index = 0; index < 5; index++) expect((await replicaB.checkProposal(input)).allowed).toBe(true);
    // Replica B's local count is 5, far below the cap, so the shared store makes the decision.
    expect(await replicaB.checkProposal(input)).toEqual(denied("rate_limited_turn", "turn_proposals"));
    expect(store.calls.slice(before).filter((call) => call.op === "hit" && call.key.startsWith("turn:proposals:"))).toHaveLength(6);
    // Replica A rejects locally after the shared total reached the cap, without touching the store.
    for (let index = 0; index < 5; index++) await replicaA.checkProposal(input);
    const afterA = store.calls.length;
    expect(await replicaA.checkProposal(input)).toEqual(denied("rate_limited_turn", "turn_proposals"));
    expect(store.calls.length).toBe(afterA);
    expect(config.proposalsPerTurn).toBe(25);
  });

  it("keeps existing active counts when capacity refuses another turn", async () => {
    const { limiter, clock } = setup({}, { maxLocalTurns: 2 });
    const first = proposal(clock, { turnId: "t1" });
    for (let index = 0; index < 3; index++) await limiter.checkProposal(first);
    await limiter.checkProposal(proposal(clock, { turnId: "t2" }));
    expect(await limiter.checkProposal(proposal(clock, { turnId: "t3" }))).toEqual(fault);
    // Capacity never evicts t1: the existing count still allows the remaining legitimate hits.
    let allowed = 3;
    for (let index = 0; index < 40; index++) if ((await limiter.checkProposal(first)).allowed) allowed++;
    expect(allowed).toBe(25);
  });

  it("caps executions per turn separately from proposals", async () => {
    const { limiter, store } = setup();
    for (let index = 0; index < 8; index++) expect((await limiter.claimExecution(turnInput())).allowed).toBe(true);
    expect(await limiter.claimExecution(turnInput())).toEqual(denied("rate_limited_turn", "turn_executions"));
    const calls = store.calls.length;
    for (let index = 0; index < 100; index++) await limiter.claimExecution(turnInput());
    expect(store.calls.length).toBe(calls);
    expect((await limiter.claimExecution(turnInput({ turnId: "another" }))).allowed).toBe(true);
  });

  it("enforces per-user per-window and rolls over at the window boundary", async () => {
    const { limiter, clock, config } = setup();
    for (let index = 0; index < config.perUserPerMinute.limit; index++) expect((await limiter.checkProposal(proposal(clock))).allowed).toBe(true);
    const over = await limiter.checkProposal(proposal(clock));
    expect(over).toEqual(denied("rate_limited_user", "user"));
    expect(over).toMatchObject({ retryAfterSeconds: 60 });
    expect((await limiter.checkProposal(proposal(clock, { userId: "bob" }))).allowed).toBe(true);
    clock.advance(60);
    expect((await limiter.checkProposal(proposal(clock))).allowed).toBe(true);
  });

  it("enforces the per-tenant limit across users and keeps tenants independent", async () => {
    const { limiter, clock } = setup({ perTenantPerMinute: { limit: 3, windowSeconds: 60 } });
    for (const user of ["u1", "u2", "u3"]) expect((await limiter.checkProposal(proposal(clock, { userId: user }))).allowed).toBe(true);
    expect(await limiter.checkProposal(proposal(clock, { userId: "u4" }))).toEqual(denied("rate_limited_tenant", "tenant"));
    expect((await limiter.checkProposal(proposal(clock, { scope: { tenantId: B }, userId: "u1" }))).allowed).toBe(true);
  });

  it("enforces per-user per-capability limits independently per capability and user", async () => {
    const { limiter, config } = setup();
    for (let index = 0; index < config.perUserPerCapabilityPerMinute.limit; index++) expect((await limiter.checkCapability(capability())).allowed).toBe(true);
    expect(await limiter.checkCapability(capability())).toEqual(denied("rate_limited_capability", "capability"));
    expect((await limiter.checkCapability(capability({ actionId: "other" }))).allowed).toBe(true);
    expect((await limiter.checkCapability(capability({ userId: "bob" }))).allowed).toBe(true);
  });

  it("shares one hourly budget between HIGH and CRITICAL and never counts lower risk", async () => {
    const { limiter, store, config } = setup({ perUserPerCapabilityPerMinute: { limit: 1000, windowSeconds: 60 } });
    for (let index = 0; index < 50; index++) expect((await limiter.checkCapability(capability({ risk: "MEDIUM" }))).allowed).toBe(true);
    expect(store.calls.some((call) => call.key.startsWith("risk:"))).toBe(false);
    for (let index = 0; index < config.highRiskPerUserPerHour.limit; index++) expect((await limiter.checkCapability(capability({ risk: index % 2 ? "CRITICAL" : "HIGH", actionId: `a${index}` }))).allowed).toBe(true);
    expect(await limiter.checkCapability(capability({ risk: "CRITICAL", actionId: "z" }))).toEqual(denied("rate_limited_risk", "risk"));
    expect(await limiter.checkCapability(capability({ risk: "HIGH", actionId: "y" }))).toEqual(denied("rate_limited_risk", "risk"));
    expect((await limiter.checkCapability(capability({ risk: "HIGH", userId: "bob" }))).allowed).toBe(true);
  });

  it("uses every window and limit from the validated configuration", async () => {
    const { limiter, store } = setup();
    await limiter.checkProposal(proposal(new TestClock(), { turnId: "cfg" }));
    await limiter.checkCapability(capability({ risk: "HIGH" }));
    const rules = Object.fromEntries(store.calls.filter((call) => call.op === "hit").map((call) => [call.key.split(":")[0], call.rule]));
    expect(rules).toEqual({
      turn: { limit: 25, windowSeconds: 30 }, tenant: { limit: 600, windowSeconds: 60 }, user: { limit: 60, windowSeconds: 60 },
      cap: { limit: 20, windowSeconds: 60 }, risk: { limit: 10, windowSeconds: 3600 },
    });
  });
});

describe("T116 limiter: which denials count toward the throttle", () => {
  it("only denials decided by the shared store count; local, blocked and faulted denials cost no recording", async () => {
    const { limiter, clock, make, config } = setup({ perTenantPerMinute: { limit: 1000, windowSeconds: 60 } });
    const counts = async (verdict: Promise<LimitVerdict>): Promise<boolean | undefined> => { const result = await verdict; return result.allowed ? undefined : result.countsTowardThrottle; };
    // shared-store denials
    for (let index = 0; index < config.perUserPerMinute.limit; index++) await limiter.checkProposal(proposal(clock));
    expect(await counts(limiter.checkProposal(proposal(clock)))).toBe(true);
    for (let index = 0; index < config.perUserPerCapabilityPerMinute.limit; index++) await limiter.checkCapability(capability({ actionId: "c" }));
    expect(await counts(limiter.checkCapability(capability({ actionId: "c" })))).toBe(true);
    // local decisions
    expect(await counts(limiter.checkProposal(proposal(clock, { chainDepth: config.maxChainDepth + 1 })))).toBe(false);
    clock.advance(config.turnBudgetMs / 1000 + 1);
    expect(await counts(limiter.checkProposal(proposal(clock, { turnStartedAt: new Date(clock.ms - config.turnBudgetMs - 1).toISOString() as IsoInstant })))).toBe(false);
    const turn = proposal(clock, { turnId: "local", userId: "other" });
    for (let index = 0; index < config.proposalsPerTurn; index++) await limiter.checkProposal(turn);
    expect(await counts(limiter.checkProposal(turn))).toBe(false);
    // block and fault
    for (let index = 0; index < config.denialThrottle.denials + 1; index++) await limiter.recordDenial(denial());
    expect(await counts(limiter.checkProposal(proposal(clock, { userId: "third" })))).toBe(false);
    expect(await counts(make({ hit: () => Promise.reject(new Error("x")), isBlocked: async () => false, block: async () => undefined }).checkProposal(proposal(clock, { aiSessionId: "fresh" })))).toBe(false);
  });
});

describe("T116 limiter: denial throttle", () => {
  it("blocks the AI session after the configured denials and not before", async () => {
    const { limiter, clock, store, config } = setup();
    for (let index = 0; index < config.denialThrottle.denials; index++) expect(await limiter.recordDenial(denial())).toEqual({ recorded: true, throttled: false });
    expect((await limiter.checkProposal(proposal(clock))).allowed).toBe(true);
    expect(await limiter.recordDenial(denial())).toEqual({ recorded: true, throttled: true });
    expect(store.calls.filter((call) => call.op === "block")).toEqual([{ op: "block", tenantId: A, key: "deny:session-1", seconds: 300 }]);
    expect(await limiter.checkProposal(proposal(clock))).toEqual(denied("denial_throttle", "denial_throttle"));
    expect(await limiter.checkProposal(proposal(clock, { aiSessionId: "session-2" }))).toEqual({ allowed: true });
    expect(await limiter.checkProposal(proposal(clock, { scope: { tenantId: B } }))).toEqual({ allowed: true });
    clock.advance(299);
    expect(await limiter.checkProposal(proposal(clock))).toEqual(denied("denial_throttle", "denial_throttle"));
    clock.advance(1);
    expect((await limiter.checkProposal(proposal(clock))).allowed).toBe(true);
  });

  it("counts denials in the configured window only", async () => {
    const { limiter, clock, config } = setup();
    for (let index = 0; index < config.denialThrottle.denials; index++) await limiter.recordDenial(denial());
    clock.advance(config.denialThrottle.windowSeconds);
    for (let index = 0; index < config.denialThrottle.denials; index++) expect(await limiter.recordDenial(denial())).toEqual({ recorded: true, throttled: false });
  });

  it("a recording fault reports not recorded and never throws", async () => {
    const { make } = setup();
    const broken = make({ hit: () => Promise.reject(new Error("down")), isBlocked: async () => false, block: async () => undefined });
    expect(await broken.recordDenial(denial())).toEqual({ recorded: false });
    const blockFails = make({ hit: async () => ({ allowed: false, retryAfterSeconds: 1 }), isBlocked: async () => false, block: () => Promise.reject(new Error("down")) });
    expect(await blockFails.recordDenial(denial())).toEqual({ recorded: false });
  });
});

describe("T116 limiter: runner-supplied depth and wall clock", () => {
  it("denies chain depth above the maximum without any store call", async () => {
    const { limiter, clock, store, config } = setup();
    expect((await limiter.checkProposal(proposal(clock, { chainDepth: config.maxChainDepth }))).allowed).toBe(true);
    const before = store.calls.length;
    expect(await limiter.checkProposal(proposal(clock, { chainDepth: config.maxChainDepth + 1 }))).toEqual(denied("rate_limited_turn", "chain_depth"));
    expect(store.calls.length).toBe(before);
  });

  it("denies when the turn budget is exceeded, exactly at the boundary, using the clock port", async () => {
    const { limiter, clock, store, config } = setup();
    const startedAt = clock.now();
    clock.advance(config.turnBudgetMs / 1000);
    expect((await limiter.checkProposal(proposal(clock, { turnStartedAt: startedAt }))).allowed).toBe(true);
    clock.ms += 1;
    const before = store.calls.length;
    expect(await limiter.checkProposal(proposal(clock, { turnStartedAt: startedAt }))).toEqual(denied("rate_limited_turn", "turn_budget"));
    expect(store.calls.length).toBe(before);
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "1", null, undefined, 2 ** 53])("malformed depth %j fails closed", async (depth) => {
    const { limiter, clock, store } = setup();
    expect(await limiter.checkProposal(proposal(clock, { chainDepth: depth as number }))).toEqual(fault);
    expect(store.calls).toHaveLength(0);
  });

  it.each(["", "not a date", "2026-01-01", "2026-13-45T00:00:00Z", 5, null, undefined])("malformed turn start %j fails closed", async (start) => {
    const { limiter, clock } = setup();
    expect(await limiter.checkProposal(proposal(clock, { turnStartedAt: start as IsoInstant }))).toEqual(fault);
  });

  it("a turn start in the future, or a clock that is invalid, fails closed", async () => {
    const { limiter, clock } = setup();
    expect(await limiter.checkProposal(proposal(clock, { turnStartedAt: new Date(clock.ms + 1000).toISOString() as IsoInstant }))).toEqual(fault);
    const bad = createLimiter({ rateLimiter: setup().store, config: DEFAULT_LIMIT_CONFIG, clock: { now: () => "nope" as IsoInstant }, timer: new ManualTimer() });
    expect(await bad.checkProposal(proposal(clock))).toEqual(fault);
    const throwing = createLimiter({ rateLimiter: setup().store, config: DEFAULT_LIMIT_CONFIG, clock: { now: () => { throw new Error("clock"); } }, timer: new ManualTimer() });
    expect(await throwing.checkProposal(proposal(clock))).toEqual(fault);
  });
});

type Faulty = Partial<RateLimiter>;
const okRate = { allowed: true, retryAfterSeconds: 0 };
const faults: ReadonlyArray<[string, Faulty]> = [
  ["hit throws synchronously", { hit: () => { throw new Error("boom"); } }],
  ["hit rejects", { hit: () => Promise.reject(new Error("boom")) }],
  ["hit returns undefined", { hit: (() => Promise.resolve(undefined)) as never }],
  ["hit returns null", { hit: (() => Promise.resolve(null)) as never }],
  ["hit returns string 'allowed'", { hit: (() => Promise.resolve("allowed")) as never }],
  ["hit allowed is truthy non-boolean", { hit: (() => Promise.resolve({ allowed: "yes", retryAfterSeconds: 0 })) as never }],
  ["hit allowed is 1", { hit: (() => Promise.resolve({ allowed: 1, retryAfterSeconds: 0 })) as never }],
  ["hit retryAfter negative", { hit: (() => Promise.resolve({ allowed: true, retryAfterSeconds: -1 })) as never }],
  ["hit retryAfter NaN", { hit: (() => Promise.resolve({ allowed: true, retryAfterSeconds: Number.NaN })) as never }],
  ["hit retryAfter missing", { hit: (() => Promise.resolve({ allowed: true })) as never }],
  ["hit returns throwing getter", { hit: (() => Promise.resolve({ get allowed(): boolean { throw new Error("getter"); }, retryAfterSeconds: 0 })) as never }],
  ["hit returns a Proxy", { hit: (() => Promise.resolve(new Proxy({}, { get: () => { throw new Error("proxy"); }, ownKeys: () => { throw new Error("proxy"); } }))) as never }],
  ["hit returns a cyclic object", { hit: (() => { const value: Record<string, unknown> = { allowed: true, retryAfterSeconds: 0 }; value.self = value; return Promise.resolve(value); }) as never }],
  ["isBlocked throws synchronously", { isBlocked: () => { throw new Error("boom"); } }],
  ["isBlocked rejects", { isBlocked: () => Promise.reject(new Error("boom")) }],
  ["isBlocked returns undefined", { isBlocked: (() => Promise.resolve(undefined)) as never }],
  ["isBlocked returns 0", { isBlocked: (() => Promise.resolve(0)) as never }],
  ["isBlocked returns 'false'", { isBlocked: (() => Promise.resolve("false")) as never }],
  ["isBlocked returns an object", { isBlocked: (() => Promise.resolve({ blocked: false })) as never }],
];
const hangs: ReadonlyArray<[string, Faulty]> = [
  ["hit hangs", { hit: () => new Promise<RateLimitResult>(() => undefined) }],
  ["isBlocked hangs", { isBlocked: () => new Promise<boolean>(() => undefined) }],
];
const healthy = (over: Faulty): RateLimiter => ({ hit: async () => okRate, isBlocked: async () => false, block: async () => undefined, ...over });
const proposalOps: ReadonlyArray<[string, (limiter: Limiter, clock: TestClock) => Promise<LimitVerdict>, Array<keyof RateLimiter>]> = [
  ["checkProposal", (limiter, clock) => limiter.checkProposal(proposal(clock)), ["hit", "isBlocked"]],
  ["checkCapability(HIGH)", (limiter) => limiter.checkCapability(capability({ risk: "HIGH" })), ["hit"]],
  ["claimExecution", (limiter) => limiter.claimExecution(turnInput()), ["hit"]],
];

describe("T116 limiter: ANY limiter fault denies fail-closed", () => {
  for (const [opName, run, used] of proposalOps) {
    for (const [name, broken] of faults) {
      const key = Object.keys(broken)[0] as keyof RateLimiter;
      if (!used.includes(key)) continue;
      it(`${opName}: ${name} => dependency_failure denial`, async () => {
        const { make, clock } = setup();
        const verdict = await run(make(healthy(broken)), clock);
        expect(verdict).toEqual(fault);
        expect(verdict.allowed).toBe(false);
      });
    }
    for (const [name, broken] of hangs) {
      const key = Object.keys(broken)[0] as keyof RateLimiter;
      if (!used.includes(key)) continue;
      it(`${opName}: ${name} => dependency_failure denial at the deadline`, async () => {
        const { make, clock, timer } = setup();
        const pending = run(make(healthy(broken)), clock);
        await flush();
        expect(timer.pending.size).toBe(1);
        timer.advance(2000);
        expect(await pending).toEqual(fault);
      });
    }
  }

  it("a full store denies (the in-memory store refuses at capacity) and never allows", async () => {
    const { limiter, clock } = setup({}, { maxEntries: 2 });
    expect(await limiter.checkProposal(proposal(clock))).toEqual(fault);
  });

  it("a late answer after the deadline cannot flip a denial", async () => {
    const { make, clock, timer } = setup();
    let release: (value: RateLimitResult) => void = () => undefined;
    const limiter = make(healthy({ hit: () => new Promise<RateLimitResult>((resolve) => { release = resolve; }) }));
    const pending = limiter.checkProposal(proposal(clock));
    await flush();
    timer.advance(2000);
    release(okRate);
    expect(await pending).toEqual(fault);
  });

  it("clears its timer after every settled call", async () => {
    const { limiter, clock, timer } = setup();
    await limiter.checkProposal(proposal(clock));
    await limiter.checkCapability(capability({ risk: "HIGH" }));
    await limiter.claimExecution(turnInput());
    await limiter.recordDenial(denial());
    expect(timer.pending.size).toBe(0);
  });

  it("honours a configured timeout and rejects unusable timeouts at construction", async () => {
    const { clock, timer, config } = setup();
    const limiter = createLimiter({ rateLimiter: healthy({ hit: () => new Promise<RateLimitResult>(() => undefined) }), config, clock, timer, timeoutMs: 50 });
    const pending = limiter.checkProposal(proposal(clock));
    await flush();
    timer.advance(49);
    timer.advance(1);
    expect(await pending).toEqual(fault);
    for (const timeoutMs of [0, -1, 1.5, Number.NaN, 2 ** 31]) expect(() => createLimiter({ rateLimiter: healthy({}), config, clock, timeoutMs })).toThrow();
  });

  it("a fault during a later bucket still denies even if earlier buckets allowed", async () => {
    const { make, clock } = setup();
    let calls = 0;
    const limiter = make(healthy({ hit: () => { calls++; return calls < 3 ? Promise.resolve(okRate) : Promise.reject(new Error("third")); } }));
    expect(await limiter.checkProposal(proposal(clock))).toEqual(fault);
  });

  it("never rejects or throws for hostile inputs", async () => {
    const { limiter, clock } = setup();
    const hostile = [
      undefined, null, 5, "x", {}, { scope: null }, { scope: { tenantId: "not-a-uuid" } }, { scope: { tenantId: A } },
      { ...proposal(clock), scope: { get tenantId(): TenantId { throw new Error("getter"); } } },
    ];
    for (const input of hostile) expect(await limiter.checkProposal(input as never)).toEqual(fault);
    for (const input of hostile) expect(await limiter.checkCapability(input as never)).toEqual(fault);
    for (const input of hostile) expect(await limiter.claimExecution(input as never)).toEqual(fault);
    for (const input of hostile) expect(await limiter.recordDenial(input as never)).toEqual({ recorded: false });
  });

  it("rejects malformed identifiers for every operation that uses them", async () => {
    const { limiter, clock, store } = setup();
    const bad = ["", 7, null, undefined, "x".repeat(257), "a\u0000b", { toString: () => "x" }];
    for (const value of bad) {
      expect(await limiter.checkProposal(proposal(clock, { userId: value as never }))).toEqual(fault);
      expect(await limiter.checkProposal(proposal(clock, { aiSessionId: value as never }))).toEqual(fault);
      expect(await limiter.checkProposal(proposal(clock, { turnId: value as never }))).toEqual(fault);
      expect(await limiter.checkCapability(capability({ userId: value as never }))).toEqual(fault);
      expect(await limiter.checkCapability(capability({ actionId: value as never }))).toEqual(fault);
      expect(await limiter.claimExecution(turnInput({ aiSessionId: value as never }))).toEqual(fault);
      expect(await limiter.claimExecution(turnInput({ turnId: value as never }))).toEqual(fault);
      expect(await limiter.recordDenial(denial({ aiSessionId: value as never }))).toEqual({ recorded: false });
    }
    expect(store.calls).toHaveLength(0);
  });

  it("rejects an unusable risk level", async () => {
    const { limiter } = setup();
    for (const risk of ["", "high", "NONE", undefined, 5]) expect(await limiter.checkCapability(capability({ risk: risk as never }))).toEqual(fault);
  });
});

describe("T116 limiter: capacity exhausted is a fail-closed denial", () => {
  const exhausted = (): Promise<never> => Promise.reject(new Error("Security state capacity exhausted"));
  it("a store that reports capacity exhausted denies every operation as a dependency failure, never an allow", async () => {
    const { make, clock } = setup();
    const full = make(healthy({ hit: exhausted, isBlocked: exhausted, block: exhausted }));
    expect(await full.checkProposal(proposal(clock))).toEqual(fault);
    expect(await full.checkCapability(capability({ risk: "HIGH" }))).toEqual(fault);
    expect(await full.claimExecution(turnInput())).toEqual(fault);
    expect(await full.recordDenial(denial())).toEqual({ recorded: false });
    const hitOnly = make(healthy({ hit: exhausted }));
    expect(await hitOnly.checkProposal(proposal(clock))).toEqual(fault);
    const blockOnly = make(healthy({ hit: async () => ({ allowed: false, retryAfterSeconds: 1 }), block: exhausted }));
    expect(await blockOnly.recordDenial(denial())).toEqual({ recorded: false });
  });
});

describe("T116 limiter: tenant isolation and key hygiene", () => {
  it("passes only the trusted scope tenant to the store and never puts tenant text in keys", async () => {
    const { limiter, clock, store } = setup();
    await limiter.checkProposal(proposal(clock, { userId: `${B}`, aiSessionId: `${B}`, turnId: `${B}` }));
    await limiter.checkCapability(capability({ userId: `${B}`, actionId: `${B}`, risk: "HIGH" }));
    await limiter.claimExecution(turnInput({ aiSessionId: `${B}` }));
    await limiter.recordDenial(denial({ aiSessionId: `${B}` }));
    expect(new Set(store.calls.map((call) => call.tenantId))).toEqual(new Set([A]));
  });

  it("separates identical user and session names across tenants", async () => {
    const { limiter, clock } = setup({ perUserPerMinute: { limit: 1, windowSeconds: 60 } });
    expect((await limiter.checkProposal(proposal(clock, { scope: { tenantId: A } }))).allowed).toBe(true);
    expect(await limiter.checkProposal(proposal(clock, { scope: { tenantId: A } }))).toEqual(denied("rate_limited_user", "user"));
    expect((await limiter.checkProposal(proposal(clock, { scope: { tenantId: B } }))).allowed).toBe(true);
    for (let index = 0; index < 6; index++) await limiter.recordDenial(denial({ scope: { tenantId: A } }));
    expect(await limiter.checkProposal(proposal(clock, { scope: { tenantId: B }, userId: "carol" }))).toEqual({ allowed: true });
  });

  it("builds injective keys: delimiters inside identifiers cannot collide buckets", async () => {
    const { limiter, clock, store } = setup();
    const pairs: Array<[string, string]> = [["a", "b:c"], ["a:b", "c"], ["a:b:c", "d"], ["a", "b%3Ac"], ["a%3Ab", "c"]];
    for (const [user, action] of pairs) await limiter.checkCapability(capability({ userId: user, actionId: action }));
    const keys = store.calls.filter((call) => call.key.startsWith("cap:")).map((call) => call.key);
    expect(new Set(keys).size).toBe(pairs.length);
    const turns: Array<[string, string]> = [["s", "t:u"], ["s:t", "u"], ["s%3At", "u"]];
    for (const [session, turn] of turns) await limiter.checkProposal(proposal(clock, { aiSessionId: session, turnId: turn }));
    const turnKeys = store.calls.filter((call) => call.key.startsWith("turn:proposals:")).map((call) => call.key);
    expect(new Set(turnKeys).size).toBe(turns.length);
    expect(keys.concat(turnKeys).every((key) => Buffer.byteLength(key) <= 1024)).toBe(true);
  });

  it("reads each input field once so a mutating or hostile input cannot change what is limited", async () => {
    const { limiter, store, clock } = setup();
    let reads = 0;
    const input = { ...proposal(clock), get userId(): string { reads++; return reads === 1 ? "alice" : "mallory"; } };
    await limiter.checkProposal(input as ProposalLimitInput);
    expect(reads).toBe(1);
    expect(store.calls.filter((call) => call.key.startsWith("user:")).map((call) => call.key)).toEqual(["user:alice"]);
  });

  it("uses stable bucket names for the documented scopes", async () => {
    const { limiter, clock, store } = setup();
    await limiter.checkProposal(proposal(clock, { turnId: "t9" }));
    await limiter.checkCapability(capability({ risk: "CRITICAL" }));
    await limiter.recordDenial(denial());
    expect(store.calls.filter((call) => call.op === "hit").map((call) => call.key)).toEqual([
      "turn:proposals:session-1:t9", "tenant", "user:alice", "cap:alice:testSafeEcho", "risk:alice", "deny:session-1",
    ]);
    expect(store.calls[0]).toEqual({ op: "isBlocked", tenantId: A, key: "deny:session-1" });
  });
});

describe("T116 limiter: review-hardening cases", () => {
  it("concurrent proposals on one turn reserve locally: shared turn hits never exceed the cap", async () => {
    const { limiter, clock, store, config } = setup();
    const input = proposal(clock, { turnId: "burst" });
    const verdicts = await Promise.all(Array.from({ length: 200 }, () => limiter.checkProposal(input)));
    expect(verdicts.filter((item) => item.allowed)).toHaveLength(config.proposalsPerTurn);
    expect(store.calls.filter((call) => call.op === "hit" && call.key.startsWith("turn:proposals:"))).toHaveLength(config.proposalsPerTurn);
  });

  it("the shared execution rule (not the proposal rule) caps executions across replicas", async () => {
    const { make } = setup();
    const a = make(); const b = make();
    for (let index = 0; index < 5; index++) expect((await a.claimExecution(turnInput())).allowed).toBe(true);
    for (let index = 0; index < 3; index++) expect((await b.claimExecution(turnInput())).allowed).toBe(true);
    expect(await b.claimExecution(turnInput())).toEqual(denied("rate_limited_turn", "turn_executions"));
    expect(await a.claimExecution(turnInput())).toEqual(denied("rate_limited_turn", "turn_executions"));
  });

  it("turn windows round the turn budget up to whole seconds", async () => {
    const { limiter, clock, store } = setup({ turnBudgetMs: 1500 });
    await limiter.checkProposal(proposal(clock));
    await limiter.claimExecution(turnInput());
    expect(store.calls.filter((call) => call.key.startsWith("turn:")).map((call) => call.rule?.windowSeconds)).toEqual([2, 2]);
  });

  it("bounds memory by denying new active turns, then reclaims slots after the turn lifetime", async () => {
    const { limiter, clock, store, config } = setup({}, { maxLocalTurns: 1 });
    const first = proposal(clock, { turnId: "keep" });
    for (let index = 0; index < config.proposalsPerTurn; index++) await limiter.checkProposal(first);
    const exhausted = store.calls.length;
    expect(await limiter.checkProposal(proposal(clock, { turnId: "other" }))).toEqual(fault);
    expect(await limiter.checkProposal(first)).toEqual(denied("rate_limited_turn", "turn_proposals"));
    expect(store.calls.length).toBe(exhausted);
    clock.advance(config.turnBudgetMs / 1000 + 1);
    expect(await limiter.checkProposal(proposal(clock, { turnId: "fresh" }))).toEqual({ allowed: true });
  });

  it("normalises the trusted tenant to lower case before it reaches the store", async () => {
    const { limiter, clock, store } = setup();
    await limiter.checkProposal(proposal(clock, { scope: { tenantId: A.toUpperCase() as TenantId } }));
    expect(new Set(store.calls.map((call) => call.tenantId))).toEqual(new Set([A]));
  });

  it("keeps per-turn local counts separate per tenant", async () => {
    const { limiter, clock, config } = setup();
    for (let index = 0; index < config.proposalsPerTurn + 2; index++) await limiter.checkProposal(proposal(clock, { turnId: "same", aiSessionId: "same" }));
    expect((await limiter.checkProposal(proposal(clock, { turnId: "same", aiSessionId: "same", scope: { tenantId: B } }))).allowed).toBe(true);
  });

  it("validates identifiers, tenant and keys before any store call (port-independent)", async () => {
    const { make, clock } = setup();
    let calls = 0;
    const counting = make({ hit: async () => { calls++; return okRate; }, isBlocked: async () => { calls++; return false; }, block: async () => { calls++; } });
    expect(await counting.checkProposal(proposal(clock, { scope: { tenantId: "tenant-a" as TenantId } }))).toEqual(fault);
    expect(await counting.checkProposal(proposal(clock, { userId: "é".repeat(200) }))).toEqual(fault);
    expect(await counting.checkCapability(capability({ actionId: "é".repeat(200) }))).toEqual(fault);
    expect(await counting.checkCapability(capability({ scope: { tenantId: "x" as TenantId } }))).toEqual(fault);
    expect(await counting.claimExecution(turnInput({ scope: { tenantId: "x" as TenantId } }))).toEqual(fault);
    expect(await counting.recordDenial(denial({ scope: { tenantId: "x" as TenantId } }))).toEqual({ recorded: false });
    expect(calls).toBe(0);
  });

  it("rejects clock readings that are not full ISO instants even when Date.parse accepts them", async () => {
    const { clock } = setup();
    for (const reading of ["2026-01-01", "2026/01/01 00:00:00", "Jan 1 2026"]) {
      const limiter = createLimiter({ rateLimiter: healthy({}), config: DEFAULT_LIMIT_CONFIG, clock: { now: () => reading as IsoInstant }, timer: new ManualTimer() });
      expect(await limiter.checkProposal(proposal(clock, { turnStartedAt: "2026-01-01T00:00:00Z" as IsoInstant }))).toEqual(fault);
    }
  });

  it("a block that answers with anything but a void promise is a fault", async () => {
    const { make } = setup();
    const answers: unknown[] = [true, "ok", {}, null, 1];
    for (const answer of answers) {
      const limiter = make({ hit: async () => ({ allowed: false, retryAfterSeconds: 1 }), isBlocked: async () => false, block: (() => Promise.resolve(answer)) as never });
      expect(await limiter.recordDenial(denial())).toEqual({ recorded: false });
    }
    const throwing = make({ hit: async () => ({ allowed: false, retryAfterSeconds: 1 }), isBlocked: async () => false, block: () => { throw new Error("sync"); } });
    expect(await throwing.recordDenial(denial())).toEqual({ recorded: false });
  });
});

describe("T116 limiter: construction", () => {
  it("rejects missing or malformed dependencies and unvalidated config", () => {
    const { store, clock } = setup();
    expect(() => createLimiter({ rateLimiter: store, config: { ...DEFAULT_LIMIT_CONFIG, proposalsPerTurn: 0 }, clock })).toThrow();
    expect(() => createLimiter({ rateLimiter: store, config: { ...DEFAULT_LIMIT_CONFIG, extra: 1 } as never, clock })).toThrow();
    expect(() => createLimiter({ rateLimiter: null as never, config: DEFAULT_LIMIT_CONFIG, clock })).toThrow();
    expect(() => createLimiter({ rateLimiter: {} as never, config: DEFAULT_LIMIT_CONFIG, clock })).toThrow();
    expect(() => createLimiter({ rateLimiter: store, config: DEFAULT_LIMIT_CONFIG, clock: {} as never })).toThrow();
    expect(() => createLimiter({ rateLimiter: store, config: DEFAULT_LIMIT_CONFIG, clock, maxLocalTurns: 0 })).toThrow();
  });

  it("snapshots the configuration at construction", async () => {
    const { store, clock } = setup();
    const config = { ...DEFAULT_LIMIT_CONFIG, perUserPerMinute: { limit: 2, windowSeconds: 60 } };
    const limiter = createLimiter({ rateLimiter: store, config, clock });
    (config.perUserPerMinute as { limit: number }).limit = 1000;
    for (let index = 0; index < 2; index++) await limiter.checkProposal(proposal(clock));
    expect(await limiter.checkProposal(proposal(clock))).toEqual(denied("rate_limited_user", "user"));
  });
});
