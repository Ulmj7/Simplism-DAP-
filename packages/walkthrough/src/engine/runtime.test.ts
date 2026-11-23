import { describe, expect, it } from "vitest";
import { createSemanticRegistry } from "../semantic/registry.js";
import { createWalkthroughCatalog } from "../walkthrough/catalog.js";
import { defineWalkthrough } from "../walkthrough/definition.js";
import { ELEMENTS, ROUTES, click, input, makeHarness, walkthroughN } from "./test-support.js";
import type { Harness } from "./test-support.js";
import { createWalkthroughRuntime } from "./runtime.js";

const status = (h: Harness) => h.runtime.getState().status;
const step = (h: Harness) => h.runtime.getState().stepId;
const presented = (h: Harness) => h.effects.filter((e) => e.type === "present");
const lastPresent = (h: Harness) => presented(h).at(-1);
const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

describe("walkthrough A (navigate -> input -> click + verify, with failed-save recovery)", () => {
  it("runs from start to complete with fake ports", () => {
    const h = makeHarness();
    expect(h.runtime.startWalkthrough("profileUpdate")).toEqual({ ok: true });
    expect(h.navigations).toEqual(["profile"]); // the runtime navigated, then verified the route
    expect(status(h)).toBe("WAITING");
    expect(step(h)).toBe("a2");
    expect(lastPresent(h)).toEqual({ type: "present", stepId: "a2", target: "profile.nameInput", text: "Type your name.", expects: "input" });
    h.runtime.dispatch(input("profile.nameInput", true));
    expect(step(h)).toBe("a3");
    expect(lastPresent(h)).toMatchObject({ stepId: "a3", target: "profile.saveButton", expects: "click" });
    h.runtime.dispatch(click("profile.saveButton"));
    expect(h.runtime.getState()).toMatchObject({ status: "COMPLETED", stepId: "adone", stepKind: "complete" });
    expect(lastPresent(h)).toEqual({ type: "present", stepId: "adone", text: "Your profile is saved.", expects: "ack" });
  });
  it("a failed save goes to the recovery step, then retries and succeeds", async () => {
    const h = makeHarness();
    h.runtime.startWalkthrough("profileUpdate");
    h.runtime.dispatch(input("profile.nameInput", true));
    h.answers.profileSaved = () => false;
    h.runtime.dispatch(click("profile.saveButton"));
    expect(step(h)).toBe("a4");
    expect(status(h)).toBe("WAITING");
    expect(lastPresent(h)).toMatchObject({ stepId: "a4", text: "Fix your name and try again." });
    h.answers.profileSaved = () => true;
    h.runtime.dispatch(input("profile.nameInput", true));
    expect(step(h)).toBe("a3");
    expect(h.runtime.getState().attempt).toBe(2); // the save step was entered a second time
    h.runtime.dispatch(click("profile.saveButton"));
    expect(status(h)).toBe("COMPLETED");
  });
});

describe("walkthrough B (click + route verify -> ack -> complete)", () => {
  it("runs from start to complete", () => {
    const h = makeHarness();
    h.runtime.startWalkthrough("findSecurity");
    expect(lastPresent(h)).toMatchObject({ stepId: "b1", target: "nav.settings", expects: "click" });
    h.world.route = "settings"; // the app navigated because the user clicked the link
    h.runtime.dispatch(click("nav.settings"));
    expect(step(h)).toBe("b2");
    expect(lastPresent(h)).toMatchObject({ target: "settings.securityPanel", expects: "ack" });
    h.runtime.dispatch({ type: "ack" });
    expect(status(h)).toBe("COMPLETED");
  });
  it("a click whose route check fails does not advance (no recovery defined: the run fails)", () => {
    const h = makeHarness();
    h.runtime.startWalkthrough("findSecurity");
    h.answers.onSettings = () => h.world.route === "settings";
    h.runtime.dispatch(click("nav.settings")); // still on the dashboard
    expect(h.runtime.getState()).toMatchObject({ status: "FAILED", failure: "verification_failed", stepId: "b1" });
  });
});

