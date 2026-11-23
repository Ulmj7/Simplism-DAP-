import type { CapabilityTraits, GatewayConfig } from "@dap/contracts";
import { DEFAULT_GATEWAY_CONFIG } from "@dap/security";
import { INVALID_PARAM_SAMPLES } from "../test-capabilities/index.js";
import { exactly, proceedsAs, sequenceScenario, submission, validRaw, type Round, type SequenceScenario } from "./sequence-scenario.js";

const pass = (traits: CapabilityTraits, ...submissions: Round["submissions"][number][]): Round => ({ submissions, proceeds: { min: submissions.length, max: submissions.length, as: proceedsAs(traits) }, denials: [] });
const replayed = (...submissions: Round["submissions"][number][]): Round => ({ submissions, proceeds: { min: 0, max: 0, as: "ALLOWED" }, denials: [exactly("replayed_request", submissions.length)] });
const positive = (traits: CapabilityTraits): boolean => traits.risk !== "FORBIDDEN";

/**
 * ATK-REPLAY-01..08 and ATK-XTENANT-06 as data plus an independent oracle (the replay claim is
 * `${aiSessionId}:${callId}` per tenant, taken BEFORE validation). Gateway "instances" are replicas
 * over the same shared state; run each scenario in fresh state. Needs a SequenceTarget harness.
 * ATK-REPLAY-05 (replay of a consumed confirmation) is the confirmation family's ATK-CONFIRM-05.
 * The harness must keep the session valid across the retention advance of REPLAY-04.
 */
export function createReplayScenarios(config: GatewayConfig = DEFAULT_GATEWAY_CONFIG): readonly SequenceScenario[] {
  const retention = config.replayRetentionSeconds;
  const echo = (traits: CapabilityTraits): unknown => validRaw(traits);
  return [
    sequenceScenario({ id: "ATK-REPLAY-01", category: "replay", title: "same (aiSession, callId) twice: second is a replay, one execution", appliesTo: positive,
      rounds: (traits) => [pass(traits, submission("call-1", echo(traits))), replayed(submission("call-1", echo(traits)))] }),
    sequenceScenario({ id: "ATK-REPLAY-02", category: "replay", title: "replay after a new gateway instance starts on the same state", appliesTo: positive,
      rounds: (traits) => [pass(traits, submission("call-1", echo(traits))), replayed(submission("call-1", echo(traits), { instance: 2 }))] }),
    sequenceScenario({ id: "ATK-REPLAY-03", category: "replay", title: "50 parallel submissions of one callId across two instances: exactly one proceeds", appliesTo: positive,
      rounds: (traits) => [{
        mode: "parallel",
        submissions: Array.from({ length: 50 }, (_, index) => submission("call-1", echo(traits), { instance: index % 2 === 0 ? 1 : 2 })),
        proceeds: { min: 1, max: 1, as: proceedsAs(traits) }, denials: [exactly("replayed_request", 49)],
      }] }),
    sequenceScenario({ id: "ATK-REPLAY-04", category: "replay", title: "replay after the retention window is processed again (documented boundary)", appliesTo: positive,
      rounds: (traits) => [
        pass(traits, submission("call-1", echo(traits))),
        { ...replayed(submission("call-1", echo(traits))), advanceSecondsBefore: retention - 1 },
        { ...pass(traits, submission("call-1", echo(traits))), advanceSecondsBefore: 1 },
      ] }),
    sequenceScenario({ id: "ATK-REPLAY-06", category: "replay", title: "same callId in two tenants is independent", appliesTo: positive,
      rounds: (traits) => [pass(traits, submission("call-1", echo(traits), { tenant: "A" })), pass(traits, submission("call-1", echo(traits), { tenant: "B" }))] }),
    sequenceScenario({ id: "ATK-REPLAY-07", category: "replay", title: "model-supplied callId/requestId are rejected as envelope keys and never claim anything", appliesTo: positive,
      rounds: (traits) => [
        { submissions: ["callId", "requestId"].flatMap((key, index) => ["a", "b"].map((suffix) => submission(`call-${index}${suffix}`, { ...(echo(traits) as object), [key]: "model-chosen" }))),
          proceeds: { min: 0, max: 0, as: "ALLOWED" }, denials: [exactly("malformed_envelope", 4, "INVALID_ACTION")] },
        // The trusted ids those hostile attempts used were never claimed: the same ids now proceed.
        pass(traits, submission("call-0a", echo(traits)), submission("call-1b", echo(traits))),
      ] }),
    sequenceScenario({ id: "ATK-REPLAY-08", category: "replay", title: "invalid proposal then corrected proposal with the same callId: the second is a replay", appliesTo: positive,
      rounds: (traits) => [
        { submissions: [submission("call-1", { action: traits.actionId, params: INVALID_PARAM_SAMPLES.find((sample) => sample.capabilityId === traits.actionId && sample.reason === "missing")?.params ?? { __invalid: true } })],
          proceeds: { min: 0, max: 0, as: "ALLOWED" }, denials: [exactly("invalid_parameters", 1, "INVALID_PARAMETERS")] },
        replayed(submission("call-1", echo(traits))),
      ] }),
    sequenceScenario({ id: "ATK-XTENANT-06", category: "cross-tenant", title: "same callId in tenants A and B: both claim independently and each replays only within its own tenant", appliesTo: positive,
      rounds: (traits) => [
        pass(traits, submission("call-1", echo(traits), { tenant: "A" })),
        pass(traits, submission("call-1", echo(traits), { tenant: "B" })),
        replayed(submission("call-1", echo(traits), { tenant: "A" })),
        replayed(submission("call-1", echo(traits), { tenant: "B" })),
      ] }),
  ];
}
export const replayScenarios = createReplayScenarios();
