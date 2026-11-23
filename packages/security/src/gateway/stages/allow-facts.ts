/**
 * What the audit stage (8) and the execute stage (9) need to know, read from the facts the earlier stages published and proven
 * CONSISTENT with each other. Every slot has a strict shape (an unknown key is contract drift and fails closed), and the slots must
 * agree: the action that intake read is the one resolve found; the risk resolve found is the one the risk stage reports; the
 * resource validate extracted is the one authorize resolved; a confirmation is either absent from both the risk and confirmation
 * facts or present, accepted, in both.
 *
 * Facts contract (stage -> slot):
 *   intake       { callId, action, params }
 *   resolve      { id, version, risk, definitionHash }
 *   validate     { params, paramsDigest, resource: {type, id} | null }
 *   authorize    { resource: {type, id, displayName} | null }
 *   risk         { risk, confirmation: "not_required" | "accepted" }
 *   confirmation { state: "not_required" | "accepted", confirmationId: uuid | null }
 *   audit        { eventId, actionId, version, risk, paramsDigest, confirmationId }   (read by execute only)
 */
import { z } from "zod";
import { RISK_LEVELS } from "@dap/contracts";
import type { JsonValue, PipelineStage, RiskLevel } from "@dap/contracts";
import { snapshotAnswer } from "../answer-snapshot.js";
type StageFacts = Readonly<Partial<Record<PipelineStage, JsonValue>>>;

const text = z.string().min(1);
const digest = z.string().regex(/^[a-f0-9]{64}$/);
// FORBIDDEN is never allowed: no executor is bound to it and resolve stops it.
const allowedRisk = z.enum(["SAFE", "LOW", "MEDIUM", "HIGH", "CRITICAL"]);
const SLOTS = {
  intake: z.strictObject({ callId: text, action: text, params: z.record(z.string(), z.json()) }),
  resolve: z.strictObject({ id: text, version: z.number().int().min(1), risk: z.enum(RISK_LEVELS), definitionHash: digest }),
  validate: z.strictObject({ params: z.record(z.string(), z.json()), paramsDigest: digest, resource: z.strictObject({ type: text, id: text }).nullable() }),
  authorize: z.strictObject({ resource: z.strictObject({ type: text, id: text, displayName: text }).nullable() }),
  risk: z.strictObject({ risk: allowedRisk, confirmation: z.enum(["not_required", "accepted"]) }),
  confirmation: z.strictObject({ state: z.enum(["not_required", "accepted"]), confirmationId: z.uuid().nullable() }),
  audit: z.strictObject({ eventId: z.uuid(), actionId: text, version: z.number().int().min(1), risk: allowedRisk, paramsDigest: digest, confirmationId: z.uuid().nullable() }),
} as const;

export interface AllowFacts {
  readonly actionId: string;
  readonly version: number;
  readonly risk: Exclude<RiskLevel, "FORBIDDEN">;
  readonly definitionHash: string;
  readonly params: { readonly [key: string]: JsonValue };
  readonly paramsDigest: string;
  readonly resource: { readonly type: string; readonly id: string; readonly displayName: string } | null;
  readonly confirmationId: string | null;
}
export interface AuditedFacts extends AllowFacts { readonly eventId: string }

/**
 * The facts stage 7 decides from: what intake, resolve, validate and authorize published, proven consistent with each other (the action intake
 * read is the one resolve found; the resource validate extracted is the one authorize resolved). The risk class here is what RESOLVE found.
 */
export function readPreRiskFacts(facts: StageFacts): { readonly actionId: string; readonly version: number; readonly risk: RiskLevel } | undefined {
  const intake = SLOTS.intake.safeParse(facts.intake);
  const resolve = SLOTS.resolve.safeParse(facts.resolve);
  const validate = SLOTS.validate.safeParse(facts.validate);
  const authorize = SLOTS.authorize.safeParse(facts.authorize);
  if (!intake.success || !resolve.success || !validate.success || !authorize.success) return undefined;
  const [i, r, v, a] = [intake.data, resolve.data, validate.data, authorize.data];
  if (i.action !== r.id) return undefined;
  if (v.resource === null ? a.resource !== null : a.resource === null || a.resource.type !== v.resource.type || a.resource.id !== v.resource.id) return undefined;
  return Object.freeze({ actionId: r.id, version: r.version, risk: r.risk });
}

/** What the confirmation position reads back from the risk stage: a risk fact that says no confirmation was needed, for the class resolve found. */
export function readNoConfirmationNeeded(facts: StageFacts): boolean {
  const pre = readPreRiskFacts(facts);
  const risk = z.strictObject({ risk: allowedRisk, confirmation: z.literal("not_required") }).safeParse(facts.risk);
  return pre !== undefined && risk.success && risk.data.risk === pre.risk;
}