describe("walkthrough C (target missing -> recover to a prerequisite -> retry -> ack -> complete)", () => {
  it("recovers through the prerequisite and finishes", () => {
    const h = makeHarness();
    h.available.delete("settings.twoFactorSetup");
    h.runtime.startWalkthrough("findTwoFactor");
    expect(status(h)).toBe("RESOLVING");
    expect(h.effects).toEqual([]); // nothing is shown while the target is missing
    expect(h.pending().map((t) => t.ms)).toEqual([500]); // the step's own targetWaitMs
    h.pending()[0]!.fire(); // the wait ran out
    expect(step(h)).toBe("c2");
    expect(lastPresent(h)).toMatchObject({ stepId: "c2", target: "settings.advancedToggle" });
    h.runtime.dispatch(click("settings.advancedToggle")); // opens the advanced area
    expect(step(h)).toBe("c1");
    expect(status(h)).toBe("RESOLVING"); // still missing
    h.available.add("settings.twoFactorSetup");
    h.runtime.dispatch({ type: "targetAvailable", id: "settings.twoFactorSetup" });
    expect(status(h)).toBe("WAITING");
    expect(lastPresent(h)).toMatchObject({ stepId: "c1", target: "settings.twoFactorSetup" });
    h.runtime.dispatch(click("settings.twoFactorSetup"));
    expect(step(h)).toBe("c3");
    h.runtime.dispatch({ type: "ack" });
    expect(status(h)).toBe("COMPLETED");
  });
  it("a target that appears within the wait proceeds, and the wait timer is cancelled", () => {
    const h = makeHarness();
    h.available.delete("settings.twoFactorSetup");
    h.runtime.startWalkthrough("findTwoFactor");
    h.runtime.dispatch({ type: "targetAvailable", id: "settings.twoFactorSetup" });
    expect(status(h)).toBe("WAITING");
    expect(h.pending()).toEqual([]);
  });
  it("a target that disappears while waiting is resolved again (the same step, a new attempt)", () => {
    const h = makeHarness();
    h.runtime.startWalkthrough("findTwoFactor");
    expect(status(h)).toBe("WAITING");
    h.available.delete("settings.twoFactorSetup");
    h.runtime.dispatch({ type: "targetGone", id: "settings.twoFactorSetup" });
    expect(step(h)).toBe("c1");
    expect(status(h)).toBe("RESOLVING");
    expect(h.runtime.getState().attempt).toBe(2);
    expect(h.effects.at(-1)).toEqual({ type: "clear" });
  });
  it("without a recover step a missing target fails with target_unavailable", () => {
    const h = makeHarness();
    h.available.delete("profile.saveButton");
    h.runtime.startWalkthrough("verifyOnly");
    h.pending()[0]!.fire();
    expect(h.runtime.getState()).toMatchObject({ status: "FAILED", failure: "target_unavailable" });
  });
});

