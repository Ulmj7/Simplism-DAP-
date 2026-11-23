/**
 * T109 teeth. A conformance suite that no broken adapter can fail proves nothing, and the PostgreSQL adapters (T114)
 * will lean on these suites. Each entry below is a small, deliberately broken adapter with ONE defect; the case it is
 * named for must fail against it, and a faithful reference must pass every case. A case that no defect can fail is
 * itself a failure, so a new property cannot be added without a defect that proves it can fail.
 */
import { describe, expect, it } from "vitest";
import type { RateLimiter, RateLimitRule, ReplayGuard, TenantScope } from "@dap/contracts";
import { FakeClock } from "@dap/testkit";
import { rateLimiterConformanceCases } from "../../packages/security/src/state/conformance/rate-limiter.conformance.js";
import type { RateLimiterConformanceCase } from "../../packages/security/src/state/conformance/rate-limiter.conformance.js";
import { replayConformanceCases } from "../../packages/security/src/state/conformance/replay.conformance.js";
import type { ReplayConformanceCase } from "../../packages/security/src/state/conformance/replay.conformance.js";

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const MAX_SECONDS = 31_536_000;

function positive(value: unknown, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > maximum) throw new TypeError("invalid integer");
  return value;
}
function tenantOf(scope: unknown, fault?: string): string {
  const raw: unknown = (scope as { tenantId?: unknown } | undefined)?.tenantId;
  if (fault === "acceptsBadScope") return String(raw);
  if (fault === "lenientTenantSpelling") {
    const text = String(raw).trim().replace(/^urn:uuid:/, "").replace(/[{}-]/g, "");
    if (!/^[0-9a-f]{32}$/i.test(text)) throw new TypeError("invalid tenant");
    return text.toLowerCase();
  }
  if (typeof raw !== "string" || !UUID.test(raw)) throw new TypeError("invalid tenant");
  return fault === "caseSensitive" ? raw : raw.toLowerCase();
}
function keyOf(key: unknown, fault?: string): string {
  if (fault === "acceptsBadKeys") return String(key);
  if (typeof key !== "string" || key.length < 1 || key.includes("\u0000")) throw new TypeError("invalid key");
  const size = fault === "keyLimitByCharacters" ? key.length : Buffer.byteLength(key, "utf8");
  const maximum = fault === "keyLimitOffByOne" ? 1023 : fault === "keyLimitAcceptsOneMore" ? 1025 : 1024;
  if (size > maximum) throw new TypeError("key too long");
  if (fault !== "acceptsLoneSurrogates" && !key.isWellFormed()) throw new TypeError("ill-formed key");
  return key;
}
/** A tenant embedded as JSON text inside a key must never choose the scope; this defect lets it. */
function embeddedTenant(key: string, tenant: string, fault?: string): string {
  if (fault !== "tenantFromKeyText") return tenant;
  try { const parsed: unknown = JSON.parse(key); const text = (parsed as { tenantId?: unknown } | null)?.tenantId; return typeof text === "string" ? text.toLowerCase() : tenant; }
  catch { return tenant; }
}

class ReferenceReplay implements ReplayGuard {
  private readonly entries = new Map<string, number>();
  constructor(private readonly clock: FakeClock, private readonly fault?: string) {}
  async claim(scope: TenantScope, key: string, retainSeconds: number): Promise<"claimed" | "duplicate"> {
    const f = this.fault;
    const tenant = tenantOf(scope, f);
    const text = keyOf(key, f);
    const owner = embeddedTenant(text, tenant, f);
    const name = f === "dropsNamespace" ? text.slice(text.lastIndexOf(":") + 1) : text;
    const storage = f === "ignoresTenant" ? name : JSON.stringify([owner, name]);
    const now = Date.parse(this.clock.now());
    if (f === "recordsBeforeValidation") this.entries.set(storage, now + 60_000);
    const seconds = f === "acceptsBadRetention" ? Number(retainSeconds) : positive(retainSeconds, MAX_SECONDS);
    const expires = this.entries.get(storage);
    const live = expires !== undefined && (f === "expiryInclusive" ? now <= expires : f === "expiresOneSecondEarly" ? now < expires - 1000 : now < expires);
    if (f === "nonAtomic") await Promise.resolve();
    if (live) {
      if (f === "extendsOnDuplicate") this.entries.set(storage, now + seconds * 1000);
      return "duplicate";
    }
    this.entries.set(storage, now + (f === "ignoresRetention" ? 60 : seconds) * 1000);
    return "claimed";
  }
}

