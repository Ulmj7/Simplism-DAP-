/**
 * T074. The factory is the only door to an identity: strict principal, usable session, honest host ports, and an
 * output the Gateway can tell apart from a look-alike (ATK-ARCH-04). Every guard has a case that fails without it.
 */
import { describe, expect, it } from "vitest";
import type { AuthenticatedPrincipal, IsoInstant } from "@dap/contracts";
import { isMintedContext } from "@dap/contracts/mint";
import type { HookTimer } from "../gateway/hook-wrapper.js";
import { createSecurityContextFactory } from "./factory.js";

const TENANT = "00000000-0000-4000-8000-000000000001";
const NOW = "2026-01-01T00:30:00Z";
const principal = (overrides: Record<string, unknown> = {}): AuthenticatedPrincipal => ({ userId: "alice", tenantId: TENANT, sessionId: "session-1", authenticatedAt: "2026-01-01T00:00:00Z", validUntil: "2026-01-01T01:00:00Z", ...overrides }) as AuthenticatedPrincipal;

class ManualTimer implements HookTimer {
  time = 0; private next = 0;
  readonly pending = new Map<number, { at: number; callback: () => void }>();
  now(): number { return this.time; }
  setTimeout(callback: () => void, ms: number): number { const id = this.next++; this.pending.set(id, { at: this.time + ms, callback }); return id; }
  clearTimeout(handle: unknown): void { this.pending.delete(handle as number); }
  advance(ms: number): void { this.time += ms; for (const [id, entry] of [...this.pending]) if (entry.at <= this.time) { this.pending.delete(id); entry.callback(); } }
}
function factory(answer: unknown = principal(), clock: () => unknown = () => NOW, timer: HookTimer = new ManualTimer(), options: { hookTimeoutMs?: number } = {}) {
  const seen: unknown[] = [];
  const made = createSecurityContextFactory({ authentication: { authenticate: async (evidence: unknown) => { seen.push(evidence); return typeof answer === "function" ? (answer as () => unknown)() : answer; } } as never, clock: { now: clock as () => IsoInstant } }, { timer, ...options });
  return { establish: made.establish, seen };
}

describe("a valid principal", () => {
  it("yields a minted, frozen context with exactly the principal's five fields and no permissions", async () => {
    const { establish, seen } = factory();
    const ctx = await establish({ cookie: "evidence" });
    expect(ctx).toEqual({ userId: "alice", tenantId: TENANT, sessionId: "session-1", authenticatedAt: "2026-01-01T00:00:00Z", validUntil: "2026-01-01T01:00:00Z" });
    expect(Object.keys(ctx!).sort()).toEqual(["authenticatedAt", "sessionId", "tenantId", "userId", "validUntil"]);
    expect(Object.isFrozen(ctx)).toBe(true);
    expect(isMintedContext(ctx)).toBe(true);
    expect(seen).toEqual([{ cookie: "evidence" }]);
  });

  it("is recognized by identity: a plain literal, a spread copy and a clone are not (ATK-ARCH-04)", async () => {
    const ctx = (await factory().establish(undefined))!;
    expect(isMintedContext({ ...ctx })).toBe(false);
    expect(isMintedContext(JSON.parse(JSON.stringify(ctx)))).toBe(false);
    expect(isMintedContext(Object.create(ctx))).toBe(false);
    expect(isMintedContext(principal())).toBe(false);
    expect(isMintedContext(ctx)).toBe(true);
  });

  it("mints a new context for every call", async () => {
    const { establish } = factory();
    expect(await establish(1)).not.toBe(await establish(1));
  });

  it("returns frozen factory", () => {
    const made = createSecurityContextFactory({ authentication: { authenticate: async () => null }, clock: { now: () => NOW as IsoInstant } });
    expect(Object.isFrozen(made)).toBe(true);
    expect(Object.isFrozen(made.establish)).toBe(true);
  });

  it("accepts identifiers up to 256 characters and an offset instant", async () => {
    const ctx = await factory(principal({ userId: "u".repeat(256), sessionId: "s".repeat(256), authenticatedAt: "2026-01-01T02:00:00+02:00", validUntil: "2026-01-01T03:30:00+02:00" })).establish(0);
    expect(isMintedContext(ctx)).toBe(true);
  });
});

