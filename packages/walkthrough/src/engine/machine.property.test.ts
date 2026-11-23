import { expect, it } from "vitest";
import fc from "fast-check";
import { createWalkthroughCatalog } from "../walkthrough/catalog.js";
import { transition } from "./machine.js";
import type { EngineState, Input } from "./machine.js";
import { ALL, makeRegistry, POSTCONDITION_NAMES } from "./test-support.js";

it("seed 213071: machine purity, absorption and bounded per-run progress across catalogs", () => {
  const catalog = createWalkthroughCatalog(makeRegistry(), POSTCONDITION_NAMES, ALL);
  const signals: Input[] = [
    { type: "targetFound" }, { type: "targetWaitExpired" }, { type: "presented" }, { type: "presentFailed" },
    { type: "navigated" }, { type: "navigationRefused" }, { type: "verified", ok: true },
    { type: "verified", ok: false }, { type: "verifyFailed" }, { type: "cancel" }, { type: "internalError" },
    { type: "event", event: { type: "ack" } }, { type: "event", event: { type: "input", id: "profile.nameInput", nonEmpty: true } },
    { type: "event", event: { type: "click", id: "profile.saveButton" } },
    { type: "event", event: { type: "targetGone", id: "profile.saveButton" } },
    ...ALL.map(def => ({ type: "start" as const, id: def.id })),
  ];
  let changed = 0;
  fc.assert(fc.property(fc.integer({ min: 0, max: ALL.length - 1 }), fc.array(fc.integer({ min: 0, max: signals.length - 1 }), { maxLength: 200 }), (index, choices) => {
    const def = ALL[index]!;
    let state: EngineState = transition(catalog, Object.freeze({ status: "IDLE" }), { type: "start", id: def.id }).state;
    let progress = 0;
    for (const choice of choices) {
      const input = Object.freeze(signals[choice]!);
      const before = JSON.stringify(state);
      const result = transition(catalog, state, input);
      expect(result).toEqual(transition(catalog, state, input));
      expect(JSON.stringify(state)).toBe(before);
      if (["FAILED", "COMPLETED", "CANCELLED"].includes(state.status) && input.type !== "start") {
        expect(result.state).toBe(state); expect(result.effects).toEqual([]);
      }
      if (input.type === "start" && result.state !== state) progress = 0;
      if (result.state !== state) { progress++; changed++; }
      const active = result.state.status === "IDLE" ? undefined : catalog.get(result.state.walkthroughId);
      const bound = 5 * (active?.steps.reduce((n, step) => n + (step.kind === "complete" ? 1 : step.maxAttempts ?? 3), 0) ?? 1) + 5;
      expect(progress).toBeLessThanOrEqual(bound);
      if ("attempts" in result.state) for (const [id, count] of Object.entries(result.state.attempts)) {
        const step = active!.steps.find(step => step.id === id)!;
        expect(count).toBeGreaterThanOrEqual(1);
        expect(count).toBeLessThanOrEqual(step.kind === "complete" ? 1 : step.maxAttempts ?? 3);
      }
      expect(Object.isFrozen(result.state)).toBe(true);
      state = result.state;
    }
  }), { seed: 213071, numRuns: 250 });
  expect(changed).toBeGreaterThan(100);
});
