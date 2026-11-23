/**
 * T079. Every field of an audit event has a trusted source; nothing the model wrote reaches the record except the one
 * sanitized attempted name; each of the nine types has its own fixed shape. Each guard has a case that fails without it.
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { AUDIT_EVENT_TYPES } from "@dap/contracts";
import type { AuditEvent, AuditEventType } from "@dap/contracts";
import { mintAuthorizationContext } from "@dap/contracts/mint";
import { buildAuditEvent, createAuditEventBuilder, isBuiltAuditEvent } from "./event-builder.js";
import type { AuditEventInput } from "./event-builder.js";
import { context, run } from "../gateway/fixtures.test-support.js";

const ID = "11111111-1111-4111-8111-111111111111";
const CONFIRMATION = "22222222-2222-4222-8222-222222222222";
const AT = "2026-01-01T00:00:00Z";
const registered = { kind: "registered", id: "openProject", version: 3 } as const;
type Loose = { -readonly [K in keyof AuditEventInput]?: AuditEventInput[K] | undefined };
const base = (overrides: Loose = {}): AuditEventInput => ({ type: "AI_ACTION_DENIED", id: ID, occurredAt: AT, requestId: "req-1", decisionId: "dec-1", context: context(), run, outcome: "DENIED", reason: "permission_missing", ...overrides }) as AuditEventInput;

/** One valid input per event type. */
const VALID: Record<AuditEventType, AuditEventInput> = {
  AI_ACTION_PROPOSED: base({ type: "AI_ACTION_PROPOSED", action: { kind: "attempted", name: "openProject" }, outcome: undefined, reason: undefined }),
  AI_ACTION_ALLOWED: base({ type: "AI_ACTION_ALLOWED", action: registered, risk: "LOW", outcome: "ALLOWED", reason: "allowed", paramsView: { "/projectId": "p1" }, resource: { type: "project", id: "p1" } }),
  AI_ACTION_DENIED: base({ action: registered, risk: "LOW", paramsView: { "/projectId": "p1" } }),
  AI_CONFIRMATION_REQUIRED: base({ type: "AI_CONFIRMATION_REQUIRED", action: registered, risk: "HIGH", outcome: "REQUIRES_CONFIRMATION", reason: "confirmation_required", confirmation: { id: CONFIRMATION, state: "pending" } }),
  AI_CONFIRMATION_ACCEPTED: base({ type: "AI_CONFIRMATION_ACCEPTED", action: registered, risk: "HIGH", outcome: "ALLOWED", reason: "allowed", confirmation: { id: CONFIRMATION, state: "accepted" } }),
  AI_CONFIRMATION_REJECTED: base({ type: "AI_CONFIRMATION_REJECTED", action: registered, risk: "HIGH", outcome: "DENIED", reason: "confirmation_rejected", confirmation: { id: CONFIRMATION, state: "rejected" } }),
  AI_POLICY_VIOLATION: base({ type: "AI_POLICY_VIOLATION", action: { kind: "attempted", name: "executeShell" }, outcome: "FORBIDDEN_POLICY", reason: "reserved_forbidden_action" }),
  AI_RATE_LIMITED: base({ type: "AI_RATE_LIMITED", action: registered, outcome: "DENIED", reason: "rate_limited_user" }),
  AI_ACTION_EXECUTED: base({ type: "AI_ACTION_EXECUTED", action: registered, risk: "LOW", outcome: "ALLOWED", reason: "allowed", executionResult: "success" }),
};
const throwsField = (input: AuditEventInput, field: string) => expect(() => buildAuditEvent(input)).toThrow(new TypeError(`Invalid audit event: ${field}`));

