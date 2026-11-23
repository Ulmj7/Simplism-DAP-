/**
 * Independent runtime delivery (Studio COMPLETION, S7): the key-addressed routes an application's OWN pages call to fetch their live guides, with no Studio session and no cookies.
 *
 *   GET|OPTIONS /api/runtime/:key/guides        { guides: [{ id, title, description }] }   the application's LIVE guides (published, re-validated against the CURRENT registry)
 *   GET|OPTIONS /api/runtime/:key/guides/:id    the guide bundle (`guide-bundle.ts`, the same builder the maintainer bundle route uses)
 *
 * AUTHORISATION is the conjunction of four facts, each checked on every request and none taken from the request body:
 *   1. the KEY names an application through the narrow database function `studio_runtime_application` (an ENABLED, Studio-managed application with runtime access on);
 *   2. the request `Origin` EXACTLY equals one of that application's stored allowed origins (a missing or different Origin is 403 and never receives a CORS header);
 *   3. the guide is live (a published guide of THAT application) and still validates against the application's current registry;
 *   4. the per-key-and-address rate limit has room.
 * An unknown key, a disabled application, runtime access off, a rotated (old) key, a guide that is not live and a registry that no longer validates are all the same 404 with a fixed body.
 * The key is a PUBLIC identifier, not a secret: it selects the application, the Origin check authorises. There is NO end-user identity here (documented): whoever can load an allowed
 * origin can read the application's published guides.
 *
 * Responses: `Access-Control-Allow-Origin: <that origin>` and `Vary: Origin` and `Cache-Control: no-store`, never `Access-Control-Allow-Credentials`, never a tenant id, a permission, a stored
 * origin list or another application's data. Every body is fixed or built from the validated guide; nothing the caller sent is echoed. The preflight answers only for allowed origins, only for
 * GET, and allows no request header beyond the CORS-safelisted ones (none are needed).
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { WalkthroughStore } from "../authoring/store.js";
import { MAX_PUBLISHED_PER_TENANT } from "../authoring/store.js";
import type { TenantPool } from "../authoring/tenant-tx.js";
import { validateAuthoredDefinition } from "../authoring/validate.js";
import type { ApplicationStore } from "./application-store.js";
import { isApplicationId, isRuntimeKey } from "./applications.js";
import type { ApplicationRecord } from "./applications.js";
import { buildGuideBundle } from "./guide-bundle.js";
import { createRegistryResolver } from "./registry-resolver.js";
import type { RegistryResolver } from "./registry-resolver.js";
import type { RegistryCatalog } from "./registries.js";
import { emptyTargetStore } from "./empty-target-store.js";
import type { TargetStore } from "./target-store.js";

/** The (tenant, application) a runtime key names, or `null`. The PostgreSQL implementation is the SECURITY DEFINER function of migration 076. */
export interface RuntimeLookup { find(key: string): Promise<{ readonly tenantId: string; readonly applicationId: string } | null> }

export function createPostgresRuntimeLookup(pool: TenantPool): RuntimeLookup {
  return Object.freeze({
    async find(key: string) {
      if (!isRuntimeKey(key)) return null;
      const client = await pool.connect();
      try {
        const { rows } = await client.query("SELECT tenant_id::text AS tenant_id, application_id FROM public.studio_runtime_application($1)", [key]);
        const row = rows[0];
        return row === undefined || !isApplicationId(row.application_id) ? null : { tenantId: String(row.tenant_id), applicationId: String(row.application_id) };
      } finally { client.release(); }
    },
  });
}

export const RUNTIME_MESSAGES = Object.freeze({
  forbidden: "This request is not allowed.",
  notFound: "Not found.",
  rateLimited: "Too many requests. Please try again shortly.",
  unavailable: "Guides are temporarily unavailable. Please try again.",
});
export const RUNTIME_RATE_LIMIT = Object.freeze({ max: 60, windowMs: 60_000, maxEntries: 5_000 });
const GUIDE_ID = /^wt-[a-f0-9]{12}$/;
const SAFE_REQUEST_HEADERS: ReadonlySet<string> = new Set(["accept", "accept-language", "content-language"]);

