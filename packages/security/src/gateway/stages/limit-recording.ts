import { AsyncLocalStorage } from "node:async_hooks";
import type { PolicyDecision } from "@dap/contracts";

interface PendingDenial { readonly stage: string; readonly reason: string; readonly record: () => Promise<void> }
interface Scope { active: boolean; readonly pending: PendingDenial[] }
const recording = new AsyncLocalStorage<Scope>();

/** Request-local: neither concurrent submissions nor duplicate host ids can share a throttle write. */
export function deferLimitDenial(job: PendingDenial): boolean {
  const scope = recording.getStore();
  if (!scope) return false;
  if (scope.active) scope.pending.push(job);
  return true; // A late stage cannot enqueue work after its final decision.
}

/** Composition owns post-decision side effects; the generic pipeline knows no limiter policy. */
export function withDeferredLimitDenials(operation: () => Promise<PolicyDecision>): Promise<PolicyDecision> {
  return recording.run({ active: true, pending: [] }, async () => {
    const scope = recording.getStore()!;
    try {
      const decision = await operation();
      scope.active = false;
      for (const job of scope.pending) if (decision.outcome === "DENIED" && decision.stage === job.stage && decision.reason === job.reason) {
        try { await job.record(); } catch { /* A recording failure never replaces a final denial. */ }
      }
      return decision;
    } finally { scope.active = false; scope.pending.length = 0; }
  });
}