interface Counter { readonly count: number; readonly expiresAt: number; readonly limit: number; readonly windowSeconds: number }
class ReferenceLimiter implements RateLimiter {
  private readonly counters = new Map<string, Counter>();
  private readonly blocks = new Map<string, number>();
  constructor(private readonly clock: FakeClock, private readonly fault?: string) {}
  private storage(scope: unknown, bucketKey: unknown, kind: "counter" | "block"): { readonly id: string; readonly name: string } {
    const f = this.fault;
    const tenant = tenantOf(scope, f);
    const text = keyOf(bucketKey, f);
    const owner = embeddedTenant(text, tenant, f);
    const shared = f === "blockIgnoresTenant" && kind === "block" ? "" : owner;
    const name = f === "blockIgnoresKey" && kind === "block" ? "*" : text;
    return { id: f === "ignoresTenant" ? `${kind}:${name}` : `${kind}:${JSON.stringify([shared, name])}`, name: text };
  }
  async hit(scope: TenantScope, bucketKey: string, rule: RateLimitRule): Promise<{ allowed: boolean; retryAfterSeconds: number }> {
    const f = this.fault;
    const { id } = this.storage(scope, bucketKey, "counter");
    const limit = f === "acceptsBadRule" ? Number(rule?.limit) : positive(rule?.limit, 1_000_000);
    const windowSeconds = f === "acceptsBadRule" ? Number(rule?.windowSeconds) : positive(rule?.windowSeconds, MAX_SECONDS);
    const now = Date.parse(this.clock.now());
    const windowMs = windowSeconds * 1000;
    if (f === "blockDeniesHits" && this.blocks.has(id.replace("counter:", "block:")) && (this.blocks.get(id.replace("counter:", "block:")) as number) > now) return { allowed: false, retryAfterSeconds: 1 };
    const prior = this.counters.get(id);
    let live = prior !== undefined && (f === "neverRollsOver" ? true : f === "rolloverInclusive" ? now <= prior.expiresAt : now < prior.expiresAt);
    if (live && prior && (prior.limit !== limit || prior.windowSeconds !== windowSeconds)) {
      if (f === "ruleChangeResets") live = false;
      else if (f !== "ruleChangeAccepted") throw new TypeError("cannot change a live rule");
    }
    const base = live ? prior!.count : 0;
    let expiresAt = live ? prior!.expiresAt : f === "windowFromFirstHit" ? now + windowMs : (Math.floor(now / windowMs) + 1) * windowMs;
    if (f === "nonAtomic") await Promise.resolve();
    const count = base + 1;
    const allowed = f === "limitOffByOne" ? count < limit : count <= limit;
    if (!allowed && f === "slidingOnDenial") expiresAt = now + windowMs;
    this.counters.set(id, { count, expiresAt, limit, windowSeconds });
    const remaining = (expiresAt - now) / 1000;
    const retry = f === "retryAfterRounds" ? Math.round(remaining) : f === "retryAfterFloors" ? Math.floor(remaining) : f === "retryAfterWindow" ? windowSeconds : Math.ceil(remaining);
    return { allowed, retryAfterSeconds: allowed ? 0 : retry };
  }
  async isBlocked(scope: TenantScope, bucketKey: string): Promise<boolean> {
    const f = this.fault;
    const { id } = this.storage(scope, bucketKey, "block");
    const now = Date.parse(this.clock.now());
    const expires = this.blocks.get(id);
    if (f === "exhaustedCounterBlocks" && this.counters.has(this.storage(scope, bucketKey, "counter").id)) return true;
    return expires !== undefined && (f === "blockInclusiveBoundary" ? now <= expires : now < expires);
  }
  async block(scope: TenantScope, bucketKey: string, seconds: number): Promise<void> {
    const f = this.fault;
    const { id } = this.storage(scope, bucketKey, "block");
    const duration = f === "acceptsBadBlockSeconds" ? Number(seconds) : positive(seconds, MAX_SECONDS);
    const now = Date.parse(this.clock.now());
    const next = now + duration * 1000;
    const existing = this.blocks.get(id);
    this.blocks.set(id, f === "blockReplaces" ? next : f === "blockKeepsFirst" ? existing ?? next : Math.max(existing ?? 0, next));
  }
}

const find = <T extends { readonly name: string }>(cases: readonly T[], prefix: string): T => {
  const matches = cases.filter((entry) => entry.name.startsWith(prefix));
  if (matches.length !== 1) throw new Error(`expected exactly one case starting with "${prefix}", found ${matches.length}`);
  return matches[0]!;
};
async function passes<T extends { run: (ctx: never) => Promise<void> }>(conformanceCase: T, ctx: Parameters<T["run"]>[0]): Promise<boolean> {
  try { await conformanceCase.run(ctx as never); return true; } catch { return false; }
}

