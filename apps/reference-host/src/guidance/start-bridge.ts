/**
 * The host bridge that turns an ACCEPTED guidance proposal into a Gateway submission (T315; T317 later composes it with the model adapter).
 *
 * `askGuidance` returns a `walkthrough` result that is only a validated proposal: nothing has started. This one function submits it through the AI-facing
 * `AiSession.submit`, exactly as a model's own tool call would be submitted (an `{ action, params }` envelope, raw text, a fresh provider call id), so the
 * proposal gets the full Gateway pipeline: strict schema, permission, risk, rate/replay and the durable audit, and only then the trusted executor. Nothing
 * here can bypass the Gateway, and there is no other way to reach the executor from this package.
 *
 * The Gateway's feedback is mapped to a CLOSED result; no raw feedback, issue list or error text is ever returned:
 *   ALLOWED with category `ok`                       -> `walkthrough` (accepted; the executor ran)
 *   UNAUTHORIZED, FORBIDDEN_POLICY, or DENIED        -> `unsupported(not_permitted)` (DENIED with category `try_later` is a throttle or an outage: `unavailable`)
 *   anything else (including ALLOWED with `try_later`, which means execution failed or was not confirmed; a side effect may already have occurred) -> `unsupported(unavailable)`
 */
import { randomUUID } from "node:crypto";
import { WALKTHROUGH_ID, unsupportedResult } from "@dap/ai";
import type { GuidanceResult } from "@dap/ai";
import type { AiSession } from "../compose.js";
import { START_WALKTHROUGH_ACTION_ID } from "./capability.js";

export async function submitWalkthroughStart(session: AiSession, walkthroughId: string): Promise<GuidanceResult> {
  if (typeof walkthroughId !== "string" || !WALKTHROUGH_ID.test(walkthroughId)) return unsupportedResult("unknown_walkthrough");
  let feedback: unknown;
  try {
    feedback = await session.submit({ providerCallId: `guidance-start-${randomUUID()}`, arguments: JSON.stringify({ action: START_WALKTHROUGH_ACTION_ID, params: { walkthroughId } }) });
  } catch { return unsupportedResult("unavailable"); }
  if (feedback === null || typeof feedback !== "object" || Array.isArray(feedback)) return unsupportedResult("unavailable");
  let outcome: unknown; let category: unknown;
  try { outcome = (feedback as { outcome?: unknown } | null)?.outcome; category = (feedback as { category?: unknown } | null)?.category; } catch { return unsupportedResult("unavailable"); }
  if (outcome === "ALLOWED" && category === "ok") return Object.freeze({ kind: "walkthrough", walkthroughId });
  if (outcome === "UNAUTHORIZED" || outcome === "FORBIDDEN_POLICY" || (outcome === "DENIED" && category !== "try_later")) return unsupportedResult("not_permitted");
  return unsupportedResult("unavailable");
}
