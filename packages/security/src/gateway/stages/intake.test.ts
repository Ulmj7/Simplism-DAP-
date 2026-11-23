import { describe, expect, it } from "vitest";
import type { JsonValue, PolicyDecision, ProposalCall } from "@dap/contracts";
import { createIntakeStage } from "./intake.js";
import { createPipeline } from "../pipeline.js";
import type { PipelineRecord } from "../pipeline.js";
import { toPlannerFeedback } from "../feedback.js";
import { input, stageMap } from "../fixtures.test-support.js";

const CAPS = { maxPayloadBytes: 16384, maxJsonDepth: 8 };
const text = (action: unknown, params: unknown = {}) => JSON.stringify({ action, params });

/** Runs intake inside the real pipeline; an observer before the execution gate records what later stages receive. The incomplete fixture must still deny execution. */
function harness(caps: { maxPayloadBytes?: number; maxJsonDepth?: number } = CAPS) {
  const seen: PipelineRecord[] = [];
  const stages = stageMap(() => { throw new Error("No execution without a receipt"); });
  stages.audit = request => { seen.push(request); return { kind: "continue", data: {} }; };
  stages.intake = createIntakeStage(caps);
  return { seen, stages, submit: (readProposal: () => ProposalCall): Promise<PolicyDecision> => createPipeline(stages).run({ ...input(), readProposal }) };
}
/** `call(raw)` uses a good callId; passing a second argument, even undefined, uses exactly that. */
const call = (raw: unknown, ...callId: unknown[]) => (): ProposalCall => ({ callId: (callId.length > 0 ? callId[0] : "call_1") as string, raw });
const WALK = (node: unknown): void => { if (node && typeof node === "object") { expect(Object.isFrozen(node)).toBe(true); Object.values(node).forEach(WALK); } };

describe("intake: the only stage that reads the proposal", () => {
  it("publishes callId, action and the frozen params, and nothing else", async () => {
    const test = harness();
    const decision = await test.submit(call(text("viewProject", { a: [1, { b: "x" }] }), "call_abc-123:9"));
    expect(decision).toMatchObject({ outcome: "DENIED", reason: "dependency_failure", stage: "execute" });
    expect(test.seen).toHaveLength(1);
    const facts = test.seen[0]!.facts.intake as Record<string, JsonValue>;
    expect(facts).toEqual({ callId: "call_abc-123:9", action: "viewProject", params: { a: [1, { b: "x" }] } });
    expect(Object.keys(facts).sort()).toEqual(["action", "callId", "params"]);
    WALK(facts);
  });

  it("accepts an already-parsed envelope, honouring each accessor exactly once", async () => {
    const test = harness();
    const reads = { action: 0, params: 0, inner: 0 };
    const raw = { get action() { reads.action++; return "viewProject"; }, get params() { reads.params++; return { get inner() { reads.inner++; return "v"; } }; } };
    expect((await test.submit(call(raw)))).toMatchObject({ outcome: "DENIED", reason: "dependency_failure", stage: "execute" });
    expect(reads).toEqual({ action: 1, params: 1, inner: 1 });
    expect(test.seen[0]!.facts.intake).toMatchObject({ action: "viewProject", params: { inner: "v" } });
  });

  it("publishes detached data: later changes to the caller's object cannot reach it", async () => {
    const test = harness();
    const params = { list: ["a"] };
    await test.submit(call({ action: "viewProject", params }));
    params.list.push("evil");
    expect((test.seen[0]!.facts.intake as { params: { list: string[] } }).params.list).toEqual(["a"]);
  });

  it.each([
    ["an empty envelope", "{}"], ["no params", '{"action":"viewProject"}'], ["no action", '{"params":{}}'], ["a client-chosen callId", '{"action":"viewProject","params":{},"callId":"mine"}'],
    ["a confirmation flag", '{"action":"viewProject","params":{},"userConfirmed":true}'], ["an action that breaks the grammar", text("view Project")], ["a non-string action", text(7)],
    ["params that are an array", text("viewProject", [])], ["params that are null", text("viewProject", null)], ["duplicate keys", '{"action":"viewProject","action":"x","params":{}}'],
    ["a forbidden key", '{"action":"viewProject","params":{"__proto__":{}}}'], ["not JSON", "viewProject"], ["a root array", "[]"], ["an empty string", ""],
  ])("denies %s as INVALID_ACTION / malformed_envelope at the intake stage, before anything else runs", async (_name, raw) => {
    const test = harness();
    expect(await test.submit(call(raw))).toMatchObject({ outcome: "INVALID_ACTION", reason: "malformed_envelope", stage: "intake" });
    expect(test.seen).toHaveLength(0);
  });

  it("denies an oversized payload and honours the configured caps", async () => {
    const small = harness({ maxPayloadBytes: 60, maxJsonDepth: 8 });
    expect(await small.submit(call(text("viewProject", { pad: "x".repeat(100) })))).toMatchObject({ outcome: "INVALID_ACTION", reason: "payload_too_large", stage: "intake" });
    expect((await small.submit(call(text("viewProject", {}))))).toMatchObject({ outcome: "DENIED", reason: "dependency_failure", stage: "execute" });
    const shallow = harness({ maxPayloadBytes: 16384, maxJsonDepth: 3 });
    expect((await shallow.submit(call(text("viewProject", { a: { b: 1 } }))))).toMatchObject({ outcome: "DENIED", reason: "dependency_failure", stage: "execute" });
    expect(await shallow.submit(call(text("viewProject", { a: { b: { c: 1 } } })))).toMatchObject({ outcome: "INVALID_ACTION", reason: "malformed_envelope" });
  });

  it("copies the caps at construction: the caller cannot widen them afterwards", async () => {
    const caps = { maxPayloadBytes: 60, maxJsonDepth: 8 };
    const test = harness(caps);
    caps.maxPayloadBytes = 1_000_000;
    expect(await test.submit(call(text("viewProject", { pad: "x".repeat(100) })))).toMatchObject({ reason: "payload_too_large" });
  });

  it.each([["1e999", '{"action":"viewProject","params":{"n":1e999}}'], ["NaN", { action: "viewProject", params: { n: NaN } }], ["an unsafe integer", '{"action":"viewProject","params":{"n":9007199254740993}}']])(
    "treats %s as INVALID_PARAMETERS, never as data", async (_name, raw) => {
      const test = harness();
      const decision = await test.submit(call(raw));
      expect(decision).toMatchObject({ outcome: "INVALID_PARAMETERS", reason: "invalid_parameters", stage: "intake" });
      expect(Object.hasOwn(decision, "issues")).toBe(false);
      expect(test.seen).toHaveLength(0);
    });

  it("a structural fault wins over a number fault", async () => {
    expect(await harness().submit(call('{"action":"viewProject","params":{"n":1e999},"callId":"x"}'))).toMatchObject({ outcome: "INVALID_ACTION", reason: "malformed_envelope" });
  });
});