describe("all nine event types", () => {
  it("covers exactly the contract's event types", () => {
    expect(Object.keys(VALID).sort()).toEqual([...AUDIT_EVENT_TYPES].sort());
  });

  it.each(AUDIT_EVENT_TYPES)("%s builds a complete, frozen, registered event", (type) => {
    const input = VALID[type];
    const event = buildAuditEvent(input);
    const ctx = context();
    expect(event).toMatchObject({ id: ID, occurredAt: AT, type, requestId: "req-1", decisionId: "dec-1", tenantId: ctx.tenantId, userId: ctx.userId, aiSessionId: run.aiSessionId, turnId: run.turnId, model: run.model });
    expect(Object.keys(event).sort()).toEqual(["actionId", "aiSessionId", "confirmationId", "confirmationState", "decisionId", "definitionVersion", "executionResult", "id", "model", "occurredAt", "outcome", "paramsView", "reason", "requestId", "resource", "risk", "tenantId", "turnId", "type", "userId"]);
    expect(Object.isFrozen(event)).toBe(true);
    expect(Object.isFrozen(event.paramsView)).toBe(true);
    expect(isBuiltAuditEvent(event)).toBe(true);
  });

  it("fills exactly the fields each type carries and leaves the rest null", () => {
    expect(buildAuditEvent(VALID.AI_ACTION_PROPOSED)).toMatchObject({ actionId: "openProject", definitionVersion: null, risk: null, outcome: null, reason: null, confirmationId: null, confirmationState: null, executionResult: null, resource: null, paramsView: {} });
    expect(buildAuditEvent(VALID.AI_ACTION_ALLOWED)).toMatchObject({ actionId: "openProject", definitionVersion: 3, risk: "LOW", outcome: "ALLOWED", reason: "allowed", executionResult: null, resource: { type: "project", id: "p1" }, paramsView: { "/projectId": "p1" } });
    expect(buildAuditEvent(VALID.AI_ACTION_EXECUTED)).toMatchObject({ outcome: "ALLOWED", executionResult: "success" });
    expect(buildAuditEvent({ ...VALID.AI_ACTION_EXECUTED, executionResult: "failure" })).toMatchObject({ executionResult: "failure" });
    expect(buildAuditEvent(VALID.AI_CONFIRMATION_REQUIRED)).toMatchObject({ confirmationId: CONFIRMATION, confirmationState: "pending", outcome: "REQUIRES_CONFIRMATION" });
    expect(buildAuditEvent(VALID.AI_CONFIRMATION_ACCEPTED)).toMatchObject({ confirmationState: "accepted" });
    expect(buildAuditEvent(VALID.AI_CONFIRMATION_REJECTED)).toMatchObject({ confirmationState: "rejected", reason: "confirmation_rejected" });
    expect(buildAuditEvent(VALID.AI_RATE_LIMITED)).toMatchObject({ outcome: "DENIED", reason: "rate_limited_user", risk: null });
  });
});

describe("every field has a trusted source", () => {
  it("takes tenant and user from the minted context, not from anything else in the input", () => {
    const other = mintAuthorizationContext({ userId: "bob", tenantId: "00000000-0000-4000-8000-000000000002", sessionId: "s", authenticatedAt: AT, validUntil: "2026-01-01T01:00:00Z" });
    const event = buildAuditEvent(base({ context: other, ...({ tenantId: "forged", userId: "forged" } as object) }));
    expect([event.tenantId, event.userId]).toEqual(["00000000-0000-4000-8000-000000000002", "bob"]);
  });

  it("takes session, turn and model from the trusted run metadata only", () => {
    const event = buildAuditEvent(base({ run: { aiSessionId: "sess-9", turnId: "turn-9", model: "model-9", ...({ extra: "x" } as object) } }));
    expect([event.aiSessionId, event.turnId, event.model]).toEqual(["sess-9", "turn-9", "model-9"]);
  });

  it.each([["a plain look-alike", { ...context() }], ["a clone", JSON.parse(JSON.stringify(context())) as unknown], ["null", null], ["undefined", undefined], ["a string", "alice"]])("refuses %s as the context", (_name, ctx) => {
    throwsField(base({ context: ctx as never }), "context");
  });

  it.each(["aiSessionId", "turnId", "model"] as const)("refuses a run without a usable %s", (field) => {
    for (const bad of [undefined, "", 5, "a\nb", "x".repeat(257), String.fromCharCode(97, 0x2028, 98)]) throwsField(base({ run: { ...run, [field]: bad } as never }), field);
  });
  it("refuses a missing run", () => throwsField(base({ run: undefined as never }), "aiSessionId"));

  it("reads every input field once", () => {
    let reads = 0;
    const input = { ...base(), get requestId() { reads += 1; return reads === 1 ? "req-1" : "changed"; } } as AuditEventInput;
    expect(buildAuditEvent(input).requestId).toBe("req-1");
    expect(reads).toBe(1);
  });

  it.each([["id", "not-a-uuid"], ["id", ""], ["occurredAt", "yesterday"], ["occurredAt", "2026-01-01"], ["occurredAt", "2026-01-01T00:00:00"], ["requestId", ""], ["requestId", "a\nb"], ["decisionId", ""], ["decisionId", 7]])(
    "refuses a bad %s (%j)", (field, value) => {
      throwsField(base({ [field]: value } as never), field);
    });
  it("accepts an offset instant and the largest identifier", () => {
    expect(buildAuditEvent(base({ occurredAt: "2026-01-01T02:00:00+02:00", requestId: "r".repeat(256) }))).toMatchObject({ occurredAt: "2026-01-01T02:00:00+02:00" });
  });
});

