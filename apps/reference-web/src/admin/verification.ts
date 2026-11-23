import { CHECK_ATTRIBUTES, expectedOf, MAX_ATTRIBUTE_EXPECTED, MAX_EXPECTED, VALUE_ROLES } from "../embed/checks.js";
import type { CheckAttribute } from "../embed/checks.js";
import type { CheckInput, CheckView } from "./checks.js";

/**
 * The verification editor's vocabulary (S4/S9): plain-word conditions instead of JSON. A condition plus a registered target (or a route) plus at most one short expected value is exactly one check of the
 * host's checks API; the step stores only that check's NAME in its `verify`.
 */
export type Condition = "none" | "visible" | "hidden" | "text" | "value" | "attribute" | "route" | "builtin";
export const conditionLabels: Readonly<Record<Condition, string>> = Object.freeze({
  none: "None", visible: "Element becomes visible", hidden: "Element becomes hidden", text: "Element text equals", value: "Element value equals", attribute: "Attribute equals", route: "Route equals", builtin: "Built-in check",
});
export const MANAGED_CONDITIONS: readonly Condition[] = ["none", "visible", "hidden", "text", "value", "attribute", "route"];
export const DO_NOT_ENTER_SECRETS = "Do not enter secrets. The value is compared in the page and is saved with the workflow.";

/** Which conditions a target supports: a value check reads a text box, a select or a checkbox; a text check reads everything else. */
export function conditionSupport(condition: Condition, role: string | undefined): { readonly ok: boolean; readonly reason?: string } {
  if (role === undefined) return { ok: true };
  if (condition === "value" && !VALUE_ROLES.includes(role)) return { ok: false, reason: "Only text boxes, selects and checkboxes have a value." };
  if (condition === "text" && VALUE_ROLES.includes(role)) return { ok: false, reason: "A field has a value, not a text: use “Element value equals”." };
  return { ok: true };
}

export interface VerificationFields { readonly condition: Condition; readonly targetId?: string; readonly route?: string; readonly attribute?: string; readonly expected?: string }
/** The check request for the chosen fields, or the sentence that says what is missing. */
export function checkInputOf(fields: VerificationFields, roleOf: (targetId: string) => string | undefined): { readonly input: CheckInput } | { readonly problem: string } {
  const { condition, targetId, route, attribute, expected } = fields;
  if (condition === "none" || condition === "builtin") return { problem: "Choose a condition." };
  if (condition === "route") return route ? { input: { kind: "route.equals", route } } : { problem: "Choose a route." };
  if (!targetId) return { problem: "Choose a target." };
  const support = conditionSupport(condition, roleOf(targetId));
  if (!support.ok) return { problem: support.reason! };
  if (condition === "visible") return { input: { kind: "element.visible", targetId } };
  if (condition === "hidden") return { input: { kind: "element.hidden", targetId } };
  const text = (expected ?? "").trim();
  const limit = condition === "attribute" ? MAX_ATTRIBUTE_EXPECTED : MAX_EXPECTED;
  if (!expectedOf(text, limit)) return { problem: `Enter the expected value (1 to ${limit} characters).` };
  if (condition === "text") return { input: { kind: "element.text.equals", targetId, expected: text } };
  if (condition === "value") return { input: { kind: "element.value.equals", targetId, expected: text } };
  if (!(CHECK_ATTRIBUTES as readonly string[]).includes(attribute ?? "")) return { problem: "Choose an attribute." };
  return { input: { kind: "element.attribute.equals", targetId, attribute: attribute as CheckAttribute, expected: text } };
}

/** A check in plain words, naming its target by its label. */
export function describeCheck(check: CheckView, labelOf: (targetId: string) => string): string {
  const target = check.targetId === null ? "" : `“${labelOf(check.targetId)}”`;
  switch (check.kind) {
    case "route.equals": return `The page is “${check.route}”`;
    case "element.visible": return `${target} becomes visible`;
    case "element.hidden": return `${target} becomes hidden`;
    case "element.text.equals": return `${target} text equals “${check.expected}”`;
    case "element.value.equals": return `${target} value equals “${check.expected}”`;
    default: return `${target} attribute ${check.attribute} equals “${check.expected}”`;
  }
}
/** The editor fields that reproduce an existing check (so choosing a step shows its verification). */
export function fieldsOf(check: CheckView): VerificationFields {
  const condition: Condition = check.kind === "route.equals" ? "route" : check.kind === "element.visible" ? "visible" : check.kind === "element.hidden" ? "hidden"
    : check.kind === "element.text.equals" ? "text" : check.kind === "element.value.equals" ? "value" : "attribute";
  return { condition, ...(check.targetId === null ? {} : { targetId: check.targetId }), ...(check.route === null ? {} : { route: check.route }), ...(check.attribute === null ? {} : { attribute: check.attribute }), ...(check.expected === null ? {} : { expected: check.expected }) };
}