describe("an unauthenticated or malformed principal is null", () => {
  const bad: [string, unknown][] = [
    ["null", null], ["undefined", undefined], ["a string", "alice"], ["an array", [principal()]], ["a number", 7], ["an empty object", {}],
    ["a missing userId", (() => { const { userId: _u, ...rest } = principal(); void _u; return rest; })()], ["a missing tenantId", (() => { const { tenantId: _t, ...rest } = principal(); void _t; return rest; })()],
    ["a missing sessionId", (() => { const { sessionId: _s, ...rest } = principal(); void _s; return rest; })()], ["a missing authenticatedAt", (() => { const { authenticatedAt: _a, ...rest } = principal(); void _a; return rest; })()],
    ["a missing validUntil", (() => { const { validUntil: _v, ...rest } = principal(); void _v; return rest; })()],
    ["an extra field", principal({ roles: ["admin"] })], ["an extra permissions field", principal({ permissions: ["*"] })], ["a numeric userId", principal({ userId: 1 })], ["an empty userId", principal({ userId: "" })],
    ["a numeric sessionId", principal({ sessionId: 1 })], ["an empty sessionId", principal({ sessionId: "" })], ["an overlong userId", principal({ userId: "u".repeat(257) })], ["an overlong sessionId", principal({ sessionId: "s".repeat(257) })],
    ["a userId with a newline", principal({ userId: "alice\nbob" })], ["a userId with a NUL", principal({ userId: "alice\u0000" })], ["a userId with DEL", principal({ userId: "alice\u007f" })], ["a userId with a C1 control", principal({ userId: "alice\u0085" })],
    ["a userId with a line separator", principal({ userId: "alice\u2028bob" })], ["a userId with a paragraph separator", principal({ userId: "alice\u2029bob" })], ["a sessionId with a newline", principal({ sessionId: "s\n1" })],
    ["a tenant that is not a UUID", principal({ tenantId: "acme" })], ["a numeric tenant", principal({ tenantId: 1 })], ["an empty tenant", principal({ tenantId: "" })], ["the nil UUID", principal({ tenantId: "00000000-0000-0000-0000-000000000000" })],
    ["an upper-case tenant UUID", principal({ tenantId: "ABCDEF00-0000-4000-8000-000000000001" })], ["a mixed-case tenant UUID", principal({ tenantId: "abcdef00-0000-4000-8000-00000000000A" })], ["a tenant UUID with a suffix", principal({ tenantId: `${TENANT}x` })], ["a braced tenant UUID", principal({ tenantId: `{${TENANT}}` })],
    ["an authenticatedAt that is not ISO", principal({ authenticatedAt: "yesterday" })], ["an epoch authenticatedAt", principal({ authenticatedAt: 1767225600 })], ["a date-only authenticatedAt", principal({ authenticatedAt: "2026-01-01" })],
    ["an authenticatedAt without a zone", principal({ authenticatedAt: "2026-01-01T00:00:00" })], ["a validUntil that is not ISO", principal({ validUntil: "tomorrow" })], ["a validUntil without a zone", principal({ validUntil: "2026-01-01T01:00:00" })],
    ["an impossible date", principal({ validUntil: "2026-02-30T01:00:00Z" })], ["a Date object", principal({ validUntil: new Date("2026-01-01T01:00:00Z") })],
  ];
  it.each(bad)("%s", async (_name, answer) => {
    expect(await factory(() => answer).establish(undefined)).toBeNull();
  });

  it("accepts a lower-case tenant UUID with hex letters", async () => {
    expect(isMintedContext(await factory(principal({ tenantId: "abcdef00-0000-4000-8000-00000000000a" })).establish(0))).toBe(true);
  });
});

