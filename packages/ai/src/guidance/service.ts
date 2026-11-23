/**
 * The guidance service (T314): the ONE orchestration of a guidance request. The model proposes; this code validates and decides.
 *
 *   query -> sanitise (host function) -> bound -> semantic context (strict) -> catalog summaries (validated, capped) -> retrieve -> build and FIT the request
 *   -> (no summaries and no sources: no model call) -> ONE guarded model call under the deadline -> strict decision -> a trusted result.
 *
 * Results are closed: `answer | walkthrough | clarify | unsupported(reason)`. A `walkthrough` result is only a validated PROPOSAL: this package cannot start
 * anything (it has no Gateway, executor or runtime; the host turns an accepted proposal into a Gateway submission). Every failure is a closed reason with a fixed
 * message; no provider, parser, schema or thrown text, and no model text other than a validated `clarify` message, ever reaches a result. `askGuidance` never
 * throws and never makes more than one model call (a fresh call guard per request; no retries).
 *
 * Grounding and selection run against what was ACTUALLY SUPPLIED to the model: the sources and summaries of the fitted request, not the larger sets that
 * were retrieved or listed before the budget routine dropped some.
 */
import { MAX_ANSWER_CHARS, MAX_MESSAGE_CHARS, MAX_QUERY_CHARS, MAX_SOURCES } from "./limits.js";
import { groundDecision } from "./answer.js";
import { callGuidanceModel, createModelCallGuard } from "./call-model.js";
import { parseSemanticContextInput } from "./context-input.js";
import { fitRequestToBudget } from "./prompt.js";
import { parseGuidanceModelRequest } from "./request.js";
import { unsupportedResult } from "./result.js";
import { capSummaries, judgeProposal, parseCatalogSummaries } from "./selection.js";
import { isBoundedText } from "./text.js";
import type { Retriever } from "./knowledge/retriever.js";
import type { GuidanceModel, GuidanceResult, GuidanceTimers, SafeWalkthroughSummary, SanitizeQuery, SemanticContextInput, WalkthroughCatalogView } from "./types.js";
import type { AnswerChunk } from "./answer.js";

export interface GuidanceServiceDeps {
  readonly model: GuidanceModel;
  readonly catalog: WalkthroughCatalogView;
  readonly retriever: Retriever;
  readonly timers: GuidanceTimers;
  /** Host-supplied (the reference host passes Feature 001's `scrubText`). Returns the usable query text, or `null`; a throw means `null`. */
  readonly sanitizeQuery: SanitizeQuery;
}
export interface GuidanceService {
  /** `input` is untrusted (the query and the semantic context come from the browser). Never throws. */
  askGuidance(input: { readonly query: unknown; readonly semanticContext: unknown }): Promise<GuidanceResult>;
}

/** Fixed, trusted clarification texts. The model's words are never used for these. */
const UNRELATED_MESSAGE = "I could not match that to one of the available guides. Could you tell me what you would like to do?";
const AMBIGUOUS_MESSAGE = "More than one guide could fit. Could you say a bit more about what you want to do?";
const AMBIGUOUS_PREFIX = "More than one guide could fit. Which do you mean: ";

const clarify = (message: string): GuidanceResult => Object.freeze({ kind: "clarify", message });

/** Names the best candidates by their TRUSTED catalog titles, as many as fit in one message. */
function ambiguousMessage(candidates: readonly string[], summaries: readonly SafeWalkthroughSummary[]): string {
  const titleOf = new Map(summaries.map((summary) => [summary.id, summary.title]));
  const titles: string[] = [];
  for (const id of candidates) {
    const title = titleOf.get(id);
    if (title === undefined) continue;
    const next = `${AMBIGUOUS_PREFIX}${[...titles, title].join("; ")}?`;
    if (next.length > MAX_MESSAGE_CHARS) break;
    titles.push(title);
  }
  return titles.length < 2 ? AMBIGUOUS_MESSAGE : `${AMBIGUOUS_PREFIX}${titles.join("; ")}?`;
}

/** The retriever is a trusted in-process component, but a failure or a malformed answer from it only means "no evidence". */
function retrieve(retriever: Retriever, query: string): AnswerChunk[] {
  try {
    const found: unknown = retriever.search(query);
    if (!Array.isArray(found)) return [];
    return found.slice(0, MAX_SOURCES).map((chunk: AnswerChunk) => ({ id: chunk.id, docId: chunk.docId, title: chunk.title, text: chunk.text }));
  } catch { return []; }
}