describe("the action: registered, or the one sanitized attempted name", () => {
  const nameOf = (name: unknown) => buildAuditEvent(base({ action: { kind: "attempted", name } as never })).actionId;

  it("records a registered action's id and version", () => {
    expect(buildAuditEvent(base({ action: registered }))).toMatchObject({ actionId: "openProject", definitionVersion: 3 });
  });
  it("records no action when none was readable", () => {
    expect(buildAuditEvent(base())).toMatchObject({ actionId: null, definitionVersion: null });
  });
  it.each([["an id that is not an action id", { kind: "registered", id: "Open Project", version: 1 }], ["a numeric id", { kind: "registered", id: 5, version: 1 }], ["version 0", { kind: "registered", id: "openProject", version: 0 }],
    ["a fractional version", { kind: "registered", id: "openProject", version: 1.5 }], ["a string version", { kind: "registered", id: "openProject", version: "1" }], ["an unknown kind", { kind: "other", id: "openProject" }]])("refuses %s", (_name, action) => {
    throwsField(base({ action: action as never }), "action");
  });
  it("refuses a non-string attempted name", () => {
    for (const bad of [undefined, null, 5, {}, ["x"]]) expect(() => nameOf(bad)).toThrow(new TypeError("Invalid audit event: action"));
  });

  it("bounds an already-printable name at exactly 64, and keeps a printable name with spaces and backslashes as it is", () => {
    expect(nameOf("x".repeat(64))).toBe("x".repeat(64));
    expect(nameOf("x".repeat(65))).toBe("x".repeat(64));
    expect(nameOf("EXECUTE \\u{a}rm")).toBe("EXECUTE \\u{a}rm");
    expect(nameOf(" \\u{a}")).toBe(" \\u{a}");
  });
  it("escapes control characters and look-alikes, and bounds the name at 64", () => {
    expect(nameOf("EXECUTE_SHELL\n{\"outcome\":\"ALLOWED\"}")).toBe("EXECUTE_SHELL\\u{a}{\"outcome\":\"ALLOWED\"}");
    expect(nameOf("vіew")).toBe("v\\u{456}ew");
    expect(nameOf("x".repeat(500))).toBe("x".repeat(64));
    expect(nameOf("")).toBeNull();
  });
  it("keeps a name that is already escaped and bounded exactly as it is (the intake stage prepares it)", () => {
    for (const ready of ["viewProject", "EXECUTE_SHELL\\u{a}rm", "x".repeat(64), "~!@ #$%^&*()_+"]) expect(nameOf(ready), ready).toBe(ready);
  });
  it("redacts a secret-shaped name, before and after preparation", () => {
    expect(nameOf("sk-abcdefghijklmnopqrstuvwx")).toBe("[redacted]");
    expect(nameOf(`${"y".repeat(60)}AKIAABCDEFGHIJKLMNOP`)).not.toContain("AKIA");
    expect(nameOf("AKIAABCDEFGHIJKLMNOP")).toBe("[redacted]");
  });
  it("a risk needs a resolved action: an attempted name has none", () => {
    throwsField(base({ action: { kind: "attempted", name: "x" }, risk: "LOW" }), "risk");
    throwsField(base({ risk: "LOW" }), "risk");
  });
});

