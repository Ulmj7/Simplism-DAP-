import { z } from "zod";
import { PIPELINE_STAGES, REASON_CODES } from "@dap/contracts";
import type { PolicyDecision } from "@dap/contracts";
import { isValidActionId } from "../registry/reserved-names.js";
import { snapshotAnswer } from "./answer-snapshot.js";

export const ISSUE_CODES = ["required", "type", "unknown_key", "too_long", "too_many", "out_of_range", "format", "invalid"] as const;
type Allowed = Extract<PolicyDecision, { outcome: "ALLOWED" }>;
type Confirmation = Extract<PolicyDecision, { outcome: "REQUIRES_CONFIRMATION" }>;
type Denial = Exclude<PolicyDecision, Allowed | Confirmation>;
const text = z.string().min(1);
const base = { decisionId: text, requestId: text };
const action = { ...base, actionId: z.custom<string>(isValidActionId), risk: z.enum(["SAFE", "LOW", "MEDIUM", "HIGH", "CRITICAL"]) };
const denialSchema = z.strictObject({
  ...base,
  outcome: z.enum(["DENIED", "INVALID_ACTION", "FORBIDDEN_POLICY", "UNAUTHORIZED", "INVALID_PARAMETERS"]).default("DENIED"),
  reason: z.enum(REASON_CODES), stage: z.enum(PIPELINE_STAGES),
  attemptedAction: z.string().transform((name) => name.slice(0, 64)).optional(),
  issues: z.array(z.strictObject({ path: z.string(), code: z.enum(ISSUE_CODES) })).optional(),
});

function fields(input: unknown, schema: z.ZodType): object {
  try {
    const parsed = schema.safeParse(snapshotAnswer(input));
    if (parsed.success) return snapshotAnswer(parsed.data) as object;
  } catch { /* Generic programmer error, never host values or Zod error text. */ }
  throw new TypeError("Invalid decision fields");
}

export function allowedDecision(input: Omit<Allowed, "outcome">): Allowed {
  const captured = fields(input, z.strictObject({ ...action, paramsDigest: z.string().regex(/^[a-f0-9]{64}$/) }));
  return Object.freeze({ ...captured, outcome: "ALLOWED" }) as Allowed;
}
export function confirmationDecision(input: Omit<Confirmation, "outcome">): Confirmation {
  const captured = fields(input, z.strictObject({ ...action, confirmationId: z.uuid() }));
  return Object.freeze({ ...captured, outcome: "REQUIRES_CONFIRMATION" }) as Confirmation;
}
export function denyDecision(input: Omit<Denial, "outcome"> & { readonly outcome?: Denial["outcome"] }): Denial {
  return fields(input, denialSchema) as Denial;
}
