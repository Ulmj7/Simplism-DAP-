/**
 * @dap/testkit: world.ts (T034)
 *
 * The prepared world for scenario tests: two tenants with the SAME user id strings
 * (alice/bob/carol) reused in both, two typed resources per tenant, and a minted
 * AuthorizationContext per (tenant, user) via @dap/contracts/mint, timestamped by a
 * FakeClock so the world is fully deterministic.
 */
import type {
  AuditAppendOptions,
  AuditSink,
  ActionId,
  AuditEvent,
  AuditEventType,
  AuthorizationContext,
  AuthenticatedPrincipal,
  CapabilityTraits,
  ExecutionResult,
  GatewayConfig,
  GatewayDependencies,
  PageId,
  PermissionId,
  PlannerFeedback,
  PlannerRunMeta,
  PolicyGateway,
  ProposalCall,
  ProposalSubmitter,
  RateLimitResult,
  ReplayGuard,
  ResolvedResource,
  ResourceRef,
  SessionId,
  TenantId,
  UserId,
} from "@dap/contracts";
import type { ZodType } from "zod";
import { isMintedContext, mintAuthorizationContext } from "@dap/contracts/mint";
import {
  bindExecutors, buildRegistry, createPolicyGateway, createSecurityContextFactory, DEFAULT_GATEWAY_CONFIG, InMemoryRateLimiter, InMemoryReplayGuard, validateGatewayConfig,
} from "@dap/security";
import { InMemoryAuditSink } from "./audit-capture.js";
import { FakeClock } from "./clock.js";
import { faulty } from "./fault-injection.js";
import type { FaultMode } from "./fault-injection.js";
import { FakePageContextProvider, FakePermissionChecker } from "./host-fakes.js";
import { IdGenerator } from "./ids.js";
import { RecordingExecutor } from "./recording-executor.js";
import { snapshotData } from "./snapshot.js";
import { ALL_TEST_CAPABILITIES, VALID_PARAMS } from "./test-capabilities/index.js";

/** Tenant A (fixed UUID constant). */
export const TENANT_A = "2b9f6c1a-5f2e-4e81-9c4d-1a2b3c4d5e6f" as TenantId;
/** Tenant B (fixed UUID constant). */
export const TENANT_B = "7d4a2e9b-8c13-4f72-a6b9-9e8d7c6b5a40" as TenantId;

/** The SAME user id strings are reused in both tenants (cross-tenant test material). */
export const ALICE = "alice" as UserId;
export const BOB = "bob" as UserId;
export const CAROL = "carol" as UserId;

/** Host-side role knowledge (AuthorizationContext itself never carries roles). */
export type UserRole = "admin" | "member" | "read-only";

export const USER_ROLES: readonly { readonly userId: UserId; readonly role: UserRole }[] = snapshotData([
  { userId: ALICE, role: "admin" },
  { userId: BOB, role: "member" },
  { userId: CAROL, role: "read-only" },
]);

/** Two typed resources in tenant A. */
export const TENANT_A_RESOURCES: readonly ResolvedResource[] = snapshotData([
  {
    ref: { type: "document", id: "doc-a-1" },
    tenantId: TENANT_A,
    displayName: "A: Quarterly report",
  },
  {
    ref: { type: "document", id: "doc-a-2" },
    tenantId: TENANT_A,
    displayName: "A: Onboarding guide",
  },
]);

/** Two typed resources in tenant B. */
export const TENANT_B_RESOURCES: readonly ResolvedResource[] = snapshotData([
  {
    ref: { type: "document", id: "doc-b-1" },
    tenantId: TENANT_B,
    displayName: "B: Sales pipeline",
  },
  {
    ref: { type: "document", id: "doc-b-2" },
    tenantId: TENANT_B,
    displayName: "B: Vendor list",
  },
]);

const clock = new FakeClock();
const TENANTS: readonly TenantId[] = [TENANT_A, TENANT_B];
const USERS: readonly UserId[] = [ALICE, BOB, CAROL];

function key(tenantId: TenantId, userId: UserId): string {
  return `${tenantId}\u0000${userId}`;
}

const mintedContexts = new Map<string, AuthorizationContext>();
for (const tenantId of TENANTS) {
  for (const userId of USERS) {
    const authenticatedAt = clock.now();
    clock.advance(3600);
    mintedContexts.set(
      key(tenantId, userId),
      mintAuthorizationContext({
        tenantId,
        userId,
        sessionId: `${tenantId}@${userId}` as SessionId,
        authenticatedAt,
        validUntil: clock.now(),
      }),
    );
  }
}

