/**
 * @dap/testkit: attacks/audit.ts (T081): ATK-AUDIT-01..05 and 07.
 *
 * Scenario definitions with their own oracles. Each `run` only drives the world it is given (an `AuditAttackTarget`, which
 * the end-to-end world of T070 provides); each `verify` recomputes the expectation from the scenario's stated facts and never
 * asks the Gateway what it decided. ATK-AUDIT-06 (append-only storage) belongs to the PostgreSQL batch (T094).
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import type { AttackObservation, AttackScenario, AuditEvent, AuditEventType, JsonValue, PlannerFeedback, ProposalCall } from "@dap/contracts";
import type { ScenarioTarget } from "../scenario-runner.js";

/** What the audit attacks need from the world, beyond a plain scenario target. Implemented by the end-to-end world (T070). */
export interface AuditAttackTarget extends ScenarioTarget {
  /** Make the audit store refuse appends: every record, or only records of these types. Restored by `failAudit([])`. */
  failAudit(which: "all" | readonly AuditEventType[]): void;
  /** How many audit writes the Gateway has counted as failed (its telemetry). */
  auditWriteFailures(): number;
  /** A proposal the permitted user may execute: valid parameters for this capability. */
  validProposal(): unknown;
  /** A proposal with listed, masked and unlisted parameter values, and what the record may and may not hold. */
  projectionProposal(): { readonly raw: unknown; readonly plain: Readonly<Record<string, JsonValue>>; readonly masked: readonly string[]; readonly canaries: readonly string[] };
}
export interface AuditObservation extends AttackObservation { readonly auditWriteFailures: number; readonly projection?: ReturnType<AuditAttackTarget["projectionProposal"]> }

const call = (id: string, index: number, raw: unknown): ProposalCall => ({ callId: `${id}-${index}`, raw });
const feedbackIs = (feedback: PlannerFeedback | undefined, outcome: string, category: string) => isDeepStrictEqual(feedback, { outcome, category });
const typesOf = (events: readonly AuditEvent[]) => events.map((event) => event.type);
const DECISION_TYPES: readonly AuditEventType[] = ["AI_ACTION_DENIED", "AI_POLICY_VIOLATION", "AI_RATE_LIMITED", "AI_CONFIRMATION_REQUIRED"];

async function observe(target: AuditAttackTarget, id: string, raws: readonly unknown[]): Promise<AuditObservation> {
  const feedback: PlannerFeedback[] = [];
  for (const [index, raw] of raws.entries()) feedback.push(await target.submit(call(id, index, raw)));
  return { feedback, executorCalls: target.executor.calls, auditEvents: target.audit.events, leakFindings: [], auditWriteFailures: target.auditWriteFailures() };
}
const asAuditObservation = (observation: AttackObservation): AuditObservation | undefined => (typeof (observation as Partial<AuditObservation>).auditWriteFailures === "number" ? observation as AuditObservation : undefined);

function scenario(id: string, title: string, run: (target: AuditAttackTarget) => Promise<AuditObservation>, verify: (observation: AuditObservation) => readonly string[]): AttackScenario {
  return {
    id, category: "audit-failure", title, appliesTo: () => true,
    run: (target) => run(target as AuditAttackTarget),
    verify: (observation) => {
      const audited = asAuditObservation(observation);
      return audited === undefined ? ["no audit telemetry was observed"] : verify(audited);
    },
  };
}

