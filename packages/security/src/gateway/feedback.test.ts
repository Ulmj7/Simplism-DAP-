import { describe, expect, it } from "vitest";
import { OUTCOMES, REASON_CODES } from "@dap/contracts";
import type { PolicyDecision } from "@dap/contracts";
import { toPlannerFeedback } from "./feedback.js";

const retry = new Set(["denial_throttle", "dependency_failure", "audit_unavailable", "state_unavailable", "internal_error"]);
const categories = ["ok", "not_available", "invalid_input", "needs_user_confirmation", "try_later"];
const secret = "CANARY_SECRET_VALUE";
const decision = (outcome: string, reason: string, extra: object = {}): PolicyDecision => ({
  outcome, reason, decisionId: secret, requestId: secret, actionId: secret, paramsDigest: secret,
  confirmationId: "123e4567-e89b-42d3-a456-426614174000", attemptedAction: secret, stage: "authorize", risk: "HIGH", ...extra,
}) as unknown as PolicyDecision;

describe("planner feedback D14 / T057", () => {
  it.each(OUTCOMES.flatMap((outcome) => REASON_CODES.map((reason) => [outcome, reason] as const)))
  ("is total and exposes only closed categories for %s / %s", (outcome, reason) => {
    const feedback = toPlannerFeedback(decision(outcome, reason));
    expect(feedback.outcome).toBe(outcome);
    expect(categories).toContain(feedback.category);
    expect(Object.keys(feedback).sort()).toEqual(["category", "outcome"]);
    expect(JSON.stringify(feedback)).not.toContain(secret);
    expect(JSON.stringify(feedback)).not.toContain("123e4567");
    expect(Object.isFrozen(feedback)).toBe(true);
  });

  it.each([
    ["INVALID_PARAMETERS", "invalid_parameters", "invalid_input"],
    ["INVALID_ACTION", "unknown_action", "not_available"], ["FORBIDDEN_POLICY", "reserved_forbidden_action", "not_available"],
    ["DENIED", "action_not_enabled", "not_available"], ["UNAUTHORIZED", "permission_missing", "not_available"],
    ["DENIED", "resource_not_available", "not_available"], ["DENIED", "tenant_mismatch", "not_available"],
    ["DENIED", "replayed_request", "not_available"], ["REQUIRES_CONFIRMATION", "confirmation_required", "needs_user_confirmation"],
    ["ALLOWED", "allowed", "ok"],
  ])("maps the D14 row %s / %s to %s", (outcome, reason, category) => {
    expect(toPlannerFeedback(decision(outcome!, reason!))).toEqual({ outcome, category });
  });

  it("maps every rate/dependency/audit failure to try_later", () => {
    for (const reason of REASON_CODES.filter((value) => value.startsWith("rate_limited_") || retry.has(value))) {
      expect(toPlannerFeedback(decision("DENIED", reason))).toEqual({ outcome: "DENIED", category: "try_later" });
    }
  });

  it("keeps ALLOWED after executor failure, exposing only try_later (T091)", () => {
    expect(toPlannerFeedback(decision("ALLOWED", "allowed"), "failure")).toEqual({ outcome: "ALLOWED", category: "try_later" });
    expect(toPlannerFeedback(decision("ALLOWED", "allowed"), "success")).toEqual({ outcome: "ALLOWED", category: "ok" });
  });

  it("projects only field paths and generic issue codes, with detached immutable copies", () => {
    const issue = { path: "/name", code: "too_long", value: secret, reason: "permission_missing" };
    const result = toPlannerFeedback(decision("INVALID_PARAMETERS", "invalid_parameters", { issues: [issue] }));
    issue.path = "/mutated";
    expect(result).toEqual({ outcome: "INVALID_PARAMETERS", category: "invalid_input", issues: [{ path: "/name", code: "too_long" }] });
    expect(Object.isFrozen(result.issues?.[0])).toBe(true);
    expect(JSON.stringify(result)).not.toContain(secret);
  });

  it("does not echo unknown parameter names, malformed paths, codes, or extra getters", () => {
    const issues = [
      { path: `/${secret}`, code: "unknown_key", get value(): never { throw new Error(secret); } },
      { path: "/123e4567-e89b-42d3-a456-426614174000", code: "invalid" },
      { path: "/name", code: "permission_missing" },
    ];
    const result = toPlannerFeedback(decision("INVALID_PARAMETERS", "invalid_parameters", { issues }));
    expect(result.issues).toEqual([{ path: "", code: "unknown_key" }, { path: "", code: "invalid" }, { path: "/name", code: "invalid" }]);
    expect(JSON.stringify(result)).not.toContain(secret);
    expect(JSON.stringify(result)).not.toContain("permission_missing");
  });

  it("does not reflect internal codes or digest/id-shaped segments as field paths", () => {
    const issues = ["/permission_missing", `/${"a".repeat(64)}`, "/AKIAIOSFODNN7EXAMPLE"].map((path) => ({ path, code: "type" }));
    const result = toPlannerFeedback(decision("INVALID_PARAMETERS", "invalid_parameters", { issues }));
    expect(result.issues?.map((issue) => issue.path)).toEqual(["", "", ""]);
  });

  it("resource-not-found, denied, other-tenant and wrong-context feedback are byte-identical", () => {
    const values = ["missing", "denied", "other-tenant", "wrong-context"].map((variant) => JSON.stringify(toPlannerFeedback(
      decision("DENIED", "resource_not_available", { attemptedAction: variant, tenantId: variant, resource: variant }),
    )));
    expect(new Set(values).size).toBe(1);
    expect(toPlannerFeedback(decision("DENIED", "tenant_mismatch"))).toEqual(toPlannerFeedback(decision("DENIED", "context_not_allowed")));
  });

  it("reads relevant fields once, ignores hidden metadata, and contains throwing getters", () => {
    const reads = new Map<PropertyKey, number>();
    const input = new Proxy(decision("DENIED", "resource_not_available"), { get(target, key, receiver) {
      reads.set(key, (reads.get(key) ?? 0) + 1);
      if (reads.get(key)! > 1) throw new Error("repeat");
      return Reflect.get(target, key, receiver);
    } });
    expect(toPlannerFeedback(input)).toEqual({ outcome: "DENIED", category: "not_available" });
    expect([...reads.keys()].sort()).toEqual(["outcome", "reason"]);
    expect(toPlannerFeedback({ get outcome(): never { throw new Error(secret); } } as unknown as PolicyDecision)).toEqual({ outcome: "DENIED", category: "try_later" });
  });
});
