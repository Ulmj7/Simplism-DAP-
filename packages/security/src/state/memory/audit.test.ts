import { describe, expect, it } from "vitest";
import type { AuditEvent } from "@dap/contracts";
import { mintAuthorizationContext } from "@dap/contracts/mint";
import { buildAuditEvent } from "../../audit/event-builder.js";
import type { AuditEventInput } from "../../audit/event-builder.js";
import { context, run } from "../../gateway/fixtures.test-support.js";
import { InMemoryAuditStore } from "./audit.js";

const TENANT_B = "00000000-0000-4000-8000-000000000002";
const idOf = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
const eventOf = (n: number, overrides: Partial<AuditEventInput> = {}): AuditEvent => buildAuditEvent({ type: "AI_ACTION_DENIED", id: idOf(n), occurredAt: "2026-01-01T00:00:00Z", requestId: `req-${n}`, decisionId: `dec-${n}`, context: context(), run, outcome: "DENIED", reason: "permission_missing", ...overrides } as AuditEventInput);
const ctxB = () => mintAuthorizationContext({ userId: "bob", tenantId: TENANT_B, sessionId: "s", authenticatedAt: "2026-01-01T00:00:00Z", validUntil: "2026-01-01T01:00:00Z" });

describe("InMemoryAuditStore", () => {
  it("stores events in commit order, per tenant, and returns them from listForTenant", async () => {
    const store = new InMemoryAuditStore();
    const [a, b, c] = [eventOf(1), eventOf(2), eventOf(3, { context: ctxB() })];
    await store.append(a); await store.append(b); await store.append(c);
    expect(await store.listForTenant(context().tenantId)).toEqual([a, b]);
    expect(await store.listForTenant(TENANT_B)).toEqual([c]);
    expect(await store.listForTenant("00000000-0000-4000-8000-0000000000ff")).toEqual([]);
    expect(store.size).toBe(3);
  });

  it("is idempotent on the event id: the same event again leaves one row", async () => {
    const store = new InMemoryAuditStore();
    const event = eventOf(1);
    await store.append(event); await store.append(event); await store.append(event);
    expect(await store.listForTenant(context().tenantId)).toHaveLength(1);
    expect(store.size).toBe(1);
  });

  it("refuses an id reused with different content, and keeps the original", async () => {
    const store = new InMemoryAuditStore();
    const original = eventOf(1);
    await store.append(original);
    await expect(store.append(eventOf(1, { reason: "unknown_action", outcome: "INVALID_ACTION" }))).rejects.toThrow("An audit event id cannot be reused with different content");
    await expect(store.append(eventOf(1, { context: ctxB() }))).rejects.toThrow(TypeError);
    expect(await store.listForTenant(context().tenantId)).toEqual([original]);
    expect(await store.listForTenant(TENANT_B)).toEqual([]);
  });

  it.each([["a plain literal", { id: idOf(9), type: "AI_ACTION_DENIED" }], ["a copy of a built event", () => ({ ...eventOf(9) })], ["null", null], ["undefined", undefined], ["a string", "event"]])("refuses %s that the builder did not make", async (_name, imposter) => {
    const store = new InMemoryAuditStore();
    const value = typeof imposter === "function" ? (imposter as () => unknown)() : imposter;
    await expect(store.append(value as AuditEvent)).rejects.toThrow("Only built audit events can be appended");
    expect(store.size).toBe(0);
  });

  it("is append-only: the stored events are frozen, and the list is a copy", async () => {
    const store = new InMemoryAuditStore();
    await store.append(eventOf(1));
    const list = [...(await store.listForTenant(context().tenantId))];
    expect(Object.isFrozen(list[0])).toBe(true);
    list.length = 0;
    expect(await store.listForTenant(context().tenantId)).toHaveLength(1);
    expect(() => { (list as unknown as { tenantId: string }[]).push({ tenantId: "x" }); }).not.toThrow();
    expect(await store.listForTenant(context().tenantId)).toHaveLength(1);
    expect(Object.keys(store).includes("update")).toBe(false);
    expect((store as unknown as Record<string, unknown>).delete).toBeUndefined();
    expect((store as unknown as Record<string, unknown>).clear).toBeUndefined();
  });

  it("returns a distinct array on every call", async () => {
    const store = new InMemoryAuditStore();
    await store.append(eventOf(1));
    expect(await store.listForTenant(context().tenantId)).not.toBe(await store.listForTenant(context().tenantId));
  });
});
