import { h } from "../../dom.js";
import { button, card, statusMessage } from "../../ui/pieces.js";
import type { ApplicationView } from "../applications.js";
import type { AdminClient } from "../client.js";
import type { TargetView } from "../targets.js";
import { confirmAction, readError, writeError } from "./shared.js";

export function registrySection(client: AdminClient, signal: AbortSignal) {
  const title = h("h2", { tabindex: "-1" }, "Registry and targets");
  const status = statusMessage();
  const alert = h("p", { role: "alert", class: "error" });
  const contents = h("div");
  const element = card(title, status, alert, contents);
  element.hidden = true;
  let selected: ApplicationView | undefined;
  let generation = 0;
  let writing = false;

  async function change(target: TargetView, next: TargetView["status"], app: ApplicationView) {
    if (writing || signal.aborted) return;
    writing = true;
    for (const control of contents.querySelectorAll("button")) control.disabled = true;
    alert.textContent = "";
    const result = await client.setTargetStatus(app.id, target.id, next);
    writing = false;
    if (signal.aborted || selected?.id !== app.id) return;
    if (result.kind !== "ok") alert.textContent = writeError(result);
    await load(app, false);
  }

  function targetRow(target: TargetView, app: ApplicationView) {
    const disabling = target.status === "active";
    const action = button(disabling ? "Disable" : "Enable");
    action.disabled = writing || (!disabling && !app.enabled);
    action.setAttribute("aria-label", (disabling ? "Disable " : "Enable ") + target.id);
    action.addEventListener("click", () => {
      if (action.disabled || selected?.id !== app.id) return;
      if (disabling && (target.references.drafts > 0 || target.references.published > 0)) {
        confirmAction(action, element, "Disable target?",
          `${target.label} is referenced by ${target.references.drafts} drafts and ${target.references.published} published walkthroughs.`,
          "Disable target", () => { void change(target, "disabled", app); });
      } else void change(target, disabling ? "disabled" : "active", app);
    });
    return h("li", { class: "studio-candidate" }, h("strong", {}, target.label), h("p", {}, target.id),
      h("p", {}, `${target.role} · ${target.route} · ${target.operations.join(", ")}`),
      h("p", {}, `${target.status === "active" ? "Active" : "Disabled"} · References: ${target.references.drafts} drafts, ${target.references.published} published`), action);
  }

  async function load(app: ApplicationView, focus: boolean) {
    const attempt = ++generation;
    selected = app;
    element.hidden = false;
    title.textContent = `Registry and targets for ${app.name}`;
    if (focus) { alert.textContent = ""; title.focus(); }
    contents.replaceChildren();
    status.textContent = "Loading registry…";
    if (app.source === "built-in") {
      const result = await client.applicationRegistry(app.id);
      if (signal.aborted || attempt !== generation) return;
      status.textContent = "Built-in registry · Read-only";
      if (result.kind !== "ok") { alert.textContent = readError(result); return; }
      contents.append(h("ul", { class: "studio-candidates" }, ...result.value.elements.map(target =>
        h("li", { class: "studio-candidate" }, h("strong", {}, target.label), h("p", {}, target.id),
          h("p", {}, `${target.role} · ${target.route} · ${target.operations.join(", ")}`)))));
      return;
    }
    const result = await client.targets(app.id);
    if (signal.aborted || attempt !== generation) return;
    status.textContent = "Studio-managed registry";
    if (result.kind !== "ok") { alert.textContent = result.kind === "application" ? writeError(result) : readError(result); return; }
    const { routes, targets, limits } = result.value;
    contents.append(h("h3", {}, `Routes (${routes.length}/${limits.maxRoutes})`),
      routes.length === 0 ? h("p", {}, "No routes registered.") : h("ul", {}, ...routes.map(route => h("li", {}, `${route.route} · ${route.page}`))),
      h("h3", {}, `Targets (${targets.length}/${limits.maxTargets})`),
      targets.length === 0 ? h("p", {}, "No targets registered.") : h("ul", { class: "studio-candidates" }, ...targets.map(target => targetRow(target, app))));
  }

  return {
    element,
    select: (app: ApplicationView) => { void load(app, true); },
    refresh(applications: readonly ApplicationView[]) {
      const app = applications.find(item => item.id === selected?.id);
      if (app) void load(app, false);
    },
  };
}