/**
 * The minted AuthorizationContext for one (tenant, user) pair.
 * @throws when the pair is not part of the prepared world.
 */
export function ctx(tenantId: TenantId, userId: UserId): AuthorizationContext {
  const found = mintedContexts.get(key(tenantId, userId));
  if (found === undefined) {
    throw new Error(`world: no minted context for tenant ${tenantId} / user ${userId}`);
  }
  return found;
}

// ---------------------------------------------------------------------------
// withGateway (T070): the minimal world for the REAL Policy Gateway
// ---------------------------------------------------------------------------

/** Whether a value is a context minted by the trusted runtime (tests may not import the mint entry themselves). */
export const isMintedWorldContext = (value: unknown): boolean => isMintedContext(value);

/** The two tenants of the world. */
export type WorldTenant = "A" | "B";
/** A trusted test user in one tenant. `session` (default `session-<user>`) is both the authenticated session id and the AI session id. */
export interface WorldUser {
  readonly tenant: WorldTenant;
  readonly user: string;
  readonly session?: string;
}
/** Per-submitter settings: which AI turn, how deep in a chain, which Gateway replica, how long the authenticated session lasts. */
export interface WorldSubmitterOptions {
  readonly turn?: string;
  readonly depth?: number;
  readonly model?: string;
  /** Which Gateway instance over the SAME shared state (default 1). A new number starts a new replica. */
  readonly instance?: number;
  /** Length of the authenticated session in seconds (default: the world's `sessionSeconds`). */
  readonly sessionSeconds?: number;
}
/** What a user's bound submitter gives a test: the one submitter the planner would have, plus the trusted context and run it is bound to. */
export interface WorldSubmitter extends ProposalSubmitter {
  /** The minted context the Gateway checks every proposal against. */
  readonly context: AuthorizationContext;
  readonly run: PlannerRunMeta;
}
/** Host ports a test may fault. */
export type WorldPort = "authentication" | "permissions" | "resources" | "pages" | "replay" | "rateLimiter" | "tenantPolicy" | "audit" | "clock";
export type WorldResourceKind = "other-tenant" | "nonexistent" | "same-tenant-unauthorized";

export interface GatewayWorldOptions {
  /** Trusted test-only MEDIUM opt-out, with its written justification; the real registry and risk gate still decide. */
  readonly mediumConfirmationJustification?: string;
  /** The validated gateway configuration (default: DEFAULT_GATEWAY_CONFIG). */
  readonly config?: GatewayConfig;
  /** What every executor answers (default success). */
  readonly executorResult?: ExecutionResult;
  /** Seed of the deterministic id generator (default 117). */
  readonly seed?: number;
  /** ISO instant the fake clock starts at (default 2026-01-01T00:00:00Z). */
  readonly startAt?: string;
  /** Default length of an authenticated session in seconds (default 3600). */
  readonly sessionSeconds?: number;
  /**
   * An audit sink the Gateway writes to FIRST (for example the PostgreSQL store). The world's own capture, which `events()` reads, records an event only after
   * this sink has committed it, so `events()` holds exactly what was durably written, and a failing sink fails the append like any audit failure.
   */
  readonly auditSink?: AuditSink;
  /** Replace the input schema of named test capabilities (for example the PARAMS fixture schema with nesting). The sample parameters of `proposal()` must still parse. */
  readonly inputSchemas?: Readonly<Record<string, ZodType>>;
  /** Every user holds every permission (default false: only the users listed in `WORLD_PERMISSIONS`). */
  readonly openPermissions?: boolean;
  /** A replay guard to use instead of the in-memory one (for example the PostgreSQL guard); it is built from the world's clock when given as a factory. */
  readonly replay?: ReplayGuard | ((clock: FakeClock) => ReplayGuard);
}

/** The shared-state traffic the world has seen, for the tests that bound it. */
export interface GatewayWorldStats {
  readonly permissionCalls: number;
  readonly resourceCalls: number;
  readonly pageCalls: number;
  /** Calls to the shared replay and rate-limit store (the limiter's local pre-check makes none). */
  readonly sharedStoreCalls: number;
  readonly replayClaims: readonly { readonly tenantId: string; readonly key: string; readonly answer: string }[];
}

