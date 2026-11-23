/**
 * Shared harness for the Studio V1B PostgreSQL tests: one tenant, one host (real Gateway, every capability family incl. the target capabilities), the authoring, application and target routes on
 * the C01 transport (`inject`, no port), a maintainer and an ordinary user, and helpers to enrol applications and register targets through the REAL Gateway. Needs the PostgreSQL of deploy/compose.yaml
 * on a fresh database (DAP_DATABASE_URL / DAP_MIGRATE_DATABASE_URL).
 */
import { randomUUID } from "node:crypto";
import { vi } from "vitest";
import { composeReferenceHost } from "../../apps/reference-host/src/index.js";
import type { ReferenceHost } from "../../apps/reference-host/src/index.js";
import { parseDevSessions } from "../../apps/reference-host/src/dev-auth/index.js";
import { createAuthoringExtension } from "../../apps/reference-host/src/authoring/capabilities.js";
import { createPostgresWalkthroughStore } from "../../apps/reference-host/src/authoring/postgres-store.js";
import { createDemoPrincipalResolver } from "../../apps/reference-host/src/authoring/principal.js";
import { registerAuthoringRoutes } from "../../apps/reference-host/src/authoring/routes.js";
import type { WalkthroughStore } from "../../apps/reference-host/src/authoring/store.js";
import { withTenant } from "../../apps/reference-host/src/authoring/tenant-tx.js";
import { createProposalStore } from "../../apps/reference-host/src/http/proposal-store.js";
import { createGuidanceTransport } from "../../apps/reference-host/src/http/transport.js";
import { demoCatalogView } from "../../apps/reference-host/src/guidance/walkthrough-summaries.js";
import { createApplicationExtension } from "../../apps/reference-host/src/studio/application-capabilities.js";
import { registerApplicationRoutes } from "../../apps/reference-host/src/studio/application-routes.js";
import type { ApplicationConfig } from "../../apps/reference-host/src/studio/applications.js";
import { FIXTURE_ENTRY } from "../../apps/reference-host/src/studio/fixture-registry.js";
import { createPostgresApplicationStore } from "../../apps/reference-host/src/studio/postgres-application-store.js";
import { createPostgresTargetStore } from "../../apps/reference-host/src/studio/postgres-target-store.js";
import { createRegistryCatalog } from "../../apps/reference-host/src/studio/registries.js";
import { createRegistryResolver } from "../../apps/reference-host/src/studio/registry-resolver.js";
import { createTargetExtension } from "../../apps/reference-host/src/studio/target-capabilities.js";
import { createPostgresPool } from "../../packages/security/src/index.js";
import { withTenant as withTenantOwner } from "../../packages/security/src/state/postgres/tenant-tx.js";
import type { Pool } from "pg";

export const ALL_ACTIONS = "demoLookup,saveWalkthroughDraft,setWalkthroughStatus,saveStudioApplication,setStudioApplicationEnabled,rotateStudioRuntimeKey,registerStudioTarget,setStudioTargetStatus,setStudioTargetHealth,repairStudioTarget,registerStudioCheck,setStudioCheckStatus";
export const managedConfig = (over: Partial<ApplicationConfig> = {}): ApplicationConfig => ({ name: "Managed application", origin: "http://127.0.0.1:5187", allowedOrigins: ["http://127.0.0.1:5187"], environment: "test", registryId: "studio-managed", routing: "hash", runtimeAccess: false, ...over });
export const referenceConfig = (over: Partial<ApplicationConfig> = {}): ApplicationConfig => ({ name: "Reference application", origin: "http://127.0.0.1:5184", allowedOrigins: ["http://127.0.0.1:5184"], environment: "development", registryId: "reference", routing: "hash", runtimeAccess: false, ...over });
export const fixtureConfig = (over: Partial<ApplicationConfig> = {}): ApplicationConfig => ({ name: "Fixture application", origin: "http://127.0.0.1:5185", allowedOrigins: ["http://127.0.0.1:5185"], environment: "test", registryId: "fixture", routing: "hash", runtimeAccess: false, ...over });

