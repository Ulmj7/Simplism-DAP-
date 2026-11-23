/**
 * @dap/security: validation/params.ts
 *
 * T063 / FR-018, FR-020. Validate the model's parameters against a registered definition's strict schema and
 * produce the ONLY thing later stages may authorize, digest, confirm, audit or execute: the normalized,
 * deeply frozen output, together with the resource it targets and a digest that binds it to the action, the
 * tenant and the user.
 *
 * `paramsDigest` is SHA-256 over canonical JSON of `{actionId, version, params, resource, tenant, user}`
 * (data-model: `sec_confirmations.params_digest`). Tenant and user cannot be derived from `(definition,
 * params)`, so they are a required third argument: omitting them would silently weaken the digest. `resource`
 * is `definition.resource?.(normalized) ?? null`, called exactly once, on the normalized parameters.
 *
 * Planner-facing issues carry a JSON-pointer path and one of eight generic codes, never a value, a message or
 * a model-authored key: an unknown key is reported at its PARENT's path.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import type { AnyActionDefinition, FeedbackIssue, JsonValue, ResourceRef, Sha256Hex } from "@dap/contracts";
import { canonicalJson } from "./canonical.js";
import { parseStrictJson } from "./strict-json.js";
import type { StrictJsonCode, StrictJsonOptions } from "./strict-json.js";
import { declaredIssuePath } from "./issue-path.js";

export interface ParamsScope {
  readonly tenantId: string;
  readonly userId: string;
}

export type ValidatedParams =
  | { readonly ok: true; readonly normalized: JsonValue; readonly resource: ResourceRef | null; readonly paramsDigest: Sha256Hex }
  | { readonly ok: false; readonly issues: readonly FeedbackIssue[] };

type Code = FeedbackIssue["code"];
const MAX_ISSUES = 64;

const text = (value: unknown): value is string => typeof value === "string" && value.length > 0;

/** The inputs of the digest, exactly. Everything is checked: a digest over garbage binds nothing. */
export interface ParamsDigestInput {
  readonly actionId: string;
  readonly version: number;
  readonly params: unknown;
  readonly resource: ResourceRef | null;
  readonly tenantId: string;
  readonly userId: string;
}

/** Recomputable from a stored confirmation row (T105): the same function the validate stage used. */
export function paramsDigest(input: ParamsDigestInput): Sha256Hex {
  const { actionId, version, params, resource, tenantId, userId } = input;
  if (!text(actionId) || !Number.isSafeInteger(version) || version < 1 || !text(tenantId) || !text(userId)) {
    throw new TypeError("A parameter digest needs an action, a version, a tenant and a user");
  }
  // Capture the entire binding together: params and resource may alias the same hostile object.
  const encoded = canonicalJson({ actionId, version, params, resource, tenant: tenantId, user: userId });
  const captured = (JSON.parse(encoded) as { resource: unknown }).resource;
  if (captured !== null && !(typeof captured === "object" && Object.keys(captured).length === 2 && text(Reflect.get(captured, "type")) && text(Reflect.get(captured, "id")))) {
    throw new TypeError("A parameter digest needs a resource of exactly { type, id } or null");
  }
  return createHash("sha256").update(encoded, "utf8").digest("hex") as Sha256Hex;
}

function pointer(path: readonly PropertyKey[]): string {
  return path.map((segment) => `/${String(segment).replaceAll("~", "~0").replaceAll("/", "~1")}`).join("");
}

/**
 * Is the value at `path` absent from `input`? An absent LAST key is "required"; a value that is present, or whose
 * parent is absent or not an object, is a wrong type. `input` is the strict copy, which is JSON data and so can
 * never hold an explicit undefined: presence is the only question.
 */
function isMissing(input: unknown, path: readonly PropertyKey[]): boolean {
  let node: unknown = input;
  for (const segment of path) {
    if (node === null || typeof node !== "object") return false;
    if (!Object.hasOwn(node, segment)) return segment === path.at(-1);
    node = (node as Record<PropertyKey, unknown>)[segment];
  }
  return false;
}

interface ZodLike { readonly code: string; readonly path: readonly PropertyKey[]; readonly origin?: unknown }