describe("events", () => {
  it("a click on another registered element, an input on a click step and an unknown event do not advance", () => {
    const h = makeHarness();
    h.runtime.startWalkthrough("verifyOnly");
    const before = h.runtime.getState();
    for (const event of [click("profile.cancelButton"), input("profile.saveButton", true), { type: "ack" }, { type: "routeChanged", route: "settings" }, { type: "click", id: "profile.ghost" }, { type: "boom" }, null, "click", { type: "click", id: "profile.saveButton", extra: 1 }]) {
      h.runtime.dispatch(event);
      expect(h.runtime.getState()).toEqual(before);
    }
    h.runtime.dispatch(click("profile.saveButton"));
    expect(status(h)).toBe("COMPLETED");
  });
  it("an input event with nonEmpty false does not advance an input wait", () => {
    const h = makeHarness();
    h.runtime.startWalkthrough("profileUpdate");
    h.runtime.dispatch(input("profile.nameInput", false));
    expect(step(h)).toBe("a2");
    h.runtime.dispatch(input("profile.nameInput", true));
    expect(step(h)).toBe("a3");
  });
  it("one event is consumed by exactly one step: two consecutive click steps need two clicks", () => {
    const def = defineWalkthrough({ id: "twoClicks", title: "T", description: "Two clicks", start: "t1", steps: [
      { id: "t1", kind: "guide", target: "profile.saveButton", text: "Click.", wait: "click", next: "t2" },
      { id: "t2", kind: "guide", target: "profile.saveButton", text: "Click again.", wait: "click", next: "td" },
      { id: "td", kind: "complete", text: "Done." }] });
    const h = makeHarness({ definitions: [def] });
    h.runtime.startWalkthrough("twoClicks");
    h.runtime.dispatch(click("profile.saveButton"));
    expect(step(h)).toBe("t2");
    expect(status(h)).toBe("WAITING");
    h.runtime.dispatch(click("profile.saveButton"));
    expect(status(h)).toBe("COMPLETED");
  });
  it("events while verifying are ignored", async () => {
    const h = makeHarness();
    h.runtime.startWalkthrough("verifyOnly");
    let settle: (value: boolean) => void = () => undefined;
    h.answers.check = () => new Promise<boolean>((resolve) => { settle = resolve; });
    h.runtime.dispatch(click("profile.saveButton"));
    expect(status(h)).toBe("VERIFYING");
    const before = h.runtime.getState();
    h.runtime.dispatch(click("profile.saveButton"));
    h.runtime.dispatch({ type: "ack" });
    h.runtime.dispatch({ type: "targetGone", id: "profile.saveButton" });
    expect(h.runtime.getState()).toEqual(before);
    settle(true);
    await flush();
    expect(status(h)).toBe("COMPLETED");
  });
  it("a valid event with no run in progress changes nothing", () => {
    const h = makeHarness();
    h.runtime.dispatch(click("profile.saveButton"));
    expect(status(h)).toBe("IDLE");
  });
});

describe("postconditions", () => {
  const verifyOutcome = async (answer: () => unknown, h = makeHarness()) => {
    h.runtime.startWalkthrough("verifyOnly");
    h.answers.check = answer;
    h.runtime.dispatch(click("profile.saveButton"));
    await flush();
    return h.runtime.getState();
  };
  it("exactly true advances (sync and async)", async () => {
    expect((await verifyOutcome(() => true)).status).toBe("COMPLETED");
    expect((await verifyOutcome(() => Promise.resolve(true))).status).toBe("COMPLETED");
  });
  it.each([
    ["false", () => false], ["a truthy number", () => 1], ["the string true", () => "true"], ["undefined", () => undefined], ["null", () => null], ["an object", () => ({})],
    ["a throw", () => { throw new Error("boom"); }], ["a rejection", () => Promise.reject(new Error("boom"))], ["a promise of false", () => Promise.resolve(false)], ["a promise of a truthy non-boolean", () => Promise.resolve("true")],
  ])("%s does not advance (the run fails with verification_failed when there is no recovery)", async (_name, answer) => {
    expect(await verifyOutcome(answer as () => unknown)).toMatchObject({ status: "FAILED", failure: "verification_failed", stepId: "v1" });
  });
  it("a hung postcondition times out through the timer port (default 2000 ms) and does not advance", async () => {
    const h = makeHarness();
    h.runtime.startWalkthrough("verifyOnly");
    h.answers.check = () => new Promise<boolean>(() => undefined);
    h.runtime.dispatch(click("profile.saveButton"));
    expect(status(h)).toBe("VERIFYING");
    const timer = h.pending().find((t) => t.ms === 2000)!;
    expect(timer).toBeDefined();
    timer.fire();
    expect(h.runtime.getState()).toMatchObject({ status: "FAILED", failure: "verification_failed" });
  });
  it("a late answer after the timeout, or after a cancel, is ignored", async () => {
    const h = makeHarness();
    h.runtime.startWalkthrough("verifyOnly");
    let settle: (value: boolean) => void = () => undefined;
    h.answers.check = () => new Promise<boolean>((resolve) => { settle = resolve; });
    h.runtime.dispatch(click("profile.saveButton"));
    h.pending().find((t) => t.ms === 2000)!.fire();
    settle(true);
    await flush();
    expect(h.runtime.getState()).toMatchObject({ status: "FAILED", failure: "verification_failed" });
    const h2 = makeHarness();
    h2.runtime.startWalkthrough("verifyOnly");
    h2.answers.check = () => new Promise<boolean>((resolve) => { settle = resolve; });
    h2.runtime.dispatch(click("profile.saveButton"));
    h2.runtime.cancel();
    settle(true);
    await flush();
    expect(status(h2)).toBe("CANCELLED");
  });
  it("a late answer from a finished run cannot advance a new run", async () => {
    const h = makeHarness();
    h.runtime.startWalkthrough("verifyOnly");
    let settle: (value: boolean) => void = () => undefined;
    h.answers.check = () => new Promise<boolean>((resolve) => { settle = resolve; });
    h.runtime.dispatch(click("profile.saveButton"));
    h.runtime.cancel();
    h.answers.check = () => new Promise<boolean>(() => undefined);
    h.runtime.startWalkthrough("verifyOnly");
    h.runtime.dispatch(click("profile.saveButton"));
    expect(status(h)).toBe("VERIFYING");
    settle(true); // the OLD verification answers
    await flush();
    expect(status(h)).toBe("VERIFYING");
  });
  it("a failed postcondition with a recovery step recovers; the verification timeout is configurable", async () => {
    const h = makeHarness({ overrides: { verifyTimeoutMs: 50 } });
    h.runtime.startWalkthrough("verifyRecover");
    h.answers.check = () => new Promise<boolean>(() => undefined);
    h.runtime.dispatch(click("profile.saveButton"));
    h.pending().find((t) => t.ms === 50)!.fire();
    expect(step(h)).toBe("r2");
    expect(status(h)).toBe("WAITING");
  });
});

