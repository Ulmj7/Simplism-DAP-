import { describe, expect, it, vi } from "vitest";
import { wrapHook } from "@dap/security";
import { dependencyFailureScenarios, DEPENDENCY_PORTS, DEPENDENCY_FAULTS, confirmationChannelFailure, faultedDependency, type DependencyPort } from "./dependency-failure.js";
import { runScenario, type ScenarioTarget } from "../scenario-runner.js";
import { InMemoryAuditSink } from "../audit-capture.js";
import { RecordingExecutor } from "../recording-executor.js";
import { faulty } from "../fault-injection.js";
const safe = { actionId: "testSafeEcho", risk: "SAFE" as const, targetsResource: false, changesState: false, requiresConfirmation: false };

describe("T123 dependency-failure definitions", () => {
  it("contains the full independent 9 by 4 matrix with unique stable ids", () => {
    expect(DEPENDENCY_PORTS).toEqual(["authentication", "permissions", "resources", "pages", "replay", "rate-limiter", "confirmations-store", "tenant-policy", "audit-append"]);
    expect(DEPENDENCY_FAULTS).toEqual(["throws", "hangs", "undefined", "wrong-type"]);
    expect(dependencyFailureScenarios).toHaveLength(36);
    expect(new Set(dependencyFailureScenarios.map((scenario) => scenario.id)).size).toBe(36);
    for (const port of DEPENDENCY_PORTS) for (const mode of DEPENDENCY_FAULTS) {
      expect(dependencyFailureScenarios.filter((scenario) => scenario.port === port && scenario.mode === mode)).toHaveLength(1);
    }
  });
  it.each(dependencyFailureScenarios)("$id rejects vacuous evidence, execution and allowed feedback", (scenario) => {
    expect(scenario.id).toBe(`ATK-DEP-${scenario.port}-${scenario.mode}`);
    expect(scenario.verify({ feedback: [], executorCalls: 0, auditEvents: [], leakFindings: [] })).toContain("missing or surplus decision");
    expect(scenario.verify({ feedback: [{ outcome: "DENIED", category: "try_later" }], executorCalls: 0, auditEvents: [], leakFindings: [] })).toEqual([]);
    expect(scenario.verify({ feedback: [{ outcome: "ALLOWED", category: "ok" }], executorCalls: 1, auditEvents: [], leakFindings: [] })).toContain("executor ran under dependency fault");
    expect(scenario.verify({ feedback: [{ outcome: "ALLOWED", category: "ok" }], executorCalls: 0, auditEvents: [], leakFindings: [] })).toContain("dependency fault did not deny");
    expect(scenario.verify({ feedback: [{ outcome: "ALLOWED", category: "try_later" }], executorCalls: 0, auditEvents: [], leakFindings: [] })).toContain("dependency fault did not deny");
    expect(scenario.verify({ feedback: [{ outcome: "DENIED", category: "ok" }], executorCalls: 0, auditEvents: [], leakFindings: [] })).toContain("dependency fault did not deny");
    expect(scenario.verify({ feedback: [{ outcome: "DENIED", category: "try_later" }], executorCalls: 0, auditEvents: [], leakFindings: ["canary:$"] })).toContain("planner output leaked");
    expect(scenario.verify({ feedback: [{ outcome: "DENIED", category: "try_later", issues: [] }], executorCalls: 0, auditEvents: [], leakFindings: [] })).toContain("unexpected feedback fields");
  });
  it("applies resource/confirmation-store faults only where those ports are required", () => {
    for (const scenario of dependencyFailureScenarios) {
      expect(scenario.appliesTo(safe)).toBe(!["resources", "confirmations-store"].includes(scenario.port));
      expect(scenario.appliesTo({ ...safe, targetsResource: true, requiresConfirmation: true })).toBe(true);
    }
    expect(confirmationChannelFailure).toEqual({ id: "ATK-DEP-confirmation-channel", port: "confirmation-channel", modes: DEPENDENCY_FAULTS, expectedOutcome: "REQUIRES_CONFIRMATION", pendingRequestSurvives: true });
  });
  it("runner preserves closure-bound installation/submission; transport or setup failure can never pass", async () => {
    const definition = dependencyFailureScenarios[0]!;
    const installFault = vi.fn(async () => {});
    const submit = vi.fn(async () => { throw new Error("transport sentinel; no gateway policy is simulated"); });
    const scenario = definition.prepare({ validProposal: { callId: "hostile", raw: "{}" }, installFault, faultCalls: () => 0 });
    const target: ScenarioTarget = { ...safe, planner: { script: [] }, executor: new RecordingExecutor({ id: "transport-test", result: { status: "success", value: null } }), audit: new InMemoryAuditSink(), visibleOutput: null, submit };
    const observation = await runScenario(scenario, target);
    expect(installFault).toHaveBeenCalledExactlyOnceWith(definition.port, definition.mode);
    expect(submit).toHaveBeenCalledExactlyOnceWith({ callId: "hostile", raw: "{}" });
    expect(scenario.verify(observation)).toContain("faulted port was not observed through a completed submission");
    const unbound = await runScenario(definition, target);
    expect(definition.verify(unbound)).toContain("missing or surplus decision");
    expect(definition.verify(unbound)).toContain("planner output leaked");
    const setup = definition.prepare({ validProposal: { callId: "x", raw: "{}" }, installFault: async () => { throw new Error("setup failed"); }, faultCalls: () => 0 });
    expect(setup.verify(await runScenario(setup, target))).toContain("faulted port was not observed through a completed submission");
  });
  it("completed-run proof accepts observed port calls, refuses unchanged/invalid counts and cannot be reused", async () => {
    // Synthetic observations test the evidence protocol only; they make no gateway-policy claim.
    const definition = dependencyFailureScenarios[0]!;
    const proposal = { callId: "proof", raw: "{}" };
    for (const [before, after, valid] of [[0, 1, true], [2, 3, true], [0, 0, false], [2, 1, false], [-1, 1, false], [0, NaN, false], [0.5, 1, false], [0, Infinity, false]] as const) {
      let observed: number = before;
      const target: ScenarioTarget = { ...safe, planner: { script: [] }, executor: new RecordingExecutor({ id: "evidence-only", result: { status: "success", value: null } }), audit: new InMemoryAuditSink(), visibleOutput: null,
        submit: async () => { observed = after; return { outcome: "DENIED", category: "try_later" }; } };
      const scenario = definition.prepare({ validProposal: proposal, installFault: async () => {}, faultCalls: () => observed });
      const result = await runScenario(scenario, target);
      expect(scenario.verify(result).length === 0, `${before} -> ${after}`).toBe(valid);
      const reused = await runScenario(scenario, target);
      expect(scenario.verify(reused)).toContain("faulted port was not observed through a completed submission");
    }
  });
  it("existing fault injection throws/returns invalid answers without calling the healthy port", async () => {
    const healthy = vi.fn(async () => true);
    expect(() => (faulty({ check: healthy }, "throws") as { check(): unknown }).check()).toThrow();
    expect((faulty({ check: healthy }, "undefined") as { check(): unknown }).check()).toBeUndefined();
    expect((faulty({ check: healthy }, "wrong-type") as { check(): unknown }).check()).toBe("yes");
    expect((faulty({ check: healthy }, "hangs") as { check(): unknown }).check()).toBeInstanceOf(Promise);
    expect(healthy).not.toHaveBeenCalled();
  });
});

