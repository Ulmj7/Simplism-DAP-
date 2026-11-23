/**
 * The Studio browser session API (Studio V1A D5-D7, Studio V1B D4-D8, D13): `POST /api/studio/browser`, maintainer-only, on the existing transport instance.
 *
 * A session is bound to ONE enrolled application, loaded ONLY through the application store scoped to the principal's tenant, never from the request. Two registry sources:
 *
 *   built-in        exposure policy = the catalog entry's approved labels, navigation policy = its pages + the application's allowed origins (V1A, byte for byte); the inspector
 *                   classifies each approved control `trusted` | `unregistered`.
 *   studio-managed  exposure policy `labels: "all"`, navigation policy `routes: "any"` + the application's allowed origins; the HOST forwards only controls that carry a valid
 *                   `data-ai-id` marker and pass the privacy gate (`managed-inspector.ts`): `trusted` | `registrable` | `disabled`, everything else only counted in `hidden`.
 *
 * Commands (exact-key bodies, see `browser-commands.ts`):
 *   connect    { action, applicationId, walkthroughId? }                         -> { sessionId, applicationId, application, origin, registrySource }
 *   resume     { action, applicationId }                                         -> the same + resumed:true (adopts the owner's running session under a NEW id)
 *   refresh    { action, sessionId, applicationId }                              -> { url, route, page, elements, hidden, truncated }
 *   highlight  { action, sessionId, applicationId, ref }                         -> { highlighted: true, ref }   (trusted, registrable or mismatched; re-verifies; persists NOTHING)
 *   capture    { action, sessionId, applicationId, ref }                         -> { targetId, route, name, role, operations }   (the UI's "Use": trusted only)
 *   register   { action, sessionId, applicationId, ref, targetId, route, operations, label, description, privacy } -> { target, route: { route, page, created } }
 *   check      { action, sessionId, applicationId }                              -> { page, route, results: [{ targetId, state: healthy|broken|unverified, reason?: not_found|role_changed|private|ambiguous }] }
 *   repair     { action, sessionId, applicationId, targetId, ref, operations, label, description, confirm } -> confirm false: { target, current, proposed, impact }; true: { target, impact }
 *   disconnect { action, sessionId, applicationId? }                             -> { closed: true }
 *
 * Error codes (`{ error: CODE }`, never an echo of what was sent): INVALID_REQUEST 400; FORBIDDEN 403; SESSION_CLOSED 404 (also: not the owner); APPLICATION_NOT_FOUND 404; BROWSER_BUSY, APPLICATION_DISABLED,
 * APPLICATION_MISMATCH, REGISTRY_NOT_MANAGED, REF_NOT_FOUND, TARGET_UNAVAILABLE, TARGET_NOT_REGISTRABLE, TARGET_ID_MISMATCH, TARGET_EXISTS, ROUTE_MISMATCH, REGISTRY_FULL 409; and for a repair
 * TARGET_NOT_FOUND, REPAIR_ROUTE_MISMATCH (the control is on another page than the target's), MARKER_IN_USE (the marker belongs to another target), REPAIR_UNCHANGED 409, and
 * REPAIR_INCOMPATIBLE 409 { error, problems: <= 20 fixed phrases }; INVALID_TARGET 422 { error, issues }; BROWSER_UNAVAILABLE 503 (+ the adapter's fixed codes).
 *
 * REGISTRATION TRUST CHAIN (the ONLY way a target is created; there is no route that accepts a raw target): the application is re-loaded (enabled, Studio-managed, same tenant); the ref must be
 * one of the LAST refresh's candidates and `registrable`; a FRESH observation re-reads the live marker and privacy facts (drift is REF_NOT_FOUND, never a fuzzy match); the body's `targetId`
 * must equal the live marker; role and page are derived from the live element and URL, never from the body; the maintainer's fields are validated by the same validator the executor uses; and only
 * then the Gateway capability `registerStudioTarget` persists it with server-built parameters. The element ref (`@eN`) never reaches the capability, the store or a log.
 *
 * REPAIR TRUST CHAIN (the only way a target's marker, role, operations or texts change): the same chain as a registration, with the ref's candidate `registrable` (a new marker) or `mismatched`
 * (the target's own marker on another role or route), a control on the target's own PAGE, a marker no other target owns, and every workflow that names the target validating, with the one Feature 002
 * validator, against the registry as it would be after the repair. `check` verifies the active targets of the current page against a fresh observation and persists the verdicts that changed.
 *
 * Invariants kept from V1A (and re-tested): ONE session per host owned by [principal key, tenant, actor]; one command in flight (BROWSER_BUSY); the session closes on disconnect, after five idle
 * minutes OF THE OWNER'S OWN activity, on host shutdown (`onClose`) and when connecting fails; every command re-loads the application and re-resolves its registry (nothing is cached for the session,
 * because targets can change while it is open); a disabled, removed or re-pointed application closes the session; no raw error text, CLI output, URL or application origin leaves in an error.
 */