describe("recovery and attempts", () => {
  it("maxAttempts ends an endless recovery loop with max_attempts", () => {
    const h = makeHarness();
    h.answers.check = () => false;
    h.runtime.startWalkthrough("loopForever");
    const seen: (string | null)[] = [];
    for (let round = 0; round < 10 && status(h) === "WAITING"; round++) {
      seen.push(step(h));
      h.runtime.dispatch(step(h) === "l1" ? click("profile.saveButton") : { type: "ack" });
    }
    expect(seen).toEqual(["l1", "l2", "l1", "l2"]);
    expect(h.runtime.getState()).toMatchObject({ status: "FAILED", failure: "max_attempts", stepId: "l1" });
  });
  it("a failure with no recover step is FAILED with the right reason", () => {
    const h = makeHarness();
    h.answers.check = () => false;
    h.runtime.startWalkthrough("verifyOnly");
    h.runtime.dispatch(click("profile.saveButton"));
    expect(h.runtime.getState().failure).toBe("verification_failed");
  });
});

describe("navigation", () => {
  it("an allowed route is navigated, verified and advanced", () => {
    const h = makeHarness();
    h.runtime.startWalkthrough("goSettings");
    expect(h.navigations).toEqual(["settings"]);
    expect(status(h)).toBe("COMPLETED");
  });
  it("a route outside the registry's routes is refused, and router.navigate is never called", () => {
    const narrow = createSemanticRegistry({ routes: ["dashboard", "profile"], elements: ELEMENTS.filter((e) => e.route !== "settings") });
    const h = makeHarness();
    const catalog = createWalkthroughCatalog(createSemanticRegistry({ routes: ROUTES, elements: ELEMENTS }), [], [walkthroughN]);
    const runtime = createWalkthroughRuntime({ ...h.options, registry: narrow, catalog });
    expect(runtime.startWalkthrough("goSettings")).toEqual({ ok: true });
    expect(runtime.getState()).toMatchObject({ status: "FAILED", failure: "navigation_refused" });
    expect(h.navigations).toEqual([]);
  });
  it("a router that throws on navigate is navigation_refused; one that does not arrive fails verification", () => {
    const h = makeHarness();
    h.ports.router.navigate = () => { throw new Error("boom"); };
    const throwing = createWalkthroughRuntime({ ...h.options, router: { current: () => "dashboard", navigate: () => { throw new Error("boom"); } } });
    throwing.startWalkthrough("goSettings");
    expect(throwing.getState().failure).toBe("navigation_refused");
    const stuck = createWalkthroughRuntime({ ...h.options, router: { current: () => "dashboard", navigate: () => undefined } });
    stuck.startWalkthrough("goSettings");
    expect(stuck.getState().failure).toBe("verification_failed");
  });
  it("a user-driven route change satisfies a route wait; any other route does not", () => {
    const h = makeHarness();
    h.runtime.startWalkthrough("userGoesSettings");
    expect(lastPresent(h)).toEqual({ type: "present", stepId: "u1", text: "Open the settings page.", expects: "route" });
    expect(h.navigations).toEqual([]); // the runtime did not navigate: the user does
    h.runtime.dispatch({ type: "routeChanged", route: "profile" });
    expect(status(h)).toBe("WAITING");
    h.world.route = "settings";
    h.runtime.dispatch({ type: "routeChanged", route: "settings" });
    expect(status(h)).toBe("COMPLETED");
  });
  it("a routeChanged event the router contradicts fails the implicit route check", () => {
    const h = makeHarness();
    h.runtime.startWalkthrough("userGoesSettings");
    h.runtime.dispatch({ type: "routeChanged", route: "settings" }); // the router still says dashboard
    expect(h.runtime.getState().failure).toBe("verification_failed");
  });
});