describe("paramsView", () => {
  it("is empty by default and a frozen plain object otherwise", () => {
    expect(buildAuditEvent(base()).paramsView).toEqual({});
    expect(Object.isFrozen(buildAuditEvent(base()).paramsView)).toBe(true);
  });
  it("is scrubbed again here, whatever the projection did", () => {
    const event = buildAuditEvent(base({ action: registered, paramsView: { "/k": "sk-abcdefghijklmnopqrstuvwx", "/n": { deep: "AKIAABCDEFGHIJKLMNOP" } } }));
    expect(event.paramsView).toEqual({ "/k": "[redacted]", "/n": { deep: "[redacted]" } });
  });
  it("keeps hostile text inside one value", () => {
    const event = buildAuditEvent(base({ action: registered, paramsView: { "/note": "a\n\u001b[31m\"}{\"forged\":1" } }));
    expect(Object.keys(event.paramsView)).toEqual(["/note"]);
    expect(JSON.stringify(event).includes("\n")).toBe(false);
  });
  it.each([["an array", []], ["null", null], ["a string", "x"], ["a number", 1], ["a boolean", true], ["an unserializable value", 10n]])("refuses %s", (_name, view) => {
    throwsField(base({ paramsView: view }), "paramsView");
  });
  it("is refused for a proposal, which has no validated parameters yet, and for a rate-limit event", () => {
    throwsField({ ...VALID.AI_ACTION_PROPOSED, paramsView: { "/a": 1 } }, "paramsView");
    throwsField({ ...VALID.AI_RATE_LIMITED, paramsView: { "/a": 1 } }, "paramsView");
    expect(buildAuditEvent({ ...VALID.AI_ACTION_PROPOSED, paramsView: {} }).paramsView).toEqual({});
  });
});

