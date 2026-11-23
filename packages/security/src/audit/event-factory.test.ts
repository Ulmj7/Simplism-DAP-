import { describe, expect, it } from "vitest";
import type { Clock, IsoInstant } from "@dap/contracts";
import { createAuditEventFactory } from "./event-factory.js";
import type { AuditEventInput } from "./event-builder.js";
import { isBuiltAuditEvent } from "./event-builder.js";
import type { HookTimer } from "../gateway/hook-wrapper.js";
import { context, run } from "../gateway/fixtures.test-support.js";

const input = (): Omit<AuditEventInput, "id" | "occurredAt"> => ({ type: "AI_ACTION_PROPOSED", requestId: "req", decisionId: "dec", context: context(), run, action: { kind: "attempted", name: "openProject" } });
const clockOf = (now: () => unknown): Clock => ({ now: now as never });
class ManualTimer implements HookTimer {
  time = 0; private next = 0;
  readonly pending = new Map<number, { at: number; callback: () => void }>();
  now(): number { return this.time; }
  setTimeout(callback: () => void, ms: number): number { const id = this.next++; this.pending.set(id, { at: this.time + ms, callback }); return id; }
  clearTimeout(handle: unknown): void { this.pending.delete(handle as number); }
  advance(ms: number): void { this.time += ms; for (const [id, entry] of [...this.pending]) if (entry.at <= this.time) { this.pending.delete(id); entry.callback(); } }
}

describe("the Gateway's event factory", () => {
  it("dates the event with the host clock's reading, gives it a fresh UUID, and returns a built event", async () => {
    const factory = createAuditEventFactory({ clock: clockOf(() => "2026-03-04T05:06:07Z" as IsoInstant) });
    const [a, b] = [await factory.make(input()), await factory.make(input())];
    expect(a.occurredAt).toBe("2026-03-04T05:06:07Z");
    expect(a.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a.id).not.toBe(b.id);
    expect(isBuiltAuditEvent(a)).toBe(true);
    expect(Object.isFrozen(factory)).toBe(true);
    expect(Object.isFrozen(factory.make)).toBe(true);
  });

  it("reads the clock afresh for every event, with the host's receiver", async () => {
    const readings = ["2026-01-01T00:00:00Z", "2026-01-01T00:00:05Z"];
    const receivers: unknown[] = [];
    const host = { now(this: unknown) { receivers.push(this); return readings.shift(); } };
    const factory = createAuditEventFactory({ clock: host as never });
    expect([(await factory.make(input())).occurredAt, (await factory.make(input())).occurredAt]).toEqual(["2026-01-01T00:00:00Z", "2026-01-01T00:00:05Z"]);
    expect(receivers).toEqual([host, host]);
  });

  it("takes its ids from an injected generator and refuses one that is not a UUID", async () => {
    const id = "11111111-1111-4111-8111-111111111111";
    expect((await createAuditEventFactory({ clock: clockOf(() => "2026-01-01T00:00:00Z"), newId: () => id }).make(input())).id).toBe(id);
    await expect(createAuditEventFactory({ clock: clockOf(() => "2026-01-01T00:00:00Z"), newId: () => "id-1" }).make(input())).rejects.toThrow("Invalid audit event: id");
  });

  it.each([["throws", () => { throw new Error("CANARY"); }], ["rejects", () => Promise.reject(new Error("CANARY"))], ["answers undefined", () => undefined], ["answers a date-only string", () => "2026-01-01"], ["answers a number", () => 5]])("a clock that %s cannot date an event: make rejects, with no host text", async (_name, now) => {
    const error = await createAuditEventFactory({ clock: clockOf(now) }).make(input()).catch((e: Error) => e);
    expect(error).toBeInstanceOf(TypeError);
    expect(String((error as Error).message)).not.toContain("CANARY");
  });

  it("a clock that hangs is cut off at the configured hook timeout", async () => {
    const timer = new ManualTimer();
    const pending = createAuditEventFactory({ clock: clockOf(() => new Promise(() => {})) }, { timer, hookTimeoutMs: 40 }).make(input()).catch((e: Error) => e);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect([...timer.pending.values()].map((entry) => entry.at)).toEqual([40]);
    timer.advance(40);
    expect(await pending).toBeInstanceOf(TypeError);
  });

  it("builder refusals surface as they are", async () => {
    await expect(createAuditEventFactory({ clock: clockOf(() => "2026-01-01T00:00:00Z") }).make({ ...input(), requestId: "" })).rejects.toThrow("Invalid audit event: requestId");
  });
});
