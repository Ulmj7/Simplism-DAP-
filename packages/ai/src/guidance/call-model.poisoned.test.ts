/**
 * Regression checks (Slice 2, step 0): a trusted provider may hand back a promise or thenable whose `then` misbehaves. Each case must end in a closed reason,
 * leave NO unhandled rejection behind, release the cancel handle, and leak nothing from the provider. Not a general Promise-hardening suite.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { callGuidanceModel } from "./call-model.js";
import type { GuidanceModel, GuidanceTimers } from "./types.js";

const request = () => ({
  input: {
    query: "How do I change my name?",
    semanticContext: { route: "profile", elements: [{ id: "profile.nameInput", role: "textbox", label: "Name", description: "Your display name", privacy: "public", available: true }] },
    walkthroughSummaries: [], sources: [],
  },
  maxOutputChars: 1200,
});
const decision = { kind: "clarify", message: "Which page do you mean?" };
const SECRET = "sk-live-SECRET-POISON";

const unhandled: unknown[] = [];
const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
beforeEach(() => { unhandled.length = 0; process.on("unhandledRejection", onUnhandled); });
afterEach(() => { process.off("unhandledRejection", onUnhandled); });
const settleTicks = () => new Promise<void>((resolve) => setTimeout(resolve, 20));

function run(produce: () => unknown, fire = false) {
  const cancelled: boolean[] = [];
  const callbacks: (() => void)[] = [];
  const timers: GuidanceTimers = { set: (cb) => { callbacks.push(cb); cancelled.push(false); const index = cancelled.length - 1; return () => { cancelled[index] = true; }; } };
  const model: GuidanceModel = { generate: () => produce() as Promise<unknown> };
  const promise = callGuidanceModel({ model, request: request(), timers });
  if (fire) callbacks[0]!();
  return { promise, cancelled };
}
const closed = (outcome: unknown, reason: string) => {
  expect(outcome).toEqual({ ok: false, reason });
  expect(JSON.stringify(outcome)).not.toContain("SECRET");
};

describe("a provider promise or thenable whose then misbehaves", () => {
  it("(a) a native promise that REJECTS and has an own then getter that throws: model_unavailable, no unhandled rejection", async () => {
    const produce = () => { const p = Promise.reject(new Error(SECRET)); Object.defineProperty(p, "then", { get() { throw new Error(SECRET); } }); return p; };
    const r = run(produce);
    closed(await r.promise, "model_unavailable");
    await settleTicks();
    expect(unhandled).toEqual([]);
    expect(r.cancelled).toEqual([true]);
  });
  it("(a2) the same with a native promise that RESOLVES with a valid decision: the real answer is used, nothing is left unhandled", async () => {
    const produce = () => { const p = Promise.resolve(decision); Object.defineProperty(p, "then", { get() { throw new Error(SECRET); } }); return p; };
    const r = run(produce);
    expect(await r.promise).toEqual({ ok: true, decision });
    await settleTicks();
    expect(unhandled).toEqual([]);
    expect(r.cancelled).toEqual([true]);
  });
  it("(b) a thenable object whose then getter throws: model_unavailable, no unhandled rejection", async () => {
    const r = run(() => ({ get then(): unknown { throw new Error(SECRET); } }));
    closed(await r.promise, "model_unavailable");
    await settleTicks();
    expect(unhandled).toEqual([]);
    expect(r.cancelled).toEqual([true]);
  });
  it("(c) a thenable that calls resolve and reject, several times: the first call counts, the rest are ignored", async () => {
    const a = run(() => ({ then(res: (v: unknown) => void, rej: (e: unknown) => void) { res(decision); res({ kind: "execute" }); rej(new Error(SECRET)); } }));
    expect(await a.promise).toEqual({ ok: true, decision });
    const b = run(() => ({ then(res: (v: unknown) => void, rej: (e: unknown) => void) { rej(new Error(SECRET)); rej(new Error(SECRET)); res(decision); } }));
    closed(await b.promise, "model_unavailable");
    const c = run(() => ({ then(res: (v: unknown) => void) { res({ kind: "execute", action: SECRET }); res(decision); } }));
    closed(await c.promise, "invalid_model_output");
    await settleTicks();
    expect(unhandled).toEqual([]);
    for (const r of [a, b, c]) expect(r.cancelled).toEqual([true]);
  });
  it("(c2) a thenable whose then throws after calling back: the callback already decided", async () => {
    const r = run(() => ({ then(res: (v: unknown) => void) { res(decision); throw new Error(SECRET); } }));
    expect(await r.promise).toEqual({ ok: true, decision });
    await settleTicks();
    expect(unhandled).toEqual([]);
  });
  it("(d) a Promise subclass, and a native promise with a replaced then that calls back synchronously: a closed outcome, nothing unhandled, nothing leaked", async () => {
    class Sub<T> extends Promise<T> {}
    const sub = run(() => Sub.resolve(decision));
    expect(await sub.promise).toEqual({ ok: true, decision });
    const rejectingSub = run(() => Sub.reject(new Error(SECRET)));
    closed(await rejectingSub.promise, "model_unavailable");
    const replaced = run(() => { const p = Promise.reject(new Error(SECRET)); (p as unknown as { then: unknown }).then = (res: (v: unknown) => void) => { res(decision); return undefined; }; return p; });
    const outcome = await replaced.promise;
    expect(JSON.stringify(outcome)).not.toContain("SECRET");
    expect(["model_unavailable"].includes((outcome as { reason?: string }).reason ?? "") || (outcome as { ok: boolean }).ok === true).toBe(true);
    await settleTicks();
    expect(unhandled).toEqual([]);
    for (const r of [sub, rejectingSub, replaced]) expect(r.cancelled).toEqual([true]);
  });
  it("(e) a foreign thenable that never settles times out through the deadline, and the cancel handle is released", async () => {
    const r = run(() => ({ then() { /* never calls back */ } }), true);
    closed(await r.promise, "model_unavailable");
    expect(r.cancelled).toEqual([true]);
    const n = run(() => new Promise<never>(() => undefined), true);
    closed(await n.promise, "model_unavailable");
    await settleTicks();
    expect(unhandled).toEqual([]);
  });
  it("a late rejection of a native promise after the deadline is also handled", async () => {
    let reject: (e: unknown) => void = () => undefined;
    const r = run(() => new Promise((_res, rej) => { reject = rej; }), true);
    closed(await r.promise, "model_unavailable");
    reject(new Error(SECRET));
    await settleTicks();
    expect(unhandled).toEqual([]);
  });
});
