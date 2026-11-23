/**
 * C01: the narrow browser transport for AI Help. Two JSON routes and nothing else:
 *
 *   POST /api/guidance        {query, semanticContext}  -> answer | walkthrough(proposalId, title) | clarify | unsupported | unavailable
 *   POST /api/guidance/start  {proposalId}              -> start(walkthroughId) | unsupported
 *
 * The proposal step only ASKS (Feature 003 `askGuidance`): it starts and approves nothing, and the browser gets an opaque single-use proposal id, never a
 * walkthrough id. Only `/start` sends the proposal through the Gateway (via the injected session's `start`), and the walkthrough id it returns is the one the
 * trusted executor approved. Validation reuses Feature 003 (`MAX_QUERY_CHARS`, `parseSemanticContextInput`; `askGuidance` validates again). Every reply is a
 * closed shape with a fixed message: no stack trace, schema error, provider text, prompt, key, database error, permission id or risk detail can reach it.
 * No CORS headers are sent: the browser reaches this server same-origin through the reference web app's dev proxy (`/api` -> 127.0.0.1:8787), and
 * `application/json` is the only accepted body type, so a cross-site page cannot post here without a (refused) preflight.
 */
import { fastify } from "fastify";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { MAX_QUERY_CHARS, parseSemanticContextInput, unsupportedResult } from "@dap/ai";
import type { GuidanceResult, WalkthroughCatalogView } from "@dap/ai";
import type { StartOutcome } from "./approved-start.js";
import type { ProposalStore } from "./proposal-store.js";

// --- the wire contract ------------------------------------------------------------------------------------------------------------------------------
export type GuidanceWireResponse =
  | { readonly kind: "answer"; readonly answer: string; readonly sources: readonly { readonly id: string; readonly title: string }[] }
  | { readonly kind: "walkthrough"; readonly proposalId: string; readonly title: string; readonly message?: string }
  | { readonly kind: "clarify"; readonly message: string }
  | { readonly kind: "unsupported"; readonly message: string }
  | { readonly kind: "unavailable"; readonly message: string };
export type StartWireResponse =
  | { readonly kind: "start"; readonly walkthroughId: string }
  | { readonly kind: "unsupported"; readonly message: string }
  | { readonly kind: "unavailable"; readonly message: string };

/** A host session as the transport sees it: a key that proposals are bound to, and the Gateway start. */
export interface GuidanceSession {
  readonly key: string;
  start(walkthroughId: string): Promise<StartOutcome>;
}
export type RequestHeaders = FastifyRequest["headers"];
export interface GuidanceTransportDeps {
  /** Feature 003 `askGuidance` (proposal only). Untrusted input; expected never to throw (a throw is `unavailable`). */
  readonly ask: (input: { readonly query: unknown; readonly semanticContext: unknown }) => Promise<GuidanceResult>;
  /** The trusted catalog, for the title shown with a proposal. */
  readonly catalog: WalkthroughCatalogView;
  /** The host's session for this request, or `null`. The browser supplies no identity: the dev server always returns its own demo session. */
  readonly resolveSession: (headers: RequestHeaders) => Promise<GuidanceSession | null>;
  readonly proposals: ProposalStore;
  readonly bodyLimit?: number;
}

/** A full 60-element context is about 31 KB of JSON; 64 KiB admits every valid request with room for escaping and nothing much larger. */
export const BODY_LIMIT_BYTES = 64 * 1024;
const PROPOSAL_ID = /^[A-Za-z0-9_-]{16,128}$/;
export const DEFAULT_HTTP_PORT = 8787;
/** Loopback only. */
export const HTTP_HOST = "127.0.0.1";
/** `DAP_HTTP_PORT`: unset or empty is the default port; anything but a decimal 1..65535 is `null` (startup refuses it). */
export function parseHttpPort(raw: string | undefined): number | null {
  if (raw === undefined || raw === "") return DEFAULT_HTTP_PORT;
  if (!/^[0-9]{1,5}$/.test(raw)) return null;
  const port = Number(raw);
  return port >= 1 && port <= 65535 ? port : null;
}

export const TRANSPORT_MESSAGES = Object.freeze({
  malformed: "That request could not be read. Please try again.",
  tooLarge: "That request is too large. Please ask a shorter question.",
  unavailable: "Guidance is temporarily unavailable. Please try again.",
  noSession: "Guidance is not available right now.",
  proposalGone: "That guide can no longer be started. Please ask again.",
  startRefused: "That guide cannot be started right now.",
  proposal: "I found a guide that can help.",
  notFound: "Not found.",
  forbiddenHost: "This request is not allowed.",
});

/** Loopback host names only (any port): a request whose Host names another site (DNS rebinding) is refused before routing. */
const LOOPBACK_HOST = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/;

const unsupported = (message: string) => ({ kind: "unsupported" as const, message });
const unavailable = () => ({ kind: "unavailable" as const, message: TRANSPORT_MESSAGES.unavailable });

/** The body as an own-keys record with EXACTLY `keys`, or `null`. (Exported for the authoring routes, which share the transport's strictness.) */
export function exactBody(body: unknown, keys: readonly string[]): Record<string, unknown> | null {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
  const own = Object.keys(body);
  if (own.length !== keys.length || !keys.every((key) => Object.hasOwn(body, key))) return null;
  return body as Record<string, unknown>;
}

function titleOf(catalog: WalkthroughCatalogView, walkthroughId: string): string | null {
  try {
    const found = catalog.list().find((summary) => summary.id === walkthroughId);
    return typeof found?.title === "string" ? found.title : null;
  } catch { return null; }
}

