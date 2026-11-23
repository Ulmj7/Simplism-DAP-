/**
 * The authoring routes (Feature 004, T406), registered on the EXISTING C01 Fastify instance (`createGuidanceTransport`) before `listen`:
 *
 *   GET  /api/walkthroughs/published        any valid session   the tenant's published definitions, each re-validated against ITS application's registry (a guide without an
 *                                                                application is the built-in `reference` one), at most 50 (never a draft)
 *   POST /api/walkthrough-events           any valid session   idempotent client-reported usage for built-in and published guides (204)
 *   GET  /api/admin/analytics               Maintainer          aggregated client-reported usage
 *   GET  /api/admin/walkthroughs            Maintainer          { authored: [...], builtIn: [...] }  (built-in guides are a SEPARATE read-only array, never persisted)
 *   GET  /api/admin/walkthroughs/:id        Maintainer          { id, status, applicationId, definition }  (a built-in or unknown id is 404; `applicationId` is null for a legacy guide)
 *   POST /api/admin/walkthroughs            Maintainer          body EXACTLY { applicationId, definition }: application (404/409), validate against ITS registry (422), generate the id,
 *                                                                Gateway save, read back (201)
 *   PUT  /api/admin/walkthroughs/:id        Maintainer          body EXACTLY { applicationId, definition }: drafts only (409 for a published guide); the application is assigned once
 *                                                                (409 APPLICATION_MISMATCH for another one, 409 APPLICATION_DISABLED)
 *   POST /api/admin/walkthroughs/:id/status Maintainer          body EXACTLY { status }: publish pre-validates against the current registry (422)
 *
 * It inherits everything the transport already enforces (loopback Host guard, Sec-Fetch-Site guard, JSON-only content type, 64 KiB limit, no-store/nosniff and the
 * fixed error handler) because it adds routes to that instance and nothing else: no second server. There is no audit route or DELETE.
 * Usage is advisory, client-reported product telemetry. It does not use the Gateway and does not provide security audit evidence.
 *
 * Authority. The PRINCIPAL is resolved by the host from its own session configuration (`resolvePrincipal`), never from the body or a header the browser could forge
 * for authority: `{ key, tenantId, actor, permissions, submit }`. Reads authorise on `permissions.has("perm.walkthrough.maintain")`. Writes pass the same check and
 * THEN go through the Gateway (`principal.submit`: permission, risk, rate/replay, durable audit, trusted executor), so a missing permission is refused twice. Tenant and
 * actor are never read from a request.
 *
 * Writes are fire-then-read: the Gateway answers only `{ outcome, category }`, so after `ALLOWED/ok` the route reads the stored record back. Every reply is a closed shape
 * with a fixed message: no stack, SQL, Zod text, permission id, Gateway stage, capability id or token ever leaves; `issues` (validator wording with positional labels) are
 * returned only on 422, capped at 20 of 200 characters with control characters removed.
 */
import { randomUUID } from "node:crypto";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { AiSession } from "../compose.js";
import { exactBody } from "../http/transport.js";
import { DEMO_WALKTHROUGH_SUMMARIES } from "../guidance/walkthrough-summaries.js";
import { MAINTAIN_PERMISSION, SAVE_ACTION_ID, STATUS_ACTION_ID } from "./capabilities.js";
import type { ApplicationRecord } from "../studio/applications.js";
import { isApplicationId } from "../studio/applications.js";
import type { ApplicationStore } from "../studio/application-store.js";
import { REFERENCE_REGISTRY_ID, registryDataFor } from "../studio/registries.js";
import type { RegistryCatalog } from "../studio/registries.js";
import { generateWalkthroughId, isAuthoredId } from "./ids.js";
import { STATUSES } from "./schema.js";
import type { WalkthroughStatus } from "./schema.js";
import { MAX_PUBLISHED_PER_TENANT } from "./store.js";
import { USAGE_EVENTS } from "./store.js";
import { usageReport } from "./analytics.js";
import type { UsageEvent, WalkthroughStore } from "./store.js";
import type { TrustedRegistryData } from "./trusted-registry.js";
import { capIssues, validateAuthoredDefinition } from "./validate.js";

/** The host-resolved identity of one request. `submit` is the Gateway (a FRESH Gateway session per call, so each write is its own turn). */
export interface AuthoringPrincipal {
  readonly key: string;
  readonly tenantId: string;
  /** The safe actor id (what the audit trail will show). */
  readonly actor: string;
  readonly permissions: ReadonlySet<string>;
  submit: AiSession["submit"];
}
export type RequestHeaders = FastifyRequest["headers"];