export const auditScenarios: readonly AttackScenario[] = [
  scenario("ATK-AUDIT-01", "audit append fails before an allowed action: it is never executed", async (target) => {
    target.failAudit("all");
    return observe(target, "ATK-AUDIT-01", [target.validProposal()]);
  }, (o) => {
    const v: string[] = [];
    if (o.executorCalls !== 0) v.push("executor ran without a durable allow-event");
    if (!feedbackIs(o.feedback[0], "DENIED", "try_later") || o.feedback.length !== 1) v.push("planner was not told to try later");
    if (o.auditEvents.some((event) => event.type === "AI_ACTION_ALLOWED" || event.type === "AI_ACTION_EXECUTED")) v.push("an allow or result record exists although the store failed");
    return v;
  }),

  scenario("ATK-AUDIT-02", "audit append fails for a denial: it is still denied", async (target) => {
    target.failAudit("all");
    return observe(target, "ATK-AUDIT-02", [{ action: "deleteEverything", params: {} }]);
  }, (o) => {
    const v: string[] = [];
    if (o.executorCalls !== 0) v.push("executor ran");
    if (o.feedback.length !== 1 || !feedbackIs(o.feedback[0], "INVALID_ACTION", "not_available")) v.push("the denial changed when its record failed");
    if (o.auditWriteFailures < 1) v.push("the failed record was not counted");
    return v;
  }),

  scenario("ATK-AUDIT-03", "audit append fails after execution: counted, and the planner sees the executed result", async (target) => {
    target.failAudit(["AI_ACTION_EXECUTED"]);
    return observe(target, "ATK-AUDIT-03", [target.validProposal()]);
  }, (o) => {
    const v: string[] = [];
    if (o.executorCalls !== 1) v.push("the action did not run exactly once");
    if (o.feedback.length !== 1 || !feedbackIs(o.feedback[0], "ALLOWED", "ok")) v.push("the planner did not see the executed result");
    if (o.auditWriteFailures < 1) v.push("the failed result record was not counted");
    if (!o.auditEvents.some((event) => event.type === "AI_ACTION_ALLOWED")) v.push("the pre-execution allow-event is missing");
    if (o.auditEvents.some((event) => event.type === "AI_ACTION_EXECUTED")) v.push("a result record exists although the store failed for it");
    return v;
  }),

  scenario("ATK-AUDIT-04", "every proposal has PROPOSED and exactly one decision (or allow and result), tied by request id", async (target) => {
    return observe(target, "ATK-AUDIT-04", [target.validProposal(), { action: "deleteEverything", params: {} }, {}, { action: "executeShell", params: { command: "id" } }, target.validProposal()]);
  }, (o) => {
    const v: string[] = [];
    const byRequest = new Map<string, AuditEvent[]>();
    for (const event of o.auditEvents) byRequest.set(event.requestId, [...(byRequest.get(event.requestId) ?? []), event]);
    if (byRequest.size !== o.feedback.length) v.push("proposals and request ids do not match one to one");
    if (new Set(o.auditEvents.map((event) => event.id)).size !== o.auditEvents.length) v.push("duplicate event id");
    for (const [requestId, group] of byRequest) {
      const types = typesOf(group);
      if (types[0] !== "AI_ACTION_PROPOSED" || types.filter((type) => type === "AI_ACTION_PROPOSED").length !== 1) v.push(`${requestId}: not exactly one PROPOSED, first`);
      const decisions = types.filter((type) => DECISION_TYPES.includes(type));
      const allowed = isDeepStrictEqual(types, ["AI_ACTION_PROPOSED", "AI_ACTION_ALLOWED", "AI_ACTION_EXECUTED"]);
      if (!allowed && decisions.length !== 1) v.push(`${requestId}: not exactly one decision`);
      if (!allowed && decisions.length === 1 && types.length !== 2) v.push(`${requestId}: stray records`);
      if (new Set(group.map((event) => `${event.tenantId}/${event.userId}/${event.aiSessionId}/${event.turnId}/${event.decisionId}`)).size !== 1) v.push(`${requestId}: identity differs between records`);
    }
    return v;
  }),

  scenario("ATK-AUDIT-05", "parameter projection: unlisted parameters absent, masked ones masked", async (target) => {
    const fixture = target.projectionProposal();
    return { ...(await observe(target, "ATK-AUDIT-05", [fixture.raw])), projection: fixture };
  }, (o) => (o.projection === undefined ? ["no projection fixture was observed"] : verifyProjection(o, o.projection))),

  {
    id: "ATK-AUDIT-07", category: "audit-failure", title: "the AI layer has no path to an audit reader", appliesTo: () => true,
    async run() {
      const root = fileURLToPath(new URL("../../../ai", import.meta.url));
      const offenders: string[] = [];
      const manifest = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as { dependencies?: Record<string, string> };
      if (Object.keys(manifest.dependencies ?? {}).some((name) => name === "@dap/security" || name === "@dap/actions")) offenders.push("package.json depends on security or actions");
      const walk = (dir: string): void => {
        for (const name of readdirSync(dir)) {
          const path = join(dir, name);
          if (statSync(path).isDirectory()) { if (name !== "node_modules" && name !== "dist") walk(path); continue; }
          if (!name.endsWith(".ts")) continue;
          if (/from\s+["'](?:@dap\/security|@dap\/actions)[^"']*["']|audit-reader|AuditReader/.test(readFileSync(path, "utf8"))) offenders.push(path.slice(root.length + 1));
        }
      };
      walk(join(root, "src"));
      return { feedback: [], executorCalls: 0, auditEvents: [], leakFindings: offenders, auditWriteFailures: 0 } satisfies AuditObservation;
    },
    verify: (observation) => observation.leakFindings.map((path) => `the AI layer reaches an audit reader: ${path}`),
  },
];

/** ATK-AUDIT-05's oracle, separate because it needs the fixture that produced the proposal. */
export function verifyProjection(observation: AttackObservation, fixture: ReturnType<AuditAttackTarget["projectionProposal"]>): readonly string[] {
  const v: string[] = [];
  const allowed = observation.auditEvents.filter((event) => event.type === "AI_ACTION_ALLOWED");
  if (allowed.length !== 1) return ["expected exactly one allow-event"];
  const view = allowed[0]!.paramsView;
  const expected = { ...fixture.plain, ...Object.fromEntries(fixture.masked.map((path) => [path, "[masked]"])) };
  if (!isDeepStrictEqual({ ...view }, expected)) v.push("the recorded parameters are not exactly the listed plain values and the masked markers");
  const text = JSON.stringify(observation.auditEvents);
  for (const canary of fixture.canaries) if (text.includes(canary)) v.push("an unlisted or masked value reached the audit trail");
  return v;
}
