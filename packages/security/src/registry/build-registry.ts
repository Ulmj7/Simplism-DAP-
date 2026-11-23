import { z } from "zod";
import type { ActionRegistry, AnyActionDefinition, GatewayConfig, RegisteredAction, RegistrationIssue, RegistrationRule } from "@dap/contracts";
import { definitionHash, registryFingerprint } from "./definition-hash.js";
import { RegistrationError } from "./registration-error.js";
import { isReservedForbidden, isValidActionId } from "./reserved-names.js";
import { inspectInputSchema } from "./schema-rules.js";
import { frozenView, Snapshot } from "./snapshot.js";

const text = z.string().refine((value) => value.trim().length > 0);
const auditSchema = z.strictObject({ params: z.array(z.strictObject({
  path: z.string().regex(/^(?:\/(?:[^~/]|~[01])*)*$/), mode: z.enum(["plain", "masked"]),
})) });
const fields = {
  id: z.custom<string>(isValidActionId),
  version: z.number().int().min(1),
  description: text,
  inputSchema: z.custom<z.ZodType>((value) => value instanceof z.core.$ZodType),
  risk: z.enum(["SAFE", "LOW", "MEDIUM", "HIGH", "CRITICAL", "FORBIDDEN"]),
  requiredPermission: text,
  allowedPages: z.union([z.literal("any"), z.array(text).min(1)]),
  confirmation: z.discriminatedUnion("kind", [
    z.strictObject({ kind: z.literal("required") }),
    z.strictObject({ kind: z.literal("not-required"), justification: text.refine(value => value.length <= 1000).optional() }),
  ]),
  changesState: z.boolean(),
  audit: auditSchema,
  resource: z.custom((value) => typeof value === "function").optional(),
  describeConsequence: z.custom((value) => typeof value === "function").optional(),
  confirmationTtlSeconds: z.number().int().positive().optional(),
  executorId: text,
};
const required = new Set(Object.keys(fields).filter((key) => !["resource", "describeConsequence", "confirmationTtlSeconds"].includes(key)));

/** Build once, snapshot before validating, collect every issue, and publish no mutable table. */
export function buildRegistry(
  definitions: readonly AnyActionDefinition[],
  options: Partial<Pick<GatewayConfig, "confirmationDefaultTtlSeconds">> = {},
): ActionRegistry {
  const issues: RegistrationIssue[] = [];
  const reader = new Snapshot();
  const entries = new Map<string, RegisteredAction>();
  const seen = new Set<string>();
  const add = (actionId: string, rule: RegistrationRule, detail: string): void => { issues.push({ actionId, rule, detail }); };
  let defaultTtl: unknown;
  try {
    const configured = reader.read(options, "confirmationDefaultTtlSeconds");
    defaultTtl = configured === undefined ? 300 : configured;
  } catch { defaultTtl = undefined; }
  if (typeof defaultTtl !== "number" || !Number.isSafeInteger(defaultTtl) || defaultTtl < 1 || defaultTtl > 900) {
    add("<registry>", "R11", "confirmationDefaultTtlSeconds must be an integer from 1 to 900");
  }

  let length: unknown;
  try { length = Array.isArray(definitions) ? reader.read(definitions, "length") : undefined; } catch { length = undefined; }
  if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0) {
    throw new RegistrationError([...issues, { actionId: "<registry>", rule: "R1", detail: "definitions must be an array" }]);
  }
  for (let index = 0; index < length; index += 1) {
    let source: unknown;
    try { source = reader.read(definitions, String(index)); } catch { source = undefined; }
    if (source === null || typeof source !== "object") {
      add(`<definition:${index}>`, "R1", "definition must be an object");
      continue;
    }
    const captured: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
    const failures: { field: string; rule: RegistrationRule }[] = [];
    let ownKeys: PropertyKey[] = [];
    try { ownKeys = Reflect.ownKeys(source); } catch { failures.push({ field: "definition keys", rule: "R1" }); }
    for (const key of ownKeys) {
      if (typeof key !== "string" || !Object.hasOwn(fields, key)) failures.push({ field: String(key), rule: "R1" });
    }
    for (const field of Object.keys(fields)) {
      try {
        const value = reader.copy(reader.read(source, field));
        if (value !== undefined) captured[field] = value;
      } catch { failures.push({ field, rule: field === "inputSchema" ? "R3" : "R1" }); }
      if (required.has(field) && !ownKeys.includes(field)) failures.push({ field, rule: "R1" });
    }
    const actionId = typeof captured.id === "string" ? captured.id : `<definition:${index}>`;
    const issueStart = issues.length;
    for (const { field, rule } of failures) add(actionId, rule, `${field} could not be captured as definition data`);
    for (const [field, schema] of Object.entries(fields)) {
      if (!schema.safeParse(captured[field]).success) add(actionId, "R1", `${field} is missing or invalid`);
    }
    if (typeof captured.id === "string") {
      if (seen.has(captured.id)) add(actionId, "R2", "duplicate exact action id");
      seen.add(captured.id);
    }
    const inspection = inspectInputSchema(captured.inputSchema as z.ZodType);
    for (const detail of inspection.issues) add(actionId, "R3", detail);

    const { risk, confirmation, changesState, resource, describeConsequence, confirmationTtlSeconds } = captured;
    const policy = confirmation !== null && typeof confirmation === "object" ? confirmation as Record<string, unknown> : {};
    if ((risk === "HIGH" || risk === "CRITICAL") && policy.kind !== "required") add(actionId, "R4", "HIGH and CRITICAL require confirmation");
    if (risk === "MEDIUM" && policy.kind !== "required" &&
      !(policy.kind === "not-required" && typeof policy.justification === "string" && policy.justification.trim().length > 0)) {
      add(actionId, "R5", "MEDIUM requires confirmation or a written justification");
    }
    if ((risk === "SAFE" || risk === "LOW") && changesState === true) add(actionId, "R6", "SAFE and LOW cannot change state");
    // executorId is a reference, not an executor. R7's absence of a binding is checked by bindExecutors.
    if (policy.kind === "required" && typeof describeConsequence !== "function") add(actionId, "R8", "required confirmation needs describeConsequence");
    // Resource targeting is declared by an extractor; the contract has no independent targeting flag.
    if (changesState === true && typeof resource !== "function") add(actionId, "R9", "state changes require a resource extractor");
    if (confirmationTtlSeconds !== undefined &&
      !(typeof confirmationTtlSeconds === "number" && Number.isSafeInteger(confirmationTtlSeconds) && confirmationTtlSeconds >= 1 &&
        typeof defaultTtl === "number" && confirmationTtlSeconds <= defaultTtl)) {
      add(actionId, "R11", "confirmationTtlSeconds must be a positive integer at most the global default");
    }
    if (!auditSchema.safeParse(captured.audit).success) add(actionId, "R12", "audit is mandatory with only a params allowlist; opt-outs are not supported");

    if (issues.length === issueStart && inspection.inputSchemaJson !== undefined) {
      try {
        const definition = captured as unknown as AnyActionDefinition;
        const hash = definitionHash(definition, inspection.inputSchemaJson);
        entries.set(actionId, Object.freeze({ definition: frozenView(definition), definitionHash: hash }));
      } catch { add(actionId, "R1", "definition could not be frozen and hashed"); }
    }
  }
  if (issues.length > 0) throw new RegistrationError(issues);
  const list = Object.freeze([...entries.values()]);
  return Object.freeze({
    get: (id: string) => entries.get(id),
    list: () => list,
    isReservedForbidden,
    fingerprint: registryFingerprint(list.map(({ definitionHash }) => definitionHash)),
  });
}
