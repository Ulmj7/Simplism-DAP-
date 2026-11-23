import { h } from "../dom.js";
import { button } from "./pieces.js";

/**
 * Shared loading, empty and error states of the admin pages (Studio completion S9). Loading and empty are polite status regions; an error is an alert (announced at once) with an optional Retry
 * button, so a page never ends in silence. Each returns a fresh element: pages replace the previous state with the next one.
 */
export const loadingState = (text = "Loading…"): HTMLElement => h("p", { role: "status", "aria-live": "polite", class: "status state-loading" }, text);

export function emptyState(title: string, text: string, action?: HTMLElement): HTMLElement {
  return h("div", { class: "state-empty", role: "status", "aria-live": "polite" }, h("strong", {}, title), h("p", { class: "hint" }, text), ...(action ? [action] : []));
}

/** `retry` makes the failure recoverable in place; without it the message stands alone. */
export function errorState(text: string, retry?: () => void, label = "Try again"): HTMLElement {
  const element = h("div", { class: "state-error error", role: "alert" }, h("p", {}, text));
  if (retry) {
    const again = button(label);
    again.addEventListener("click", () => { again.disabled = true; retry(); });
    element.append(again);
  }
  return element;
}
