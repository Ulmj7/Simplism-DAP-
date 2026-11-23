import type { AuthorizationContext, IdGenerator, PlannerFeedback, PlannerRunMeta, PolicyGateway, ProposalCall, RequestId } from "@dap/contracts";
import { snapshotAnswer } from "./answer-snapshot.js";
import { toPlannerFeedback } from "./feedback.js";
import type { PipelineEvaluation, PipelineInput } from "./pipeline.js";

/** The only thing the proposal door needs from the pipeline; injectable so its invariants are testable. */
export interface DecisionPipeline { evaluate(input: PipelineInput): Promise<PipelineEvaluation> }

const unavailable: PlannerFeedback = Object.freeze({ outcome: "DENIED", category: "try_later" });

/**
 * The planner-facing door. Everything a submit can return is `PlannerFeedback`: the decision, its ids and
 * its internal reasons stay inside. Any failure here, before or after the pipeline, is a generic retry.
 */
export function createProposalGateway({ pipeline, ids }: { readonly pipeline: DecisionPipeline; readonly ids: Pick<IdGenerator, "newDecisionId"> }): PolicyGateway {
  return Object.freeze({
    forSession: Object.freeze((context: AuthorizationContext, run: PlannerRunMeta) => {
      // Metadata is read once and detached; an unreadable record is passed as null and denied by the pipeline.
      let capturedRun: unknown;
      try { capturedRun = snapshotAnswer(run); } catch { capturedRun = null; }
      return Object.freeze({
        submit: Object.freeze(async (call: ProposalCall): Promise<PlannerFeedback> => {
          try {
            const id: unknown = ids.newDecisionId();
            if (typeof id !== "string" || !id) {
              // A broken synchronous port may hand back a rejecting promise; consume its rejection.
              void Promise.resolve(id).catch(() => undefined);
              return unavailable;
            }
            // ONE identifier per proposal, drawn from ids.newDecisionId(), serves as both the `decisionId` and the `requestId`
            // (a deliberate choice, confirmed in review): the decision, its audit events and the single-use ExecutionGrant all
            // key on this same value. The grant binding names it `requestId`, the PolicyDecision names it `decisionId`, and audit
            // events carry it as `requestId`; they are always equal. `callId` is the OTHER identifier: the trusted runner's
            // replay-protection key, which travels only in facts.intake and is never used as a request or decision id.
            // The proposal itself is only read if a stage asks.
            const { decision, executionStatus } = await pipeline.evaluate({ context, run: capturedRun, decisionId: id, requestId: id as RequestId, readProposal: () => call });
            // Only the execute stage reports a status: an authorized action that then failed is ALLOWED but the planner is told to try later.
            return toPlannerFeedback(decision, executionStatus);
          } catch { return unavailable; }
        }),
      });
    }),
  });
}
