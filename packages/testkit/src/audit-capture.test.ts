import { describe, expect, it } from "vitest";
import type { AuditEvent, IsoInstant, RequestId, RiskLevel, TenantId, UserId } from "@dap/contracts";
import { InMemoryAuditSink } from "./audit-capture.js";

// T033: in-memory AuditSink capturing events as deep-frozen copies.

function makeEvent(overrides: Partial<AuditEvent> = {}): AuditEvent {
  return {
    id: "evt-1",
    occurredAt: "2026-01-01T00:00:01.000Z" as IsoInstant,
    type: "AI_ACTION_ALLOWED",
    requestId: "req-1" as RequestId,
    decisionId: "dec-1",
    tenantId: "11111111-1111-4111-8111-111111111111" as TenantId,
    userId: "user-alice" as UserId,
    aiSessionId: "run-1",
    turnId: "turn-1",
    model: "model-x",
    actionId: "act-1",
    definitionVersion: 1,
    paramsView: { a: 1 },
    risk: "LOW" as RiskLevel,
    outcome: "ALLOWED",
    reason: "allowed",
    confirmationId: null,
    confirmationState: null,
    executionResult: null,
    resource: null,
    ...overrides,
  };
}

describe("InMemoryAuditSink", () => {
  it("captures events in append order", async () => {
    const sink = new InMemoryAuditSink();
    await sink.append(makeEvent({ id: "evt-1" }));
    await sink.append(makeEvent({ id: "evt-2", paramsView: { a: [1, 2] } }));
    await sink.append(makeEvent({ id: "evt-3" }));

    expect(sink.events.map((e) => e.id)).toEqual(["evt-1", "evt-2", "evt-3"]);
  });

  it("captures deep copies: mutating a returned event does not change the log", async () => {
    const sink = new InMemoryAuditSink();
    await sink.append(makeEvent({ id: "evt-1", paramsView: { nested: { a: 1 } } }));

    const events = sink.events;
    const returned = events[0]!;
    expect(Object.isFrozen(returned)).toBe(true);
    expect(Object.isFrozen(returned.paramsView.nested)).toBe(true);

    // Returned copies (and their elements) are frozen: no in-place mutation possible.
    expect(() => {
      (returned.paramsView as unknown as Record<string, unknown>).nested = "gone";
    }).toThrow(TypeError);

    // A shallow copy taken by the caller stays isolated from the log.
    const shallowCopy = { ...returned };
    shallowCopy.id = "tampered";
    expect(sink.events[0]?.id).toBe("evt-1");
  });

  it("returns a fresh copy of the list on every access", async () => {
    const sink = new InMemoryAuditSink();
    await sink.append(makeEvent({ id: "evt-1" }));

    const first = sink.events;
    (first as unknown[]).push(makeEvent({ id: "evt-forge" }));
    expect(sink.events).toHaveLength(1);
  });

  it("failAppend(true) makes append reject and leaves the log unchanged", async () => {
    const sink = new InMemoryAuditSink();
    await sink.append(makeEvent({ id: "evt-1" }));

    sink.failAppend(true);
    await expect(sink.append(makeEvent({ id: "evt-2" }))).rejects.toThrow(/audit append disabled/);
    await expect(sink.append(makeEvent({ id: "evt-3" }))).rejects.toThrow(/audit append disabled/);
    expect(sink.events).toHaveLength(1);
    expect(sink.events[0]?.id).toBe("evt-1");

    sink.failAppend(false);
    await expect(sink.append(makeEvent({ id: "evt-4" }))).resolves.toBeUndefined();
    expect(sink.events.map((e) => e.id)).toEqual(["evt-1", "evt-4"]);
  });
});
