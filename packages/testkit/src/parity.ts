/**
 * @dap/testkit: parity.ts (T072)
 *
 * The parity oracle for privilege escalation (ATK-PRIV-01): the Gateway must never decide differently from the host's own check of the
 * same user. It is independent of the Gateway: it asks the HOST's permission checker directly, with the same context and permission,
 * and compares. A Gateway that allows what the host denies is an escalation; one that denies a user the host allows is only acceptable when
 * the scenario says the denial is for another reason (`expect: "any"`).
 */
import type { AuthorizationContext, PermissionChecker, PermissionId, PlannerFeedback } from "@dap/contracts";

export interface ParityInput {
  /** What the planner was told. */
  readonly feedback: PlannerFeedback;
  /** The host's raw answer to the same question, asked directly. Only the literal `true` is an allow. */
  readonly host: unknown;
  /** `denied`: the scenario's user lacks the permission, so BOTH must deny. `any`: they must merely agree on any allow. */
  readonly expect: "denied" | "any";
}

/** Violations of parity; empty means the Gateway and the host agree. */
export function parityViolations({ feedback, host, expect }: ParityInput): readonly string[] {
  const violations: string[] = [];
  const hostAllows = host === true;
  const gatewayAllows = feedback.outcome === "ALLOWED";
  if (gatewayAllows && !hostAllows) violations.push("the gateway allowed what the host's own check denies");
  if (expect === "denied") {
    if (hostAllows) violations.push("the scenario's user is allowed by the host: the fixture does not lack the permission");
    if (!gatewayAllows && feedback.outcome !== "UNAUTHORIZED") violations.push("the gateway denied with an outcome other than UNAUTHORIZED");
  }
  return violations;
}

/** Asks the host directly (never through the Gateway) and compares. A host that throws is a violation, never an allow. */
export async function hostParity(host: PermissionChecker, context: AuthorizationContext, permission: PermissionId, feedback: PlannerFeedback, expect: ParityInput["expect"]): Promise<readonly string[]> {
  let answer: unknown;
  try { answer = await host.has(context, permission); } catch { return ["the host's own check could not be asked"]; }
  return parityViolations({ feedback, host: answer, expect });
}
