import { effectivePrivacy, ATTR_ID, ATTR_IGNORE, ATTR_PRIVATE, ATTR_REDACT } from "@dap/walkthrough";
import type { Postconditions } from "@dap/walkthrough";

/**
 * Studio completion S4 in the embed: the verification checks of a managed registry, evaluated LOCALLY against the page. No selector, no script: a check names a kind, a registered target (resolved
 * through its marker) and at most one short expected value. Values are compared in place and never leave the page: nothing here posts, logs or returns what the page held (only a boolean).
 */
export const CHECK_KINDS = ["route.equals", "element.visible", "element.hidden", "element.text.equals", "element.value.equals", "element.attribute.equals"] as const;
export type CheckKind = (typeof CHECK_KINDS)[number];
export const CHECK_ATTRIBUTES = ["aria-checked", "aria-expanded", "aria-selected", "aria-pressed", "aria-disabled", "aria-current", "disabled", "checked"] as const;
export type CheckAttribute = (typeof CHECK_ATTRIBUTES)[number];
export const CHECK_NAME = /^check\.v[0-9a-f]{10}$/u;
export const MAX_CHECKS = 100;
export const MAX_EXPECTED = 120;
export const MAX_ATTRIBUTE_EXPECTED = 40;
/** The roles whose live value a check may compare. */
export const VALUE_ROLES: readonly string[] = ["textbox", "select", "checkbox"];

interface Named { readonly name: string }
export type CheckDef = Named & (
  | { readonly kind: "route.equals"; readonly route: string }
  | { readonly kind: "element.visible" | "element.hidden"; readonly targetId: string }
  | { readonly kind: "element.text.equals" | "element.value.equals"; readonly targetId: string; readonly expected: string }
  | { readonly kind: "element.attribute.equals"; readonly targetId: string; readonly attribute: CheckAttribute; readonly expected: string }
);

/** Plain, short, no control characters; the value is compared, never rendered as markup. */
export const expectedOf = (value: unknown, max: number): value is string => typeof value === "string" && value.length >= 1 && value.length <= max && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/u.test(value);

/** Presence of the element behind a marker, as one constant-selector pass over the document (the marker is only ever compared as a string). */
export type Presence = { readonly state: "absent" | "ambiguous" | "hidden" | "ignored" } | { readonly state: "visible"; readonly element: HTMLElement };

function isVisible(element: HTMLElement): boolean {
  if (!element.isConnected) return false;
  const view = element.ownerDocument.defaultView;
  if (view === null) return false;
  for (let node: Element | null = element; node !== null; node = node.parentElement) {
    if (node.hasAttribute("inert") || node.hasAttribute("hidden") || node.getAttribute("aria-hidden") === "true") return false;
    if (node.tagName === "DETAILS" && !node.hasAttribute("open")) {
      const summary = Array.from(node.children).find(child => child.tagName === "SUMMARY");
      if (summary === undefined || !summary.contains(element)) return false;
    }
    if (view.getComputedStyle(node).display === "none") return false;
  }
  const visibility = view.getComputedStyle(element).visibility;
  return visibility !== "hidden" && visibility !== "collapse";
}

/** `public`: nothing in the markup marks the element ignored, private or redacted, and it is not a password/hidden/credential input. Only a public element's text or value may be read. */
function isPublic(element: HTMLElement): boolean {
  return effectivePrivacy({
    ignoredByAncestorOrSelf: element.closest(`[${ATTR_IGNORE}]`) !== null, private: element.hasAttribute(ATTR_PRIVATE), redact: element.hasAttribute(ATTR_REDACT),
    tagName: element.tagName, inputType: element.getAttribute("type"), autocomplete: element.getAttribute("autocomplete"), registryPrivacy: "public",
  }) === "public";
}

export function presenceOf(root: HTMLElement, marker: string): Presence {
  const matches = Array.from(root.querySelectorAll<HTMLElement>(`[${ATTR_ID}]`)).filter(candidate => candidate.getAttribute(ATTR_ID) === marker);
  if (matches.length === 0) return { state: "absent" };
  if (matches.length > 1) return { state: "ambiguous" };
  const element = matches[0]!;
  if (!isVisible(element)) return { state: "hidden" };
  return isPublic(element) ? { state: "visible", element } : { state: "ignored" };
}

const booleanText = (value: boolean) => (value ? "true" : "false");

/** What a check reads off a PUBLIC, visible, unique element; `null` when the kind cannot read it. */
function liveValue(kind: "text" | "value" | "attribute", element: HTMLElement, attribute?: CheckAttribute): string | null {
  if (kind === "text") return (element.textContent ?? "").trim();
  if (kind === "value") {
    if (element instanceof element.ownerDocument.defaultView!.HTMLInputElement && (element.type === "checkbox" || element.type === "radio")) return booleanText(element.checked);
    if ("value" in element && typeof (element as HTMLInputElement).value === "string") return (element as HTMLInputElement).value;
    return null;
  }
  if (attribute === "disabled") return booleanText(element.hasAttribute("disabled") || (element as HTMLButtonElement).disabled === true);
  if (attribute === "checked") return booleanText((element as HTMLInputElement).checked === true || element.hasAttribute("checked"));
  return attribute === undefined ? null : element.getAttribute(attribute);
}

export interface CheckPorts {
  readonly root: HTMLElement;
  /** The current route name of the page (`""` when unknown). */
  readonly route: () => string;
  /** DAP target id -> the marker the page carries. */
  readonly markerOf: (targetId: string) => string | undefined;
  /** DAP target id -> its registered role (value checks only read textbox, select and checkbox). */
  readonly roleOf: (targetId: string) => string | undefined;
}

/** One evaluator: `true` only when the page matches exactly; every other outcome (absent, ambiguous, private, wrong role, thrown error) is `false`. */
export function evaluateCheck(check: CheckDef, ports: CheckPorts): boolean {
  try {
    if (check.kind === "route.equals") return ports.route() === check.route;
    const marker = ports.markerOf(check.targetId);
    if (marker === undefined) return false;
    const presence = presenceOf(ports.root, marker);
    if (check.kind === "element.visible") return presence.state === "visible";
    if (check.kind === "element.hidden") return presence.state === "absent" || presence.state === "hidden";
    if (presence.state !== "visible") return false;
    if (check.kind === "element.text.equals") return liveValue("text", presence.element) === check.expected.trim();
    if (check.kind === "element.value.equals") {
      const role = ports.roleOf(check.targetId);
      return role !== undefined && VALUE_ROLES.includes(role) && liveValue("value", presence.element) === check.expected;
    }
    if (check.kind !== "element.attribute.equals") return false;
    return liveValue("attribute", presence.element, check.attribute) === check.expected;
  } catch { return false; }
}

/** The named postconditions of a registry: `route.<route>` for every route and one `check.v…` per check. */
export function checkPostconditions(routes: readonly string[], checks: readonly CheckDef[], ports: CheckPorts): Postconditions {
  const named: Record<string, () => boolean> = {};
  for (const route of routes) named[`route.${route}`] = () => ports.route() === route;
  for (const check of checks) named[check.name] = () => evaluateCheck(check, ports);
  return Object.freeze(named);
}
