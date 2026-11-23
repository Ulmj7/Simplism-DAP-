import { describe, expect, it, vi } from "vitest";
import { createWalkthroughCatalog } from "../walkthrough/catalog.js";
import { defineWalkthrough } from "../walkthrough/definition.js";
import { makeRegistry } from "./test-support.js";
import { transition } from "./machine.js";
import type { EngineState, Input } from "./machine.js";

const m1 = defineWalkthrough({
  id: "m1", title: "M1", description: "Guide steps", start: "g",
  steps: [
    { id: "g", kind: "guide", target: "profile.saveButton", text: "Press Save.", wait: "click", verify: "check", next: "d", recover: "r", maxAttempts: 2 },
    { id: "r", kind: "guide", target: "profile.nameInput", text: "Fix it.", wait: "input", next: "g" },
    { id: "d", kind: "complete", text: "Done." },
  ],
});
const m2 = defineWalkthrough({
  id: "m2", title: "M2", description: "Navigation steps", start: "n",
  steps: [
    { id: "n", kind: "navigate", route: "settings", next: "u" },
    { id: "u", kind: "navigate", route: "profile", text: "Open the profile.", next: "d" },
    { id: "d", kind: "complete", text: "Done." },
  ],
});
const catalog = createWalkthroughCatalog(makeRegistry(), ["check"], [m1, m2]);
const go = (state: EngineState, input: Input) => transition(catalog, state, input);

const at = (status: "RESOLVING" | "PRESENTING" | "WAITING" | "VERIFYING", walkthroughId: string, stepId: string, attempts: Record<string, number> = { [stepId]: 1 }): EngineState => ({ status, walkthroughId, stepId, attempts });
const STATES: Record<string, EngineState> = {
  IDLE: { status: "IDLE" },
  "g:RESOLVING": at("RESOLVING", "m1", "g"), "g:PRESENTING": at("PRESENTING", "m1", "g"), "g:WAITING": at("WAITING", "m1", "g"), "g:VERIFYING": at("VERIFYING", "m1", "g"),
  "n:RESOLVING": at("RESOLVING", "m2", "n"), "n:VERIFYING": at("VERIFYING", "m2", "n"),
  "u:PRESENTING": at("PRESENTING", "m2", "u"), "u:WAITING": at("WAITING", "m2", "u"), "u:VERIFYING": at("VERIFYING", "m2", "u"),
  COMPLETED: { status: "COMPLETED", walkthroughId: "m1", stepId: "d" },
  FAILED: { status: "FAILED", walkthroughId: "m1", stepId: "g", reason: "verification_failed" },
  CANCELLED: { status: "CANCELLED", walkthroughId: "m1" },
};
const click = (id: string): Input => ({ type: "event", event: { type: "click", id } });
const INPUTS: Record<string, Input> = {
  "start:m1": { type: "start", id: "m1" }, "start:m2": { type: "start", id: "m2" }, "start:unknown": { type: "start", id: "nope" },
  targetFound: { type: "targetFound" }, targetWaitExpired: { type: "targetWaitExpired" }, presented: { type: "presented" }, presentFailed: { type: "presentFailed" },
  "click:match": click("profile.saveButton"), "click:other": click("profile.cancelButton"),
  "input:true": { type: "event", event: { type: "input", id: "profile.saveButton", nonEmpty: true } },
  ack: { type: "event", event: { type: "ack" } },
  "route:profile": { type: "event", event: { type: "routeChanged", route: "profile" } }, "route:settings": { type: "event", event: { type: "routeChanged", route: "settings" } },
  "available:save": { type: "event", event: { type: "targetAvailable", id: "profile.saveButton" } }, "available:other": { type: "event", event: { type: "targetAvailable", id: "profile.nameInput" } },
  "gone:save": { type: "event", event: { type: "targetGone", id: "profile.saveButton" } }, "gone:other": { type: "event", event: { type: "targetGone", id: "profile.nameInput" } },
  navigated: { type: "navigated" }, navigationRefused: { type: "navigationRefused" },
  "verified:true": { type: "verified", ok: true }, "verified:false": { type: "verified", ok: false }, verifyFailed: { type: "verifyFailed" },
  internalError: { type: "internalError" }, cancel: { type: "cancel" },
};

