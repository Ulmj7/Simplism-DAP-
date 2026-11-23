import { z } from "zod";
import { PIPELINE_STAGES } from "@dap/contracts";
import type { AuthorizationContext, JsonValue, PipelineStage, PlannerRunMeta, PolicyDecision, ProposalCall, RequestId } from "@dap/contracts";
import { isMintedContext } from "@dap/contracts/mint";
import { readAllowedCheckpoint, readExecutionCheckpoint } from "./stages/allow-facts.js";
import { snapshotAnswer } from "./answer-snapshot.js";
import { allowedDecision, confirmationDecision, denyDecision } from "./decision.js";
import { assertTimeout, nativeTimer, underDeadline, type HookTimer } from "./deadline.js";
import type { HookOptions } from "./hook-wrapper.js";

export interface PipelineInput {
  readonly context: unknown;
  /** Untrusted until the pipeline validates it; a record that cannot be read arrives as null. */
  readonly run: unknown;
  readonly decisionId: string;
  readonly requestId: RequestId;
  /** Only intake reads the proposal; context denial must not even inspect its getters. */
  readonly readProposal: () => ProposalCall;
}
/**
 * What is left of the proposal's overall deadline, read from the runner's own monotonic timer. A stage that makes
 * several host calls in sequence (authorize) gives each one at most this much, and never more than `hookTimeoutMs`.
 */
export interface ProposalBudget { readonly remainingMs: () => number }
export interface PipelineRecord extends Omit<PipelineInput, "context" | "run"> {
  /** Only audit receives this receipt callback, after the writer confirms the durable append. */
  readonly reportAllowed?: (checkpoint: unknown) => void;
  /** Only execute receives this checkpoint, before any post-execution recording. */
  readonly reportExecution?: (checkpoint: unknown) => void;
  readonly budget: ProposalBudget;
  readonly context: AuthorizationContext | null;
  readonly run: PlannerRunMeta;
  /** Each stage owns one append-only slot. Values are detached, deeply frozen JSON data. */
  readonly facts: Readonly<Partial<Record<PipelineStage, JsonValue>>>;
}
/** Only the execute stage reports one: whether the executor ran to success. An allowed attempt that cannot start is a failure. */
export type ExecutionStatus = "success" | "failure";
export type StageResult = Readonly<{ kind: "continue"; data: Readonly<Record<string, JsonValue>> }> | Readonly<{ kind: "stop"; decision: PolicyDecision; executionStatus?: ExecutionStatus }>;
/** What the runner hands the proposal door: the decision, and the execution status for an allowed execution attempt. */
export interface PipelineEvaluation { readonly decision: PolicyDecision; readonly executionStatus?: ExecutionStatus }
/** Runner-level audit and telemetry (see decision-auditor.ts). Absent in tests that only exercise stages. */
export interface DecisionAuditor {
  /** The proposal was received: called at most once per proposal, before its decision is recorded. Never throws. */
  proposed(request: PipelineRecord, attemptedAction: string | undefined): Promise<void>;
  /** The proposal's final decision. Never throws, and nothing it does can change the decision. */
  decided(request: PipelineRecord, decision: PolicyDecision): Promise<void>;
}
export type PolicyStage = (request: PipelineRecord) => StageResult | Promise<StageResult>;
export type StageMap = Partial<Record<PipelineStage, PolicyStage>>;
const runSchema = z.strictObject({ aiSessionId: z.string().min(1), turnId: z.string().min(1), model: z.string().min(1), depth: z.number().int().nonnegative(), turnStartedAt: z.iso.datetime({ offset: true }) });
const continuing = z.strictObject({ kind: z.literal("continue"), data: z.record(z.string(), z.json()) });
type FailureReason = "internal_error" | "dependency_failure";
/**
 * Each untrusted proposal field is read exactly once. The shell is frozen; `raw` stays the caller's
 * value for intake to copy once (never frozen in place), so intake is the only stage handed this reader:
 * every other stage works from intake's detached facts and can never see a second, different `raw`.
 */
function onceProposal(read: () => ProposalCall): () => ProposalCall {
  let captured: { readonly proposal: ProposalCall } | null | undefined;
  return Object.freeze((): ProposalCall => {
    if (captured === undefined) {
      try {
        const call = read();
        if (call === null || typeof call !== "object") throw new TypeError("Proposal is not an object");
        captured = { proposal: Object.freeze({ callId: call.callId, raw: call.raw }) };
      } catch { captured = null; }
    }
    if (captured === null) throw new TypeError("Proposal unavailable");
    return captured.proposal;
  });
}
const proposalWithheld = Object.freeze((): ProposalCall => { throw new TypeError("Only intake may read the proposal"); });
const failure = (request: Pick<PipelineInput, "decisionId" | "requestId">, stage: PipelineStage, reason: FailureReason) => denyDecision({ decisionId: request.decisionId, requestId: request.requestId, stage, reason });

