/**
 * T084, SC-008. A small representative M1 sample through the shared real Gateway.
 * The separate stage-level 20-action test remains in packages/security/src/gateway/audit-trail.test.ts.
 */
import { describe, expect, it } from "vitest";
import type { AuditEvent } from "@dap/contracts";
import { EXPECTED, reconstruct, sample } from "./audit-trail.support.js";

describe("T084 audit trail (SC-008)", () => {
  // The same sample read back from PostgreSQL through the tenant-scoped reader, and the cross-tenant reviewer proof (ATK-XTENANT-09): tests/integration/audit-postgres.test.ts.
  it("from the events alone: what was proposed, allowed or denied and why, who initiated it, whether it executed, and the resource", async () => {
    const world = await sample();
    expect(world.executorCalls()).toBe(2); // the success and failure bodies ran; decisions alone are not execution evidence
    expect(reconstruct(world.events())).toEqual(EXPECTED);
  });

  it("the reading is able to fail: each corrupted copy of the real trail gives an answer that differs from the truth", async () => {
    const events = [...(await sample()).events()];
    const executedIndex = events.findIndex((event) => event.type === "AI_ACTION_EXECUTED");
    const deniedIndex = events.findIndex((event) => event.reason === "permission_missing");
    const confirmIndex = events.findIndex((event) => event.type === "AI_CONFIRMATION_REQUIRED");
    const mutate = (name: string, change: (copy: AuditEvent[]) => AuditEvent[]) => [name, change(events.map((event) => ({ ...event })))] as const;
    const mutants = [
      mutate("a failed execution is reported as successful", (copy) => copy.map((event) => event.executionResult === "failure" ? { ...event, executionResult: "success" } : event)),
      mutate("the version is lost", (copy) => copy.map((event) => ({ ...event, definitionVersion: null }))),
      mutate("the trail drops who initiated the request", (copy) => copy.map((event) => ({ ...event, userId: "" as never }))),
      mutate("the EXECUTED event is missing", (copy) => copy.filter((_, index) => index !== executedIndex)),
      mutate("a denial's reason is replaced", (copy) => copy.map((event, index) => index === deniedIndex ? { ...event, reason: "allowed" as never } : event)),
      mutate("the resource is omitted", (copy) => copy.map((event, index) => index === confirmIndex ? { ...event, resource: null } : event)),
      mutate("the tenant is dropped", (copy) => copy.map((event) => ({ ...event, tenantId: "" as never }))),
      mutate("the action is dropped from the whole request (a decision alone still names it through the proposal, so both go)", (copy) => copy.map((event) => event.requestId === events[deniedIndex]!.requestId ? { ...event, actionId: null } : event)),
    ];
    for (const [name, corrupted] of mutants) expect(reconstruct(corrupted), name).not.toEqual(EXPECTED);
    expect(() => reconstruct(events.filter((event) => event.type !== "AI_ACTION_PROPOSED"))).toThrow(/proposal/);
    expect(() => reconstruct(events.map((event, index) => index === deniedIndex ? { ...event, requestId: "split" as never } : event))).toThrow();
    expect(() => reconstruct(events.map((event, index) => index === executedIndex ? { ...event, userId: "other" as never } : event))).toThrow(/binding/);
    // a decision recorded twice is not a different reading but an inconsistent trail: it is refused outright
    expect(() => reconstruct([...events.slice(0, deniedIndex + 1), { ...events[deniedIndex]! }, ...events.slice(deniedIndex + 1)])).toThrow(/decision events/);
  });

  it("every request has exactly one PROPOSED and one decision event, linked by request id, user and tenant, and the order is PROPOSED, decision, EXECUTED", async () => {
    const world = await sample();
    const ids = world.requestIds();
    expect(ids).toHaveLength(EXPECTED.length);
    for (const id of ids) {
      const group = world.eventsFor(id);
      expect(group.filter((event) => event.type === "AI_ACTION_PROPOSED")).toHaveLength(1);
      expect(group[0]!.type).toBe("AI_ACTION_PROPOSED");
      expect(new Set(group.map((event) => `${event.tenantId}/${event.userId}/${event.requestId}`)).size).toBe(1);
    }
    expect(world.eventsFor(ids[0]!).map((event) => event.type)).toEqual(["AI_ACTION_PROPOSED", "AI_ACTION_ALLOWED", "AI_ACTION_EXECUTED"]);
  });

});