import { randomUUID } from "node:crypto";
import { BrowserRuntimeError, createAgentBrowserAdapter } from "@dap/browser-runtime";
import type { AgentBrowserAdapterOptions, BrowserRuntime, BrowserSnapshot, ElementFacts, ElementRef } from "@dap/browser-runtime";
import type { FastifyInstance } from "fastify";
import { submitGatewayWrite } from "../authoring/routes.js";
import type { AuthoringRouteDeps } from "../authoring/routes.js";
import type { WalkthroughStore } from "../authoring/store.js";
import type { ApplicationStore } from "./application-store.js";
import type { ApplicationRecord, RegistrySource } from "./applications.js";
import { registrySourceOf } from "./applications.js";
import { parseStudioCommand } from "./browser-commands.js";
import type { StudioCommand } from "./browser-commands.js";
import { emptyTargetStore } from "./empty-target-store.js";
import { MAX_URL_CHARS, classifyCandidates, routeOfUrl } from "./inspector.js";
import type { Candidate } from "./inspector.js";
import { classifyControl, classifyManaged, pageOfUrl, routeOfPage, selectFactRefs } from "./managed-inspector.js";
import type { ManagedCandidate, ManagedRegistryView } from "./managed-inspector.js";
import type { RegistryCatalog } from "./registries.js";
import { MAX_ROUTES_PER_APPLICATION, MAX_TARGETS_PER_APPLICATION, snapshotRoleToTargetRole, validateTargetRegistration, validateTargetRepair } from "./registry-targets.js";
import { createRegistryResolver } from "./registry-resolver.js";
import type { RegistryResolver } from "./registry-resolver.js";
import { REGISTER_TARGET_ACTION_ID, REPAIR_TARGET_ACTION_ID, TARGET_HEALTH_ACTION_ID, withRegistrationReceipt, withRepairReceipt } from "./target-capabilities.js";
import { evaluateHealth } from "./target-health.js";
import { impactOf, registryAfterRepair, verifyRepair } from "./repair-impact.js";
import type { RepairFields, TargetStore } from "./target-store.js";

const idleMs = 5 * 60_000;
const busyRecheckMs = 1_000;
const MAINTAIN = "perm.walkthrough.maintain";

/** The policy a runtime is created with: derived from the application, never from a request. */
export type BrowserRuntimeConfig = Pick<AgentBrowserAdapterOptions, "labels" | "routes" | "origins" | "routing">;

type AnyCandidate = Candidate | ManagedCandidate;

interface Session {
  /** Replaced by `resume`: the old id stops working. */
  id: string;
  readonly owner: string;
  readonly tenantId: string;
  readonly applicationId: string;
  readonly application: { readonly name: string; readonly origin: string };
  readonly source: RegistrySource;
  /** How the application's pages are addressed; fixed for the life of the session (a change closes it, see `policy`). */
  readonly routing: "hash" | "history";
  /** What the live adapter was configured with: a later change to it closes the session (the adapter's policy would be stale). */
  readonly policy: string;
  readonly runtime: BrowserRuntime;
  /** The last refresh. Replaced wholesale by every refresh; dropped with the session. */
  snapshot?: BrowserSnapshot;
  candidates: ReadonlyMap<string, AnyCandidate>;
}

interface Options {
  readonly resolvePrincipal: AuthoringRouteDeps["resolvePrincipal"];
  /** The tenant's enrolled applications (the ONLY source of a session's origins, registry and enabled state). */
  readonly applications: ApplicationStore;
  /** The host-trusted registry catalog: `application.registryId` -> labels, pages and the trusted registry (built-in applications). */
  readonly catalog: RegistryCatalog;
  /** Read-only access to stored walkthroughs, for the optional `walkthroughId` binding check at connect (tenant-scoped). */
  readonly authoring: Pick<WalkthroughStore, "get">;
  /** The Studio-managed registries (routes and targets in PostgreSQL). Without it a managed application has an empty registry and nothing can be registered. */
  readonly targets?: TargetStore;
  /** The registry resolver; built from `catalog` and `targets` when omitted. */
  readonly resolver?: RegistryResolver;
  readonly createRuntime?: (config: BrowserRuntimeConfig) => BrowserRuntime;
  readonly makeId?: () => string;
}

/** `origin + pathname` of a URL (no query, no fragment), bounded; an unparsable URL is reported as the empty string. */
function withoutQueryAndFragment(url: string): string {
  try { const parsed = new URL(url); return `${parsed.origin}${parsed.pathname}`.slice(0, MAX_URL_CHARS); } catch { return ""; }
}

