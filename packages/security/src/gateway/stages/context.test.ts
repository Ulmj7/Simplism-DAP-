import { describe, expect, it, vi, afterEach } from "vitest";
import type { AuthorizationContext, Clock } from "@dap/contracts";
import { mintAuthorizationContext } from "@dap/contracts/mint";
import { createContextStage, sessionVerdict } from "./context.js";
import { createPipeline } from "../pipeline.js";
import { context, input, stageMap } from "../fixtures.test-support.js";

afterEach(() => { vi.useRealTimers(); });
describe("minted context stage", () => {
  async function check(ctx: unknown, clock: Clock = { now: () => "2026-01-01T00:00:00Z" as never }) {
    let observations = 0;
    const stages = stageMap(() => { throw new Error("No execution without a receipt"); });
    stages.audit = () => { observations++; return { kind: "continue", data: {} }; };
    stages.context = createContextStage(clock, { hookTimeoutMs: 20 });
    const decision = await createPipeline(stages).run({ ...input(), context: ctx, readProposal: () => { throw new Error("proposal must not be read"); } });
    return { decision, observations };
  }
  it.each([null, undefined, {}, { ...context() }, new Proxy(context(), {})])("rejects a non-minted context %j", async (ctx) => {
    const { decision, observations } = await check(ctx);
    expect(decision).toMatchObject({ outcome: "UNAUTHORIZED", reason: "unauthenticated", stage: "context" });
    expect(observations).toBe(0);
  });
  it("never reads properties on a forged context", async () => {
    let reads = 0;
    const ctx = { get userId() { reads++; throw new Error("CANARY"); } } as unknown as AuthorizationContext;
    const result = await check(ctx);
    expect(result.decision.outcome).toBe("UNAUTHORIZED");
    expect(result.observations).toBe(0);
    expect(reads).toBe(0);
  });
  it.each(["2026-01-01T01:00:00Z", "2026-01-01T02:00:00Z"])("denies at or after expiry %s", async (time) => {
    const { decision, observations } = await check(context(), { now: () => time as never });
    expect(decision).toMatchObject({ outcome: "UNAUTHORIZED", reason: "session_expired" });
    expect(observations).toBe(0);
  });
  const minted = (authenticatedAt: string, validUntil: string) => mintAuthorizationContext({ userId: "alice", tenantId: "00000000-0000-4000-8000-000000000001", sessionId: "session", authenticatedAt: authenticatedAt as never, validUntil: validUntil as never });
  it.each([
    ["authenticated after the clock reading", "2026-01-01T00:00:01Z", "2026-01-01T01:00:00Z"],
    ["valid-until before authentication", "2025-12-31T23:00:00Z", "2025-12-31T22:00:00Z"],
    ["valid-until equal to authentication", "2025-12-31T23:00:00Z", "2025-12-31T23:00:00Z"],
    ["unparseable instants", "never", "forever"],
  ])("a minted context with an incoherent validity window (%s) is unauthenticated", async (_label, authenticatedAt, validUntil) => {
    const { decision, observations } = await check(minted(authenticatedAt, validUntil));
    expect(decision).toMatchObject({ outcome: "UNAUTHORIZED", reason: "unauthenticated", stage: "context" });
    expect(observations).toBe(0);
  });
  it("accepts a context authenticated exactly at the clock reading", async () => {
    const result = await check(minted("2026-01-01T00:00:00Z", "2026-01-01T01:00:00Z"));
    expect(result.decision).toMatchObject({ outcome: "DENIED", reason: "dependency_failure", stage: "execute" });
    expect(result.observations).toBe(1);
  });
  it("accepts the original minted identity before expiry", async () => {
    const result = await check(context());
    expect(result.decision).toMatchObject({ outcome: "DENIED", reason: "dependency_failure", stage: "execute" });
    expect(result.observations).toBe(1);
  });
  it.each([undefined, null, 1, "yesterday"])("malformed clock %j denies", async (value) => {
    const { decision, observations } = await check(context(), { now: () => value } as Clock);
    expect(decision).toMatchObject({ outcome: "DENIED", reason: "dependency_failure" });
    expect(observations).toBe(0);
  });
  it("fails closed locally if a clock reading cannot be turned into a time", async () => {
    const reading = "2026-01-01T00:00:00.5Z";
    const original = Date.parse.bind(Date);
    const spy = vi.spyOn(Date, "parse").mockImplementation((text) => (text === reading ? Number.NaN : original(text)));
    try {
      const { decision, observations } = await check(context(), { now: () => reading as never });
      expect(decision).toMatchObject({ outcome: "DENIED", reason: "dependency_failure", stage: "context" });
      expect(observations).toBe(0);
    } finally { spy.mockRestore(); }
  });
  it("contains a throwing clock", async () => {
    const { decision, observations } = await check(context(), { now: () => { throw new Error("CANARY"); } });
    expect(decision).toMatchObject({ outcome: "DENIED", reason: "dependency_failure" });
    expect(observations).toBe(0);
    expect(JSON.stringify(decision)).not.toContain("CANARY");
  });
  it("times out a clock that violates its synchronous contract", async () => {
    vi.useFakeTimers();
    const pending = check(context(), { now: () => new Promise(() => {}) } as unknown as Clock);
    await vi.advanceTimersByTimeAsync(20);
    const { decision, observations } = await pending;
    expect(decision).toMatchObject({ outcome: "DENIED", reason: "dependency_failure" });
    expect(observations).toBe(0);
  });
});

