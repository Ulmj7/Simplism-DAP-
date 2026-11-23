/** C01 approved-id handoff and proposal store, no PostgreSQL: the Gateway submission is a stub that plays the executor's part. */
import { describe, expect, it, vi } from "vitest";
import type { GuidanceResult } from "@dap/ai";
import type { AiSession } from "../compose.js";
import { createApprovalRecorder, createGatewayStart } from "./approved-start.js";
import { PROPOSAL_TTL_MS, createProposalStore } from "./proposal-store.js";

const session: AiSession = { submit: async () => { throw new Error("unused: submit is stubbed"); } };
const approved = (walkthroughId: string): GuidanceResult => ({ kind: "walkthrough", walkthroughId });
const refused: GuidanceResult = { kind: "unsupported", message: "Not permitted.", reason: "not_permitted" };

describe("createGatewayStart", () => {
  it("approve: the id the executor's starter received is returned, and the record is claimed", async () => {
    const recorder = createApprovalRecorder();
    const submit = vi.fn(async (_s: AiSession, id: string) => { recorder.starter.start(id); return approved(id); });
    const start = createGatewayStart({ openSession: async () => session, recorder, submit });
    expect(await start("profileUpdate")).toEqual({ ok: true, walkthroughId: "profileUpdate" });
    expect(submit).toHaveBeenCalledWith(session, "profileUpdate");
  });

  it("policy refuse: the executor never ran, so nothing is recorded and the start fails", async () => {
    const recorder = createApprovalRecorder();
    const start = createGatewayStart({ openSession: async () => session, recorder, submit: async () => refused });
    expect(await start("profileUpdate")).toEqual({ ok: false });
  });

  it("a Gateway ok without a recorded id fails closed", async () => {
    const recorder = createApprovalRecorder();
    const start = createGatewayStart({ openSession: async () => session, recorder, submit: async (_s, id) => approved(id) });
    expect(await start("profileUpdate")).toEqual({ ok: false });
  });

  it("a record left by a refused submission is claimed and never approves a later start", async () => {
    const recorder = createApprovalRecorder();
    let allow = false;
    const start = createGatewayStart({ openSession: async () => session, recorder, submit: async (_s, id) => { recorder.starter.start(id); return allow ? approved(id) : refused; } });
    expect(await start("profileUpdate")).toEqual({ ok: false });
    allow = true;
    expect(await start("profileUpdate")).toEqual({ ok: true, walkthroughId: "profileUpdate" });
  });

  it("no session, or a throwing submission, fails closed without throwing", async () => {
    const recorder = createApprovalRecorder();
    expect(await createGatewayStart({ openSession: async () => null, recorder, submit: async (_s, id) => approved(id) })("profileUpdate")).toEqual({ ok: false });
    expect(await createGatewayStart({ openSession: async () => { throw new Error("db down"); }, recorder })("profileUpdate")).toEqual({ ok: false });
    const throwing = createGatewayStart({ openSession: async () => session, recorder, submit: async (_s, id) => { recorder.starter.start(id); throw new Error("boom"); } });
    expect(await throwing("profileUpdate")).toEqual({ ok: false });
  });

  it("overlapping starts of the same id are serialized, so a refused one cannot claim an approved one's record", async () => {
    const recorder = createApprovalRecorder();
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    let call = 0;
    const submit = async (_s: AiSession, id: string) => {
      call += 1;
      if (call === 1) { recorder.starter.start(id); await gate; return approved(id); }
      return refused;
    };
    const start = createGatewayStart({ openSession: async () => session, recorder, submit });
    const first = start("profileUpdate");
    const second = start("profileUpdate");
    release();
    expect(await first).toEqual({ ok: true, walkthroughId: "profileUpdate" });
    expect(await second).toEqual({ ok: false });
  });

  it("the recorder only accepts one matching id while a submission is open", () => {
    const recorder = createApprovalRecorder();
    expect(recorder.starter.start("a")).toMatchObject({ ok: false });
    recorder.withSubmission("a", take => {
      expect(recorder.starter.start("b")).toMatchObject({ ok: false });
      expect(recorder.starter.start("a")).toEqual({ ok: true });
      expect(recorder.starter.start("a")).toMatchObject({ ok: false });
      expect(take()).toBe("a");
      expect(take()).toBeNull();
      expect(recorder.starter.start("a")).toMatchObject({ ok: false });
    });
  });
});

describe("createProposalStore", () => {
  const make = (maxEntries?: number) => {
    const clock = { now: 0 };
    let n = 0;
    const store = createProposalStore({ now: () => clock.now, newId: () => `id-${String(++n).padStart(14, "0")}`, ...(maxEntries ? { maxEntries } : {}) });
    return { clock, store };
  };

  it("redeems once, for the minting session only, within the TTL", () => {
    const { clock, store } = make();
    const a = store.mint("s1", "profileUpdate");
    expect(store.redeem("s1", a)).toBe("profileUpdate");
    expect(store.redeem("s1", a)).toBeNull();
    const b = store.mint("s1", "profileUpdate");
    expect(store.redeem("s2", b)).toBeNull();
    expect(store.redeem("s1", b)).toBeNull();
    const c = store.mint("s1", "profileUpdate");
    clock.now += PROPOSAL_TTL_MS;
    expect(store.redeem("s1", c)).toBeNull();
    expect(store.size()).toBe(0);
  });

  it("is bounded: the oldest proposal is evicted first", () => {
    const { store } = make(2);
    const first = store.mint("s", "a");
    const second = store.mint("s", "b");
    const third = store.mint("s", "c");
    expect(store.size()).toBe(2);
    expect(store.redeem("s", first)).toBeNull();
    expect(store.redeem("s", second)).toBe("b");
    expect(store.redeem("s", third)).toBe("c");
  });

  it("fails closed on a repeating id generator", () => {
    const store = createProposalStore({ now: () => 0, newId: () => "same-id-0000000000" });
    store.mint("s", "a");
    expect(() => store.mint("s", "b")).toThrow();
  });
});

