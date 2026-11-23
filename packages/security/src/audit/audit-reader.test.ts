import { describe, expect, it } from "vitest";
import type { AuditEvent, AuditQuery } from "@dap/contracts";
import { AUDIT_EVENT_TYPES } from "@dap/contracts";
import { mintAuthorizationContext } from "@dap/contracts/mint";
import { InMemoryAuditStore } from "../state/memory/audit.js";
import { MAX_AUDIT_QUERY_LIMIT, createAuditReader } from "./audit-reader.js";
import type { AuditEventSource } from "./audit-reader.js";
import { buildAuditEvent } from "./event-builder.js";
import type { AuditEventInput } from "./event-builder.js";
import { context, run } from "../gateway/fixtures.test-support.js";

const TENANT_A = "00000000-0000-4000-8000-000000000001";
const TENANT_B = "00000000-0000-4000-8000-000000000002";
const ctxOf = (tenantId: string, userId: string) => mintAuthorizationContext({ userId, tenantId, sessionId: "s", authenticatedAt: "2026-01-01T00:00:00Z", validUntil: "2026-01-01T01:00:00Z" });
const idOf = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;
let n = 100;
const event = (overrides: { tenant?: string; user?: string; at?: string; requestId?: string; type?: AuditEventInput["type"] } = {}): AuditEvent => {
  const type = overrides.type ?? "AI_ACTION_DENIED";
  const extra: Partial<AuditEventInput> = type === "AI_ACTION_PROPOSED" ? {} : { outcome: "DENIED", reason: "permission_missing" };
  return buildAuditEvent({ type, id: idOf(++n), occurredAt: overrides.at ?? "2026-01-01T00:00:10Z", requestId: overrides.requestId ?? "req-1", decisionId: "dec-1", context: ctxOf(overrides.tenant ?? TENANT_A, overrides.user ?? "alice"), run, ...extra } as AuditEventInput);
};
const limit = (extra: Partial<AuditQuery> = {}): AuditQuery => ({ limit: 100, ...extra }) as AuditQuery;
async function world(events: AuditEvent[]) {
  const store = new InMemoryAuditStore();
  for (const e of events) await store.append(e);
  return { store, reader: createAuditReader(store) };
}
const reviewerA = () => ctxOf(TENANT_A, "reviewer");

describe("tenant scoping (ATK-XTENANT-09)", () => {
  it("a reviewer in tenant A sees only tenant A's events, and tenant B's reviewer only B's", async () => {
    const [a1, a2, b1] = [event(), event(), event({ tenant: TENANT_B, user: "bob" })];
    const { reader } = await world([a1, b1, a2]);
    expect(await reader.query(reviewerA(), limit())).toEqual([a1, a2]);
    expect(await reader.query(ctxOf(TENANT_B, "rev"), limit())).toEqual([b1]);
    expect(await reader.query(ctxOf("00000000-0000-4000-8000-0000000000ff", "rev"), limit())).toEqual([]);
  });

  it("asks the source for the context's tenant only", async () => {
    const asked: unknown[][] = [];
    const source: AuditEventSource = { listForTenant: (...args) => { asked.push(args); return []; } };
    await createAuditReader(source).query(reviewerA(), limit());
    expect(asked).toEqual([[TENANT_A]]);
  });

  it("drops anything a faulty source returns for another tenant", async () => {
    const [mine, theirs] = [event(), event({ tenant: TENANT_B })];
    const reader = createAuditReader({ listForTenant: () => [theirs, mine, theirs] });
    expect(await reader.query(reviewerA(), limit())).toEqual([mine]);
  });

  it("cannot be widened by a query field: there is no tenant in a query, and an unknown field is refused", async () => {
    const { reader } = await world([event({ tenant: TENANT_B })]);
    await expect(reader.query(reviewerA(), { ...limit(), tenantId: TENANT_B } as never)).rejects.toThrow("Invalid audit query");
    expect(await reader.query(reviewerA(), limit({ userId: "alice" as never }))).toEqual([]);
  });

  it.each([["a plain look-alike", { ...context() }], ["a clone", JSON.parse(JSON.stringify(context())) as unknown], ["null", null], ["undefined", undefined], ["a string", TENANT_A]])("refuses %s as the context, before reading anything", async (_name, ctx) => {
    let asked = 0;
    const reader = createAuditReader({ listForTenant: () => { asked++; return []; } });
    await expect(reader.query(ctx as never, limit())).rejects.toThrow("Audit queries need an authenticated context");
    expect(asked).toBe(0);
  });
});

