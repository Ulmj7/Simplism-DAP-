/**
 * The maintainer routes of the Application Manager (Studio V1A, D2), registered on the EXISTING C01 Fastify instance next to the authoring routes (never a second server, so
 * every transport guard applies):
 *
 *   GET  /api/admin/applications              Maintainer   { applications: ApplicationView[], registries: { id, label }[] }   the tenant's applications and the selectable registries
 *   GET  /api/admin/applications/:id          Maintainer   ApplicationView   (another tenant's id or a malformed one is 404 APPLICATION_NOT_FOUND)
 *   POST /api/admin/applications              Maintainer   body EXACTLY { name, origin, allowedOrigins, environment, registryId }: validate (422), generate the id,
 *                                                          Gateway save, read back (201); the 21st application of a tenant is 409
 *   PUT  /api/admin/applications/:id          Maintainer   the same body: update the configuration (the enabled flag is untouched)
 *   POST /api/admin/applications/:id/status   Maintainer   body EXACTLY { enabled: boolean }: Gateway enable/disable
 *   GET  /api/admin/applications/:id/registry Maintainer   { routes, elements (public only), postconditionNames, previewable }: the application's public-eligible registry
 *
 * Authority and reply shapes are exactly those of `authoring/routes.ts`: the PRINCIPAL is resolved by the host (never a body or header the browser could forge for
 * authority), reads authorise on `perm.walkthrough.maintain`, writes pass the same check and THEN go through the Gateway (`principal.submit`: permission, risk, rate/replay,
 * durable audit, trusted executor, default deny via `DAP_ENABLED_ACTIONS`) and are read back (fire-then-read). Every reply is a closed `{ kind, message }` (+ a fixed `code`
 * for APPLICATION_NOT_FOUND); `issues` appear only on 422, capped at 20 of 200 characters, with fixed phrases that never repeat what the maintainer typed. No stack, SQL,
 * Zod text, permission id, Gateway stage or capability id ever leaves.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { AUTHORING_MESSAGES, submitGatewayWrite } from "../authoring/routes.js";
import type { AuthoringRouteDeps } from "../authoring/routes.js";
import { MAINTAIN_PERMISSION } from "../authoring/capabilities.js";
import { exactBody } from "../http/transport.js";
import { ENABLE_APPLICATION_ACTION_ID, SAVE_APPLICATION_ACTION_ID } from "./application-capabilities.js";
import type { ApplicationStore } from "./application-store.js";
import { MAX_APPLICATIONS_PER_TENANT, REGISTRY_SWITCH_PHRASE, STUDIO_MANAGED_REGISTRY_ID, capApplicationIssues, generateApplicationId, isApplicationId, registryIdsOf, registrySourceOf, toApplicationView, validateApplicationConfig } from "./applications.js";
import type { ApplicationRecord } from "./applications.js";
import { emptyTargetStore } from "./empty-target-store.js";
import { MAX_ROUTES_PER_APPLICATION, MAX_TARGETS_PER_APPLICATION, isTargetId, TARGET_STATUSES } from "./registry-targets.js";
import type { TargetStatus } from "./registry-targets.js";
import { createRegistryResolver } from "./registry-resolver.js";
import type { RegistryResolver } from "./registry-resolver.js";
import type { RegistryCatalog } from "./registries.js";
import { TARGET_STATUS_ACTION_ID } from "./target-capabilities.js";
import type { TargetStore } from "./target-store.js";

export interface ApplicationRouteDeps {
  readonly applications: ApplicationStore;
  readonly catalog: RegistryCatalog;
  /** The Studio-managed registries (Studio V1B). Without it a managed application reads as an empty registry. */
  readonly targets?: TargetStore;
  /** The registry resolver; built from `catalog` and `targets` when omitted. */
  readonly resolver?: RegistryResolver;
  /** The same host-resolved principal as the authoring routes. */
  readonly resolvePrincipal: AuthoringRouteDeps["resolvePrincipal"];
  /** Id source (default: `app-` + 12 hex from the OS random source). Injectable for tests. */
  readonly newId?: () => string;
}

