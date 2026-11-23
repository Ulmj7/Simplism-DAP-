/**
 * T088. Each record kind has its own failure semantics; every append is guarded; retries reuse the event so an idempotent sink
 * never holds two rows; and nothing here ever throws or lets a sink fault change a decision.
 */
import { describe, expect, it, vi } from "vitest";
import type { AuditEvent, AuditSink } from "@dap/contracts";
import type { HookTimer } from "../gateway/hook-wrapper.js";
import type { GatewayTelemetry } from "../gateway/telemetry.js";
import { InMemoryAuditStore } from "../state/memory/audit.js";
import { createAuditWriter } from "./audit-writer.js";
import { buildAuditEvent } from "./event-builder.js";
import type { AuditEventInput } from "./event-builder.js";
import { context, run } from "../gateway/fixtures.test-support.js";

const CONFIRMATION = "22222222-2222-4222-8222-222222222222";
const registered = { kind: "registered", id: "openProject", version: 1 } as const;
let counter = 0;
const nextId = () => `00000000-0000-4000-8000-${String(++counter).padStart(12, "0")}`;
const base = (overrides: Partial<AuditEventInput>): AuditEvent => buildAuditEvent({ id: nextId(), occurredAt: "2026-01-01T00:00:00Z", requestId: "req-1", decisionId: "dec-1", context: context(), run, ...overrides } as AuditEventInput);
const proposed = () => base({ type: "AI_ACTION_PROPOSED", action: { kind: "attempted", name: "openProject" } });
const denied = () => base({ type: "AI_ACTION_DENIED", outcome: "DENIED", reason: "permission_missing" });
const allowed = () => base({ type: "AI_ACTION_ALLOWED", action: registered, risk: "LOW", outcome: "ALLOWED", reason: "allowed" });
const executed = () => base({ type: "AI_ACTION_EXECUTED", action: registered, risk: "LOW", outcome: "ALLOWED", reason: "allowed", executionResult: "success" });

class ManualTimer implements HookTimer {
  time = 0; private next = 0;
  readonly pending = new Map<number, { at: number; callback: () => void }>();
  now(): number { return this.time; }
  setTimeout(callback: () => void, ms: number): number { const id = this.next++; this.pending.set(id, { at: this.time + ms, callback }); return id; }
  clearTimeout(handle: unknown): void { this.pending.delete(handle as number); }
  advance(ms: number): void { this.time += ms; for (const [id, entry] of [...this.pending]) if (entry.at <= this.time) { this.pending.delete(id); entry.callback(); } }
}
function counters() {
  const failures: string[] = [];
  const telemetry = { auditWriteFailed: (kind: string) => { failures.push(kind); } } as unknown as GatewayTelemetry;
  return { failures, telemetry };
}
const sinkOf = (append: (event: AuditEvent) => unknown): AuditSink => ({ append: append as never });
const flush = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };

describe("a healthy sink", () => {
  it("records each kind of event, resolving only after the append resolved", async () => {
    const store = new InMemoryAuditStore();
    const { failures, telemetry } = counters();
    const writer = createAuditWriter({ sink: store, telemetry });
    await writer.recordProposed(proposed());
    await writer.recordDecision(denied());
    expect(await writer.recordAllowedDurably(allowed())).toEqual({ ok: true });
    await writer.recordExecuted(executed());
    expect((await store.listForTenant(context().tenantId)).map((event) => event.type)).toEqual(["AI_ACTION_PROPOSED", "AI_ACTION_DENIED", "AI_ACTION_ALLOWED", "AI_ACTION_EXECUTED"]);
    expect(failures).toEqual([]);
  });

  it("passes the very event it was given, once, to the host's own method", async () => {
    const seen: { event: unknown; receiver: unknown; count: number }[] = [];
    const sink = { async append(this: unknown, ...args: unknown[]) { seen.push({ event: args[0], receiver: this, count: args.length }); } } as unknown as AuditSink;
    const event = allowed();
    await createAuditWriter({ sink }).recordAllowedDurably(event);
    expect(seen).toHaveLength(1);
    expect(seen[0]!.event).toBe(event);
    expect(seen[0]!.receiver).toBe(sink);
    expect(seen[0]!.count).toBe(2); // the event and the abandonment options, nothing else
  });

  it("returns frozen results", async () => {
    const writer = createAuditWriter({ sink: new InMemoryAuditStore() });
    expect(Object.isFrozen(writer)).toBe(true);
    expect(Object.isFrozen(await writer.recordAllowedDurably(allowed()))).toBe(true);
    const failing = createAuditWriter({ sink: sinkOf(() => Promise.reject(new Error("x"))) });
    expect(Object.isFrozen(await failing.recordAllowedDurably(allowed()))).toBe(true);
  });
});