describe("each type has a fixed shape", () => {
  it.each([
    ["a proposal with an outcome", { ...VALID.AI_ACTION_PROPOSED, outcome: "DENIED" }, "outcome"], ["a proposal with a reason", { ...VALID.AI_ACTION_PROPOSED, reason: "unknown_action" }, "outcome"],
    ["a proposal with a risk", { ...VALID.AI_ACTION_PROPOSED, action: registered, risk: "LOW" }, "risk"], ["a proposal with a resource", { ...VALID.AI_ACTION_PROPOSED, resource: { type: "a", id: "b" } }, "resource"],
    ["a proposal with a confirmation", { ...VALID.AI_ACTION_PROPOSED, confirmation: { id: CONFIRMATION, state: "pending" } }, "confirmation"],
    ["an allowed event that is not ALLOWED", { ...VALID.AI_ACTION_ALLOWED, outcome: "DENIED" }, "outcome"], ["an allowed event with a denial reason", { ...VALID.AI_ACTION_ALLOWED, reason: "permission_missing" }, "reason"],
    ["an allowed event with no risk", { ...VALID.AI_ACTION_ALLOWED, risk: undefined }, "risk"], ["an allowed event for an unresolved action", { ...VALID.AI_ACTION_ALLOWED, action: { kind: "attempted", name: "x" }, risk: undefined }, "action"],
    ["an allowed event with no action", { ...VALID.AI_ACTION_ALLOWED, action: undefined, risk: undefined }, "action"], ["an allowed event with an execution result", { ...VALID.AI_ACTION_ALLOWED, executionResult: "success" }, "executionResult"],
    ["an executed event with no result", { ...VALID.AI_ACTION_EXECUTED, executionResult: undefined }, "executionResult"], ["an executed event with an unknown result", { ...VALID.AI_ACTION_EXECUTED, executionResult: "maybe" }, "executionResult"],
    ["an executed event that is DENIED", { ...VALID.AI_ACTION_EXECUTED, outcome: "DENIED", reason: "permission_missing" }, "outcome"],
    ["a denial with outcome ALLOWED", { ...VALID.AI_ACTION_DENIED, outcome: "ALLOWED", reason: "allowed" }, "outcome"], ["a denial with outcome REQUIRES_CONFIRMATION", { ...VALID.AI_ACTION_DENIED, outcome: "REQUIRES_CONFIRMATION" }, "outcome"],
    ["a denial with the success reason", { ...VALID.AI_ACTION_DENIED, reason: "allowed" }, "reason"], ["a denial with the confirmation-required reason", { ...VALID.AI_ACTION_DENIED, reason: "confirmation_required" }, "reason"],
    ["a denial with an unknown reason", { ...VALID.AI_ACTION_DENIED, reason: "because" }, "reason"], ["a denial with no outcome", { ...VALID.AI_ACTION_DENIED, outcome: undefined }, "outcome"],
    ["a denial with no reason", { ...VALID.AI_ACTION_DENIED, reason: undefined }, "reason"], ["a denial with an execution result", { ...VALID.AI_ACTION_DENIED, executionResult: "failure" }, "executionResult"],
    ["a denial with an unknown outcome", { ...VALID.AI_ACTION_DENIED, outcome: "NOPE" }, "outcome"], ["a risk that is not a risk level", { ...VALID.AI_ACTION_DENIED, risk: "TINY" }, "risk"],
    ["a violation with outcome ALLOWED", { ...VALID.AI_POLICY_VIOLATION, outcome: "ALLOWED", reason: "allowed" }, "outcome"], ["a violation with outcome INVALID_ACTION", { ...VALID.AI_POLICY_VIOLATION, outcome: "INVALID_ACTION" }, "outcome"],
    ["a violation with the success reason", { ...VALID.AI_POLICY_VIOLATION, reason: "allowed" }, "reason"], ["a violation with a confirmation", { ...VALID.AI_POLICY_VIOLATION, confirmation: { id: CONFIRMATION, state: "pending" } }, "confirmation"],
    ["a rate-limit event that is not DENIED", { ...VALID.AI_RATE_LIMITED, outcome: "UNAUTHORIZED" }, "outcome"], ["a rate-limit event with an unrelated reason", { ...VALID.AI_RATE_LIMITED, reason: "permission_missing" }, "reason"],
    ["a rate-limit event with a resource", { ...VALID.AI_RATE_LIMITED, resource: { type: "a", id: "b" } }, "resource"],
    ["a confirmation request without a confirmation", { ...VALID.AI_CONFIRMATION_REQUIRED, confirmation: undefined }, "confirmation"], ["a confirmation request that is not pending", { ...VALID.AI_CONFIRMATION_REQUIRED, confirmation: { id: CONFIRMATION, state: "accepted" } }, "confirmation"],
    ["a confirmation request with the wrong outcome", { ...VALID.AI_CONFIRMATION_REQUIRED, outcome: "DENIED" }, "outcome"], ["a confirmation request with the wrong reason", { ...VALID.AI_CONFIRMATION_REQUIRED, reason: "allowed" }, "reason"],
    ["a confirmation request with no risk", { ...VALID.AI_CONFIRMATION_REQUIRED, risk: undefined }, "risk"], ["an accepted confirmation that is pending", { ...VALID.AI_CONFIRMATION_ACCEPTED, confirmation: { id: CONFIRMATION, state: "pending" } }, "confirmation"],
    ["an accepted confirmation with the wrong outcome", { ...VALID.AI_CONFIRMATION_ACCEPTED, outcome: "DENIED", reason: "confirmation_rejected" }, "outcome"],
    ["a rejected confirmation that is accepted", { ...VALID.AI_CONFIRMATION_REJECTED, confirmation: { id: CONFIRMATION, state: "accepted" } }, "confirmation"], ["a rejected confirmation with the wrong reason", { ...VALID.AI_CONFIRMATION_REJECTED, reason: "permission_missing" }, "reason"],
    ["a confirmation id that is not a UUID", { ...VALID.AI_CONFIRMATION_REQUIRED, confirmation: { id: "c-1", state: "pending" } }, "confirmation"], ["an unknown confirmation state", { ...VALID.AI_CONFIRMATION_REQUIRED, confirmation: { id: CONFIRMATION, state: "limbo" } }, "confirmation"],
    ["an unknown type", { ...VALID.AI_ACTION_DENIED, type: "AI_SOMETHING" }, "type"],
  ])("refuses %s", (_name, input, field) => {
    throwsField(input as AuditEventInput, field);
  });

  it("lets a denial and an allowed or executed event carry a confirmation, in any state for a denial", () => {
    for (const state of ["pending", "accepted", "rejected", "invalidated"] as const) expect(buildAuditEvent({ ...VALID.AI_ACTION_DENIED, reason: "confirmation_expired", confirmation: { id: CONFIRMATION, state } }).confirmationState).toBe(state);
    expect(buildAuditEvent({ ...VALID.AI_ACTION_ALLOWED, confirmation: { id: CONFIRMATION, state: "accepted" } }).confirmationId).toBe(CONFIRMATION);
    expect(buildAuditEvent({ ...VALID.AI_ACTION_EXECUTED, confirmation: { id: CONFIRMATION, state: "accepted" } }).confirmationId).toBe(CONFIRMATION);
  });
  it("accepts every rate-limit reason and every denial outcome", () => {
    for (const reason of ["rate_limited_turn", "rate_limited_user", "rate_limited_tenant", "rate_limited_capability", "rate_limited_risk", "denial_throttle"] as const) expect(buildAuditEvent({ ...VALID.AI_RATE_LIMITED, reason }).reason).toBe(reason);
    for (const outcome of ["DENIED", "INVALID_ACTION", "INVALID_PARAMETERS", "UNAUTHORIZED", "FORBIDDEN_POLICY"] as const) expect(buildAuditEvent({ ...VALID.AI_ACTION_DENIED, outcome }).outcome).toBe(outcome);
    for (const outcome of ["FORBIDDEN_POLICY", "DENIED", "UNAUTHORIZED"] as const) expect(buildAuditEvent({ ...VALID.AI_POLICY_VIOLATION, outcome }).outcome).toBe(outcome);
  });
  it("accepts every risk level on a resolved action", () => {
    for (const risk of ["SAFE", "LOW", "MEDIUM", "HIGH", "CRITICAL", "FORBIDDEN"] as const) expect(buildAuditEvent({ ...VALID.AI_ACTION_DENIED, risk }).risk).toBe(risk);
  });
});

