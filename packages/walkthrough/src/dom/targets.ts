/**
 * DOM targets: finds the element behind a registered semantic id. The id is NEVER put into a CSS selector: elements are found by iterating
 * `root.querySelectorAll("[data-ai-id]")` (a constant selector) and comparing the attribute VALUE to the id as a plain string.
 * An element is a target only if it is unique, visible and not ignored by the privacy module.
 */
import { ATTR_ID, ATTR_IGNORE, ATTR_PRIVATE, ATTR_REDACT, effectivePrivacy } from "../privacy/privacy.js";
import type { SemanticRegistry } from "../semantic/types.js";

export interface TargetHandle {
  readonly id: string;
  readonly element: HTMLElement;
  /** The element's current viewport rectangle. */
  rect(): DOMRect;
  /** Scrolls the element into view, only when it is (partly) off-screen. */
  reveal(): void;
}

export interface Targets {
  /** The element for a registered id, or `null` when it is unregistered, absent, duplicated, hidden or ignored. Never throws. */
  find(id: unknown): TargetHandle | null;
  /** Calls `callback` when markup or attributes that can change availability change. Returns the unsubscribe function. */
  observe(callback: () => void): () => void;
}

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
  return view.getComputedStyle(element).visibility !== "hidden" && view.getComputedStyle(element).visibility !== "collapse";
}

function isIgnored(element: HTMLElement, registryPrivacy: "public" | "private" | "redact"): boolean {
  return effectivePrivacy({
    ignoredByAncestorOrSelf: element.closest(`[${ATTR_IGNORE}]`) !== null,
    private: element.hasAttribute(ATTR_PRIVATE),
    redact: element.hasAttribute(ATTR_REDACT),
    tagName: element.tagName,
    inputType: element.getAttribute("type"),
    autocomplete: element.getAttribute("autocomplete"),
    registryPrivacy,
  }) === "ignore";
}

export function createTargets(root: HTMLElement, registry: SemanticRegistry): Targets {
  const find = (id: unknown): TargetHandle | null => {
    try {
      const def = registry.get(id);
      if (def === undefined) return null;
      const matches: HTMLElement[] = [];
      for (const candidate of Array.from(root.querySelectorAll<HTMLElement>(`[${ATTR_ID}]`))) {
        if (candidate.getAttribute(ATTR_ID) === def.id) matches.push(candidate);
      }
      if (matches.length !== 1) return null; // absent, or duplicated: never highlight "one of them"
      const element = matches[0]!;
      if (isIgnored(element, def.privacy) || !isVisible(element)) return null;
      return Object.freeze({
        id: def.id,
        element,
        rect: () => element.getBoundingClientRect(),
        reveal: () => {
          const view = element.ownerDocument.defaultView;
          const rect = element.getBoundingClientRect();
          const offscreen = view !== null && (rect.top < 0 || rect.left < 0 || rect.bottom > view.innerHeight || rect.right > view.innerWidth);
          if (offscreen && typeof element.scrollIntoView === "function") element.scrollIntoView({ block: "center", inline: "nearest" });
        },
      });
    } catch { return null; }
  };
  const observe = (callback: () => void): (() => void) => {
    const view = root.ownerDocument.defaultView;
    if (view === null) return () => undefined;
    const observer = new view.MutationObserver(() => { try { callback(); } catch { /* a subscriber's failure is its own */ } });
    observer.observe(root, {
      childList: true, subtree: true, attributes: true,
      attributeFilter: [ATTR_ID, ATTR_IGNORE, ATTR_PRIVATE, ATTR_REDACT, "hidden", "aria-hidden", "style", "class", "type", "open", "inert", "autocomplete"],
    });
    return () => observer.disconnect();
  };
  return Object.freeze({ find, observe });
}
