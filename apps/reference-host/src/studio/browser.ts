/**
 * The Studio browser session API (Studio V1A, D5-D7): `POST /api/studio/browser`, maintainer-only, on the existing transport instance.
 *
 * A session is bound to ONE enrolled application. The application is loaded ONLY through the application store scoped to the principal's tenant, never from the request:
 *
 *   exposure policy   config.labels  = the role + accessible-name pairs the application's registry declares (nothing else ever leaves the adapter)
 *   navigation policy config.routes  = the pages of that registry; config.origins = the application's allowed origins, exactly as stored (already normalised)
 *
 * Commands (exact-key bodies, see `browser-commands.ts`):
 *   connect    { action, applicationId, walkthroughId? }          -> { sessionId, applicationId, application, origin }
 *   refresh    { action, sessionId, applicationId }               -> { url, route, elements }  (the inspector: each candidate is `trusted` with its registry target id, or `unregistered`)
 *   highlight  { action, sessionId, applicationId, ref }          -> { highlighted: true, ref }   (re-verifies, highlights, persists NOTHING)
 *   capture    { action, sessionId, applicationId, ref }          -> { targetId, route, name, role, operations }   (the UI's "Use": a trusted candidate only)
 *   disconnect { action, sessionId, applicationId? }              -> { closed: true }
 *
 * Invariants kept from the first Studio (and re-tested): ONE session per host, owned by [principal key, tenant, actor]; one command in flight (BROWSER_BUSY); the session closes on
 * disconnect, after five idle minutes, on host shutdown (`onClose`) and when connecting fails; no raw error text, CLI output, blocked URL or application origin leaves in an error.
 * New: every command re-loads the application, so a session whose application was disabled or removed since connect is closed and refused (fail closed). A session can never change
 * application: connect while a session exists is BROWSER_BUSY, and a command naming another application is APPLICATION_MISMATCH (the session stays open).
 *
 * The temporary element refs (`@eN`) are session-only evidence: they live in the session object, are replaced wholesale by every refresh, are never written anywhere by the host and are
 * gone when the session closes. The persisted value is always the registry id.
 */
import { randomUUID } from "node:crypto";
import { BrowserRuntimeError, createAgentBrowserAdapter } from "@dap/browser-runtime";
import type { AgentBrowserAdapterOptions, BrowserRuntime, BrowserSnapshot, ElementRef } from "@dap/browser-runtime";
import type { FastifyInstance } from "fastify";
import type { AuthoringRouteDeps } from "../authoring/routes.js";
import type { WalkthroughStore } from "../authoring/store.js";
import type { ApplicationStore } from "./application-store.js";
import type { ApplicationRecord } from "./applications.js";
import { parseStudioCommand } from "./browser-commands.js";
import type { StudioCommand } from "./browser-commands.js";
import { MAX_URL_CHARS, classifyCandidates, routeOfUrl } from "./inspector.js";
import type { Candidate } from "./inspector.js";
import type { RegistryCatalog, RegistryEntry } from "./registries.js";

const idleMs = 5 * 60_000;
const busyRecheckMs = 1_000;
const MAINTAIN = "perm.walkthrough.maintain";

/** The policy a runtime is created with: derived from the application, never from a request. */
export type BrowserRuntimeConfig = Pick<AgentBrowserAdapterOptions, "labels" | "routes" | "origins">;

interface Session {
  readonly id: string;
  readonly owner: string;
  readonly tenantId: string;
  readonly applicationId: string;
  readonly application: { readonly name: string; readonly origin: string };
  /** What the live adapter was configured with: a later change to it closes the session (the adapter's policy would be stale). */
  readonly policy: string;
  readonly registry: RegistryEntry;
  readonly runtime: BrowserRuntime;
  /** The last refresh. Replaced wholesale by every refresh; dropped with the session. */
  snapshot?: BrowserSnapshot;
  candidates: ReadonlyMap<string, Candidate>;
}

interface Options {
  readonly resolvePrincipal: AuthoringRouteDeps["resolvePrincipal"];
  /** The tenant's enrolled applications (the ONLY source of a session's origins, registry and enabled state). */
  readonly applications: ApplicationStore;
  /** The host-trusted registry catalog: `application.registryId` -> labels, pages and the trusted registry. */
  readonly catalog: RegistryCatalog;
  /** Read-only access to stored walkthroughs, for the optional `walkthroughId` binding check at connect (tenant-scoped). */
  readonly authoring: Pick<WalkthroughStore, "get">;
  readonly createRuntime?: (config: BrowserRuntimeConfig) => BrowserRuntime;
  readonly makeId?: () => string;
}

/** The fields of an application that shape the adapter's policy. A rename does not; an origin, allowed-origin or registry change does. */
const policyOf = (application: ApplicationRecord): string => JSON.stringify([application.origin, application.allowedOrigins, application.registryId]);