export interface EventFilter { readonly type?: AuditEventType; readonly requestId?: string; readonly actionId?: string; readonly userId?: string }

/** The compatible-by-name surface of the attack scenarios' targets (PrivilegeTarget, TenantAttackTarget) plus the plain ScenarioTarget members. */
export interface WorldTarget extends CapabilityTraits {
  readonly planner: { readonly script: readonly ProposalCall[] };
  readonly executor: RecordingExecutor;
  readonly audit: InMemoryAuditSink;
  readonly visibleOutput: unknown;
  submit(call: ProposalCall): Promise<PlannerFeedback>;
  validProposal(): unknown;
  setPermissionAnswer(answer: unknown): void;
  setReportedPage(page: string | null): void;
  expireSession(): void;
  resourceProposal(kind: WorldResourceKind): unknown;
  setResourceAnswer(answer: unknown): void;
  foreignResource(): unknown;
  readonly foreignDisplayNames: readonly string[];
}

export interface GatewayWorld {
  /** The world's own clock; it moves only through `advanceClock` (and `expireSession`). */
  readonly clock: FakeClock;
  readonly config: GatewayConfig;
  /** The captured audit sink of the current state (replaced by `reset`). */
  readonly audit: InMemoryAuditSink;
  /** The real dependencies the Gateway was built from, for a test that needs a second Gateway over the same host ports. */
  readonly deps: GatewayDependencies;
  readonly tenants: Readonly<Record<WorldTenant, TenantId>>;

  /** A submitter bound to this user's real, established session. Rejects when the session is refused or already expired. */
  submitterFor(who: WorldUser, options?: WorldSubmitterOptions): Promise<WorldSubmitter>;
  /** `submitterFor(who).submit(call)` in one step. */
  submit(who: WorldUser, call: ProposalCall, options?: WorldSubmitterOptions): Promise<PlannerFeedback>;
  /** A valid proposal for a test capability: its sample parameters, with a deterministic call id (`callId`, or the next `call-<n>`). */
  proposal(actionId: string, callId?: string): ProposalCall;
  /** A valid proposal for a resource-targeting capability aimed at a resource of the given kind, as seen from `tenant` (default A). */
  resourceProposal(actionId: string, kind: WorldResourceKind, tenant?: WorldTenant, callId?: string): ProposalCall;

  /** The recording executor of one capability. */
  executor(actionId: string): RecordingExecutor;
  /** Calls that reached the body of one capability's executor, or of all of them. */
  executorCalls(actionId?: string): number;
  /** The captured audit events, optionally filtered. */
  events(filter?: EventFilter): readonly AuditEvent[];
  /** The events of one request (proposal), in order. */
  eventsFor(requestId: string): readonly AuditEvent[];
  /** The request ids seen so far, in order of first appearance. */
  requestIds(): readonly string[];
  /** Events recorded after the first `mark` events: `const mark = world.events().length; ...; world.eventsSince(mark)`. */
  eventsSince(mark: number): readonly AuditEvent[];
  stats(): GatewayWorldStats;

