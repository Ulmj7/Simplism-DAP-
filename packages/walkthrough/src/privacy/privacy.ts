/**
 * The privacy boundary (Constitution VI), its own module. DOM-free: it works on plain facts about an element, so it unit-tests in Node.
 * Nothing here ever returns a value, text or HTML of the page.
 */
import type { SemanticPrivacy, SemanticRegistry, SemanticRole } from "../semantic/types.js";

export const ATTR_ID = "data-ai-id";
export const ATTR_IGNORE = "data-ai-ignore";
export const ATTR_PRIVATE = "data-ai-private";
export const ATTR_REDACT = "data-ai-redact";
export const REDACTED_MARKER = "[REDACTED]";

/** What the DOM adapter reads off an element (and its ancestors) and hands over as plain data. */
export interface ElementFacts {
  /** The element or any ancestor carries `data-ai-ignore`. */
  readonly ignoredByAncestorOrSelf: boolean;
  /** The element carries `data-ai-private`. */
  readonly private: boolean;
  /** The element carries `data-ai-redact`. */
  readonly redact: boolean;
  readonly tagName: string;
  readonly inputType?: string | null;
  /** Standard autocomplete tokens identifying credentials or payment-card data. */
  readonly autocomplete?: string | null;
  /** The registry's privacy for this element, when it is registered. */
  readonly registryPrivacy?: SemanticPrivacy;
}

export type EffectivePrivacy = "ignore" | SemanticPrivacy;

/** `ignore` beats everything; `type=password|hidden` inputs are ignored always, registered or not. Otherwise the strictest of the markup and the registry wins. */
export function effectivePrivacy(facts: ElementFacts): EffectivePrivacy {
  if (facts.ignoredByAncestorOrSelf) return "ignore";
  const type = typeof facts.inputType === "string" ? facts.inputType.trim().toLowerCase() : "";
  if (String(facts.tagName).toLowerCase() === "input" && (type === "password" || type === "hidden")) return "ignore";
  const autocomplete = typeof facts.autocomplete === "string" ? facts.autocomplete.trim().toLowerCase().split(/\s+/) : [];
  if (autocomplete.some(token => token.startsWith("cc-") || token === "current-password" || token === "new-password" || token === "one-time-code")) return "ignore";
  if (facts.private || facts.registryPrivacy === "private") return "private";
  if (facts.redact || facts.registryPrivacy === "redact") return "redact";
  return "public";
}

export type ValueView =
  | { readonly kind: "omitted" }
  | { readonly kind: "redacted"; readonly marker: typeof REDACTED_MARKER }
  | { readonly kind: "present" }
  | { readonly kind: "empty" };

/** The only description of a field's value that may leave the page: whether it exists, never what it is. */
export function describeValue(privacy: EffectivePrivacy, rawValue: unknown): ValueView {
  if (privacy === "ignore" || privacy === "private") return Object.freeze({ kind: "omitted" });
  if (privacy === "redact") return Object.freeze({ kind: "redacted", marker: REDACTED_MARKER });
  return Object.freeze({ kind: typeof rawValue === "string" && rawValue.length > 0 ? "present" : "empty" });
}

export interface SemanticContextElement {
  readonly id: string;
  readonly role: SemanticRole;
  readonly label: string;
  readonly description: string;
  readonly privacy: SemanticPrivacy;
  readonly available: boolean;
}
export interface SemanticContext {
  readonly route: string;
  readonly elements: readonly SemanticContextElement[];
}

/**
 * The only producer of page data meant for AI use. It reads registry metadata and a plain availability lookup, nothing else: never the DOM,
 * values, text or HTML.
 */
export function buildSemanticContext(registry: SemanticRegistry, route: string, availability: (id: string) => boolean): SemanticContext {
  const elements = registry.forRoute(route).map((def) => {
    let available = false;
    try { available = availability(def.id) === true; } catch { available = false; }
    return Object.freeze({ id: def.id, role: def.role, label: def.label, description: def.description, privacy: def.privacy, available });
  });
  return Object.freeze({ route, elements: Object.freeze(elements) });
}
