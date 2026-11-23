import type { Clock, RateLimiter, RateLimitResult, RateLimitRule, TenantScope } from "@dap/contracts";
import { BoundedState, MAX_STATE_SECONDS, positiveInteger, stateKey, type MemoryStateOptions } from "./bounded-state.js";

type Entry = { readonly expiresAt: number; readonly kind: "block" }
  | { readonly expiresAt: number; readonly kind: "counter"; readonly count: number; readonly limit: number; readonly windowSeconds: number };

/**
 * DEV / TEST ONLY (production: PostgreSQL, T114). Fixed epoch-aligned windows; block and counter entries share the hard
 * memory cap, which is one process-wide budget across tenants: when it is full, new keys fail closed for ALL tenants.
 */
export class InMemoryRateLimiter implements RateLimiter {
  private readonly state: BoundedState<Entry>;
  constructor(clock: Clock, options: MemoryStateOptions = {}) { this.state = new BoundedState(clock, options); }

  async hit(scope: TenantScope, bucketKey: string, rule: RateLimitRule): Promise<RateLimitResult> {
    const key = `counter:${stateKey(scope, bucketKey)}`;
    const limit = positiveInteger(rule?.limit, 1_000_000);
    const windowSeconds = positiveInteger(rule?.windowSeconds, MAX_STATE_SECONDS);
    const now = this.state.now();
    const prior = this.state.get(key);
    if (prior && (prior.kind !== "counter" || prior.limit !== limit || prior.windowSeconds !== windowSeconds)) throw new TypeError("Cannot change a live rate limit rule");
    const count = prior?.kind === "counter" ? prior.count + 1 : 1;
    if (!Number.isSafeInteger(count)) throw new Error("Security state counter exhausted");
    const windowMs = windowSeconds * 1000;
    const expiresAt = prior?.expiresAt ?? (Math.floor(now / windowMs) + 1) * windowMs;
    // Capture and update synchronously, before this async method yields to any competing hit.
    this.state.set(key, { kind: "counter", count, limit, windowSeconds, expiresAt });
    const allowed = count <= limit;
    return Object.freeze({ allowed, retryAfterSeconds: allowed ? 0 : Math.ceil((expiresAt - now) / 1000) });
  }

  async isBlocked(scope: TenantScope, bucketKey: string): Promise<boolean> {
    const key = `block:${stateKey(scope, bucketKey)}`;
    this.state.now();
    return this.state.get(key)?.kind === "block";
  }

  async block(scope: TenantScope, bucketKey: string, seconds: number): Promise<void> {
    const key = `block:${stateKey(scope, bucketKey)}`;
    const duration = positiveInteger(seconds, MAX_STATE_SECONDS);
    const now = this.state.now();
    const expiresAt = Math.max(this.state.get(key)?.expiresAt ?? now, now + duration * 1000);
    this.state.set(key, { kind: "block", expiresAt });
  }
}