describe("the public API", () => {
  it("returns typed refusals for unknown, busy and invalid ids, and never throws", () => {
    const h = makeHarness();
    expect(h.runtime.startWalkthrough("nope")).toEqual({ ok: false, reason: "unknown_walkthrough" });
    for (const id of ["", "bad id", "__proto__", "constructor", undefined, null, 5, {}, "x".repeat(100)]) expect(h.runtime.startWalkthrough(id as never)).toEqual({ ok: false, reason: "invalid_id" });
    expect(h.runtime.startWalkthrough("profileUpdate")).toEqual({ ok: true });
    expect(h.runtime.startWalkthrough("findSecurity")).toEqual({ ok: false, reason: "busy" });
    expect(h.runtime.startWalkthrough("nope")).toEqual({ ok: false, reason: "busy" });
    expect(step(h)).toBe("a2"); // the refused starts changed nothing
  });
  it("cancel clears the presentation, ends the run, and a new run can start", () => {
    const h = makeHarness();
    h.runtime.startWalkthrough("profileUpdate");
    h.runtime.cancel();
    expect(status(h)).toBe("CANCELLED");
    expect(h.effects.at(-1)).toEqual({ type: "clear" });
    expect(h.pending()).toEqual([]);
    h.runtime.dispatch(input("profile.nameInput", true)); // absorbed
    expect(status(h)).toBe("CANCELLED");
    expect(h.runtime.startWalkthrough("findSecurity")).toEqual({ ok: true });
    expect(step(h)).toBe("b1");
    h.runtime.cancel(); h.runtime.cancel(); // cancelling twice is harmless
    expect(status(h)).toBe("CANCELLED");
  });
  it("a finished run can be followed by a new one (terminal states accept start)", () => {
    const h = makeHarness();
    h.runtime.startWalkthrough("goSettings");
    expect(status(h)).toBe("COMPLETED");
    expect(h.runtime.startWalkthrough("findSecurity")).toEqual({ ok: true });
    expect(h.effects.some((e) => e.type === "clear")).toBe(true); // the completion message is cleared first
  });
  it("notifies subscribers once per state change, never for a no-op, and not after unsubscribe", () => {
    const h = makeHarness();
    const seen: string[] = [];
    const off = h.runtime.subscribe((s) => seen.push(`${s.status}:${s.stepId}`));
    h.runtime.startWalkthrough("verifyOnly");
    expect(seen).toEqual(["RESOLVING:v1", "PRESENTING:v1", "WAITING:v1"]);
    h.runtime.dispatch(click("profile.cancelButton")); // a no-op
    h.runtime.dispatch({ type: "nonsense" });
    expect(seen).toHaveLength(3);
    h.runtime.dispatch(click("profile.saveButton"));
    expect(seen.slice(3)).toEqual(["VERIFYING:v1", "COMPLETED:vdone"]);
    off();
    h.runtime.cancel();
    h.runtime.startWalkthrough("verifyOnly");
    expect(seen).toHaveLength(5);
  });
  it("a throwing subscriber does not disturb the run or the other subscribers", () => {
    const h = makeHarness();
    let calls = 0;
    h.runtime.subscribe(() => { throw new Error("listener"); });
    h.runtime.subscribe(() => { calls++; });
    h.runtime.startWalkthrough("verifyOnly");
    expect(calls).toBe(3);
    expect(status(h)).toBe("WAITING");
  });
  it("exposes exactly the documented members and nothing else", () => {
    const { runtime } = makeHarness();
    expect(Object.keys(runtime).sort()).toEqual(["cancel", "catalog", "context", "dispatch", "getState", "startWalkthrough", "subscribe"]);
    expect(Object.keys(runtime.catalog).sort()).toEqual(["get", "list"]);
    expect(Object.isFrozen(runtime)).toBe(true);
    expect(Object.isFrozen(runtime.catalog)).toBe(true);
    for (const forbidden of ["registry", "targets", "router", "presenter", "timers", "postconditions", "transition", "feed", "state", "ports", "executors", "gateway", "mint"]) expect(forbidden in runtime, forbidden).toBe(false);
  });
  it("the catalog list shows only id, title and description; get returns frozen definitions or undefined", () => {
    const { runtime } = makeHarness();
    for (const summary of runtime.catalog.list()) expect(Object.keys(summary).sort()).toEqual(["description", "id", "title"]);
    expect(runtime.catalog.get("nope")).toBeUndefined();
    expect(Object.isFrozen(runtime.catalog.get("profileUpdate"))).toBe(true);
  });
  it("the snapshot is presentation-neutral plain data", () => {
    const h = makeHarness();
    h.runtime.startWalkthrough("profileUpdate");
    const snapshot = h.runtime.getState();
    expect(Object.keys(snapshot).sort()).toEqual(["attempt", "failure", "status", "stepId", "stepKind", "walkthroughId"]);
    expect(snapshot).toEqual({ status: "WAITING", walkthroughId: "profileUpdate", stepId: "a2", stepKind: "guide", attempt: 1, failure: null });
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(makeHarness().runtime.getState()).toEqual({ status: "IDLE", walkthroughId: null, stepId: null, stepKind: null, attempt: 0, failure: null });
  });
  it("refuses to be built with a missing port, a missing postcondition or a bad timeout", () => {
    const h = makeHarness();
    expect(() => createWalkthroughRuntime({ ...h.options, presenter: {} as never })).toThrow(/presenter.apply/);
    expect(() => createWalkthroughRuntime({ ...h.options, postconditions: {} })).toThrow(/postcondition/);
    expect(() => createWalkthroughRuntime({ ...h.options, verifyTimeoutMs: 0 })).toThrow(RangeError);
  });
});

