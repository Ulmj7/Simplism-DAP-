/**
 * The deterministic retriever: a pure function of (chunks, query). No embeddings, no model call, no I/O, no timers, no randomness.
 *
 * Normalisation: NFKC, lower case, split on anything that is not a letter or digit, a short English stop-word list, and a plain trailing `s` folded
 * only for tokens longer than 3 characters that do not end in `ss` (no stemmer). Ranking: BM25 (k1 1.2, b 0.75; IDF ln(1 + (N - df + 0.5)/(df + 0.5)),
 * always positive) over chunks, with title and tag tokens counted double, summed over the query's DISTINCT terms, rounded to 6 decimals. Results below
 * `MIN_RELEVANCE` are dropped, so an unrelated question finds nothing; order is score descending, then chunk id ascending; at most `MAX_SOURCES`.
 * Retrieved text is DATA: it is returned as is and has no effect on ranking beyond its words.
 */
import { MAX_SOURCES } from "../limits.js";
import type { KnowledgeChunk } from "./document.js";

export const BM25_K1 = 1.2;
export const BM25_B = 0.75;
/**
 * The least score a chunk needs to be returned. Tuned on the shipped help articles (apps/reference-host/src/guidance/knowledge.test.ts pins which questions pass and which do not):
 * questions the articles really answer scored 2.6 to 5.1 at the top; the highest score of any question they do not answer ("delete my account", which
 * shares only the word "account") was 1.74, and a lone common word ("settings") 0.8. The score depends on the number of chunks, so re-check the
 * constant if the knowledge base grows far beyond a few dozen chunks. A very small base (a handful of chunks) scores lower and may need two matching terms.
 */
export const MIN_RELEVANCE = 2.0;
export const MAX_QUERY_TOKENS = 64;

const STOP_WORDS: ReadonlySet<string> = new Set([
  "a", "about", "after", "all", "also", "am", "an", "and", "any", "are", "as", "at", "be", "been", "but", "by", "can", "could", "did", "do", "does", "for", "from",
  "get", "had", "has", "have", "how", "i", "if", "in", "into", "is", "it", "its", "just", "me", "my", "of", "on", "or", "our", "please", "should", "so", "some",
  "tell", "than", "that", "the", "their", "them", "then", "there", "these", "they", "this", "to", "us", "was", "we", "were", "what", "when", "where", "which", "who",
  "why", "will", "with", "would", "you", "your",
]);

/** The normalised, stop-word-free, plural-folded tokens of a text (duplicates kept). */
export function tokenize(text: unknown): string[] {
  if (typeof text !== "string") return [];
  const out: string[] = [];
  for (const raw of text.normalize("NFKC").toLowerCase().split(/[^\p{L}\p{N}]+/u)) {
    if (raw === "" || STOP_WORDS.has(raw)) continue;
    out.push(raw.length > 3 && raw.endsWith("s") && !raw.endsWith("ss") ? raw.slice(0, -1) : raw);
  }
  return out;
}

export interface RetrievedChunk {
  readonly id: string;
  readonly docId: string;
  readonly title: string;
  readonly text: string;
  readonly score: number;
}
export interface Retriever {
  /** Total and pure: a non-string, empty or unrelated query gives `[]`. Never throws. */
  search(query: unknown): readonly RetrievedChunk[];
}

export const round6 = (value: number): number => Number(value.toFixed(6));

/** One document for the scorer: weighted term frequencies and its weighted length. */
export interface Bm25Doc { readonly tf: ReadonlyMap<string, number>; readonly length: number }
/** Builds a scorer document from token lists, each with a weight (a token counts `weight` times, in the term frequency and in the length). */
export function bm25Doc(fields: readonly (readonly [tokens: readonly string[], weight: number])[]): Bm25Doc {
  const tf = new Map<string, number>();
  let length = 0;
  for (const [tokens, weight] of fields) for (const token of tokens) { tf.set(token, (tf.get(token) ?? 0) + weight); length += weight; }
  return { tf, length };
}
/**
 * The ONE BM25 formula of this package (k1 1.2, b 0.75; IDF ln(1 + (N - df + 0.5)/(df + 0.5)), always positive), shared by the knowledge retriever and the
 * walkthrough-selection guard. `score(doc, terms)` sums over the DISTINCT `terms` and is NOT rounded; callers round with `round6`.
 */
export function createBm25(docs: readonly Bm25Doc[]): { score(doc: Bm25Doc, terms: readonly string[]): number } {
  const documentFrequency = new Map<string, number>();
  for (const doc of docs) for (const term of doc.tf.keys()) documentFrequency.set(term, (documentFrequency.get(term) ?? 0) + 1);
  const total = docs.length;
  const averageLength = total === 0 ? 0 : docs.reduce((sum, doc) => sum + doc.length, 0) / total;
  return {
    score(doc, terms) {
      let score = 0;
      for (const term of terms) {
        const tf = doc.tf.get(term);
        if (tf === undefined) continue;
        const df = documentFrequency.get(term) ?? 0;
        const idf = Math.log(1 + (total - df + 0.5) / (df + 0.5));
        score += idf * ((tf * (BM25_K1 + 1)) / (tf + BM25_K1 * (1 - BM25_B + BM25_B * (doc.length / averageLength))));
      }
      return score;
    },
  };
}

export function createRetriever(chunks: readonly KnowledgeChunk[]): Retriever {
  interface Entry { readonly chunk: KnowledgeChunk; readonly doc: Bm25Doc }
  const entries: Entry[] = [...chunks].map((chunk) => ({
    chunk: Object.freeze({ ...chunk }),
    doc: bm25Doc([[tokenize(chunk.text), 1], [tokenize(chunk.title), 2], [tokenize(chunk.tags.join(" ")), 2]]),
  }));
  const bm25 = createBm25(entries.map((entry) => entry.doc));
  const total = entries.length;

  return Object.freeze({
    search(query: unknown): readonly RetrievedChunk[] {
      try {
        const terms = [...new Set(tokenize(query).slice(0, MAX_QUERY_TOKENS))];
        if (terms.length === 0 || total === 0) return [];
        const scored: RetrievedChunk[] = [];
        for (const entry of entries) {
          const rounded = round6(bm25.score(entry.doc, terms));
          if (rounded >= MIN_RELEVANCE) scored.push(Object.freeze({ id: entry.chunk.id, docId: entry.chunk.docId, title: entry.chunk.title, text: entry.chunk.text, score: rounded }));
        }
        scored.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
        return Object.freeze(scored.slice(0, MAX_SOURCES));
      } catch { return []; }
    },
  });
}
