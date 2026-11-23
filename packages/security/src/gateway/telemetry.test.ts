import { describe, expect, it } from "vitest";
import { OUTCOMES, REASON_CODES, RISK_LEVELS } from "@dap/contracts";
import { AUDIT_WRITE_KINDS, DEPENDENCIES, RATE_LIMIT_SCOPES, noopTelemetry, safeTelemetry } from "./telemetry.js";
import type { GatewayTelemetry } from "./telemetry.js";

const sample = { outcome: "DENIED", reason: "permission_missing", risk: "LOW", action: "openProject" } as const;
function recorder() {
  const calls: { method: string; args: unknown[]; receiver: unknown }[] = [];
  const target: GatewayTelemetry = {
    decision(this: unknown, ...args: unknown[]) { calls.push({ method: "decision", args, receiver: this }); },
    auditWriteFailed(this: unknown, ...args: unknown[]) { calls.push({ method: "auditWriteFailed", args, receiver: this }); },
    dependencyFailed(this: unknown, ...args: unknown[]) { calls.push({ method: "dependencyFailed", args, receiver: this }); },
    rateLimited(this: unknown, ...args: unknown[]) { calls.push({ method: "rateLimited", args, receiver: this }); },
  } as never;
  return { calls, target };
}

describe("the no-op default", () => {
  it("counts nothing and cannot be altered", () => {
    expect(() => { noopTelemetry.decision(sample); noopTelemetry.auditWriteFailed("allowed"); noopTelemetry.dependencyFailed("audit"); noopTelemetry.rateLimited("user"); }).not.toThrow();
    expect(Object.isFrozen(noopTelemetry)).toBe(true);
  });
  it.each([["nothing", undefined], ["null", null], ["a string", "x"], ["a number", 5]])("is what safeTelemetry gives for %s", (_name, source) => {
    expect(safeTelemetry(source as never)).toBe(noopTelemetry);
  });
});

describe("safeTelemetry passes what happened, with labels from closed vocabularies", () => {
  it("forwards each signal to the host's own method, with the host's receiver", () => {
    const { calls, target } = recorder();
    const telemetry = safeTelemetry(target, new Set(["openProject"]));
    telemetry.decision(sample); telemetry.auditWriteFailed("allowed"); telemetry.dependencyFailed("permissions"); telemetry.rateLimited("tenant");
    expect(calls.map((call) => [call.method, call.args])).toEqual([["decision", [sample]], ["auditWriteFailed", ["allowed"]], ["dependencyFailed", ["permissions"]], ["rateLimited", ["tenant"]]]);
    for (const call of calls) expect(call.receiver).toBe(target);
  });

  it("passes every legal label through unchanged", () => {
    const { calls, target } = recorder();
    const telemetry = safeTelemetry(target);
    for (const outcome of OUTCOMES) telemetry.decision({ ...sample, outcome });
    for (const reason of REASON_CODES) telemetry.decision({ ...sample, reason });
    for (const risk of RISK_LEVELS) telemetry.decision({ ...sample, risk });
    for (const kind of AUDIT_WRITE_KINDS) telemetry.auditWriteFailed(kind);
    for (const dependency of DEPENDENCIES) telemetry.dependencyFailed(dependency);
    for (const scope of RATE_LIMIT_SCOPES) telemetry.rateLimited(scope);
    expect(calls).toHaveLength(OUTCOMES.length + REASON_CODES.length + RISK_LEVELS.length + AUDIT_WRITE_KINDS.length + DEPENDENCIES.length + RATE_LIMIT_SCOPES.length);
    expect(calls.filter((call) => call.method === "decision").map((call) => (call.args[0] as { outcome: string }).outcome).slice(0, OUTCOMES.length)).toEqual([...OUTCOMES]);
    expect(calls.some((call) => (call.args[0] as { risk?: unknown }).risk === "FORBIDDEN")).toBe(true);
  });

  it("replaces anything outside the vocabulary with `unknown`, so a hostile value cannot mint a metric series", () => {
    const { calls, target } = recorder();
    const telemetry = safeTelemetry(target);
    telemetry.decision({ outcome: "CANARY", reason: "CANARY\n", risk: "CANARY", action: "CANARY action!" } as never);
    telemetry.decision({ outcome: 5, reason: null, risk: 7, action: 9 } as never);
    telemetry.auditWriteFailed("CANARY" as never); telemetry.dependencyFailed("CANARY" as never); telemetry.rateLimited("CANARY" as never);
    expect(calls.map((call) => call.args[0])).toEqual([
      { outcome: "unknown", reason: "unknown", risk: "unknown", action: "unknown" }, { outcome: "unknown", reason: "unknown", risk: "unknown", action: "unknown" }, "unknown", "unknown", "unknown",
    ]);
  });

  it("keeps a null risk and a null action as null (an unresolved action), and a registered id as it is", () => {
    const { calls, target } = recorder();
    safeTelemetry(target).decision({ ...sample, risk: null, action: null });
    expect(calls[0]!.args[0]).toEqual({ ...sample, risk: null, action: null });
  });

  it("passes a frozen sample, and no tenant or user", () => {
    const { calls, target } = recorder();
    safeTelemetry(target).decision({ ...sample, tenantId: "t", userId: "u" } as never);
    const sent = calls[0]!.args[0] as object;
    expect(Object.isFrozen(sent)).toBe(true);
    expect(Object.keys(sent).sort()).toEqual(["action", "outcome", "reason", "risk"]);
    expect(Object.isFrozen(safeTelemetry(target))).toBe(true);
    const wrapped = safeTelemetry(target);
    for (const method of [wrapped.decision, wrapped.auditWriteFailed, wrapped.dependencyFailed, wrapped.rateLimited]) expect(Object.isFrozen(method)).toBe(true);
  });
});

