/**
 * The reference host's composition root (T131): the ONE place the pieces are wired together.
 *
 *   dev session token -> trusted AuthorizationContext (dev-auth + the security context factory)
 *     -> AI-facing session (`submit` only) -> the real Policy Gateway (rate/replay, resolve, validate, authorize, risk, confirmation
 *     placeholder, execution cap, durable ALLOWED audit in PostgreSQL) -> trusted executor -> EXECUTED audit.
 *
 * It is NOT an application platform and NOT a production authentication system. It builds, from the production packages only (never the
 * testkit): the Action Registry and executor bindings, the PostgreSQL audit/replay/rate-limit/tenant-policy stores, the host's demo
 * permission/resource/page ports, a trusted clock and id generator, and the Gateway. `loadConfig` validates the environment first, so a
 * missing or malformed value (or development authentication in production) fails startup before anything is created.
 *
 * What the AI layer gets (`AiSession`): ONE function, `submit(rawToolCall)`. It does not get the registry, the executors, the stores or pool,
 * the audit reader, any mint API, the confirmation service, or the context it is bound to. The call id is assigned HERE (trusted runner,
 * research D11) from the session, the turn and the provider's id; identity and the page never come from the proposal.
 */
import { randomUUID } from "node:crypto";
import type { ActionExecutor, AnyActionDefinition, AuditEvent, Clock, ConfirmationChannel, ConfirmationId, GatewayDependencies, IdGenerator, IsoInstant, PlannerFeedback, PlannerRunMeta, SecurityStateStore } from "@dap/contracts";
import { toProposalCall } from "@dap/ai";
import type { RawToolCall } from "@dap/ai";
import {
  PostgresAuditStore, PostgresRateLimiter, PostgresReplayGuard, PostgresTenantActionPolicyStore, bindExecutors, buildRegistry, createPolicyGateway,
  createPostgresPool, createSecurityContextFactory,
} from "@dap/security";
import { DEMO_ACTION_IDS, DEMO_DEFINITIONS, createDemoExecutors } from "./capabilities.js";
import type { TrustedHandle } from "./capabilities.js";
import { loadConfig } from "./config.js";
import type { Environment } from "./config.js";
import { createDevAuthentication } from "./dev-auth/index.js";
import { createPageContextProvider, createPermissionChecker, createResourceAuthorizer } from "./host-ports.js";

/**
 * What a host extension may add: capability definitions and their executors, nothing else. No hook, no plugin lifecycle, and no access to the pool,
 * the stores, the registry, the clock or the configuration. An extension is data handed in by the composition root's caller (trusted host code).
 */
export interface HostExtension {
  readonly definitions: readonly AnyActionDefinition[];
  readonly executors: readonly ActionExecutor[];
}
export interface ComposeOptions {
  readonly extensions?: readonly HostExtension[];
}
export class ExtensionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExtensionError";
  }
}

/**
 * Validates the extensions (fail closed, before anything is created) and returns the extra definitions and executors in order. Refused: an extension that
 * is not exactly `{ definitions, executors }`, malformed lists or entries, a capability id that collides with a demo capability or with another extension, an
 * executor id that collides with a demo executor or another extension's, and a capability whose executor is not its own extension's (or is shared by two capabilities).
 */
function collectExtensions(extensions: readonly HostExtension[] | undefined): { readonly definitions: readonly AnyActionDefinition[]; readonly executors: readonly ActionExecutor[] } {
  if (extensions === undefined) return { definitions: [], executors: [] };
  if (!Array.isArray(extensions)) throw new ExtensionError("extensions must be an array");
  const definitions: AnyActionDefinition[] = [];
  const executors: ActionExecutor[] = [];
  const actionIds = new Set<string>(DEMO_ACTION_IDS);
  const executorIds = new Set<string>(DEMO_DEFINITIONS.map((definition) => definition.executorId as string)); // an extension executor may not shadow a demo executor
  const isObject = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object";
  for (const extension of extensions as readonly unknown[]) {
    const bag = extension as Partial<HostExtension> | null;
    if (bag === null || typeof bag !== "object" || Object.keys(bag).some((key) => key !== "definitions" && key !== "executors") || !Array.isArray(bag.definitions) || !Array.isArray(bag.executors)) {
      throw new ExtensionError("an extension must be exactly { definitions, executors }");
    }
    if ([...bag.definitions, ...bag.executors].some((entry: unknown) => !isObject(entry))) throw new ExtensionError("an extension holds only capability definitions and executors");
    const own = new Set<string>(); // the executors THIS extension brings
    for (const executor of bag.executors) {
      const id = executor.id as string;
      if (typeof id !== "string" || executorIds.has(id)) throw new ExtensionError("an extension executor id is missing or collides with another executor");
      executorIds.add(id);
      own.add(id);
      executors.push(executor);
    }
    const bound = new Set<string>();
    for (const definition of bag.definitions) {
      const id = definition.id as string;
      if (typeof id !== "string" || actionIds.has(id)) throw new ExtensionError("an extension capability id is missing or collides with another capability");
      // A capability may use only an executor of its own extension, and only one capability per executor: it cannot re-expose a demo (or another extension's) executor under a weaker policy.
      const executorId = definition.executorId as string;
      if (typeof executorId !== "string" || !own.has(executorId) || bound.has(executorId)) throw new ExtensionError("an extension capability must use its own executor, one capability per executor");
      bound.add(executorId);
      actionIds.add(id);
      definitions.push(definition);
    }
  }
  return { definitions, executors };
}