function toIssues(issues: readonly ZodLike[], input: unknown, schema: unknown): readonly FeedbackIssue[] {
  const seen = new Set<string>();
  const out: FeedbackIssue[] = [];
  for (const issue of issues) {
    const segments = [...issue.path];
    const path = declaredIssuePath(schema, segments, input) ? pointer(segments) : "";
    let code: Code;
    switch (issue.code) {
      case "invalid_type": code = isMissing(input, segments) ? "required" : "type"; break;
      case "too_big": code = issue.origin === "string" ? "too_long" : issue.origin === "array" ? "too_many" : "out_of_range"; break;
      case "too_small": case "not_multiple_of": code = "out_of_range"; break;
      case "invalid_format": code = "format"; break;
      // The offending key is model-authored text: only the object that contains it is reported.
      case "unrecognized_keys": code = "unknown_key"; break;
      default: code = "invalid";
    }
    const key = `${code}\u0000${path}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ path, code });
    if (out.length >= MAX_ISSUES) break;
  }
  return out;
}

// `duplicate_key` and `syntax` arise only from JSON TEXT, and a string is rejected before intake; they stay so the map is exhaustive.
const STRICT_JSON_ISSUE: Record<StrictJsonCode, Code> = {
  too_large: "too_long", too_deep: "out_of_range", duplicate_key: "unknown_key", forbidden_key: "unknown_key",
  not_finite: "out_of_range", unsafe_number: "out_of_range", not_plain: "type", syntax: "type",
};

const reject = (issues: readonly FeedbackIssue[]): ValidatedParams =>
  Object.freeze({ ok: false, issues: Object.freeze(issues.map(({ path, code }) => Object.freeze({ path, code }))) });

/**
 * A resource extractor's answer, proven to be exactly `{ type, id }` of non-empty text, copied once and frozen.
 * A string is never an answer: strict intake would read it as JSON text, which an extractor must not return.
 */
function captureResource(answer: unknown): ResourceRef | null {
  if (answer === null || answer === undefined) return null;
  const copy = typeof answer === "object" ? parseStrictJson(answer) : undefined;
  if (!copy?.ok) throw new TypeError("A resource extractor must return { type, id } or null");
  const { type, id } = copy.value as Record<string, unknown>;
  if (Object.keys(copy.value as object).length !== 2 || !text(type) || !text(id)) throw new TypeError("A resource extractor must return { type, id } or null");
  return Object.freeze({ type, id });
}

/**
 * Validate `params` for `definition`, for the given tenant and user.
 *
 * `params` is copied exactly once through strict intake (so a getter or Proxy answers once, ATK-PARAMS-12) and
 * only the copy reaches the schema. Throws a TypeError for a defect in the DEFINITION (a schema or extractor that
 * produces something that is not JSON data), never for a hostile input: those are `{ ok: false, issues }`.
 */
export function validateParams(
  definition: Pick<AnyActionDefinition, "id" | "version" | "inputSchema" | "resource">,
  params: unknown,
  scope: ParamsScope,
  options: StrictJsonOptions = {},
): ValidatedParams {
  const tenantId: unknown = scope.tenantId;
  const userId: unknown = scope.userId;
  if (!text(tenantId) || !text(userId)) throw new TypeError("Parameters are validated for a tenant and a user");
  const actionId: unknown = definition.id;
  const version: unknown = definition.version;
  const schema: unknown = definition.inputSchema;
  const extract: unknown = definition.resource;
  const safeParse: unknown = schema !== null && typeof schema === "object" ? Reflect.get(schema, "safeParse") : undefined;
  if (!text(actionId) || typeof version !== "number" || typeof safeParse !== "function") {
    throw new TypeError("Cannot validate against a malformed definition");
  }
  // A string is JSON TEXT to strict intake; parameters are always data, and a string is never a parameter object.
  if (typeof params === "string") return reject([{ path: "", code: "type" }]);
  const copy = parseStrictJson(params, options);
  if (!copy.ok) return reject([{ path: "", code: STRICT_JSON_ISSUE[copy.code] }]);

  const parsed = Reflect.apply(safeParse, schema, [copy.value]) as { success: boolean; data?: unknown; error?: { issues: readonly ZodLike[] } };
  if (!parsed.success) {
    let declared: unknown;
    try { declared = z.toJSONSchema(schema as z.ZodType, { io: "input", unrepresentable: "throw" }); }
    catch { /* A defective schema has no provable diagnostic paths; only the root is safe. */ }
    return reject(toIssues(parsed.error?.issues ?? [], copy.value, declared));
  }

  // Only the normalized OUTPUT is ever authorized, digested, confirmed, audited and executed (FR-020): it must be JSON data.
  const normalized = parseStrictJson(parsed.data, options);
  if (!normalized.ok) throw new TypeError("A schema's normalized output must be plain JSON data");
  const resource = typeof extract === "function" ? captureResource((extract as (params: unknown) => unknown)(normalized.value)) : null;
  const digest = paramsDigest({ actionId, version, params: normalized.value, resource, tenantId, userId });
  return Object.freeze({ ok: true, normalized: normalized.value, resource, paramsDigest: digest });
}