export interface AuthoringRouteDeps {
  readonly store: WalkthroughStore;
  /** The tenant's enrolled applications (the source of every guide's registry and enabled state). */
  readonly applications: ApplicationStore;
  /** The host-trusted registry catalog (default: the built-in `reference` entry only). */
  readonly catalog: RegistryCatalog;
  /** The host's session for this request, or `null` (no valid session). Never derived from the request body. */
  readonly resolvePrincipal: (headers: RequestHeaders) => Promise<AuthoringPrincipal | null>;
  /** The built-in guides listed (read-only) for the admin list. Defaults to the host's three summaries. */
  readonly builtIn?: readonly { readonly id: string; readonly title: string; readonly description: string }[];
  /** TEST SEAM: replaces the registry data of the built-in `reference` entry only (a drifted registry through the REAL validator). Production code omits it. */
  readonly registryData?: TrustedRegistryData;
  /** Id source (default: `wt-` + 12 hex from the OS random source). Injectable for tests. */
  readonly newId?: () => string;
}

export const AUTHORING_MESSAGES = Object.freeze({
  noSession: "Authoring is not available right now.",
  forbidden: "You do not have access to that.",
  notFound: "Not found.",
  malformed: "That request could not be read. Please try again.",
  invalid: "That walkthrough has problems. Please fix them and try again.",
  published: "A published walkthrough cannot be edited. Unpublish it first.",
  limit: "The limit of published walkthroughs has been reached. Unpublish one first.",
  applicationNotFound: "That application was not found.",
  applicationDisabled: "That application is disabled. Enable it first.",
  applicationMismatch: "That walkthrough belongs to a different application.",
  refused: "That change was not allowed.",
  unavailable: "Authoring is temporarily unavailable. Please try again.",
  invalidEvent: "That walkthrough event could not be accepted.",
});
/** Everything a reply can be: a closed set of shapes. Application failures add a fixed `code`. */
export type ApplicationFailureCode = "APPLICATION_NOT_FOUND" | "APPLICATION_DISABLED" | "APPLICATION_MISMATCH";
type Fail = { kind: "unauthenticated" | "forbidden" | "not_found" | "malformed" | "conflict" | "unavailable"; message: string; code?: ApplicationFailureCode };

/** The Gateway's own payload limit is 16 KiB for the whole proposal (`maxPayloadBytes`); stay safely under it so the refusal is a clear 422, not an opaque denial. */
const MAX_PROPOSAL_BYTES = 15_000;
const failure = (kind: Fail["kind"], message: string, code?: ApplicationFailureCode): Fail => (code === undefined ? { kind, message } : { kind, message, code });

/** `ok` (ALLOWED/ok), `failed` (ALLOWED/try_later: the executor refused or failed), `refused` (anything the Gateway did not allow), `broken` (no usable answer). */
export type WriteResult = "ok" | "failed" | "refused" | "broken";
/** Fire a capability through the principal's Gateway session (a fresh session per call, so each write is its own turn) and classify the closed answer. */
export async function submitGatewayWrite(principal: AuthoringPrincipal, action: string, params: unknown): Promise<WriteResult> {
  let feedback: unknown;
  try { feedback = await principal.submit({ providerCallId: `authoring-${randomUUID()}`, arguments: JSON.stringify({ action, params }) }); } catch { return "broken"; }
  let outcome: unknown; let category: unknown;
  try { outcome = (feedback as { outcome?: unknown } | null)?.outcome; category = (feedback as { category?: unknown } | null)?.category; } catch { return "broken"; }
  if (outcome === "ALLOWED") return category === "ok" ? "ok" : category === "try_later" ? "failed" : "broken";
  return typeof outcome === "string" ? "refused" : "broken";
}

