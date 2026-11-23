import { describe, expect, it } from "vitest";
import fc from "fast-check";
import { parseStrictJson } from "../../packages/security/src/validation/strict-json.js";
import { denyDecision, toPlannerFeedback, validateParams } from "@dap/security";
import { REASON_CODES } from "@dap/contracts";
import { ALICE, TENANT_A, TENANT_B, executionViolations, mayReachExecutor, LeakScanner, testSafeEcho } from "@dap/testkit";
import type { ExecutionFacts } from "@dap/testkit";

const permittedFacts: ExecutionFacts = {
  tenantId: TENANT_A, resourceTenantId: TENANT_A, risk: "SAFE",
  authenticated: true, sessionValid: true, schemaValid: true, registered: true,
  globallyEnabled: true, tenantEnabled: true, userPermitted: true, contextAllowed: true,
  withinLimits: true, replayClaimed: true, allowEventCommitted: true, dependenciesHealthy: true,
  targetsResource: true, resourceAvailable: true, requiresConfirmation: false, confirmationAccepted: false,
};
const PREREQUISITES = ["authenticated", "sessionValid", "schemaValid", "registered", "globallyEnabled", "tenantEnabled", "userPermitted", "contextAllowed", "withinLimits", "replayClaimed", "allowEventCommitted", "dependenciesHealthy"] as const;
type Prerequisite = (typeof PREREQUISITES)[number];
const BS = String.fromCharCode(92);

const settings = { seed: 125001, numRuns: 250 };
const scope = { tenantId: TENANT_A, userId: ALICE };

// Worlds that actually REACH the interesting cases: a uniform array of booleans is all-true once in 4096 worlds and has
// exactly one missing prerequisite once in 340, so it would pass for an oracle that ignores any single prerequisite.
const NOT_TRUE: fc.Arbitrary<unknown> = fc.constantFrom(false, undefined, null, "true", "yes", 1, 0, {}, [true], Number.NaN);
const brokenSet: fc.Arbitrary<readonly Prerequisite[]> = fc.oneof(
  { weight: 3, arbitrary: fc.constant<readonly Prerequisite[]>([]) },
  { weight: 4, arbitrary: fc.uniqueArray(fc.constantFrom(...PREREQUISITES), { minLength: 1, maxLength: 1 }) },
  { weight: 3, arbitrary: fc.uniqueArray(fc.constantFrom(...PREREQUISITES), { minLength: 2, maxLength: PREREQUISITES.length }) },
);
const world = fc.tuple(brokenSet, fc.array(NOT_TRUE, { minLength: PREREQUISITES.length, maxLength: PREREQUISITES.length }));

