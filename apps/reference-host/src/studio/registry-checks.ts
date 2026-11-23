/**
 * The verification checks of a Studio-managed registry (Studio COMPLETION, S4): a CHECK is a named, closed, read-only observation of the application's page that a guide step may name as its `verify`.
 * It is DATA, never code: the embed runtime evaluates one of six fixed kinds against the live page, so nothing a maintainer types is ever executed.
 *
 *   route.equals              the page is the registered route                                         { route }
 *   element.visible           the target is on the page and shown                                      { targetId }
 *   element.hidden            the target is not on the page or not shown                               { targetId }
 *   element.text.equals       the visible text of the target equals `expected` exactly                 { targetId, expected }
 *   element.value.equals      the value of a textbox, select or checkbox target equals `expected`      { targetId, expected }   (textbox | select | checkbox targets only)
 *   element.attribute.equals  one allow-listed attribute of the target equals `expected`               { targetId, attribute, expected }
 *
 * DO NOT ENTER SECRETS in an expected value: it is stored and sent to the application's page in the clear, like a label. The expected value is never written to the audit log, a log line, an error
 * message or a Gateway answer (the audit records ids only); the HTTP replies show it only to the maintainer who owns the application.
 *
 * Identity. A check has no id of its own: its NAME is derived by the HOST from its content, `check.v` + the first 10 hex characters of the SHA-256 of the canonical JSON
 * `{kind,targetId,route,attribute,expected}` (that key order, `null` for an absent field). The same check therefore always has the same name, registering it twice is a no-op, and a guide's `verify`
 * names exactly one observation. The name is a registry POSTCONDITION name while its status is `active` and its target is `active` (a check whose target is disabled drops out of the registry, so a guide that
 * names it stops validating: fail closed). A check is immutable; only its status changes, and it is never deleted.
 */
import { createHash } from "node:crypto";
import { z } from "zod";
import { APPLICATION_ID } from "./applications.js";
import { MAX_TARGET_ID_CHARS, MAX_ROUTE_CHARS, isRouteName, isTargetId } from "./registry-targets.js";
import type { RegistrableRole } from "./registry-targets.js";

export const CHECK_KINDS = ["route.equals", "element.visible", "element.hidden", "element.text.equals", "element.value.equals", "element.attribute.equals"] as const;
export type CheckKind = (typeof CHECK_KINDS)[number];
export const CHECK_ATTRIBUTES = ["aria-checked", "aria-expanded", "aria-selected", "aria-pressed", "aria-disabled", "aria-current", "disabled", "checked"] as const;
export type CheckAttribute = (typeof CHECK_ATTRIBUTES)[number];
/** The roles whose value `element.value.equals` may observe. */
export const VALUE_CHECK_ROLES: readonly RegistrableRole[] = Object.freeze(["textbox", "select", "checkbox"] as const);
export const MAX_EXPECTED_CHARS = 120;
export const MAX_ATTRIBUTE_EXPECTED_CHARS = 40;
export const MAX_CHECKS_PER_APPLICATION = 100;
export const CHECK_NAME_PATTERN = /^check\.v[0-9a-f]{10}$/;
export const CHECK_STATUSES = ["active", "disabled"] as const;
export type CheckStatus = (typeof CHECK_STATUSES)[number];

const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;
export const isCheckName = (value: unknown): value is string => typeof value === "string" && CHECK_NAME_PATTERN.test(value);
export const isCheckKind = (value: unknown): value is CheckKind => (CHECK_KINDS as readonly unknown[]).includes(value);

/** The content of a check; absent fields are `null`. */
export interface CheckContent {
  readonly kind: CheckKind;
  readonly targetId: string | null;
  readonly route: string | null;
  readonly attribute: CheckAttribute | null;
  readonly expected: string | null;
}
export interface CheckRecord extends CheckContent { readonly name: string; readonly status: CheckStatus }
/** What the maintainer routes return (the contract's `CheckView`): `references` counts the stored guides whose steps name the check as their `verify`. */
export interface CheckView extends CheckRecord { readonly references: { readonly drafts: number; readonly published: number } }

/** The name of a check, from its (already validated) content. */
export function checkName(content: CheckContent): string {
  const canonical = JSON.stringify({ kind: content.kind, targetId: content.targetId, route: content.route, attribute: content.attribute, expected: content.expected });
  return `check.v${createHash("sha256").update(canonical).digest("hex").slice(0, 10)}`;
}

/** The fields each kind carries (and nothing else). */
const FIELDS: Readonly<Record<CheckKind, readonly string[]>> = Object.freeze({
  "route.equals": Object.freeze(["route"]),
  "element.visible": Object.freeze(["targetId"]),
  "element.hidden": Object.freeze(["targetId"]),
  "element.text.equals": Object.freeze(["targetId", "expected"]),
  "element.value.equals": Object.freeze(["targetId", "expected"]),
  "element.attribute.equals": Object.freeze(["targetId", "attribute", "expected"]),
});
export const CHECK_ISSUE_PHRASES = Object.freeze({
  shape: "check: must be an object with a kind and exactly the fields of that kind",
  kind: "kind: must be route.equals, element.visible, element.hidden, element.text.equals, element.value.equals or element.attribute.equals",
  targetId: "targetId: must be the dotted id of a registered target",
  route: `route: must be a name of at most ${MAX_ROUTE_CHARS} letters and digits starting with a lower-case letter`,
  attribute: "attribute: must be aria-checked, aria-expanded, aria-selected, aria-pressed, aria-disabled, aria-current, disabled or checked",
  expected: `expected: must be plain text without control characters, 1 to ${MAX_EXPECTED_CHARS} characters (1 to ${MAX_ATTRIBUTE_EXPECTED_CHARS} for an attribute) and not blank`,
  status: "status: must be active or disabled",
});