export function registerStudioBrowser(app: FastifyInstance, { resolvePrincipal, applications, catalog, authoring, createRuntime = (config) => createAgentBrowserAdapter(config), makeId = randomUUID }: Options): void {
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
   * (Re)starts the idle clock. It is called ONLY for the OWNER's own successful activity (a connect that opened the session, or a command whose owner, session id and application matched),
   * never for a rejected connect (BROWSER_BUSY), a command carrying somebody else's session id, an unauthorized or malformed request: otherwise anyone probing a forgotten session
   * (or the owner clicking Connect after a page reload) would keep it open for ever. If a command is in flight when the clock runs out, it checks again shortly.
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
    const deny = (status: number, error: string) => reply.code(status).send({ error });
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

      if (!current || current.owner !== owner || command.sessionId !== current.id) return deny(404, "SESSION_CLOSED");
      const session = current;
      if (command.applicationId !== undefined && command.applicationId !== session.applicationId) return deny(409, "APPLICATION_MISMATCH");
      ownerActivity = true;
      if (command.action === "disconnect") { await close(); return { closed: true }; }

      // Every other command re-loads the application: a session never outlives its enrolment (fail closed).
      let record: ApplicationRecord | null;
      try { record = await applications.get(principal.tenantId, session.applicationId); }
      catch { return deny(503, "BROWSER_UNAVAILABLE"); }
      if (record === null) { await close().catch(() => {}); return deny(404, "APPLICATION_NOT_FOUND"); }
      if (!record.enabled) { await close().catch(() => {}); return deny(409, "APPLICATION_DISABLED"); }
      if (policyOf(record) !== session.policy) { await close().catch(() => {}); return deny(409, "APPLICATION_MISMATCH"); }

      if (command.action === "refresh") {
        delete session.snapshot;
        session.candidates = new Map();
        const snapshot = await session.runtime.snapshot();
        const route = routeOfUrl(snapshot.url, session.registry.browser.pages);
        const candidates = classifyCandidates(snapshot, await session.runtime.inspectSemanticIds(snapshot), route, session.registry.registry);
        session.snapshot = snapshot;
        session.candidates = new Map(candidates.map((candidate) => [candidate.ref, candidate]));
        return { url: snapshot.url.slice(0, MAX_URL_CHARS), route, elements: candidates };
      }

      // highlight and capture: the ref must be one of the LAST refresh's candidates, and a trusted one.
      const snapshot = session.snapshot;
      const candidate = session.candidates.get(command.ref);
      if (!snapshot || !candidate) return deny(409, "REF_NOT_FOUND");
      if (candidate.status !== "trusted") return deny(409, "TARGET_UNAVAILABLE");
      // Re-verify against a FRESH observation: the live element must still carry the same registry id (a stale snapshot is REF_NOT_FOUND from the adapter).
      const id = await session.runtime.inspectSemanticId(command.ref as ElementRef, snapshot);
      if (id !== candidate.targetId) return deny(409, "TARGET_UNAVAILABLE");
      await session.runtime.highlight(command.ref as ElementRef, snapshot);
      if (command.action === "highlight") return { highlighted: true, ref: command.ref };
      return { targetId: candidate.targetId, route: candidate.route, name: candidate.name, role: candidate.role, operations: candidate.operations };
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

  /** Opens the one session for an enrolled application of the caller's tenant. Never reads an origin, registry or label from the request. */
  async function connect(command: Extract<StudioCommand, { action: "connect" }>, tenantId: string, owner: string, deny: (status: number, error: string) => unknown, touch: () => void) {
    if (current) return deny(409, "BROWSER_BUSY");
    let record: ApplicationRecord | null;
    try { record = await applications.get(tenantId, command.applicationId); }
    catch { return deny(503, "BROWSER_UNAVAILABLE"); }
    if (record === null) return deny(404, "APPLICATION_NOT_FOUND");
    if (!record.enabled) return deny(409, "APPLICATION_DISABLED");
    const registry = catalog.get(record.registryId);
    if (registry === undefined) return deny(503, "BROWSER_UNAVAILABLE");
    if (command.walkthroughId !== undefined) {
      let stored: Awaited<ReturnType<WalkthroughStore["get"]>>;
      try { stored = await authoring.get(tenantId, command.walkthroughId); }
      catch { return deny(503, "BROWSER_UNAVAILABLE"); }
      // Unknown, foreign or malformed is the generic bad request (no new code); a guide of another application is a mismatch; a legacy guide (no application) may be opened by any.
      if (stored === null) return deny(400, "INVALID_REQUEST");
      if (stored.applicationId !== null && stored.applicationId !== record.id) return deny(409, "APPLICATION_MISMATCH");
    }
    let runtime: BrowserRuntime;
    try { runtime = createRuntime({ labels: registry.browser.labels, routes: Object.keys(registry.browser.pages), origins: record.allowedOrigins }); }
    catch { return deny(503, "BROWSER_UNAVAILABLE"); } // the adapter refused the configuration (never echoed)
    const session: Session = {
      id: makeId(), owner, tenantId, applicationId: record.id, application: { name: record.name, origin: record.origin }, policy: policyOf(record), registry, runtime, candidates: new Map(),
    };
    current = session; // set before start so a failed start (or the idle timer, or shutdown) closes the half-open browser
    touch();
    try { await runtime.start({ url: `${record.origin}/`, headed: true }); }
    catch (error) { await close().catch(() => {}); throw error; }
    return { sessionId: session.id, applicationId: record.id, application: record.name, origin: record.origin };
  }
}
