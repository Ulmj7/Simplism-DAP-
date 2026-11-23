/**
 * Approved product knowledge: document validation and deterministic chunking. Pure: documents arrive as plain data from the trusted host loader.
 *
 * One shared product knowledge base: documents carry no tenant ownership, and a document with a `tenantId` is REFUSED until tenant filtering exists.
 * (The trigger is Constitution XI: when a feature stores tenant-owned knowledge, the tenant constraint must be part of the retrieval QUERY, never a
 * post-filter. Secret-pattern refusal is the host loader's job: this package cannot import the scrubber.)
 */
import { z } from "zod";
import { MAX_DOC_CHARS, MAX_DOC_TAGS, MAX_KNOWLEDGE_DOCS, MAX_SOURCE_CHARS, MAX_TITLE_CHARS, MAX_TOPIC_CHARS } from "../limits.js";
import { snapshotPlainData } from "../snapshot.js";
import { isDocumentText, isId, isPlainText } from "../text.js";

const DOC_ID = /^[a-z][a-z0-9-]{0,47}$/;
const TAG = /^[a-z0-9][a-z0-9-]{0,31}$/;

export interface KnowledgeDoc {
  readonly id: string;
  readonly title: string;
  readonly content: string;
  readonly tags: readonly string[];
  readonly topic?: string;
  readonly visibility: "public";
}
export interface KnowledgeChunk {
  /** `<docId>.<n>`, n from 1 without gaps. Always a valid source id. */
  readonly id: string;
  readonly docId: string;
  readonly title: string;
  readonly text: string;
  readonly tags: readonly string[];
}

const docSchema = z.strictObject({
  id: z.string().refine((v) => isId(v, DOC_ID)),
  title: z.string().refine((v) => isPlainText(v, MAX_TITLE_CHARS)),
  content: z.string().refine((v) => isDocumentText(v, MAX_DOC_CHARS)),
  tags: z.array(z.string().refine((v) => TAG.test(v))).max(MAX_DOC_TAGS),
  topic: z.string().refine((v) => isPlainText(v, MAX_TOPIC_CHARS)).optional(),
  visibility: z.literal("public"),
});

export type DocParse = { readonly ok: true; readonly doc: KnowledgeDoc } | { readonly ok: false; readonly reason: "invalid_document" | "tenant_scoped_document" };
export type SetParse =
  | { readonly ok: true; readonly docs: readonly KnowledgeDoc[] }
  | { readonly ok: false; readonly reason: "invalid_document" | "tenant_scoped_document" | "duplicate_id" | "too_many_documents" };

const deepFreeze = <T>(value: T): T => {
  if (value !== null && typeof value === "object") { for (const child of Object.values(value)) deepFreeze(child); Object.freeze(value); }
  return value;
};

/** A validated, frozen copy, or the reason it was refused. Never echoes the document. */
export function parseKnowledgeDoc(raw: unknown): DocParse {
  try {
    const snapshot = snapshotPlainData(raw, { maxString: MAX_DOC_CHARS + 1 });
    if (!snapshot.ok) return { ok: false, reason: "invalid_document" };
    const value = snapshot.value;
    if (value !== null && typeof value === "object" && !Array.isArray(value) && Object.hasOwn(value, "tenantId")) return { ok: false, reason: "tenant_scoped_document" };
    const parsed = docSchema.safeParse(value);
    return parsed.success ? { ok: true, doc: deepFreeze(parsed.data as KnowledgeDoc) } : { ok: false, reason: "invalid_document" };
  } catch { return { ok: false, reason: "invalid_document" }; }
}

/** Validates a whole knowledge base: at most 200 documents, no duplicate ids. */
export function parseKnowledgeSet(raw: unknown): SetParse {
  try {
    if (!Array.isArray(raw)) return { ok: false, reason: "invalid_document" };
    const lengthDescriptor = Object.getOwnPropertyDescriptor(raw, "length");
    const length = lengthDescriptor !== undefined && "value" in lengthDescriptor ? lengthDescriptor.value as unknown : undefined;
    if (typeof length !== "number" || !Number.isInteger(length) || length < 0) return { ok: false, reason: "invalid_document" };
    if (length > MAX_KNOWLEDGE_DOCS) return { ok: false, reason: "too_many_documents" };
    const docs: KnowledgeDoc[] = [];
    const seen = new Set<string>();
    for (let index = 0; index < length; index++) {
      const descriptor = Object.getOwnPropertyDescriptor(raw, String(index));
      if (descriptor === undefined || !("value" in descriptor)) return { ok: false, reason: "invalid_document" };
      const parsed = parseKnowledgeDoc(descriptor.value);
      if (!parsed.ok) return parsed;
      if (seen.has(parsed.doc.id)) return { ok: false, reason: "duplicate_id" };
      seen.add(parsed.doc.id);
      docs.push(parsed.doc);
    }
    return { ok: true, docs: Object.freeze(docs) };
  } catch { return { ok: false, reason: "invalid_document" }; }
}

/** Splits text longer than `max` at the last space before the bound (a hard cut only when there is none), so nothing is dropped. */
function splitLong(paragraph: string, max: number): string[] {
  const pieces: string[] = [];
  let rest = paragraph;
  while (rest.length > max) {
    const cut = rest.lastIndexOf(" ", max);
    if (cut > 0) { pieces.push(rest.slice(0, cut)); rest = rest.slice(cut + 1); }
    else { pieces.push(rest.slice(0, max)); rest = rest.slice(max); }
  }
  if (rest.length > 0) pieces.push(rest);
  return pieces;
}

/**
 * Deterministic chunking. Line endings are normalised and every whitespace run becomes one space (so chunk text satisfies the source-text rule);
 * paragraphs (blank-line boundaries) are merged greedily into chunks of at most 800 characters; an over-long paragraph is split, never truncated.
 * Joining the chunk texts with a space gives the normalised content back (a hard cut, only when a word is longer than 800 characters, joins with nothing).
 */
export function chunkDocument(doc: KnowledgeDoc): KnowledgeChunk[] {
  const paragraphs = doc.content.replace(/\r\n?/g, "\n").split(/\n[ \t]*\n/).map((p) => p.replace(/\s+/g, " ").trim()).filter((p) => p.length > 0);
  const texts: string[] = [];
  let current = "";
  for (const piece of paragraphs.flatMap((p) => splitLong(p, MAX_SOURCE_CHARS))) {
    if (current === "") current = piece;
    else if (current.length + 1 + piece.length <= MAX_SOURCE_CHARS) current = `${current} ${piece}`;
    else { texts.push(current); current = piece; }
  }
  if (current !== "") texts.push(current);
  return texts.map((text, index) => ({ id: `${doc.id}.${index + 1}`, docId: doc.id, title: doc.title, text, tags: doc.tags }));
}

/** Chunks every document of a validated set, in document order. */
export const chunkKnowledge = (docs: readonly KnowledgeDoc[]): KnowledgeChunk[] => docs.flatMap(chunkDocument);
