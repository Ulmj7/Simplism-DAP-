/**
 * One guarded call to a model. The request is validated first; there is exactly one `generate` call; the deadline comes from an injected timer port
 * (the package starts no real timer); and everything that goes wrong becomes a CLOSED reason. Nothing from the provider (a message, stack, cause,
 * key, raw object or schema error) can reach the outcome: it is built only from constants and a validated decision.
 */
import { MAX_MODEL_CALLS, MODEL_DEADLINE_MS } from "./limits.js";
import { parseGuidanceDecision } from "./decision.js";
import { parseGuidanceModelRequest } from "./request.js";
import type { GuidanceDecision, GuidanceModel, GuidanceTimers } from "./types.js";

export type ModelCallFailure = "query_invalid" | "context_invalid" | "model_unavailable" | "invalid_model_output";
export type ModelCallOutcome = { readonly ok: true; readonly decision: GuidanceDecision } | { readonly ok: false; readonly reason: ModelCallFailure };

/** Counts model calls. A guard shared by several `callGuidanceModel` calls refuses every call after the first. */
export interface ModelCallGuard { take(): boolean }
export function createModelCallGuard(limit: number = MAX_MODEL_CALLS): ModelCallGuard {
  let used = 0;
  return Object.freeze({ take: () => (used < limit ? (used++, true) : false) });
}

const intrinsicThen = Promise.prototype.then; // captured once: later changes to Promise.prototype or to a promise's own `then` do not matter

/**
 * Observes whatever `generate` returned, exactly once. A genuine native promise is observed with the intrinsic `then` (its own `then` property is never
 * read, so a poisoned one cannot throw or leave its rejection unhandled); anything else that has a `then` is a foreign thenable, whose `then` is read
 * once, called once, and answered through once-only callbacks; a plain value is the answer itself. Never throws.
 */
function observe(answer: unknown, onValue: (value: unknown) => void, onReject: () => void): void {
  let done = false;
  const once = <T>(next: (value: T) => void) => (value: T): void => { if (!done) { done = true; next(value); } };
  const value = once(onValue);
  const reject = once<unknown>(() => onReject());
  try { intrinsicThen.call(answer as Promise<unknown>, value, reject); return; } catch { /* not a native promise */ }
  if (answer !== null && (typeof answer === "object" || typeof answer === "function")) {
    let then: unknown;
    try { then = (answer as { then?: unknown }).then; } catch { reject(undefined); return; }
    if (typeof then === "function") {
      try { Reflect.apply(then, answer, [value, reject]); } catch { reject(undefined); }
      return;
    }
  }
  value(answer);
}

const failed = (reason: ModelCallFailure): ModelCallOutcome => Object.freeze({ ok: false, reason });

export function callGuidanceModel(args: { readonly model: GuidanceModel; readonly request: unknown; readonly timers: GuidanceTimers; readonly guard?: ModelCallGuard }): Promise<ModelCallOutcome> {
  return new Promise<ModelCallOutcome>((resolve) => {
    let settled = false;
    let cancel: (() => void) | null = null;
    const finish = (outcome: ModelCallOutcome): void => {
      if (settled) return; // a late answer, or a second timer, changes nothing
      settled = true;
      const release = cancel;
      cancel = null;
      try { release?.(); } catch { /* releasing is best effort */ }
      resolve(outcome);
    };
    try {
      const request = parseGuidanceModelRequest(args.request);
      if (!request.ok) return finish(failed(request.reason));
      if ((args.guard ?? createModelCallGuard()).take() !== true) return finish(failed("model_unavailable"));
      // The deadline is armed BEFORE the call: a timer port that fails means no call is made at all.
      const handle: unknown = args.timers.set(() => finish(failed("model_unavailable")), MODEL_DEADLINE_MS);
      if (typeof handle !== "function") { settled = true; return resolve(failed("model_unavailable")); }
      // A port may fire synchronously, before it hands back the cancel handle.
      // Honour that deadline without starting a model call, and release the handle once.
      if (settled) { try { handle(); } catch { /* releasing is best effort */ } return; }
      cancel = handle as () => void;
      let answer: unknown;
      try { answer = args.model.generate(request.request); } catch { return finish(failed("model_unavailable")); }
      observe(answer,
        (value) => {
          const decision = parseGuidanceDecision(value);
          const tooLong = decision?.kind === "answer" && decision.answer.length > request.request.maxOutputChars;
          finish(decision === null || tooLong ? failed("invalid_model_output") : Object.freeze({ ok: true, decision }));
        },
        () => finish(failed("model_unavailable")));
    } catch { finish(failed("model_unavailable")); }
  });
}
