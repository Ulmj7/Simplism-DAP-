/**
 * Walkthrough selection (T312 + T313): what the model may propose, and a deterministic sanity check on what it did propose.
 *
 * Part 1, validation (T312). A proposed id is valid only if it equals, with `===`, the id of a summary that was ACTUALLY SUPPLIED to the model. The lookup
 * is a `Map` over the supplied summaries, never a property lookup on an object, so `__proto__`, `constructor`, a different case, surrounding white space or a
 * Unicode look-alike matches nothing. Nothing in this file creates, renames or alters a walkthrough: it only reads summaries and returns one of them or `null`.
 * With more summaries than `MAX_SUMMARIES` the model is shown the best lexical matches for the query (ties by id).
 *
 * Part 2, the lexical guard (T313). It is a SANITY CHECK, not an intent classifier, and it is meant to be explained in one paragraph: the question and each
 * summary (title and description; the title counts double) are normalised with the SAME tokenizer as the knowledge retriever (NFKC, lower case, stop words,
 * plural `s` fold), a few words that name the activity rather than the topic ("start", "walkthrough", "guide", "help", ...) are dropped, and the summaries are
 * scored with the SAME BM25 (k1 1.2, b 0.75) as the retriever, the summaries being the documents. A proposed id is accepted only if
 *   (1) it is one of the supplied summaries, else `unknown`;
 *   (2) its score is at least MIN_SELECTION_SCORE, else `unrelated` (the model picked something the question does not mention);
 *   (3) it is among the best SELECTION_TOP_N and its score is at least SELECTION_MARGIN times the best OTHER summary's score, else `ambiguous` (a tie is ambiguous).
 * The margin rule already implies the top-N rule (a summary 20% ahead of every other one is first); both are kept as separate one-liners so each can be read and tested.
 * No embeddings, no synonym list, no model call. Pure: the same input gives the same output, whatever the order of the summaries.
 */
import { z } from "zod";
import { MAX_SUMMARIES } from "./limits.js";
import { bm25Doc, createBm25, round6, tokenize } from "./knowledge/retriever.js";
import { summarySchema } from "./request.js";
import { snapshotPlainData } from "./snapshot.js";
import type { SafeWalkthroughSummary } from "./types.js";

/** Feature 002 allows at most 100 walkthroughs; the catalog view may not return more. */
export const MAX_CATALOG_SUMMARIES = 100;
const catalogSchema = z.array(summarySchema).max(MAX_CATALOG_SUMMARIES);

/**
 * Validates what a `WalkthroughCatalogView.list()` returned (it is a host port, so it is checked, not trusted): a plain array of at most 100 strict
 * summaries `{ id, title, description }` with plain-text titles and descriptions and unique ids. Anything else is `null`. Returns frozen copies.
 */
export function parseCatalogSummaries(raw: unknown): readonly SafeWalkthroughSummary[] | null {
  try {
    const snapshot = snapshotPlainData(raw);
    if (!snapshot.ok) return null;
    const parsed = catalogSchema.safeParse(snapshot.value);
    if (!parsed.success || new Set(parsed.data.map((summary) => summary.id)).size !== parsed.data.length) return null;
    return Object.freeze(parsed.data.map((summary) => Object.freeze({ id: summary.id, title: summary.title, description: summary.description })));
  } catch { return null; }
}

/**
 * The least BM25 score a proposed summary needs for the question. Tuned on the three demo summaries (pinned in apps/reference-host/src/guidance/walkthrough-summaries.test.ts
 * and plan.md "Slice 3 decisions"): no overlap scores exactly 0, the weakest real overlap (a topic word two guides share) 0.69. The score is absolute and BM25's IDF depends
 * on the number of summaries, so re-tune it if the catalog changes size a lot; with a catalog of ONE summary a single matching term scores about 0.45 and is not enough
 * (the result is a `clarify`, never a start).
 */
export const MIN_SELECTION_SCORE = 0.5;
/** How many summaries count as "near the top". */
export const SELECTION_TOP_N = 3;
/** The proposed summary must score at least this many times the best OTHER summary. */
export const SELECTION_MARGIN = 1.2;