describe("recordAllowedDurably: a failure means the caller must deny", () => {
  const faults: [string, () => unknown][] = [
    ["a throw", () => { throw new Error("CANARY"); }], ["a rejection", () => Promise.reject(new Error("CANARY"))], ["a synchronous undefined (no promise)", () => undefined],
    ["a resolved value that is not undefined", () => Promise.resolve(true)], ["a resolved false", () => Promise.resolve(false)], ["a resolved object", () => Promise.resolve({ ok: true })], ["a resolved null", () => Promise.resolve(null)],
    ["a throwing getter on the answer", () => Promise.resolve({ get x(): never { throw new Error("CANARY"); } })],
  ];
  it.each(faults)("%s is audit_unavailable, counted once as `allowed`", async (_name, append) => {
    const { failures, telemetry } = counters();
    expect(await createAuditWriter({ sink: sinkOf(append), telemetry }).recordAllowedDurably(allowed())).toEqual({ ok: false, reason: "audit_unavailable" });
    expect(failures).toEqual(["allowed"]);
  });

  it("a sink that hangs is audit_unavailable at exactly hookTimeoutMs, and the timer is cleared", async () => {
    const timer = new ManualTimer();
    const writer = createAuditWriter({ sink: sinkOf(() => new Promise(() => {})) }, { timer, hookTimeoutMs: 50 });
    const pending = writer.recordAllowedDurably(allowed());
    await flush();
    timer.advance(49); await flush();
    expect(timer.pending.size).toBe(1);
    timer.advance(1);
    expect(await pending).toEqual({ ok: false, reason: "audit_unavailable" });
    expect(timer.pending.size).toBe(0);
  });

  it("a late commit is not a commit", async () => {
    const timer = new ManualTimer();
    let release!: () => void;
    const writer = createAuditWriter({ sink: sinkOf(() => new Promise<void>((resolve) => { release = resolve; })) }, { timer, hookTimeoutMs: 50 });
    const pending = writer.recordAllowedDurably(allowed());
    await flush();
    timer.advance(50);
    release();
    expect(await pending).toEqual({ ok: false, reason: "audit_unavailable" });
  });

  it("defaults the timeout to 2000 ms", async () => {
    const timer = new ManualTimer();
    const pending = createAuditWriter({ sink: sinkOf(() => new Promise(() => {})) }, { timer }).recordAllowedDurably(allowed());
    await flush();
    expect([...timer.pending.values()][0]!.at).toBe(2000);
    timer.advance(2000);
    expect(await pending).toEqual({ ok: false, reason: "audit_unavailable" });
  });

  it("does not leak the sink's error text into anything it returns or counts", async () => {
    const { failures, telemetry } = counters();
    const result = await createAuditWriter({ sink: sinkOf(() => { throw new Error("CANARY_SECRET sk-abcdefghijklmnopqrstuvwx"); }), telemetry }).recordAllowedDurably(allowed());
    expect(JSON.stringify([result, failures])).not.toContain("CANARY");
  });
});

