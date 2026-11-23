import { z } from "zod";
import type { FeedbackIssue, Outcome, ReasonCode } from "@dap/contracts";
import { denialScenario } from "./denial-scenario.js";

/** Register this bounded strict schema on the target for the PARAMS scenario fixture. */
export const malformedParamsSchema = z.strictObject({
  message: z.string().max(200),
  options: z.strictObject({ nested: z.strictObject({ leaf: z.strictObject({ value: z.string().max(20) }) }) }).optional(),
  count: z.number().min(0).max(10).optional(),
  tags: z.array(z.string().max(20)).max(2).optional(),
});
const envelope = (action: string, params: unknown) => ({ action, params });
const invalid = (raw: unknown, outcome: Outcome = "INVALID_PARAMETERS", reason: ReasonCode = "invalid_parameters") => ({ raw, outcome, reason });
const issue = (path: string, code: FeedbackIssue["code"]): readonly FeedbackIssue[] => [{ path, code }];
const schemaCase = (id: string, title: string, params: () => readonly unknown[], issues: readonly (readonly FeedbackIssue[])[]) => denialScenario(`ATK-PARAMS-${id}`, "malformed-parameters", title, ({ actionId }) => params().map((value, index) => ({ ...invalid(envelope(actionId, value)), auditedAction: actionId, issues: issues[index]! })));

/** 08/09 need caps maxJsonDepth=8 and maxPayloadBytes=1024. Run in fresh replay/rate state. */
export const malformedParameterScenarios = [
  schemaCase("01", "missing required message", () => [{}], [issue("/message", "required")]),
  schemaCase("02", "mistyped scalar/object", () => [{ message: 7 }, { message: "ok", count: "1" }, { message: "ok", options: [] }], [issue("/message", "type"), issue("/count", "type"), issue("/options", "type")]),
  schemaCase("03", "extra top-level parameter", () => [{ message: "ok", unexpected: "value" }], [issue("", "unknown_key")]),
  // Feedback currently redacts unknown-key paths to the root, including nested unknown keys.
  schemaCase("04", "extra key at depth three", () => [{ message: "ok", options: { nested: { leaf: { value: "ok", extra: true } } } }], [issue("", "unknown_key")]),
  schemaCase("05", "bounded strings arrays and numbers", () => [{ message: "x".repeat(201) }, { message: "ok", tags: ["a", "b", "c"] }, { message: "ok", count: 11 }, { message: "ok", count: -1 }], [issue("/message", "too_long"), issue("/tags", "too_many"), issue("/count", "out_of_range"), issue("/count", "out_of_range")]),
  denialScenario("ATK-PARAMS-06", "malformed-parameters", "duplicate raw JSON keys", ({ actionId }) => [invalid(`{"action":"${actionId}","params":{"message":"a","message":"b"}}`, "INVALID_ACTION", "malformed_envelope"), invalid(`{"action":"${actionId}","action":"deleteEverything","params":{"message":"ok"}}`, "INVALID_ACTION", "malformed_envelope")]),
  denialScenario("ATK-PARAMS-07", "malformed-parameters", "prototype keys in raw JSON", ({ actionId }) => ["__proto__", "constructor", "prototype"].flatMap((key) => [invalid(`{"action":"${actionId}","params":{"message":"ok","${key}":{}}}`, "INVALID_ACTION", "malformed_envelope"), invalid(`{"action":"${actionId}","params":{"message":"ok","options":{"${key}":{}}}}`, "INVALID_ACTION", "malformed_envelope")])),
  denialScenario("ATK-PARAMS-08", "malformed-parameters", "depth cap of eight exceeded", ({ actionId }) => [invalid(envelope(actionId, { message: "ok", nested: Array.from({ length: 12 }).reduce<unknown>((value) => ({ child: value }), null) }), "INVALID_ACTION", "malformed_envelope")]),
  denialScenario("ATK-PARAMS-09", "malformed-parameters", "1024-byte cap exceeded with multibyte UTF-8", ({ actionId }) => [invalid(JSON.stringify(envelope(actionId, { message: "界".repeat(400) })), "INVALID_ACTION", "payload_too_large")]),
  denialScenario("ATK-PARAMS-10", "malformed-parameters", "non-finite object numbers", ({ actionId }) => [NaN, Infinity, -Infinity].map((count) => invalid(envelope(actionId, { message: "ok", count })))),
  schemaCase("11", "identity-like keys at top level and nested", () => ["tenantId", "userId", "role", "confirmed", "isAdmin"].flatMap((key) => [{ message: "ok", [key]: "claimed" }, { message: "ok", options: { nested: { leaf: { value: "ok", [key]: "claimed" } } } }]), Array.from({ length: 10 }, () => issue("", "unknown_key"))),
  schemaCase("12", "getter and Proxy initially invalid then valid must remain denied", () => {
    let getterReads = 0;
    let proxyReads = 0;
    return [{ get message() { return ++getterReads === 1 ? 7 : "ok"; } }, new Proxy({ message: 7 }, { get(target, key, receiver) { return key === "message" ? (++proxyReads === 1 ? 7 : "ok") : Reflect.get(target, key, receiver); } })];
  }, [issue("/message", "type"), issue("/message", "type")]),
  denialScenario("ATK-PARAMS-13", "malformed-parameters", "extra envelope keys", ({ actionId }) => ["callId", "requestId", "userConfirmed"].map((key) => invalid({ ...envelope(actionId, { message: "ok" }), [key]: "fabricated" }, "INVALID_ACTION", "malformed_envelope"))),
];