/** Words that say "do the guided thing" rather than naming a topic. They never carry a selection (post plural fold, so "walkthroughs" is covered). */
const ACTIVITY_WORDS: ReadonlySet<string> = new Set(["start", "walkthrough", "guide", "help", "show", "tour", "walk", "through", "open"]);
const selectionTokens = (text: unknown): string[] => tokenize(text).filter((token) => !ACTIVITY_WORDS.has(token));

export interface RankedSummary { readonly id: string; readonly score: number }

const byScoreThenId = (a: RankedSummary, b: RankedSummary): number => (b.score !== a.score ? b.score - a.score : a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/** Every summary with its guard score for the query: score descending, then id ascending. Total and pure; independent of the input order. */
export function rankSummaries(summaries: readonly SafeWalkthroughSummary[], query: unknown): readonly RankedSummary[] {
  try {
    const docs = summaries.map((summary) => bm25Doc([[selectionTokens(summary.title), 2], [selectionTokens(summary.description), 1]]));
    const bm25 = createBm25(docs);
    const terms = [...new Set(selectionTokens(query))];
    return summaries.map((summary, index) => ({ id: summary.id, score: terms.length === 0 ? 0 : round6(bm25.score(docs[index]!, terms)) })).sort(byScoreThenId);
  } catch { return summaries.map((summary) => ({ id: summary.id, score: 0 })).sort(byScoreThenId); }
}

/**
 * The summaries the model is shown: all of them (sorted by id) when there are at most `MAX_SUMMARIES`, otherwise the best `MAX_SUMMARIES` lexical matches
 * for the query (ties by id), also sorted by id. Deterministic for any input order.
 */
export function capSummaries(summaries: readonly SafeWalkthroughSummary[], query: unknown): readonly SafeWalkthroughSummary[] {
  const byId = new Map<string, SafeWalkthroughSummary>(summaries.map((summary) => [summary.id, summary]));
  const keep = summaries.length <= MAX_SUMMARIES ? [...byId.keys()] : rankSummaries(summaries, query).slice(0, MAX_SUMMARIES).map((ranked) => ranked.id);
  return Object.freeze(keep.sort().map((id) => byId.get(id)!));
}

/** The supplied summary whose id is EXACTLY `id`, or `null`. A duplicated id in the supplied list is treated as no match (fail closed). */
export function validateProposedWalkthrough(summaries: readonly SafeWalkthroughSummary[], id: unknown): SafeWalkthroughSummary | null {
  if (typeof id !== "string") return null;
  const byId = new Map<string, SafeWalkthroughSummary>();
  for (const summary of summaries) {
    if (byId.has(summary.id)) return null;
    byId.set(summary.id, summary);
  }
  return byId.get(id) ?? null;
}

export type SelectionVerdict =
  | { readonly verdict: "accepted" }
  | { readonly verdict: "unknown" }
  | { readonly verdict: "unrelated" }
  /** `candidates` are the ids of the best summaries that reach the minimum score (at most `SELECTION_TOP_N`), best first. */
  | { readonly verdict: "ambiguous"; readonly candidates: readonly string[] };

/** The guard. `summaries` must be the ones actually supplied to the model, and `query` the (sanitised) question. */
export function judgeProposal(summaries: readonly SafeWalkthroughSummary[], query: unknown, id: unknown): SelectionVerdict {
  const proposed = validateProposedWalkthrough(summaries, id);
  if (proposed === null) return { verdict: "unknown" };
  const ranked = rankSummaries(summaries, query);
  const own = ranked.find((entry) => entry.id === proposed.id)!;
  if (own.score < MIN_SELECTION_SCORE) return { verdict: "unrelated" };
  const bestOther = ranked.find((entry) => entry.id !== proposed.id)?.score ?? 0;
  const inTopN = ranked.slice(0, SELECTION_TOP_N).some((entry) => entry.id === proposed.id); // implied by the margin rule below; kept as its own line
  const clearlyAhead = own.score >= SELECTION_MARGIN * bestOther;
  if (inTopN && clearlyAhead) return { verdict: "accepted" };
  return { verdict: "ambiguous", candidates: Object.freeze(ranked.filter((entry) => entry.score >= MIN_SELECTION_SCORE).slice(0, SELECTION_TOP_N).map((entry) => entry.id)) };
}
