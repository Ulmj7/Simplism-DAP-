import { GUIDANCE_REASONS } from "./types.js";
import type { GuidanceReason, GuidanceResult } from "./types.js";

/** One fixed, generic message per reason. Never model text, never error text. */
const MESSAGES: Readonly<Record<GuidanceReason, string>> = Object.freeze({
  query_invalid: "Please ask a shorter question in plain text.",
  context_invalid: "Guidance is not available for this page right now.",
  model_unavailable: "Guidance is temporarily unavailable. Please try again.",
  invalid_model_output: "I could not produce a safe answer for that.",
  unknown_walkthrough: "I could not find a guide for that.",
  ungrounded: "I do not have enough approved information to answer that.",
  not_permitted: "That guide is not available to you.",
  unavailable: "Guidance is temporarily unavailable. Please try again.",
  unsupported_request: "I can only help with finding guides and answering questions about the product.",
});

export function unsupportedResult(reason: GuidanceReason): Extract<GuidanceResult, { kind: "unsupported" }> {
  const safe: GuidanceReason = (GUIDANCE_REASONS as readonly string[]).includes(reason) ? reason : "unsupported_request";
  return Object.freeze({ kind: "unsupported", message: MESSAGES[safe], reason: safe });
}
