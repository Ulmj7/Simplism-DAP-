import { describe, expect, it } from "vitest";
import { callGuidanceModel, createModelCallGuard } from "./call-model.js";
import { MODEL_DEADLINE_MS } from "./limits.js";
import type { GuidanceModel, GuidanceTimers } from "./types.js";

const request = () => ({
  input: {
    query: "How do I change my name?",
    semanticContext: { route: "profile", elements: [{ id: "profile.nameInput", role: "textbox", label: "Name", description: "Your display name", privacy: "public", available: true }] },
    walkthroughSummaries: [{ id: "profileUpdate", title: "Update your profile", description: "Change your name and save" }],
    sources: [],
  },
  maxOutputChars: 1200,
});
const validDecision = { kind: "start_walkthrough", walkthroughId: "profileUpdate" };
const SECRET = "sk-live-SECRETKEY-123";

interface FakeTimer { ms: number; cancelled: boolean; fired: boolean; fire(): void }
function makeTimers() {
  const timers: FakeTimer[] = [];
  const port: GuidanceTimers = {
    set(callback, ms) {
      const timer: FakeTimer = { ms, cancelled: false, fired: false, fire() { if (!timer.cancelled && !timer.fired) { timer.fired = true; callback(); } } };
      timers.push(timer);
      return () => { timer.cancelled = true; };
    },
  };
  return { timers, port };
}
function makeModel(behaviour: () => unknown) {
  const seen: unknown[] = [];
  const model: GuidanceModel = { generate: (req) => { seen.push(req); return behaviour() as Promise<unknown>; } };
  return { model, seen };
}
const flush = async () => { for (let i = 0; i < 5; i++) await Promise.resolve(); };
const run = (behaviour: () => unknown, over: { request?: unknown; timers?: GuidanceTimers; guard?: ReturnType<typeof createModelCallGuard> } = {}) => {
  const { model, seen } = makeModel(behaviour);
  const t = makeTimers();
  const promise = callGuidanceModel({ model, request: over.request ?? request(), timers: over.timers ?? t.port, ...(over.guard ? { guard: over.guard } : {}) });
  return { promise, seen, ...t };
};

describe("success", () => {
  it("a valid decision comes back, after exactly one call, with the deadline armed and released", async () => {
    const r = run(() => Promise.resolve(validDecision));
    expect(await r.promise).toEqual({ ok: true, decision: validDecision });
    expect(r.seen).toHaveLength(1);
    expect(r.timers.map((t) => t.ms)).toEqual([MODEL_DEADLINE_MS]);
    expect(MODEL_DEADLINE_MS).toBe(8000);
    expect(r.timers[0]!.cancelled).toBe(true);
  });
  it("a plain value (not a promise) is accepted the same way", async () => {
    expect(await run(() => validDecision).promise).toEqual({ ok: true, decision: validDecision });
  });
  it("enforces the caller's smaller answer bound as well as the global bound", async () => {
    const req = { ...request(), maxOutputChars: 1 };
    const accepted = run(() => ({ kind: "answer", answer: "x", sources: ["a.1"] }), { request: req });
    expect(await accepted.promise).toMatchObject({ ok: true });
    const refused = run(() => ({ kind: "answer", answer: "xx", sources: ["a.1"] }), { request: req });
    expect(await refused.promise).toEqual({ ok: false, reason: "invalid_model_output" });
    expect(refused.seen).toHaveLength(1);
    expect(refused.timers[0]!.cancelled).toBe(true);
  });
  it("the model receives the validated frozen request, not the caller's object", async () => {
    const original = request();
    const r = run(() => validDecision, { request: original });
    await r.promise;
    expect(r.seen[0]).toEqual(original);
    expect(r.seen[0]).not.toBe(original);
    expect(Object.isFrozen(r.seen[0])).toBe(true);
  });
});

describe("the request is validated before any call", () => {
  it("a bad query is query_invalid, and the model is never called", async () => {
    const r = run(() => validDecision, { request: { ...request(), input: { ...request().input, query: "" } } });
    expect(await r.promise).toEqual({ ok: false, reason: "query_invalid" });
    expect(r.seen).toHaveLength(0);
    expect(r.timers).toHaveLength(0);
  });
  it("a bad context is context_invalid, and the model is never called", async () => {
    const r = run(() => validDecision, { request: { ...request(), extra: true } });
    expect(await r.promise).toEqual({ ok: false, reason: "context_invalid" });
    expect(r.seen).toHaveLength(0);
  });
  it("a validation failure does not use up the call", async () => {
    const guard = createModelCallGuard();
    await run(() => validDecision, { request: 5, guard }).promise;
    expect(await run(() => validDecision, { guard }).promise).toEqual({ ok: true, decision: validDecision });
  });
});