function captureResult(raw: unknown, request: PipelineRecord, stage: PipelineStage): StageResult {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new TypeError("Invalid stage result");
  // Reject extra fields before copying: promise assimilation may already have read `then`.
  const keys = Reflect.ownKeys(raw);
  const reported = keys.includes("executionStatus");
  if (keys.length !== (reported ? 3 : 2) || !keys.includes("kind") || (!keys.includes("data") && !keys.includes("decision"))) throw new TypeError("Invalid stage result fields");
  const captured = snapshotAnswer(raw);
  if (!captured || typeof captured !== "object" || Array.isArray(captured)) throw new TypeError("Invalid stage result");
  const value = captured as Record<string, unknown>;
  if (value.kind === "continue") {
    if (!continuing.safeParse(value).success) throw new TypeError("Invalid stage continuation");
    return captured as StageResult;
  }
  if (value.kind !== "stop") throw new TypeError("Invalid stage stop");
  const status = value.executionStatus;
  if (reported && status !== "success" && status !== "failure") throw new TypeError("Invalid execution status");
  const decision = value.decision as PolicyDecision;
  if (!decision || decision.decisionId !== request.decisionId || decision.requestId !== request.requestId) throw new TypeError("Invalid decision binding");
  // Builders validate all fields again from the captured data, never from caller getters.
  const { outcome, ...fields } = decision;
  let checked: PolicyDecision;
  if (outcome === "ALLOWED") {
    if (stage !== "execute") throw new TypeError("Premature allow");
    checked = allowedDecision(fields as Parameters<typeof allowedDecision>[0]);
  } else if (outcome === "REQUIRES_CONFIRMATION") {
    if (stage !== "risk" && stage !== "confirmation") throw new TypeError("Premature confirmation");
    checked = confirmationDecision(fields as Parameters<typeof confirmationDecision>[0]);
  } else {
    checked = denyDecision({ ...fields, outcome } as Parameters<typeof denyDecision>[0]);
    if (checked.stage !== stage || checked.reason === "allowed") throw new TypeError("Invalid denial");
  }
  // An execution status can only accompany an ALLOWED decision, and only execute may return one (see "Premature allow"): no other stage may claim an executor ran.
  if (reported && checked.outcome !== "ALLOWED") throw new TypeError("Premature execution status");
  return Object.freeze(reported ? { kind: "stop", decision: checked, executionStatus: status as ExecutionStatus } : { kind: "stop", decision: checked });
}

function runStage(fn: PolicyStage, request: PipelineRecord, stage: PipelineStage, timeout: number, timer: HookTimer): Promise<StageResult> {
  const denied = (reason: FailureReason): StageResult => Object.freeze({ kind: "stop", decision: failure(request, stage, reason) });
  // A stage that throws or rejects is an internal error; a stage that is late, malformed or cannot be timed is a dependency failure.
  return underDeadline<StageResult>(() => fn(request), (raw) => captureResult(raw, request, stage), (cause) => denied(cause === "thrown" || cause === "rejected" ? "internal_error" : "dependency_failure"), timeout, timer);
}

export interface PipelineOptions extends HookOptions {
  /** Overall deadline for one proposal across every stage. Default 10 000 ms. */
  readonly proposalBudgetMs?: number;
  /** Records the proposal and its decision, and counts decisions. Optional: without it nothing is recorded. */
  readonly audit?: DecisionAuditor;
}
/**
 * A stage's deadline, given what is left of the proposal budget. Most stages get `min(hookTimeoutMs, left)`. Stages that make
 * several host calls in sequence (authorize) or one that may legitimately take longer (audit) get all of what is left, each call
 * being capped by `hookTimeoutMs` inside the stage. Execute gets what is left PLUS one hook timeout: the executor may use the whole
 * budget, and recording its result still has its own time.
 */
function stageDeadline(stage: PipelineStage, left: number, hookTimeoutMs: number): number {
  if (stage === "rate_limit" || stage === "authorize" || stage === "audit") return left;
  if (stage === "execute") return left + hookTimeoutMs;
  return Math.min(hookTimeoutMs, left);
}