describe("a failing port fails closed and never crashes the host", () => {
  it("a presenter that throws: present_failed", () => {
    const h = makeHarness();
    h.presenter.throws = true;
    expect(() => h.runtime.startWalkthrough("verifyOnly")).not.toThrow();
    expect(h.runtime.getState()).toMatchObject({ status: "FAILED", failure: "present_failed" });
  });
  it("a target port that throws, or answers nonsense: internal_error, or simply unavailable", () => {
    const h = makeHarness();
    const throwing = createWalkthroughRuntime({ ...h.options, targets: { resolve: () => { throw new Error("boom"); } } });
    expect(() => throwing.startWalkthrough("verifyOnly")).not.toThrow();
    expect(throwing.getState()).toMatchObject({ status: "FAILED", failure: "internal_error" });
    const odd = createWalkthroughRuntime({ ...h.options, targets: { resolve: () => "yes" as never } });
    odd.startWalkthrough("verifyOnly");
    expect(odd.getState().status).toBe("RESOLVING"); // not exactly "available": it keeps waiting and times out
  });
  it("a router.current that throws during verification fails the verification; a timer port that throws is internal_error", () => {
    const h = makeHarness();
    const router = createWalkthroughRuntime({ ...h.options, router: { current: () => { throw new Error("boom"); }, navigate: () => undefined } });
    router.startWalkthrough("goSettings");
    expect(router.getState().failure).toBe("verification_failed");
    const timers = createWalkthroughRuntime({ ...h.options, timers: { set: () => { throw new Error("boom"); } } });
    expect(() => timers.startWalkthrough("verifyOnly")).not.toThrow();
    expect(timers.getState().failure).toBe("internal_error");
  });
  it("a postcondition that is not callable at run time fails the check", () => {
    const h = makeHarness();
    const runtime = createWalkthroughRuntime({ ...h.options });
    runtime.startWalkthrough("verifyOnly");
    (h.options.postconditions as Record<string, unknown>).check = 5;
    runtime.dispatch(click("profile.saveButton"));
    expect(runtime.getState().failure).toBe("verification_failed");
  });
  it("a presenter that throws on clear does not stop a cancel", () => {
    const h = makeHarness();
    h.runtime.startWalkthrough("verifyOnly");
    h.presenter.throws = true;
    expect(() => h.runtime.cancel()).not.toThrow();
    expect(status(h)).toBe("CANCELLED");
  });
});

