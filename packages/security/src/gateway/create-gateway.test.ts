import { describe, expect, it } from "vitest";
import type { GatewayDependencies } from "@dap/contracts";
import { createPolicyGateway } from "./create-gateway.js";
import { context, dependencies, run } from "./fixtures.test-support.js";

/** A well-formed envelope: intake, resolve and validate pass, and the first absent stage then denies fail-closed. */
const VALID = '{"action":"viewProject","params":{}}';

describe("gateway composition and planner boundary", () => {
  it("returns the two frozen doors and a fail-closed confirmation placeholder", async () => {
    const { deps, calls } = dependencies();
    const gateway = createPolicyGateway(deps);
    expect(Object.keys(gateway)).toEqual(["proposals", "confirmations"]);
    expect(Object.isFrozen(gateway)).toBe(true);
    expect(Object.isFrozen(gateway.proposals)).toBe(true);
    expect(Object.isFrozen(gateway.confirmations)).toBe(true);
    const result = await gateway.confirmations.decide(context(), { confirmationId: "unknown", decision: "accept" });
    expect(result).toEqual({ status: "not_valid", category: "not_found" });
    expect(Object.isFrozen(result)).toBe(true);
    const pending = await gateway.confirmations.listPending(context());
    expect(pending).toEqual([]);
    expect(Object.isFrozen(pending)).toBe(true);
    expect(calls()).toBe(0);
  });

  it("submit exposes feedback only, with no id, internal reason or raw value", async () => {
    const { deps, calls } = dependencies();
    const submitter = createPolicyGateway(deps).proposals.forSession(context(), run);
    const result = await submitter.submit({ callId: "CANARY_CALL", raw: { action: "viewProject", params: { canary: "CANARY_VALUE" } } });
    expect(result).toEqual({ outcome: "INVALID_PARAMETERS", category: "invalid_input", issues: [{ path: "", code: "unknown_key" }] });
    expect(Object.keys(submitter)).toEqual(["submit"]);
    expect(Object.isFrozen(submitter)).toBe(true);
    expect(Object.isFrozen(result)).toBe(true);
    expect(calls()).toBe(0);
  });

  it("checks context before accessing a proposal", async () => {
    const { deps, calls } = dependencies();
    let reads = 0;
    const call = { get raw(): never { reads++; throw new Error("CANARY"); }, get callId(): never { reads++; throw new Error("CANARY"); } };
    const result = await createPolicyGateway(deps).proposals.forSession({ ...context() }, run).submit(call);
    expect(result).toEqual({ outcome: "UNAUTHORIZED", category: "not_available" });
    expect(reads).toBe(0);
    expect(calls()).toBe(0);
  });

  it("captures dependency properties once and preserves host method receivers", async () => {
    const { deps, calls } = dependencies();
    const seen = new WeakMap<object, Map<PropertyKey, number>>();
    const copies = new WeakMap<object, object>();
    let clockCalls = 0;
    let constructing = true;
    const receivers: unknown[] = [];
    const port = { time: "2026-01-01T00:00:00Z", now() { clockCalls++; receivers.push(this); return this.time as never; } };
    Object.assign(deps, { clock: port });
    function watch(value: object): object {
      const old = copies.get(value);
      if (old) return old;
      const proxy = new Proxy(value, { get(target, key) {
        if (!constructing) return Reflect.get(target, key, target);
        const counts = seen.get(target) ?? new Map<PropertyKey, number>();
        seen.set(target, counts);
        const count = (counts.get(key) ?? 0) + 1; counts.set(key, count);
        if (count > 1) throw new Error(`repeated field ${String(key)}`);
        const child: unknown = Reflect.get(target, key, target);
        return child && typeof child === "object" && !Object.isFrozen(child) && !(child instanceof Set) ? watch(child) : child;
      } });
      copies.set(value, proxy);
      return proxy;
    }
    const gateway = createPolicyGateway(watch(deps) as GatewayDependencies);
    constructing = false; // Only dependency CAPTURE is read-once; live host methods may read their own fields repeatedly.
    expect(await gateway.proposals.forSession(context(), run).submit({ callId: "call", raw: VALID })).toEqual({ outcome: "DENIED", category: "try_later" });
    // context, rate entry, rate admission and live authorization, then one reading to date the PROPOSED record and one for the decision record.
    expect(clockCalls).toBe(6);
    expect(receivers).toHaveLength(6);
    for (const receiver of receivers) expect(receiver).toBe(copies.get(port));
    expect(calls()).toBe(0);
  });

  it("snapshots run metadata once and isolates submitters", async () => {
    const { deps, calls } = dependencies();
    let reads = 0;
    const metadata = { ...run, get model() { reads++; return "model"; } };
    const submitter = createPolicyGateway(deps).proposals.forSession(context(), metadata);
    await submitter.submit({ callId: "one", raw: VALID });
    await submitter.submit({ callId: "two", raw: VALID });
    expect(reads).toBe(1);
    expect(calls()).toBe(0);
  });

  it("snapshots host method selection and configuration at construction", async () => {
    const { deps, calls } = dependencies();
    let clocks = 0;
    Object.assign(deps, { clock: { now: () => { clocks++; return "2026-01-01T00:00:00Z"; } } });
    const gateway = createPolicyGateway(deps);
    Object.assign(deps.clock, { now: () => { throw new Error("replacement"); } });
    Object.assign(deps.config, { hookTimeoutMs: -1 });
    expect(await gateway.proposals.forSession(context(), run).submit({ callId: "call", raw: VALID })).toEqual({ outcome: "DENIED", category: "try_later" });
    expect(clocks).toBe(6); // context, rate entry, rate admission, live authorization, PROPOSED record, decision record
    expect(calls()).toBe(0);
  });
});

