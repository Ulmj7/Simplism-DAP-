/**
 * @dap/ai: planner-port.ts
 *
 * T069 / Constitution I, II, III. The planner is an UNTRUSTED proposer.
 *
 * `PlannerPort` is the seam the trusted host implements to drive the model
 * (or a scripted hostile planner in tests). The AI layer binds this port to a
 * `ProposalSubmitter` and converts each raw tool call with `toProposalCall`;
 * the model never sees the registry, executors, AuthorizationContext, state
 * stores, or confirmation service.
 *
 * Types only. This module imports from @dap/contracts and nothing else.
 */
import type { PlannerFeedback } from "@dap/contracts";

/**
 * One model tool call exactly as the host/provider returns it.
 */
export interface RawToolCall {
  /**
   * Provider-side id for this call. The trusted runner combines it with the
   * run to produce the final `ProposalCall.callId` (research D11); the model
   * never sets the final callId.
   */
  readonly providerCallId: string;
  /**
   * The model's raw tool-argument text. Passed to Gateway intake untouched
   * (FR-014): only raw text lets intake reject duplicate keys.
   */
  readonly arguments: string;
}

/**
 * The port the trusted host implements to produce planner output.
 *
 * `plan` is called once per planner turn with the feedback from the
 * proposals already submitted in that turn (empty on the first turn). It
 * returns `null` when the model chose not to propose an action.
 */
export interface PlannerPort {
  plan(
    feedback: readonly PlannerFeedback[],
  ): Promise<RawToolCall | null>;
}
