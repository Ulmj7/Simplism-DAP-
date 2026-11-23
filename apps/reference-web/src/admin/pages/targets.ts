import { copy } from "../../copy.js";
import { h } from "../../dom.js";
import { breadcrumb } from "../../ui/breadcrumb.js";
import { button, card, statusMessage } from "../../ui/pieces.js";
import { emptyState, errorState, loadingState } from "../../ui/states.js";
import type { ApplicationView } from "../applications.js";
import { browserWorkspace } from "../browser-workspace.js";
import type { BrowserWorkspace } from "../browser-workspace.js";
import { getFocusedApplication, focusApplication } from "../session.js";
import type { TargetDetail, TargetHealth, TargetList, TargetView } from "../targets.js";
import { adminPage, confirmAction, readError, writeError } from "./shared.js";
import type { AdminPageOptions } from "./shared.js";

const c = copy.admin;
const healthText: Readonly<Record<TargetHealth, string>> = Object.freeze({ unverified: "Unverified", healthy: "Healthy", broken: "Broken" });
const ALL = "all";

/** Targets of ONE application (S3/S9): table with filters, a detail panel that keeps the durable DAP identity apart from the live browser evidence, usage, change history, page checks and repair. */
export function targetsPage({ client, signal, navigate }: AdminPageOptions) {
  const page = adminPage(c.targets);
  const crumbs = h("div");
  page.prepend(crumbs);
  const notice = statusMessage();
  const alert = h("div", { role: "alert", class: "error" });
  const picker = h("select", { id: "targets-application" }) as HTMLSelectElement;
  const status = h("select", { id: "targets-filter-status" }, ...[[ALL, "All statuses"], ["active", "Active"], ["disabled", "Disabled"]].map(([value, label]) => h("option", { value: value! }, label!))) as HTMLSelectElement;
  const health = h("select", { id: "targets-filter-health" }, ...[[ALL, "All health"], ["unverified", "Unverified"], ["healthy", "Healthy"], ["broken", "Broken"]].map(([value, label]) => h("option", { value: value! }, label!))) as HTMLSelectElement;
  const route = h("select", { id: "targets-filter-route" }, h("option", { value: ALL }, "All routes")) as HTMLSelectElement;
  const field = (control: HTMLElement, label: string) => h("div", { class: "field" }, h("label", { for: control.id }, label), control);
  const filters = h("div", { class: "admin-filters", role: "group", "aria-label": "Filter targets" }, field(status, "Status"), field(health, "Health"), field(route, "Route"));
  const body = h("div");
  const listCard = card(h("h2", {}, "Targets"), filters, body);
  const detailHost = h("div");
  const detailCard = card(detailHost);
  detailCard.hidden = true;
  const live = h("div");
  page.append(notice, alert, card(field(picker, "Application")), listCard, detailCard, live);
  notice.textContent = c.loading;

  let apps: readonly ApplicationView[] = [];
  let selected: ApplicationView | undefined;
  let data: TargetList | undefined;
  let detailId: string | undefined;
  let workspace: BrowserWorkspace | undefined;
  let generation = 0;
  let writing = false;
  const say = (text: string) => { alert.textContent = ""; notice.textContent = text; };
  const warn = (text: string) => { notice.textContent = ""; alert.textContent = text; };

  function crumbsFor() {
    crumbs.replaceChildren(breadcrumb([{ label: c.applications, href: "#/applications" }, ...(selected ? [{ label: selected.name }] : []), { label: c.targets }]));
  }

  // ---- applications ---------------------------------------------------------------------------------------------------
  async function loadApplications() {
    body.replaceChildren(loadingState());
    const result = await client.applications();
    if (signal.aborted) return;
    if (result.kind !== "ok") { notice.textContent = ""; body.replaceChildren(errorState(result.kind === "denied" ? c.denied : c.application.unavailable, () => { void loadApplications(); })); return; }
    apps = result.value.applications;
    notice.textContent = "";
    picker.replaceChildren(h("option", { value: "" }, c.application.choose), ...apps.map(app => h("option", { value: app.id }, `${app.name}${app.enabled ? "" : c.application.disabledSuffix}${app.source === "built-in" ? " · built-in" : ""}`)));
    const wanted = getFocusedApplication();
    const initial = apps.find(app => app.id === wanted) ?? apps.find(app => app.source === "studio-managed" && app.enabled);
    if (initial) { picker.value = initial.id; await choose(initial); }
    else { crumbsFor(); body.replaceChildren(emptyState(apps.length === 0 ? "No applications" : "Choose an application", apps.length === 0 ? "Enroll an application in Applications first." : c.application.chooseFirst)); }
  }
  async function choose(app: ApplicationView | undefined) {
    selected = app; data = undefined; detailId = undefined; detailCard.hidden = true; detailHost.replaceChildren(); alert.textContent = "";
    for (const select of [status, health, route]) select.value = ALL;
    route.replaceChildren(h("option", { value: ALL }, "All routes"));
    crumbsFor();
    live.replaceChildren();
    workspace?.setApplication(app === undefined ? undefined : { id: app.id, name: app.name, enabled: app.enabled });
    if (!app) { body.replaceChildren(emptyState("Choose an application", c.application.chooseFirst)); return; }
    focusApplication(app.id);
    await loadTargets();
  }

  // ---- the table ------------------------------------------------------------------------------------------------------
  async function loadTargets(announce = false) {
    const app = selected;
    if (!app) return;
    const attempt = ++generation;
    body.replaceChildren(loadingState("Loading targets…"));
    if (app.source === "built-in") {
      const result = await client.applicationRegistry(app.id);
      if (signal.aborted || attempt !== generation) return;
      if (result.kind !== "ok") { body.replaceChildren(errorState(readError(result), () => { void loadTargets(); })); return; }
      filters.hidden = true;
      body.replaceChildren(h("p", { class: "hint" }, "Built-in registry · read-only. Its targets are part of the application and cannot be changed here."),
        result.value.elements.length === 0 ? emptyState("No targets", "This registry has no targets.")
          : h("ul", { class: "studio-candidates" }, ...result.value.elements.map(element => h("li", { class: "studio-candidate" }, h("strong", {}, element.label), h("p", {}, element.id), h("p", {}, `${element.role} · ${element.route} · ${element.operations.join(", ")}`)))));
      return;
    }
    const result = await client.targets(app.id);
    if (signal.aborted || attempt !== generation) return;
    if (result.kind !== "ok") { body.replaceChildren(errorState(result.kind === "application" ? writeError(result) : readError(result), () => { void loadTargets(); })); return; }
    data = result.value;
    filters.hidden = false;
    const wanted = route.value;
    route.replaceChildren(h("option", { value: ALL }, "All routes"), ...data.routes.map(item => h("option", { value: item.route }, item.route)));
    route.value = data.routes.some(item => item.route === wanted) ? wanted : ALL;
    renderTable();
    mountWorkspace(app);
    if (announce) say(`${data.targets.length} targets loaded.`);
    if (detailId && data.targets.some(item => item.id === detailId)) void showDetail(detailId, false);
  }

  function visible(): readonly TargetView[] {
    if (!data) return [];
    return data.targets.filter(item => (status.value === ALL || item.status === status.value) && (health.value === ALL || item.health === health.value) && (route.value === ALL || item.route === route.value));
  }
  function renderTable() {
    const app = selected;
    if (!data || !app) return;
    const { targets, limits } = data;
    const rows = visible();
    const summary = h("p", { role: "status", "aria-live": "polite", class: "hint" }, `Targets (${targets.length}/${limits.maxTargets}) · showing ${rows.length}`);
    if (targets.length === 0) { body.replaceChildren(summary, emptyState("No targets yet", "Connect Chrome below, inspect a page and register its controls.")); return; }
    if (rows.length === 0) { body.replaceChildren(summary, emptyState("No target matches", "Change the filters to see more targets.")); return; }
    const columns = ["Target ID", "Name", "Role", "Route", "Operations", "Privacy", "Status", "Health", "Used by"];
    const tbody = h("tbody", { role: "rowgroup" });
    for (const target of rows) {
      const open = button(target.id);
      open.setAttribute("aria-label", `Details: ${target.id}`);
      open.setAttribute("aria-pressed", String(detailId === target.id));
      open.addEventListener("click", () => { void showDetail(target.id, true); });
      const cell = (index: number, content: string | Node) => h("td", { role: "cell", "data-label": columns[index]! }, content);
      tbody.append(h("tr", { role: "row" }, cell(0, open), cell(1, target.label), cell(2, target.role), cell(3, target.route), cell(4, target.operations.join(", ")), cell(5, target.privacy),
        cell(6, h("span", { class: "badge", "data-state": target.status === "active" ? "enabled" : "disabled" }, target.status === "active" ? "Active" : "Disabled")),
        cell(7, h("span", { class: "badge", "data-health": target.health }, healthText[target.health])), cell(8, `${target.references.drafts} drafts, ${target.references.published} published`)));
    }
    body.replaceChildren(summary, h("table", { class: "admin-table", role: "table", "aria-label": "Targets" },
      h("thead", { role: "rowgroup" }, h("tr", { role: "row" }, ...columns.map(title => h("th", { scope: "col", role: "columnheader" }, title)))), tbody));
  }
  for (const select of [status, health, route]) select.addEventListener("change", () => { renderTable(); });

  // ---- the detail panel -------------------------------------------------------------------------------------------------
  async function showDetail(id: string, focus: boolean) {
    const app = selected;
    if (!app) return;
    detailId = id;
    detailCard.hidden = false;
    if (focus) detailHost.replaceChildren(loadingState("Loading target…"));
    const result = await client.targetDetail(app.id, id);
    if (signal.aborted || selected?.id !== app.id || detailId !== id) return;
    if (result.kind !== "ok") { detailHost.replaceChildren(errorState(readError(result), () => { void showDetail(id, true); })); return; }
    renderDetail(app, result.value, focus);
    renderTable();
  }
  const facts = (rows: readonly (readonly [string, string])[]) => h("dl", { class: "detail-grid" }, ...rows.flatMap(([term, value]) => [h("dt", {}, term), h("dd", {}, value)]));
  const when = (value: string | null) => (value === null ? "Never checked" : new Date(value).toLocaleString());
  function renderDetail(app: ApplicationView, target: TargetDetail, focus: boolean) {
    const title = h("h2", { tabindex: "-1" }, `Target ${target.id}`);
    const disabling = target.status === "active";
    const toggle = button(disabling ? "Disable" : "Enable");
    toggle.setAttribute("aria-label", `${disabling ? "Disable" : "Enable"} ${target.id}`);
    toggle.disabled = writing || (!disabling && !app.enabled);
    toggle.addEventListener("click", () => {
      if (toggle.disabled || selected?.id !== app.id) return;
      if (disabling && (target.references.drafts > 0 || target.references.published > 0)) {
        confirmAction(toggle, page, "Disable target?", `${target.label} is referenced by ${target.references.drafts} drafts and ${target.references.published} published workflows.`, "Disable target", () => { void changeStatus(app, target, "disabled"); });
      } else void changeStatus(app, target, disabling ? "disabled" : "active");
    });
    const repair = button("Repair…");
    repair.setAttribute("aria-label", `Repair: ${target.id}`);
    repair.disabled = !app.enabled || target.status !== "active" || workspace === undefined;
    repair.addEventListener("click", () => { startRepair(target); });
    const list = (items: readonly string[], empty: string) => (items.length === 0 ? h("p", { class: "hint" }, empty) : h("ul", {}, ...items.map(item => h("li", {}, item))));
    detailHost.replaceChildren(title,
      h("div", { class: "detail-columns" },
        h("section", { "aria-labelledby": "target-identity" }, h("h3", { id: "target-identity" }, "Durable DAP identity"),
          h("p", { class: "hint" }, "Workflows refer to this identity. It never changes."),
          facts([["Target ID", target.id], ["Application", app.name], ["Route", target.route], ["Page", target.page], ["Role", target.role], ["Operations", target.operations.join(", ")], ["Privacy", target.privacy],
            ["Status", target.status === "active" ? "Active" : "Disabled"], ["Revision", String(target.revision)], ["Label", target.label], ["Description", target.description]])),
        h("section", { "aria-labelledby": "target-evidence" }, h("h3", { id: "target-evidence" }, "Live browser evidence"),
          h("p", { class: "hint" }, "Evidence only: what the page carries today. A repair changes it, never the identity."),
          facts([["Marker", target.marker], ["Health", healthText[target.health]], ["Last checked", when(target.healthCheckedAt)]]))),
      h("div", { class: "detail-columns" },
        h("section", { "aria-labelledby": "target-usage" }, h("h3", { id: "target-usage" }, "Usage"),
          h("p", {}, `Draft workflows (${target.usage.drafts.length})`), list(target.usage.drafts.map(item => item.title), "No draft uses this target."),
          h("p", {}, `Published workflows (${target.usage.published.length})`), list(target.usage.published.map(item => `${item.title} · version ${item.version}`), "No published workflow uses this target.")),
        h("section", { "aria-labelledby": "target-history" }, h("h3", { id: "target-history" }, "Change history"),
          list(target.changes.map(item => `Revision ${item.revision} · ${when(item.changedAt)} · ${item.changedBy} · ${Object.entries(item.after).map(([key, value]) => `${key}: ${String(Array.isArray(value) ? value.join(", ") : value)}`).join("; ") || "no change"}`), "No repairs yet."))),
      h("div", { class: "admin-actions" }, toggle, repair));
    if (focus) title.focus();
  }
  async function changeStatus(app: ApplicationView, target: TargetView, next: TargetView["status"]) {
    if (writing || signal.aborted) return;
    writing = true; alert.textContent = "";
    for (const control of detailHost.querySelectorAll("button")) control.disabled = true;
    const result = await client.setTargetStatus(app.id, target.id, next);
    writing = false;
    if (signal.aborted || selected?.id !== app.id) return;
    if (result.kind !== "ok") warn(writeError(result)); else say(`Target ${target.id} is now ${next === "active" ? "active" : "disabled"}.`);
    await loadTargets();
  }

  // ---- browser: page checks and repair ----------------------------------------------------------------------------------------
  function mountWorkspace(app: ApplicationView) {
    if (workspace || !client.studio) return;
    const call = client.studio;
    workspace = browserWorkspace({
      call, signal, bindTarget: () => () => false, application: { id: app.id, name: app.name, enabled: app.enabled },
      onChecked: reply => {
        const broken = reply.results.filter(item => item.state === "broken").length;
        say(reply.results.length === 0 ? "No active target is registered for this page." : `Health updated for ${reply.results.length} targets: ${reply.results.length - broken} healthy, ${broken} broken.`);
        void loadTargets();
      },
      repair: undefined,
    });
    live.replaceChildren(workspace.element);
  }
  function startRepair(target: TargetView) {
    if (!workspace || !selected) return;
    workspace.setRepair({ target, onRepaired: repaired => { say(`Target ${repaired.id} repaired. Health: ${healthText[repaired.health]}.`); workspace?.setRepair(undefined); void loadTargets(); } });
    say(`Repair mode for ${target.id}: connect Chrome, open the page ${target.page}, inspect it and choose the replacement element.`);
    workspace.element.querySelector<HTMLElement>("h2")?.focus();
  }

  picker.addEventListener("change", () => { void choose(apps.find(app => app.id === picker.value)); });
  void loadApplications();
  void navigate;
  return page;
}