/** The values of one registration in the capability's parameter shape. */
export const registration = (over: Record<string, unknown> = {}) => ({
  targetId: "orders.submitButton", route: "orders", page: "/#/orders", elementRole: "button", label: "Submit order", description: "Submits the order", operations: ["highlight", "click"], privacy: "public", ...over,
});
/** A walkthrough over managed targets: navigate to a route, highlight one target, complete. */
export const managedDef = (target = "orders.submitButton", route = "orders", over: Record<string, unknown> = {}) => ({
  title: "Submit an order", description: "Submit the order.", start: "n1",
  steps: [{ id: "n1", kind: "navigate", route, next: "s1" }, { id: "s1", kind: "guide", target, text: "Press the button.", wait: "click", verify: `route.${route}`, next: "done" }, { id: "done", kind: "complete", text: "Done." }],
  ...over,
});

export interface StartOptions {
  enabled?: string; tenant?: string; wrapStore?: (real: WalkthroughStore) => WalkthroughStore;
  /** Wraps the application store the AUTHORING executors read (to interleave a concurrent change between their read and their write). */
  wrapApplications?: (real: ReturnType<typeof createPostgresApplicationStore>) => ReturnType<typeof createPostgresApplicationStore>;
  /** Wraps the target store the REGISTRY RESOLVER reads (to change the registry between the executor's first read and its in-transaction re-read). */
  wrapRegistration?: (register: ReturnType<typeof createPostgresTargetStore>["register"]) => ReturnType<typeof createPostgresTargetStore>["register"];
  wrapTargets?: (real: ReturnType<typeof createPostgresTargetStore>) => ReturnType<typeof createPostgresTargetStore>;
}

