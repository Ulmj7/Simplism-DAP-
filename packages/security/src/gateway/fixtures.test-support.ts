import { z } from "zod";
import { defineAction, defineExecutor } from "@dap/contracts";
import type { ActionId, ExecutorId, GatewayDependencies, IsoInstant, PermissionId, PipelineStage, PlannerRunMeta, RequestId } from "@dap/contracts";
import { mintAuthorizationContext } from "@dap/contracts/mint";
import { InMemoryReplayGuard } from "../state/memory/replay.js";
import { InMemoryRateLimiter } from "../state/memory/rate-limiter.js";
import { buildRegistry } from "../registry/build-registry.js";
import { bindExecutors } from "../registry/bind-executors.js";
import type { PipelineInput, PolicyStage, StageMap } from "./pipeline.js";

export const now = "2026-01-01T00:00:00Z" as IsoInstant;
export const context = () => mintAuthorizationContext({ userId: "alice", tenantId: "00000000-0000-4000-8000-000000000001", sessionId: "session", authenticatedAt: now, validUntil: "2026-01-01T01:00:00Z" });
export const run: PlannerRunMeta = { aiSessionId: "ai-session", turnId: "turn", model: "model", depth: 0, turnStartedAt: now };
export const input = (name = "request"): PipelineInput => ({ context: context(), run, decisionId: `decision-${name}`, requestId: name as RequestId, readProposal: () => ({ callId: name, raw: { action: "viewProject", params: {} } }) });
export const pass: PolicyStage = () => ({ kind: "continue", data: {} });
export function stageMap(terminal: PolicyStage): StageMap {
  return Object.fromEntries(["context", "intake", "rate_limit", "replay", "resolve", "validate", "authorize", "risk", "confirmation", "audit", "execute"].map((name) => [name, name === "execute" ? terminal : pass])) as Record<PipelineStage, PolicyStage>;
}

export function dependencies() {
  let executions = 0;
  const definition = defineAction({ id: "viewProject" as ActionId, version: 1, description: "View project", inputSchema: z.strictObject({}), risk: "SAFE", requiredPermission: "project:view" as PermissionId, allowedPages: "any", confirmation: { kind: "not-required" }, changesState: false, audit: { params: [] }, executorId: "viewProjectExecutor" as ExecutorId });
  const registry = buildRegistry([definition]);
  const executor = defineExecutor({ id: definition.executorId, run: async () => { executions++; return { status: "success" as const }; } });
  const unavailable = (): never => { throw new Error("unused dependency touched"); };
  const deps: GatewayDependencies = {
    registry, executors: bindExecutors(registry, [executor]), globalAllowlist: new Set([definition.id]),
    hooks: { permissions: { has: unavailable }, resources: { resolve: unavailable }, pages: { currentPage: unavailable } },
    state: { replay: new InMemoryReplayGuard({ now: () => now }), rateLimiter: new InMemoryRateLimiter({ now: () => now }), confirmations: { create: unavailable, get: unavailable, listPending: unavailable, tryAccept: unavailable, tryReject: unavailable, invalidate: unavailable, recordExecution: unavailable }, tenantPolicy: { isDisabled: async () => false }, ping: unavailable },
    audit: { append: unavailable }, confirmationChannel: { deliver: unavailable }, clock: { now: () => now }, ids: { newDecisionId: () => "decision", newConfirmationId: unavailable },
    config: { limits: { proposalsPerTurn: 12, executionsPerTurn: 5, maxChainDepth: 6, turnBudgetMs: 45000, perUserPerMinute: { limit: 60, windowSeconds: 60 }, perTenantPerMinute: { limit: 600, windowSeconds: 60 }, perUserPerCapabilityPerMinute: { limit: 30, windowSeconds: 60 }, highRiskPerUserPerHour: { limit: 5, windowSeconds: 3600 }, denialThrottle: { denials: 5, windowSeconds: 60, blockSeconds: 60 } }, maxPayloadBytes: 16384, maxJsonDepth: 8, replayRetentionSeconds: 86400, confirmationDefaultTtlSeconds: 300, hookTimeoutMs: 2000 },
  };
  return { deps, definition, calls: () => executions, otherId: "otherAction" as ActionId };
}