interface Expect { readonly status: string; readonly stepId?: string; readonly reason?: string; readonly effects: readonly string[]; readonly refusal?: string; readonly attempt?: number }
const E = (status: string, effects: string[], extra: Partial<Expect> = {}): Expect => ({ status, effects, ...extra });
const TABLE = new Map<string, Expect>();
const set = (state: string, input: string, expected: Expect) => TABLE.set(`${state}|${input}`, expected);

// --- every allowed transition (plan 4.4) ---------------------------------------------------------------------------------------------------------------
set("IDLE", "start:m1", E("RESOLVING", ["startTimer", "resolveTarget"], { stepId: "g", attempt: 1 }));
set("IDLE", "start:m2", E("RESOLVING", ["navigate"], { stepId: "n", attempt: 1 }));
for (const terminal of ["COMPLETED", "FAILED", "CANCELLED"]) {
  set(terminal, "start:m1", E("RESOLVING", ["clear", "startTimer", "resolveTarget"], { stepId: "g", attempt: 1 }));
  set(terminal, "start:m2", E("RESOLVING", ["clear", "navigate"], { stepId: "n", attempt: 1 }));
}
for (const state of ["IDLE", "COMPLETED", "FAILED", "CANCELLED"]) set(state, "start:unknown", E(STATES[state]!.status, [], { refusal: "unknown_walkthrough" }));
for (const state of Object.keys(STATES).filter((s) => !["IDLE", "COMPLETED", "FAILED", "CANCELLED"].includes(s))) {
  for (const input of ["start:m1", "start:m2", "start:unknown"]) set(state, input, E(STATES[state]!.status, [], { refusal: "busy" }));
  set(state, "internalError", E("FAILED", ["cancelTimer", "cancelTimer", "clear"], { reason: "internal_error" }));
  set(state, "cancel", E("CANCELLED", ["cancelTimer", "cancelTimer", "clear"]));
}
set("g:RESOLVING", "targetFound", E("PRESENTING", ["cancelTimer", "present"], { stepId: "g" }));
set("g:RESOLVING", "available:save", E("PRESENTING", ["cancelTimer", "present"], { stepId: "g" }));
set("g:RESOLVING", "targetWaitExpired", E("RESOLVING", ["cancelTimer", "startTimer", "resolveTarget"], { stepId: "r", attempt: 1 })); // the recover step
set("g:PRESENTING", "presented", E("WAITING", [], { stepId: "g" }));
set("g:PRESENTING", "presentFailed", E("FAILED", ["clear"], { reason: "present_failed" }));
set("g:WAITING", "click:match", E("VERIFYING", ["verify"], { stepId: "g" }));
set("g:WAITING", "gone:save", E("RESOLVING", ["clear", "startTimer", "resolveTarget"], { stepId: "g", attempt: 2 }));
set("g:VERIFYING", "verified:true", E("COMPLETED", ["cancelTimer", "clear", "present"], { stepId: "d" }));
set("g:VERIFYING", "verified:false", E("RESOLVING", ["cancelTimer", "clear", "startTimer", "resolveTarget"], { stepId: "r", attempt: 1 }));
set("g:VERIFYING", "verifyFailed", E("RESOLVING", ["cancelTimer", "clear", "startTimer", "resolveTarget"], { stepId: "r", attempt: 1 }));
set("n:RESOLVING", "navigated", E("VERIFYING", ["verifyRoute"], { stepId: "n" }));
set("n:RESOLVING", "navigationRefused", E("FAILED", ["clear"], { reason: "navigation_refused" }));
set("n:VERIFYING", "verified:true", E("PRESENTING", ["cancelTimer", "clear", "present"], { stepId: "u", attempt: 1 }));
set("n:VERIFYING", "verified:false", E("FAILED", ["cancelTimer", "clear", "clear"], { reason: "verification_failed" }));
set("n:VERIFYING", "verifyFailed", E("FAILED", ["cancelTimer", "clear", "clear"], { reason: "verification_failed" }));
set("u:PRESENTING", "presented", E("WAITING", [], { stepId: "u" }));
set("u:PRESENTING", "presentFailed", E("FAILED", ["clear"], { reason: "present_failed" }));
set("u:WAITING", "route:profile", E("VERIFYING", ["verifyRoute"], { stepId: "u" }));
set("u:VERIFYING", "verified:true", E("COMPLETED", ["cancelTimer", "clear", "present"], { stepId: "d" }));
set("u:VERIFYING", "verified:false", E("FAILED", ["cancelTimer", "clear", "clear"], { reason: "verification_failed" }));
set("u:VERIFYING", "verifyFailed", E("FAILED", ["cancelTimer", "clear", "clear"], { reason: "verification_failed" }));