describe("createGatewayStart: a stalled Gateway cannot wedge /start (timeout and queue cap)", () => {
  /** A manual timer: `fire()` runs every pending callback, as if the timeout elapsed. */
  const manualTimers = () => {
    const pending = new Map<number, () => void>();
    let next = 0;
    return {
      timers: { setTimeout: (fn: () => void) => { next += 1; pending.set(next, fn); return next; }, clearTimeout: (handle: unknown) => { pending.delete(handle as number); } },
      fire: () => { const fns = [...pending.values()]; pending.clear(); for (const fn of fns) fn(); },
      size: () => pending.size,
    };
  };
  const deferred = <T>() => { let resolve: (value: T) => void = () => undefined; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; };
  const flush = () => new Promise<void>((resolve) => setImmediate(resolve));

  it("hang -> timeout: the stalled start fails closed as unavailable, its record is cleared, and the next start still works", async () => {
    const recorder = createApprovalRecorder();
    const clock = manualTimers();
    const hung = deferred<GuidanceResult>();
    let call = 0;
    const submit = async (_s: AiSession, id: string) => { call += 1; recorder.starter.start(id); return call === 1 ? hung.promise : approved(id); };
    const start = createGatewayStart({ openSession: async () => session, recorder, submit, timers: clock.timers, timeoutMs: 10_000 });
    const first = start("profileUpdate");
    await flush();
    clock.fire();
    expect(await first).toEqual({ ok: false, unavailable: true });
    expect(await start("findSecuritySettings")).toEqual({ ok: true, walkthroughId: "findSecuritySettings" });
    expect(clock.size()).toBe(0);
  });

  it("a late completion after the timeout is ignored: never reported as approved, and it leaves no stale record", async () => {
    const recorder = createApprovalRecorder();
    const clock = manualTimers();
    const hung = deferred<void>();
    const outcomes: unknown[] = [];
    const lateRecords: unknown[] = [];
    const start = createGatewayStart({ openSession: async () => session, recorder, submit: async (_session, id) => {
      await hung.promise;
      lateRecords.push(recorder.starter.start(id));
      return approved(id);
    }, timers: clock.timers });
    void start("profileUpdate").then((outcome) => outcomes.push(outcome));
    await flush();
    clock.fire();
    await flush();
    hung.resolve(); // the executor tries to record after the transport gave up
    await flush();
    await flush();
    expect(outcomes).toEqual([{ ok: false, unavailable: true }]);
    expect(lateRecords).toEqual([expect.objectContaining({ ok: false })]);
  });

  it("an expired submission cannot lend a late approval to a newer submission of the same id", async () => {
    const recorder = createApprovalRecorder();
    const clock = manualTimers();
    const oldGate = deferred<void>();
    const oldFinish = deferred<void>();
    const newGate = deferred<void>();
    let calls = 0;
    const start = createGatewayStart({ openSession: async () => session, recorder, timers: clock.timers, submit: async (_session, id) => {
      if (++calls === 1) {
        await oldGate.promise;
        recorder.starter.start(id);
        await oldFinish.promise;
        return refused;
      }
      await newGate.promise;
      return approved(id); // The new submission did not itself record anything.
    } });
    const first = start("profileUpdate");
    await flush();
    clock.fire();
    expect(await first).toEqual({ ok: false, unavailable: true });
    const second = start("profileUpdate");
    await flush();
    expect(calls).toBe(2);
    oldGate.resolve();
    await flush();
    newGate.resolve();
    expect(await second).toEqual({ ok: false });
    oldFinish.resolve();
    await flush();
  });

  it("queue cap: beyond maxQueue pending starts, a start fails closed at once without reaching the Gateway", async () => {
    const recorder = createApprovalRecorder();
    const clock = manualTimers();
    const hung = deferred<GuidanceResult>();
    const submit = vi.fn(async () => hung.promise);
    const start = createGatewayStart({ openSession: async () => session, recorder, submit, timers: clock.timers, maxQueue: 2 });
    const a = start("profileUpdate");
    const b = start("profileUpdate");
    expect(await start("profileUpdate")).toEqual({ ok: false, unavailable: true });
    await flush();
    expect(submit).toHaveBeenCalledTimes(1);
    clock.fire(); // a times out, b takes the slot
    expect(await a).toEqual({ ok: false, unavailable: true });
    await flush();
    clock.fire();
    expect(await b).toEqual({ ok: false, unavailable: true });
    const c = start("profileUpdate"); // the queue drained, so starts are accepted again
    await flush();
    clock.fire();
    expect(await c).toEqual({ ok: false, unavailable: true });
    expect(submit).toHaveBeenCalledTimes(3);
  });

  it("defaults: a 10 s timeout and a queue of 8", async () => {
    const recorder = createApprovalRecorder();
    const delays: number[] = [];
    const timers = { setTimeout: (_fn: () => void, ms: number) => { delays.push(ms); return 0; }, clearTimeout: () => undefined };
    const never = new Promise<GuidanceResult>(() => undefined);
    const start = createGatewayStart({ openSession: async () => session, recorder, submit: async () => never, timers });
    for (let i = 0; i < 8; i += 1) void start("profileUpdate");
    expect(await start("profileUpdate")).toEqual({ ok: false, unavailable: true });
    await flush();
    expect(delays).toEqual([10_000]);
  });
});