describe("limits of identifiers and states", () => {
  it("refuses a paragraph separator and the empty string in an identifier, and accepts 256 characters", () => {
    throwsField(base({ requestId: `a${String.fromCharCode(0x2029)}b` }), "requestId");
    throwsField(base({ requestId: "" }), "requestId");
    expect(buildAuditEvent(base({ requestId: "r".repeat(256) })).requestId).toHaveLength(256);
  });
  it("refuses an unknown confirmation state wherever a confirmation is optional", () => {
    throwsField({ ...VALID.AI_ACTION_DENIED, reason: "confirmation_expired", confirmation: { id: CONFIRMATION, state: "limbo" } } as never, "confirmation");
    throwsField({ ...VALID.AI_ACTION_ALLOWED, confirmation: { id: CONFIRMATION, state: "limbo" } } as never, "confirmation");
  });
  it("refuses a confirmation on a rate-limit event", () => {
    throwsField({ ...VALID.AI_RATE_LIMITED, confirmation: { id: CONFIRMATION, state: "invalidated" } }, "confirmation");
  });
  it("refuses an outcome or reason that is missing, or that is not a known code, for every type that carries one", () => {
    for (const type of AUDIT_EVENT_TYPES.filter((t) => t !== "AI_ACTION_PROPOSED")) {
      throwsField({ ...VALID[type], outcome: undefined } as never, "outcome");
      throwsField({ ...VALID[type], outcome: "NOPE" as never }, "outcome");
      throwsField({ ...VALID[type], reason: undefined } as never, "reason");
      throwsField({ ...VALID[type], reason: "nope" as never }, "reason");
    }
  });
});

describe("the resource", () => {
  it("scrubs the type as well as the id", () => {
    expect(buildAuditEvent({ ...VALID.AI_ACTION_ALLOWED, resource: { type: "sk-abcdefghijklmnopqrstuvwx", id: "p1" } }).resource).toEqual({ type: "[redacted]", id: "p1" });
  });
  it("is recorded scrubbed, and bounded identifiers only", () => {
    expect(buildAuditEvent({ ...VALID.AI_ACTION_ALLOWED, resource: { type: "project", id: "sk-abcdefghijklmnopqrstuvwx" } }).resource).toEqual({ type: "project", id: "[redacted]" });
    for (const bad of [{ type: "", id: "x" }, { type: "t", id: "" }, { type: "t", id: "a\nb" }, { type: 1, id: "x" }, { type: "t", id: "x".repeat(257) }]) throwsField({ ...VALID.AI_ACTION_ALLOWED, resource: bad as never }, "resource");
    expect(Object.isFrozen(buildAuditEvent(VALID.AI_ACTION_ALLOWED).resource)).toBe(true);
  });
});