export interface RuntimeRouteDeps {
  readonly lookup: RuntimeLookup;
  readonly applications: ApplicationStore;
  readonly store: Pick<WalkthroughStore, "listPublished">;
  readonly catalog: RegistryCatalog;
  readonly targets?: TargetStore;
  readonly resolver?: RegistryResolver;
  /** Injectable clock (tests). */
  readonly now?: () => number;
  readonly rateLimit?: { readonly max: number; readonly windowMs: number; readonly maxEntries: number };
}

/** A bounded sliding-window counter per key. The map never holds more than `maxEntries` keys (the oldest are dropped first) and each entry at most `max` timestamps. */
export function createRateLimiter(options: { readonly max: number; readonly windowMs: number; readonly maxEntries: number }, now: () => number) {
  const hits = new Map<string, number[]>();
  const trim = (): void => { while (hits.size > options.maxEntries) { const oldest = hits.keys().next().value; if (oldest === undefined) break; hits.delete(oldest); } };
  return {
    /** `true` when the request may proceed (and is counted). */
    allow(key: string): boolean {
      const t = now();
      const recent = (hits.get(key) ?? []).filter((stamp) => t - stamp < options.windowMs);
      hits.delete(key); // re-inserted below: Map order = least recently used first
      const allowed = recent.length < options.max;
      if (allowed) recent.push(t);
      hits.set(key, recent);
      trim();
      return allowed;
    },
    size: () => hits.size,
  };
}