  grantPermission(who: WorldUser, permission: string): void;
  revokePermission(who: WorldUser, permission: string): void;
  /** Make the host's permission hook answer exactly `answer` (any value, `undefined` included) to every question, until `clearPermissionAnswer`. */
  setPermissionAnswer(answer: unknown): void;
  /** Make the host's permission hook throw an error with exactly this message (`undefined` stops it), for the tests that plant a secret in a dependency failure. */
  failPermissionsWith(message: string | undefined): void;
  /** Remove the `setPermissionAnswer` override: the host's real grants answer again. */
  clearPermissionAnswer(): void;
  /** Make the host's page provider report `page`. */
  setReportedPage(page: string | null): void;
  /** Make the host's resource check answer exactly `answer` (null, a resolved resource, or any other value) to every question, until `clearResourceAnswer`. */
  setResourceAnswer(answer: unknown): void;
  /** Remove the `setResourceAnswer` override: the host's real resource table answers again. */
  clearResourceAnswer(): void;
  /** Hide a resource from one user (or from everyone in the tenant when `user` is omitted) while it still exists in the tenant. */
  denyResource(tenant: WorldTenant, ref: ResourceRef, user?: string): void;
  /** What the host's resource check returns for a resource of the OTHER tenant: a resolved resource of that tenant. */
  foreignResource(from: WorldTenant): ResolvedResource;
  /** Display names planted in the other tenant's resources. */
  foreignDisplayNames(from: WorldTenant): readonly string[];
  /**
   * Remove (or restore) a capability from the GLOBAL allowlist. The Gateway reads the allowlist when it is built, so every Gateway replica is dropped;
   * a submitter bound before the call keeps the old Gateway, so bind again (a target's `submit` always does).
   */
  setGloballyEnabled(actionId: string, enabled: boolean): void;
  /** Disable (or re-enable) a capability for one tenant. */
  disableCapability(tenant: WorldTenant, actionId: string, disabled?: boolean): void;
  /** Move the clock past the end of this user's session (and of every session established so far). */
  expireSession(who: WorldUser): void;
  /** Make the authentication port refuse this user from now on; an already bound submitter keeps its context until it expires. */
  refuseSession(who: WorldUser): void;
  /** Fault a named host port with the testkit's `faulty()` wrapper. `bucketPrefix` limits a rate-limiter fault to buckets starting with it. */
  injectFault(port: WorldPort, mode: FaultMode, options?: { readonly bucketPrefix?: string }): void;
  clearFault(port: WorldPort): void;
  advanceClock(seconds: number): void;
  /** Drop a Gateway replica so that the next submitter on that instance gets a new one over the same shared state. */
  restart(instance?: number): void;
  /** Back to the initial world: fresh audit, executors, replay and limiter state, default permissions, no faults, a new clock. Earlier submitters are void. */
  reset(): void;
  /** One capability and one user as a scenario target, with the method names of the attack scenarios' PrivilegeTarget and TenantAttackTarget. */
  targetFor(actionId: string, who?: WorldUser, options?: WorldSubmitterOptions): WorldTarget;
}

/**
 * Limits wide enough that a batch scenario (dozens of denials in one turn) is never throttled, so every answer is the pipeline's own.
 * The default denial throttle is 5 denials per 60 seconds. Pass it as `withGateway({ config: WIDE_GATEWAY_CONFIG })`.
 */
export const WIDE_GATEWAY_CONFIG: GatewayConfig = validateGatewayConfig({
  ...DEFAULT_GATEWAY_CONFIG,
  limits: {
    ...DEFAULT_GATEWAY_CONFIG.limits, proposalsPerTurn: 500, perUserPerMinute: { limit: 5000, windowSeconds: 60 }, perTenantPerMinute: { limit: 50000, windowSeconds: 60 },
    perUserPerCapabilityPerMinute: { limit: 5000, windowSeconds: 60 }, denialThrottle: { denials: 5000, windowSeconds: 60, blockSeconds: 300 },
  },
});

/** What each default user holds in each tenant: alice everything, bob the SAFE, LOW and MEDIUM capabilities, carol nothing. */
export const WORLD_PERMISSIONS: Readonly<Record<string, readonly string[]>> = Object.freeze({
  [ALICE]: Object.freeze(ALL_TEST_CAPABILITIES.map((definition) => definition.requiredPermission as string)),
  [BOB]: Object.freeze(ALL_TEST_CAPABILITIES.filter((definition) => ["SAFE", "LOW", "MEDIUM"].includes(definition.risk)).map((definition) => definition.requiredPermission as string)),
  [CAROL]: Object.freeze([]),
});

/** Registered in both tenants under the SAME id (`doc-1`, the sample parameters' document), so tenant scoping is observable. */
const SHARED_DOCUMENT = "doc-1";
const RESTRICTED_DOCUMENT = "doc-restricted";
const NO_SUCH_DOCUMENT = "doc-does-not-exist";

