/**
 * @dap/security: state/postgres/audit.ts (T094)
 *
 * The PostgreSQL audit trail: an `AuditSink` and the tenant-scoped `AuditEventSource` behind `createAuditReader`.
 * It behaves as `InMemoryAuditStore` does (the reference; both run `audit.conformance.ts`):
 *
 * - Only events made by `buildAuditEvent` are accepted, and each is re-validated here before it is written: what is stored is
 *   already the sanitized projection, never raw parameters.
 * - `append` is idempotent on the event id. The same event again is a no-op success; the same id with different content, or an id
 *   already used by ANOTHER tenant, is an error and nothing is overwritten (rows cannot be changed at all: the table is append-only).
 * - Every statement runs in a tenant transaction (`withTenant`): the tenant is the event's / the reader context's, and forced row
 *   level security enforces it again in the database.
 * - FAIL CLOSED: any database failure (connection, timeout, constraint, permission) rejects with a generic error that carries no
 *   driver text, host, database, user or SQL. The audit writer then treats the write as failed (an allow is not executed).
 * - CANCELLATION: the audit writer aborts `options.signal` when it gives up on an append (timeout and the like). Before COMMIT is issued,
 *   abandonment prevents new writes: it does not start once the signal is aborted (before a connection is taken and again right after), and inside the transaction the
 *   signal is read live just before COMMIT, ROLLBACK replacing it when aborted. As a second, independent bound the DATABASE cancels a blocked
 *   or slow statement itself (`lock_timeout` and `statement_timeout`, `writeTimeoutMs`). Residual risk: once COMMIT has been issued its
 *   outcome is uncertain if the writer gives up at that moment.
 * - `occurredAt` is stored as given by the event (the host clock reading made by the Gateway's event factory) and comes back as a
 *   normalized UTC instant without losing PostgreSQL microseconds. Finer nonzero fractions are refused, never silently rounded.
 */
import { z } from "zod";
import type { Pool, PoolClient } from "pg";
import { AUDIT_EVENT_TYPES, OUTCOMES, REASON_CODES, RISK_LEVELS } from "@dap/contracts";
import type { AuditAppendOptions, AuditEvent, AuditQuery, AuditSink, JsonValue } from "@dap/contracts";
import { isBuiltAuditEvent } from "../../audit/event-builder.js";
import { MAX_AUDIT_QUERY_LIMIT } from "../../audit/audit-reader.js";
import type { AuditEventSource } from "../../audit/audit-reader.js";
import { canonicalJson } from "../../validation/canonical.js";
import { withTenant } from "./tenant-tx.js";

const OBSERVED_POOLS = new WeakSet<Pool>();
const UNAVAILABLE = "Audit store unavailable";
const text = z.string().min(1).max(256);
const row = z.strictObject({
  id: z.uuid(), occurredAt: z.iso.datetime({ offset: true }).refine((value) => !/[1-9]/.test((/\.(\d+)/.exec(value)?.[1] ?? "").slice(6))), type: z.enum(AUDIT_EVENT_TYPES), requestId: text, decisionId: text, tenantId: z.uuid(), userId: text,
  aiSessionId: text, turnId: text, model: text, actionId: text.nullable(), definitionVersion: z.number().int().min(1).nullable(),
  paramsView: z.record(z.string(), z.json()), risk: z.enum(RISK_LEVELS).nullable(), outcome: z.enum(OUTCOMES).nullable(), reason: z.enum(REASON_CODES).nullable(),
  confirmationId: z.uuid().nullable(), confirmationState: z.enum(["pending", "accepted", "rejected", "invalidated"]).nullable(),
  executionResult: z.enum(["success", "failure"]).nullable(), resource: z.strictObject({ type: text, id: text }).nullable(),
});
const querySchema = z.strictObject({
  requestId: text.optional(), userId: text.optional(), from: z.iso.datetime({ offset: true }).optional(), to: z.iso.datetime({ offset: true }).optional(),
  types: z.array(z.enum(AUDIT_EVENT_TYPES)).min(1).max(AUDIT_EVENT_TYPES.length).optional(), limit: z.number().int().min(1).max(MAX_AUDIT_QUERY_LIMIT),
});
const COLUMNS = "id, tenant_id, occurred_at, event_type, request_id, decision_id, user_id, ai_session_id, turn_id, model, action_id, definition_version, params_view, risk, outcome, reason, confirmation_id, confirmation_state, execution_result, resource_type, resource_id";
// Read timestamp text instead of pg's Date parser, which truncates sub-millisecond precision.
const READ_COLUMNS = COLUMNS.replace("occurred_at", `to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS occurred_at`);


