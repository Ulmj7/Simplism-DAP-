/**
 * T104a, stage 7: the deterministic risk decision. Which risk classes continue, which need a confirmation, which are refused, and that every
 * malformed, missing or inconsistent fact fails closed. It reads the risk class and the confirmation policy from the proven definition
 * snapshot (read once), never from the proposal, never creates a confirmation record, and never returns ALLOWED.
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { toPlannerFeedback } from "../feedback.js";
import { createNoConfirmationStage, createRiskGateStage } from "./risk-gate.js";
import { recordOf } from "./stage-facts.test-support.js";
import type { Facts } from "./stage-facts.test-support.js";

const HASH = "a".repeat(64);
const DIGEST = "b".repeat(64);
const CONF = "22222222-2222-4222-8222-222222222222";
const JUSTIFICATION = "Private drafts are reversible and never published.";

const NOT_REQUIRED = { kind: "not-required" } as const;
const REQUIRED = { kind: "required" } as const;
type Definition = Record<string, unknown>;

function build(definition: Definition, options: { ids?: () => unknown; get?: () => unknown } = {}) {
  let confirmationIds = 0;
  const ids = { newConfirmationId: () => { confirmationIds += 1; return (options.ids ?? (() => CONF))(); } };
  const live = { id: "openProject", version: 2, ...definition };
  const registry = { get: options.get ?? (() => ({ definition: live, definitionHash: HASH })), list: () => [], isReservedForbidden: () => false };
  const stage = createRiskGateStage({ registry: registry as never, ids: ids as never });
  return { stage, confirmationIds: () => confirmationIds, live };
}
const facts = (risk: string, over: Partial<Facts> = {}): Facts => ({
  intake: { callId: "call-1", action: "openProject", params: { projectId: "p1" } },
  resolve: { id: "openProject", version: 2, risk, definitionHash: HASH },
  validate: { params: { projectId: "p1" }, paramsDigest: DIGEST, resource: null },
  authorize: { resource: null },
  ...over,
});
const outcome = (result: unknown) => result as { kind: string; data?: Record<string, unknown>; decision?: Record<string, unknown> };
const decide = async (risk: string, policy: unknown, over: Partial<Facts> = {}, extra: Definition = {}) =>
  outcome(await build({ risk, confirmation: policy, ...extra }).stage(recordOf(facts(risk, over))));

describe("the risk matrix", () => {
  it.each([["SAFE"], ["LOW"]])("%s continues and publishes facts.risk exactly", async (risk) => {
    const result = await decide(risk, NOT_REQUIRED);
    expect(result).toEqual({ kind: "continue", data: { risk, confirmation: "not_required" } });
  });

  it("MEDIUM that opted out of confirmation with a recorded justification continues", async () => {
    expect(await decide("MEDIUM", { kind: "not-required", justification: JUSTIFICATION })).toEqual({ kind: "continue", data: { risk: "MEDIUM", confirmation: "not_required" } });
  });

  it("MEDIUM that requires confirmation needs one", async () => {
    expect(await decide("MEDIUM", REQUIRED)).toMatchObject({ kind: "stop", decision: { outcome: "REQUIRES_CONFIRMATION", risk: "MEDIUM", actionId: "openProject" } });
  });

  it.each([
    ["no justification", { kind: "not-required" }], ["an empty justification", { kind: "not-required", justification: "" }],
    ["a blank justification", { kind: "not-required", justification: "  \n\t " }], ["a justification that is not a string", { kind: "not-required", justification: 42 }],
    ["a justification that is an object", { kind: "not-required", justification: { text: JUSTIFICATION } }], ["a justification over the bound", { kind: "not-required", justification: "x".repeat(1001) }],
  ])("MEDIUM that opts out with %s needs a confirmation", async (_name, policy) => {
    expect(await decide("MEDIUM", policy)).toMatchObject({ kind: "stop", decision: { outcome: "REQUIRES_CONFIRMATION", risk: "MEDIUM" } });
  });
  it("a justification at the bound is valid", async () => {
    expect(await decide("MEDIUM", { kind: "not-required", justification: "x".repeat(1000) })).toMatchObject({ kind: "continue" });
  });

  it.each([["HIGH"], ["CRITICAL"]])("%s always needs a confirmation, whatever its policy says", async (risk) => {
    for (const policy of [REQUIRED, NOT_REQUIRED, { kind: "not-required", justification: JUSTIFICATION }]) {
      expect(await decide(risk, policy), JSON.stringify(policy)).toMatchObject({ kind: "stop", decision: { outcome: "REQUIRES_CONFIRMATION", risk } });
    }
  });

  it.each([["SAFE"], ["LOW"]])("%s whose own policy requires confirmation is held to that policy", async (risk) => {
    expect(await decide(risk, REQUIRED)).toMatchObject({ kind: "stop", decision: { outcome: "REQUIRES_CONFIRMATION", risk } });
  });

  it("FORBIDDEN is refused as FORBIDDEN_POLICY at the risk stage, and never asks for a confirmation id", async () => {
    const world = build({ risk: "FORBIDDEN", confirmation: NOT_REQUIRED });
    const result = outcome(await world.stage(recordOf(facts("FORBIDDEN"))));
    expect(result).toMatchObject({ kind: "stop", decision: { outcome: "FORBIDDEN_POLICY", reason: "reserved_forbidden_action", stage: "risk" } });
    expect(world.confirmationIds()).toBe(0);
  });

  it("never returns ALLOWED, whatever the class", async () => {
    for (const risk of ["SAFE", "LOW", "MEDIUM", "HIGH", "CRITICAL", "FORBIDDEN"]) {
      for (const policy of [REQUIRED, NOT_REQUIRED, { kind: "not-required", justification: JUSTIFICATION }]) {
        const result = await decide(risk, policy);
        expect(result.decision?.outcome).not.toBe("ALLOWED");
      }
    }
  });
});

describe("a confirmation decision", () => {
  it("carries the ids, the action, the class and a well-formed confirmation handle, and nothing else", async () => {
    const result = await decide("HIGH", REQUIRED);
    expect(result.decision).toEqual({ outcome: "REQUIRES_CONFIRMATION", decisionId: "decision-request", requestId: "request", actionId: "openProject", risk: "HIGH", confirmationId: CONF });
  });
  it("is told to the planner without an id or a token", async () => {
    const { decision } = await decide("CRITICAL", REQUIRED);
    const feedback = toPlannerFeedback(decision as never);
    expect(feedback).toEqual({ outcome: "REQUIRES_CONFIRMATION", category: "needs_user_confirmation" });
    expect(JSON.stringify(feedback)).not.toContain(CONF);
  });
  it("asks for the handle only when one is needed, and once", async () => {
    const safe = build({ risk: "SAFE", confirmation: NOT_REQUIRED });
    await safe.stage(recordOf(facts("SAFE")));
    expect(safe.confirmationIds()).toBe(0);
    const high = build({ risk: "HIGH", confirmation: REQUIRED });
    await high.stage(recordOf(facts("HIGH")));
    expect(high.confirmationIds()).toBe(1);
  });
  it.each([
    ["throws", () => { throw new Error("CANARY"); }], ["is not a uuid", () => "not-a-uuid"], ["is empty", () => ""], ["is undefined", () => undefined],
    ["is a number", () => 7], ["is a promise", () => Promise.resolve(CONF)], ["is an object", () => ({ toString: () => CONF })], ["is a rejected promise", () => Promise.reject(new Error("x"))],
  ])("fails closed when the id generator %s", async (_name, ids) => {
    const result = outcome(await build({ risk: "HIGH", confirmation: REQUIRED }, { ids }).stage(recordOf(facts("HIGH"))));
    expect(result).toMatchObject({ kind: "stop", decision: { outcome: "DENIED", reason: "dependency_failure", stage: "risk" } });
    expect(JSON.stringify(result)).not.toContain("CANARY");
  });
});

describe("any malformed, missing or inconsistent fact fails closed", () => {
  const denied = { kind: "stop", decision: { outcome: "DENIED", reason: "dependency_failure", stage: "risk" } };
  const SAFE_DEFINITION = { risk: "SAFE", confirmation: NOT_REQUIRED };
  const run = async (over: Partial<Facts>, definition: Definition = SAFE_DEFINITION, risk = "SAFE") => outcome(await build(definition).stage(recordOf(facts(risk, over))));

  it("resolve.risk disagreeing with the definition snapshot", async () => {
    expect(await run({}, { risk: "HIGH", confirmation: REQUIRED }, "SAFE")).toMatchObject(denied);
    expect(await run({}, { risk: "SAFE", confirmation: NOT_REQUIRED }, "HIGH")).toMatchObject(denied);
  });
  it.each([["EXTREME"], ["safe"], [""], [7], [null]])("an unknown risk class %j in the resolve fact", async (risk) => {
    const base = facts("SAFE");
    expect(outcome(await build(SAFE_DEFINITION).stage(recordOf({ ...base, resolve: { ...(base.resolve as object), risk } })))).toMatchObject(denied);
  });
  it.each([["EXTREME"], ["safe"], [undefined], [7]])("an unknown risk class %j in the definition snapshot", async (risk) => {
    expect(await run({}, { risk, confirmation: NOT_REQUIRED })).toMatchObject(denied);
  });
  it.each([["a missing"], ["a null"], ["a string"], ["an unknown kind"], ["a kind that is not a string"]])("%s confirmation policy", async (name) => {
    const policy = { "a missing": undefined, "a null": null, "a string": "required", "an unknown kind": { kind: "maybe" }, "a kind that is not a string": { kind: 1 } }[name];
    expect(await run({}, { risk: "SAFE", confirmation: policy })).toMatchObject(denied);
    expect(await run({}, { risk: "HIGH", confirmation: policy }, "HIGH")).toMatchObject(denied);
  });
  it.each(["intake", "resolve", "validate", "authorize"])("a missing %s fact", async (slot) => {
    const base = facts("SAFE");
    const { [slot]: _gone, ...rest } = base; void _gone;
    expect(outcome(await build(SAFE_DEFINITION).stage(recordOf(rest)))).toMatchObject(denied);
  });
  it.each([
    ["an extra key in resolve", "resolve", { extra: 1 }], ["a bad definition hash", "resolve", { definitionHash: "nope" }], ["a version of 0", "resolve", { version: 0 }],
    ["an extra key in intake", "intake", { extra: 1 }], ["another action in intake", "intake", { action: "otherAction" }],
    ["a bad digest in validate", "validate", { paramsDigest: "nope" }], ["a resource in validate that authorize did not resolve", "validate", { resource: { type: "project", id: "p1" } }],
    ["a resource in authorize that validate did not extract", "authorize", { resource: { type: "project", id: "p1", displayName: "P" } }],
  ])("%s", async (_name, slot, patch) => {
    const base = facts("SAFE");
    const bent = { ...base, [slot]: { ...(base[slot] as object), ...patch } };
    expect(outcome(await build(SAFE_DEFINITION).stage(recordOf(bent)))).toMatchObject(denied);
  });
  it("a facts record that is not an object", async () => {
    for (const bad of [null, "x", 1]) expect(outcome(await build(SAFE_DEFINITION).stage(recordOf({ ...facts("SAFE"), resolve: bad })))).toMatchObject(denied);
  });
  it("a registry that has forgotten the action, or answers with another version, hash or id", async () => {
    const definition = { risk: "SAFE", confirmation: NOT_REQUIRED };
    for (const get of [() => undefined, () => null, () => 5, () => ({ definition: null, definitionHash: HASH }),
      () => ({ definition: { id: "openProject", version: 3, ...definition }, definitionHash: HASH }),
      () => ({ definition: { id: "other", version: 2, ...definition }, definitionHash: HASH }),
      () => ({ definition: { id: "openProject", version: 2, ...definition }, definitionHash: "c".repeat(64) }),
      () => { throw new Error("registry down"); }]) {
      const result = outcome(await build(definition, { get }).stage(recordOf(facts("SAFE"))));
      expect(result).toMatchObject(denied);
    }
  });
  it("a context that is not minted", async () => {
    expect(outcome(await build(SAFE_DEFINITION).stage(recordOf(facts("SAFE"), { context: { userId: "forged" } })))).toMatchObject(denied);
    expect(outcome(await build(SAFE_DEFINITION).stage(recordOf(facts("SAFE"), { context: null })))).toMatchObject(denied);
  });
});

describe("what it reads, and what it never trusts", () => {
  it("reads the class and the policy of the live definition once, however the host answers afterwards", async () => {
    let riskReads = 0; let policyReads = 0;
    const definition = {
      get risk() { riskReads += 1; return riskReads === 1 ? "SAFE" : "HIGH"; },
      get confirmation() { policyReads += 1; return policyReads === 1 ? NOT_REQUIRED : REQUIRED; },
    };
    const result = outcome(await build(definition).stage(recordOf(facts("SAFE"))));
    expect(result).toMatchObject({ kind: "continue", data: { risk: "SAFE" } });
    expect([riskReads, policyReads]).toEqual([1, 1]);
  });
  it("reads the justification once", async () => {
    let reads = 0;
    const policy = { kind: "not-required", get justification() { reads += 1; return reads === 1 ? JUSTIFICATION : ""; } };
    expect(await decide("MEDIUM", policy)).toMatchObject({ kind: "continue" });
    expect(reads).toBe(1);
  });
  it("is not moved by anything in the proposal: claims of risk or confirmation in the parameters change nothing", async () => {
    const hostile = { risk: "SAFE", confirmation: "not_required", confirmed: true, approved: true, confirmationId: CONF, isAdmin: true };
    const base = facts("HIGH", { intake: { callId: "c", action: "openProject", params: hostile } });
    const result = outcome(await build({ risk: "HIGH", confirmation: REQUIRED }).stage(recordOf(base)));
    expect(result).toMatchObject({ kind: "stop", decision: { outcome: "REQUIRES_CONFIRMATION", risk: "HIGH" } });
  });
  it("never reads the proposal itself", async () => {
    const record = recordOf(facts("SAFE"), { readProposal: () => { throw new Error("the risk stage must not read the proposal"); } });
    expect(outcome(await build({ risk: "SAFE", confirmation: NOT_REQUIRED }).stage(record))).toMatchObject({ kind: "continue" });
  });
  it("publishes a frozen result, and the live definition changing afterwards changes nothing already published", async () => {
    const world = build({ risk: "SAFE", confirmation: { kind: "not-required" } });
    const result = outcome(await world.stage(recordOf(facts("SAFE"))));
    expect(Object.isFrozen(result)).toBe(true);
    expect(Object.isFrozen(result.data)).toBe(true);
    (world.live as Record<string, unknown>).risk = "HIGH";
    expect(result.data).toEqual({ risk: "SAFE", confirmation: "not_required" });
    const held = outcome(await decide("HIGH", REQUIRED));
    expect(Object.isFrozen(held.decision)).toBe(true);
  });
  it("neither imports nor names the confirmation service or store, and never returns ALLOWED itself", () => {
    const source = readFileSync(fileURLToPath(new URL("./risk-gate.ts", import.meta.url)), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");
    expect(source).not.toMatch(/ConfirmationStore|ConfirmationService|confirmation\/(service|store)|state\/.*confirm/i);
    expect(source).not.toMatch(/allowedDecision|"ALLOWED"/);
    expect(source).not.toMatch(/\.create\(|tryAccept|recordExecution/);
  });
});

describe("the confirmation position when nothing needed confirming", () => {
  const stage = createNoConfirmationStage();
  const withRisk = (risk: string, confirmation: unknown = "not_required", over: Partial<Facts> = {}): Facts => ({ ...facts(risk), risk: { risk, confirmation }, ...over });

  it("publishes facts.confirmation exactly, and only after a risk fact that says none was needed", async () => {
    expect(outcome(await stage(recordOf(withRisk("SAFE"))))).toEqual({ kind: "continue", data: { state: "not_required", confirmationId: null } });
    expect(Object.isFrozen(outcome(await stage(recordOf(withRisk("MEDIUM")))).data)).toBe(true);
  });
  it.each([
    ["no risk fact", () => facts("SAFE")], ["a risk fact for another class", () => withRisk("SAFE", "not_required", { risk: { risk: "HIGH", confirmation: "not_required" } })],
    ["a confirmation that was accepted, which nothing exists yet to have done", () => withRisk("HIGH", "accepted")], ["an unknown class", () => withRisk("EXTREME")],
    ["an extra key", () => withRisk("SAFE", "not_required", { risk: { risk: "SAFE", confirmation: "not_required", extra: 1 } })], ["a risk fact that is not an object", () => withRisk("SAFE", "not_required", { risk: "SAFE" as never })],
    ["no resolve fact", () => { const f = withRisk("SAFE"); delete f.resolve; return f; }],
    ["a FORBIDDEN class, which nothing may continue with", () => ({ ...facts("FORBIDDEN"), risk: { risk: "FORBIDDEN", confirmation: "not_required" } })],
  ])("fails closed on %s", async (_name, make) => {
    expect(outcome(await stage(recordOf(make())))).toMatchObject({ kind: "stop", decision: { outcome: "DENIED", reason: "dependency_failure", stage: "confirmation" } });
  });
});