describe("a session that is not usable now is null", () => {
  it.each([
    ["expired", { validUntil: "2026-01-01T00:10:00Z" }], ["expiring at this very instant", { validUntil: NOW }], ["not begun yet", { authenticatedAt: "2026-01-01T00:30:01Z" }],
    ["ending before it began", { authenticatedAt: "2026-01-01T00:20:00Z", validUntil: "2026-01-01T00:10:00Z" }], ["ending when it began", { authenticatedAt: "2026-01-01T00:20:00Z", validUntil: "2026-01-01T00:20:00Z" }],
    ["expired in another zone", { validUntil: "2026-01-01T02:00:00+02:00" }],
  ])("%s", async (_name, overrides) => {
    expect(await factory(principal(overrides)).establish(undefined)).toBeNull();
  });

  it("is judged against the host clock at the moment of the call, not at construction", async () => {
    let instant = NOW;
    const { establish } = factory(principal(), () => instant);
    expect(isMintedContext(await establish(0))).toBe(true);
    instant = "2026-01-01T01:00:00Z";
    expect(await establish(0)).toBeNull();
  });

  it("accepts a session that began exactly now", async () => {
    expect(isMintedContext(await factory(principal({ authenticatedAt: NOW })).establish(0))).toBe(true);
  });

  it("is null when the clock cannot tell the time", async () => {
    for (const reading of [undefined, null, 5, "not a time", "2026-01-01", { toString: () => NOW }]) expect(await factory(principal(), () => reading).establish(0), String(reading)).toBeNull();
    expect(await factory(principal(), () => { throw new Error("clock down"); }).establish(0)).toBeNull();
    expect(await factory(principal(), () => Promise.reject(new Error("clock down"))).establish(0)).toBeNull();
  });
});

describe("a faulty authentication port is null and never leaks", () => {
  it.each([
    ["a throw", () => { throw new Error("CANARY_SECRET"); }], ["a rejection", () => Promise.reject(new Error("CANARY_SECRET"))], ["a getter that throws", () => ({ get userId(): string { throw new Error("CANARY_SECRET"); } })],
    ["a function", () => () => principal()], ["a proxy that throws", () => new Proxy({}, { get() { throw new Error("CANARY_SECRET"); }, ownKeys() { throw new Error("CANARY_SECRET"); } })],
  ])("%s", async (_name, answer) => {
    await expect(factory(answer).establish(0)).resolves.toBeNull();
  });

  it("is null when the port hangs, at exactly hookTimeoutMs, and the timer is cleared", async () => {
    const timer = new ManualTimer();
    const { establish } = factory(() => new Promise(() => {}), () => NOW, timer, { hookTimeoutMs: 50 });
    let settled = false;
    const pending = establish(0).then((ctx) => { settled = true; return ctx; });
    await Promise.resolve();
    timer.advance(49); await Promise.resolve();
    expect(settled).toBe(false);
    timer.advance(1);
    expect(await pending).toBeNull();
    expect(timer.pending.size).toBe(0);
  });

  it("is null when the clock hangs", async () => {
    const timer = new ManualTimer();
    const { establish } = factory(principal(), () => new Promise(() => {}), timer, { hookTimeoutMs: 50 });
    const pending = establish(0);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(timer.pending.size).toBe(1); // the clock call is guarded by THIS timer and timeout, not a default
    const [guard] = [...timer.pending.values()];
    expect(guard!.at).toBe(50);
    timer.advance(50);
    expect(await pending).toBeNull();
    expect(timer.pending.size).toBe(0);
  });

  it("does not take a late answer", async () => {
    const timer = new ManualTimer();
    let release!: (value: unknown) => void;
    const { establish } = factory(() => new Promise((resolve) => { release = resolve; }), () => NOW, timer, { hookTimeoutMs: 50 });
    const pending = establish(0);
    await Promise.resolve();
    timer.advance(50);
    release(principal());
    expect(await pending).toBeNull();
  });
});