export function withGateway(options: GatewayWorldOptions = {}): GatewayWorld {
  const config = validateGatewayConfig(options.config ?? DEFAULT_GATEWAY_CONFIG);
  const tenants = Object.freeze({ A: TENANT_A, B: TENANT_B } as const);
  const resourcesOf = (tenant: WorldTenant): readonly ResolvedResource[] => {
    const own = tenant === "A" ? TENANT_A_RESOURCES : TENANT_B_RESOURCES;
    const display = (suffix: string): string => `${tenant}: ${suffix}`;
    const extra = (id: string, name: string): ResolvedResource => snapshotData({ ref: { type: "document", id }, tenantId: tenants[tenant], displayName: display(name) });
    return [...own, extra(SHARED_DOCUMENT, "Shared-name document"), extra(RESTRICTED_DOCUMENT, "Restricted document")];
  };
  const tenantKey = (tenant: WorldTenant | TenantId): TenantId => (tenant === "A" ? TENANT_A : tenant === "B" ? TENANT_B : tenant);

  /** Everything that `reset()` replaces. */
  function build() {
    const clock = new FakeClock(options.startAt);
    const audit = new InMemoryAuditSink();
    const ids = new IdGenerator(options.seed ?? 117);
    const permissions = new FakePermissionChecker();
    for (const tenantId of [TENANT_A, TENANT_B]) for (const [user, held] of Object.entries(WORLD_PERMISSIONS)) for (const permission of held) permissions.grant(user as UserId, permission as PermissionId, tenantId);
    const pages = new FakePageContextProvider();
    const stats = { permissionCalls: 0, resourceCalls: 0, sharedStoreCalls: 0, replayClaims: [] as { tenantId: string; key: string; answer: string }[] };
    const controls = {
      permissionAnswer: undefined as unknown, permissionOverride: false, permissionFailure: undefined as string | undefined,
      resourceAnswer: undefined as unknown, resourceOverride: false,
      denied: new Set<string>(), disabled: new Set<string>(), refused: new Set<string>(),
      faults: new Map<WorldPort, { mode: FaultMode; bucketPrefix?: string }>(),
      resourceTable: new Map<string, ResolvedResource>(),
    };
    for (const tenant of ["A", "B"] as const) for (const resource of resourcesOf(tenant)) controls.resourceTable.set(JSON.stringify([tenants[tenant], resource.ref.type, resource.ref.id]), resource);
    controls.denied.add(JSON.stringify([TENANT_A, "*", "document", RESTRICTED_DOCUMENT]));
    controls.denied.add(JSON.stringify([TENANT_B, "*", "document", RESTRICTED_DOCUMENT]));

    const replayBase = typeof options.replay === "function" ? options.replay(clock) : options.replay ?? new InMemoryReplayGuard(clock);
    const limiterBase = new InMemoryRateLimiter(clock);
    const faultFor = (port: WorldPort, bucket?: string): FaultMode | undefined => {
      const fault = controls.faults.get(port);
      if (fault === undefined) return undefined;
      return fault.bucketPrefix === undefined || (bucket !== undefined && bucket.startsWith(fault.bucketPrefix)) ? fault.mode : undefined;
    };
    /** Calls the faulted version of a port's method when a fault is injected for it, else the real one. */
    const through = <P extends object>(port: WorldPort, real: P, method: keyof P & string, bucket?: string) => (...args: unknown[]): unknown => {
      const mode = faultFor(port, bucket);
      const target = mode === undefined ? real : (faulty(real, mode) as P);
      return Reflect.apply((target as Record<string, unknown>)[method] as (...a: unknown[]) => unknown, target, args);
    };

    const permissionPort = {
      async has(context: AuthorizationContext, permission: PermissionId): Promise<boolean> {
        stats.permissionCalls++;
        if (controls.permissionFailure !== undefined) throw new Error(controls.permissionFailure);
        if (controls.permissionOverride) return controls.permissionAnswer as boolean;
        if (options.openPermissions === true) return true;
        return permissions.has(context, permission);
      },
    };
    const resourcePort = {
      async resolve(context: AuthorizationContext, ref: ResourceRef): Promise<ResolvedResource | null> {
        stats.resourceCalls++;
        if (controls.resourceOverride) return controls.resourceAnswer as ResolvedResource | null;
        const found = controls.resourceTable.get(JSON.stringify([context.tenantId, ref.type, ref.id])) ?? null;
        if (found === null) return null;
        const hidden = controls.denied.has(JSON.stringify([context.tenantId, "*", ref.type, ref.id])) || controls.denied.has(JSON.stringify([context.tenantId, context.userId, ref.type, ref.id]));
        return hidden ? null : found;
      },
    };
    const replayPort = {
      async claim(...args: Parameters<ReplayGuard["claim"]>) {
        stats.sharedStoreCalls++;
        const answer = await replayBase.claim(...args);
        stats.replayClaims.push({ tenantId: args[0].tenantId, key: args[1], answer });
        return answer;
      },
    };
    const limiterPort = {
      async hit(...args: Parameters<InMemoryRateLimiter["hit"]>): Promise<RateLimitResult> { stats.sharedStoreCalls++; return limiterBase.hit(...args); },
      async isBlocked(...args: Parameters<InMemoryRateLimiter["isBlocked"]>) { stats.sharedStoreCalls++; return limiterBase.isBlocked(...args); },
      async block(...args: Parameters<InMemoryRateLimiter["block"]>) { stats.sharedStoreCalls++; return limiterBase.block(...args); },
    };
    const tenantPolicyPort = { async isDisabled(scope: { tenantId: TenantId }, actionId: ActionId): Promise<boolean> { return controls.disabled.has(JSON.stringify([scope.tenantId, actionId])); } };
    const unused = async (): Promise<never> => { throw new Error("world: the confirmation store is unused until the confirmation service exists"); };

    const definitions = ALL_TEST_CAPABILITIES.map((definition) => {
      const schema = options.inputSchemas?.[definition.id as string];
      const trusted = options.mediumConfirmationJustification !== undefined && definition.id === "testMediumDraft" ? { ...definition, confirmation: { kind: "not-required" as const, justification: options.mediumConfirmationJustification } } : definition;
      return schema === undefined ? trusted : { ...trusted, inputSchema: schema };
    }) as unknown as typeof ALL_TEST_CAPABILITIES;
    const registry = buildRegistry(definitions);
    const executable = definitions.filter((definition) => definition.risk !== "FORBIDDEN");
    const recorders = new Map<string, RecordingExecutor>(executable.map((definition) => [definition.id as string, new RecordingExecutor({ id: definition.executorId, result: options.executorResult ?? { status: "success" } })]));
    const globalAllowlist = new Set(executable.map((definition) => definition.id as ActionId));
    const deps: GatewayDependencies = {
      registry, executors: bindExecutors(registry, [...recorders.values()].map((recorder) => recorder.executor)),
      globalAllowlist,
      hooks: {
        permissions: { has: through("permissions", permissionPort, "has") as never },
        resources: { resolve: through("resources", resourcePort, "resolve") as never },
        pages: { currentPage: through("pages", { currentPage: async (...a: Parameters<FakePageContextProvider["currentPage"]>) => pages.currentPage(...a) }, "currentPage") as never },
      },
      state: {
        replay: { claim: through("replay", replayPort, "claim") as never },
        rateLimiter: {
          hit: ((...args: [unknown, string, unknown]) => through("rateLimiter", limiterPort, "hit", args[1])(...args)) as never,
          isBlocked: ((...args: [unknown, string]) => through("rateLimiter", limiterPort, "isBlocked", args[1])(...args)) as never,
          block: ((...args: [unknown, string, unknown]) => through("rateLimiter", limiterPort, "block", args[1])(...args)) as never,
        },
        tenantPolicy: { isDisabled: through("tenantPolicy", tenantPolicyPort, "isDisabled") as never },
        confirmations: { create: unused, get: unused, listPending: unused, tryAccept: unused, tryReject: unused, invalidate: unused, recordExecution: unused } as never,
        ping: async () => true,
      },
      audit: { append: through("audit", { append: async (event: AuditEvent, appendOptions?: AuditAppendOptions) => { if (options.auditSink !== undefined) await options.auditSink.append(event, appendOptions); await audit.append(event); } }, "append") as never },
      confirmationChannel: { deliver: unused },
      clock: { now: through("clock", { now: () => clock.now() }, "now") as never },
      ids, config,
    };
    const authenticationPort = {
      async authenticate(evidence: string): Promise<AuthenticatedPrincipal | null> {
        const [tenant, user, session, seconds] = JSON.parse(evidence) as [TenantId, string, string, number];
        if (controls.refused.has(JSON.stringify([tenant, user]))) return null;
        const authenticatedAt = clock.now();
        return { userId: user as UserId, tenantId: tenant, sessionId: session as SessionId, authenticatedAt, validUntil: new Date(Date.parse(authenticatedAt) + seconds * 1000).toISOString() as AuthenticatedPrincipal["validUntil"] };
      },
    };
    const factory = createSecurityContextFactory({
      authentication: { authenticate: through("authentication", authenticationPort, "authenticate") as never },
      clock: { now: through("clock", { now: () => clock.now() }, "now") as never },
    });
    return { clock, audit, ids, globalAllowlist, permissions, pages, stats, controls, deps, recorders, factory, gateways: new Map<number, PolicyGateway>(), contexts: new Map<string, AuthorizationContext>(), turns: new Map<string, string>(), counter: { calls: 0 }, latestEnd: { ms: 0 } };
  }

  let state = build();
  const sessionSeconds = options.sessionSeconds ?? 3600;
  const sessionOf = (who: WorldUser): string => who.session ?? `session-${who.user}`;
  const traitsOf = (actionId: string): CapabilityTraits => {
    const definition = state.deps.registry.get(actionId as ActionId)?.definition;
    if (definition === undefined) throw new Error(`world: no test capability ${actionId}`);
    return { actionId, risk: definition.risk, changesState: definition.changesState, targetsResource: typeof definition.resource === "function", requiresConfirmation: definition.confirmation.kind === "required" };
  };
  const params = (actionId: string): Record<string, unknown> => {
    const sample = (VALID_PARAMS as Record<string, unknown>)[actionId];
    if (sample === undefined) throw new Error(`world: no sample parameters for ${actionId}`);
    return JSON.parse(JSON.stringify(sample)) as Record<string, unknown>;
  };
  const nextCallId = (): string => `call-${++state.counter.calls}`;

  const world: GatewayWorld = {
    get clock() { return state.clock; },
    get config() { return config; },
    get audit() { return state.audit; },
    get deps() { return state.deps; },
    tenants,

    async submitterFor(who, submitterOptions = {}) {
      const current = state;
      const seconds = submitterOptions.sessionSeconds ?? sessionSeconds;
      const key = JSON.stringify([tenantKey(who.tenant), who.user, sessionOf(who), seconds]);
      let context = current.contexts.get(key);
      if (context === undefined) {
        const established = await current.factory.establish(JSON.stringify([tenantKey(who.tenant), who.user, sessionOf(who), seconds]));
        if (established === null) throw new Error(`world: the session of ${who.user} in tenant ${who.tenant} was refused or has expired`);
        context = established;
        current.contexts.set(key, context);
        current.latestEnd.ms = Math.max(current.latestEnd.ms, Date.parse(context.validUntil));
      }
      const turn = submitterOptions.turn ?? "turn-1";
      const turnKey = JSON.stringify([key, turn]);
      let started = current.turns.get(turnKey);
      if (started === undefined) { started = current.clock.now(); current.turns.set(turnKey, started); }
      const run: PlannerRunMeta = Object.freeze({ aiSessionId: sessionOf(who), turnId: turn, model: submitterOptions.model ?? "scripted", depth: submitterOptions.depth ?? 0, turnStartedAt: started as PlannerRunMeta["turnStartedAt"] });
      const instance = submitterOptions.instance ?? 1;
      let gateway = current.gateways.get(instance);
      if (gateway === undefined) { gateway = createPolicyGateway(current.deps).proposals; current.gateways.set(instance, gateway); }
      const bound = gateway.forSession(context, run);
      return Object.freeze({ submit: bound.submit, context, run });
    },
    async submit(who, call, submitterOptions) { return (await world.submitterFor(who, submitterOptions)).submit(call); },
    proposal(actionId, callId) { return { callId: callId ?? nextCallId(), raw: { action: actionId, params: params(actionId) } }; },
    resourceProposal(actionId, kind, tenant = "A", callId) {
      const sample = params(actionId);
      if (!("documentId" in sample)) throw new Error(`world: ${actionId} targets no document`);
      const other = tenant === "A" ? "doc-b-1" : "doc-a-1";
      sample.documentId = kind === "other-tenant" ? other : kind === "nonexistent" ? NO_SUCH_DOCUMENT : RESTRICTED_DOCUMENT;
      return { callId: callId ?? nextCallId(), raw: { action: actionId, params: sample } };
    },

    executor(actionId) {
      const found = state.recorders.get(actionId);
      if (found === undefined) throw new Error(`world: no executor is bound to ${actionId}`);
      return found;
    },
    executorCalls(actionId) { return actionId === undefined ? [...state.recorders.values()].reduce((total, recorder) => total + recorder.calls, 0) : world.executor(actionId).calls; },
    events(filter = {}) {
      return state.audit.events.filter((event) => (filter.type === undefined || event.type === filter.type) && (filter.requestId === undefined || event.requestId === filter.requestId) &&
        (filter.actionId === undefined || event.actionId === filter.actionId) && (filter.userId === undefined || event.userId === filter.userId));
    },
    eventsFor(requestId) { return world.events({ requestId }); },
    requestIds() { return [...new Set(state.audit.events.map((event) => event.requestId as string))]; },
    eventsSince(mark) { return state.audit.events.slice(mark); },
    stats() { return Object.freeze({ permissionCalls: state.stats.permissionCalls, resourceCalls: state.stats.resourceCalls, pageCalls: state.pages.calls, sharedStoreCalls: state.stats.sharedStoreCalls, replayClaims: Object.freeze([...state.stats.replayClaims]) }); },

    grantPermission(who, permission) { state.permissions.grant(who.user as UserId, permission as PermissionId, tenantKey(who.tenant)); },
    revokePermission(who, permission) { state.permissions.revoke(who.user as UserId, permission as PermissionId, tenantKey(who.tenant)); },
    setPermissionAnswer(answer) { state.controls.permissionOverride = true; state.controls.permissionAnswer = answer; },
    failPermissionsWith(message) { state.controls.permissionFailure = message; },
    clearPermissionAnswer() { state.controls.permissionOverride = false; state.controls.permissionAnswer = undefined; },
    setReportedPage(page) { state.pages.setPage(page as PageId | null); },
    setResourceAnswer(answer) { state.controls.resourceOverride = true; state.controls.resourceAnswer = answer; },
    clearResourceAnswer() { state.controls.resourceOverride = false; state.controls.resourceAnswer = undefined; },
    denyResource(tenant, ref, user) { state.controls.denied.add(JSON.stringify([tenantKey(tenant), user ?? "*", ref.type, ref.id])); },
    foreignResource(from) { return structuredClone((from === "A" ? TENANT_B_RESOURCES : TENANT_A_RESOURCES)[0]!); },
    foreignDisplayNames(from) { return (from === "A" ? TENANT_B_RESOURCES : TENANT_A_RESOURCES).map((resource) => resource.displayName); },
    setGloballyEnabled(actionId, enabled) {
      if (enabled) state.globalAllowlist.add(actionId as ActionId); else state.globalAllowlist.delete(actionId as ActionId);
      state.gateways.clear();
    },
    disableCapability(tenant, actionId, disabled = true) {
      const key = JSON.stringify([tenantKey(tenant), actionId]);
      if (disabled) state.controls.disabled.add(key); else state.controls.disabled.delete(key);
    },
    expireSession(who) {
      void who;
      const end = Math.max(state.latestEnd.ms, Date.parse(state.clock.now()) + sessionSeconds * 1000);
      state.clock.advance((end - Date.parse(state.clock.now())) / 1000 + 1);
    },
    refuseSession(who) {
      state.controls.refused.add(JSON.stringify([tenantKey(who.tenant), who.user]));
      for (const key of [...state.contexts.keys()]) if ((JSON.parse(key) as unknown[])[0] === tenantKey(who.tenant) && (JSON.parse(key) as unknown[])[1] === who.user) state.contexts.delete(key);
    },
    injectFault(port, mode, faultOptions = {}) { state.controls.faults.set(port, { mode, ...(faultOptions.bucketPrefix === undefined ? {} : { bucketPrefix: faultOptions.bucketPrefix }) }); },
    clearFault(port) { state.controls.faults.delete(port); },
    advanceClock(seconds) { state.clock.advance(seconds); },
    restart(instance = 1) { state.gateways.delete(instance); },
    reset() { state = build(); },

    targetFor(actionId, who = { tenant: "A", user: ALICE }, submitterOptions = {}) {
      const traits = traitsOf(actionId);
      return Object.freeze({
        ...traits,
        planner: Object.freeze({ script: Object.freeze([]) as readonly ProposalCall[] }),
        get executor() { return world.executor(actionId); },
        get audit() { return state.audit; },
        visibleOutput: null,
        submit: async (call: ProposalCall) => (await world.submitterFor(who, submitterOptions)).submit(call),
        validProposal: () => world.proposal(actionId).raw,
        setPermissionAnswer: (answer: unknown) => world.setPermissionAnswer(answer),
        setReportedPage: (page: string | null) => world.setReportedPage(page),
        expireSession: () => world.expireSession(who),
        resourceProposal: (kind: WorldResourceKind) => world.resourceProposal(actionId, kind, who.tenant).raw,
        setResourceAnswer: (answer: unknown) => world.setResourceAnswer(answer),
        foreignResource: () => world.foreignResource(who.tenant),
        get foreignDisplayNames() { return world.foreignDisplayNames(who.tenant); },
      }) as WorldTarget;
    },
  };
  return world;
}
