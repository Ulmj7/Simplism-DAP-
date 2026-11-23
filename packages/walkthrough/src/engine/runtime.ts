/**
 * The runtime shell: a thin effect runner around the pure machine. It runs the machine's internal effects through the injected ports, forwards the
 * presentation effects to the presenter, feeds every result back as an input, and exposes a small frozen public API. No DOM, no network, no clock,
 * no randomness; time only exists as the injected `timers` port.
 */
import { buildSemanticContext } from "../privacy/privacy.js";
import type { SemanticContext } from "../privacy/privacy.js";
import type { SemanticRegistry } from "../semantic/types.js";
import { isValidId } from "../walkthrough/catalog.js";
import type { WalkthroughCatalog } from "../walkthrough/catalog.js";
import { parseSemanticEvent } from "./events.js";
import { transition } from "./machine.js";
import type { Effect, EngineState, FailureReason, Input, TimerKey } from "./machine.js";
import type { Cancel, Postconditions, PresenterPort, RouterPort, TargetPort, TimerPort } from "./ports.js";

export const DEFAULT_VERIFY_TIMEOUT_MS = 2000;

export interface RuntimeOptions {
  readonly registry: SemanticRegistry;
  readonly catalog: WalkthroughCatalog;
  readonly targets: TargetPort;
  readonly router: RouterPort;
  readonly presenter: PresenterPort;
  readonly timers: TimerPort;
  readonly postconditions: Postconditions;
  /** How long a postcondition may take before it counts as failed (default 2000 ms). */
  readonly verifyTimeoutMs?: number;
}

export interface EngineSnapshot {
  readonly status: EngineState["status"];
  readonly walkthroughId: string | null;
  readonly stepId: string | null;
  readonly stepKind: "guide" | "navigate" | "complete" | null;
  /** How often the current step has been entered in this run. */
  readonly attempt: number;
  readonly failure: FailureReason | null;
}

export type StartResult = { readonly ok: true } | { readonly ok: false; readonly reason: "unknown_walkthrough" | "busy" | "invalid_id" };
export type Unsubscribe = () => void;

export interface WalkthroughRuntime {
  startWalkthrough(id: string): StartResult;
  cancel(): void;
  getState(): EngineSnapshot;
  /** `listener` is called once per state change with the new snapshot. */
  subscribe(listener: (snapshot: EngineSnapshot) => void): Unsubscribe;
  /** The host forwards trusted semantic events here. Anything that is not a valid event is dropped; this never throws. */
  dispatch(event: unknown): void;
  readonly catalog: Pick<WalkthroughCatalog, "list" | "get">;
  /** Registry metadata and availability for the current route. Never a value, text, HTML or attribute of the page. */
  context(): SemanticContext;
}