describe("construction", () => {
  const clock = { now: () => NOW as IsoInstant };
  it.each([["no authentication port", undefined], ["a port without authenticate", {}], ["a port whose authenticate is not a function", { authenticate: 1 }]])("throws for %s", (_name, authentication) => {
    expect(() => createSecurityContextFactory({ authentication: authentication as never, clock })).toThrow("Missing security context dependency");
  });
  it.each([["no clock", undefined], ["a clock without now", {}], ["a clock whose now is not a function", { now: "x" }]])("throws for %s", (_name, bad) => {
    expect(() => createSecurityContextFactory({ authentication: { authenticate: async () => null }, clock: bad as never })).toThrow("Missing security context dependency");
  });

  it("reads each port method once: a host that swaps its methods afterwards changes nothing", async () => {
    const authentication = { authenticate: async () => principal() as AuthenticatedPrincipal | null };
    const hostClock = { now: () => NOW as IsoInstant };
    const made = createSecurityContextFactory({ authentication, clock: hostClock });
    authentication.authenticate = async () => principal({ userId: "mallory" });
    hostClock.now = () => "2030-01-01T00:00:00Z" as IsoInstant;
    expect(await made.establish(0)).toMatchObject({ userId: "alice" });
  });

  it("keeps the host's receiver for both ports", async () => {
    const receivers: unknown[] = [];
    const authentication = { async authenticate(this: unknown) { receivers.push(this); return principal(); } };
    const hostClock = { now(this: unknown) { receivers.push(this); return NOW as IsoInstant; } };
    await createSecurityContextFactory({ authentication, clock: hostClock }).establish(0);
    expect(receivers).toEqual([authentication, hostClock]);
  });

  it("passes the evidence through untouched, and only the evidence", async () => {
    const evidence = { cookie: "c" };
    const calls: unknown[][] = [];
    const made = createSecurityContextFactory({ authentication: { authenticate: async (...args: unknown[]) => { calls.push(args); return principal(); } } as never, clock: { now: () => NOW as IsoInstant } });
    await made.establish(evidence);
    expect(calls).toHaveLength(1);
    expect(calls[0]).toHaveLength(1);
    expect(calls[0]![0]).toBe(evidence);
  });
});

describe("identifiers a log line or an audit record can be forged with are refused", () => {
  const confusable = [
    ["a bidirectional override", "alice\u202e"], ["a zero-width space", "al\u200bice"], ["a byte-order mark", "\ufeffalice"], ["a soft hyphen", "al\u00adice"],
    ["a joiner", "al\u200dice"], ["a lone high surrogate", "al\ud800ice"], ["a lone low surrogate", "\udc00"], ["a private-use character", "al\ue000ice"],
    ["an unassigned code point", "al\u0378ice"], ["a no-break space", "al\u00a0ice"], ["an ideographic space", "al\u3000ice"], ["only spaces", "   "],
    ["a leading space", " alice"], ["a trailing space", "alice "], ["a tab", "a\tb"], ["a next-line character", "a\u0085b"], ["a line separator", "a\u2028b"],
  ] as const;
  it.each(confusable)("userId with %s is null", async (_name, userId) => {
    expect(await factory(principal({ userId })).establish({})).toBeNull();
  });
  it.each(confusable)("sessionId with %s is null", async (_name, sessionId) => {
    expect(await factory(principal({ sessionId })).establish({})).toBeNull();
  });
  it.each([["a plain id", "alice"], ["a single character", "a"], ["an email", "alice@example.com"], ["an id with an inner space", "Alice Smith"], ["an accented name", "Zoë Müller"], ["a CJK name", "山田太郎"], ["an emoji", "alice\u{1F600}"], ["a uuid", "123e4567-e89b-12d3-a456-426614174000"]])("userId that is %s stays valid", async (_name, userId) => {
    expect(await factory(principal({ userId, sessionId: userId })).establish({})).toMatchObject({ userId, sessionId: userId });
  });
});
