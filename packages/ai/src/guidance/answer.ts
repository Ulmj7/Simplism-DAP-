/**
 * The grounding rule for answers (T310), now used by the guidance service (T314).
 *
 * Retrieved chunks are data. The public result is built only from the trusted chunks that were ACTUALLY SUPPLIED to the model (the sources of the fitted
 * request): an `answer` must cite at least one of their ids, a model-invented id, or the id of a chunk that the budget routine dropped, makes it
 * `ungrounded`, and the returned sources are `{ id: docId, title }` taken from the chunks, never from model-provided titles. Citation membership is not
 * proof that the answer follows from the text. A `start_walkthrough` decision is handled by the service (selection guard), not here.
 */
import { unsupportedResult } from "./result.js";
import type { GuidanceDecision, GuidanceResult } from "./types.js";

/** What the answer path keeps of a retrieved chunk. */
export interface AnswerChunk { readonly id: string; readonly docId: string; readonly title: string; readonly text: string }

/** Turns a validated decision into a trusted result, given the chunks that were actually supplied to the model. Pure. */
export function groundDecision(decision: GuidanceDecision, supplied: readonly Pick<AnswerChunk, "id" | "docId" | "title">[]): GuidanceResult {
  switch (decision.kind) {
    case "answer": {
      const byId = new Map(supplied.map((chunk) => [chunk.id, chunk]));
      if (decision.sources.length === 0 || decision.sources.some((id) => !byId.has(id))) return unsupportedResult("ungrounded");
      const sources: { id: string; title: string }[] = [];
      for (const id of decision.sources) {
        const chunk = byId.get(id)!;
        if (!sources.some((source) => source.id === chunk.docId)) sources.push({ id: chunk.docId, title: chunk.title });
      }
      return Object.freeze({ kind: "answer", answer: decision.answer, sources: Object.freeze(sources.map((source) => Object.freeze(source))) });
    }
    case "clarify": return Object.freeze({ kind: "clarify", message: decision.message });
    default: return unsupportedResult("unsupported_request"); // `unsupported` (fixed message, never model text); a walkthrough proposal never gets here
  }
}