export const APPLICATION_MESSAGES = Object.freeze({
  invalid: "That application has problems. Please fix them and try again.",
  notFound: "That application was not found.",
  targetNotFound: "That target was not found.",
  notManaged: "That application does not use a Studio-managed registry.",
  applicationDisabled: "That application is disabled. Enable it first.",
  limit: `The limit of ${MAX_APPLICATIONS_PER_TENANT} applications has been reached. Disable an application you no longer use; applications are never deleted.`,
});
type Fail = { kind: "unauthenticated" | "forbidden" | "not_found" | "malformed" | "conflict" | "unavailable"; message: string; code?: "APPLICATION_NOT_FOUND" | "TARGET_NOT_FOUND" | "REGISTRY_NOT_MANAGED" | "APPLICATION_DISABLED" };
const failure = (kind: Fail["kind"], message: string, code?: Fail["code"]): Fail => (code === undefined ? { kind, message } : { kind, message, code });

export function registerApplicationRoutes(app: FastifyInstance, deps: ApplicationRouteDeps): void {
  const { applications, catalog, resolvePrincipal } = deps;
  const targets = deps.targets ?? emptyTargetStore;
  const resolver = deps.resolver ?? createRegistryResolver({ catalog, targets });
  const knownRegistryIds = registryIdsOf(catalog);
  const newId = deps.newId ?? (() => generateApplicationId());
  type Principal = NonNullable<Awaited<ReturnType<AuthoringRouteDeps["resolvePrincipal"]>>>;

  const send = (reply: FastifyReply, status: number, body: unknown) => reply.code(status).type("application/json; charset=utf-8").send(body);
  const gate = async (request: FastifyRequest, reply: FastifyReply): Promise<Principal | null> => {
    let principal: Principal | null = null;
    try { principal = await resolvePrincipal(request.headers); } catch { principal = null; }
    if (principal === null) { send(reply, 401, failure("unauthenticated", AUTHORING_MESSAGES.noSession)); return null; }
    if (!principal.permissions.has(MAINTAIN_PERMISSION)) { send(reply, 403, failure("forbidden", AUTHORING_MESSAGES.forbidden)); return null; }
    return principal;
  };
  const unavailable = (reply: FastifyReply) => send(reply, 503, failure("unavailable", AUTHORING_MESSAGES.unavailable));
  const notFound = (reply: FastifyReply) => send(reply, 404, failure("not_found", APPLICATION_MESSAGES.notFound, "APPLICATION_NOT_FOUND"));
  const malformed = (reply: FastifyReply) => send(reply, 400, failure("malformed", AUTHORING_MESSAGES.malformed));
  const invalid = (reply: FastifyReply, issues: readonly string[]) => send(reply, 422, { kind: "invalid", message: APPLICATION_MESSAGES.invalid, issues: capApplicationIssues(issues) });
  const idParam = (request: FastifyRequest): string | null => {
    const id = (request.params as { id?: unknown } | undefined)?.id;
    return isApplicationId(id) ? id : null;
  };
  const view = (record: ApplicationRecord) => toApplicationView(record);
  /** The built-in catalog entries plus the Studio-managed one; every choice says where its registry lives. */
  const registryChoices = () => [...catalog.choices().map((choice) => ({ id: choice.id, label: choice.label, source: "built-in" as const })),
    { id: STUDIO_MANAGED_REGISTRY_ID, label: "Studio-managed (register targets from the browser)", source: "studio-managed" as const }];

  app.get("/api/admin/applications", async (request, reply) => {
    const principal = await gate(request, reply);
    if (principal === null) return;
    try { return send(reply, 200, { applications: (await applications.list(principal.tenantId)).map(view), registries: registryChoices() }); }
    catch { return unavailable(reply); }
  });

  app.get("/api/admin/applications/:id", async (request, reply) => {
    const principal = await gate(request, reply);
    if (principal === null) return;
    const id = idParam(request);
    if (id === null) return notFound(reply);
    try {
      const record = await applications.get(principal.tenantId, id);
      return record === null ? notFound(reply) : send(reply, 200, view(record));
    } catch { return unavailable(reply); }
  });

  app.get("/api/admin/applications/:id/registry", async (request, reply) => {
    const principal = await gate(request, reply);
    if (principal === null) return;
    const id = idParam(request);
    if (id === null) return notFound(reply);
    try {
      const record = await applications.get(principal.tenantId, id);
      if (record === null) return notFound(reply);
      const resolved = await resolver.resolve(principal.tenantId, record);
      if (resolved === undefined) return unavailable(reply);
      // The public-eligible registry: for a Studio-managed application the ACTIVE targets (all public by construction) and the routes registered so far.
      const elements = resolved.registry.elements.filter((element) => element.privacy === "public").map((element) => ({
        id: element.id, route: element.route, role: element.role, label: element.label, description: element.description, operations: [...element.operations], privacy: "public" as const }));
      return send(reply, 200, {
        routes: resolved.registry.routes, elements, postconditionNames: resolved.registry.postconditionNames, previewable: resolved.previewable,
        source: resolved.source, pages: resolved.pages, previewMode: resolved.previewMode,
      });
    } catch { return unavailable(reply); }
  });

  /** The 21st application: the limit is checked before the Gateway call for a clear 409 (the executor re-checks inside the transaction). */
  const atLimit = async (tenantId: string): Promise<boolean> => (await applications.list(tenantId)).length >= MAX_APPLICATIONS_PER_TENANT;

  app.post("/api/admin/applications", async (request, reply) => {
    const principal = await gate(request, reply);
    if (principal === null) return;
    const body = exactBody(request.body, ["name", "origin", "allowedOrigins", "environment", "registryId"]);
    if (body === null) return malformed(reply);
    const checked = validateApplicationConfig(body, knownRegistryIds);
    if (!checked.ok) return invalid(reply, checked.issues);
    try { if (await atLimit(principal.tenantId)) return send(reply, 409, failure("conflict", APPLICATION_MESSAGES.limit)); } catch { return unavailable(reply); }
    const id = newId();
    const result = await submitGatewayWrite(principal, SAVE_APPLICATION_ACTION_ID, { applicationId: id, ...checked.config });
    if (result === "refused") return send(reply, 403, failure("forbidden", AUTHORING_MESSAGES.refused));
    try {
      if (result === "failed" && await atLimit(principal.tenantId)) return send(reply, 409, failure("conflict", APPLICATION_MESSAGES.limit));
      if (result !== "ok") return unavailable(reply);
      const record = await applications.get(principal.tenantId, id);
      return record === null ? unavailable(reply) : send(reply, 201, view(record));
    } catch { return unavailable(reply); }
  });

  app.put("/api/admin/applications/:id", async (request, reply) => {
    const principal = await gate(request, reply);
    if (principal === null) return;
    const id = idParam(request);
    if (id === null) return notFound(reply);
    const body = exactBody(request.body, ["name", "origin", "allowedOrigins", "environment", "registryId"]);
    if (body === null) return malformed(reply);
    let existing: ApplicationRecord | null;
    try { existing = await applications.get(principal.tenantId, id); } catch { return unavailable(reply); }
    if (existing === null) return notFound(reply);
    const checked = validateApplicationConfig(body, knownRegistryIds);
    if (!checked.ok) return invalid(reply, checked.issues);
    // The registry source never changes: a built-in application cannot become Studio-managed or the other way round (the store and the database refuse it as well).
    if (registrySourceOf(existing.registryId) !== registrySourceOf(checked.config.registryId)) return invalid(reply, [REGISTRY_SWITCH_PHRASE]);
    const result = await submitGatewayWrite(principal, SAVE_APPLICATION_ACTION_ID, { applicationId: id, ...checked.config });
    if (result === "refused") return send(reply, 403, failure("forbidden", AUTHORING_MESSAGES.refused));
    if (result !== "ok") return unavailable(reply);
    try {
      const record = await applications.get(principal.tenantId, id);
      return record === null ? unavailable(reply) : send(reply, 200, view(record));
    } catch { return unavailable(reply); }
  });

  app.post("/api/admin/applications/:id/status", async (request, reply) => {
    const principal = await gate(request, reply);
    if (principal === null) return;
    const id = idParam(request);
    if (id === null) return notFound(reply);
    const body = exactBody(request.body, ["enabled"]);
    if (body === null || typeof body.enabled !== "boolean") return malformed(reply);
    try { if ((await applications.get(principal.tenantId, id)) === null) return notFound(reply); } catch { return unavailable(reply); }
    const result = await submitGatewayWrite(principal, ENABLE_APPLICATION_ACTION_ID, { applicationId: id, enabled: body.enabled });
    if (result === "refused") return send(reply, 403, failure("forbidden", AUTHORING_MESSAGES.refused));
    if (result !== "ok") return unavailable(reply);
    try {
      const record = await applications.get(principal.tenantId, id);
      return record === null ? unavailable(reply) : send(reply, 200, view(record));
    } catch { return unavailable(reply); }
  });

  // --- Studio-managed targets (Studio V1B): a read and a safety lever. There is NO route that creates a target: registration happens only in the browser session. -----------------------------
  const managed = async (principal: Principal, reply: FastifyReply, request: FastifyRequest): Promise<ApplicationRecord | null> => {
    const id = idParam(request);
    if (id === null) { notFound(reply); return null; }
    let record: ApplicationRecord | null;
    try { record = await applications.get(principal.tenantId, id); } catch { unavailable(reply); return null; }
    if (record === null) { notFound(reply); return null; }
    if (registrySourceOf(record.registryId) !== "studio-managed") { send(reply, 409, failure("conflict", APPLICATION_MESSAGES.notManaged, "REGISTRY_NOT_MANAGED")); return null; }
    return record;
  };

  app.get("/api/admin/applications/:id/targets", async (request, reply) => {
    const principal = await gate(request, reply);
    if (principal === null) return;
    const record = await managed(principal, reply, request);
    if (record === null) return;
    try {
      const listing = await targets.list(principal.tenantId, record.id);
      return send(reply, 200, { targets: listing.targets, routes: listing.routes, limits: { maxTargets: MAX_TARGETS_PER_APPLICATION, maxRoutes: MAX_ROUTES_PER_APPLICATION } });
    } catch { return unavailable(reply); }
  });

  app.post("/api/admin/applications/:id/targets/:targetId/status", async (request, reply) => {
    const principal = await gate(request, reply);
    if (principal === null) return;
    const targetId = (request.params as { targetId?: unknown } | undefined)?.targetId;
    const body = exactBody(request.body, ["status"]);
    if (body === null || typeof body.status !== "string" || !(TARGET_STATUSES as readonly string[]).includes(body.status)) return malformed(reply);
    const record = await managed(principal, reply, request);
    if (record === null) return;
    const wanted = body.status as TargetStatus;
    const targetNotFound = () => send(reply, 404, failure("not_found", APPLICATION_MESSAGES.targetNotFound, "TARGET_NOT_FOUND"));
    if (!isTargetId(targetId)) return targetNotFound();
    try {
      if ((await targets.get(principal.tenantId, record.id, targetId)) === null) return targetNotFound();
      // Disabling is always allowed (a safety lever); enabling needs the application enabled (the executor re-checks inside its transaction).
      if (wanted === "active" && !record.enabled) return send(reply, 409, failure("conflict", APPLICATION_MESSAGES.applicationDisabled, "APPLICATION_DISABLED"));
    } catch { return unavailable(reply); }
    const result = await submitGatewayWrite(principal, TARGET_STATUS_ACTION_ID, { applicationId: record.id, targetId, status: wanted });
    if (result === "refused") return send(reply, 403, failure("forbidden", AUTHORING_MESSAGES.refused));
    try {
      if (result === "failed") { // the executor refused: most likely the application was disabled in the meantime
        const now = await applications.get(principal.tenantId, record.id);
        if (wanted === "active" && now !== null && !now.enabled) return send(reply, 409, failure("conflict", APPLICATION_MESSAGES.applicationDisabled, "APPLICATION_DISABLED"));
      }
      if (result !== "ok") return unavailable(reply);
      const target = await targets.get(principal.tenantId, record.id, targetId);
      return target === null ? unavailable(reply) : send(reply, 200, target);
    } catch { return unavailable(reply); }
  });
}