export function registerRuntimeRoutes(app: FastifyInstance, deps: RuntimeRouteDeps): void {
  const { lookup, applications, store, catalog } = deps;
  const targets = deps.targets ?? emptyTargetStore;
  const resolver = deps.resolver ?? createRegistryResolver({ catalog, targets });
  const now = deps.now ?? Date.now;
  const limiter = createRateLimiter(deps.rateLimit ?? RUNTIME_RATE_LIMIT, now);
  const limits = deps.rateLimit ?? RUNTIME_RATE_LIMIT;

  const fail = (reply: FastifyReply, status: 403 | 404 | 429 | 503, message: string, kind: string, origin?: string): FastifyReply => {
    reply.header("vary", "Origin");
    if (origin !== undefined) reply.header("access-control-allow-origin", origin);
    if (status === 429) reply.header("retry-after", String(Math.ceil(limits.windowMs / 1000)));
    return reply.code(status).type("application/json; charset=utf-8").send({ kind, message });
  };
  const notFound = (reply: FastifyReply, origin?: string) => fail(reply, 404, RUNTIME_MESSAGES.notFound, "not_found", origin);
  const ok = (reply: FastifyReply, origin: string, body: unknown) => {
    reply.header("access-control-allow-origin", origin).header("vary", "Origin").header("cache-control", "no-store");
    return reply.code(200).type("application/json; charset=utf-8").send(body);
  };

  /** The application of a request, after the key, the rate limit and the Origin; or the reply that was sent. */
  async function authorise(request: FastifyRequest, reply: FastifyReply): Promise<{ readonly application: ApplicationRecord; readonly tenantId: string; readonly origin: string } | null> {
    const key = (request.params as { key?: unknown } | undefined)?.key;
    if (!isRuntimeKey(key)) { notFound(reply); return null; } // a malformed key never reaches the database or the limiter's map
    if (!limiter.allow(`${key}|${request.ip}`)) { fail(reply, 429, RUNTIME_MESSAGES.rateLimited, "rate_limited"); return null; }
    let found: Awaited<ReturnType<RuntimeLookup["find"]>>;
    try { found = await lookup.find(key); } catch { fail(reply, 503, RUNTIME_MESSAGES.unavailable, "unavailable"); return null; }
    if (found === null) { notFound(reply); return null; }
    let application: ApplicationRecord | null;
    try { application = await applications.get(found.tenantId, found.applicationId); } catch { fail(reply, 503, RUNTIME_MESSAGES.unavailable, "unavailable"); return null; }
    // Defence in depth: the lookup already required these, re-checked on the record the rest of the request uses.
    if (application === null || !application.enabled || !application.runtimeAccess || application.runtimeKey !== key || application.registryId !== "studio-managed") { notFound(reply); return null; }
    const origin = request.headers.origin;
    if (typeof origin !== "string" || !application.allowedOrigins.includes(origin)) { fail(reply, 403, RUNTIME_MESSAGES.forbidden, "forbidden"); return null; }
    return { application, tenantId: found.tenantId, origin };
  }

  /** The application's live guides: published heads of THIS application that still validate against its CURRENT registry. */
  async function liveGuides(tenantId: string, application: ApplicationRecord) {
    const resolved = await resolver.resolve(tenantId, application);
    if (resolved === undefined) return [];
    const guides: { readonly definition: Parameters<typeof buildGuideBundle>[0]["definition"]; readonly resolved: typeof resolved }[] = [];
    for (const row of await store.listPublished(tenantId)) {
      if (row.applicationId !== application.id) continue;
      const checked = validateAuthoredDefinition(row.id, row.definition, resolved.registry);
      if (checked.ok) guides.push({ definition: checked.definition, resolved });
    }
    return guides.slice(0, MAX_PUBLISHED_PER_TENANT);
  }

  app.get("/api/runtime/:key/guides", async (request, reply) => {
    const auth = await authorise(request, reply);
    if (auth === null) return reply;
    try {
      const guides = await liveGuides(auth.tenantId, auth.application);
      return ok(reply, auth.origin, { guides: guides.map(({ definition }) => ({ id: definition.id, title: definition.title, description: definition.description })) });
    } catch { return fail(reply, 503, RUNTIME_MESSAGES.unavailable, "unavailable", auth.origin); }
  });

  app.get("/api/runtime/:key/guides/:id", async (request, reply) => {
    const auth = await authorise(request, reply);
    if (auth === null) return reply;
    const id = (request.params as { id?: unknown } | undefined)?.id;
    if (typeof id !== "string" || !GUIDE_ID.test(id)) return notFound(reply, auth.origin);
    try {
      const guide = (await liveGuides(auth.tenantId, auth.application)).find((candidate) => candidate.definition.id === id);
      if (guide === undefined) return notFound(reply, auth.origin);
      return ok(reply, auth.origin, buildGuideBundle({ definition: guide.definition, application: auth.application, resolved: guide.resolved }));
    } catch { return fail(reply, 503, RUNTIME_MESSAGES.unavailable, "unavailable", auth.origin); }
  });

  /** The preflight: only for an allowed origin, only for GET, no request header beyond the CORS-safelisted ones. */
  const preflight = async (request: FastifyRequest, reply: FastifyReply) => {
    const auth = await authorise(request, reply);
    if (auth === null) return reply;
    const method = request.headers["access-control-request-method"];
    const asked = request.headers["access-control-request-headers"];
    const askedHeaders = typeof asked === "string" ? asked.split(",").map((name) => name.trim().toLowerCase()).filter((name) => name !== "") : [];
    if ((method !== undefined && method !== "GET") || askedHeaders.some((name) => !SAFE_REQUEST_HEADERS.has(name))) return fail(reply, 403, RUNTIME_MESSAGES.forbidden, "forbidden");
    reply.header("access-control-allow-origin", auth.origin).header("vary", "Origin").header("access-control-allow-methods", "GET").header("access-control-max-age", "600").header("cache-control", "no-store");
    return reply.code(204).send();
  };
  app.options("/api/runtime/:key/guides", preflight);
  app.options("/api/runtime/:key/guides/:id", preflight);
}
