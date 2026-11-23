import { performance } from "node:perf_hooks";

export interface HookTimer {
  now(): number;
  setTimeout(callback: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}
export const nativeTimer: HookTimer = {
  now: () => performance.now(),
  setTimeout: (callback, ms) => setTimeout(callback, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export function assertTimeout(ms: number, what: string): void {
  if (!Number.isSafeInteger(ms) || ms < 1 || ms > 0x7fff_ffff) throw new RangeError(`Invalid ${what} timeout`);
}

/** Why a guarded call produced no usable answer. Callers map each cause to their own denial. */
export type Cause = "setup" | "timeout" | "thrown" | "rejected" | "late" | "invalid";

/**
 * The one deadline state machine behind every host-facing call: the answer is accepted only if the call
 * neither throws, rejects, nor exceeds `timeoutMs` (checked by timer AND by a monotonic reading, so
 * synchronous blocking or a broken timer cannot extend it). `accept` receives the raw answer and a
 * `within()` probe; it may throw to reject. A settled call never touches a late answer again, and the
 * timer is always cleared; if it cannot be, the result is a failure.
 */
export function underDeadline<R>(
  call: () => unknown,
  accept: (raw: unknown, within: () => boolean) => R,
  fail: (cause: Cause) => R,
  timeoutMs: number,
  timer: HookTimer,
): Promise<R> {
  return new Promise((resolve) => {
    let settled = false;
    let armed = false;
    let handle: unknown;
    const finish = (result: R): void => {
      if (settled) return;
      settled = true;
      try { if (armed) timer.clearTimeout(handle); } catch { result = fail("setup"); }
      resolve(result);
    };
    try {
      const start = timer.now();
      if (!Number.isFinite(start)) { finish(fail("setup")); return; }
      const within = (): boolean => {
        const current = timer.now();
        return Number.isFinite(current) && current >= start && current - start < timeoutMs;
      };
      handle = timer.setTimeout(() => finish(fail("timeout")), timeoutMs);
      armed = true;
      if (settled) { timer.clearTimeout(handle); return; }
      let raw: unknown;
      try { raw = call(); } catch { finish(fail("thrown")); return; }
      void Promise.resolve(raw).then((answer: unknown) => {
        if (settled) return;
        try {
          if (!within()) { finish(fail("late")); return; }
          const accepted = accept(answer, within);
          finish(within() ? accepted : fail("late"));
        } catch { finish(fail("invalid")); }
      }, () => finish(fail("rejected")));
    } catch { finish(fail("setup")); }
  });
}
