/**
 * @dap/security: audit/audit-reader.ts
 *
 * T092 / FR-042, SC-008. The reviewer path: `AuditReader.query(ctx, q)`, tenant-scoped by the MINTED context. It is for people who review
 * the trail, not for the AI layer, which has no reader at all (ATK-AUDIT-07).
 *
 * - The tenant is taken from the context only: the source is asked for that tenant alone, and anything it returns for another tenant
 *   is dropped (a faulty or hostile source cannot widen the scope).
 * - `limit` is required: a positive integer, at most `MAX_AUDIT_QUERY_LIMIT`. Unknown or malformed query fields are refused.
 * - Events come back oldest first (by `occurredAt`, ties in commit order), filtered, then cut at `limit`.
 * - A refused query rejects with a generic TypeError that never echoes the query.
 */
import { z } from "zod";
import { AUDIT_EVENT_TYPES } from "@dap/contracts";
import type { AuditEvent, AuditQuery, AuditReader, AuthorizationContext } from "@dap/contracts";
import { isMintedContext } from "@dap/contracts/mint";
import { snapshotAnswer } from "../gateway/answer-snapshot.js";

export const MAX_AUDIT_QUERY_LIMIT = 500;

/** Where events are read from; the in-memory store implements it, and PostgreSQL will. Asked for ONE tenant. */
export interface AuditEventSource {
  /** Optional bounded backend query; the reader still rechecks every returned event. */
  queryForTenant?(tenantId: string, query: AuditQuery): Promise<readonly AuditEvent[]> | readonly AuditEvent[];
  listForTenant(tenantId: string): Promise<readonly AuditEvent[]> | readonly AuditEvent[];
}

const text = z.string().min(1).max(256);
const instant = z.iso.datetime({ offset: true });
const querySchema = z.strictObject({
  requestId: text.optional(), userId: text.optional(), from: instant.optional(), to: instant.optional(),
  types: z.array(z.enum(AUDIT_EVENT_TYPES)).min(1).max(AUDIT_EVENT_TYPES.length).optional(),
  limit: z.number().int().min(1).max(MAX_AUDIT_QUERY_LIMIT),
});

export function createAuditReader(source: AuditEventSource): AuditReader {
  const list: unknown = source?.listForTenant;
  if (typeof list !== "function") throw new TypeError("Missing audit source");
  const listForTenant = list as AuditEventSource["listForTenant"];
  const bounded = source.queryForTenant;
  if (bounded !== undefined && typeof bounded !== "function") throw new TypeError("Invalid bounded audit source");
  return Object.freeze({
    query: Object.freeze(async (ctx: AuthorizationContext, q: AuditQuery): Promise<readonly AuditEvent[]> => {
      if (!isMintedContext(ctx)) throw new TypeError("Audit queries need an authenticated context");
      const parsed = querySchema.safeParse(q);
      if (!parsed.success) throw new TypeError("Invalid audit query");
      const query = parsed.data;
      const from = query.from === undefined ? undefined : Date.parse(query.from);
      const to = query.to === undefined ? undefined : Date.parse(query.to);
      if (from !== undefined && to !== undefined && from > to) throw new TypeError("Invalid audit query");
      const tenantId = ctx.tenantId;
      let candidates: readonly AuditEvent[];
      try { candidates = await (bounded === undefined ? Reflect.apply(listForTenant, source, [tenantId]) : Reflect.apply(bounded, source, [tenantId, query])) as readonly AuditEvent[]; } catch { throw new TypeError("Audit source unavailable"); }
      const types = query.types === undefined ? undefined : new Set<string>(query.types);
      let matching: { readonly event: AuditEvent }[];
      try {
        const captured = snapshotAnswer(candidates) as readonly AuditEvent[];
        matching = captured
        .map((event) => ({ event, at: Date.parse(event.occurredAt) }))
        .filter(({ event, at }) => event.tenantId === tenantId && Number.isFinite(at)
          && (query.requestId === undefined || event.requestId === query.requestId) && (query.userId === undefined || event.userId === query.userId)
          && (types === undefined || types.has(event.type)) && (from === undefined || at >= from) && (to === undefined || at <= to))
        // Array.prototype.sort is stable: events with the same instant keep the order they were committed in.
        .sort((a, b) => a.at - b.at);
      } catch { throw new TypeError("Audit source unavailable"); }
      return Object.freeze(matching.slice(0, query.limit).map(({ event }) => event));
    }),
  });
}