describe("T125 catalogue invariants (recorded seed 125001)", () => {
  it("generators are reproducible from the recorded seed, and reach permitted, single-fault and multi-fault worlds", () => {
    expect(fc.sample(world, { seed: settings.seed, numRuns: 30 })).toEqual(fc.sample(world, { seed: settings.seed, numRuns: 30 }));
    const sizes = fc.sample(world, { seed: settings.seed, numRuns: 400 }).map(([broken]) => Math.min(broken.length, 2));
    for (const size of [0, 1, 2]) expect(sizes.filter((value) => value === size).length, `worlds with ${size} broken`).toBeGreaterThan(40);
  });

  it("1: the independent oracle admits a world exactly when EVERY prerequisite is literally true, whichever one is broken and however", () => {
    const singles = new Map<string, number>(); let permitted = 0; let multi = 0;
    fc.assert(fc.property(world, ([broken, values]) => {
      const facts = { ...permittedFacts, ...Object.fromEntries(broken.map((key, index) => [key, values[index]])) } as ExecutionFacts;
      expect(mayReachExecutor(facts), JSON.stringify(broken)).toBe(broken.length === 0);
      expect(executionViolations(facts, 1)).toHaveLength(broken.length === 0 ? 0 : 1);
      expect(executionViolations(facts, 0)).toEqual([]);
      if (broken.length === 0) permitted++; else if (broken.length === 1) singles.set(broken[0]!, (singles.get(broken[0]!) ?? 0) + 1); else multi++;
    }), settings);
    expect(permitted).toBeGreaterThan(20); expect(multi).toBeGreaterThan(20);
    for (const key of PREREQUISITES) expect(singles.get(key) ?? 0, `single-fault worlds for ${key}`).toBeGreaterThan(0);
  });

  it("1: risk, resource tenancy and confirmation each independently forbid execution, and each independently suffice when satisfied", () => {
    const risks = fc.constantFrom("SAFE", "LOW", "MEDIUM", "HIGH", "CRITICAL", "FORBIDDEN", "invented", "", "safe");
    const tenants = fc.constantFrom<string | null>(TENANT_A, TENANT_B, null, TENANT_A.toUpperCase(), ` ${TENANT_A}`);
    const flag = fc.constantFrom<unknown>(true, false, undefined, "true", 1);
    let admitted = 0; let refused = 0;
    fc.assert(fc.property(risks, fc.boolean(), tenants, flag, fc.boolean(), flag, (risk, targetsResource, resourceTenantId, resourceAvailable, requiresConfirmation, confirmationAccepted) => {
      const facts = { ...permittedFacts, risk, targetsResource, resourceTenantId, resourceAvailable, requiresConfirmation, confirmationAccepted } as ExecutionFacts;
      const knownRisk = ["SAFE", "LOW", "MEDIUM", "HIGH", "CRITICAL"].includes(risk);
      const resourceOk = !targetsResource || (resourceAvailable === true && resourceTenantId === TENANT_A);
      const confirmed = !(requiresConfirmation || risk === "HIGH" || risk === "CRITICAL") || confirmationAccepted === true;
      const expected = knownRisk && resourceOk && confirmed;
      expect(mayReachExecutor(facts), JSON.stringify({ risk, targetsResource, resourceTenantId, resourceAvailable, requiresConfirmation, confirmationAccepted })).toBe(expected);
      if (expected) admitted++; else refused++;
    }), settings);
    expect(admitted).toBeGreaterThan(10); expect(refused).toBeGreaterThan(10);
  });
  // SC-007 real-chain evidence: review-fixes.test.ts (preconditions and post-ALLOW faults) and integration/audit-postgres.test.ts (durable ALLOW before the body).

  it("2: same proposal and scope produce byte-identical validation and digest; the digest is bound to tenant and user", () => {
    let accepted = 0; let rejected = 0;
    fc.assert(fc.property(fc.oneof(fc.record({ message: fc.string({ minLength: 1, maxLength: 100 }) }), fc.jsonValue()), (params) => {
      const first = validateParams(testSafeEcho, params, scope);
      const second = validateParams(testSafeEcho, params, scope);
      expect(JSON.stringify(first)).toBe(JSON.stringify(second));
      expect(first).toEqual(second);
      if (!first.ok) { rejected++; return; }
      accepted++;
      expect(first.paramsDigest).toMatch(/^[a-f0-9]{64}$/);
      const otherTenant = validateParams(testSafeEcho, params, { tenantId: TENANT_B, userId: ALICE });
      const otherUser = validateParams(testSafeEcho, params, { tenantId: TENANT_A, userId: "bob" });
      expect(otherTenant.ok && otherTenant.paramsDigest).not.toBe(first.paramsDigest);
      expect(otherUser.ok && otherUser.paramsDigest).not.toBe(first.paramsDigest);
    }), settings);
    expect(accepted).toBeGreaterThan(20); expect(rejected).toBeGreaterThan(20);
  });
  // Invariant 2 on the REAL chain: test-world.gateway.test.ts ("is deterministic: two worlds given the same proposals record identical events") and prompt-injection.test.ts
  // ("every corpus string gives the benign outcome, audit reasons and executor count, on independent fresh worlds"); reconciled in T071, no longer a todo.

  it("3: planner-visible feedback for EVERY non-allowed outcome carries no canary and no internal reason", () => {
    const outcomes = fc.constantFrom("DENIED", "INVALID_ACTION", "FORBIDDEN_POLICY", "UNAUTHORIZED", "INVALID_PARAMETERS");
    const issue = fc.record({ path: fc.constantFrom("", "/message", "/items/0/name"), code: fc.constantFrom("required", "type", "unknown_key", "too_long", "too_many", "out_of_range", "format", "invalid") });
    const vocabulary = new Set(["outcome", "category", "issues"]);
    const harmless = new Set<string>(["not_available", "try_later", "invalid_input", "needs_user_confirmation", "ok"]);
    const internal = REASON_CODES.filter((reason) => !harmless.has(reason));
    fc.assert(fc.property(fc.string(), fc.constantFrom(...REASON_CODES), outcomes, fc.array(issue, { maxLength: 3 }), (text, reason, outcome, issues) => {
      const canary = `CANARY_PRIVATE_${text}_END`;
      const feedback = toPlannerFeedback(denyDecision({ decisionId: "d", requestId: "r" as never, stage: "authorize", outcome, reason, attemptedAction: canary, ...(outcome === "INVALID_PARAMETERS" ? { issues } : {}) }));
      const serialized = JSON.stringify(feedback);
      expect(new LeakScanner({ canaries: [canary] }).scan(feedback)).toEqual([]);
      expect(Object.keys(feedback).every((key) => vocabulary.has(key)), serialized).toBe(true);
      expect(Object.hasOwn(feedback, "issues")).toBe(outcome === "INVALID_PARAMETERS" && issues.length > 0);
      for (const code of internal) expect(serialized, `reason ${code}`).not.toContain(`"${code}"`);
      expect(feedback.category).toBe(outcome === "INVALID_PARAMETERS" ? "invalid_input" : feedback.category);
      expect(["invalid_input", "try_later", "not_available"]).toContain(feedback.category);
      // Positive control: the same scanner DOES find the canary in output that has it.
      expect(new LeakScanner({ canaries: [canary] }).scan({ output: canary }).some((finding) => finding.kind === "canary")).toBe(true);
    }), settings);
  });
  it.todo("3 (OPTIONAL): a GENERATED sweep of port faults over the real chain; the representative per-port faults with canaries and stack text are proven in secret-extraction.test.ts (T082 (2) and (4))");

  it("4: strict parameter intake never returns a value with two colliding keys or a prototype key, at any depth, however the key is spelled", () => {
    const spell = (key: string, mask: readonly boolean[]) => [...key].map((char, index) => (mask[index % mask.length] ? `${BS}u${char.charCodeAt(0).toString(16).padStart(4, "0")}` : char)).join("");
    const masks = fc.array(fc.boolean(), { minLength: 1, maxLength: 12 });
    let rejected = 0;
    fc.assert(fc.property(fc.string({ minLength: 1, maxLength: 100 }), fc.constantFrom("__proto__", "constructor", "prototype"), masks, fc.constantFrom(0, 1, 3), (text, key, mask, depth) => {
      const quoted = JSON.stringify(text);
      const nest = (inner: string) => `{"message":${quoted},"child":`.repeat(depth) + inner + "}".repeat(depth);
      const spelled = `"${spell(key, mask)}"`;
      const duplicates = nest(`{"message":${quoted},"mess${BS}u0061ge":"second"}`);
      const prototype = nest(`{"message":${quoted},${spelled}:{}}`);
      expect(parseStrictJson(duplicates).ok, duplicates).toBe(false);
      expect(parseStrictJson(prototype).ok, prototype).toBe(false);
      rejected += 2;
      expect(parseStrictJson(nest(`{"message":${quoted}}`)).ok).toBe(true);
    }), settings);
    expect(rejected).toBeGreaterThan(300);
  });
});