/** The consistent facts an ALLOWED path rests on, or undefined if any slot is missing, malformed, or disagrees with another. */
export function readAllowFacts(facts: StageFacts): AllowFacts | undefined {
  const intake = SLOTS.intake.safeParse(facts.intake);
  const resolve = SLOTS.resolve.safeParse(facts.resolve);
  const validate = SLOTS.validate.safeParse(facts.validate);
  const authorize = SLOTS.authorize.safeParse(facts.authorize);
  const risk = SLOTS.risk.safeParse(facts.risk);
  const confirmation = SLOTS.confirmation.safeParse(facts.confirmation);
  if (!intake.success || !resolve.success || !validate.success || !authorize.success || !risk.success || !confirmation.success) return undefined;
  const [i, r, v, a, k, c] = [intake.data, resolve.data, validate.data, authorize.data, risk.data, confirmation.data];
  if (i.action !== r.id || r.risk !== k.risk) return undefined;
  if (k.confirmation !== c.state || (c.state === "accepted") !== (c.confirmationId !== null)) return undefined;
  if (v.resource === null ? a.resource !== null : a.resource === null || a.resource.type !== v.resource.type || a.resource.id !== v.resource.id) return undefined;
  return Object.freeze({ actionId: r.id, version: r.version, risk: k.risk, definitionHash: r.definitionHash, params: snapshotAnswer(v.params) as AllowFacts["params"], paramsDigest: v.paramsDigest, resource: a.resource, confirmationId: c.confirmationId });
}

/** The same facts, plus the allow-event the audit stage wrote, proven to describe exactly this action, version, risk, digest and confirmation. */
export function readAuditedFacts(facts: StageFacts): AuditedFacts | undefined {
  const base = readAllowFacts(facts);
  const audit = SLOTS.audit.safeParse(facts.audit);
  if (base === undefined || !audit.success) return undefined;
  const a = audit.data;
  if (a.actionId !== base.actionId || a.version !== base.version || a.risk !== base.risk || a.paramsDigest !== base.paramsDigest || a.confirmationId !== base.confirmationId) return undefined;
  return Object.freeze({ ...base, eventId: a.eventId });
}

/** Internal, opaque checkpoints: JSON facts and structural copies cannot attest a commit or execution. */
interface CheckpointScope { readonly requestId: string; readonly decisionId: string; readonly context: unknown; readonly budget: object }
interface Checkpoint<T> extends CheckpointScope { readonly data: T }
const allowedCheckpoints = new WeakMap<object, Checkpoint<AuditedFacts>>();
const executionCheckpoints = new WeakMap<object, Checkpoint<"success" | "failure">>();
function readCheckpoint<T>(entries: WeakMap<object, Checkpoint<T>>, scope: CheckpointScope, token: unknown): T | undefined {
  const entry = token !== null && typeof token === "object" ? entries.get(token) : undefined;
  return entry !== undefined && entry.requestId === scope.requestId && entry.decisionId === scope.decisionId && entry.context === scope.context && entry.budget === scope.budget ? entry.data : undefined;
}
/** Called only by the real audit stage, after its writer confirmed the durable append. Not a public package export. */
export function createAllowedCheckpoint(scope: CheckpointScope, facts: StageFacts, data: Readonly<Record<string, JsonValue>>): object {
  const audited = readAuditedFacts({ ...facts, audit: data });
  if (audited === undefined) throw new TypeError("Invalid committed allow facts");
  const token = Object.freeze({});
  allowedCheckpoints.set(token, { requestId: scope.requestId, decisionId: scope.decisionId, context: scope.context, budget: scope.budget, data: snapshotAnswer(audited) as AuditedFacts });
  return token;
}
export const readAllowedCheckpoint = (scope: CheckpointScope, token: unknown): AuditedFacts | undefined => readCheckpoint(allowedCheckpoints, scope, token);
/** Called only after the real execute stage obtained an execution outcome. */
export function createExecutionCheckpoint(scope: CheckpointScope, status: "success" | "failure"): object {
  const token = Object.freeze({}); executionCheckpoints.set(token, { requestId: scope.requestId, decisionId: scope.decisionId, context: scope.context, budget: scope.budget, data: status }); return token;
}
export const readExecutionCheckpoint = (scope: CheckpointScope, token: unknown): "success" | "failure" | undefined => readCheckpoint(executionCheckpoints, scope, token);
