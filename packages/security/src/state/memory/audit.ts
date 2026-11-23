import type { AuditEvent, AuditSink } from "@dap/contracts";
import { isBuiltAuditEvent } from "../../audit/event-builder.js";
import { canonicalJson } from "../../validation/canonical.js";

/**
 * In-memory `AuditSink` and tenant-scoped event source, for tests and local development (T092).
 *
 * - Append-only: there is no way to change or remove an event, and stored events are the builder's deep-frozen objects.
 * - `append` is IDEMPOTENT on `event.id`: the same event again leaves one row, the same id with different content is an error
 *   (so a retry after an ambiguous failure can never duplicate, and an id can never be reused to rewrite history).
 * - Only events made by `buildAuditEvent` are accepted: nothing unsanitized can be written.
 * - Storage is per tenant, and `listForTenant` only ever answers for the tenant it is given.
 */
export class InMemoryAuditStore implements AuditSink {
  private readonly byTenant = new Map<string, AuditEvent[]>();
  private readonly known = new Map<string, string>(); // id -> canonical content

  async append(event: AuditEvent): Promise<void> {
    if (!isBuiltAuditEvent(event)) throw new TypeError("Only built audit events can be appended");
    const content = canonicalJson(event);
    const previous = this.known.get(event.id);
    if (previous !== undefined) {
      if (previous === content) return;
      throw new TypeError("An audit event id cannot be reused with different content");
    }
    this.known.set(event.id, content);
    const list = this.byTenant.get(event.tenantId);
    if (list === undefined) this.byTenant.set(event.tenantId, [event]);
    else list.push(event);
  }

  /** The tenant's events in the order they were committed. A fresh array; the events are immutable. */
  async listForTenant(tenantId: string): Promise<readonly AuditEvent[]> {
    return [...(this.byTenant.get(tenantId) ?? [])];
  }

  /** Total events held, across tenants (tests only). */
  get size(): number { return this.known.size; }
}
