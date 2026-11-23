/**
 * The request the model is shown: structured, validated, bounded. Every object is strict, so a request cannot carry an authorization context, a token,
 * a cookie, HTML, an arbitrary attribute, an executor handle, Gateway internals or a walkthrough definition: any such key makes it invalid.
 * Nothing is trimmed or repaired. (Rendering the request into prompt text is a later host-side helper.)
 */
import { z } from "zod";
import {
  MAX_ANSWER_CHARS, MAX_CONTEXT_ELEMENTS, MAX_DESCRIPTION_CHARS, MAX_ID_CHARS, MAX_LABEL_CHARS, MAX_QUERY_CHARS, MAX_ROUTE_CHARS, MAX_SOURCE_CHARS, MAX_SOURCES, MAX_SUMMARIES, MAX_TITLE_CHARS,
} from "./limits.js";
import { snapshotPlainData } from "./snapshot.js";
import { ELEMENT_ID, ROUTE, SOURCE_ID, WALKTHROUGH_ID, isBoundedText, isId, isPlainText } from "./text.js";
import type { GuidanceModelRequest } from "./types.js";

const plain = (max: number) => z.string().refine((v) => isPlainText(v, max));
const bounded = (max: number) => z.string().refine((v) => isBoundedText(v, max));

const querySchema = bounded(MAX_QUERY_CHARS);
const element = z.strictObject({
  id: z.string().max(MAX_ID_CHARS).refine((v) => isId(v, ELEMENT_ID)),
  role: z.enum(["button", "link", "textbox", "checkbox", "select", "panel", "nav", "heading", "text"]),
  label: plain(MAX_LABEL_CHARS),
  description: plain(MAX_DESCRIPTION_CHARS),
  privacy: z.enum(["public", "private", "redact"]),
  available: z.boolean(),
});
/**
 * The mirror of Feature 002's `runtime.context()` shape. A page whose route is not in the registry yields the EMPTY route with no elements, so `""` is
 * accepted, but only together with an empty element list (found by the contract test against the real runtime, tests/integration/guidance-context-contract.test.ts).
 */
export const contextSchema = z.strictObject({
  route: z.string().max(MAX_ROUTE_CHARS).refine((v) => v === "" || ROUTE.test(v)),
  elements: z.array(element).max(MAX_CONTEXT_ELEMENTS),
}).refine((c) => c.route !== "" || c.elements.length === 0);
export const summarySchema = z.strictObject({
  id: z.string().refine((v) => isId(v, WALKTHROUGH_ID)),
  title: plain(MAX_TITLE_CHARS),
  description: plain(MAX_DESCRIPTION_CHARS),
});
const sourceSchema = z.strictObject({
  id: z.string().refine((v) => isId(v, SOURCE_ID)),
  title: plain(MAX_TITLE_CHARS),
  text: bounded(MAX_SOURCE_CHARS),
});
const requestSchema = z.strictObject({
  input: z.strictObject({
    query: querySchema,
    semanticContext: contextSchema,
    walkthroughSummaries: z.array(summarySchema).max(MAX_SUMMARIES),
    sources: z.array(sourceSchema).max(MAX_SOURCES),
  }),
  maxOutputChars: z.number().int().min(1).max(MAX_ANSWER_CHARS),
});

export type RequestParse =
  | { readonly ok: true; readonly request: GuidanceModelRequest }
  /** `query_invalid` when the query is the problem, `context_invalid` for anything else (the context, summaries, sources, limits or shape). */
  | { readonly ok: false; readonly reason: "query_invalid" | "context_invalid" };

const deepFreeze = <T>(value: T): T => {
  if (value !== null && typeof value === "object") { for (const child of Object.values(value)) deepFreeze(child); Object.freeze(value); }
  return value;
};

/** Validates an untrusted request and returns a deeply frozen copy, or the reason it was refused (never the value, and never a schema error). */
export function parseGuidanceModelRequest(raw: unknown): RequestParse {
  const snapshot = snapshotPlainData(raw);
  if (!snapshot.ok) return { ok: false, reason: "context_invalid" };
  const value = snapshot.value;
  const input = value !== null && typeof value === "object" ? (value as { input?: unknown }).input : undefined;
  if (input === null || typeof input !== "object") return { ok: false, reason: "context_invalid" }; // no structure to blame the query for
  if (!querySchema.safeParse((input as { query?: unknown }).query).success) return { ok: false, reason: "query_invalid" };
  const parsed = requestSchema.safeParse(snapshot.value);
  if (!parsed.success) return { ok: false, reason: "context_invalid" };
  return { ok: true, request: deepFreeze(parsed.data as GuidanceModelRequest) };
}
