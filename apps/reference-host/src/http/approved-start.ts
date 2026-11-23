/**
 * C01: how the browser learns which walkthrough the Gateway APPROVED.
 *
 * The `startWalkthrough` capability's trusted executor calls a host `WalkthroughStarter` once it has passed the full Gateway pipeline. On this host the
 * starter cannot drive a browser, so it only RECORDS the id it was called with. `/api/guidance/start` submits the proposal through the existing bridge
 * (`submitWalkthroughStart`, i.e. `AiSession.submit` -> Gateway -> executor), then takes the recorded id: only an id the executor actually received AND a
 * Gateway result of `ok` yield an approved id, which the browser then passes to `GuideApi.startWalkthrough` itself. Anything else fails closed.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import type { AiSession } from "../compose.js";
import type { WalkthroughStarter } from "../guidance/capability.js";
import { submitWalkthroughStart } from "../guidance/start-bridge.js";

/** The bridge's own result type (a Feature 003 GuidanceResult), so this module imports nothing from the AI package itself. */
type BridgeResult = Awaited<ReturnType<typeof submitWalkthroughStart>>;

/** `unavailable`: the start timed out or the start queue was full (the transport replies 503 unavailable); otherwise a refusal. */
export type StartOutcome = { readonly ok: true; readonly walkthroughId: string } | { readonly ok: false; readonly unavailable?: true };
/** Each Gateway submission owns its own record, even when a timed-out submission is still running. */
export interface ApprovalRecorder {
  readonly starter: WalkthroughStarter;
  withSubmission(walkthroughId: string, run: (take: () => string | null) => void): void;
}

export function createApprovalRecorder(): ApprovalRecorder {
  const submissions = new AsyncLocalStorage<{ walkthroughId: string; open: boolean; recorded: boolean }>();
  return Object.freeze({
    starter: Object.freeze({
      start(id: string) {
        const submission = submissions.getStore();
        if (!submission?.open || submission.walkthroughId !== id || submission.recorded) return { ok: false as const, reason: "no_pending_submission" };
        submission.recorded = true;
        return { ok: true as const };
      },
    }),
    withSubmission(walkthroughId: string, run: (take: () => string | null) => void) {
      const submission = { walkthroughId, open: true, recorded: false };
      submissions.run(submission, () => run(() => {
        if (!submission.open) return null;
        submission.open = false;
        return submission.recorded ? submission.walkthroughId : null;
      }));
    },
  });
}

/** Timers for the per-start timeout, injectable so tests decide when it elapses. */
export interface StartTimers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}
const hostStartTimers: StartTimers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => { if (handle !== null && typeof handle === "object") clearTimeout(handle as ReturnType<typeof setTimeout>); },
};
/** A start that has not finished in this time is abandoned: it fails closed and releases its slot. */
export const START_TIMEOUT_MS = 10_000;
/** Starts waiting or running at once; past this a start fails closed immediately. */
export const MAX_START_QUEUE = 8;
const UNAVAILABLE: StartOutcome = Object.freeze({ ok: false, unavailable: true });

export interface GatewayStartDeps {
  /** Opens the host's own (server-side) session; `null` when it is refused. */
  readonly openSession: () => Promise<AiSession | null>;
  readonly recorder: ApprovalRecorder;
  readonly submit?: (session: AiSession, walkthroughId: string) => Promise<BridgeResult>;
  readonly timers?: StartTimers;
  readonly timeoutMs?: number;
  readonly maxQueue?: number;
}

/**
 * Sends one proposed walkthrough id through the Gateway and returns the id the executor approved. Never throws.
 *
 * At most `maxQueue` starts wait or run. When a timeout releases the slot, the abandoned submission loses its ability to record an approval.
 */
export function createGatewayStart({ openSession, recorder, submit = submitWalkthroughStart, timers = hostStartTimers, timeoutMs = START_TIMEOUT_MS, maxQueue = MAX_START_QUEUE }: GatewayStartDeps): (walkthroughId: string) => Promise<StartOutcome> {
  const startOnce = async (walkthroughId: string, isSettled: () => boolean): Promise<boolean> => {
    const session = await openSession();
    if (session === null || isSettled()) return false;
    const result = await submit(session, walkthroughId);
    return result.kind === "walkthrough" && result.walkthroughId === walkthroughId;
  };
  let tail: Promise<void> = Promise.resolve();
  let pending = 0;
  return (walkthroughId) => {
    if (pending >= maxQueue) return Promise.resolve(UNAVAILABLE);
    pending += 1;
    let releaseSlot: () => void = () => undefined;
    const previous = tail;
    tail = new Promise<void>((resolve) => { releaseSlot = resolve; });
    return previous.then(() => new Promise<StartOutcome>((resolve) => {
      let settled = false;
      const settle = (outcome: StartOutcome) => {
        if (settled) return;
        settled = true;
        pending -= 1;
        releaseSlot();
        resolve(outcome);
      };
      recorder.withSubmission(walkthroughId, (take) => {
        let handle: unknown;
        try {
          handle = timers.setTimeout(() => { take(); settle(UNAVAILABLE); }, timeoutMs);
        } catch {
          take();
          settle(UNAVAILABLE);
          return;
        }
        const cleanup = () => { try { timers.clearTimeout(handle); } catch { /* best effort */ } };
        if (settled) { cleanup(); return; }
        void startOnce(walkthroughId, () => settled).catch(() => false).then(ok => {
          cleanup();
          const approved = take();
          settle(ok && approved !== null ? { ok: true, walkthroughId: approved } : { ok: false });
        });
      });
    }));
  };
}