describe("failures map to closed reasons, and nothing from the provider reaches the result", () => {
  const leaks = (value: unknown) => expect(JSON.stringify(value)).not.toContain("SECRET");
  it.each([
    ["an Error whose message looks like a secret", () => Promise.reject(new Error(`401 invalid key ${SECRET}`))],
    ["a rejected string", () => Promise.reject(SECRET)],
    ["a rejected object with a secret", () => Promise.reject({ apiKey: SECRET, stack: `at ${SECRET}` })],
    ["a rejected undefined", () => Promise.reject(undefined)],
    ["an Error with a cause and a stack", () => Promise.reject(new Error("x", { cause: SECRET }))],
    ["a synchronous throw", () => { throw new Error(SECRET); }],
    ["a synchronous throw of a string", () => { throw SECRET; }],
    ["a thenable that throws", () => ({ then() { throw new Error(SECRET); } })],
  ])("%s -> model_unavailable", async (_name, behaviour) => {
    const outcome = await run(behaviour).promise;
    expect(outcome).toEqual({ ok: false, reason: "model_unavailable" });
    leaks(outcome);
  });
  it.each([
    ["undefined", undefined], ["null", null], ["a string", JSON.stringify(validDecision)], ["a wrong kind", { kind: "execute", walkthroughId: "profileUpdate" }],
    ["an extra field", { ...validDecision, confirmed: true, note: SECRET }], ["no kind", { walkthroughId: "profileUpdate" }], ["an oversized answer", { kind: "answer", answer: "a".repeat(5000), sources: [] }],
    ["markup", { kind: "clarify", message: `<script>${SECRET}</script>` }], ["a function", () => SECRET],
    ["a hostile getter", { kind: "clarify", get message(): string { throw new Error(SECRET); } }],
    ["a throwing proxy", new Proxy({}, { ownKeys() { throw new Error(SECRET); } })],
    ["a class instance", new (class D { kind = "clarify"; message = "hello"; })()],
  ])("%s -> invalid_model_output", async (_name, value) => {
    const outcome = await run(() => Promise.resolve(value)).promise;
    expect(outcome).toEqual({ ok: false, reason: "invalid_model_output" });
    leaks(outcome);
  });
  it("a failure outcome has exactly the keys ok and reason", async () => {
    expect(Object.keys(await run(() => Promise.reject(new Error(SECRET))).promise).sort()).toEqual(["ok", "reason"]);
  });
});

describe("the deadline", () => {
  it("a hang times out at 8000 ms with model_unavailable, and the timer is released", async () => {
    const r = run(() => new Promise<never>(() => undefined));
    await flush();
    expect(r.timers).toHaveLength(1);
    r.timers[0]!.fire();
    expect(await r.promise).toEqual({ ok: false, reason: "model_unavailable" });
  });
  it("a late resolution after the deadline is ignored", async () => {
    let resolve: (value: unknown) => void = () => undefined;
    const r = run(() => new Promise((res) => { resolve = res; }));
    r.timers[0]!.fire();
    resolve(validDecision);
    await flush();
    expect(await r.promise).toEqual({ ok: false, reason: "model_unavailable" });
  });
  it("a late rejection after the deadline is handled (no unhandled rejection) and ignored", async () => {
    let reject: (error: unknown) => void = () => undefined;
    const r = run(() => new Promise((_res, rej) => { reject = rej; }));
    r.timers[0]!.fire();
    reject(new Error(SECRET));
    await flush();
    expect(await r.promise).toEqual({ ok: false, reason: "model_unavailable" });
  });
  it("an answer before the deadline wins, and a timer that fires afterwards changes nothing", async () => {
    const r = run(() => Promise.resolve(validDecision));
    const outcome = await r.promise;
    r.timers[0]!.fire(); // already cancelled: a no-op
    expect(outcome).toEqual({ ok: true, decision: validDecision });
  });
  it("a cancel handle that throws does not break the outcome", async () => {
    const timers: GuidanceTimers = { set: () => () => { throw new Error(SECRET); } };
    expect(await run(() => Promise.resolve(validDecision), { timers }).promise).toEqual({ ok: true, decision: validDecision });
  });
});

describe("a failing timer port fails closed and leaves nothing pending", () => {
  it.each([
    ["a timer port that throws", () => { throw new Error(SECRET); }],
    ["a handle that is not a function", () => "cancel"],
    ["undefined instead of a handle", () => undefined],
    ["null", () => null],
  ])("%s -> model_unavailable and the model is never called", async (_name, set) => {
    const r = run(() => Promise.resolve(validDecision), { timers: { set: set as never } });
    const outcome = await r.promise;
    expect(outcome).toEqual({ ok: false, reason: "model_unavailable" });
    expect(r.seen).toHaveLength(0);
    expect(JSON.stringify(outcome)).not.toContain("SECRET");
  });
  it("a timer port that fires immediately (synchronously) wins before the model can answer", async () => {
    let released = 0;
    const timers: GuidanceTimers = { set: (callback) => { callback(); callback(); return () => { released++; }; } };
    const r = run(() => Promise.resolve(validDecision), { timers });
    expect(await r.promise).toEqual({ ok: false, reason: "model_unavailable" });
    expect(r.seen).toHaveLength(0);
    expect(released).toBe(1);
  });
});

describe("exactly one model call", () => {
  it("a second call on the same guard is refused without calling the model or arming a timer", async () => {
    const guard = createModelCallGuard();
    const first = run(() => Promise.resolve(validDecision), { guard });
    expect(await first.promise).toMatchObject({ ok: true });
    const second = run(() => Promise.resolve(validDecision), { guard });
    expect(await second.promise).toEqual({ ok: false, reason: "model_unavailable" });
    expect(second.seen).toHaveLength(0);
    expect(second.timers).toHaveLength(0);
  });
  it("one call never calls the model twice, whatever happens", async () => {
    for (const behaviour of [() => Promise.reject(new Error("x")), () => ({ kind: "bad" }), () => { throw new Error("x"); }, () => Promise.resolve(validDecision)]) {
      const r = run(behaviour);
      await r.promise;
      expect(r.seen).toHaveLength(1);
    }
  });
  it("each call without a shared guard gets its own single call", async () => {
    expect((await run(() => validDecision).promise).ok).toBe(true);
    expect((await run(() => validDecision).promise).ok).toBe(true);
  });
});