describe("the query", () => {
  it.each([["no limit", {}], ["limit 0", { limit: 0 }], ["a negative limit", { limit: -1 }], ["a fractional limit", { limit: 1.5 }], ["a string limit", { limit: "10" }], ["NaN", { limit: Number.NaN }], ["Infinity", { limit: Number.POSITIVE_INFINITY }],
    ["a limit above the maximum", { limit: MAX_AUDIT_QUERY_LIMIT + 1 }], ["an empty requestId", { limit: 1, requestId: "" }], ["a numeric userId", { limit: 1, userId: 5 }], ["a non-ISO from", { limit: 1, from: "yesterday" }],
    ["a non-ISO to", { limit: 1, to: "2026-01-01" }], ["empty types", { limit: 1, types: [] }], ["an unknown type", { limit: 1, types: ["AI_SOMETHING"] }], ["too many types", { limit: 1, types: [...AUDIT_EVENT_TYPES, "AI_ACTION_DENIED"] }],
    ["from after to", { limit: 1, from: "2026-01-02T00:00:00Z", to: "2026-01-01T00:00:00Z" }], ["a query that is null", null], ["a query that is a string", "all"], ["an unknown field", { limit: 1, orderBy: "x" }]])("refuses %s, with a generic error", async (_name, query) => {
    const { reader } = await world([event()]);
    const refusal = reader.query(reviewerA(), query as never);
    await expect(refusal).rejects.toThrow(new TypeError("Invalid audit query"));
  });

  it("pins the maximum limit at 500: 500 is accepted, 501 refused", async () => {
    expect(MAX_AUDIT_QUERY_LIMIT).toBe(500);
    const { reader } = await world([event()]);
    expect(await reader.query(reviewerA(), limit({ limit: 500 }))).toHaveLength(1);
    await expect(reader.query(reviewerA(), limit({ limit: 501 }))).rejects.toThrow("Invalid audit query");
  });

  it("bounds the text filters at 256 characters", async () => {
    const { reader } = await world([event()]);
    expect(await reader.query(reviewerA(), limit({ requestId: "r".repeat(256) as never }))).toEqual([]);
    await expect(reader.query(reviewerA(), limit({ requestId: "r".repeat(257) as never }))).rejects.toThrow("Invalid audit query");
    await expect(reader.query(reviewerA(), limit({ userId: "u".repeat(257) as never }))).rejects.toThrow("Invalid audit query");
  });

  it("accepts the largest limit and every event type", async () => {
    const { reader } = await world([event()]);
    expect(await reader.query(reviewerA(), limit({ limit: MAX_AUDIT_QUERY_LIMIT, types: AUDIT_EVENT_TYPES }))).toHaveLength(1);
  });

  it("never echoes the query in the error", async () => {
    const { reader } = await world([]);
    const error = await reader.query(reviewerA(), { limit: 0, requestId: "CANARY_REQUEST" } as never).catch((e: Error) => e);
    expect((error as Error).message).not.toContain("CANARY");
  });

  it("filters by request id, user, type and an inclusive time range", async () => {
    const events = [
      event({ requestId: "r1", at: "2026-01-01T00:00:01Z" }), event({ requestId: "r1", user: "bob", at: "2026-01-01T00:00:02Z", type: "AI_ACTION_PROPOSED" }),
      event({ requestId: "r2", at: "2026-01-01T00:00:03Z" }), event({ requestId: "r2", user: "bob", at: "2026-01-01T00:00:04Z" }),
    ];
    const { reader } = await world(events);
    expect(await reader.query(reviewerA(), limit({ requestId: "r1" as never }))).toEqual([events[0], events[1]]);
    expect(await reader.query(reviewerA(), limit({ userId: "bob" as never }))).toEqual([events[1], events[3]]);
    expect(await reader.query(reviewerA(), limit({ types: ["AI_ACTION_PROPOSED"] }))).toEqual([events[1]]);
    expect(await reader.query(reviewerA(), limit({ types: ["AI_ACTION_PROPOSED", "AI_ACTION_DENIED"] }))).toHaveLength(4);
    expect(await reader.query(reviewerA(), limit({ from: "2026-01-01T00:00:02Z" as never }))).toEqual([events[1], events[2], events[3]]);
    expect(await reader.query(reviewerA(), limit({ to: "2026-01-01T00:00:02Z" as never }))).toEqual([events[0], events[1]]);
    expect(await reader.query(reviewerA(), limit({ from: "2026-01-01T00:00:02Z" as never, to: "2026-01-01T00:00:03Z" as never }))).toEqual([events[1], events[2]]);
    expect(await reader.query(reviewerA(), limit({ from: "2026-01-01T00:00:03Z" as never, to: "2026-01-01T00:00:03Z" as never }))).toEqual([events[2]]);
    expect(await reader.query(reviewerA(), limit({ requestId: "r2" as never, userId: "alice" as never, types: ["AI_ACTION_DENIED"] }))).toEqual([events[2]]);
  });

  it("compares instants as instants, across offsets", async () => {
    const early = event({ at: "2026-01-01T02:00:00+02:00" }); // 00:00Z
    const late = event({ at: "2026-01-01T00:30:00Z" });
    const { reader } = await world([late, early]);
    expect(await reader.query(reviewerA(), limit())).toEqual([early, late]);
    expect(await reader.query(reviewerA(), limit({ from: "2026-01-01T00:10:00Z" as never }))).toEqual([late]);
  });

  it("returns events oldest first, ties in commit order, and cuts at the limit after filtering", async () => {
    const [x, y, z, w] = [event({ at: "2026-01-01T00:00:05Z" }), event({ at: "2026-01-01T00:00:01Z" }), event({ at: "2026-01-01T00:00:05Z" }), event({ at: "2026-01-01T00:00:03Z" })];
    const { reader } = await world([x, y, z, w]);
    expect(await reader.query(reviewerA(), limit())).toEqual([y, w, x, z]);
    expect(await reader.query(reviewerA(), limit({ limit: 2 }))).toEqual([y, w]);
    expect(await reader.query(reviewerA(), limit({ limit: 1 }))).toEqual([y]);
    expect(await reader.query(reviewerA(), limit({ limit: 4 }))).toHaveLength(4);
    const other = event({ tenant: TENANT_B, at: "2026-01-01T00:00:00Z" });
    const mixed = createAuditReader({ listForTenant: () => [other, ...[x, y, z, w]] });
    expect(await mixed.query(reviewerA(), limit({ limit: 2 }))).toEqual([y, w]); // another tenant's event does not use up the limit
  });

  it("returns a frozen list", async () => {
    const { reader } = await world([event()]);
    expect(Object.isFrozen(await reader.query(reviewerA(), limit()))).toBe(true);
    expect(Object.isFrozen(reader)).toBe(true);
  });

  it("can answer what was attempted and why, tied by request id (SC-008)", async () => {
    const proposed = event({ requestId: "r9", type: "AI_ACTION_PROPOSED", at: "2026-01-01T00:00:01Z" });
    const decision = event({ requestId: "r9", at: "2026-01-01T00:00:02Z" });
    const { reader } = await world([decision, proposed]);
    const trail = await reader.query(reviewerA(), limit({ requestId: "r9" as never }));
    expect(trail.map((e) => [e.type, e.reason])).toEqual([["AI_ACTION_PROPOSED", null], ["AI_ACTION_DENIED", "permission_missing"]]);
  });
});