describe("sessionVerdict: the one place a session's usability is decided", () => {
  const at = (iso: string) => Date.parse(iso);
  const session = { authenticatedAt: "2026-01-01T00:00:00Z", validUntil: "2026-01-01T01:00:00Z" };
  it.each([
    ["inside the window", "2026-01-01T00:30:00Z", "ok"], ["the instant it began", "2026-01-01T00:00:00Z", "ok"], ["one ms before expiry", "2026-01-01T00:59:59.999Z", "ok"],
    ["the instant it expires", "2026-01-01T01:00:00Z", "session_expired"], ["after expiry", "2026-01-01T02:00:00Z", "session_expired"], ["before it began", "2025-12-31T23:59:59.999Z", "unauthenticated"],
  ])("%s", (_name, now, expected) => {
    expect(sessionVerdict(session, at(now))).toBe(expected);
  });

  it.each([
    ["validUntil before authenticatedAt", { authenticatedAt: "2026-01-01T00:30:00Z", validUntil: "2026-01-01T00:10:00Z" }], ["validUntil equal to authenticatedAt", { authenticatedAt: "2026-01-01T00:30:00Z", validUntil: "2026-01-01T00:30:00Z" }],
  ])("%s is unauthenticated even when the session would otherwise be live, or expired", (_name, odd) => {
    expect(sessionVerdict(odd, at("2026-01-01T00:20:00Z"))).toBe("unauthenticated");
    expect(sessionVerdict(odd, at("2026-01-01T05:00:00Z"))).toBe("unauthenticated");
  });

  it.each([["an unparseable validUntil", { ...session, validUntil: "never" }], ["an unparseable authenticatedAt", { ...session, authenticatedAt: "once" }], ["an empty validUntil", { ...session, validUntil: "" }], ["both unparseable", { authenticatedAt: "a", validUntil: "b" }]])(
    "%s is unauthenticated, never usable", (_name, odd) => {
      expect(sessionVerdict(odd, at("2026-01-01T00:30:00Z"))).toBe("unauthenticated");
      expect(sessionVerdict(odd, at("2030-01-01T00:30:00Z"))).toBe("unauthenticated");
    });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])("a reading of %s is unauthenticated", (now) => {
    expect(sessionVerdict(session, now)).toBe("unauthenticated");
  });
});
