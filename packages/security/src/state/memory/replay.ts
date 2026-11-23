import type { Clock, ReplayGuard, TenantScope } from "@dap/contracts";
import { BoundedState, MAX_STATE_SECONDS, positiveInteger, stateKey, type MemoryStateOptions } from "./bounded-state.js";

/** DEV / TEST ONLY (production: PostgreSQL, T114): shares one process-wide capacity across tenants; see BoundedState. */
export class InMemoryReplayGuard implements ReplayGuard {
  private readonly state: BoundedState<{ readonly expiresAt: number }>;
  constructor(clock: Clock, options: MemoryStateOptions = {}) { this.state = new BoundedState(clock, options); }

  async claim(scope: TenantScope, key: string, retainSeconds: number): Promise<"claimed" | "duplicate"> {
    const captured = stateKey(scope, key);
    const seconds = positiveInteger(retainSeconds, MAX_STATE_SECONDS);
    const now = this.state.now();
    // No await between lookup and insert: one atomic turn of this process's event loop.
    if (this.state.get(captured)) return "duplicate";
    this.state.set(captured, { expiresAt: now + seconds * 1000 });
    return "claimed";
  }
}