describe("the gateway accepts only a configuration the T115 validator accepts", () => {
  const withConfig = (change: (config: Record<string, unknown>) => unknown) => {
    const { deps } = dependencies();
    const config = structuredClone(deps.config) as unknown as Record<string, unknown>;
    return { ...deps, config: (change(config) ?? config) as never } as GatewayDependencies;
  };
  const limits = (config: Record<string, unknown>) => config.limits as Record<string, unknown>;

  it("builds with the fixture configuration and with an explicit proposalBudgetMs", () => {
    expect(() => createPolicyGateway(withConfig(() => undefined))).not.toThrow();
    expect(() => createPolicyGateway(withConfig((config) => { config.proposalBudgetMs = 4000; }))).not.toThrow();
  });
  it.each([
    ["maxChainDepth 0 (a chain of zero calls is not a limit)", (c: Record<string, unknown>) => { limits(c).maxChainDepth = 0; }],
    ["a hook timeout above 60 s", (c: Record<string, unknown>) => { c.hookTimeoutMs = 60_001; }],
    ["a hook timeout that fits a timer but not a sane deadline", (c: Record<string, unknown>) => { c.hookTimeoutMs = 0x7fff_ffff; }],
    ["a payload cap above 1 MiB", (c: Record<string, unknown>) => { c.maxPayloadBytes = 1_048_577; }],
    ["a per-turn proposal count above the ceiling", (c: Record<string, unknown>) => { limits(c).proposalsPerTurn = 1_000_001; }],
    ["an unknown top-level key", (c: Record<string, unknown>) => { c.unlimited = true; }],
    ["an unknown nested key", (c: Record<string, unknown>) => { (limits(c).denialThrottle as Record<string, unknown>).bypass = 1; }],
    ["a missing limit", (c: Record<string, unknown>) => { delete limits(c).perTenantPerMinute; }],
    ["a proposal budget of 0", (c: Record<string, unknown>) => { c.proposalBudgetMs = 0; }],
    ["a string proposal budget", (c: Record<string, unknown>) => { c.proposalBudgetMs = "5000"; }],
    ["a configuration that is not plain data", () => Object.create({}) as unknown],
  ])("refuses %s", (_name, change) => {
    expect(() => createPolicyGateway(withConfig(change))).toThrow(TypeError);
  });
  it("takes no field from the prototype chain", () => {
    const { deps } = dependencies();
    expect(() => createPolicyGateway({ ...deps, config: Object.create(deps.config) } as GatewayDependencies)).toThrow(TypeError);
  });
});