const attemptOf = (state: EngineState, stepId: string | undefined): number | undefined => ("attempts" in state && stepId !== undefined ? state.attempts[stepId] : undefined);

describe("every (state, input) pair of the transition table", () => {
  for (const [stateName, state] of Object.entries(STATES)) {
    for (const [inputName, input] of Object.entries(INPUTS)) {
      const expected = TABLE.get(`${stateName}|${inputName}`);
      it(`${stateName} + ${inputName} ${expected === undefined ? "is a no-op" : `-> ${expected.status}${expected.refusal ? ` (refused: ${expected.refusal})` : ""}`}`, () => {
        const out = go(state, input);
        if (expected === undefined) {
          expect(out.state).toBe(state); // the very same state object: nothing changed
          expect(out.effects).toEqual([]);
          expect(out.refusal).toBeUndefined();
          return;
        }
        expect(out.state.status).toBe(expected.status);
        expect(out.effects.map((e) => e.type)).toEqual(expected.effects);
        expect(out.refusal).toBe(expected.refusal);
        if (expected.refusal !== undefined) expect(out.state).toBe(state);
        if (expected.stepId !== undefined) expect((out.state as { stepId?: string }).stepId).toBe(expected.stepId);
        if (expected.reason !== undefined) expect((out.state as { reason?: string }).reason).toBe(expected.reason);
        if (expected.attempt !== undefined) expect(attemptOf(out.state, expected.stepId)).toBe(expected.attempt);
      });
    }
  }
});

