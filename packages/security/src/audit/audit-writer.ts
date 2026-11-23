/**
 * @dap/security: audit/audit-writer.ts
 *
 * T088 / FR-040, research D13. The Gateway's only door to `AuditSink.append`, with the failure semantics of each kind of record:
 *
 *   recordProposed        best effort, awaited. A failure is counted, never raised.
 *   recordDecision        a denial (or other non-allowing decision). A failure is counted and NEVER changes the decision.
 *   recordAllowedDurably  the allow-event written BEFORE any execution. Resolves `{ ok: false, reason: "audit_unavailable" }` on
 *                         any failure: the caller must then return DENIED `audit_unavailable` and not execute.
 *   recordExecuted        the result after the fact. A failure is counted only; it never un-executes anything.
 *
 * Every append goes through the shared hook wrapper and deadline code, so a throw, a rejection, a hang, a wrong-shaped answer
 * (only a Promise that resolves to undefined is a commit) or a late answer is a failure. The timeout of each attempt is
 * `min(hookTimeoutMs, what is left of the proposal budget)`. With `attempts` above 1 a failed append is retried with the SAME event
 * (the same id), so a sink that is idempotent on `event.id` never ends up with two rows even when the first attempt did commit.
 *
 * Every attempt passes the sink an abandonment signal (`AuditAppendOptions.signal`) and aborts it when the attempt did not end in a confirmed commit,
 * Cancellation-aware sinks roll back if they observe abandonment before issuing COMMIT; already-issued commits remain uncertain.
 * Signals are never aborted after a confirmed commit.
 *
 * Only events made by `buildAuditEvent` are written: anything else is refused without touching the sink, counted as a failure.
 * Nothing here throws, and no error text (which could hold anything) is kept or forwarded.
 */
import type { AuditAppendOptions, AuditEvent, AuditEventType, AuditSink } from "@dap/contracts";
import { assertTimeout } from "../gateway/deadline.js";
import { wrapHook, type HookOptions } from "../gateway/hook-wrapper.js";
import type { ProposalBudget } from "../gateway/pipeline.js";
import { safeTelemetry, type AuditWriteKind, type GatewayTelemetry } from "../gateway/telemetry.js";
import { isBuiltAuditEvent } from "./event-builder.js";

export interface AuditWriterOptions extends HookOptions {
  /** Attempts per record, 1 to 5. Default 1: no retry. */
  readonly attempts?: number;
}
export type DurableResult = Readonly<{ ok: true }> | Readonly<{ ok: false; reason: "audit_unavailable" }>;
export interface AuditWriter {
  recordProposed(event: AuditEvent, budget?: ProposalBudget): Promise<void>;
  recordDecision(event: AuditEvent, budget?: ProposalBudget): Promise<void>;
  recordAllowedDurably(event: AuditEvent, budget?: ProposalBudget): Promise<DurableResult>;
  recordExecuted(event: AuditEvent, budget?: ProposalBudget): Promise<void>;
}

const KINDS: Readonly<Record<AuditWriteKind, readonly AuditEventType[]>> = Object.freeze({
  proposed: ["AI_ACTION_PROPOSED"],
  decision: ["AI_ACTION_DENIED", "AI_POLICY_VIOLATION", "AI_RATE_LIMITED", "AI_CONFIRMATION_REQUIRED", "AI_CONFIRMATION_REJECTED"],
  allowed: ["AI_ACTION_ALLOWED", "AI_CONFIRMATION_ACCEPTED"],
  executed: ["AI_ACTION_EXECUTED"],
});
const UNAVAILABLE: DurableResult = Object.freeze({ ok: false, reason: "audit_unavailable" });
const COMMITTED: DurableResult = Object.freeze({ ok: true });

export function createAuditWriter(
  { sink, telemetry }: { readonly sink: AuditSink; readonly telemetry?: Partial<GatewayTelemetry> },
  options: AuditWriterOptions = {},
): AuditWriter {
  const { hookTimeoutMs = 2000, attempts = 1, timer } = options;
  assertTimeout(hookTimeoutMs, "audit");
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 5) throw new RangeError("Invalid audit attempts");
  // The sink method is read once and keeps the host's receiver.
  const appended: unknown = sink?.append;
  if (typeof appended !== "function") throw new TypeError("Missing audit sink");
  const append = appended as (this: AuditSink, event: AuditEvent, options: AuditAppendOptions) => unknown;
  const count = safeTelemetry(telemetry);

  /** True only when the event was durably committed. Never throws. */
  async function write(kind: AuditWriteKind, event: AuditEvent, budget: ProposalBudget | undefined): Promise<boolean> {
    try {
      if (!isBuiltAuditEvent(event) || !KINDS[kind].includes(event.type)) return false;
      for (let attempt = 0; attempt < attempts; attempt++) {
        const left = budget === undefined ? Number.POSITIVE_INFINITY : Math.floor(budget.remainingMs());
        // (A spent budget would also fail inside wrapHook, whose timeout must be at least 1; the check just avoids the call.)
        if (!(left >= 1)) return false;
        // One signal per attempt: a sink that is still working when the writer gives up is told so, and must then not commit.
        const controller = new AbortController();
        let confirmed = false;
        try {
          const committed = await wrapHook((candidate: AuditEvent) => Reflect.apply(append, sink, [candidate, { signal: controller.signal }]), "void", { hookTimeoutMs: Math.min(hookTimeoutMs, left), ...(timer === undefined ? {} : { timer }) })(event);
          confirmed = committed.ok;
          if (confirmed) return true;
        } finally {
          if (!confirmed) controller.abort();
        }
      }
      return false;
    } catch { return false; }
  }
  const run = async (kind: AuditWriteKind, event: AuditEvent, budget: ProposalBudget | undefined): Promise<boolean> => {
    const committed = await write(kind, event, budget);
    if (!committed) count.auditWriteFailed(kind);
    return committed;
  };
  return Object.freeze({
    recordProposed: Object.freeze(async (event: AuditEvent, budget?: ProposalBudget): Promise<void> => { await run("proposed", event, budget); }),
    recordDecision: Object.freeze(async (event: AuditEvent, budget?: ProposalBudget): Promise<void> => { await run("decision", event, budget); }),
    recordAllowedDurably: Object.freeze(async (event: AuditEvent, budget?: ProposalBudget): Promise<DurableResult> => ((await run("allowed", event, budget)) ? COMMITTED : UNAVAILABLE)),
    recordExecuted: Object.freeze(async (event: AuditEvent, budget?: ProposalBudget): Promise<void> => { await run("executed", event, budget); }),
  });
}
