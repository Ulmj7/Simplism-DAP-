/** Consistent facts for the audit and execute stages, and ways to bend each one. */
import type { PipelineRecord } from "../pipeline.js";
import type { Chain } from "../chain.test-support.js";
import { context, input, run } from "../fixtures.test-support.js";

export const EVENT_ID = "33333333-3333-4333-8333-333333333333";
export const CONFIRMATION = "22222222-2222-4222-8222-222222222222";
export const DIGEST = "a".repeat(64);
export const PROJECT = { type: "project", id: "p1" };
export type Facts = Record<string, unknown>;

/** The facts every earlier stage would have published for `openProject` with a resource, a masked note and a SAFE risk. */
export function goodFacts(world: Chain, over: { risk?: string } = {}): Facts {
  const entry = world.registry.get("openProject")!;
  const risk = over.risk ?? "SAFE";
  return {
    intake: { callId: "call-1", action: "openProject", params: { projectId: "p1", note: "RAW_NOTE" } },
    resolve: { id: "openProject", version: entry.definition.version, risk, definitionHash: entry.definitionHash },
    validate: { params: { projectId: "p1", note: "SECRET_NOTE" }, paramsDigest: DIGEST, resource: PROJECT },
    authorize: { resource: { ...PROJECT, displayName: "Project One" } },
    risk: { risk, confirmation: "not_required" },
    confirmation: { state: "not_required", confirmationId: null },
  };
}
export const withAudit = (facts: Facts): Facts => {
  const resolve = facts.resolve as { id: string; version: number; risk: string };
  const validate = facts.validate as { paramsDigest: string };
  const confirmation = facts.confirmation as { confirmationId: string | null };
  return { ...facts, audit: { eventId: EVENT_ID, actionId: resolve.id, version: resolve.version, risk: resolve.risk, paramsDigest: validate.paramsDigest, confirmationId: confirmation.confirmationId } };
};
/** A deep copy with one slot's field replaced, e.g. `bend(facts, "audit", { paramsDigest: "b".repeat(64) })`. */
export const bend = (facts: Facts, slot: string, patch: Record<string, unknown>): Facts => ({ ...facts, [slot]: { ...(facts[slot] as object), ...patch } });
export const without = (facts: Facts, slot: string): Facts => { const { [slot]: _gone, ...rest } = facts; void _gone; return rest; };

export function recordOf(facts: Facts, over: Partial<PipelineRecord> | Record<string, unknown> = {}): PipelineRecord {
  return { ...input(), run, context: context(), facts, budget: { remainingMs: () => 10_000 }, ...over } as unknown as PipelineRecord;
}
