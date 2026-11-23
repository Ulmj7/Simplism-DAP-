/**
 * @dap/security: audit/event-factory.ts
 *
 * The Gateway's event maker: `buildAuditEvent` with a fresh UUID and the time from the HOST CLOCK, read through the hook wrapper
 * (so a clock that throws, hangs or answers the wrong shape cannot produce an event, and `make` rejects instead). Callers treat a
 * rejected `make` as "this record could not be made": a denial still stands, an allow-event means the action is not executed.
 */
import { randomUUID } from "node:crypto";
import type { AuditEvent, Clock } from "@dap/contracts";
import { wrapHook, type HookOptions } from "../gateway/hook-wrapper.js";
import { buildAuditEvent } from "./event-builder.js";
import type { AuditEventInput } from "./event-builder.js";

export interface AuditEventFactory {
  make(input: Omit<AuditEventInput, "id" | "occurredAt">): Promise<AuditEvent>;
}

export function createAuditEventFactory({ clock, newId = randomUUID }: { readonly clock: Clock; readonly newId?: () => string }, options: HookOptions = {}): AuditEventFactory {
  const now = wrapHook(clock.now.bind(clock), "instant", options);
  return Object.freeze({
    make: Object.freeze(async (input: Omit<AuditEventInput, "id" | "occurredAt">): Promise<AuditEvent> => {
      const reading = await now();
      if (!reading.ok) throw new TypeError("The audit clock is unavailable");
      return buildAuditEvent({ ...input, id: newId(), occurredAt: reading.value });
    }),
  });
}
