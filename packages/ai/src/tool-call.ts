/**
 * @dap/ai: tool-call.ts
 *
 * T069. One model tool call -> `ProposalCall`.
 *
 * The provider's raw argument text is passed through UNTOUCHED: no JSON.parse,
 * no trim, no normalization. Only raw text lets the Gateway intake reject
 * duplicate keys and enforce the byte/depth caps (contracts `ProposalCall`,
 * FR-014). An already-parsed value would have lost its duplicate keys.
 *
 * Imports from @dap/contracts only.
 */
import type { ProposalCall } from "@dap/contracts";

/**
 * Wrap one raw model tool call as a `ProposalCall`.
 *
 * @param callId Trusted, runner-assigned call id (replay-protection key, D11).
 *   The model can never set it.
 * @param rawArgumentsText The provider's raw tool-argument text, passed to
 *   `raw` byte-for-byte. May be empty, unparseable, or over the caps — the
 *   Gateway intake is the only place that judges it.
 */
export function toProposalCall(
  callId: string,
  rawArgumentsText: string,
): ProposalCall {
  // Frozen so nothing between the AI layer and the Gateway can rewrite what was proposed.
  return Object.freeze({
    callId,
    raw: rawArgumentsText,
  });
}
