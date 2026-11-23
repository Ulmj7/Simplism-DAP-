import { randomUUID } from "node:crypto";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { AuditEvent, AuditSink } from "@dap/contracts";
import { mintAuthorizationContext } from "@dap/contracts/mint";
import { createAuditReader } from "../../audit/audit-reader.js";
import type { AuditEventSource } from "../../audit/audit-reader.js";
import { buildAuditEvent } from "../../audit/event-builder.js";
import type { AuditEventInput } from "../../audit/event-builder.js";

export interface AuditTestContext {
  /** The store under test: an AuditSink and the tenant-scoped source behind the reviewer reader. */
  readonly store: AuditSink & AuditEventSource;
  readonly dispose?: () => Promise<void>;
}
/** One conformance property. Exported as data so a deliberately broken adapter can prove the property can fail. */
export interface AuditConformanceCase {
  readonly name: string;
  readonly run: (ctx: AuditTestContext) => Promise<void>;
}

const tenant = (): string => randomUUID();
const minted = (tenantId: string, userId = "alice") => mintAuthorizationContext({ userId, tenantId, sessionId: "s", authenticatedAt: "2026-01-01T00:00:00Z", validUntil: "2026-01-01T01:00:00Z" });
const run = { aiSessionId: "session-1", turnId: "turn-1", model: "scripted" } as const;
/** A built event (the only kind a store accepts). Every call is a new id unless `id` is given. */
export function auditEvent(tenantId: string, over: Partial<Omit<AuditEventInput, "context">> & { user?: string } = {}): AuditEvent {
  const { user, ...rest } = over;
  const type = rest.type ?? "AI_ACTION_DENIED";
  const decision: Partial<AuditEventInput> = type === "AI_ACTION_PROPOSED" ? {} : { outcome: "DENIED", reason: "permission_missing" };
  return buildAuditEvent({ type, id: randomUUID(), occurredAt: "2026-01-01T00:00:10.000Z", requestId: "req-1", decisionId: "dec-1", context: minted(tenantId, user), run, action: { kind: "registered", id: "testSafeEcho", version: 1 }, risk: "SAFE", ...decision, ...rest });
}
const times = (index: number) => new Date(Date.parse("2026-01-01T00:00:10.000Z") + index * 1000).toISOString();