export function registerAuthoringRoutes(app: FastifyInstance, deps: AuthoringRouteDeps): void {
  const { store, resolvePrincipal, applications, catalog } = deps;
  const builtIn = Object.freeze((deps.builtIn ?? DEMO_WALKTHROUGH_SUMMARIES).map((summary) => Object.freeze({ id: summary.id, title: summary.title, description: summary.description })));
  const newId = deps.newId ?? (() => generateWalkthroughId());

  const send = (reply: FastifyReply, status: number, body: unknown) => reply.code(status).type("application/json; charset=utf-8").send(body);
  const principalOf = async (request: FastifyRequest): Promise<AuthoringPrincipal | null> => { try { return await resolvePrincipal(request.headers); } catch { return null; } };
  const isMaintainer = (principal: AuthoringPrincipal): boolean => principal.permissions.has(MAINTAIN_PERMISSION);
  /** Session, then (for admin routes) the maintainer permission. Returns the principal, or sends the refusal and returns `null`. */
  const gate = async (request: FastifyRequest, reply: FastifyReply, admin: boolean): Promise<AuthoringPrincipal | null> => {
    const principal = await principalOf(request);
    if (principal === null) { send(reply, 401, failure("unauthenticated", AUTHORING_MESSAGES.noSession)); return null; }
    if (admin && !isMaintainer(principal)) { send(reply, 403, failure("forbidden", AUTHORING_MESSAGES.forbidden)); return null; }
    return principal;
  };
  const unavailable = (reply: FastifyReply) => send(reply, 503, failure("unavailable", AUTHORING_MESSAGES.unavailable));
  const notFound = (reply: FastifyReply) => send(reply, 404, failure("not_found", AUTHORING_MESSAGES.notFound));
  const invalid = (reply: FastifyReply, issues: readonly string[]) => send(reply, 422, { kind: "invalid", message: AUTHORING_MESSAGES.invalid, issues: capIssues(issues) });
  const idParam = (request: FastifyRequest): string | null => {
    const id = (request.params as { id?: unknown } | undefined)?.id;
    return isAuthoredId(id) ? id : null; // a built-in id, the preview id and any junk are simply "not found"
  };
  const record = (row: { readonly id: string; readonly status: WalkthroughStatus; readonly applicationId: string | null; readonly definition: unknown }) =>
    ({ id: row.id, status: row.status, applicationId: row.applicationId, definition: row.definition });
  const submitWrite = submitGatewayWrite;
  const appNotFound = (reply: FastifyReply) => send(reply, 404, failure("not_found", AUTHORING_MESSAGES.applicationNotFound, "APPLICATION_NOT_FOUND"));
  const appDisabled = (reply: FastifyReply) => send(reply, 409, failure("conflict", AUTHORING_MESSAGES.applicationDisabled, "APPLICATION_DISABLED"));
  const appMismatch = (reply: FastifyReply) => send(reply, 409, failure("conflict", AUTHORING_MESSAGES.applicationMismatch, "APPLICATION_MISMATCH"));
  /** The registry data of an application (`null` = a guide written before Studio, which is the built-in reference one). `undefined`: the catalog has no such registry. */
  const registryOf = (application: ApplicationRecord | null) => registryDataFor(catalog, application === null ? REFERENCE_REGISTRY_ID : application.registryId, deps.registryData);

  const isDefinition = (definition: unknown): definition is Record<string, unknown> =>
    definition !== null && typeof definition === "object" && !Array.isArray(definition);
  const tooLarge = (id: string, applicationId: string, definition: unknown): boolean => Buffer.byteLength(JSON.stringify({ action: SAVE_ACTION_ID, params: { walkthroughId: id, applicationId, definition } })) > MAX_PROPOSAL_BYTES;

  // --- reads --------------------------------------------------------------------------------------------------------------------------------------
  app.get("/api/walkthroughs/published", async (request, reply) => {
    const principal = await gate(request, reply, false);
    if (principal === null) return;
    try {
      const rows = await store.listPublished(principal.tenantId);
      const byId = new Map((await applications.list(principal.tenantId)).map((application) => [application.id, application] as const));
      // Every stored definition is re-validated against ITS application's CURRENT registry data (a guide without an application is the built-in `reference` one); one that is no
      // longer valid, or whose application is unknown, is left out (the others still load). A disabled application does not hide its published guides.
      const walkthroughs = rows.map((row) => {
        const application = row.applicationId === null ? null : byId.get(row.applicationId);
        const registryData = application === undefined ? undefined : registryOf(application);
        return registryData === undefined ? { ok: false as const } : validateAuthoredDefinition(row.id, row.definition, registryData);
      }).flatMap((result) => (result.ok ? [result.definition] : [])).slice(0, MAX_PUBLISHED_PER_TENANT);
      return send(reply, 200, { walkthroughs });
    } catch { return unavailable(reply); }
  });

  app.get("/api/admin/walkthroughs", async (request, reply) => {
    const principal = await gate(request, reply, true);
    if (principal === null) return;
    try {
      const authored = (await store.list(principal.tenantId)).map((row) => ({ id: row.id, title: row.title, description: row.description, status: row.status, applicationId: row.applicationId, stepCount: row.stepCount, updatedAt: row.updatedAt }));
      return send(reply, 200, { authored, builtIn });
    } catch { return unavailable(reply); }
  });

  app.get("/api/admin/walkthroughs/:id", async (request, reply) => {
    const principal = await gate(request, reply, true);
    if (principal === null) return;
    const id = idParam(request);
    if (id === null) return notFound(reply);
    try {
      const row = await store.get(principal.tenantId, id);
      return row === null ? notFound(reply) : send(reply, 200, record(row));
    } catch { return unavailable(reply); }
  });

  app.get("/api/admin/analytics", async (request, reply) => {
    const principal = await gate(request, reply, true);
    if (principal === null) return;
    try { return send(reply, 200, usageReport(await store.summary(principal.tenantId), builtIn)); }
    catch { return unavailable(reply); }
  });

  app.post("/api/walkthrough-events", async (request, reply) => {
    const principal = await gate(request, reply, false);
    if (principal === null) return;
    const body = exactBody(request.body, ["walkthroughId", "runId", "event"]);
    const refused = () => send(reply, 400, failure("malformed", AUTHORING_MESSAGES.invalidEvent));
    if (body === null) return refused();
    const { walkthroughId, runId, event } = body;
    if (typeof walkthroughId !== "string" || typeof runId !== "string"
      || !/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/.test(runId)
      || !(USAGE_EVENTS as readonly unknown[]).includes(event)) return refused();
    try {
      if (walkthroughId === "wt-preview" || (!builtIn.some(guide => guide.id === walkthroughId) && !isAuthoredId(walkthroughId))) return refused();
      const accepted = await store.recordEvent(principal.tenantId, { walkthroughId, runId, event: event as UsageEvent["event"] });
      return accepted ? reply.code(204).send() : refused();
    } catch { return unavailable(reply); }
  });

  // --- writes -------------------------------------------------------------------------------------------------------------------------------------
  /**
   * The application a write names, resolved in the caller's OWN tenant. Sends the refusal (404 not found, 409 disabled, 503 no registry) and returns `null`, or returns the
   * record and the registry data to validate against. `requireEnabled` is false only for reads that must still work for a disabled application.
   */
  const resolveApplication = async (principal: AuthoringPrincipal, reply: FastifyReply, applicationId: unknown): Promise<{ readonly application: ApplicationRecord; readonly registryData: TrustedRegistryData } | null> => {
    if (!isApplicationId(applicationId)) { appNotFound(reply); return null; }
    let application: ApplicationRecord | null;
    try { application = await applications.get(principal.tenantId, applicationId); } catch { unavailable(reply); return null; }
    if (application === null) { appNotFound(reply); return null; }
    if (!application.enabled) { appDisabled(reply); return null; }
    const registryData = registryOf(application);
    if (registryData === undefined) { unavailable(reply); return null; }
    return { application, registryData };
  };

  app.post("/api/admin/walkthroughs", async (request, reply) => {
    const principal = await gate(request, reply, true);
    if (principal === null) return;
    const body = exactBody(request.body, ["applicationId", "definition"]);
    if (body === null) return send(reply, 400, failure("malformed", AUTHORING_MESSAGES.malformed));
    if (typeof body.applicationId !== "string" || !isDefinition(body.definition)) return send(reply, 400, failure("malformed", AUTHORING_MESSAGES.malformed));
    if (Object.hasOwn(body.definition, "id")) return invalid(reply, ["definition.id: omit the id when creating a draft"]);
    const resolved = await resolveApplication(principal, reply, body.applicationId);
    if (resolved === null) return;
    const id = newId();
    const candidate = { ...body.definition, id };
    const checked = validateAuthoredDefinition(id, candidate, resolved.registryData);
    if (!checked.ok) return invalid(reply, checked.issues);
    if (tooLarge(id, resolved.application.id, candidate)) return invalid(reply, ["definition: too large to save"]);
    const result = await submitWrite(principal, SAVE_ACTION_ID, { walkthroughId: id, applicationId: resolved.application.id, definition: candidate });
    if (result === "refused") return send(reply, 403, failure("forbidden", AUTHORING_MESSAGES.refused));
    if (result !== "ok") return unavailable(reply);
    try {
      const row = await store.get(principal.tenantId, id);
      return row === null ? unavailable(reply) : send(reply, 201, record(row));
    } catch { return unavailable(reply); }
  });

  app.put("/api/admin/walkthroughs/:id", async (request, reply) => {
    const principal = await gate(request, reply, true);
    if (principal === null) return;
    const id = idParam(request);
    if (id === null) return notFound(reply);
    const body = exactBody(request.body, ["applicationId", "definition"]);
    if (body === null) return send(reply, 400, failure("malformed", AUTHORING_MESSAGES.malformed));
    if (typeof body.applicationId !== "string" || !isDefinition(body.definition)) return send(reply, 400, failure("malformed", AUTHORING_MESSAGES.malformed));
    if (Object.hasOwn(body.definition, "id") && body.definition.id !== id) return invalid(reply, ["definition.id: must match the requested draft"]);
    const candidate = { ...body.definition, id };
    let existing;
    try { existing = await store.get(principal.tenantId, id); } catch { return unavailable(reply); }
    if (existing === null) return notFound(reply);
    if (existing.status !== "draft") return send(reply, 409, failure("conflict", AUTHORING_MESSAGES.published));
    // The application is assigned once: a bound draft accepts only its own application, a legacy draft takes the one named here.
    if (existing.applicationId !== null && existing.applicationId !== body.applicationId) return appMismatch(reply);
    const resolved = await resolveApplication(principal, reply, body.applicationId);
    if (resolved === null) return;
    const checked = validateAuthoredDefinition(id, candidate, resolved.registryData);
    if (!checked.ok) return invalid(reply, checked.issues);
    if (tooLarge(id, resolved.application.id, candidate)) return invalid(reply, ["definition: too large to save"]);
    const result = await submitWrite(principal, SAVE_ACTION_ID, { walkthroughId: id, applicationId: resolved.application.id, definition: candidate });
    if (result === "refused") return send(reply, 403, failure("forbidden", AUTHORING_MESSAGES.refused));
    try {
      if (result === "failed") { // the executor refused: most likely the guide was published (or bound to another application) in the meantime
        const now = await store.get(principal.tenantId, id);
        if (now !== null && now.status !== "draft") return send(reply, 409, failure("conflict", AUTHORING_MESSAGES.published));
        if (now !== null && now.applicationId !== null && now.applicationId !== resolved.application.id) return appMismatch(reply);
      }
      if (result !== "ok") return unavailable(reply);
      const row = await store.get(principal.tenantId, id);
      return row === null ? unavailable(reply) : send(reply, 200, record(row));
    } catch { return unavailable(reply); }
  });

  app.post("/api/admin/walkthroughs/:id/status", async (request, reply) => {
    const principal = await gate(request, reply, true);
    if (principal === null) return;
    const id = idParam(request);
    if (id === null) return notFound(reply);
    const body = exactBody(request.body, ["status"]);
    const status = body?.status;
    if (body === null || typeof status !== "string" || !(STATUSES as readonly string[]).includes(status)) return send(reply, 400, failure("malformed", AUTHORING_MESSAGES.malformed));
    const wanted = status as WalkthroughStatus;
    let existing;
    try { existing = await store.get(principal.tenantId, id); } catch { return unavailable(reply); }
    if (existing === null) return notFound(reply);
    if (wanted === "published" && existing.status !== "published") {
      // The guide's application: it must be enabled to publish (a guide written before Studio belongs to the built-in reference application and has no record to disable).
      let application: ApplicationRecord | null = null;
      if (existing.applicationId !== null) {
        try { application = await applications.get(principal.tenantId, existing.applicationId); } catch { return unavailable(reply); }
        if (application === null) return appNotFound(reply);
        if (!application.enabled) return appDisabled(reply);
      }
      const registryData = registryOf(application);
      if (registryData === undefined) return unavailable(reply);
      // Pre-validate the STORED definition against the application's CURRENT registry data: the clear 422 for a stale or invalid draft (the executor re-checks inside the transaction).
      const checked = validateAuthoredDefinition(id, existing.definition, registryData);
      if (!checked.ok) return invalid(reply, checked.issues);
      try {
        const published = await store.listPublished(principal.tenantId);
        if (published.length >= MAX_PUBLISHED_PER_TENANT) return send(reply, 409, failure("conflict", AUTHORING_MESSAGES.limit));
      } catch { return unavailable(reply); }
    }
    const result = await submitWrite(principal, STATUS_ACTION_ID, { walkthroughId: id, status: wanted });
    if (result === "refused") return send(reply, 403, failure("forbidden", AUTHORING_MESSAGES.refused));
    if (result !== "ok") return unavailable(reply);
    try {
      const row = await store.get(principal.tenantId, id);
      return row === null ? unavailable(reply) : send(reply, 200, record(row));
    } catch { return unavailable(reply); }
  });
}
