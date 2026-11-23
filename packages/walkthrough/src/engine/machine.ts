/**
 * The pure state machine (plan 4.4). `transition(catalog, state, input)` returns the next state and the effects to run. It has no timers, no I/O,
 * no Date or Math.random, and it never mutates its inputs or throws: an input that does not apply returns the SAME state object and no effects.
 *
 * Attempts: every entry into a step (first entry, `next`, `recover`, re-resolve after `targetGone`) counts; entering a step more than `maxAttempts` times
 * ends the run `FAILED max_attempts`. That bounds every loop a recovery can make.
 */
import type { WalkthroughCatalog } from "../walkthrough/catalog.js";
import { DEFAULT_MAX_ATTEMPTS, DEFAULT_TARGET_WAIT_MS } from "../walkthrough/definition.js";
import type { Step, WalkthroughDef } from "../walkthrough/definition.js";
import type { SemanticEvent } from "./events.js";

export type FailureReason = "target_unavailable" | "verification_failed" | "max_attempts" | "present_failed" | "navigation_refused" | "internal_error";
export type Attempts = Readonly<Record<string, number>>;
export type EngineState =
  | { readonly status: "IDLE" }
  | { readonly status: "RESOLVING" | "PRESENTING" | "WAITING" | "VERIFYING"; readonly walkthroughId: string; readonly stepId: string; readonly attempts: Attempts }
  | { readonly status: "COMPLETED"; readonly walkthroughId: string; readonly stepId: string }
  | { readonly status: "FAILED"; readonly walkthroughId: string; readonly stepId: string; readonly reason: FailureReason }
  | { readonly status: "CANCELLED"; readonly walkthroughId: string };

export type Input =
  | { readonly type: "start"; readonly id: string }
  | { readonly type: "targetFound" }
  | { readonly type: "targetWaitExpired" }
  | { readonly type: "presented" }
  | { readonly type: "presentFailed" }
  | { readonly type: "event"; readonly event: SemanticEvent }
  | { readonly type: "navigated" }
  | { readonly type: "navigationRefused" }
  | { readonly type: "verified"; readonly ok: boolean }
  | { readonly type: "verifyFailed" }
  | { readonly type: "internalError" }
  | { readonly type: "cancel" };

export type Expects = "click" | "input" | "ack" | "route";
/** Forwarded to the UI-facing presenter. Plain data: ids and text only, never a selector, style, coordinate or element. */
export type PresentationEffect =
  | { readonly type: "present"; readonly stepId: string; readonly target?: string; readonly text: string; readonly expects: Expects }
  | { readonly type: "clear" };
/** Run by the runtime shell itself through its ports. The shell, not the machine, owns the postcondition timeout (it is configuration, not behaviour). */
export type InternalEffect =
  | { readonly type: "resolveTarget"; readonly id: string }
  | { readonly type: "navigate"; readonly route: string }
  | { readonly type: "verify"; readonly postcondition: string }
  | { readonly type: "verifyRoute"; readonly route: string }
  | { readonly type: "startTimer"; readonly key: TimerKey; readonly ms: number }
  | { readonly type: "cancelTimer"; readonly key: TimerKey };
export type TimerKey = "targetWait" | "verify";
export type Effect = PresentationEffect | InternalEffect;

export interface TransitionResult {
  readonly state: EngineState;
  readonly effects: readonly Effect[];
  /** Set only for `start`: why it was not accepted. The state is then unchanged. */
  readonly refusal?: "busy" | "unknown_walkthrough";
}

const NONE: readonly Effect[] = Object.freeze([]);
const fx = <T extends Effect>(effect: T): T => Object.freeze(effect);
const result = (state: EngineState, effects: readonly Effect[] = NONE, refusal?: TransitionResult["refusal"]): TransitionResult =>
  Object.freeze(refusal === undefined ? { state, effects: Object.freeze([...effects]) } : { state, effects: Object.freeze([...effects]), refusal });

const isTerminal = (state: EngineState): boolean => state.status === "COMPLETED" || state.status === "FAILED" || state.status === "CANCELLED";
const stepOf = (def: WalkthroughDef, id: string): Step | undefined => def.steps.find((s) => s.id === id);
const failed = (walkthroughId: string, stepId: string, reason: FailureReason, effects: readonly Effect[]): TransitionResult =>
  result(Object.freeze({ status: "FAILED", walkthroughId, stepId, reason }), [...effects, fx({ type: "clear" })]);

/** Enters step `stepId`: counts the attempt, then resolves a guide target, navigates, asks the user to navigate, or completes. */
function enter(def: WalkthroughDef, stepId: string, attempts: Attempts, before: readonly Effect[]): TransitionResult {
  const step = stepOf(def, stepId);
  if (step === undefined) return failed(def.id, stepId, "internal_error", before);
  if (step.kind === "complete") {
    return result(Object.freeze({ status: "COMPLETED", walkthroughId: def.id, stepId }), [...before, fx({ type: "present", stepId, text: step.text, expects: "ack" })]);
  }
  const attempt = (attempts[stepId] ?? 0) + 1;
  if (attempt > (step.maxAttempts ?? DEFAULT_MAX_ATTEMPTS)) return failed(def.id, stepId, "max_attempts", before);
  const next: Attempts = Object.freeze({ ...attempts, [stepId]: attempt });
  const at = (status: "RESOLVING" | "PRESENTING"): EngineState => Object.freeze({ status, walkthroughId: def.id, stepId, attempts: next });
  if (step.kind === "guide") {
    return result(at("RESOLVING"), [...before, fx({ type: "startTimer", key: "targetWait", ms: step.targetWaitMs ?? DEFAULT_TARGET_WAIT_MS }), fx({ type: "resolveTarget", id: step.target })]);
  }
  if (step.text === undefined) return result(at("RESOLVING"), [...before, fx({ type: "navigate", route: step.route })]);
  return result(at("PRESENTING"), [...before, fx({ type: "present", stepId, text: step.text, expects: "route" })]);
}