describe("a built event is recognised, a look-alike is not", () => {
  it("accepts only what the builder made", () => {
    const event = buildAuditEvent(base());
    expect(isBuiltAuditEvent(event)).toBe(true);
    for (const imposter of [{ ...event }, JSON.parse(JSON.stringify(event)) as unknown, Object.create(event) as unknown, null, undefined, "x", 5]) expect(isBuiltAuditEvent(imposter)).toBe(false);
  });
});

describe("errors never carry a value", () => {
  it("names the field and nothing else, for every refusal", () => {
    const canary = "CANARY_VALUE_sk-abcdefghijklmnopqrstuvwx";
    const attempts: AuditEventInput[] = [base({ requestId: `${canary}\n` }), base({ reason: canary as never }), base({ outcome: canary as never }), base({ paramsView: [canary] }), base({ resource: { type: canary, id: "a\nb" } }),
      base({ action: { kind: "registered", id: canary, version: 1 } }), base({ confirmation: { id: canary, state: "pending" } }), base({ type: canary as never })];
    for (const attempt of attempts) {
      let message = "";
      try { buildAuditEvent(attempt); } catch (error) { message = (error as Error).message; }
      expect(message).toMatch(/^Invalid audit event: [A-Za-z]+$/);
      expect(message).not.toContain("CANARY");
    }
  });
});

describe("no model free text reaches any field (property)", () => {
  it("every string of the event is trusted, sanitized or a fixed vocabulary, whatever the model wrote", () => {
    fc.assert(fc.property(fc.string({ maxLength: 300 }), fc.string({ maxLength: 300 }), (name, note) => {
      const event = buildAuditEvent(base({ action: { kind: "attempted", name }, paramsView: {} }));
      if (event.actionId !== null) expect(event.actionId).toMatch(/^[\x20-\x7e]{1,64}$/);
      const line = JSON.stringify(event);
      expect(/[\p{Cc}\p{Zl}\p{Zp}]/u.test(line)).toBe(false);
      const withView = buildAuditEvent(base({ action: registered, paramsView: { "/note": note } }));
      expect(Object.keys(withView.paramsView)).toEqual(["/note"]);
      expect(/[\p{Cc}\p{Zl}\p{Zp}]/u.test(JSON.stringify(withView))).toBe(false);
    }), { numRuns: 150 });
  });
});

describe("createAuditEventBuilder: the id and the time come from the system, never from the caller", () => {
  it("fills id and occurredAt from its own sources, overriding anything supplied", () => {
    const builder = createAuditEventBuilder({ now: () => "2026-02-03T04:05:06Z", newId: () => ID });
    const { id: _id, occurredAt: _at, ...rest } = base();
    void _id; void _at;
    const event = builder.build({ ...rest, ...({ id: "forged", occurredAt: "1999-01-01T00:00:00Z" } as object) });
    expect([event.id, event.occurredAt]).toEqual([ID, "2026-02-03T04:05:06Z"]);
    expect(Object.isFrozen(builder)).toBe(true);
  });
  it("generates a fresh UUID per event by default", () => {
    const builder = createAuditEventBuilder({ now: () => AT });
    const { id: _id, occurredAt: _at, ...rest } = base();
    void _id; void _at;
    const [a, b] = [builder.build(rest), builder.build(rest)] as [AuditEvent, AuditEvent];
    expect(a.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    expect(a.id).not.toBe(b.id);
  });
  it("refuses an id or time it cannot trust", () => {
    const { id: _id, occurredAt: _at, ...rest } = base();
    void _id; void _at;
    expect(() => createAuditEventBuilder({ now: () => "soon", newId: () => ID }).build(rest)).toThrow("Invalid audit event: occurredAt");
    expect(() => createAuditEventBuilder({ now: () => AT, newId: () => "id" }).build(rest)).toThrow("Invalid audit event: id");
  });
});