/** The normal form two copies of one event are compared in: UTC instant (microseconds preserved), canonical JSON and UUIDs. */
function instant(value: string): string {
  const fraction = (/\.(\d+)/.exec(value)?.[1] ?? "").replace(/0+$/, "").padEnd(3, "0");
  return new Date(value).toISOString().replace(/\.\d{3}Z$/, `.${fraction}Z`);
}
function normalized(event: AuditEvent): string {
  return canonicalJson({ ...event, paramsView: JSON.parse(JSON.stringify(event.paramsView)), id: event.id.toLowerCase(), tenantId: event.tenantId.toLowerCase(), confirmationId: event.confirmationId?.toLowerCase() ?? null, occurredAt: instant(event.occurredAt) });
}

function toEvent(r: Record<string, unknown>): AuditEvent {
  const event = row.parse({
    id: r.id, occurredAt: instant(r.occurred_at as string), type: r.event_type, requestId: r.request_id, decisionId: r.decision_id, tenantId: r.tenant_id, userId: r.user_id,
    aiSessionId: r.ai_session_id, turnId: r.turn_id, model: r.model, actionId: r.action_id, definitionVersion: r.definition_version === null ? null : Number(r.definition_version), paramsView: r.params_view,
    risk: r.risk, outcome: r.outcome, reason: r.reason, confirmationId: r.confirmation_id, confirmationState: r.confirmation_state, executionResult: r.execution_result,
    resource: r.resource_type === null ? null : { type: r.resource_type, id: r.resource_id },
  });
  return Object.freeze({ ...event, resource: event.resource === null ? null : Object.freeze(event.resource) }) as unknown as AuditEvent;
}

export interface PostgresAuditStoreOptions {
  /** Database-side bound on each statement of an append (lock wait and run time), 1 to 10000 ms. Default 1500: below the writer's default hook timeout of 2000. */
  readonly writeTimeoutMs?: number;
}
const DEFAULT_WRITE_TIMEOUT_MS = 1500;

export class PostgresAuditStore implements AuditSink, AuditEventSource {
  private readonly writeTimeoutMs: number;
  constructor(private readonly pool: Pool, options: PostgresAuditStoreOptions = {}) {
    const timeout: unknown = options?.writeTimeoutMs === undefined ? DEFAULT_WRITE_TIMEOUT_MS : options.writeTimeoutMs;
    if (typeof timeout !== "number" || !Number.isSafeInteger(timeout) || timeout < 1 || timeout > 10_000) throw new RangeError("Invalid audit write timeout");
    this.writeTimeoutMs = timeout;
    if (!OBSERVED_POOLS.has(pool)) {
      // pg already removes broken idle clients; an unhandled pool error would otherwise terminate the process.
      pool.on("error", () => {});
      OBSERVED_POOLS.add(pool);
    }
  }