/** Leaving a step that was shown to the user. */
const clear = (): readonly Effect[] => [fx({ type: "clear" })];

/** Where a failed step goes: its `recover` step, or the end of the run with `reason`. */
function recoverOrFail(def: WalkthroughDef, state: Extract<EngineState, { attempts: Attempts }>, step: Step, reason: FailureReason, before: readonly Effect[]): TransitionResult {
  if (step.kind !== "complete" && step.recover !== undefined) return enter(def, step.recover, state.attempts, before);
  return failed(def.id, step.id, reason, before);
}

function matches(step: Step, event: SemanticEvent): boolean {
  if (step.kind === "guide") {
    if (step.wait === "click") return event.type === "click" && event.id === step.target;
    if (step.wait === "input") return event.type === "input" && event.id === step.target && event.nonEmpty === true;
    return event.type === "ack";
  }
  return step.kind === "navigate" && event.type === "routeChanged" && event.route === step.route;
}

/** The step has been satisfied (and verified, if it asks for that): move on. */
function advance(def: WalkthroughDef, state: Extract<EngineState, { attempts: Attempts }>, step: Step, before: readonly Effect[]): TransitionResult {
  if (step.kind === "complete") return failed(def.id, step.id, "internal_error", before);
  return enter(def, step.next, state.attempts, before);
}

export function transition(catalog: WalkthroughCatalog, state: EngineState, input: Input): TransitionResult {
  const unchanged = result(state);
  try {
    if (input.type === "start") {
      if (state.status !== "IDLE" && !isTerminal(state)) return result(state, NONE, "busy");
      const def = catalog.get(input.id);
      if (def === undefined) return result(state, NONE, "unknown_walkthrough");
      return enter(def, def.start, Object.freeze({}), state.status === "IDLE" ? NONE : clear());
    }
    if (input.type === "cancel") {
      if (isTerminal(state) || state.status === "IDLE") return unchanged;
      return result(Object.freeze({ status: "CANCELLED", walkthroughId: (state as { walkthroughId: string }).walkthroughId }), [fx({ type: "cancelTimer", key: "targetWait" }), fx({ type: "cancelTimer", key: "verify" }), fx({ type: "clear" })]);
    }
    if (state.status === "IDLE" || isTerminal(state)) return unchanged;
    const live = state as Extract<EngineState, { attempts: Attempts }>;
    const def = catalog.get(live.walkthroughId);
    const step = def === undefined ? undefined : stepOf(def, live.stepId);
    if (def === undefined || step === undefined) return failed(live.walkthroughId, live.stepId, "internal_error", []);
    if (input.type === "internalError") return failed(def.id, step.id, "internal_error", [fx({ type: "cancelTimer", key: "targetWait" }), fx({ type: "cancelTimer", key: "verify" })]);

    switch (live.status) {
      case "RESOLVING": {
        if (step.kind === "guide") {
          const found = input.type === "targetFound" || (input.type === "event" && input.event.type === "targetAvailable" && input.event.id === step.target);
          if (found) return result(Object.freeze({ ...live, status: "PRESENTING" }), [fx({ type: "cancelTimer", key: "targetWait" }), fx({ type: "present", stepId: step.id, target: step.target, text: step.text, expects: step.wait })]);
          if (input.type === "targetWaitExpired") return recoverOrFail(def, live, step, "target_unavailable", [fx({ type: "cancelTimer", key: "targetWait" })]);
          return unchanged;
        }
        if (step.kind === "navigate") {
          if (input.type === "navigated") return result(Object.freeze({ ...live, status: "VERIFYING" }), [fx({ type: "verifyRoute", route: step.route })]);
          if (input.type === "navigationRefused") return failed(def.id, step.id, "navigation_refused", []);
        }
        return unchanged;
      }
      case "PRESENTING":
        if (input.type === "presented") return result(Object.freeze({ ...live, status: "WAITING" }));
        if (input.type === "presentFailed") return failed(def.id, step.id, "present_failed", []);
        return unchanged;
      case "WAITING": {
        if (input.type !== "event") return unchanged;
        const event = input.event;
        if (step.kind === "guide" && event.type === "targetGone" && event.id === step.target) return enter(def, step.id, live.attempts, clear());
        if (!matches(step, event)) return unchanged;
        if (step.kind === "guide" && step.verify !== undefined) return result(Object.freeze({ ...live, status: "VERIFYING" }), [fx({ type: "verify", postcondition: step.verify })]);
        if (step.kind === "navigate") return result(Object.freeze({ ...live, status: "VERIFYING" }), [fx({ type: "verifyRoute", route: step.route })]);
        return advance(def, live, step, clear());
      }
      case "VERIFYING": {
        const stop = fx({ type: "cancelTimer", key: "verify" });
        if (input.type === "verified" && input.ok === true) return advance(def, live, step, [stop, ...clear()]);
        if (input.type === "verified" || input.type === "verifyFailed") return recoverOrFail(def, live, step, "verification_failed", [stop, ...clear()]);
        return unchanged;
      }
      default: return unchanged;
    }
  } catch { return failed("", "", "internal_error", []); }
}
