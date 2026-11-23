/**
 * @dap/testkit: attacks/positive-controls.ts (T083): POS-01 and ATK-PRIV-04.
 *
 * Positive controls: the Gateway must also ALLOW. A scenario set that only ever sees denials cannot tell a working Gateway from one that denies everything.
 */
import { isDeepStrictEqual } from "node:util";
import type { AttackObservation, AttackScenario, AuthorizationContext, JsonValue } from "@dap/contracts";
import type { ScenarioTarget } from "../scenario-runner.js";

/** What the positive controls need from the world. */
export interface PositiveTarget extends ScenarioTarget {
  /** A proposal the permitted user may execute, and the exact validated parameters it must produce. */
  validProposal(): { readonly raw: unknown; readonly validated: JsonValue };
  /** The requesting user's own minted context. */
  readonly requestingUser: AuthorizationContext;
  /** The contexts the executor body received, in order. */
  executorContexts(): readonly AuthorizationContext[];
  /** Optional observation from a host that actually exposes a service-identity hook; the shared Gateway world has no such port. */
  serviceIdentityCalls?(): number;
}
export interface PositiveObservation extends AttackObservation {
  readonly executorContexts: readonly AuthorizationContext[];
  readonly serviceIdentityCalls: number;
  readonly requestingUser: AuthorizationContext;
  /** The exact validated parameters the proposal must have produced, and what the executor body actually received. */
  readonly validated: JsonValue;
  readonly receivedParams: readonly unknown[];
}

/** Ignore plain/null prototypes and key order, but never erase non-JSON values or hidden own keys. */
const jsonData = (value: unknown, ancestors = new Set<object>()): boolean => {
  if (value === null || typeof value === "string" || typeof value === "boolean") return true;
  if (typeof value === "number") return Number.isFinite(value);
  if (typeof value !== "object" || ancestors.has(value)) return false;
  const array = Array.isArray(value);
  if (!array && ![null, Object.prototype].includes(Object.getPrototypeOf(value) as object | null)) return false;
  ancestors.add(value);
  const valid = Reflect.ownKeys(value).every((key) => {
    if (array && key === "length") return true;
    const descriptor = Object.getOwnPropertyDescriptor(value, key)!;
    return typeof key === "string" && !["__proto__", "prototype", "constructor"].includes(key) &&
      (!array || /^(0|[1-9][0-9]*)$/.test(key)) && descriptor.enumerable === true && "value" in descriptor && jsonData(descriptor.value, ancestors);
  }) && (!array || Object.keys(value).length === value.length);
  ancestors.delete(value);
  return valid;
};
const sameData = (received: unknown, expected: unknown): boolean => jsonData(received) && jsonData(expected) && isDeepStrictEqual(JSON.parse(JSON.stringify(received)), JSON.parse(JSON.stringify(expected)));

async function drive(target: PositiveTarget, id: string): Promise<PositiveObservation> {
  const proposal = target.validProposal();
  const feedback = [await target.submit({ callId: `${id}-0`, raw: proposal.raw })];
  return { feedback, executorCalls: target.executor.calls, auditEvents: target.audit.events, leakFindings: [], executorContexts: target.executorContexts(), serviceIdentityCalls: target.serviceIdentityCalls?.() ?? 0, requestingUser: target.requestingUser, validated: proposal.validated, receivedParams: target.executor.receivedParams };
}

export const positiveScenarios: readonly AttackScenario[] = [
  {
    id: "POS-01", category: "privilege-escalation", title: "a permitted user with an enabled SAFE capability executes exactly once with exactly the validated parameters",
    appliesTo: (traits) => traits.risk === "SAFE" && !traits.requiresConfirmation,
    run: (target) => drive(target as PositiveTarget, "POS-01"),
    verify: (observation) => {
      const v: string[] = [];
      const o = observation as Partial<PositiveObservation>;
      if (observation.feedback.length !== 1 || !isDeepStrictEqual(observation.feedback[0], { outcome: "ALLOWED", category: "ok" })) v.push("the proposal was not allowed");
      if (observation.executorCalls !== 1) v.push("the executor did not run exactly once");
      const types = observation.auditEvents.map((event) => event.type);
      if (!isDeepStrictEqual(types, ["AI_ACTION_PROPOSED", "AI_ACTION_ALLOWED", "AI_ACTION_EXECUTED"])) v.push("the trail is not PROPOSED, ALLOWED, EXECUTED");
      if (o.receivedParams === undefined || o.receivedParams.length !== 1 || !sameData(o.receivedParams[0], o.validated)) v.push("the executor did not receive exactly the validated parameters");
      return v;
    },
  },
  {
    id: "ATK-PRIV-04", category: "privilege-escalation", title: "the executor receives the requesting user's own context, without a substituted service identity",
    appliesTo: (traits) => traits.risk === "SAFE" && !traits.requiresConfirmation,
    run: (target) => drive(target as PositiveTarget, "ATK-PRIV-04"),
    verify: (observation) => {
      const v: string[] = [];
      const o = observation as Partial<PositiveObservation>;
      if (observation.executorCalls !== 1 || o.executorContexts?.length !== 1) return ["the executor did not run exactly once"];
      if (o.requestingUser === undefined) return ["no requesting user was observed"];
      return [...v, ...contextViolations(o.executorContexts[0]!, o.requestingUser, o.serviceIdentityCalls ?? -1)];
    },
  },
];

/** The oracle for ATK-PRIV-04, with the requesting user supplied by the test that built the world. */
export function contextViolations(received: AuthorizationContext, requesting: AuthorizationContext, serviceIdentityCalls: number): readonly string[] {
  const v: string[] = [];
  if (received !== requesting) v.push("the executor was not given the requesting user's own context object");
  if (received.userId !== requesting.userId || received.tenantId !== requesting.tenantId || received.sessionId !== requesting.sessionId) v.push("the executor's identity differs from the requesting user's");
  if (serviceIdentityCalls !== 0) v.push("a service-identity hook was invoked");
  return v;
}