// fault -> the case that must catch it (by name prefix)
const REPLAY: Record<string, string> = {
  nonAtomic: "exactly one of 32", ignoresTenant: "keeps equal keys independent", tenantFromKeyText: "keeps equal keys independent", dropsNamespace: "keeps equal keys independent",
  extendsOnDuplicate: "uses a fixed retention boundary", expiryInclusive: "uses a fixed retention boundary", expiresOneSecondEarly: "uses a fixed retention boundary",
  ignoresRetention: "honours the retention each claim asked for", caseSensitive: "canonicalizes UUID case",
  acceptsBadRetention: "rejects invalid tenant/key/retention", acceptsBadKeys: "rejects invalid tenant/key/retention", acceptsBadScope: "rejects invalid tenant/key/retention", recordsBeforeValidation: "rejects invalid tenant/key/retention",
  lenientTenantSpelling: "rejects a malformed tenant id", keyLimitByCharacters: "bounds keys at exactly 1024", keyLimitOffByOne: "bounds keys at exactly 1024", keyLimitAcceptsOneMore: "bounds keys at exactly 1024",
  acceptsLoneSurrogates: "refuses keys that are not well-formed",
};
const LIMITER: Record<string, string> = {
  nonAtomic: "never loses concurrent hits", limitOffByOne: "admits exactly `limit` sequential hits", neverRollsOver: "rolls over exactly", rolloverInclusive: "rolls over exactly", retryAfterWindow: "rolls over exactly",
  windowFromFirstHit: "anchors every window to the epoch", slidingOnDenial: "denied hits neither extend nor shift", retryAfterRounds: "reports retry-after", retryAfterFloors: "reports retry-after",
  ignoresTenant: "isolates tenant counts", tenantFromKeyText: "isolates tenant counts",
  blockReplaces: "blocks only the scoped key", blockInclusiveBoundary: "blocks only the scoped key", blockIgnoresTenant: "blocks only the scoped key", blockIgnoresKey: "blocks only the scoped key",
  blockKeepsFirst: "concurrent blocks preserve", exhaustedCounterBlocks: "keeps a counter and a block", blockDeniesHits: "keeps a counter and a block", caseSensitive: "canonicalizes UUID case",
  ruleChangeResets: "rejects changing rules", ruleChangeAccepted: "rejects changing rules",
  acceptsBadRule: "rejects invalid scope/key/rule", acceptsBadBlockSeconds: "rejects invalid scope/key/rule", acceptsBadKeys: "rejects invalid scope/key/rule", acceptsBadScope: "rejects invalid scope/key/rule",
  lenientTenantSpelling: "rejects a malformed tenant id", keyLimitByCharacters: "bounds keys at exactly 1024", keyLimitOffByOne: "bounds keys at exactly 1024", keyLimitAcceptsOneMore: "bounds keys at exactly 1024", acceptsLoneSurrogates: "bounds keys at exactly 1024",
};

function replayContext(fault?: string) {
  const clock = new FakeClock();
  return { store: new ReferenceReplay(clock, fault), advanceSeconds: async (seconds: number) => { clock.advance(seconds); } };
}
function limiterContext(fault?: string) {
  const clock = new FakeClock();
  return { store: new ReferenceLimiter(clock, fault), advanceSeconds: async (seconds: number) => { clock.advance(seconds); } };
}

describe("ReplayGuard conformance has teeth", () => {
  it.each(replayConformanceCases.map((entry) => [entry.name, entry] as [string, ReplayConformanceCase]))("a faithful reference passes: %s", async (_name, conformanceCase) => {
    await conformanceCase.run(replayContext());
  });
  it.each(Object.entries(REPLAY))("a replay guard with defect %s fails %s", async (fault, prefix) => {
    expect(await passes(find(replayConformanceCases, prefix), replayContext(fault))).toBe(false);
  });
  it("every replay case is failed by at least one defect", () => {
    const caught = new Set(Object.values(REPLAY).map((prefix) => find(replayConformanceCases, prefix).name));
    expect([...caught].sort()).toEqual(replayConformanceCases.map((entry) => entry.name).sort());
  });
});

describe("RateLimiter conformance has teeth", () => {
  it.each(rateLimiterConformanceCases.map((entry) => [entry.name, entry] as [string, RateLimiterConformanceCase]))("a faithful reference passes: %s", async (_name, conformanceCase) => {
    await conformanceCase.run(limiterContext());
  });
  it.each(Object.entries(LIMITER))("a rate limiter with defect %s fails %s", async (fault, prefix) => {
    expect(await passes(find(rateLimiterConformanceCases, prefix), limiterContext(fault))).toBe(false);
  });
  it("every rate limiter case is failed by at least one defect", () => {
    const caught = new Set(Object.values(LIMITER).map((prefix) => find(rateLimiterConformanceCases, prefix).name));
    expect([...caught].sort()).toEqual(rateLimiterConformanceCases.map((entry) => entry.name).sort());
  });
});