describe("rules the table relies on", () => {
  it("only an exactly matching event leaves WAITING: wrong id, wrong type, an input on a click step and an unknown event do nothing", () => {
    const waiting = STATES["g:WAITING"]!;
    for (const name of ["click:other", "input:true", "ack", "route:profile", "available:save", "available:other", "gone:other"]) expect(go(waiting, INPUTS[name]!).state, name).toBe(waiting);
    expect(go(waiting, INPUTS["click:match"]!).state).not.toBe(waiting);
  });
  it("an input wait advances only on nonEmpty true", () => {
    const def = defineWalkthrough({ id: "iw", title: "I", description: "Input wait", start: "i", steps: [{ id: "i", kind: "guide", target: "profile.nameInput", text: "Type.", wait: "input", next: "d" }, { id: "d", kind: "complete", text: "Done." }] });
    const c = createWalkthroughCatalog(makeRegistry(), [], [def]);
    const waiting = at("WAITING", "iw", "i");
    const ev = (nonEmpty: boolean): Input => ({ type: "event", event: { type: "input", id: "profile.nameInput", nonEmpty } });
    expect(transition(c, waiting, ev(false)).state).toBe(waiting);
    expect(transition(c, waiting, ev(true)).state.status).toBe("COMPLETED"); // no verify: advances straight to the complete step
    expect(transition(c, waiting, { type: "event", event: { type: "click", id: "profile.nameInput" } }).state).toBe(waiting);
  });
  it("an ack wait advances on ack only", () => {
    const def = defineWalkthrough({ id: "aw", title: "A", description: "Ack wait", start: "a", steps: [{ id: "a", kind: "guide", target: "settings.securityPanel", text: "Read.", wait: "ack", next: "d" }, { id: "d", kind: "complete", text: "Done." }] });
    const c = createWalkthroughCatalog(makeRegistry(), [], [def]);
    const waiting = at("WAITING", "aw", "a");
    expect(transition(c, waiting, { type: "event", event: { type: "click", id: "settings.securityPanel" } }).state).toBe(waiting);
    expect(transition(c, waiting, { type: "event", event: { type: "ack" } }).state.status).toBe("COMPLETED");
  });
  it("max attempts: entering a step more often than allowed fails the run with max_attempts", () => {
    // g allows 2 entries; re-resolving after targetGone is an entry.
    const third = go(at("WAITING", "m1", "g", { g: 2 }), INPUTS["gone:save"]!);
    expect(third.state).toMatchObject({ status: "FAILED", reason: "max_attempts", stepId: "g" });
    // r (default 3) is entered as the recovery of g
    const recover = go(at("RESOLVING", "m1", "g", { g: 1, r: 3 }), INPUTS.targetWaitExpired!);
    expect(recover.state).toMatchObject({ status: "FAILED", reason: "max_attempts", stepId: "r" });
    expect(recover.effects.map((e) => e.type)).toEqual(["cancelTimer", "clear"]);
  });
  it("a failure with no recover step fails with the matching reason", () => {
    const def = defineWalkthrough({ id: "nr", title: "N", description: "No recover", start: "s", steps: [{ id: "s", kind: "guide", target: "profile.saveButton", text: "Press.", wait: "click", verify: "check", next: "d" }, { id: "d", kind: "complete", text: "Done." }] });
    const c = createWalkthroughCatalog(makeRegistry(), ["check"], [def]);
    expect(transition(c, at("RESOLVING", "nr", "s"), INPUTS.targetWaitExpired!).state).toMatchObject({ status: "FAILED", reason: "target_unavailable" });
    expect(transition(c, at("VERIFYING", "nr", "s"), INPUTS["verified:false"]!).state).toMatchObject({ status: "FAILED", reason: "verification_failed" });
  });
  it("verified accepts only the boolean true (a lookalike object is a failure)", () => {
    expect(go(STATES["g:VERIFYING"]!, { type: "verified", ok: "true" as never }).state.status).toBe("RESOLVING"); // recovery, not advance
    expect(go(STATES["g:VERIFYING"]!, { type: "verified", ok: 1 as never }).state.status).toBe("RESOLVING");
  });
  it("is pure: the same input gives the same output, nothing is mutated, and no clock or randomness is read", () => {
    const deepFreeze = <T,>(value: T): T => { if (value && typeof value === "object") { for (const child of Object.values(value)) deepFreeze(child); Object.freeze(value); } return value; };
    const dateNow = vi.spyOn(Date, "now").mockImplementation(() => { throw new Error("clock"); });
    const random = vi.spyOn(Math, "random").mockImplementation(() => { throw new Error("random"); });
    try {
      for (const state of Object.values(STATES)) for (const input of Object.values(INPUTS)) {
        const frozenState = deepFreeze(structuredClone(state));
        const frozenInput = deepFreeze(structuredClone(input));
        const first = transition(catalog, frozenState, frozenInput);
        const second = transition(catalog, frozenState, frozenInput);
        expect(first).toEqual(second);
        expect(state).toEqual(structuredClone(state));
      }
    } finally { dateNow.mockRestore(); random.mockRestore(); }
  });
  it("no pair ever yields an internal_error by accident: only the internalError input does", () => {
    for (const [stateName, state] of Object.entries(STATES)) for (const [inputName, input] of Object.entries(INPUTS)) {
      const out = go(state, input).state;
      if (out.status === "FAILED" && out.reason === "internal_error" && state.status !== "FAILED") expect(inputName, stateName).toBe("internalError");
    }
  });
  it("effects are plain frozen data with only known keys, and no presentation detail", () => {
    const KNOWN = new Set(["type", "id", "route", "postcondition", "key", "ms", "stepId", "target", "text", "expects"]);
    const FORBIDDEN = /selector|style|color|class|css|^x$|^y$|width|height|top|left|element|node|component|html/i;
    for (const state of Object.values(STATES)) for (const input of Object.values(INPUTS)) {
      for (const effect of go(state, input).effects) {
        expect(Object.isFrozen(effect)).toBe(true);
        for (const key of Object.keys(effect)) { expect(KNOWN.has(key), key).toBe(true); expect(FORBIDDEN.test(key), key).toBe(false); }
        if (effect.type === "present") expect(["click", "input", "ack", "route"]).toContain(effect.expects);
      }
    }
  });
  it("a present effect for a guide step names its target; for a user-driven navigation it names none", () => {
    expect(go(STATES["g:RESOLVING"]!, INPUTS.targetFound!).effects[1]).toEqual({ type: "present", stepId: "g", target: "profile.saveButton", text: "Press Save.", expects: "click" });
    expect(go(STATES["n:VERIFYING"]!, INPUTS["verified:true"]!).effects[2]).toEqual({ type: "present", stepId: "u", text: "Open the profile.", expects: "route" });
    expect(go(STATES["g:VERIFYING"]!, INPUTS["verified:true"]!).effects[2]).toEqual({ type: "present", stepId: "d", text: "Done.", expects: "ack" });
  });
});
