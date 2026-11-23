import type { RunStatus } from "../../embed/protocol.js";
import type { SemanticRegistry, WalkthroughDef } from "@dap/walkthrough";
import { copy } from "../../copy.js";
import { h } from "../../dom.js";
import type { NavigationGuard } from "../../router.js";
import { breadcrumb } from "../../ui/breadcrumb.js";
import type { Crumb } from "../../ui/breadcrumb.js";
import { button } from "../../ui/pieces.js";
import type { AdminClient, AdminResult } from "../client.js";

export interface AdminPageOptions {
  client: AdminClient;
  registry: SemanticRegistry;
  signal: AbortSignal;
  navigate(route: "walkthroughs" | "applications" | "editor" | "targets"): void;
  /** The editor's dirty guard on in-app navigation (see router.ts). */
  setNavigationGuard?(guard: NavigationGuard | undefined): void;
  preview(definition: WalkthroughDef, onResult?: (status: RunStatus) => void): void;
  refresh(focus?: boolean): void;
}
const c = copy.admin;
/** An admin page: optional breadcrumbs above the h1 (the h1 receives focus on a route change). */
export const adminPage = (title: string, crumbs?: readonly Crumb[]) => h("section", { class: "admin-page", "data-ai-ignore": true }, ...(crumbs ? [breadcrumb(crumbs)] : []), h("h1", { tabindex: "-1" }, title));
export const readError = (result: AdminResult<unknown>) => result.kind === "denied" ? c.denied : c.readFailed;
export const writeError = (result: AdminResult<unknown>) => result.kind === "oversize" ? c.oversize : result.kind === "published" ? c.readOnly
  : result.kind === "application" ? c.application.failures[result.code] : result.kind === "limit" ? c.application.limit : result.kind === "conflict" ? c.conflict : c.writeFailed;
export const backLink = () => h("a", { class: "button", href: "#/walkthroughs" }, c.listBack);

export function confirmAction(trigger: HTMLElement, page: HTMLElement, title: string, message: string, action: string, submit: () => void, cancelled?: () => void) {
  if (page.querySelector("dialog[open]")) return;
  const dialog = h("dialog", { class: "dap-result", "aria-labelledby": "dap-publish-title", "aria-describedby": "dap-publish-message", "aria-modal": "true", "data-ai-ignore": true }) as HTMLDialogElement;
  const cancel = button(c.cancel);
  const accept = button(action, true);
  const close = () => {
    if (!dialog.isConnected) return false;
    if (typeof dialog.close === "function") dialog.close();
    dialog.remove();
    trigger.focus();
    return true;
  };
  const dismiss = () => { if (close()) cancelled?.(); };
  cancel.addEventListener("click", dismiss);
  accept.addEventListener("click", () => { if (close()) submit(); });
  dialog.addEventListener("cancel", event => { event.preventDefault(); dismiss(); });
  dialog.addEventListener("keydown", event => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); dismiss(); }
    if (event.key === "Tab" && dialog.ownerDocument.activeElement === (event.shiftKey ? cancel : accept)) {
      event.preventDefault(); (event.shiftKey ? accept : cancel).focus();
    }
  });
  dialog.append(h("h2", { id: "dap-publish-title" }, title), h("p", { id: "dap-publish-message" }, message), h("div", { class: "result-actions" }, cancel, accept));
  page.append(dialog);
  if (typeof dialog.showModal === "function") dialog.showModal(); else dialog.setAttribute("open", "");
  cancel.focus();
}
