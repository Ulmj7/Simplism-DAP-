import { z } from "zod";
import { RISK_LEVELS, type Clock, type IsoInstant, type LimitConfig, type RateLimiter, type RateLimitResult, type RateLimitRule, type ReasonCode, type RiskLevel, type TenantId, type TenantScope } from "@dap/contracts";
import { snapshotAnswer } from "../gateway/answer-snapshot.js";
import { assertTimeout, nativeTimer, underDeadline, type HookTimer } from "../gateway/deadline.js";
import { wrapHook } from "../gateway/hook-wrapper.js";
import { validateLimitConfig } from "./limit-config.js";

/**
 * Abuse controls over the RateLimiter port (research D12). A pure library: it returns verdicts and
 * the Gateway stages decide what to audit and how to answer the planner.
 *
 * Fail closed: ANY port fault (throw, hang past the deadline, wrong-typed or malformed answer, full
 * store) or unusable input yields a denial with reason `dependency_failure`, never an allow. Methods
 * never throw or reject.
 *
 * Tenant identity comes only from the trusted `scope`; bucket keys carry no tenant text, and every
 * identifier is percent-encoded so a delimiter inside an identifier cannot collide two buckets.
 *
 * Fixed windows are epoch-aligned, so a burst across a window edge can reach twice a limit
 * (documented limitation, D12). Turn buckets use the turn budget as their window.
 */
export type LimitKind =
  | "chain_depth" | "turn_budget" | "turn_proposals" | "turn_executions"
  | "tenant" | "user" | "capability" | "risk" | "denial_throttle" | "dependency_failure";

export type LimitVerdict =
  | Readonly<{ allowed: true }>
  | Readonly<{
    allowed: false; outcome: "DENIED"; reason: ReasonCode; limit: LimitKind; retryAfterSeconds: number | null;
    /**
     * Whether the stage should record this denial toward the throttle (`recordDenial`). False for
     * denials decided without the shared store (local checks, an active block, a fault): recording
     * them would cost a shared-store round trip per flooded request.
     */
    countsTowardThrottle: boolean;
  }>;

/** All identifiers come from the trusted context and runner, never from the planner. */
export interface ProposalLimitInput {
  readonly scope: TenantScope;
  readonly userId: string;
  readonly aiSessionId: string;
  readonly turnId: string;
  /** Runner-supplied: how many chained proposals this turn has already followed. */
  readonly chainDepth: number;
  /** Runner-supplied start of the turn, read against the injected clock. */
  readonly turnStartedAt: IsoInstant;
}
export interface TurnLimitInput { readonly scope: TenantScope; readonly aiSessionId: string; readonly turnId: string }
export interface CapabilityLimitInput { readonly scope: TenantScope; readonly userId: string; readonly actionId: string; readonly risk: RiskLevel }
export interface DenialInput { readonly scope: TenantScope; readonly aiSessionId: string }
export type DenialRecord = Readonly<{ recorded: true; throttled: boolean }> | Readonly<{ recorded: false }>;

export interface Limiter {
  /** Stage 2: denial-throttle block, depth, wall clock, per-turn proposals, tenant and user limits. */
  checkProposal(input: ProposalLimitInput): Promise<LimitVerdict>;
  /** Authorize stage: per-user per-capability limit and the HIGH/CRITICAL hourly limit. */
  checkCapability(input: CapabilityLimitInput): Promise<LimitVerdict>;
  /** Immediately before an executor may run: executions per turn. */
  claimExecution(input: TurnLimitInput): Promise<LimitVerdict>;
  /** Counts one denial toward the throttle and blocks the AI session when it is crossed. */
  recordDenial(input: DenialInput): Promise<DenialRecord>;
}

export interface LimiterOptions {
  readonly rateLimiter: RateLimiter;
  readonly config: LimitConfig;
  readonly clock: Clock;
  /** Deadline for each port call; default 2000 ms. */
  readonly timeoutMs?: number;
  readonly timer?: HookTimer;
  /** Per-replica cache of per-turn counts; active counts are never evicted; capacity exhaustion denies (default 10,000). */
  readonly maxLocalTurns?: number;
}