  async append(event: AuditEvent, options?: AuditAppendOptions): Promise<void> {
    // Validation errors are the caller's programming errors and name no value; database errors become one generic error.
    if (!isBuiltAuditEvent(event)) throw new TypeError("Only built audit events can be appended");
    const checked = row.safeParse(event);
    if (!checked.success) throw new TypeError("Invalid audit event");
    const e = checked.data;
    const tenantId = e.tenantId.toLowerCase();
    // Read live every time: the writer may abort at any moment while this append is blocked in the database.
    let signal: unknown;
    const abandoned = (): boolean => {
      if (signal === undefined) return false;
      if (typeof signal !== "object" || signal === null) throw new TypeError("Invalid cancellation signal");
      const aborted: unknown = Reflect.get(signal, "aborted");
      if (typeof aborted !== "boolean") throw new TypeError("Invalid cancellation signal");
      return aborted;
    };
    let client: PoolClient | undefined;
    let discard = false;
    try {
      signal = options?.signal;
      if (abandoned()) throw new Error("abandoned");
      client = await this.pool.connect();
      if (abandoned()) throw new Error("abandoned"); // nothing has been sent on this connection
      try {
        await client.query("BEGIN");
        await client.query("SELECT set_config('app.tenant_id', $1, true)", [tenantId]);
        // The database bounds a blocked or slow statement by itself, even when nobody aborts.
        await client.query("SELECT set_config('lock_timeout', $1, true), set_config('statement_timeout', $1, true)", [`${this.writeTimeoutMs}ms`]);
        const inserted = await client.query(
          `INSERT INTO public.sec_audit_events (${COLUMNS}) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13::jsonb,$14,$15,$16,$17,$18,$19,$20,$21) ON CONFLICT (id) DO NOTHING`,
          [e.id, tenantId, e.occurredAt, e.type, e.requestId, e.decisionId, e.userId, e.aiSessionId, e.turnId, e.model, e.actionId, e.definitionVersion, JSON.stringify(e.paramsView satisfies Record<string, JsonValue>),
            e.risk, e.outcome, e.reason, e.confirmationId, e.confirmationState, e.executionResult, e.resource?.type ?? null, e.resource?.id ?? null],
        );
        if (inserted.command !== "INSERT" || (inserted.rowCount !== 0 && inserted.rowCount !== 1)) throw new TypeError("Invalid insert result");
        if (inserted.rowCount === 0) {
          // The id exists: only the very same event is a success. An id held by another tenant is invisible here, so it is not found, and refused.
          const existing = await client.query(`SELECT ${READ_COLUMNS} FROM public.sec_audit_events WHERE id=$1 AND params_view=$2::jsonb`, [e.id, JSON.stringify(e.paramsView)]);
          if (existing.rowCount !== 1 || normalized(toEvent(existing.rows[0] as Record<string, unknown>)) !== normalized(e as unknown as AuditEvent)) throw new TypeError("An audit event id cannot be reused with different content");
        }
        // The point of no return: an append the writer has given up on must not become a row. ROLLBACK (in the catch) replaces COMMIT.
        if (abandoned()) throw new Error("abandoned");
        const commit = await client.query("COMMIT");
        if (commit.command !== "COMMIT") throw new Error("not committed");
      } catch (error) {
        try { await client.query("ROLLBACK"); } catch { discard = true; }
        throw error;
      }
    } catch { throw new Error(UNAVAILABLE); }
    finally { client?.release(discard); }
  }

  /** Full-history source compatibility. Reviewers use queryForTenant, which is bounded in SQL. */
  listForTenant(tenantId: string): Promise<readonly AuditEvent[]> { return this.read(tenantId); }

  queryForTenant(tenantId: string, query: AuditQuery): Promise<readonly AuditEvent[]> { return this.read(tenantId, query); }

  private async read(tenantId: string, query?: AuditQuery): Promise<readonly AuditEvent[]> {
    if (!z.uuid().safeParse(tenantId).success) throw new TypeError("Audit queries need a UUID tenant");
    const parsed = query === undefined ? undefined : querySchema.safeParse(query);
    if (parsed !== undefined && !parsed.success) throw new TypeError("Invalid audit query");
    const q = parsed?.data;
    if (q?.from !== undefined && q.to !== undefined && Date.parse(q.from) > Date.parse(q.to)) throw new TypeError("Invalid audit query");
    const values: unknown[] = [tenantId.toLowerCase()];
    const where = ["tenant_id=$1"];
    for (const [column, operator, value] of [["request_id", "=", q?.requestId], ["user_id", "=", q?.userId], ["occurred_at", ">=", q?.from], ["occurred_at", "<=", q?.to]] as const) {
      if (value !== undefined) { values.push(value); where.push(`${column}${operator}$${values.length}`); }
    }
    if (q?.types !== undefined) { values.push(q.types); where.push(`event_type=ANY($${values.length}::text[])`); }
    let limit = "";
    if (q !== undefined) { values.push(q.limit); limit = ` LIMIT $${values.length}`; }
    try {
      return await withTenant(this.pool, tenantId.toLowerCase(), async (client) => {
        const result = await client.query(`SELECT ${READ_COLUMNS} FROM public.sec_audit_events WHERE ${where.join(" AND ")} ORDER BY public.sec_audit_events.occurred_at, seq${limit}`, values);
        return result.rows.map((r) => toEvent(r as Record<string, unknown>));
      });
    } catch { throw new Error(UNAVAILABLE); }
  }
}
