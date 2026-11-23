/**
 * C01: the browser side of the AI Help wire contract. It POSTs `{query, semanticContext}` to `/api/guidance` and `{proposalId}` to
 * `/api/guidance/start`, and nothing else. Every server reply is untrusted: it is size-bounded, parsed, and checked against a strict, hand-written
 * shape here (reference-web may only depend on @dap/walkthrough). Anything unrecognised, malformed, oversized, late or failed becomes the safe
 * `unavailable` outcome; no server or network error text is ever passed on.
 */
import type { GuideApi } from "../launcher.js";

/** The same bounds as Feature 003 (packages/ai/src/guidance/limits.ts); restated because this app cannot import that package. */
export const HELP_LIMITS = Object.freeze({ queryChars: 500, answerChars: 1200, messageChars: 300, titleChars: 80, idChars: 128, sources: 4, responseChars: 16_000, timeoutMs: 15_000 });

export type SemanticContext = ReturnType<GuideApi["context"]>;
export interface HelpSource { readonly title: string }
export type GuidanceOutcome =
  | { readonly kind: "answer"; readonly answer: string; readonly sources: readonly HelpSource[] }
  | { readonly kind: "walkthrough"; readonly proposalId: string; readonly title: string; readonly message: string | null }
  | { readonly kind: "clarify"; readonly message: string }
  | { readonly kind: "unsupported" }
  | { readonly kind: "unavailable" };
export type StartOutcome = { readonly kind: "start"; readonly walkthroughId: string } | { readonly kind: "refused" } | { readonly kind: "unavailable" };

export interface GuidanceClient {
  ask(query: string, semanticContext: SemanticContext): Promise<GuidanceOutcome>;
  start(proposalId: string): Promise<StartOutcome>;
}
/** The part of `fetch` the client uses, so tests can inject a fake host. */
export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

type Json = Readonly<Record<string, unknown>>;
const UNAVAILABLE = Object.freeze({ kind: "unavailable" as const });

const isRecord = (value: unknown): value is Json => value !== null && typeof value === "object" && !Array.isArray(value);
const hasOnly = (value: Json, allowed: readonly string[]): boolean => Object.keys(value).every(key => allowed.includes(key));
const text = (value: unknown, max: number): value is string => typeof value === "string" && value.trim().length > 0 && value.length <= max;

function parseSources(value: unknown): readonly HelpSource[] | null {
  if (!Array.isArray(value) || value.length > HELP_LIMITS.sources) return null;
  const sources: HelpSource[] = [];
  for (const item of value as readonly unknown[]) {
    if (!isRecord(item) || !hasOnly(item, ["id", "title"]) || !text(item.id, HELP_LIMITS.idChars) || !text(item.title, HELP_LIMITS.titleChars)) return null;
    sources.push(Object.freeze({ title: item.title }));
  }
  return Object.freeze(sources);
}

/** Exported for tests: the strict guard for a `/api/guidance` reply. `ok` is whether the HTTP status was 2xx. */
export function parseGuidance(body: unknown, ok: boolean): GuidanceOutcome {
  if (!isRecord(body)) return UNAVAILABLE;
  const kind = body.kind;
  if (kind === "unsupported" && hasOnly(body, ["kind", "message"]) && text(body.message, HELP_LIMITS.messageChars)) return Object.freeze({ kind });
  if (!ok) return UNAVAILABLE; // only a refusal-style reply is meaningful with an error status
  if (kind === "clarify" && hasOnly(body, ["kind", "message"]) && text(body.message, HELP_LIMITS.messageChars)) return Object.freeze({ kind, message: body.message });
  if (kind === "answer" && hasOnly(body, ["kind", "answer", "sources"]) && text(body.answer, HELP_LIMITS.answerChars)) {
    const sources = parseSources(body.sources);
    return sources === null ? UNAVAILABLE : Object.freeze({ kind, answer: body.answer, sources });
  }
  if (kind === "walkthrough" && hasOnly(body, ["kind", "proposalId", "title", "message"]) && text(body.proposalId, HELP_LIMITS.idChars) && text(body.title, HELP_LIMITS.titleChars)) {
    if (body.message !== undefined && !text(body.message, HELP_LIMITS.messageChars)) return UNAVAILABLE;
    return Object.freeze({ kind, proposalId: body.proposalId, title: body.title, message: body.message ?? null });
  }
  return UNAVAILABLE;
}

/** Exported for tests: the strict guard for a `/api/guidance/start` reply. */
export function parseStart(body: unknown, ok: boolean): StartOutcome {
  if (!isRecord(body)) return UNAVAILABLE;
  if (body.kind === "unsupported" && hasOnly(body, ["kind", "message"]) && text(body.message, HELP_LIMITS.messageChars)) return Object.freeze({ kind: "refused" });
  if (ok && body.kind === "start" && hasOnly(body, ["kind", "walkthroughId"]) && text(body.walkthroughId, HELP_LIMITS.idChars)) return Object.freeze({ kind: "start", walkthroughId: body.walkthroughId });
  return UNAVAILABLE;
}

export async function readReply(response: Response, signal: AbortSignal, maxChars: number = HELP_LIMITS.responseChars): Promise<string | null> {
  if (response.body === null || signal.aborted) return null;
  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const cancel = () => { void reader.cancel().catch(() => undefined); };
  signal.addEventListener("abort", cancel, { once: true });
  let raw = "";
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (signal.aborted) return null;
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      // UTF-8 needs at most three bytes per UTF-16 unit. Bound decoding as well as the retained text.
      if (bytes > 3 * maxChars) { cancel(); return null; }
      raw += decoder.decode(chunk.value, { stream: true });
      if (raw.length > maxChars) { cancel(); return null; }
    }
    raw += decoder.decode();
    return raw.length <= maxChars ? raw : null;
  } catch {
    cancel();
    return null;
  } finally {
    signal.removeEventListener("abort", cancel);
    reader.releaseLock();
  }
}

export function createGuidanceClient(options: { readonly fetch?: FetchLike | undefined; readonly timeoutMs?: number } = {}): GuidanceClient {
  const timeoutMs = options.timeoutMs ?? HELP_LIMITS.timeoutMs;
  /** One bounded JSON POST. Resolves to the parsed body and status, or null for any failure (network, abort, timeout, oversize, bad JSON). */
  const post = async (url: string, payload: Json): Promise<{ readonly body: unknown; readonly ok: boolean } | null> => {
    const fetcher = options.fetch;
    if (fetcher === undefined) return null;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<null>(resolve => { timer = setTimeout(() => { controller.abort(); resolve(null); }, timeoutMs); });
    const exchange = (async () => {
      const response = await fetcher(url, {
        method: "POST", credentials: "same-origin", cache: "no-store", signal: controller.signal,
        headers: { "content-type": "application/json", accept: "application/json" }, body: JSON.stringify(payload),
      });
      const raw = await readReply(response, controller.signal);
      if (raw === null) return null;
      return { body: JSON.parse(raw) as unknown, ok: response.ok };
    })().catch(() => null);
    try { return await Promise.race([exchange, expired]); } finally { clearTimeout(timer); }
  };
  return Object.freeze({
    async ask(query: string, semanticContext: SemanticContext): Promise<GuidanceOutcome> {
      const reply = await post("/api/guidance", { query, semanticContext });
      return reply === null ? UNAVAILABLE : parseGuidance(reply.body, reply.ok);
    },
    async start(proposalId: string): Promise<StartOutcome> {
      const reply = await post("/api/guidance/start", { proposalId });
      return reply === null ? UNAVAILABLE : parseStart(reply.body, reply.ok);
    },
  });
}