const instant = z.iso.datetime({ offset: true });
const uuid = z.uuid();
const MAX_IDENTIFIER = 256;
const MAX_KEY_BYTES = 1024;
const FAULT = Symbol("limiter fault");
type Fault = typeof FAULT;
const HIGH_RISK: ReadonlySet<RiskLevel> = new Set<RiskLevel>(["HIGH", "CRITICAL", "FORBIDDEN"]);

const ALLOW: LimitVerdict = Object.freeze({ allowed: true as const });
function deny(reason: ReasonCode, limit: LimitKind, retryAfterSeconds: number | null = null, countsTowardThrottle = false): LimitVerdict {
  return Object.freeze({ allowed: false as const, outcome: "DENIED" as const, reason, limit, retryAfterSeconds, countsTowardThrottle });
}
const FAULT_VERDICT = deny("dependency_failure", "dependency_failure");

function identifier(value: unknown): string {
  if (typeof value !== "string" || value.length < 1 || value.length > MAX_IDENTIFIER || value.includes("\u0000")) throw new TypeError("Invalid limiter identifier");
  return value;
}
function captureTenant(scope: unknown): TenantScope {
  const raw: unknown = (scope as { tenantId?: unknown } | null | undefined)?.tenantId;
  if (!uuid.safeParse(raw).success) throw new TypeError("Invalid limiter tenant");
  return Object.freeze({ tenantId: (raw as string).toLowerCase() as TenantId });
}
function key(...parts: string[]): string {
  const result = parts.map((part, index) => index === 0 ? part : encodeURIComponent(part)).join(":");
  if (Buffer.byteLength(result) > MAX_KEY_BYTES) throw new TypeError("Limiter key too long");
  return result;
}
function field(input: unknown, name: string): unknown {
  if (input === null || typeof input !== "object") throw new TypeError("Invalid limiter input");
  return (input as Record<string, unknown>)[name];
}
function boundedInteger(value: unknown, maximum: number, minimum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < minimum || value > maximum) throw new TypeError("Invalid limiter integer");
  return value;
}

interface LocalCount { count: number; pending: number; readonly expiresAt: number; denial?: LimitVerdict }
/** Keep active counts through the whole turn, including an epoch-window rollover. Full capacity fails closed. */
class LocalCounts {
  private readonly counts = new Map<string, LocalCount>();
  constructor(private readonly capacity: number, private readonly lifetimeMs: number) {}
  get(id: string, now: number): LocalCount {
    // Entries are in creation order with a fixed lifetime; the caller rejects a backward clock.
    for (const [key, entry] of this.counts) {
      if (entry.expiresAt >= now) break;
      this.counts.delete(key);
    }
    const existing = this.counts.get(id);
    if (existing) return existing;
    if (this.counts.size >= this.capacity) throw new Error("Local turn capacity exhausted");
    const entry: LocalCount = { count: 0, pending: 0, expiresAt: now + this.lifetimeMs };
    this.counts.set(id, entry);
    return entry;
  }
}