describe("telemetry never changes a decision", () => {
  it.each([["throws", () => { throw new Error("CANARY"); }], ["rejects", () => Promise.reject(new Error("CANARY"))], ["hangs", () => new Promise(() => {})], ["returns a throwing thenable", () => ({ then() { throw new Error("CANARY"); } })]])(
    "a method that %s is contained, for every signal", async (_name, behave) => {
      const host = { decision: behave, auditWriteFailed: behave, dependencyFailed: behave, rateLimited: behave } as unknown as GatewayTelemetry;
      const telemetry = safeTelemetry(host);
      expect(() => { telemetry.decision(sample); telemetry.auditWriteFailed("allowed"); telemetry.dependencyFailed("audit"); telemetry.rateLimited("user"); }).not.toThrow();
      await Promise.resolve(); await Promise.resolve();
    });

  it("does not wait for the host: the call returns before an asynchronous method settles", () => {
    let settled = false;
    const telemetry = safeTelemetry({ auditWriteFailed: () => new Promise<void>((resolve) => { setTimeout(() => { settled = true; resolve(); }, 1e6).unref(); }) });
    expect(telemetry.auditWriteFailed("proposed")).toBeUndefined();
    expect(settled).toBe(false);
  });

  it.each([["a missing method", {}], ["methods that are not functions", { decision: 1, auditWriteFailed: "x", dependencyFailed: {}, rateLimited: null }]])("%s counts nothing and does not throw", (_name, host) => {
    const telemetry = safeTelemetry(host as never);
    expect(() => { telemetry.decision(sample); telemetry.auditWriteFailed("allowed"); telemetry.dependencyFailed("audit"); telemetry.rateLimited("user"); }).not.toThrow();
  });

  it("reads each host method once, at construction: later swaps change nothing", () => {
    let first = 0; let second = 0;
    const host = { decision: () => { first++; }, auditWriteFailed: () => undefined, dependencyFailed: () => undefined, rateLimited: () => undefined };
    const telemetry = safeTelemetry(host);
    host.decision = () => { second++; };
    telemetry.decision(sample);
    expect([first, second]).toEqual([1, 0]);
  });

  it("survives a host whose getters throw, and a hostile sample", () => {
    const hostile = { get decision(): never { throw new Error("CANARY"); }, auditWriteFailed: () => undefined };
    expect(safeTelemetry(hostile as never)).toBe(noopTelemetry);
    const { target } = recorder();
    const telemetry = safeTelemetry(target);
    expect(() => telemetry.decision({ get outcome(): never { throw new Error("CANARY"); } } as never)).not.toThrow();
    expect(() => telemetry.decision(null as never)).not.toThrow();
    expect(() => telemetry.decision(undefined as never)).not.toThrow();
  });
});