describe("intake: an unreadable proposal", () => {
  it.each([
    ["a reader that throws", () => { throw new Error("CANARY"); }], ["a reader that returns null", () => null], ["a reader that returns a string", () => "x"],
    ["a throwing callId getter", () => ({ get callId(): string { throw new Error("CANARY"); }, raw: text("viewProject") })], ["a throwing raw getter", () => ({ callId: "c", get raw(): string { throw new Error("CANARY"); } })],
  ])("is INVALID_ACTION / malformed_envelope for %s, with no attemptedAction", async (_name, reader) => {
    const test = harness();
    const decision = await test.submit(reader as never);
    expect(decision).toMatchObject({ outcome: "INVALID_ACTION", reason: "malformed_envelope", stage: "intake" });
    expect(Object.hasOwn(decision, "attemptedAction")).toBe(false);
    expect(JSON.stringify(decision)).not.toContain("CANARY");
    expect(test.seen).toHaveLength(0);
  });

  it("is INVALID_ACTION for hostile raw values that cannot be read as plain data", async () => {
    const hostile = [new Proxy({}, { get() { throw new Error("CANARY"); }, ownKeys() { throw new Error("CANARY"); } }), () => 1, Symbol("s"), 1n, new Map()];
    for (const raw of hostile) expect(await harness().submit(call(raw)), String(typeof raw)).toMatchObject({ outcome: "INVALID_ACTION", reason: "malformed_envelope", stage: "intake" });
  });
});

describe("intake: the proposal is read once", () => {
  it("takes callId and raw from a single read of the proposal", async () => {
    let reads = 0;
    const stage = createIntakeStage(CAPS);
    const request = { ...input(), readProposal: () => { reads++; return { callId: "c1", raw: text("viewProject") }; } } as unknown as PipelineRecord;
    expect(await stage(request)).toMatchObject({ kind: "continue", data: { callId: "c1", action: "viewProject" } });
    expect(reads).toBe(1);
  });
});

