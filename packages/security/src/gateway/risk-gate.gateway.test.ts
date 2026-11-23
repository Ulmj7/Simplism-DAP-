/**
 * T104a through the REAL createPolicyGateway (every stage composed, no stand-ins): `ALLOWED` is reachable for a class that needs no confirmation,
 * and a class that does stops at the risk stage with the executor at zero calls and no allow-event.
 */
import { describe, expect, it } from "vitest";
import type { GatewayDependencies } from "@dap/contracts";
import { chain } from "./chain.test-support.js";
import { createPolicyGateway } from "./create-gateway.js";
import { context, run } from "./fixtures.test-support.js";

const CONF = "22222222-2222-4222-8222-222222222222";
const submit = (deps: GatewayDependencies, raw: string) => createPolicyGateway(deps).proposals.forSession(context(), run).submit({ callId: "call-1", raw });

describe("through the real gateway", () => {
  it("a permitted user, an enabled SAFE capability and valid parameters are ALLOWED: the executor runs once, with the validated frozen parameters and the user's own context", async () => {
    const world = chain();
    expect(await submit(world.deps, world.text({ projectId: "p1", note: "n" }))).toEqual({ outcome: "ALLOWED", category: "ok" });
    expect(world.executorCalls).toHaveLength(1);
    const call = world.executorCalls[0]!;
    expect(call.params).toEqual({ projectId: "p1", note: "n" });
    expect(Object.isFrozen(call.params)).toBe(true);
    expect(call.security).toMatchObject({ userId: context().userId, tenantId: context().tenantId, sessionId: context().sessionId });
    expect(call.actionId).toBe("openProject");
    const events = await world.events();
    expect(events.map((event) => event.type)).toEqual(["AI_ACTION_PROPOSED", "AI_ACTION_ALLOWED", "AI_ACTION_EXECUTED"]);
    expect(events[1]).toMatchObject({ outcome: "ALLOWED", reason: "allowed", risk: "SAFE", actionId: "openProject" });
  });

  it("a LOW capability is ALLOWED the same way", async () => {
    const world = chain({ risk: "LOW" });
    expect(await submit(world.deps, world.text({ projectId: "p1" }))).toEqual({ outcome: "ALLOWED", category: "ok" });
    expect(world.executorCalls).toHaveLength(1);
  });

  it("a HIGH capability is REQUIRES_CONFIRMATION: the executor never runs, there is no allow-event, and the planner learns no id", async () => {
    const world = chain({ risk: "HIGH" });
    const deps = { ...world.deps, ids: { ...world.deps.ids, newConfirmationId: () => CONF } } as GatewayDependencies;
    const feedback = await submit(deps, world.text({ projectId: "p1", note: "n" }));
    expect(feedback).toEqual({ outcome: "REQUIRES_CONFIRMATION", category: "needs_user_confirmation" });
    expect(JSON.stringify(feedback)).not.toContain(CONF);
    expect(world.executorCalls).toHaveLength(0);
    const events = await world.events();
    expect(events.map((event) => event.type)).toEqual(["AI_ACTION_PROPOSED", "AI_CONFIRMATION_REQUIRED"]);
    expect(events.map((event) => event.type)).not.toContain("AI_ACTION_ALLOWED");
    expect(events[1]).toMatchObject({ outcome: "REQUIRES_CONFIRMATION", risk: "HIGH" });
  });

  it("a CRITICAL capability is REQUIRES_CONFIRMATION too", async () => {
    const world = chain({ risk: "CRITICAL" });
    const deps = { ...world.deps, ids: { ...world.deps.ids, newConfirmationId: () => CONF } } as GatewayDependencies;
    expect(await submit(deps, world.text({ projectId: "p1" }))).toEqual({ outcome: "REQUIRES_CONFIRMATION", category: "needs_user_confirmation" });
    expect(world.executorCalls).toHaveLength(0);
  });

  it("a class that needs a confirmation whose id generator is down is denied fail-closed, not allowed", async () => {
    const world = chain({ risk: "HIGH" });
    const deps = { ...world.deps, ids: { ...world.deps.ids, newConfirmationId: () => { throw new Error("down"); } } } as GatewayDependencies;
    expect(await submit(deps, world.text({ projectId: "p1" }))).toEqual({ outcome: "DENIED", category: "try_later" });
    expect(world.executorCalls).toHaveLength(0);
    expect((await world.events()).map((event) => event.type)).toEqual(["AI_ACTION_PROPOSED", "AI_ACTION_DENIED"]);
  });
});