describe("denials, proposals and results: a failure is counted and changes nothing", () => {
  it.each([["recordProposed", "proposed", proposed], ["recordDecision", "decision", denied], ["recordExecuted", "executed", executed]] as const)("%s resolves normally and counts a `%s` failure when the sink rejects", async (method, kind, make) => {
    for (const append of [() => { throw new Error("x"); }, () => Promise.reject(new Error("x")), () => undefined, () => new Promise(() => {})]) {
      const { failures, telemetry } = counters();
      const timer = new ManualTimer();
      const writer = createAuditWriter({ sink: sinkOf(append), telemetry }, { timer, hookTimeoutMs: 10 });
      const pending = writer[method](make());
      await flush(); timer.advance(10);
      expect(await pending).toBeUndefined();
      expect(failures).toEqual([kind]);
    }
  });

  it("recordDecision accepts every non-allowing decision type and no other", async () => {
    const store = new InMemoryAuditStore();
    const writer = createAuditWriter({ sink: store });
    const types = ["AI_ACTION_DENIED", "AI_POLICY_VIOLATION", "AI_RATE_LIMITED", "AI_CONFIRMATION_REQUIRED", "AI_CONFIRMATION_REJECTED"] as const;
    const made: Record<(typeof types)[number], AuditEvent> = {
      AI_ACTION_DENIED: denied(), AI_POLICY_VIOLATION: base({ type: "AI_POLICY_VIOLATION", outcome: "FORBIDDEN_POLICY", reason: "reserved_forbidden_action" }),
      AI_RATE_LIMITED: base({ type: "AI_RATE_LIMITED", outcome: "DENIED", reason: "rate_limited_user" }),
      AI_CONFIRMATION_REQUIRED: base({ type: "AI_CONFIRMATION_REQUIRED", action: registered, risk: "HIGH", outcome: "REQUIRES_CONFIRMATION", reason: "confirmation_required", confirmation: { id: CONFIRMATION, state: "pending" } }),
      AI_CONFIRMATION_REJECTED: base({ type: "AI_CONFIRMATION_REJECTED", action: registered, risk: "HIGH", outcome: "DENIED", reason: "confirmation_rejected", confirmation: { id: CONFIRMATION, state: "rejected" } }),
    };
    for (const type of types) await writer.recordDecision(made[type]);
    expect(store.size).toBe(types.length);
  });
});

describe("each method refuses the wrong kind of event, without touching the sink", () => {
  it.each([
    ["recordProposed", denied], ["recordProposed", allowed], ["recordProposed", executed], ["recordDecision", proposed], ["recordDecision", allowed], ["recordDecision", executed],
    ["recordAllowedDurably", proposed], ["recordAllowedDurably", denied], ["recordAllowedDurably", executed], ["recordExecuted", proposed], ["recordExecuted", denied], ["recordExecuted", allowed],
  ] as const)("%s refuses a mismatched event", async (method, make) => {
    let calls = 0;
    const { failures, telemetry } = counters();
    const writer = createAuditWriter({ sink: sinkOf(() => { calls++; return Promise.resolve(); }), telemetry });
    const result = await writer[method](make());
    expect(calls).toBe(0);
    expect(failures).toHaveLength(1);
    if (method === "recordAllowedDurably") expect(result).toEqual({ ok: false, reason: "audit_unavailable" });
  });

  it("recordAllowedDurably accepts a confirmation acceptance, the durable record before the allow-event", async () => {
    const event = base({ type: "AI_CONFIRMATION_ACCEPTED", action: registered, risk: "HIGH", outcome: "ALLOWED", reason: "allowed", confirmation: { id: CONFIRMATION, state: "accepted" } });
    expect(await createAuditWriter({ sink: new InMemoryAuditStore() }).recordAllowedDurably(event)).toEqual({ ok: true });
  });

  it.each([["a literal", { type: "AI_ACTION_ALLOWED" }], ["a copy of a built event", () => ({ ...allowed() })], ["null", null], ["undefined", undefined], ["a string", "event"]])("refuses %s that the builder did not make", async (_name, imposter) => {
    let calls = 0;
    const { failures, telemetry } = counters();
    const value = typeof imposter === "function" ? (imposter as () => unknown)() : imposter;
    const result = await createAuditWriter({ sink: sinkOf(() => { calls++; return Promise.resolve(); }), telemetry }).recordAllowedDurably(value as AuditEvent);
    expect(result).toEqual({ ok: false, reason: "audit_unavailable" });
    expect(calls).toBe(0);
    expect(failures).toEqual(["allowed"]);
  });
});