/** The ONLY thing the AI layer is given for one authenticated session. */
export interface AiSession {
  submit(call: RawToolCall): Promise<PlannerFeedback>;
}

/** The host side (transport/session layer). Not given to the AI layer. */
export interface ReferenceHost {
  /**
   * Turns session evidence (the token the host's transport received) into an `AiSession`, or `null` when there is no valid session.
   * Fails closed: an unknown, malformed, expired or missing session mints no context and yields nothing to submit through.
   */
  openSession(evidence: unknown): Promise<AiSession | null>;
  /** Releases the database pool. */
  close(): Promise<void>;
}

export interface ComposedHost {
  readonly host: ReferenceHost;
  /** The host's own view of its executors (call counts, what they received, effects). Never reachable from an `AiSession`. */
  readonly trusted: TrustedHandle;
}

const systemClock: Clock = Object.freeze({ now: (): IsoInstant => new Date().toISOString() as IsoInstant });
const systemIds: IdGenerator = Object.freeze({
  newDecisionId: (): string => `dec-${randomUUID()}`,
  newConfirmationId: (): ConfirmationId => randomUUID() as ConfirmationId,
});

/** The confirmation service does not exist yet (HIGH/CRITICAL capabilities stop at REQUIRES_CONFIRMATION). Every method rejects. */
const confirmationUnavailable = async (): Promise<never> => { throw new Error("The confirmation service is not built: this placeholder is fail-closed"); };
const confirmationStorePlaceholder: SecurityStateStore["confirmations"] = Object.freeze({
  create: confirmationUnavailable, get: confirmationUnavailable, listPending: confirmationUnavailable, tryAccept: confirmationUnavailable,
  tryReject: confirmationUnavailable, invalidate: confirmationUnavailable, recordExecution: confirmationUnavailable,
});
const confirmationChannelPlaceholder: ConfirmationChannel = Object.freeze({ deliver: confirmationUnavailable });

/**
 * Validates `env` (throws on anything missing or malformed, before any connection is made) and assembles the host. Without `options` (or with no
 * extensions) the host is exactly the Feature 001 host: the three demo capabilities and nothing else.
 */
export async function composeReferenceHost(env: Environment, options?: ComposeOptions): Promise<ComposedHost> {
  const extra = collectExtensions(options?.extensions);
  const config = loadConfig(env, extra.definitions.map((definition) => definition.id as string));
  const registry = buildRegistry([...DEMO_DEFINITIONS, ...extra.definitions]);
  const { executors, trusted } = createDemoExecutors();
  const executorTable = bindExecutors(registry, [...executors, ...extra.executors]);
  const pool = createPostgresPool(config.databaseUrl);
  try {
    const clock = systemClock;
    const audit = new PostgresAuditStore(pool);
    const state: SecurityStateStore = Object.freeze({
      replay: new PostgresReplayGuard(pool),
      rateLimiter: new PostgresRateLimiter(pool),
      tenantPolicy: new PostgresTenantActionPolicyStore(pool),
      confirmations: confirmationStorePlaceholder,
      ping: async (): Promise<boolean> => { try { await pool.query("SELECT 1"); return true; } catch { return false; } },
    });
    const deps: GatewayDependencies = {
      registry,
      executors: executorTable,
      globalAllowlist: new Set(config.enabledActions as readonly never[]),
      hooks: { permissions: createPermissionChecker(config.devSessions), resources: createResourceAuthorizer(config.devSessions), pages: createPageContextProvider() },
      state,
      audit: { append: (event: AuditEvent, options) => audit.append(event, options) },
      confirmationChannel: confirmationChannelPlaceholder,
      config: config.gateway,
      clock,
      ids: systemIds,
    };
    const { proposals } = createPolicyGateway(deps);
    const contexts = createSecurityContextFactory({ authentication: createDevAuthentication(config.devSessions, clock), clock });

    const host: ReferenceHost = Object.freeze({
      async openSession(evidence: unknown): Promise<AiSession | null> {
        const context = await contexts.establish(evidence);
        if (context === null) return null;
        const run: PlannerRunMeta = Object.freeze({ aiSessionId: context.sessionId, turnId: randomUUID(), model: "reference-host", depth: 0, turnStartedAt: clock.now() });
        const bound = proposals.forSession(context, run);
        return Object.freeze({
          submit: Object.freeze(async (call: RawToolCall): Promise<PlannerFeedback> => {
            let providerCallId: unknown; let argumentsText: unknown;
            try {
              providerCallId = call.providerCallId;
              argumentsText = call.arguments;
            } catch { return bound.submit(toProposalCall("", "")); }
            // Do not coerce provider objects or let transport getters escape the generic Gateway feedback.
            if (typeof providerCallId !== "string" || !/^[\x21-\x7e]{1,256}$/.test(providerCallId)) return bound.submit(toProposalCall("", ""));
            return bound.submit(toProposalCall(`${run.aiSessionId}.${run.turnId}.${providerCallId}`, typeof argumentsText === "string" ? argumentsText : ""));
          }),
        });
      },
      close: async () => { await pool.end(); },
    });
    return Object.freeze({ host, trusted });
  } catch (error) {
    await pool.end();
    throw error;
  }
}