describe("a source that fails", () => {
  it.each([["throws", () => { throw new Error("CANARY"); }], ["rejects", () => Promise.reject(new Error("CANARY"))], ["answers undefined", () => undefined], ["answers an object", () => ({})], ["answers a string", () => "events"],
    ["answers elements that are not events", () => [null]], ["answers an element with a throwing getter", () => [{ get tenantId(): never { throw new Error("CANARY"); } }]]])("%s: a generic rejection", async (_name, listForTenant) => {
    const reader = createAuditReader({ listForTenant: listForTenant as never });
    const error = await reader.query(reviewerA(), limit()).catch((e: Error) => e);
    expect(error).toEqual(new TypeError("Audit source unavailable"));
    expect(String((error as Error).message)).not.toContain("CANARY");
  });

  it("drops an event whose instant cannot be read rather than guessing its place", async () => {
    const good = event();
    const broken = { ...event(), occurredAt: "garbage" } as AuditEvent;
    expect(await createAuditReader({ listForTenant: () => [broken, good] }).query(reviewerA(), limit())).toEqual([good]);
  });

  it.each([["no source", undefined], ["a source without listForTenant", {}], ["a listForTenant that is not a function", { listForTenant: 1 }]])("is refused at construction: %s", (_name, source) => {
    expect(() => createAuditReader(source as never)).toThrow("Missing audit source");
  });

  it("keeps the source's receiver", async () => {
    const receivers: unknown[] = [];
    const source = { listForTenant(this: unknown) { receivers.push(this); return []; } };
    await createAuditReader(source).query(reviewerA(), limit());
    expect(receivers).toEqual([source]);
  });
});