export function createLimiter(options: LimiterOptions): Limiter {
  const config = validateLimitConfig(options?.config);
  const store: unknown = options?.rateLimiter;
  const clock: unknown = options?.clock;
  const has = (target: unknown, name: string): boolean => target !== null && typeof target === "object" && typeof (target as Record<string, unknown>)[name] === "function";
  if (!has(store, "hit") || !has(store, "isBlocked") || !has(store, "block")) throw new TypeError("A RateLimiter is required");
  if (!has(clock, "now")) throw new TypeError("A Clock is required");
  const port = store as RateLimiter;
  const clockPort = clock as Clock;
  const timeoutMs = options.timeoutMs ?? 2000;
  assertTimeout(timeoutMs, "limiter");
  const timer = options.timer ?? nativeTimer;
  const maxLocalTurns = boundedInteger(options.maxLocalTurns ?? 10_000, 1_000_000, 1);

  const turnWindowSeconds = Math.ceil(config.turnBudgetMs / 1000);
  const turnProposalRule: RateLimitRule = Object.freeze({ limit: config.proposalsPerTurn, windowSeconds: turnWindowSeconds });
  const turnExecutionRule: RateLimitRule = Object.freeze({ limit: config.executionsPerTurn, windowSeconds: turnWindowSeconds });
  const denialRule: RateLimitRule = Object.freeze({ limit: config.denialThrottle.denials, windowSeconds: config.denialThrottle.windowSeconds });
  const tenantRule = config.perTenantPerMinute;
  const userRule = config.perUserPerMinute;
  const capabilityRule = config.perUserPerCapabilityPerMinute;
  const riskRule = config.highRiskPerUserPerHour;
  const proposalCounts = new LocalCounts(maxLocalTurns, config.turnBudgetMs);
  const executionCounts = new LocalCounts(maxLocalTurns, config.turnBudgetMs);

  let lastNow = Number.NEGATIVE_INFINITY;
  function now(): number {
    const raw: unknown = clockPort.now();
    if (!instant.safeParse(raw).success) {
      void Promise.resolve(raw).catch(() => undefined);
      throw new TypeError("Invalid limiter clock");
    }
    const ms = Date.parse(raw as string);
    if (!Number.isFinite(ms) || ms < lastNow) throw new TypeError("Invalid limiter clock");
    lastNow = ms;
    return ms;
  }
  const guarded = <R>(call: () => unknown, accept: (answer: unknown) => R): Promise<R | Fault> =>
    underDeadline<R | Fault>(call, (raw) => accept(snapshotAnswer(raw)), () => FAULT, timeoutMs, timer);
  const hitAnswer = z.strictObject({ allowed: z.boolean(), retryAfterSeconds: z.number().int().nonnegative() });
  const readHit = (answer: unknown): RateLimitResult => hitAnswer.parse(answer);
  const hit = (scope: TenantScope, bucket: string, rule: RateLimitRule): Promise<RateLimitResult | Fault> => guarded(() => port.hit(scope, bucket, rule), readHit);
  const blocked = (scope: TenantScope, bucket: string): Promise<boolean | Fault> => guarded(() => port.isBlocked(scope, bucket), (answer) => {
    if (typeof answer !== "boolean") throw new TypeError("Invalid block answer");
    return answer;
  });
  const block = async (scope: TenantScope, bucket: string, seconds: number): Promise<true | Fault> => {
    const answer = await wrapHook(() => port.block(scope, bucket, seconds), "void", { hookTimeoutMs: timeoutMs, timer })();
    return answer.ok ? true : FAULT;
  };
  /** Undefined means the hit was within the limit; anything else is the denial to return. */
  async function consume(scope: TenantScope, bucket: string, rule: RateLimitRule, reason: ReasonCode, limit: LimitKind): Promise<LimitVerdict | undefined> {
    const result = await hit(scope, bucket, rule);
    if (result === FAULT) return FAULT_VERDICT;
    return result.allowed ? undefined : deny(reason, limit, result.retryAfterSeconds, true);
  }
  const turnLocalKey = (tenant: TenantScope, session: string, turn: string): string => JSON.stringify([tenant.tenantId, session, turn]);

  async function checkProposal(input: ProposalLimitInput): Promise<LimitVerdict> {
    try {
      const scope = captureTenant(field(input, "scope"));
      const userId = identifier(field(input, "userId"));
      const session = identifier(field(input, "aiSessionId"));
      const turn = identifier(field(input, "turnId"));
      const depth = boundedInteger(field(input, "chainDepth"), Number.MAX_SAFE_INTEGER, 0);
      const startedRaw = field(input, "turnStartedAt");
      if (!instant.safeParse(startedRaw).success) throw new TypeError("Invalid turn start");
      const startedAt = Date.parse(startedRaw as string);
      const turnBucket = key("turn:proposals", session, turn);
      const userBucket = key("user", userId);
      const denyBucket = key("deny", session);
      const localKey = turnLocalKey(scope, session, turn);

      if (depth > config.maxChainDepth) return deny("rate_limited_turn", "chain_depth");
      const time = now();
      const elapsed = time - startedAt;
      if (elapsed < 0) return FAULT_VERDICT;
      if (elapsed > config.turnBudgetMs) return deny("rate_limited_turn", "turn_budget");
      const local = proposalCounts.get(localKey, time);
      // A shared block or fault remains fail-closed for this turn; a new turn retries the store.
      if (local.denial) return local.denial;

      if (local.count + local.pending >= config.proposalsPerTurn) return deny("rate_limited_turn", "turn_proposals");
      local.pending++;
      let pending = true;
      try {
        const throttled = await blocked(scope, denyBucket);
        if (throttled === FAULT) return local.denial = FAULT_VERDICT;
        if (throttled) return local.denial = deny("denial_throttle", "denial_throttle");
        // Reserve and issue the shared hit in one synchronous step; an active local count is never evicted.
        local.pending--; pending = false;
        local.count++;
        const verdict = await consume(scope, turnBucket, turnProposalRule, "rate_limited_turn", "turn_proposals")
          ?? await consume(scope, "tenant", tenantRule, "rate_limited_tenant", "tenant")
          ?? await consume(scope, userBucket, userRule, "rate_limited_user", "user")
          ?? ALLOW;
        if (!verdict.allowed && verdict.reason === "dependency_failure") local.denial = verdict;
        return verdict.allowed && now() - startedAt > config.turnBudgetMs ? deny("rate_limited_turn", "turn_budget") : verdict;
      } finally { if (pending) local.pending--; }
    } catch { return FAULT_VERDICT; }
  }

  async function checkCapability(input: CapabilityLimitInput): Promise<LimitVerdict> {
    try {
      const scope = captureTenant(field(input, "scope"));
      const userId = identifier(field(input, "userId"));
      const actionId = identifier(field(input, "actionId"));
      const risk = field(input, "risk");
      if (typeof risk !== "string" || !(RISK_LEVELS as readonly string[]).includes(risk)) throw new TypeError("Invalid risk level");
      const capabilityBucket = key("cap", userId, actionId);
      const riskBucket = key("risk", userId);
      return await consume(scope, capabilityBucket, capabilityRule, "rate_limited_capability", "capability")
        ?? (HIGH_RISK.has(risk as RiskLevel) ? await consume(scope, riskBucket, riskRule, "rate_limited_risk", "risk") : undefined)
        ?? ALLOW;
    } catch { return FAULT_VERDICT; }
  }

  async function claimExecution(input: TurnLimitInput): Promise<LimitVerdict> {
    try {
      const scope = captureTenant(field(input, "scope"));
      const session = identifier(field(input, "aiSessionId"));
      const turn = identifier(field(input, "turnId"));
      const bucket = key("turn:executions", session, turn);
      const localKey = turnLocalKey(scope, session, turn);
      const local = executionCounts.get(localKey, now());
      if (local.count >= config.executionsPerTurn) return deny("rate_limited_turn", "turn_executions");
      local.count++;
      return await consume(scope, bucket, turnExecutionRule, "rate_limited_turn", "turn_executions") ?? ALLOW;
    } catch { return FAULT_VERDICT; }
  }

  async function recordDenial(input: DenialInput): Promise<DenialRecord> {
    try {
      const scope = captureTenant(field(input, "scope"));
      const bucket = key("deny", identifier(field(input, "aiSessionId")));
      const counted = await hit(scope, bucket, denialRule);
      if (counted === FAULT) return Object.freeze({ recorded: false as const });
      // The throttle is crossed by the denial after the configured number: the port reports
      // "not allowed" once the count exceeds the limit.
      if (counted.allowed) return Object.freeze({ recorded: true as const, throttled: false });
      const placed = await block(scope, bucket, config.denialThrottle.blockSeconds);
      return placed === FAULT ? Object.freeze({ recorded: false as const }) : Object.freeze({ recorded: true as const, throttled: true });
    } catch { return Object.freeze({ recorded: false as const }); }
  }

  return Object.freeze({ checkProposal, checkCapability, claimExecution, recordDenial });
}
