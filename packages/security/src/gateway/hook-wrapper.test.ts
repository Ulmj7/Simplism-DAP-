import { describe, expect, it } from "vitest";
import { wrapHook, type HookKind, type HookTimer } from "./hook-wrapper.js";

class ManualTimer implements HookTimer {
  time = 0;
  private next = 0;
  readonly pending = new Map<number, { at: number; callback: () => void }>();
  now(): number { return this.time; }
  setTimeout(callback: () => void, ms: number): number { const id = this.next++; this.pending.set(id, { at: this.time + ms, callback }); return id; }
  clearTimeout(handle: unknown): void { this.pending.delete(handle as number); }
  advance(ms: number): void {
    this.time += ms;
    for (const [id, entry] of this.pending) if (entry.at <= this.time) { this.pending.delete(id); entry.callback(); }
  }
}
const principal = () => ({ userId: "alice", tenantId: "00000000-0000-4000-8000-000000000001", sessionId: "s", authenticatedAt: "2026-01-01T00:00:00Z", validUntil: "2026-01-01T01:00:00Z" });
const resource = () => ({ tenantId: principal().tenantId, ref: { type: "document", id: "doc" }, displayName: "Trusted name" });

describe("host hook timeout and answer boundary", () => {
  it.each([true, false, undefined, null, 1, "true", {}, new Boolean(true)])("boolean authorization only accepts literal true: %j", async (answer) => {
    const result = await wrapHook(() => answer, "boolean")();
    expect(result.ok).toBe(answer === true);
    expect(Object.isFrozen(result)).toBe(true);
  });

  it.each([
    ["authentication", principal()], ["resource", resource()], ["page", "documents"], ["void", undefined], ["tenantPolicy", false],
    ["instant", "2026-01-01T00:00:00Z"], ["instant", "2026-01-01T02:00:00+01:00"],
  ] as const)("validates a positive %s answer", async (kind, answer) => {
    const result = await wrapHook(() => kind === "void" ? Promise.resolve(answer) : answer, kind)();
    expect(result).toEqual({ ok: true, value: answer });
  });

  it.each(["authentication", "resource", "page"] as const)("null %s is a safe denial", async (kind) => {
    expect(await wrapHook(() => null, kind)()).toEqual({ ok: false, reason: "denied" });
  });

  it("a void operation completes only through its promise: a bare undefined means the host omitted it", async () => {
    expect(await wrapHook(() => undefined, "void")()).toEqual({ ok: false, reason: "dependency_failure" });
    expect(await wrapHook(() => Promise.resolve(undefined), "void")()).toEqual({ ok: true, value: undefined });
    expect(await wrapHook(async () => { /* completes */ }, "void")()).toEqual({ ok: true, value: undefined });
  });

  it("tenant policy has negative polarity: only literal false means not disabled", async () => {
    expect(await wrapHook(() => true, "tenantPolicy")()).toEqual({ ok: false, reason: "denied" });
    for (const answer of [undefined, null, 0, "false", {}]) expect((await wrapHook(() => answer, "tenantPolicy")()).ok).toBe(false);
  });

  it.each([
    ["authentication", { ...principal(), role: "admin" }], ["authentication", { ...principal(), tenantId: "not-a-uuid" }],
    ["authentication", { ...principal(), validUntil: "yesterday" }], ["authentication", { ...principal(), userId: "" }],
    ["resource", { ...resource(), ref: { type: "document", id: "doc", owner: "alice" } }],
    ["resource", { ...resource(), tenantId: "bad" }], ["resource", { ...resource(), displayName: undefined }],
    ["page", {}], ["page", ""], ["void", null], ["void", true],
    ["instant", null], ["instant", undefined], ["instant", 1], ["instant", ""], ["instant", "yesterday"], ["instant", "2026-01-01"], ["instant", "2026-01-01T00:00:00"], ["instant", {}],
  ] as const)("rejects malformed %s answers", async (kind, answer) => {
    expect(await wrapHook(() => answer, kind)()).toEqual({ ok: false, reason: "dependency_failure" });
  });

  it.each(["boolean", "authentication", "resource", "page", "void", "tenantPolicy", "instant"] as HookKind[])("contains exceptions for %s without error text", async (kind) => {
    const hook = wrapHook(() => { throw new Error("CANARY_SECRET: /private/stack"); }, kind);
    expect(await hook()).toEqual({ ok: false, reason: "dependency_failure" });
    expect(JSON.stringify(await hook())).not.toContain("CANARY");
  });

  it("reads Proxy/accessor answer fields once, then returns a detached deep freeze", async () => {
    const input = resource();
    const reads = new Map<PropertyKey, number>();
    const hostile = new Proxy(input, { get(target, key, receiver) {
      const count = (reads.get(key) ?? 0) + 1; reads.set(key, count);
      if (count > 1) throw new Error(`repeat ${String(key)}`);
      return Reflect.get(target, key, receiver);
    } });
    const result = await wrapHook(() => hostile, "resource")();
    expect(result.ok).toBe(true);
    input.ref.id = "mutated";
    if (!result.ok) throw new Error("Expected success");
    expect(result.value.ref.id).toBe("doc");
    expect(Object.isFrozen(result.value)).toBe(true);
    expect(Object.isFrozen(result.value.ref)).toBe(true);
    for (const count of reads.values()) expect(count).toBe(1);
  });

  it("denies throwing answer getters and hostile thenables", async () => {
    const answer = { ...principal(), get userId(): string { throw new Error("CANARY"); } };
    expect((await wrapHook(() => answer, "authentication")()).ok).toBe(false);
    const thenable = { get then(): never { throw new Error("CANARY"); } };
    expect((await wrapHook(() => thenable, "boolean")()).ok).toBe(false);
  });

  it("times out at the default 2000 ms, removes the timer, and never observes a late answer", async () => {
    const timer = new ManualTimer();
    let resolve!: (value: unknown) => void;
    let fieldReads = 0;
    const pending = wrapHook(() => new Promise((done) => { resolve = done; }), "resource", { timer })();
    let settled = false;
    void pending.then(() => { settled = true; });
    timer.advance(1999); await Promise.resolve(); expect(settled).toBe(false);
    timer.advance(1);
    expect(await pending).toEqual({ ok: false, reason: "dependency_failure" });
    resolve({ get ref() { fieldReads++; return {}; } });
    await Promise.resolve(); await Promise.resolve();
    expect(fieldReads).toBe(0);
    expect(timer.pending.size).toBe(0);
  });

  it("handles late rejection after timeout without an unhandled rejection", async () => {
    const timer = new ManualTimer();
    let reject!: (error: Error) => void;
    const pending = wrapHook(() => new Promise((_resolve, fail) => { reject = fail; }), "boolean", { timer, hookTimeoutMs: 10 })();
    timer.advance(10); expect((await pending).ok).toBe(false);
    reject(new Error("CANARY late failure"));
    await Promise.resolve(); await Promise.resolve();
  });

  it("checks elapsed time even if synchronous host code blocks timer dispatch", async () => {
    const timer = new ManualTimer();
    expect((await wrapHook(() => { timer.time = 2001; return true; }, "boolean", { timer })()).ok).toBe(false);
  });

  it("does not snapshot an already-expired answer before the timer can dispatch", async () => {
    const timer = new ManualTimer();
    let reads = 0;
    const answer = { ...resource(), get ref() { reads++; return { type: "document", id: "doc" }; } };
    const result = await wrapHook(() => { timer.time = 2001; return answer; }, "resource", { timer })();
    expect(result.ok).toBe(false);
    expect(reads).toBe(0);
  });

  it("clears timers on success, rejection, and malformed answers", async () => {
    const timer = new ManualTimer();
    for (const call of [() => true, () => "true", () => Promise.reject(new Error("fail"))]) {
      await wrapHook(call, "boolean", { timer })();
      expect(timer.pending.size).toBe(0);
    }
  });

  it("contains broken timer dependencies and refuses invalid timeout configuration", async () => {
    const timer = new ManualTimer();
    timer.setTimeout = () => { throw new Error("CANARY timer"); };
    expect((await wrapHook(() => true, "boolean", { timer })()).ok).toBe(false);
    for (const hookTimeoutMs of [0, -1, NaN, Infinity, 0.5, 2 ** 31]) expect(() => wrapHook(() => true, "boolean", { hookTimeoutMs })).toThrow(RangeError);
  });

  it("rechecks the deadline after answer validation and fails closed on cleanup errors", async () => {
    const timer = new ManualTimer();
    let reads = 0;
    timer.now = () => (++reads >= 4 ? 2001 : 0);
    expect((await wrapHook(() => true, "boolean", { timer })()).ok).toBe(false);
    const cleanup = new ManualTimer();
    cleanup.clearTimeout = () => { throw new Error("CANARY cleanup"); };
    expect(await wrapHook(() => true, "boolean", { timer: cleanup })()).toEqual({ ok: false, reason: "dependency_failure" });
    const malformed = new ManualTimer();
    let clockReads = 0;
    malformed.now = () => (++clockReads === 1 ? 0 : "1" as unknown as number);
    expect((await wrapHook(() => true, "boolean", { timer: malformed })()).ok).toBe(false);
  });
});
