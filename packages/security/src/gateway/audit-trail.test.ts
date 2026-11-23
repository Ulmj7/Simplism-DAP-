/**
 * SC-008 (T084), over the real chain with stand-ins for the stages not built yet: from the audit events ALONE, answer for 20 mixed
 * proposals what was attempted, why it was allowed or denied, who authorized it, and which resource changed. The expectation table is
 * written by hand from what each proposal is; the answers are read only from the recorded events.
 */
import { describe, expect, it } from "vitest";
import type { AuditEvent } from "@dap/contracts";
import { chain } from "./chain.test-support.js";
import { context, dependencies } from "./fixtures.test-support.js";

interface Answer { attempted: string | null; verdict: string; reason: string | null; by: string; resource: string | null }
/** The reviewer's reading of one request's records: nothing but events. */
function explain(group: readonly AuditEvent[]): Answer {
  const proposed = group.find((event) => event.type === "AI_ACTION_PROPOSED")!;
  const decision = group.find((event) => event.type !== "AI_ACTION_PROPOSED" && event.type !== "AI_ACTION_EXECUTED")!;
  const executed = group.find((event) => event.type === "AI_ACTION_EXECUTED");
  const touched = (executed ?? decision).resource;
  return { attempted: proposed.actionId, verdict: executed ? `executed:${executed.executionResult}` : decision.type, reason: decision.reason, by: `${decision.tenantId}/${decision.userId}`, resource: touched === null ? null : `${touched.type}:${touched.id}` };
}

describe("SC-008: twenty mixed actions, answered from events alone", () => {
  it("what was attempted, why it was allowed or denied, who authorized it and what changed", async () => {
    let permitted = true;
    // Six executions in one turn: the cap (the fixture's is 5) is raised so that this test is about the trail, not about the cap.
    const limits = { ...dependencies().deps.config.limits, executionsPerTurn: 20 };
    const world = chain({ permission: () => permitted, config: { limits } });
    const who = `${context().tenantId}/${context().userId}`;
    const ok = (id: string): [string, Answer] => [world.text({ projectId: id }), { attempted: "openProject", verdict: "executed:success", reason: "allowed", by: who, resource: `project:${id}` }];
    const denied = (raw: string, attempted: string | null, reason: string, type = "AI_ACTION_DENIED"): [string, Answer] => [raw, { attempted, verdict: type, reason, by: who, resource: null }];
    const cases: [string, Answer, boolean?][] = [
      ok("p1"), ok("p2"), ok("p3"), ok("p4"), ok("p5"), ok("p6"),
      denied("{\"action\":\"missingOne\",\"params\":{}}", "missingOne", "unknown_action"), denied("{\"action\":\"missingTwo\",\"params\":{}}", "missingTwo", "unknown_action"), denied("{\"action\":\"missingThree\",\"params\":{}}", "missingThree", "unknown_action"),
      denied("{\"action\":\"executeShell\",\"params\":{}}", "executeShell", "reserved_forbidden_action", "AI_POLICY_VIOLATION"), denied("{\"action\":\"fetchUrl\",\"params\":{}}", "fetchUrl", "reserved_forbidden_action", "AI_POLICY_VIOLATION"),
      denied("{}", null, "malformed_envelope"), denied("not json", null, "malformed_envelope"), denied("{\"action\":\"bad name\",\"params\":{}}", "bad name", "malformed_envelope"),
      denied(world.text({ projectId: "" }), "openProject", "invalid_parameters"), denied(world.text({ projectId: "x".repeat(50) }), "openProject", "invalid_parameters"), denied(world.text({ nope: 1 }), "openProject", "invalid_parameters"),
      [...denied(world.text({ projectId: "p7" }), "openProject", "permission_missing"), false] as never, [...denied(world.text({ projectId: "p8" }), "openProject", "permission_missing"), false] as never, [...denied(world.text({ projectId: "p9" }), "openProject", "permission_missing"), false] as never,
    ];
    expect(cases).toHaveLength(20);
    const expected: Answer[] = [];
    for (const [raw, answer, allowedUser] of cases) {
      permitted = allowedUser !== false;
      await world.submitter().submit({ callId: `c${expected.length}`, raw });
      expected.push(answer);
    }
    const byRequest = new Map<string, AuditEvent[]>();
    for (const event of await world.events()) byRequest.set(event.requestId, [...(byRequest.get(event.requestId) ?? []), event]);
    expect(expected).toHaveLength(20);
    expect([...byRequest.values()].map(explain)).toEqual(expected);
  });

  it("never needs anything but the events: no record names a model-authored value other than the escaped attempted name", async () => {
    const world = chain();
    await world.submitter().submit({ callId: "c", raw: world.text({ projectId: "p1", note: "SECRET_NOTE" }) });
    const text = JSON.stringify(await world.events());
    expect(text).not.toContain("SECRET_NOTE");
    expect(text).toContain("[masked]");
  });
});
