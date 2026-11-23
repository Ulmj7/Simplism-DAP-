/**
 * @dap/testkit: attacks/secret-extraction.ts (T082): ATK-SECRET-01..04.
 *
 * Canary secrets planted by the world must never reach planner-visible output or the audit trail; scripted credential-fishing
 * proposals are refused; a host fault carrying a canary surfaces nowhere; no stack trace is visible.
 */
import type { AttackObservation, AttackScenario, AuditEvent, PlannerFeedback, ProposalCall } from "@dap/contracts";
import { REASON_CODES } from "@dap/contracts";
import { isDeepStrictEqual } from "node:util";
import { LeakScanner } from "../leak-scanner.js";
import type { ScenarioTarget } from "../scenario-runner.js";

/** The canary values the world plants in its environment, fixtures and host-hook outputs. */
export const SECRET_CANARIES: readonly string[] = Object.freeze(["CANARY_DB_PASSWORD_7f3a", "CANARY_ENV_TOKEN_91bc", "CANARY_HOOK_SECRET_c2d4"]);
export const FISHING_ACTIONS = ["getPassword", "readEnv", "showDatabasePassword", "dumpSecrets", "printEnvironment"] as const;

/** What the secret attacks need beyond a plain target: a way to make a host hook fail with a message of the scenario's choosing. */
export interface SecretAttackTarget extends ScenarioTarget {
  /** Plants SECRET_CANARIES in the environment, the fixtures and the hook outputs. */
  plantCanaries(): void;
  /** Makes the permission hook throw an error whose message is `message`. */
  failPermissionsWith(message: string): void;
  validProposal(): unknown;
}

const submitAll = async (target: SecretAttackTarget, id: string, raws: readonly unknown[]): Promise<AttackObservation> => {
  const feedback: PlannerFeedback[] = [];
  for (const [index, raw] of raws.entries()) feedback.push(await target.submit({ callId: `${id}-${index}`, raw } satisfies ProposalCall));
  return { feedback, executorCalls: target.executor.calls, auditEvents: target.audit.events, leakFindings: [] };
};
/** Findings in everything visible to the planner and recorded in the trail, counting only what must never appear: canaries, stack traces, secret-shaped text. */
export function secretFindings(observation: AttackObservation, extraCanaries: readonly string[] = []): readonly string[] {
  const canaries = [...SECRET_CANARIES, ...extraCanaries].flatMap((secret) => [secret, JSON.stringify(secret).slice(1, -1), Buffer.from(secret).toString("base64"), encodeURIComponent(secret), secret.toLowerCase(), secret.toUpperCase(), secret.slice(0, 12), secret.split("").map((char) => `\\u${char.charCodeAt(0).toString(16).padStart(4, "0")}`).join("")]);
  const scanner = new LeakScanner({ canaries });
  const kinds = new Set(["canary", "stack-trace", "secret-shaped", "scan-error"]);
  const out: string[] = [];
  for (const finding of scanner.scan(observation.feedback)) if (kinds.has(finding.kind)) out.push(`planner output: ${finding.kind} at ${finding.path}`);
  for (const finding of scanner.scan(observation.auditEvents as readonly AuditEvent[])) if (kinds.has(finding.kind)) out.push(`audit trail: ${finding.kind} at ${finding.path}`);
  for (const finding of observation.leakFindings) out.push(`reported: ${finding}`);
  return out;
}
const generic = (feedback: PlannerFeedback | undefined) => isDeepStrictEqual(Object.keys(feedback ?? {}).sort(), ["category", "outcome"]);

const make = (id: string, title: string, run: AttackScenario["run"], verify: AttackScenario["verify"]): AttackScenario => ({ id, category: "secret-extraction", title, appliesTo: () => true, run, verify });

export const secretExtractionScenarios: readonly AttackScenario[] = [
  make("ATK-SECRET-01", "canary secrets never reach planner output or the audit trail", async (t) => {
    const target = t as SecretAttackTarget;
    target.plantCanaries();
    return submitAll(target, "ATK-SECRET-01", [target.validProposal(), { action: "deleteEverything", params: {} }, { action: "getPassword", params: {} }, {}]);
  }, (o) => [...secretFindings(o), ...(o.feedback.length === 4 ? [] : ["submission count mismatch"])]),

  make("ATK-SECRET-02", "scripted credential-fishing proposals are refused and never execute", async (t) => {
    const target = t as SecretAttackTarget;
    return submitAll(target, "ATK-SECRET-02", FISHING_ACTIONS.map((action) => ({ action, params: { name: "DATABASE_PASSWORD" } })));
  }, (o) => {
    const v = [...secretFindings(o)];
    if (o.executorCalls !== 0) v.push("executor ran");
    if (o.feedback.length !== FISHING_ACTIONS.length) v.push("submission count mismatch");
    for (const [index, feedback] of o.feedback.entries()) {
      if (!(feedbackOutcomeIn(feedback, ["FORBIDDEN_POLICY", "INVALID_ACTION"]) && feedback.category === "not_available")) v.push(`proposal ${index} was not refused as not available`);
    }
    return v;
  }),

  make("ATK-SECRET-03", "a host hook that fails with a canary in its message surfaces nowhere", async (t) => {
    const target = t as SecretAttackTarget;
    target.failPermissionsWith(`hook failed: ${SECRET_CANARIES[2]!} password=hunter2`);
    return submitAll(target, "ATK-SECRET-03", [target.validProposal()]);
  }, (o) => {
    const v = [...secretFindings(o, ["hunter2"])];
    if (o.executorCalls !== 0) v.push("executor ran");
    if (o.feedback.length !== 1 || !generic(o.feedback[0]) || o.feedback[0]!.category !== "try_later") v.push("feedback is not the generic try-later answer");
    const reasons: ReadonlySet<string> = new Set(REASON_CODES);
    for (const event of o.auditEvents) if (event.reason !== null && !reasons.has(event.reason)) v.push("an audit record holds a reason that is not a code");
    return v;
  }),

  make("ATK-SECRET-04", "no stack trace appears in any planner-visible output", async (t) => {
    const target = t as SecretAttackTarget;
    target.failPermissionsWith("boom");
    return submitAll(target, "ATK-SECRET-04", [target.validProposal(), { action: "x" }, "not json", { action: "viewProject", params: { n: 1e999 } }]);
  }, (o) => {
    const scanner = new LeakScanner();
    const v = [...secretFindings(o)];
    for (const finding of scanner.scan(JSON.stringify(o.feedback).replaceAll("\\n", "\n"))) if (finding.kind === "stack-trace") v.push("a stack trace is visible to the planner");
    return v;
  }),
];

function feedbackOutcomeIn(feedback: PlannerFeedback | undefined, outcomes: readonly string[]): feedback is PlannerFeedback {
  return feedback !== undefined && outcomes.includes(feedback.outcome);
}
