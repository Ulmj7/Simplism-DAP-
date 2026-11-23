import type { ExecutionResult, GatewayConfig, ProposalCall, ReplayGuard } from "@dap/contracts";
import { withGateway } from "@dap/testkit";
import type { LimiterFault, SequenceTarget } from "../../packages/testkit/src/attacks/sequence-scenario.js";
import type { Actor } from "../../packages/testkit/src/attacks/sequence-scenario.js";

const FAULT_MODE = { throws: "throws", hangs: "hangs", wrong_type: "wrong-type", full_store: "throws" } as const;

/**
 * The REAL gateway, every stage, as a sequence harness: a thin adapter over the testkit world (`withGateway`), which owns the composition.
 * Every actor is a user with every permission (the sequences attack limits and replay, not authorization), on a clock far from any real one.
 */
export function gatewaySequence(options: { config?: GatewayConfig; replay?: ReplayGuard; executorResult?: ExecutionResult } = {}) {
  const world = withGateway({
    ...(options.config === undefined ? {} : { config: options.config }), ...(options.replay === undefined ? {} : { replay: options.replay }),
    ...(options.executorResult === undefined ? {} : { executorResult: options.executorResult }),
    startAt: "2099-01-01T00:00:00Z", sessionSeconds: 31_536_000, openPermissions: true,
  });
  const target: SequenceTarget = {
    actionId: "testSafeEcho", risk: "SAFE", targetsResource: false, changesState: false, requiresConfirmation: false,
    executor: { get calls() { return world.executorCalls(); } }, get audit() { return world.audit; }, visibleOutput: null,
    get sharedStoreCalls() { return world.stats().sharedStoreCalls; },
    async submitAs(actor: Actor, call: ProposalCall) {
      return world.submit({ tenant: actor.tenant, user: actor.user, session: actor.session }, call, { turn: actor.turn, depth: actor.depth, instance: actor.instance });
    },
    async advanceSeconds(seconds) { world.advanceClock(seconds); },
    async injectLimiterFault(fault: LimiterFault | null) { if (fault === null) world.clearFault("rateLimiter"); else world.injectFault("rateLimiter", FAULT_MODE[fault]); },
  };
  return {
    world, target, tenants: world.tenants, config: world.config,
    get clock() { return world.clock; },
    get claims() { return world.stats().replayClaims; },
    get permissions() { return world.stats().permissionCalls; },
    /** Limit an injected rate-limiter fault to the buckets that start with `prefix` (for example "turn:executions"); null clears it. */
    faultOnly(prefix: string, mode: LimiterFault | null) { if (mode === null) world.clearFault("rateLimiter"); else world.injectFault("rateLimiter", FAULT_MODE[mode], { bucketPrefix: prefix }); },
    restart(instance: number) { world.restart(instance); },
  };
}