describe("retries never duplicate rows", () => {
  it("a retry after a failed append reuses the same event and commits it once", async () => {
    const store = new InMemoryAuditStore();
    let calls = 0;
    const flaky: AuditSink = { append: async (event) => { calls++; if (calls === 1) throw new Error("transient"); await store.append(event); } };
    const event = allowed();
    expect(await createAuditWriter({ sink: flaky }, { attempts: 3 }).recordAllowedDurably(event)).toEqual({ ok: true });
    expect(calls).toBe(2);
    expect(store.size).toBe(1);
  });

  it("an append that committed but whose acknowledgement was lost leaves one row after the retry", async () => {
    const store = new InMemoryAuditStore();
    const timer = new ManualTimer();
    let calls = 0;
    const lossy: AuditSink = { append: async (event) => { calls++; await store.append(event); if (calls === 1) await new Promise(() => {}); } };
    const writer = createAuditWriter({ sink: lossy }, { attempts: 2, timer, hookTimeoutMs: 20 });
    const pending = writer.recordAllowedDurably(allowed());
    await flush(); timer.advance(20); await flush();
    expect(await pending).toEqual({ ok: true });
    expect(calls).toBe(2);
    expect(store.size).toBe(1);
  });

  it("stops after `attempts` and reports failure once", async () => {
    let calls = 0;
    const { failures, telemetry } = counters();
    const writer = createAuditWriter({ sink: sinkOf(() => { calls++; return Promise.reject(new Error("down")); }), telemetry }, { attempts: 3 });
    expect(await writer.recordAllowedDurably(allowed())).toEqual({ ok: false, reason: "audit_unavailable" });
    expect(calls).toBe(3);
    expect(failures).toEqual(["allowed"]);
  });

  it("does not retry a success, and does not retry by default", async () => {
    let calls = 0;
    await createAuditWriter({ sink: sinkOf(() => { calls++; return Promise.resolve(); }) }, { attempts: 5 }).recordAllowedDurably(allowed());
    expect(calls).toBe(1);
    calls = 0;
    await createAuditWriter({ sink: sinkOf(() => { calls++; return Promise.reject(new Error("x")); }) }).recordAllowedDurably(allowed());
    expect(calls).toBe(1);
  });

  it.each([0, 6, 1.5, -1, Number.NaN, "2"])("rejects attempts of %j", (attempts) => {
    expect(() => createAuditWriter({ sink: new InMemoryAuditStore() }, { attempts: attempts as number })).toThrow(RangeError);
  });
  it("accepts 1 and 5 attempts", () => {
    expect(() => createAuditWriter({ sink: new InMemoryAuditStore() }, { attempts: 1 })).not.toThrow();
    expect(() => createAuditWriter({ sink: new InMemoryAuditStore() }, { attempts: 5 })).not.toThrow();
  });
});