/** What each port's REAL boundary accepts, so a "wrong-type" answer can be proven to be wrong for it and not merely strange. */
const HOOK_KIND = { authentication: "authentication", permissions: "boolean", resources: "resource", pages: "page", "tenant-policy": "tenantPolicy", "audit-append": "void" } as const;
const PORT_METHOD: Record<DependencyPort, string> = {
  authentication: "authenticate", permissions: "has", resources: "resolve", pages: "currentPage", replay: "claim",
  "rate-limiter": "hit", "confirmations-store": "tryAccept", "tenant-policy": "isDisabled", "audit-append": "append",
};
const healthy = (port: DependencyPort) => ({ [PORT_METHOD[port]]: vi.fn(async () => true) });
const answer = (port: DependencyPort, mode: (typeof DEPENDENCY_FAULTS)[number]) => (faultedDependency(port, mode, healthy(port)) as Record<string, () => unknown>)[PORT_METHOD[port]]!();

describe("T123 injected faults really are faults for the port they are injected into", () => {
  it.each(DEPENDENCY_PORTS)("%s: a wrong-type answer is invalid at the port's own boundary", async (port) => {
    const wrong = answer(port, "wrong-type");
    if (port in HOOK_KIND) {
      const checked = await wrapHook(() => wrong, HOOK_KIND[port as keyof typeof HOOK_KIND], { hookTimeoutMs: 50 })();
      expect(checked, `${port} accepted ${JSON.stringify(wrong)}`).toMatchObject({ ok: false, reason: "dependency_failure" });
    }
    // The state ports have their own answer domains: a wrong-type answer is outside all of them.
    if (port === "replay") expect(["claimed", "duplicate"]).not.toContain(wrong);
    if (port === "rate-limiter") expect(typeof wrong === "object" && wrong !== null && typeof (wrong as { allowed?: unknown }).allowed === "boolean").toBe(false);
    if (port === "confirmations-store") expect(typeof wrong === "boolean").toBe(false);
  });
  it("the generic faulty() wrong-type answer 'yes' is a VALID page id, so pages must use a non-string", async () => {
    const generic = (faulty({ currentPage: async () => "page.edit" }, "wrong-type") as { currentPage(): unknown }).currentPage();
    expect(await wrapHook(() => generic, "page", { hookTimeoutMs: 50 })()).toMatchObject({ ok: true, value: "yes" });
    const specialized = answer("pages", "wrong-type");
    expect(typeof specialized).not.toBe("string");
    expect(await wrapHook(() => specialized, "page", { hookTimeoutMs: 50 })()).toMatchObject({ ok: false, reason: "dependency_failure" });
  });
  it("audit append 'undefined' is a bare synchronous undefined (a missing commit receipt), never a healthy resolved Promise<void>", async () => {
    const missing = answer("audit-append", "undefined");
    expect(missing).toBeUndefined();
    expect(await wrapHook(() => missing, "void", { hookTimeoutMs: 50 })()).toMatchObject({ ok: false, reason: "dependency_failure" });
    expect(await wrapHook(async () => undefined, "void", { hookTimeoutMs: 50 })()).toMatchObject({ ok: true });
  });
  it.each(DEPENDENCY_PORTS)("%s: throws throws, hangs never settles, undefined is undefined, and the healthy port is never called", async (port) => {
    const port1 = healthy(port);
    const method = PORT_METHOD[port];
    expect(() => (faultedDependency(port, "throws", port1) as Record<string, () => unknown>)[method]!()).toThrow();
    expect((faultedDependency(port, "undefined", port1) as Record<string, () => unknown>)[method]!()).toBeUndefined();
    const hang = (faultedDependency(port, "hangs", port1) as Record<string, () => unknown>)[method]!();
    expect(hang).toBeInstanceOf(Promise);
    expect(await Promise.race([hang, Promise.resolve("still pending")])).toBe("still pending");
    expect(port1[method]).not.toHaveBeenCalled();
  });
  it("a faulted port is a frozen copy and a mode that does not exist is refused", () => {
    expect(Object.isFrozen(faultedDependency("pages", "wrong-type", healthy("pages")))).toBe(true);
    expect(() => faultedDependency("pages", "nonsense" as never, healthy("pages"))).toThrow(RangeError);
    expect(() => faultedDependency("nonsense" as never, "throws", {})).toThrow(RangeError);
  });
});