export type CheckValidation = { readonly ok: true; readonly value: CheckContent & { readonly name: string } } | { readonly ok: false; readonly issues: readonly string[] };

/**
 * The structural check of one check registration (the capability's parameter shape without `applicationId`). It decides only whether the VALUES are a legal check of THIS product; that the target
 * exists, is active and has a role the kind accepts is decided by the store under its lock. The issues are fixed phrases that never repeat what was supplied.
 */
export function validateCheckRegistration(input: unknown): CheckValidation {
  const P = CHECK_ISSUE_PHRASES;
  if (input === null || typeof input !== "object" || Array.isArray(input)) return Object.freeze({ ok: false, issues: Object.freeze([P.shape]) });
  let bag: Record<string, unknown>;
  // An absent optional field is simply absent (a key holding `undefined` counts as absent).
  try { bag = Object.fromEntries(Object.entries(input as Record<string, unknown>).filter(([, value]) => value !== undefined)); } catch { return Object.freeze({ ok: false, issues: Object.freeze([P.shape]) }); }
  if (!isCheckKind(bag.kind)) return Object.freeze({ ok: false, issues: Object.freeze([P.kind]) });
  const kind = bag.kind;
  const allowed = FIELDS[kind];
  const issues: string[] = [];
  if (Object.keys(bag).some((key) => key !== "kind" && !allowed.includes(key))) issues.push(P.shape);
  const content: { kind: CheckKind; targetId: string | null; route: string | null; attribute: CheckAttribute | null; expected: string | null } = { kind, targetId: null, route: null, attribute: null, expected: null };
  if (allowed.includes("route")) { if (isRouteName(bag.route)) content.route = bag.route; else issues.push(P.route); }
  if (allowed.includes("targetId")) { if (isTargetId(bag.targetId)) content.targetId = bag.targetId; else issues.push(P.targetId); }
  if (allowed.includes("attribute")) { if ((CHECK_ATTRIBUTES as readonly unknown[]).includes(bag.attribute)) content.attribute = bag.attribute as CheckAttribute; else issues.push(P.attribute); }
  if (allowed.includes("expected")) {
    const max = kind === "element.attribute.equals" ? MAX_ATTRIBUTE_EXPECTED_CHARS : MAX_EXPECTED_CHARS;
    const value = bag.expected;
    if (typeof value === "string" && value.length >= 1 && value.length <= max && value.trim() !== "" && !CONTROL.test(value)) content.expected = value;
    else issues.push(P.expected);
  }
  if (issues.length > 0) return Object.freeze({ ok: false, issues: Object.freeze(issues) });
  return Object.freeze({ ok: true, value: Object.freeze({ ...content, name: checkName(content) }) });
}

// --- the capability input schemas (shape and size only; the rules live in the validator above) -------------------------------------------------------------------
const bounded = (max: number) => z.string().min(1).max(max);
/** `registerStudioCheck` input: `kind` and the fields of that kind; the NAME is derived by the host, never supplied. */
export const registerCheckInputSchema = z.strictObject({
  applicationId: z.string().max(16).regex(APPLICATION_ID),
  kind: bounded(32),
  targetId: bounded(MAX_TARGET_ID_CHARS).optional(),
  route: bounded(MAX_ROUTE_CHARS).optional(),
  attribute: bounded(16).optional(),
  expected: bounded(MAX_EXPECTED_CHARS).optional(),
});
/** `setStudioCheckStatus` input. */
export const checkStatusInputSchema = z.strictObject({
  applicationId: z.string().max(16).regex(APPLICATION_ID),
  name: bounded(32),
  status: z.string().max(8).pipe(z.enum(CHECK_STATUSES)),
});
export type RegisterCheckInput = z.infer<typeof registerCheckInputSchema>;
export type CheckStatusInput = z.infer<typeof checkStatusInputSchema>;

/** The closed shape of a check in the guide bundle (the embed reviewer's shapes): only the fields of the kind, never a status, a reference count or a null. */
export type BundleCheck =
  | { readonly name: string; readonly kind: "route.equals"; readonly route: string }
  | { readonly name: string; readonly kind: "element.visible" | "element.hidden"; readonly targetId: string }
  | { readonly name: string; readonly kind: "element.text.equals" | "element.value.equals"; readonly targetId: string; readonly expected: string }
  | { readonly name: string; readonly kind: "element.attribute.equals"; readonly targetId: string; readonly attribute: string; readonly expected: string };

export function toBundleCheck(check: CheckRecord): BundleCheck {
  switch (check.kind) {
    case "route.equals": return Object.freeze({ name: check.name, kind: check.kind, route: check.route as string });
    case "element.visible": case "element.hidden": return Object.freeze({ name: check.name, kind: check.kind, targetId: check.targetId as string });
    case "element.text.equals": case "element.value.equals": return Object.freeze({ name: check.name, kind: check.kind, targetId: check.targetId as string, expected: check.expected as string });
    case "element.attribute.equals": return Object.freeze({ name: check.name, kind: check.kind, targetId: check.targetId as string, attribute: check.attribute as string, expected: check.expected as string });
  }
}