/** D6 positions are fixed; adding an implementation never changes another stage's code. */
export function createPipeline(stages: StageMap, { hookTimeoutMs = 2000, timer = nativeTimer, proposalBudgetMs = 10_000, audit }: PipelineOptions = {}) {
  assertTimeout(hookTimeoutMs, "pipeline");
  assertTimeout(proposalBudgetMs, "proposal budget");
  const ordered = PIPELINE_STAGES.map((name) => Object.freeze({ name, fn: stages[name] }));
  async function evaluate(source: PipelineInput): Promise<PipelineEvaluation> {
    let identifiers = { decisionId: "unavailable", requestId: "unavailable" as RequestId };
    let current: PipelineStage = "context";
    let request: PipelineRecord | undefined;
    let proposed = false;
    let executed: ExecutionStatus | undefined;
    let committed: ReturnType<typeof readAllowedCheckpoint>;
    /** The proposal is recorded exactly once, before whatever decision follows it. */
    const ensureProposed = async (record: PipelineRecord | undefined, attempted: string | undefined): Promise<void> => {
      if (proposed || audit === undefined || record === undefined) return;
      proposed = true;
      try { await audit.proposed(record, attempted); } catch { /* recording the proposal never changes what happens to it */ }
    };
    /** Records the decision (nothing it does can change it) and returns it. */
    const finish = async (decision: PolicyDecision, executionStatus?: ExecutionStatus, attempted?: string): Promise<PipelineEvaluation> => {
      // Once the consistent ALLOW receipt exists, later faults describe execution, never a second policy decision.
      const allowed = committed;
      if (allowed !== undefined && request !== undefined && isMintedContext(request.context)) {
        decision = allowedDecision({ ...identifiers, actionId: allowed.actionId as never, risk: allowed.risk, paramsDigest: allowed.paramsDigest as never });
        executionStatus = executed ?? "failure";
      }
      try {
        if (audit !== undefined && request !== undefined) {
          await ensureProposed(request, attempted);
          await audit.decided(request, decision);
        }
      } catch { /* the auditor never throws; and if it did, the decision stands */ }
      return Object.freeze(executionStatus === undefined ? { decision } : { decision, executionStatus });
    };
    try {
      const { context, run, decisionId, requestId, readProposal } = source;
      if (typeof decisionId !== "string" || !decisionId || typeof requestId !== "string" || !requestId) return await finish(failure(identifiers, current, "dependency_failure"));
      identifiers = { decisionId, requestId };
      // The runner owns the overall deadline: a stage cannot extend it, and a timer that cannot tell the time leaves none (NaN fails `current >= started`; two infinite readings give NaN, which fails `left > 0`).
      const started = timer.now();
      const remaining = (): number => { const now = timer.now(); return now >= started ? proposalBudgetMs - (now - started) : 0; };
      const budget: ProposalBudget = Object.freeze({ remainingMs: remaining });
      const capturedRun = snapshotAnswer(run);
      if (!runSchema.safeParse(capturedRun).success || typeof readProposal !== "function") return await finish(failure(identifiers, current, "dependency_failure"));
      request = Object.freeze({ ...identifiers, context: isMintedContext(context) ? context : null, run: capturedRun as PlannerRunMeta, readProposal: proposalWithheld, facts: Object.freeze({}), budget });
      const proposal = onceProposal(readProposal);
      for (const { name, fn } of ordered) {
        current = name;
        // Absent guards must stop before any later hook or executor can run.
        if (typeof fn !== "function") return await finish(failure(request, name, "dependency_failure"));
        const left = remaining();
        if (!(left > 0)) return await finish(failure(request, name, "dependency_failure"));
        if (name === "execute" && committed === undefined) return await finish(failure(request, name, "dependency_failure"));
        const scope = request;
        const view: PipelineRecord = name === "intake" ? Object.freeze({ ...request, readProposal: proposal })
          : name === "audit" ? Object.freeze({ ...request, reportAllowed: (token: unknown) => { committed ??= readAllowedCheckpoint(scope, token); } })
          : name === "execute" ? Object.freeze({ ...request, reportExecution: (token: unknown) => { executed ??= readExecutionCheckpoint(scope, token); } }) : request;
        const result = await runStage(fn, view, name, stageDeadline(name, left, hookTimeoutMs), timer);
        if (result.kind === "stop") return await finish(result.decision, result.executionStatus, name === "intake" ? (result.decision as { attemptedAction?: string }).attemptedAction : undefined);
        // Whatever the context stage is, nothing after it may run without a minted context.
        if (name === "context" && request.context === null) return await finish(failure(request, name, "dependency_failure"));
        request = Object.freeze({ ...request, facts: Object.freeze({ ...request.facts, [name]: result.data }) });
        if (name === "intake") await ensureProposed(request, typeof result.data.action === "string" ? result.data.action : undefined);
      }
      return await finish(failure(request, "execute", "dependency_failure"));
    } catch { return await finish(failure(identifiers, current, "internal_error")); }
  }
  return Object.freeze({
    evaluate: Object.freeze(evaluate),
    /** The decision alone: what the stage-level tests and any caller that does not need the execution status use. */
    async run(source: PipelineInput): Promise<PolicyDecision> { return (await evaluate(source)).decision; },
  });
}