export function createGuidanceTransport(deps: GuidanceTransportDeps): FastifyInstance {
  const { ask, catalog, resolveSession, proposals, bodyLimit = BODY_LIMIT_BYTES } = deps;
  const app = fastify({ logger: false, bodyLimit, onProtoPoisoning: "error", onConstructorPoisoning: "error", exposeHeadRoutes: false, return503OnClosing: true });
  // JSON only: drop Fastify's built-in text/plain parser so any other content type is a 415.
  app.removeContentTypeParser("text/plain");

  const send = (reply: FastifyReply, status: number, body: GuidanceWireResponse | StartWireResponse) => reply.code(status).type("application/json; charset=utf-8").send(body);
  const session = async (request: FastifyRequest): Promise<GuidanceSession | null> => { try { return await resolveSession(request.headers); } catch { return null; } };

  app.addHook("onRequest", async (request, reply) => {
    if (!LOOPBACK_HOST.test(request.headers.host ?? "")) return send(reply, 403, unsupported(TRANSPORT_MESSAGES.forbiddenHost));
    // A browser names where the request came from: only the page's own origin (via the Vite proxy) or a direct navigation may call in. No header
    // (curl, tests) passes; a browser that sends it can't be talked out of it by page script.
    const site = request.headers["sec-fetch-site"];
    if (site !== undefined && site !== "same-origin" && site !== "none") return send(reply, 403, unsupported(TRANSPORT_MESSAGES.forbiddenHost));
  });
  app.addHook("onSend", async (_request, reply, payload) => {
    reply.header("cache-control", "no-store");
    reply.header("x-content-type-options", "nosniff");
    return payload;
  });
  // Parser, body-limit and any other framework error: a fixed message by class, never the error itself.
  app.setErrorHandler((error: { statusCode?: unknown } | null | undefined, _request, reply) => {
    const status = typeof error?.statusCode === "number" ? error.statusCode : 500;
    if (status === 413) return send(reply, 413, unsupported(TRANSPORT_MESSAGES.tooLarge));
    if (status >= 400 && status < 500) return send(reply, status === 415 ? 415 : 400, unsupported(TRANSPORT_MESSAGES.malformed));
    return send(reply, 503, unavailable());
  });
  app.setNotFoundHandler((_request, reply) => send(reply, 404, unsupported(TRANSPORT_MESSAGES.notFound)));

  const toWire = (owner: GuidanceSession, result: GuidanceResult): readonly [number, GuidanceWireResponse] => {
    switch (result.kind) {
      case "answer": return [200, { kind: "answer", answer: result.answer, sources: result.sources.map((source) => ({ id: source.id, title: source.title })) }];
      case "clarify": return [200, { kind: "clarify", message: result.message }];
      case "walkthrough": {
        const title = titleOf(catalog, result.walkthroughId);
        if (title === null) return [200, unsupported(unsupportedResult("unknown_walkthrough").message)];
        return [200, { kind: "walkthrough", proposalId: proposals.mint(owner.key, result.walkthroughId), title, message: TRANSPORT_MESSAGES.proposal }];
      }
      case "unsupported":
        if (result.reason === "model_unavailable" || result.reason === "unavailable") return [503, unavailable()];
        return [200, unsupported(unsupportedResult(result.reason).message)];
      default: return [503, unavailable()];
    }
  };

  app.post("/api/guidance", async (request, reply) => {
    const body = exactBody(request.body, ["query", "semanticContext"]);
    if (body === null || typeof body.query !== "string") return send(reply, 400, unsupported(TRANSPORT_MESSAGES.malformed));
    if (body.query.length > MAX_QUERY_CHARS) return send(reply, 400, unsupported(unsupportedResult("query_invalid").message));
    if (parseSemanticContextInput(body.semanticContext) === null) return send(reply, 400, unsupported(unsupportedResult("context_invalid").message));
    const owner = await session(request);
    if (owner === null) return send(reply, 401, unsupported(TRANSPORT_MESSAGES.noSession));
    let result: GuidanceResult;
    try { result = await ask({ query: body.query, semanticContext: body.semanticContext }); } catch { return send(reply, 503, unavailable()); }
    try {
      const [status, wire] = toWire(owner, result);
      return send(reply, status, wire);
    } catch { return send(reply, 503, unavailable()); }
  });

  app.post("/api/guidance/start", async (request, reply) => {
    const body = exactBody(request.body, ["proposalId"]);
    if (body === null || typeof body.proposalId !== "string" || !PROPOSAL_ID.test(body.proposalId)) return send(reply, 400, unsupported(TRANSPORT_MESSAGES.malformed));
    const owner = await session(request);
    if (owner === null) return send(reply, 401, unsupported(TRANSPORT_MESSAGES.noSession));
    const walkthroughId = proposals.redeem(owner.key, body.proposalId);
    if (walkthroughId === null) return send(reply, 200, unsupported(TRANSPORT_MESSAGES.proposalGone));
    let outcome: StartOutcome;
    try { outcome = await owner.start(walkthroughId); } catch { outcome = { ok: false }; }
    if (outcome.ok && typeof outcome.walkthroughId === "string") return send(reply, 200, { kind: "start", walkthroughId: outcome.walkthroughId });
    if (!outcome.ok && outcome.unavailable === true) return send(reply, 503, unavailable());
    return send(reply, 200, unsupported(TRANSPORT_MESSAGES.startRefused));
  });

  return app;
}