/** The fields of an application that shape the adapter's policy. A rename does not; an origin, allowed-origin or registry change does. */
const policyOf = (application: ApplicationRecord): string => JSON.stringify([application.origin, application.allowedOrigins, application.registryId, application.routing]);

export function registerStudioBrowser(app: FastifyInstance, { resolvePrincipal, applications, catalog, authoring, createRuntime = (config) => createAgentBrowserAdapter(config), makeId = randomUUID, ...rest }: Options): void {
  const targets = rest.targets ?? emptyTargetStore;
  const resolver = rest.resolver ?? createRegistryResolver({ catalog, targets });
  let current: Session | undefined;
  let busy = false;
  let timer: NodeJS.Timeout | undefined;
  async function close() {
    if (!current) return;
    await current.runtime.close();
    current = undefined;
    clearTimeout(timer);
  }
  /**
   * (Re)starts the idle clock. It is called ONLY for the OWNER's own successful activity (a connect or resume that opened/adopted the session, or a command whose owner, session id and application
   * matched), never for a rejected connect or resume (BROWSER_BUSY), a command carrying somebody else's session id, an unauthorized or malformed request: otherwise anyone probing a forgotten
   * session (or the owner clicking Connect after a page reload) would keep it open for ever. If a command is in flight when the clock runs out, it checks again shortly.
   */
  function refreshExpiry(delay = idleMs) {
    clearTimeout(timer);
    if (!current) return;
    timer = setTimeout(() => {
      if (busy) { refreshExpiry(busyRecheckMs); return; }
      busy = true;
      void close().catch(() => refreshExpiry()).finally(() => { busy = false; });
    }, delay);
    timer.unref();
  }
  app.addHook("onClose", async () => { clearTimeout(timer); await close().catch(() => {}); });

  app.post("/api/studio/browser", async (request, reply) => {
    const deny = (status: number, error: string, extra?: object) => reply.code(status).send({ error, ...extra });
    const principal = await resolvePrincipal(request.headers).catch(() => null);
    if (!principal) return deny(401, "SESSION_CLOSED");
    if (!principal.permissions.has(MAINTAIN)) return deny(403, "FORBIDDEN");
    const owner = JSON.stringify([principal.key, principal.tenantId, principal.actor]);
    const command: StudioCommand | null = parseStudioCommand(request.body);
    if (command === null) return deny(400, "INVALID_REQUEST");
    if (busy) return deny(409, "BROWSER_BUSY");
    busy = true;
    let ownerActivity = false; // true once this request is the OWNER's own bound activity: only then does the idle clock restart
    try {
      if (command.action === "connect") return await connect(command, principal.tenantId, owner, deny, () => { ownerActivity = true; });

      if (command.action === "resume") {
        // The browser a reloaded page lost: adopted ONLY by the same owner for the same application; anyone else is BROWSER_BUSY (never revealing whose session it is).
        if (!current) return deny(404, "SESSION_CLOSED");
        if (current.owner !== owner || current.applicationId !== command.applicationId) return deny(409, "BROWSER_BUSY");
        const failure = await reload(current, principal.tenantId, deny);
        if (failure !== undefined) return failure.reply;
        ownerActivity = true;
        current.id = makeId();
        return { sessionId: current.id, applicationId: current.applicationId, application: current.application.name, origin: current.application.origin, registrySource: current.source, resumed: true };
      }

      if (!current || current.owner !== owner || command.sessionId !== current.id) return deny(404, "SESSION_CLOSED");
      const session = current;
      if (command.applicationId !== undefined && command.applicationId !== session.applicationId) return deny(409, "APPLICATION_MISMATCH");
      ownerActivity = true;
      if (command.action === "disconnect") { await close(); return { closed: true }; }

      // Every other command re-loads the application: a session never outlives its enrolment (fail closed).
      const reloaded = await reload(session, principal.tenantId, deny);
      if (reloaded !== undefined) return reloaded.reply;
      const record = (await applications.get(principal.tenantId, session.applicationId))!;

      if (command.action === "refresh") return await (session.source === "studio-managed" ? refreshManaged(session, principal.tenantId) : refreshBuiltIn(session, record, principal.tenantId));

      if (command.action === "register") return await register(command, session, record, principal, deny);
      if (command.action === "check") return await check(session, principal, deny);
      if (command.action === "repair") return await repair(command, session, principal, deny);

      // highlight and capture: the ref must be one of the LAST refresh's candidates; trusted (both) or registrable (highlight only).
      const snapshot = session.snapshot;
      const candidate = session.candidates.get(command.ref);
      if (!snapshot || !candidate) return deny(409, "REF_NOT_FOUND");
      // The MARKER the page must still carry: a trusted or mismatched control's is the target's current marker (the DAP id never changes, the marker does after a repair), a registrable one's is its own.
      const registry = session.source === "studio-managed" ? await registryView(principal.tenantId, session.applicationId) : undefined;
      const markerOf = (targetId: string): string | null => (registry === undefined ? targetId : (registry.targets.find((item) => item.id === targetId)?.marker ?? null));
      let expectedMarker: string | null = null;
      if (candidate.status === "trusted") expectedMarker = markerOf(candidate.targetId);
      else if (command.action === "highlight" && candidate.status === "registrable") expectedMarker = candidate.proposal.targetId;
      else if (command.action === "highlight" && candidate.status === "mismatched") expectedMarker = markerOf(candidate.targetId);
      if (expectedMarker === null) return deny(409, "TARGET_UNAVAILABLE");
      // The adapter checks the observation is still current before reading the marker and facts.
      const ref = candidate.ref;
      const id = await session.runtime.inspectSemanticId(ref, snapshot);
      if (id !== expectedMarker) return deny(409, "TARGET_UNAVAILABLE");
      let currentCandidate = candidate;
      let captureRole = candidate.role;
      if (registry !== undefined) {
        const element = snapshot.elements.find((item) => item.ref === ref);
        if (!element) return deny(409, "REF_NOT_FOUND");
        const facts = await session.runtime.inspectElementFacts([ref], snapshot);
        const live = classifyControl({ routing: session.routing, snapshot, ids: new Map([[ref, id]]), facts, registry }, element);
        if (live === null || live.status !== candidate.status) return deny(409, "TARGET_UNAVAILABLE");
        currentCandidate = live;
        if (live.status === "trusted") {
          const target = registry.targets.find((item) => item.id === live.targetId);
          if (!target) return deny(409, "TARGET_UNAVAILABLE");
          captureRole = target.role;
        }
      }
      await session.runtime.highlight(ref, snapshot);
      if (command.action === "highlight") return { highlighted: true, ref };
      if (currentCandidate.status !== "trusted") return deny(409, "TARGET_UNAVAILABLE");
      return { targetId: currentCandidate.targetId, route: currentCandidate.route, name: currentCandidate.name, role: captureRole, operations: currentCandidate.operations };
    } catch (error) {
      if (error instanceof BrowserRuntimeError) {
        // A stale element is always a conflict the UI recovers from by refreshing; a closed session is cleared here; everything else keeps the session open (the user can navigate back).
        if (error.code === "REF_NOT_FOUND") return deny(409, "REF_NOT_FOUND");
        if (error.code === "BROWSER_BUSY") return deny(409, "BROWSER_BUSY");
        if (error.code === "SESSION_CLOSED") { await close().catch(() => {}); current = undefined; return deny(404, "SESSION_CLOSED"); }
        return deny(503, error.code);
      }
      return deny(503, "BROWSER_UNAVAILABLE");
    } finally { busy = false; if (ownerActivity) refreshExpiry(); }
  });

  type Deny = (status: number, error: string, extra?: object) => unknown;

  /** Re-loads the application of a live session. `undefined` = fine; otherwise the refusal (and the session was closed when the application is gone, disabled or its policy changed). */
  async function reload(session: Session, tenantId: string, deny: Deny): Promise<{ reply: unknown } | undefined> {
    let record: ApplicationRecord | null;
    try { record = await applications.get(tenantId, session.applicationId); }
    catch { return { reply: deny(503, "BROWSER_UNAVAILABLE") }; }
    if (record === null) { await close().catch(() => {}); return { reply: deny(404, "APPLICATION_NOT_FOUND") }; }
    if (!record.enabled) { await close().catch(() => {}); return { reply: deny(409, "APPLICATION_DISABLED") }; }
    if (policyOf(record) !== session.policy) { await close().catch(() => {}); return { reply: deny(409, "APPLICATION_MISMATCH") }; }
    return undefined;
  }

  async function refreshBuiltIn(session: Session, record: ApplicationRecord, tenantId: string) {
    const resolved = await resolver.resolve(tenantId, record);
    if (resolved === undefined) throw new BrowserRuntimeError("BROWSER_NOT_STARTED"); // mapped to a fixed 503 below; the registry of the application cannot be found
    delete session.snapshot;
    session.candidates = new Map();
    const snapshot = await session.runtime.snapshot();
    const route = routeOfUrl(snapshot.url, resolved.pages);
    const candidates = classifyCandidates(snapshot, await session.runtime.inspectSemanticIds(snapshot), route, resolved.registry);
    session.snapshot = snapshot;
    session.candidates = new Map(candidates.map((candidate) => [candidate.ref, candidate]));
    return { url: snapshot.url.slice(0, MAX_URL_CHARS), route, page: pageOfUrl(snapshot.url), elements: candidates, hidden: 0, truncated: false };
  }

  /** The registry as the managed inspector sees it: ALL routes and ALL targets, read fresh. */
  async function registryView(tenantId: string, applicationId: string): Promise<ManagedRegistryView> {
    const listing = await targets.list(tenantId, applicationId);
    return { routes: listing.routes, targets: listing.targets };
  }

  /** One fresh observation of the page for a managed session: the registry, the snapshot, the markers, the privacy facts of the controls that could be listed, and the classification. It becomes the session's last refresh. */
  async function observeManaged(session: Session, tenantId: string) {
    const registry = await registryView(tenantId, session.applicationId);
    delete session.snapshot;
    session.candidates = new Map();
    const snapshot = await session.runtime.snapshot();
    const ids = await session.runtime.inspectSemanticIds(snapshot);
    const refs = selectFactRefs(snapshot, ids);
    const facts: ReadonlyMap<ElementRef, ElementFacts | null> = refs.length === 0 ? new Map() : await session.runtime.inspectElementFacts(refs, snapshot);
    const inspection = classifyManaged({ routing: session.routing, snapshot, ids, facts, registry });
    session.snapshot = snapshot;
    session.candidates = new Map(inspection.elements.map((candidate) => [candidate.ref, candidate]));
    return { registry, snapshot, ids, facts, inspection };
  }

  async function refreshManaged(session: Session, tenantId: string) {
    const { registry, snapshot, inspection } = await observeManaged(session, tenantId);
    const page = pageOfUrl(snapshot.url, session.routing);
    // A history application's query string and fragment are never stored or returned (they may carry tokens or ids): its URL is reported without them.
    const url = session.routing === "history" ? withoutQueryAndFragment(snapshot.url) : snapshot.url.slice(0, MAX_URL_CHARS);
    return { url, route: routeOfPage(page, registry.routes), page, elements: inspection.elements, hidden: inspection.hidden, truncated: inspection.truncated };
  }

  /**
   * `check`: verifies every ACTIVE target of the current page against a FRESH observation (marker present exactly once, the mapped role, public by facts and name) and persists the verdicts that
   * changed through the Gateway (`healthy` is only ever written here and by a repair). The reply names registered targets only, never a hidden control. It is also a refresh: the session's refs are
   * those of this observation.
   */
  async function check(session: Session, principal: Principal, deny: Deny) {
    if (session.source !== "studio-managed") return deny(409, "REGISTRY_NOT_MANAGED");
    const { registry, snapshot, ids, facts } = await observeManaged(session, principal.tenantId);
    const report = evaluateHealth({ routing: session.routing, snapshot, ids, facts, registry });
    for (const result of report.results) {
      if (result.state === "unverified") continue;
      const stored = registry.targets.find((target) => target.id === result.targetId);
      if (stored === undefined || stored.health === result.state) continue;
      const written = await submitGatewayWrite(principal, TARGET_HEALTH_ACTION_ID, { applicationId: session.applicationId, targetId: result.targetId, health: result.state });
      if (written === "refused") return deny(403, "FORBIDDEN");
      if (written !== "ok") return deny(503, "BROWSER_UNAVAILABLE");
    }
    return { page: report.page, route: report.route, results: report.results };
  }

  type Principal = NonNullable<Awaited<ReturnType<AuthoringRouteDeps["resolvePrincipal"]>>>;

  /**
   * `repair`: re-binds a registered target to a live control. The trust chain is the registration's: the owner's session, a ref of the LAST refresh whose candidate is `registrable` (a new marker) or
   * `mismatched` (the target's own marker on another role or route), a FRESH observation (marker and privacy facts re-read, ambiguity re-checked, the classification re-run against the fresh registry),
   * the target's PAGE (route identity never changes), a marker that no other target owns, the maintainer's fields judged by the shared validator against the LIVE role. `confirm: false` is a dry run that
   * writes nothing; `confirm: true` applies iff every workflow naming the target still validates against the registry as it would be after the repair (re-checked inside the transaction).
   */
  async function repair(command: Extract<StudioCommand, { action: "repair" }>, session: Session, principal: Principal, deny: Deny) {
    if (session.source !== "studio-managed") return deny(409, "REGISTRY_NOT_MANAGED");
    const snapshot = session.snapshot;
    const candidate = session.candidates.get(command.ref);
    if (!snapshot || !candidate) return deny(409, "REF_NOT_FOUND");
    if (candidate.status !== "registrable" && candidate.status !== "mismatched") return deny(409, "TARGET_NOT_REGISTRABLE");
    const element = snapshot.elements.find((item) => item.ref === command.ref);
    if (!element) return deny(409, "REF_NOT_FOUND");
    const registry = await registryView(principal.tenantId, session.applicationId);
    const target = registry.targets.find((item) => item.id === command.targetId);
    if (target === undefined) return deny(409, "TARGET_NOT_FOUND");
    // A FRESH observation: the live marker, the live facts and the ids of the whole inspected set (ambiguity), classified against the fresh registry.
    const ref = command.ref as ElementRef;
    const liveMarker = await session.runtime.inspectSemanticId(ref, snapshot);
    if (liveMarker === null) return deny(409, "TARGET_NOT_REGISTRABLE");
    const liveFacts = (await session.runtime.inspectElementFacts([ref], snapshot)).get(ref) ?? null;
    const liveIds = new Map(await session.runtime.inspectSemanticIds(snapshot));
    liveIds.set(ref, liveMarker);
    const live = classifyControl({ routing: session.routing, snapshot, ids: liveIds, facts: new Map([[ref, liveFacts]]), registry }, element);
    if (live === null || (live.status !== "registrable" && live.status !== "mismatched")) return deny(409, "TARGET_NOT_REGISTRABLE");
    // A control that carries ANOTHER target's marker is not this target's replacement.
    if (live.status === "mismatched" && live.targetId !== target.id) return deny(409, "MARKER_IN_USE");
    // Route identity never changes: the control must be on the page the target is registered for.
    const livePage = pageOfUrl(snapshot.url, session.routing);
    if (livePage === null || livePage !== target.page) return deny(409, "REPAIR_ROUTE_MISMATCH");
    const role = snapshotRoleToTargetRole(element.role);
    const checked = validateTargetRepair({ marker: liveMarker, elementRole: role, operations: command.operations, label: command.label, description: command.description });
    if (!checked.ok) return deny(422, "INVALID_TARGET", { issues: checked.issues });
    const value = checked.value;
    const current: RepairFields = { marker: target.marker, role: target.role, operations: [...target.operations], label: target.label, description: target.description };
    const proposed: RepairFields = { marker: value.marker, role: value.role, operations: [...value.operations], label: value.label, description: value.description };
    // The impact: every workflow that names the target (drafts and published content), validated against the registry as it would be AFTER the repair.
    const definitions = await targets.definitionsUsing(principal.tenantId, session.applicationId, target.id);
    const after = registryAfterRepair(await targets.registry(principal.tenantId, session.applicationId), target.id, proposed);
    const problems = verifyRepair(definitions, after, target);
    const impact = { ...impactOf(definitions), compatible: problems.length === 0, problems };
    if (!command.confirm) return { target, current, proposed, impact };
    if (JSON.stringify(current) === JSON.stringify(proposed)) return deny(409, "REPAIR_UNCHANGED");
    if (!impact.compatible) return deny(409, "REPAIR_INCOMPATIBLE", { problems });
    const { result, repaired, problems: refused } = await withRepairReceipt({ tenantId: principal.tenantId, applicationId: session.applicationId, targetId: target.id }, () => submitGatewayWrite(principal, REPAIR_TARGET_ACTION_ID, {
      applicationId: session.applicationId, targetId: target.id, marker: value.marker, elementRole: value.role, operations: [...value.operations], label: value.label, description: value.description,
    }));
    if (result === "refused") return deny(403, "FORBIDDEN");
    if (result === "failed") return await diagnoseRepair(principal.tenantId, session, target.id, value.marker, refused, deny);
    if (result !== "ok") return deny(503, "BROWSER_UNAVAILABLE");
    const stored = repaired?.target ?? await targets.get(principal.tenantId, session.applicationId, target.id);
    if (stored === null || stored === undefined) return deny(503, "BROWSER_UNAVAILABLE");
    // The control is the target's trusted control from now on.
    session.candidates = new Map([...session.candidates].map(([key, item]) => [key, key === command.ref
      ? { ref: item.ref, name: item.name, role: item.role, route: stored.route, status: "trusted" as const, targetId: stored.id, operations: stored.operations, privacy: "public" as const } : item]));
    return { target: stored, impact: { ...(repaired?.impact ?? impactOf(definitions)), compatible: true, problems: [] } };
  }

  /** Why the repair executor refused, from the state as it is NOW (never from the executor's text). */
  async function diagnoseRepair(tenantId: string, session: Session, targetId: string, marker: string, refused: readonly string[] | undefined, deny: Deny) {
    if (refused !== undefined && refused.length > 0) return deny(409, "REPAIR_INCOMPATIBLE", { problems: refused });
    let record: ApplicationRecord | null;
    let registry: ManagedRegistryView;
    try { record = await applications.get(tenantId, session.applicationId); registry = await registryView(tenantId, session.applicationId); }
    catch { return deny(503, "BROWSER_UNAVAILABLE"); }
    if (record === null) { await close().catch(() => {}); return deny(404, "APPLICATION_NOT_FOUND"); }
    if (!record.enabled) { await close().catch(() => {}); return deny(409, "APPLICATION_DISABLED"); }
    if (!registry.targets.some((target) => target.id === targetId)) return deny(409, "TARGET_NOT_FOUND");
    if (registry.targets.some((target) => target.id !== targetId && (target.id === marker || target.marker === marker))) return deny(409, "MARKER_IN_USE");
    return deny(503, "BROWSER_UNAVAILABLE");
  }

  async function register(command: Extract<StudioCommand, { action: "register" }>, session: Session, record: ApplicationRecord, principal: NonNullable<Awaited<ReturnType<AuthoringRouteDeps["resolvePrincipal"]>>>, deny: Deny) {
    if (session.source !== "studio-managed") return deny(409, "REGISTRY_NOT_MANAGED");
    const snapshot = session.snapshot;
    const candidate = session.candidates.get(command.ref);
    if (!snapshot || !candidate) return deny(409, "REF_NOT_FOUND");
    if (candidate.status !== "registrable") return deny(409, "TARGET_NOT_REGISTRABLE");
    const element = snapshot.elements.find((item) => item.ref === command.ref);
    if (!element) return deny(409, "REF_NOT_FOUND");
    // A FRESH observation: the live marker and the live privacy facts (a drifted page is REF_NOT_FOUND from the adapter, never a fuzzy match).
    const liveMarker = await session.runtime.inspectSemanticId(command.ref as ElementRef, snapshot);
    const liveFacts = (await session.runtime.inspectElementFacts([command.ref as ElementRef], snapshot)).get(command.ref as ElementRef) ?? null;
    if (liveMarker === null || liveMarker !== command.targetId) return deny(409, "TARGET_ID_MISMATCH");
    // The eligibility rules are RE-RUN on the live data and the fresh registry (the cached candidate is not trusted).
    const registry = await registryView(principal.tenantId, session.applicationId);
    if (registry.targets.some((target) => target.id === liveMarker || target.marker === liveMarker)) return deny(409, "TARGET_EXISTS");
    // The caps are answered as such (not as "not registrable"): the registry is full, or the live page needs a new route and no route is left.
    const livePage = pageOfUrl(snapshot.url, session.routing);
    if (registry.targets.length >= MAX_TARGETS_PER_APPLICATION || (livePage !== null && routeOfPage(livePage, registry.routes) === null && registry.routes.length >= MAX_ROUTES_PER_APPLICATION)) return deny(409, "REGISTRY_FULL");
    // The ids of the whole inspected set are read again so a marker that now sits on a second control is seen (ambiguous markers are never registrable).
    const liveIds = new Map(await session.runtime.inspectSemanticIds(snapshot));
    liveIds.set(element.ref, liveMarker);
    const live = classifyControl({ routing: session.routing, snapshot, ids: liveIds, facts: new Map([[element.ref, liveFacts]]), registry }, element);
    if (live === null || live.status !== "registrable") return deny(409, "TARGET_NOT_REGISTRABLE");
    const { proposal } = live;
    // The page keeps its route; a new route name may not belong to another page.
    if (!proposal.routeIsNew && command.route !== proposal.route) return deny(409, "ROUTE_MISMATCH");
    // Role and page come from the live element and URL; the maintainer supplies only the label, description, operations and (for a new page) the route name.
    const checked = validateTargetRegistration({
      targetId: liveMarker, route: command.route, page: proposal.page, elementRole: proposal.role, label: command.label, description: command.description, operations: command.operations, privacy: command.privacy,
    });
    if (!checked.ok) return deny(422, "INVALID_TARGET", { issues: checked.issues });
    if (proposal.routeIsNew && registry.routes.some((entry) => entry.route === checked.value.route)) return deny(409, "ROUTE_MISMATCH");
    const value = checked.value;
    const { result, route } = await withRegistrationReceipt({ tenantId: principal.tenantId, applicationId: record.id, targetId: value.targetId },
      () => submitGatewayWrite(principal, REGISTER_TARGET_ACTION_ID, {
        applicationId: record.id, targetId: value.targetId, route: value.route, page: value.page, elementRole: value.role,
        label: value.label, description: value.description, operations: [...value.operations], privacy: value.privacy,
      }));
    if (result === "refused") return deny(403, "FORBIDDEN");
    if (result === "failed") return await diagnose(principal.tenantId, session, value, deny); // the executor refused: say why from the fresh state
    if (result !== "ok" || route === undefined) return deny(503, "BROWSER_UNAVAILABLE");
    const target = await targets.get(principal.tenantId, session.applicationId, value.targetId);
    if (target === null) return deny(503, "BROWSER_UNAVAILABLE");
    // The registered element is trusted from now on; the other candidates of this refresh are unchanged.
    session.candidates = new Map([...session.candidates].map(([ref, item]) => [ref, ref === command.ref ? { ref: item.ref, name: item.name, role: item.role, route: value.route, status: "trusted" as const, targetId: value.targetId, operations: target.operations, privacy: "public" as const } : item]));
    return { target, route };
  }

  /** Why the executor refused, from the state as it is NOW (never from the executor's text). */
  async function diagnose(tenantId: string, session: Session, value: { targetId: string; route: string; page: string }, deny: Deny) {
    let record: ApplicationRecord | null;
    let registry: ManagedRegistryView;
    try { record = await applications.get(tenantId, session.applicationId); registry = await registryView(tenantId, session.applicationId); }
    catch { return deny(503, "BROWSER_UNAVAILABLE"); }
    if (record === null) { await close().catch(() => {}); return deny(404, "APPLICATION_NOT_FOUND"); }
    if (!record.enabled) { await close().catch(() => {}); return deny(409, "APPLICATION_DISABLED"); }
    if (registry.targets.some((target) => target.id === value.targetId || target.marker === value.targetId)) return deny(409, "TARGET_EXISTS");
    const byPage = registry.routes.find((entry) => entry.page === value.page);
    if ((byPage !== undefined && byPage.route !== value.route) || (byPage === undefined && registry.routes.some((entry) => entry.route === value.route))) return deny(409, "ROUTE_MISMATCH");
    if (registry.targets.length >= MAX_TARGETS_PER_APPLICATION || (byPage === undefined && registry.routes.length >= MAX_ROUTES_PER_APPLICATION)) return deny(409, "REGISTRY_FULL");
    return deny(503, "BROWSER_UNAVAILABLE");
  }

  /** Opens the one session for an enrolled application of the caller's tenant. Never reads an origin, registry or label from the request. */
  async function connect(command: Extract<StudioCommand, { action: "connect" }>, tenantId: string, owner: string, deny: Deny, touch: () => void) {
    if (current) return deny(409, "BROWSER_BUSY");
    let record: ApplicationRecord | null;
    try { record = await applications.get(tenantId, command.applicationId); }
    catch { return deny(503, "BROWSER_UNAVAILABLE"); }
    if (record === null) return deny(404, "APPLICATION_NOT_FOUND");
    if (!record.enabled) return deny(409, "APPLICATION_DISABLED");
    const source = registrySourceOf(record.registryId);
    // Built-in: the catalog entry's labels and pages (V1A). Studio-managed: every operable control may be OBSERVED (`labels: "all"`) on any page of the allowed origins (`routes: "any"`);
    // the host decides what is forwarded.
    let config: BrowserRuntimeConfig;
    if (source === "studio-managed") config = record.routing === "history" ? { labels: "all", routes: "any", routing: "history", origins: record.allowedOrigins } : { labels: "all", routes: "any", origins: record.allowedOrigins };
    else {
      const entry = catalog.get(record.registryId);
      if (entry === undefined) return deny(503, "BROWSER_UNAVAILABLE");
      config = { labels: entry.browser.labels, routes: Object.keys(entry.browser.pages), origins: record.allowedOrigins };
    }
    if (command.walkthroughId !== undefined) {
      let stored: Awaited<ReturnType<WalkthroughStore["get"]>>;
      try { stored = await authoring.get(tenantId, command.walkthroughId); }
      catch { return deny(503, "BROWSER_UNAVAILABLE"); }
      // Unknown, foreign or malformed is the generic bad request (no new code); a guide of another application is a mismatch; a legacy guide (no application) may be opened by any.
      if (stored === null) return deny(400, "INVALID_REQUEST");
      if (stored.applicationId !== null && stored.applicationId !== record.id) return deny(409, "APPLICATION_MISMATCH");
    }
    let runtime: BrowserRuntime;
    try { runtime = createRuntime(config); }
    catch { return deny(503, "BROWSER_UNAVAILABLE"); } // the adapter refused the configuration (never echoed)
    const session: Session = {
      id: makeId(), owner, tenantId, applicationId: record.id, application: { name: record.name, origin: record.origin }, source, routing: record.routing, policy: policyOf(record), runtime, candidates: new Map(),
    };
    current = session; // set before start so a failed start (or the idle timer, or shutdown) closes the half-open browser
    touch();
    try { await runtime.start({ url: `${record.origin}/`, headed: true }); }
    catch (error) { await close().catch(() => {}); throw error; }
    return { sessionId: session.id, applicationId: record.id, application: record.name, origin: record.origin, registrySource: source };
  }
}