describe("context()", () => {
  it("is exactly registry metadata for the current route plus availability, and never a value, text or HTML", () => {
    const h = makeHarness();
    h.world.route = "profile";
    h.available.delete("profile.cancelButton");
    const context = h.runtime.context();
    expect(context).toEqual({
      route: "profile",
      elements: h.registry.forRoute("profile").map((e) => ({ id: e.id, role: e.role, label: e.label, description: e.description, privacy: e.privacy, available: e.id !== "profile.cancelButton" })),
    });
    expect(context.elements.find((e) => e.id === "profile.emailInput")?.privacy).toBe("private");
    expect(context.elements.find((e) => e.id === "profile.phoneInput")?.privacy).toBe("redact");
    expect(Object.keys(context).sort()).toEqual(["elements", "route"]);
    for (const element of context.elements) expect(Object.keys(element).sort()).toEqual(["available", "description", "id", "label", "privacy", "role"]);
  });
  it("does not change with what the page holds: private or redacted field values cannot reach it, because nothing reads them", () => {
    const h = makeHarness();
    h.world.route = "profile";
    const before = JSON.stringify(h.runtime.context());
    // The only inputs are the two ports below; neither offers a value, text or HTML, so there is nothing to leak.
    expect(Object.keys(h.ports.targets)).toEqual(["resolve"]);
    expect(JSON.stringify(h.runtime.context())).toBe(before);
    expect(before).not.toMatch(/secret|password|<|hunter/i);
  });
  it("survives failing ports: an unreadable route lists nothing, a throwing availability counts as unavailable", () => {
    const h = makeHarness();
    const noRoute = createWalkthroughRuntime({ ...h.options, router: { current: () => { throw new Error("boom"); }, navigate: () => undefined } });
    expect(noRoute.context()).toEqual({ route: "", elements: [] });
    const noTargets = createWalkthroughRuntime({ ...h.options, targets: { resolve: () => { throw new Error("boom"); } } });
    h.world.route = "profile";
    expect(noTargets.context().elements.every((e) => e.available === false)).toBe(true);
  });
});

describe("effects reaching the presenter", () => {
  it("only present and clear, with only the known presentation-neutral keys", () => {
    const h = makeHarness();
    for (const id of ["profileUpdate", "findSecurity", "findTwoFactor", "goSettings", "userGoesSettings"]) { h.runtime.startWalkthrough(id); h.runtime.cancel(); }
    h.runtime.startWalkthrough("profileUpdate");
    h.runtime.dispatch(input("profile.nameInput", true));
    h.runtime.dispatch(click("profile.saveButton"));
    expect(h.effects.length).toBeGreaterThan(5);
    for (const effect of h.effects) {
      expect(["present", "clear"]).toContain(effect.type);
      for (const key of Object.keys(effect)) expect(["type", "stepId", "target", "text", "expects"]).toContain(key);
      if (effect.type === "clear") expect(Object.keys(effect)).toEqual(["type"]);
      if (effect.type === "present") expect(typeof effect.text).toBe("string");
    }
    expect(JSON.stringify(h.effects)).not.toMatch(/selector|style|color|coordinate|querySelector|<|class/i);
  });
});