const buildRequest = (query: string, semanticContext: SemanticContextInput, summaries: readonly SafeWalkthroughSummary[], chunks: readonly AnswerChunk[]) =>
  parseGuidanceModelRequest({
    input: { query, semanticContext, walkthroughSummaries: summaries, sources: chunks.map((chunk) => ({ id: chunk.id, title: chunk.title, text: chunk.text })) },
    maxOutputChars: MAX_ANSWER_CHARS,
  });

export function createGuidanceService(deps: GuidanceServiceDeps): GuidanceService {
  const { model, catalog, retriever, timers, sanitizeQuery } = deps ?? ({} as GuidanceServiceDeps);
  for (const [name, port, method] of [["model", model, "generate"], ["catalog", catalog, "list"], ["retriever", retriever, "search"], ["timers", timers, "set"]] as const) {
    if (typeof (port as unknown as Record<string, unknown> | undefined)?.[method] !== "function") throw new TypeError(`Guidance service: ${name}.${method} is missing`);
  }
  if (typeof sanitizeQuery !== "function") throw new TypeError("Guidance service: sanitizeQuery is missing");

  async function ask(input: unknown): Promise<GuidanceResult> {
    let rawQuery: unknown; let rawContext: unknown;
    try {
      const bag = input as { query?: unknown; semanticContext?: unknown };
      rawQuery = bag.query; rawContext = bag.semanticContext;
    } catch { return unsupportedResult("query_invalid"); }

    // 1. The query: a bounded string BEFORE the host sanitiser sees it, usable text after.
    if (typeof rawQuery !== "string" || rawQuery.length > MAX_QUERY_CHARS) return unsupportedResult("query_invalid");
    let cleaned: unknown;
    try { cleaned = sanitizeQuery(rawQuery); } catch { cleaned = null; }
    if (typeof cleaned !== "string" || !isBoundedText(cleaned, MAX_QUERY_CHARS)) return unsupportedResult("query_invalid");
    const query = cleaned;

    // 2. The semantic context from the browser: strict, or refused.
    const semanticContext = parseSemanticContextInput(rawContext);
    if (semanticContext === null) return unsupportedResult("context_invalid");

    // 3. The catalog (a host port, validated) and the summaries the model will be shown.
    let listed: unknown;
    try { listed = catalog.list(); } catch { return unsupportedResult("unavailable"); }
    const all = parseCatalogSummaries(listed);
    if (all === null) return unsupportedResult("unavailable");
    const summaries = capSummaries(all, query);

    // 4. Retrieval, then ONE structured request that already fits the prompt budget (the shared routine drops sources first, then context).
    const chunks = retrieve(retriever, query);
    let built = buildRequest(query, semanticContext, summaries, chunks);
    if (!built.ok && chunks.length > 0) built = buildRequest(query, semanticContext, summaries, []); // a malformed chunk is no evidence, not a reason to refuse the question
    if (!built.ok) return unsupportedResult(built.reason);
    const fitted = fitRequestToBudget(built.request);
    if (!fitted.ok) return unsupportedResult(fitted.reason);
    const request = fitted.request;
    const supplied = request.input.sources;
    const shown = request.input.walkthroughSummaries;

    // 5. Nothing to choose and nothing to cite: there is nothing the model could legitimately say, so it is not called.
    if (shown.length === 0 && supplied.length === 0) return unsupportedResult("ungrounded");

    // 6. ONE guarded call (a fresh guard per request, the 8000 ms deadline, no retry), then the strict decision.
    const outcome = await callGuidanceModel({ model, request, timers, guard: createModelCallGuard() });
    if (!outcome.ok) return unsupportedResult(outcome.reason);
    const decision = outcome.decision;

    // 7. A proposal goes through the id check and the lexical guard against the summaries that were shown; everything else is grounded or fixed.
    if (decision.kind === "start_walkthrough") {
      const verdict = judgeProposal(shown, query, decision.walkthroughId);
      switch (verdict.verdict) {
        case "accepted": return Object.freeze({ kind: "walkthrough", walkthroughId: decision.walkthroughId });
        case "unknown": return unsupportedResult("unknown_walkthrough");
        case "unrelated": return clarify(UNRELATED_MESSAGE);
        default: return clarify(ambiguousMessage(verdict.candidates, shown));
      }
    }
    const byDoc = new Map(chunks.map((chunk) => [chunk.id, chunk.docId]));
    return groundDecision(decision, supplied.map((source) => ({ id: source.id, title: source.title, docId: byDoc.get(source.id) ?? source.id })));
  }

  return Object.freeze({
    async askGuidance(input: { readonly query: unknown; readonly semanticContext: unknown }): Promise<GuidanceResult> {
      try { return await ask(input); } catch { return unsupportedResult("unavailable"); }
    },
  });
}
