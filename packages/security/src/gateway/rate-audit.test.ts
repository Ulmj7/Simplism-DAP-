import { describe, expect, it, vi } from "vitest";
import { InMemoryAuditStore } from "../state/memory/audit.js";
import { isBuiltAuditEvent } from "../audit/event-builder.js";
import { auditRateDenial } from "./rate-audit.js";
import { dependencies, input } from "./fixtures.test-support.js";
import { denyDecision } from "./decision.js";

describe("T117 rate-limit denial audit", () => {
  it("emits AI_RATE_LIMITED with trusted identity and no parameters", async () => {
    const { deps } = dependencies(); const append = vi.fn(async (event: unknown) => { void event; });
    const request = input(); const decision = denyDecision({ decisionId: request.decisionId, requestId: request.requestId, stage: "rate_limit", reason: "rate_limited_user" });
    await auditRateDenial({ ...deps, audit: { append } }, request, decision);
    expect(append).toHaveBeenCalledTimes(1);
    expect(append.mock.calls[0]![0]).toMatchObject({ type: "AI_RATE_LIMITED", tenantId: (request.context as { tenantId: string }).tenantId, userId: "alice", reason: "rate_limited_user", paramsView: {}, requestId: request.requestId });
  });
  it("uses the registered audit builder so a real sink accepts the rate event", async () => {
    const { deps } = dependencies(); const sink = new InMemoryAuditStore(); const request = input();
    const decision = denyDecision({ decisionId: request.decisionId, requestId: request.requestId, stage: "rate_limit", reason: "rate_limited_turn" });
    await auditRateDenial({ ...deps, audit: sink }, request, decision);
    const events = await sink.listForTenant(contextTenant(request.context));
    expect(events).toHaveLength(1);
    expect(isBuiltAuditEvent(events[0])).toBe(true);
  });
  it("ignores non-rate decisions and contains audit failures/hangs without changing denial", async () => {
    const { deps } = dependencies(); const append = vi.fn(async () => { throw new Error("audit down"); });
    const request = input(); const rate = denyDecision({ decisionId: request.decisionId, requestId: request.requestId, stage: "rate_limit", reason: "denial_throttle" });
    await expect(auditRateDenial({ ...deps, audit: { append } }, request, rate)).resolves.toBeUndefined();
    expect(rate.reason).toBe("denial_throttle");
    append.mockClear();
    await auditRateDenial({ ...deps, audit: { append } }, request, denyDecision({ decisionId: request.decisionId, requestId: request.requestId, stage: "replay", reason: "replayed_request" }));
    expect(append).not.toHaveBeenCalled();
    vi.useFakeTimers();
    try {
      const pending = auditRateDenial({ ...deps, audit: { append: () => new Promise(() => {}) } }, request, rate);
      await vi.advanceTimersByTimeAsync(2000); await expect(pending).resolves.toBeUndefined();
      expect(vi.getTimerCount()).toBe(0);
    } finally { vi.useRealTimers(); }
  });
});

const contextTenant = (value: unknown): string => (value as { tenantId: string }).tenantId;