describe("the abandonment signal: an append the writer gave up on is told so, and a confirmed commit is never aborted", () => {
  /** A sink that records the signal of every call and the value of `aborted` at the end of each, and answers as `answer` says. */
  function spy(answer: (call: number, event: AuditEvent) => unknown) {
    const calls: { options: { signal?: { aborted: boolean } } | undefined; event: AuditEvent }[] = [];
    const sink = { append: (event: AuditEvent, options?: { signal?: { aborted: boolean } }) => { calls.push({ event, options }); return answer(calls.length, event); } } as unknown as AuditSink;
    return { calls, sink };
  }
  it("passes the sink an options object with a signal that starts not aborted", async () => {
    const { calls, sink } = spy(async () => undefined);
    expect(await createAuditWriter({ sink }).recordAllowedDurably(allowed())).toEqual({ ok: true });
    expect(calls).toHaveLength(1);
    expect(Object.keys(calls[0]!.options!)).toEqual(["signal"]);
    expect(typeof calls[0]!.options!.signal!.aborted).toBe("boolean");
  });
  it("does NOT abort after a confirmed commit, for every kind of record", async () => {
    const { calls, sink } = spy(async () => undefined);
    const writer = createAuditWriter({ sink });
    await writer.recordProposed(proposed()); await writer.recordDecision(denied()); await writer.recordAllowedDurably(allowed()); await writer.recordExecuted(executed());
    expect(calls).toHaveLength(4);
    for (const call of calls) expect(call.options!.signal!.aborted).toBe(false);
  });
  it("aborts on a timeout (the append is still pending when the writer gives up)", async () => {
    const timer = new ManualTimer();
    const { calls, sink } = spy(() => new Promise(() => {}));
    const pending = createAuditWriter({ sink }, { timer, hookTimeoutMs: 50 }).recordAllowedDurably(allowed());
    await flush();
    expect(calls[0]!.options!.signal!.aborted).toBe(false); // not before the writer gives up
    timer.advance(50);
    expect(await pending).toEqual({ ok: false, reason: "audit_unavailable" });
    expect(calls[0]!.options!.signal!.aborted).toBe(true);
  });
  it("aborts on a late answer: the commit that arrives after the deadline is already told to roll back", async () => {
    const timer = new ManualTimer();
    let release!: () => void;
    const { calls, sink } = spy(() => new Promise<void>((resolve) => { release = resolve; }));
    const pending = createAuditWriter({ sink }, { timer, hookTimeoutMs: 50 }).recordAllowedDurably(allowed());
    await flush(); timer.advance(50); release();
    expect(await pending).toEqual({ ok: false, reason: "audit_unavailable" });
    expect(calls[0]!.options!.signal!.aborted).toBe(true);
  });
  it.each<[string, () => unknown]>([["a rejection", () => Promise.reject(new Error("x"))], ["a synchronous throw", () => { throw new Error("x"); }], ["a wrong-shaped answer", () => Promise.resolve("committed")], ["a non-promise answer", () => "committed"]])("aborts on %s", async (_name, answer) => {
    const { calls, sink } = spy(answer);
    expect(await createAuditWriter({ sink }).recordAllowedDurably(allowed())).toEqual({ ok: false, reason: "audit_unavailable" });
    expect(calls[0]!.options!.signal!.aborted).toBe(true);
  });
  it("aborts a created attempt even when hook setup throws through the outer catch", async () => {
    const Native = AbortController;
    const controllers: AbortController[] = [];
    const append = vi.fn(async () => undefined);
    const writer = createAuditWriter({ sink: { append } });
    vi.spyOn(globalThis, "AbortController").mockImplementation(function () { const controller = new Native(); controllers.push(controller); return controller; });
    vi.spyOn(Math, "min").mockImplementationOnce(() => { throw new Error("setup failed"); });
    try {
      expect(await writer.recordAllowedDurably(allowed())).toEqual({ ok: false, reason: "audit_unavailable" });
      expect(append).not.toHaveBeenCalled();
      expect(controllers).toHaveLength(1);
      expect(controllers[0]!.signal.aborted).toBe(true);
    } finally { vi.restoreAllMocks(); }
  });
  it("a spent budget creates no controller or options and never calls the sink", async () => {
    const controller = vi.spyOn(globalThis, "AbortController");
    const append = vi.fn(async () => undefined);
    try {
      expect(await createAuditWriter({ sink: { append } }).recordAllowedDurably(allowed(), { remainingMs: () => 0 })).toEqual({ ok: false, reason: "audit_unavailable" });
      expect(controller).not.toHaveBeenCalled(); expect(append).not.toHaveBeenCalled();
    } finally { vi.restoreAllMocks(); }
  });
  it("a sink that ignores the second argument works exactly as before", async () => {
    const store = new InMemoryAuditStore();
    const ignoring: AuditSink = { append: async (event) => { await store.append(event); } };
    expect(await createAuditWriter({ sink: ignoring }).recordAllowedDurably(allowed())).toEqual({ ok: true });
    expect(store.size).toBe(1);
  });
  it("a retry gets a NEW signal and the SAME event: the abandoned first attempt stays aborted, the committed second never is, and there is one row", async () => {
    const store = new InMemoryAuditStore();
    const timer = new ManualTimer();
    const { calls, sink } = spy((call, event) => call === 1 ? new Promise(() => {}) : store.append(event));
    const pending = createAuditWriter({ sink }, { attempts: 2, timer, hookTimeoutMs: 20 }).recordAllowedDurably(allowed());
    await flush(); timer.advance(20); await flush();
    expect(await pending).toEqual({ ok: true });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.event).toBe(calls[1]!.event);
    expect(calls[0]!.options).not.toBe(calls[1]!.options);
    expect(calls[0]!.options!.signal).not.toBe(calls[1]!.options!.signal);
    expect([calls[0]!.options!.signal!.aborted, calls[1]!.options!.signal!.aborted]).toEqual([true, false]);
    expect(store.size).toBe(1);
  });
  it("a sink that honors the signal never commits an abandoned append (the in-memory model of the PostgreSQL rule)", async () => {
    const store = new InMemoryAuditStore();
    const timer = new ManualTimer();
    let release!: () => void;
    const honoring: AuditSink = { append: async (event, options) => { await new Promise<void>((resolve) => { release = resolve; }); if (options?.signal?.aborted === true) throw new Error("rolled back"); await store.append(event); } };
    const pending = createAuditWriter({ sink: honoring }, { timer, hookTimeoutMs: 50 }).recordAllowedDurably(allowed());
    await flush(); timer.advance(50); release();
    expect(await pending).toEqual({ ok: false, reason: "audit_unavailable" });
    await flush();
    expect(store.size).toBe(0);
  });
});

