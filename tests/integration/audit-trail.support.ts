/**
 * Shared by the in-memory (T084) and PostgreSQL (T094/T095) audit-trail tests: the reviewer's reading of a trail, and the small mixed sample
 * with the expectations the TEST knows about what it sent and who sent it.
 */
import type { AuditEvent, AuditSink } from "@dap/contracts";
import { validateGatewayConfig } from "@dap/security";
import { ALICE, CAROL, TENANT_A, WIDE_GATEWAY_CONFIG, withGateway } from "@dap/testkit";
import type { GatewayWorld, WorldUser } from "@dap/testkit";

/** What a reviewer can say about ONE request from its events alone: nothing here reads the world, the executors or the feedback. */
export interface Reading { attempted: string | null; version: number | null; verdict: "executed" | "allowed-not-executed" | "denied" | "rate-limited" | "needs-confirmation" | "violation"; reason: string | null; by: string; resource: string | null; executionResult: "success" | "failure" | null }
export function reconstruct(events: readonly AuditEvent[]): Reading[] {
  const byRequest = new Map<string, AuditEvent[]>();
  for (const event of events) byRequest.set(event.requestId, [...(byRequest.get(event.requestId) ?? []), event]);
  return [...byRequest.values()].map((group) => {
    const proposals = group.filter((event) => event.type === "AI_ACTION_PROPOSED");
    if (proposals.length !== 1 || group[0] !== proposals[0]) throw new Error("missing, duplicate or out-of-order proposal");
    const proposed = proposals[0]!;
    const decisions = group.filter((event) => event.type !== "AI_ACTION_PROPOSED" && event.type !== "AI_ACTION_EXECUTED");
    if (decisions.length !== 1) throw new Error(`request ${proposed.requestId} has ${decisions.length} decision events`);
    const decision = decisions[0]!;
    const executions = group.filter((event) => event.type === "AI_ACTION_EXECUTED");
    const executed = executions[0];
    if (executions.length > 1 || group[1] !== decision || (executed && (decision.type !== "AI_ACTION_ALLOWED" || group[2] !== executed || !["success", "failure"].includes(executed.executionResult!)))) throw new Error("invalid execution trail");
    if (group.some((event) => event.tenantId !== proposed.tenantId || event.userId !== proposed.userId || event.decisionId !== proposed.decisionId || event.actionId !== proposed.actionId)) throw new Error("inconsistent request binding");
    if (executed && executed.definitionVersion !== decision.definitionVersion) throw new Error("inconsistent version binding");
    const verdicts = { AI_ACTION_ALLOWED: executed ? "executed" : "allowed-not-executed", AI_ACTION_DENIED: "denied", AI_RATE_LIMITED: "rate-limited", AI_CONFIRMATION_REQUIRED: "needs-confirmation", AI_POLICY_VIOLATION: "violation" } as const;
    const touched = (executed ?? decision).resource;
    return {
      attempted: decision.actionId ?? proposed.actionId, version: decision.definitionVersion, verdict: verdicts[decision.type as keyof typeof verdicts], reason: decision.reason,
      executionResult: executed?.executionResult ?? null, by: `${decision.tenantId}/${decision.userId}`, resource: touched === null ? null : `${touched.type}:${touched.id}`,
    };
  });
}


/** Representative, not twenty: one request of each kind the trail must explain. The expectations are the test's own knowledge of what it sent and who sent it. */
export const A_ALICE: WorldUser = { tenant: "A", user: ALICE };
export const A_CAROL: WorldUser = { tenant: "A", user: CAROL };
const who = (user: string) => `${TENANT_A}/${user}`;
export const EXPECTED: readonly Reading[] = [
  { attempted: "testSafeEcho", version: 1, verdict: "executed", reason: "allowed", by: who(ALICE), resource: "document:doc-1", executionResult: "success" },
  { attempted: "testSafeEcho", version: 1, verdict: "denied", reason: "permission_missing", by: who(CAROL), resource: null, executionResult: null },
  { attempted: "testSafeEcho", version: 1, verdict: "denied", reason: "invalid_parameters", by: who(ALICE), resource: null, executionResult: null },
  { attempted: "missingOne", version: null, verdict: "denied", reason: "unknown_action", by: who(ALICE), resource: null, executionResult: null },
  { attempted: "testSafeEcho", version: 1, verdict: "rate-limited", reason: "rate_limited_capability", by: who(ALICE), resource: null, executionResult: null },
  { attempted: "testHighPublish", version: 1, verdict: "needs-confirmation", reason: "confirmation_required", by: who(ALICE), resource: "document:doc-1", executionResult: null },
  { attempted: "testHighPublish", version: 1, verdict: "denied", reason: "resource_not_available", by: who(ALICE), resource: null, executionResult: null },
  { attempted: "testLowNavigate", version: 1, verdict: "executed", reason: "allowed", by: who(ALICE), resource: null, executionResult: "failure" },
];
export async function sample(options: { auditSink?: AuditSink; startAt?: string; seed?: number } = {}): Promise<GatewayWorld> {
  const config = validateGatewayConfig({ ...WIDE_GATEWAY_CONFIG, limits: { ...WIDE_GATEWAY_CONFIG.limits, perUserPerCapabilityPerMinute: { limit: 1, windowSeconds: 60 } } });
  const world = withGateway({ config, ...(options.auditSink === undefined ? {} : { auditSink: options.auditSink }), ...(options.startAt === undefined ? {} : { startAt: options.startAt }), ...(options.seed === undefined ? {} : { seed: options.seed }) });
  world.executor("testSafeEcho").setNextResult({ status: "success", affected: { type: "document", id: "doc-1" } });
  const send = (user: WorldUser, raw: unknown, callId: string) => world.submit(user, { callId, raw });
  await send(A_ALICE, world.proposal("testSafeEcho").raw, "a");
  await send(A_CAROL, world.proposal("testSafeEcho").raw, "b");
  await send(A_ALICE, { action: "testSafeEcho", params: {} }, "c1");
  await send(A_ALICE, { action: "missingOne", params: {} }, "c2");
  await send(A_ALICE, world.proposal("testSafeEcho").raw, "d");
  await send(A_ALICE, world.proposal("testHighPublish").raw, "e1");
  await send(A_ALICE, world.resourceProposal("testHighPublish", "other-tenant").raw, "e2");
  world.executor("testLowNavigate").failWith("trusted executor failed");
  await send(A_ALICE, world.proposal("testLowNavigate").raw, "f");
  return world;
}

