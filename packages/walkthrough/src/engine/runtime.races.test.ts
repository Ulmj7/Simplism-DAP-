import { expect, it } from "vitest";
import { makeHarness, walkthroughC } from "./test-support.js";
import { createWalkthroughRuntime } from "./runtime.js";

it("subscriber cancellation prevents pending presentation", () => {
  const h = makeHarness();
  h.runtime.subscribe(snapshot => {
    if (snapshot.status === "PRESENTING") h.runtime.cancel();
  });
  h.runtime.startWalkthrough("verifyOnly");
  expect(h.runtime.getState().status).toBe("CANCELLED");
  expect(h.effects.filter(effect => effect.type === "present")).toEqual([]);
  expect(h.pending()).toHaveLength(0);
});

it("duplicate synchronous timer callbacks cannot expire the recovery step", () => {
  const h = makeHarness({ definitions: [walkthroughC] });
  let calls = 0;
  const runtime = createWalkthroughRuntime({
    ...h.options,
    targets: { resolve: () => "unavailable" },
    timers: { set: callback => {
      if (calls++ === 0) { callback(); callback(); }
      return () => undefined;
    } },
  });
  runtime.startWalkthrough("findTwoFactor");
  expect(runtime.getState()).toMatchObject({ status: "RESOLVING", stepId: "c2" });
});

it("context rejects a route outside the registry instead of echoing port data", () => {
  const h = makeHarness();
  const runtime = createWalkthroughRuntime({ ...h.options, router: { ...h.ports.router, current: () => "SECRET_BAD_PORT_VALUE" } });
  expect(runtime.context()).toEqual({ route: "", elements: [] });
});

it("native rejected promises are observed even when their own then getter throws", async () => {
  const h = makeHarness();
  const rejected = Promise.reject(new Error("private failure"));
  Object.defineProperty(rejected, "then", { get() { throw new Error("poisoned then"); } });
  h.answers.check = () => rejected;
  h.runtime.startWalkthrough("verifyOnly");
  h.runtime.dispatch({ type: "click", id: "profile.saveButton" });
  await Promise.resolve();
  await Promise.resolve();
  expect(h.runtime.getState()).toMatchObject({ status: "FAILED", failure: "verification_failed" });
});

it("presenter re-entry queues one event, cannot start a busy run, and cancel clears timers", () => {
  const h = makeHarness();
  const refusals: unknown[] = [];
  const runtime: ReturnType<typeof createWalkthroughRuntime> = createWalkthroughRuntime({ ...h.options, presenter: { apply: effect => {
    h.effects.push(effect);
    if (effect.type === "present" && effect.stepId === "v1") {
      refusals.push(runtime.startWalkthrough("goSettings"));
      runtime.dispatch({ type: "click", id: "profile.saveButton" });
      runtime.cancel();
    }
  } } });
  runtime.startWalkthrough("verifyOnly");
  expect(refusals).toEqual([{ ok: false, reason: "busy" }]);
  expect(runtime.getState().status).toBe("CANCELLED");
  expect(h.pending()).toHaveLength(0);
  expect(h.effects.at(-1)).toEqual({ type: "clear" });
});

it("a cancelled timer and a late postcondition from an earlier run are inert", async () => {
  const h = makeHarness();
  let resolve: (value: boolean) => void = () => undefined;
  h.answers.check = () => new Promise<boolean>(done => { resolve = done; });
  h.runtime.startWalkthrough("verifyOnly");
  h.runtime.dispatch({ type: "click", id: "profile.saveButton" });
  const old = h.timers.at(-1)!;
  h.runtime.cancel();
  h.runtime.startWalkthrough("findSecurity");
  const before = h.runtime.getState();
  old.fire(); resolve(true);
  await Promise.resolve(); await Promise.resolve();
  expect(h.runtime.getState()).toEqual(before);
  expect(h.pending()).toHaveLength(0);
});

it("availability while presenting or waiting does not advance a step; route events still verify the port", () => {
  const h = makeHarness();
  h.runtime.startWalkthrough("verifyOnly");
  const before = h.runtime.getState();
  h.runtime.dispatch({ type: "targetAvailable", id: "profile.saveButton" });
  expect(h.runtime.getState()).toEqual(before);
  h.runtime.cancel();
  h.runtime.startWalkthrough("userGoesSettings");
  h.runtime.dispatch({ type: "routeChanged", route: "settings" }); // port still dashboard
  expect(h.runtime.getState()).toMatchObject({ status: "FAILED", failure: "verification_failed" });
});

it("a never-settling target promise remains unavailable until its injected deadline", () => {
  const h = makeHarness();
  const runtime = createWalkthroughRuntime({ ...h.options, targets: { resolve: () => new Promise(() => undefined) as never } });
  runtime.startWalkthrough("verifyOnly");
  expect(runtime.getState().status).toBe("RESOLVING");
  h.pending()[0]!.fire();
  expect(runtime.getState()).toMatchObject({ status: "FAILED", failure: "target_unavailable" });
  expect(h.pending()).toHaveLength(0);
});

it("a timer port that never fires cannot measure time; cancellation still releases it", () => {
  const h = makeHarness(); h.available.clear();
  h.runtime.startWalkthrough("verifyOnly");
  expect(h.runtime.getState().status).toBe("RESOLVING");
  expect(h.pending()).toHaveLength(1);
  h.runtime.cancel();
  expect(h.pending()).toHaveLength(0);
});

it("a timer port returning no cancellation function fails closed", () => {
  const h = makeHarness();
  const runtime = createWalkthroughRuntime({ ...h.options, timers: { set: () => undefined as never } });
  runtime.startWalkthrough("verifyOnly");
  expect(runtime.getState()).toMatchObject({ status: "FAILED", failure: "internal_error" });
});