describe("the proposal budget bounds the append", () => {
  const budgetOf = (timer: ManualTimer, total: number) => ({ remainingMs: () => total - timer.time });
  it("a budget that cannot be read fails closed instead of throwing", async () => {
    let calls = 0;
    const budget = { remainingMs: () => { throw new Error("CANARY"); } };
    const result = await createAuditWriter({ sink: sinkOf(() => { calls++; return Promise.resolve(); }) }).recordAllowedDurably(allowed(), budget);
    expect(result).toEqual({ ok: false, reason: "audit_unavailable" });
    expect(calls).toBe(0);
  });

  it.each([0, 0.5, -1, Number.NaN])("a remaining budget of %s fails without calling the sink", async (left) => {
    let calls = 0;
    const result = await createAuditWriter({ sink: sinkOf(() => { calls++; return Promise.resolve(); }) }).recordAllowedDurably(allowed(), { remainingMs: () => left });
    expect(result).toEqual({ ok: false, reason: "audit_unavailable" });
    expect(calls).toBe(0);
  });

  it("gives the append min(hookTimeoutMs, remaining): the budget when that is shorter", async () => {
    const timer = new ManualTimer();
    const pending = createAuditWriter({ sink: sinkOf(() => new Promise(() => {})) }, { timer, hookTimeoutMs: 2000 }).recordAllowedDurably(allowed(), budgetOf(timer, 300));
    await flush();
    expect([...timer.pending.values()][0]!.at).toBe(300);
    timer.advance(300);
    expect(await pending).toEqual({ ok: false, reason: "audit_unavailable" });
  });

  it("never more than hookTimeoutMs, and rounds a fractional budget down", async () => {
    const timer = new ManualTimer();
    createAuditWriter({ sink: sinkOf(() => new Promise(() => {})) }, { timer, hookTimeoutMs: 100 }).recordAllowedDurably(allowed(), budgetOf(timer, 60_000)).catch(() => undefined);
    await flush();
    expect([...timer.pending.values()][0]!.at).toBe(100);
    const fractional = new ManualTimer();
    createAuditWriter({ sink: sinkOf(() => new Promise(() => {})) }, { timer: fractional, hookTimeoutMs: 100 }).recordAllowedDurably(allowed(), { remainingMs: () => 7.9 }).catch(() => undefined);
    await flush();
    expect([...fractional.pending.values()][0]!.at).toBe(7);
  });

  it("re-reads the budget before each retry", async () => {
    const timer = new ManualTimer();
    let calls = 0;
    const writer = createAuditWriter({ sink: sinkOf(() => { calls++; timer.time += 600; return Promise.reject(new Error("x")); }) }, { timer, attempts: 3, hookTimeoutMs: 1000 });
    expect(await writer.recordAllowedDurably(allowed(), budgetOf(timer, 1000))).toEqual({ ok: false, reason: "audit_unavailable" });
    expect(calls).toBe(2); // 600 ms spent after the first, 1200 after the second: the third finds no budget left and is never made
  });
});

describe("construction and robustness", () => {
  it.each([["no sink", undefined], ["a sink without append", {}], ["an append that is not a function", { append: 1 }]])("throws for %s", (_name, sink) => {
    expect(() => createAuditWriter({ sink: sink as never })).toThrow("Missing audit sink");
  });
  it.each([0, -1, 1.5, 0x8000_0000])("rejects a hookTimeoutMs of %j", (hookTimeoutMs) => {
    expect(() => createAuditWriter({ sink: new InMemoryAuditStore() }, { hookTimeoutMs })).toThrow(RangeError);
  });
  it("reads the sink's method once: a later swap changes nothing", async () => {
    let first = 0; let second = 0;
    const sink = { append: async () => { first++; } };
    const writer = createAuditWriter({ sink });
    sink.append = async () => { second++; };
    await writer.recordProposed(proposed());
    expect([first, second]).toEqual([1, 0]);
  });
  it("survives broken telemetry", async () => {
    const telemetry = { auditWriteFailed: () => { throw new Error("CANARY"); } } as unknown as GatewayTelemetry;
    const writer = createAuditWriter({ sink: sinkOf(() => Promise.reject(new Error("x"))), telemetry });
    await expect(writer.recordDecision(denied())).resolves.toBeUndefined();
    await expect(writer.recordAllowedDurably(allowed())).resolves.toEqual({ ok: false, reason: "audit_unavailable" });
  });
  it("works with no telemetry at all", async () => {
    await expect(createAuditWriter({ sink: sinkOf(() => Promise.reject(new Error("x"))) }).recordExecuted(executed())).resolves.toBeUndefined();
  });
});