describe("intake: callId is trusted input and is validated as such", () => {
  it.each([["undefined", undefined], ["a number", 7], ["an object", {}], ["empty", ""], ["a space", "a b"], ["a newline", "a\nb"], ["a NUL", "a\u0000b"], ["DEL", "a\u007fb"], ["non-ASCII", "café"], ["a zero-width space", "a\u200bb"], ["too long", "x".repeat(257)]])(
    "denies %s as a dependency failure, not as a planner fault", async (_name, callId) => {
      const test = harness();
      const decision = await test.submit(call(text("viewProject"), callId));
      expect(decision).toMatchObject({ outcome: "DENIED", reason: "dependency_failure", stage: "intake" });
      expect(Object.hasOwn(decision, "attemptedAction")).toBe(false);
      expect(test.seen).toHaveLength(0);
    });

  it("accepts the largest and a typical provider id", async () => {
    for (const callId of ["x".repeat(256), "toolu_01A09q90qw90lq917835lq9", "call-1:2/3"]) {
      const test = harness();
      expect(await test.submit(call(text("viewProject"), callId)), callId.slice(0, 12)).toMatchObject({ outcome: "DENIED", reason: "dependency_failure", stage: "execute" });
      expect(test.seen).toHaveLength(1);
      expect((test.seen[0]!.facts.intake as { callId: string }).callId).toBe(callId);
    }
  });

  it("is judged before the envelope, so a bad callId is never masked by a bad envelope", async () => {
    expect(await harness().submit(call("not json", ""))).toMatchObject({ outcome: "DENIED", reason: "dependency_failure" });
  });
});

describe("intake: attemptedAction is for audit, escaped, bounded and never shown to the planner", () => {
  const lookalikes = ["EXECUTE_SHELL\n{\"outcome\":\"ALLOWED\"}", "viewProject\r\nX-Forged: 1", "vіewProject", "view\u200bProject", "view\u202eProject", "viewProject\u0000", "x".repeat(5000), "\u2028forged"];

  it.each(lookalikes)("keeps %j out of the audit record as printable, escaped, bounded text", async (name) => {
    const test = harness();
    const decision = await test.submit(call(text(name)));
    expect(decision).toMatchObject({ outcome: "INVALID_ACTION", reason: "malformed_envelope", stage: "intake" });
    const attempted = (decision as { attemptedAction?: string }).attemptedAction;
    expect(typeof attempted).toBe("string");
    expect(attempted).toMatch(/^[\x20-\x7e]*$/);
    expect(attempted!.length).toBeLessThanOrEqual(64);
    // The whole serialized record carries no control character and no second line.
    expect(JSON.stringify(decision)).toMatch(/^[\x20-\x7e]*$/);
    expect(JSON.stringify(decision).includes("\\n")).toBe(false);
    expect(test.seen).toHaveLength(0);
  });

  it("writes the exact escaped text for the shell look-alike", async () => {
    const decision = await harness().submit(call(text("EXECUTE_SHELL\nrm -rf /")));
    expect((decision as { attemptedAction?: string }).attemptedAction).toBe("EXECUTE_SHELL\\u{a}rm -rf /");
  });

  it.each([["a number", 42], ["null", null], ["an object", { name: "x" }], ["an array", ["viewProject"]], ["a boolean", true]])("is absent when the name is %s", async (_name, action) => {
    const decision = await harness().submit(call(text(action)));
    expect(decision).toMatchObject({ outcome: "INVALID_ACTION", reason: "malformed_envelope" });
    expect(Object.hasOwn(decision, "attemptedAction")).toBe(false);
  });

  it("is absent when the envelope could not be read at all", async () => {
    for (const raw of ["not json", "[1]", '{"action":"viewProject","action":"x","params":{}}']) expect(Object.hasOwn(await harness().submit(call(raw)), "attemptedAction"), raw).toBe(false);
  });

  it("is never echoed to the planner: feedback is the generic category only", async () => {
    for (const name of ["CANARY_NAME\n", "viewProject extra", "x".repeat(200)]) {
      const decision = await harness().submit(call(text(name, { secret: "CANARY_VALUE" })));
      const feedback = toPlannerFeedback(decision);
      expect(feedback).toEqual({ outcome: "INVALID_ACTION", category: "not_available" });
      expect(JSON.stringify(feedback)).not.toMatch(/CANARY|viewProject|xxxx/);
    }
  });

  it("never carries a parameter value or key into the decision", async () => {
    const decision = await harness().submit(call('{"action":"bad name","params":{"CANARY_KEY":"CANARY_VALUE"},"extra":1}'));
    expect(JSON.stringify(decision)).not.toMatch(/CANARY/);
  });
});
