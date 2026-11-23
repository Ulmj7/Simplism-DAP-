import { z } from "zod";
import type { Clock, TenantScope } from "@dap/contracts";

const uuid = z.uuid();
const instant = z.iso.datetime({ offset: true });
export const MAX_STATE_SECONDS = 31_536_000;
export function positiveInteger(value: unknown, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > maximum) throw new TypeError("Invalid security state integer");
  return value;
}

/** Keys are opaque, including any namespace; tenant identity comes ONLY from the scope. */
export function stateKey(scope: TenantScope, key: string): string {
  const tenantId: unknown = scope?.tenantId;
  if (!uuid.safeParse(tenantId).success) throw new TypeError("Security state requires a UUID tenant");
  // A lone surrogate has no UTF-8 form: a database driver would silently turn two different keys into the same U+FFFD text.
  if (typeof key !== "string" || key.length < 1 || key.length > 1024 || key.includes("\u0000") || /\p{Cs}/u.test(key) || Buffer.byteLength(key, "utf8") > 1024) throw new TypeError("Invalid security state key");
  return JSON.stringify([(tenantId as string).toLowerCase(), key]);
}

export interface MemoryStateOptions { readonly maxEntries?: number }

/**
 * DEV / TEST ONLY. Production replay and rate-limit state lives in PostgreSQL (T114); these in-memory adapters exist for
 * tests, the reference host and local development, and are process-local (not shared between replicas).
 *
 * Hard per-store cap (default 10,000; configurable up to 1,000,000) plus 1024-byte keys. Expired entries are swept on every
 * operation. A full store throws; live entries are NEVER evicted.
 *
 * Known limitation (accepted): the cap is one process-wide budget, not per tenant. One user can fill it (replay claims are
 * kept for 86,400 s, so at 60 proposals a minute that takes about 2.8 hours), and while it is full every NEW key fails
 * closed for ALL tenants (existing keys keep working) until entries expire. Do not run these adapters in front of real
 * tenants. Every operation also scans all entries (about 0.04 ms at 10,000 entries, linear beyond).
 */
export class BoundedState<T extends { readonly expiresAt: number }> {
  private readonly entries = new Map<string, T>();
  private readonly capacity: number;
  private lastNow = -Infinity;
  constructor(private readonly clock: Clock, options: MemoryStateOptions = {}) {
    this.capacity = positiveInteger(options.maxEntries === undefined ? 10_000 : options.maxEntries, 1_000_000);
  }
  now(): number {
    const raw: unknown = this.clock.now();
    if (!instant.safeParse(raw).success) throw new TypeError("Invalid security state clock");
    const now = Date.parse(raw as string);
    if (!Number.isFinite(now) || now < this.lastNow) throw new TypeError("Invalid security state clock");
    this.lastNow = now;
    for (const [key, value] of this.entries) if (value.expiresAt <= now) this.entries.delete(key);
    return now;
  }
  get(key: string): T | undefined { return this.entries.get(key); }
  set(key: string, value: T): void {
    if (!this.entries.has(key) && this.entries.size >= this.capacity) throw new Error("Security state capacity exhausted");
    if (!Number.isSafeInteger(value.expiresAt) || Math.abs(value.expiresAt) > 8.64e15) throw new TypeError("Invalid security state expiry");
    this.entries.set(key, value);
  }
}