export async function startHost(closers: (() => Promise<unknown>)[], hosts: ReferenceHost[], owner: Pool, options: StartOptions = {}) {
  const tenant = options.tenant ?? randomUUID();
  const suffix = tenant.slice(0, 8);
  const future = new Date(Date.now() + 3_600_000).toISOString();
  const [userToken, maintToken] = [`tok-${randomUUID()}`, `tok-${randomUUID()}`];
  const sessions = [
    { token: userToken, userId: "ula", tenantId: tenant, sessionId: `s-ula-${suffix}-${randomUUID().slice(0, 4)}`, validUntil: future, permissions: ["perm.demo.lookup"] },
    { token: maintToken, userId: "maya", tenantId: tenant, sessionId: `s-maya-${suffix}-${randomUUID().slice(0, 4)}`, validUntil: future, permissions: ["perm.walkthrough.maintain", "perm.demo.lookup"] },
  ];
  const pool = createPostgresPool(process.env.DAP_DATABASE_URL!, { max: 8 });
  closers.push(() => pool.end());
  const realStore = createPostgresWalkthroughStore(pool);
  const saveDraft = vi.fn(realStore.saveDraft);
  const store: WalkthroughStore = options.wrapStore ? options.wrapStore({ ...realStore, saveDraft }) : { ...realStore, saveDraft };
  const applications = createPostgresApplicationStore(pool);
  const realTargets = createPostgresTargetStore(pool);
  const targets = options.wrapRegistration ? { ...realTargets, register: options.wrapRegistration(realTargets.register) } : realTargets;
  const catalog = createRegistryCatalog([FIXTURE_ENTRY]);
  const resolver = createRegistryResolver({ catalog, targets: options.wrapTargets ? options.wrapTargets(targets) : targets });
  const authoring = createAuthoringExtension({ store, applications: options.wrapApplications ? options.wrapApplications(applications) : applications, catalog, targets, resolver });
  const studio = createApplicationExtension({ store: applications, catalog });
  const targetExt = createTargetExtension({ targets });
  const { host } = await composeReferenceHost(
    { NODE_ENV: "test", DAP_ALLOW_DEV_AUTH: "1", DAP_DATABASE_URL: process.env.DAP_DATABASE_URL, DAP_ENABLED_ACTIONS: options.enabled ?? ALL_ACTIONS, DEV_SESSIONS: JSON.stringify(sessions) },
    { extensions: [authoring.extension, studio.extension, targetExt.extension] },
  );
  hosts.push(host);
  const resolvePrincipal = createDemoPrincipalResolver({ sessions: parseDevSessions(JSON.stringify(sessions)), userToken, maintainerToken: maintToken, openSession: (evidence) => host.openSession(evidence) });
  const app = createGuidanceTransport({ ask: async () => ({ kind: "clarify", message: "x" }), catalog: demoCatalogView, resolveSession: async () => null, proposals: createProposalStore({ now: Date.now, newId: () => "proposal-id-0000000000000000" }) });
  registerAuthoringRoutes(app, { store, applications, catalog, targets, resolver, resolvePrincipal });
  registerApplicationRoutes(app, { applications, catalog, targets, resolver, resolvePrincipal });
  closers.push(() => app.close());
  const call = async (method: "GET" | "POST" | "PUT", url: string, role: "user" | "maintainer", body?: unknown) => {
    const res = await app.inject({ method, url, headers: { "x-demo-role": role, ...(body === undefined ? {} : { "content-type": "application/json" }) }, ...(body === undefined ? {} : { payload: JSON.stringify(body) }) });
    let parsed: Record<string, unknown> = {};
    try { parsed = JSON.parse(res.body) as Record<string, unknown>; } catch { /* not JSON */ }
    return { status: res.statusCode, body: parsed, raw: res.body };
  };
  /** A FRESH Gateway session per call: each write is its own turn. */
  const submit = async (action: string, params: unknown, token = maintToken) => {
    const session = await host.openSession(token);
    if (session === null) throw new Error("session refused");
    return session.submit({ providerCallId: `call-${randomUUID()}`, arguments: JSON.stringify({ action, params }) });
  };
  const rows = async () => (await withTenantOwner(owner, tenant, (client) => client.query("SELECT event_type, action_id, outcome, risk, params_view, execution_result, resource_type, resource_id, user_id FROM public.sec_audit_events ORDER BY seq"))).rows as Record<string, unknown>[];
  const createApplication = async (config: ApplicationConfig = managedConfig()) => {
    const res = await call("POST", "/api/admin/applications", "maintainer", config);
    if (res.status !== 201) throw new Error(`application not created: ${res.status} ${res.raw}`);
    return res.body.id as string;
  };
  /** Registers through the real capability; resolves to the Gateway feedback. */
  const registerTarget = (applicationId: string, over: Record<string, unknown> = {}) => submit("registerStudioTarget", { applicationId, ...registration(over) });
  const registerOk = async (applicationId: string, over: Record<string, unknown> = {}) => {
    const feedback = await registerTarget(applicationId, over);
    if (feedback.outcome !== "ALLOWED" || feedback.category !== "ok") throw new Error(`target not registered: ${JSON.stringify(feedback)}`);
  };
  const createWorkflow = async (applicationId: string, definition: unknown) => {
    const res = await call("POST", "/api/admin/walkthroughs", "maintainer", { applicationId, definition });
    return { res, id: res.body.id as string };
  };
  const sql = <T>(fn: (client: { query(sql: string, params?: readonly unknown[]): Promise<{ rows: readonly Record<string, unknown>[]; rowCount: number | null }> }) => Promise<T>) => withTenant(pool, tenant, fn);
  return { app, resolvePrincipal, tenant, call, submit, rows, store, realStore, saveDraft, applications, targets, realTargets, resolver, catalog, pool, createApplication, registerTarget, registerOk, createWorkflow, sql, maintToken, userToken, trustedTargets: targetExt.trusted, trusted: authoring.trusted };
}
