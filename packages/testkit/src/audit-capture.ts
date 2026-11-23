/**
 * @dap/testkit: audit-capture.ts (T033)
 *
 * In-memory AuditSink for tests. Captures events as DEEP-FROZEN copies (the caller can
 * never mutate the log through a returned reference), hands out fresh copies of the list
 * from `events`, and offers a `failAppend` switch to simulate an unavailable audit store
 * (append rejects; the log is unchanged — "not recorded").
 */
import type { AuditEvent, AuditSink } from "@dap/contracts";
import { snapshotData } from "./snapshot.js";

export class InMemoryAuditSink implements AuditSink {
  private readonly log: AuditEvent[] = [];
  private failing = false;

  /** The captured events, as a fresh copy (elements are deep-frozen). */
  get events(): readonly AuditEvent[] {
    return [...this.log];
  }

  /** Make append() reject (audit unavailable). False restores normal operation. */
  failAppend(failing: boolean): void {
    this.failing = failing;
  }

  async append(event: AuditEvent): Promise<void> {
    if (this.failing) {
      throw new Error("InMemoryAuditSink: audit append disabled (failAppend is on)");
    }
    this.log.push(snapshotData(event));
  }
}