export const auditConformanceCases: readonly AuditConformanceCase[] = [
  {
    name: "round-trips every field, nullable ones included, for the events the Gateway writes",
    async run({ store }) {
      const t = tenant();
      const events = [
        auditEvent(t, { type: "AI_ACTION_PROPOSED", occurredAt: times(0), action: { kind: "attempted", name: "someAction" }, risk: undefined as never }),
        auditEvent(t, { type: "AI_ACTION_PROPOSED", occurredAt: times(1), action: undefined as never, risk: undefined as never }),
        auditEvent(t, { occurredAt: times(2), type: "AI_ACTION_ALLOWED", outcome: "ALLOWED", reason: "allowed", paramsView: { "/message": "hello", "/draft": "[masked]", "/nested": { a: [1, true, null, "x"] } }, resource: { type: "document", id: "doc-1" } }),
        auditEvent(t, { occurredAt: times(3), type: "AI_ACTION_EXECUTED", outcome: "ALLOWED", reason: "allowed", executionResult: "failure", resource: { type: "document", id: "doc-1" } }),
        auditEvent(t, { occurredAt: times(4), type: "AI_CONFIRMATION_REQUIRED", outcome: "REQUIRES_CONFIRMATION", reason: "confirmation_required", risk: "HIGH", confirmation: { id: randomUUID(), state: "pending" } }),
        auditEvent(t, { occurredAt: times(5), reason: "unknown_action", outcome: "INVALID_ACTION", action: { kind: "attempted", name: "missingOne" }, risk: undefined as never }),
      ];
      for (const event of events) await store.append(event);
      expect(await store.listForTenant(t)).toEqual(events);
      expect(events.some((event) => event.actionId === null && event.risk === null && event.resource === null && event.confirmationId === null && event.executionResult === null)).toBe(true); // the nullable fields really were exercised
    },
  },
  {
    name: "is idempotent on the event id: the same event again is a no-op success and leaves one row",
    async run({ store }) {
      const t = tenant(); const event = auditEvent(t);
      await store.append(event);
      await store.append(event);
      await store.append(event);
      expect(await store.listForTenant(t)).toEqual([event]);
    },
  },
  {
    name: "rejects a different body under the same id, and the stored event is unchanged",
    async run({ store }) {
      const t = tenant(); const id = randomUUID();
      const first = auditEvent(t, { id, reason: "permission_missing" });
      await store.append(first);
      await expect(store.append(auditEvent(t, { id, reason: "unknown_action", outcome: "INVALID_ACTION" }))).rejects.toThrow();
      await expect(store.append(auditEvent(t, { id, occurredAt: times(9) }))).rejects.toThrow();
      await expect(store.append(auditEvent(t, { id, user: "mallory" }))).rejects.toThrow();
      expect(await store.listForTenant(t)).toEqual([first]);
    },
  },
  {
    name: "does not let another tenant reuse an id: it is rejected and the owner's event is untouched",
    async run({ store }) {
      const a = tenant(); const b = tenant(); const id = randomUUID();
      const mine = auditEvent(a, { id });
      await store.append(mine);
      await expect(store.append(auditEvent(b, { id }))).rejects.toThrow();
      expect(await store.listForTenant(a)).toEqual([mine]);
      expect(await store.listForTenant(b)).toEqual([]);
    },
  },
  {
    name: "accepts only events made by the builder: a hand-made copy is refused and stores nothing",
    async run({ store }) {
      const t = tenant(); const event = auditEvent(t);
      for (const forged of [{ ...event, id: randomUUID() }, JSON.parse(JSON.stringify({ ...event, id: randomUUID() })), null, undefined, "event", 7]) {
        await expect(store.append(forged as AuditEvent)).rejects.toThrow();
      }
      expect(await store.listForTenant(t)).toEqual([]);
    },
  },
  {
    name: "answers for the asked tenant only, and a tenant with no events reads empty",
    async run({ store }) {
      const a = tenant(); const b = tenant();
      const [ea, eb] = [auditEvent(a, { requestId: "shared-request" }), auditEvent(b, { requestId: "shared-request" })];
      await store.append(ea); await store.append(eb);
      expect(await store.listForTenant(a)).toEqual([ea]);
      expect(await store.listForTenant(b)).toEqual([eb]);
      expect(await store.listForTenant(tenant())).toEqual([]);
    },
  },
  {
    name: "returns a tenant's events in time order, ties in commit order, deterministically",
    async run({ store }) {
      const t = tenant();
      const events = [0, 1, 1, 1, 2, 3].map((slot) => auditEvent(t, { occurredAt: times(slot) }));
      for (const event of events) await store.append(event);
      expect(await store.listForTenant(t)).toEqual(events);
      expect(await store.listForTenant(t)).toEqual(events);
    },
  },
  {
    name: "behind the reviewer reader: the limit is enforced, filters apply, and a tenant cannot read another's events even by request id",
    async run({ store }) {
      const a = tenant(); const b = tenant();
      const mine = Array.from({ length: 6 }, (_, index) => auditEvent(a, { occurredAt: times(index), requestId: index % 2 === 0 ? "req-even" : "req-odd" }));
      const theirs = auditEvent(b, { requestId: "req-b-only" });
      for (const event of [...mine, theirs]) await store.append(event);
      const reader = createAuditReader(store);
      expect(await reader.query(minted(a, "reviewer"), { limit: 4 })).toEqual(mine.slice(0, 4));
      expect(await reader.query(minted(a, "reviewer"), { limit: 100, requestId: "req-even" as never })).toEqual([mine[0], mine[2], mine[4]]);
      expect(await reader.query(minted(a, "reviewer"), { limit: 100, requestId: "req-b-only" as never })).toEqual([]);
      expect(await reader.query(minted(b, "reviewer"), { limit: 100 })).toEqual([theirs]);
      await expect(reader.query(minted(a, "reviewer"), { limit: 0 })).rejects.toThrow();
      await expect(reader.query(minted(a, "reviewer"), {} as never)).rejects.toThrow();
    },
  },
];

export function runAuditConformance(makeStore: () => Promise<AuditTestContext>): void {
  describe("AuditSink conformance", () => {
    let ctx: AuditTestContext;
    beforeEach(async () => { ctx = await makeStore(); });
    afterEach(async () => { await ctx?.dispose?.(); });
    for (const item of auditConformanceCases) it(item.name, async () => { await item.run(ctx); });
  });
}