export function createWalkthroughRuntime(options: RuntimeOptions): WalkthroughRuntime {
  const { registry, catalog, targets, router, presenter, timers, postconditions } = options;
  const verifyTimeoutMs = options.verifyTimeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS;
  for (const [name, port, methods] of [["targets", targets, ["resolve"]], ["router", router, ["current", "navigate"]], ["presenter", presenter, ["apply"]], ["timers", timers, ["set"]]] as const) {
    for (const method of methods) if (typeof (port as unknown as Record<string, unknown>)?.[method] !== "function") throw new TypeError(`Walkthrough runtime: ${name}.${method} is missing`);
  }
  if (!Number.isInteger(verifyTimeoutMs) || verifyTimeoutMs < 1 || verifyTimeoutMs > 60_000) throw new RangeError("Walkthrough runtime: verifyTimeoutMs must be an integer from 1 to 60000");
  for (const summary of catalog.list()) {
    for (const step of catalog.get(summary.id)?.steps ?? []) {
      if (step.kind === "guide" && step.verify !== undefined && (!Object.hasOwn(postconditions, step.verify) || typeof postconditions[step.verify] !== "function")) {
        throw new TypeError(`Walkthrough runtime: postcondition ${step.verify} (used by ${summary.id}.${step.id}) was not supplied`);
      }
    }
  }

  let state: EngineState = Object.freeze({ status: "IDLE" });
  const listeners = new Set<(snapshot: EngineSnapshot) => void>();
  const queue: { readonly input: Input; readonly valid: () => boolean }[] = [];
  let draining = false;
  let cancelRequested = false;
  const cancelers: Record<TimerKey, Cancel | null> = { targetWait: null, verify: null };
  // A timer or an async result only counts if its sequence number is still the current one: leaving a step bumps it.
  const sequence: Record<TimerKey, number> = { targetWait: 0, verify: 0 };

  const snapshot = (): EngineSnapshot => {
    const walkthroughId = state.status === "IDLE" ? null : state.walkthroughId;
    const stepId = state.status === "IDLE" || state.status === "CANCELLED" ? null : state.stepId;
    const def = walkthroughId === null ? undefined : catalog.get(walkthroughId);
    const stepKind = def?.steps.find((s) => s.id === stepId)?.kind ?? null;
    const attempt = "attempts" in state && stepId !== null ? state.attempts[stepId] ?? 0 : 0;
    return Object.freeze({ status: state.status, walkthroughId, stepId, stepKind, attempt, failure: state.status === "FAILED" ? state.reason : null });
  };
  const notify = (): void => {
    const view = snapshot();
    for (const listener of [...listeners]) { try { listener(view); } catch { /* a subscriber's failure is its own */ } }
  };

  const feed = (input: Input, valid: () => boolean = () => true): void => { queue.push({ input, valid }); drain(); };
  const stopTimer = (key: TimerKey): void => {
    sequence[key]++;
    const cancel = cancelers[key];
    cancelers[key] = null;
    try { cancel?.(); } catch { /* nothing to do */ }
  };
  const startTimer = (key: TimerKey, ms: number, onFire: (valid: () => boolean) => void): void => {
    stopTimer(key);
    const mine = sequence[key];
    try {
      let fired = false;
      const cancel = timers.set(() => {
        if (!fired && sequence[key] === mine) {
          fired = true;
          onFire(() => sequence[key] === mine);
        }
      }, ms);
      if (typeof cancel !== "function") throw new TypeError("Invalid timer cancellation handle");
      cancelers[key] = cancel;
    } catch { feed({ type: "internalError" }); }
  };

  const settleVerify = (token: number, ok: unknown): void => {
    if (token !== sequence.verify) return; // superseded by a newer verification, a cancel or the end of the step
    feed(ok === true ? { type: "verified", ok: true } : { type: "verifyFailed" }, () => token === sequence.verify);
  };
  const beginVerify = (): number => {
    startTimer("verify", verifyTimeoutMs, valid => feed({ type: "verifyFailed" }, valid));
    return sequence.verify;
  };

  function run(effect: Effect): void {
    switch (effect.type) {
      case "present":
        try { presenter.apply(effect); feed({ type: "presented" }); } catch { feed({ type: "presentFailed" }); }
        return;
      case "clear":
        try { presenter.apply(effect); } catch { /* clearing is best effort */ }
        return;
      case "resolveTarget": {
        let availability: unknown;
        try { availability = targets.resolve(effect.id); } catch { feed({ type: "internalError" }); return; }
        if (availability === "available") feed({ type: "targetFound" });
        return;
      }
      case "navigate":
        if (!registry.routes.includes(effect.route)) { feed({ type: "navigationRefused" }); return; }
        try { router.navigate(effect.route); feed({ type: "navigated" }); } catch { feed({ type: "navigationRefused" }); }
        return;
      case "verifyRoute": {
        const token = beginVerify();
        try { settleVerify(token, router.current() === effect.route); } catch { settleVerify(token, false); }
        return;
      }
      case "verify": {
        const token = beginVerify();
        try {
          const check = Object.hasOwn(postconditions, effect.postcondition) ? postconditions[effect.postcondition] : undefined;
          if (typeof check !== "function") { settleVerify(token, false); return; }
          const answer: unknown = check();
          if (answer !== null && typeof answer === "object") {
            const settled = (value: unknown) => settleVerify(token, value);
            try {
              // Observe native promises without trusting an overridden own `then` getter.
              Reflect.apply(Promise.prototype.then, answer, [settled, () => settled(false)]);
            } catch {
              const then: unknown = Reflect.get(answer, "then");
              if (typeof then === "function") {
                void new Promise(resolve => { Reflect.apply(then, answer, [resolve, () => resolve(false)]); })
                  .then(settled, () => settled(false));
              } else settled(false);
            }
          } else settleVerify(token, answer);
        } catch { settleVerify(token, false); }
        return;
      }
      case "startTimer":
        startTimer(effect.key, effect.ms, valid => feed({ type: "targetWaitExpired" }, valid));
        return;
      case "cancelTimer":
        stopTimer(effect.key);
        return;
    }
  }

  function drain(): void {
    if (draining) return;
    draining = true;
    try {
      for (let entry = queue.shift(); entry !== undefined; entry = queue.shift()) {
        if (!entry.valid()) continue;
        const input = entry.input;
        const next = transition(catalog, state, input);
        if (next.state !== state) { state = next.state; notify(); }
        if (input.type === "cancel") cancelRequested = false;
        for (const effect of next.effects) {
          if (cancelRequested && effect.type !== "clear" && effect.type !== "cancelTimer") continue;
          run(effect);
        }
      }
    } catch {
      queue.length = 0;
      state = Object.freeze({ status: "FAILED", walkthroughId: "walkthroughId" in state ? state.walkthroughId : "", stepId: "stepId" in state ? state.stepId : "", reason: "internal_error" });
      notify();
    } finally { draining = false; }
  }

  return Object.freeze({
    startWalkthrough(id: string): StartResult {
      if (!isValidId(id)) return { ok: false, reason: "invalid_id" };
      const dry = transition(catalog, state, { type: "start", id });
      if (dry.refusal !== undefined) return { ok: false, reason: dry.refusal };
      feed({ type: "start", id });
      return { ok: true };
    },
    cancel(): void {
      if (["RESOLVING", "PRESENTING", "WAITING", "VERIFYING"].includes(state.status)) cancelRequested = true;
      feed({ type: "cancel" });
    },
    getState: snapshot,
    subscribe(listener: (snapshot: EngineSnapshot) => void): Unsubscribe {
      if (typeof listener !== "function") return () => undefined;
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
    dispatch(event: unknown): void {
      const parsed = parseSemanticEvent(event, registry);
      if (parsed !== null) feed({ type: "event", event: parsed });
    },
    catalog: Object.freeze({ list: () => catalog.list(), get: (id: unknown) => catalog.get(id) }),
    context(): SemanticContext {
      let route = "";
      try { const current: unknown = router.current(); if (typeof current === "string" && registry.routes.includes(current)) route = current; } catch { /* no route: nothing is listed */ }
      return buildSemanticContext(registry, route, (id) => { try { return targets.resolve(id) === "available"; } catch { return false; } });
    },
  });
}
