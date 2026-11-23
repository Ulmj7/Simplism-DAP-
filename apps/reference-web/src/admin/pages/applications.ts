import { copy } from "../../copy.js";
import { h } from "../../dom.js";
import { button, card, statusMessage } from "../../ui/pieces.js";
import { ENVIRONMENTS } from "../applications.js";
import type { ApplicationInput, ApplicationList, ApplicationView } from "../applications.js";
import type { AdminResult } from "../client.js";
import { newEditSession } from "../session.js";
import { adminPage, readError, writeError } from "./shared.js";
import type { AdminPageOptions } from "./shared.js";

const c = copy.admin;
const p = c.application.page;

/** The Application Manager: enroll, edit, enable/disable and pick the application Studio authors for. The host validates every field. */
export function applicationsPage({ client, signal, navigate }: AdminPageOptions) {
  const page = adminPage(c.applications);
  const notice = statusMessage();
  page.append(h("p", { class: "page-intro" }, p.intro), notice);
  notice.textContent = c.loading;
  let list: ApplicationList | undefined;
  let editing: ApplicationView | undefined;
  let busy = false;

  const table = h("div");
  const formCard = card();
  page.append(card(table), formCard);

  async function load() {
    const loaded = await client.applications();
    if (signal.aborted) return;
    if (loaded.kind !== "ok") { notice.textContent = loaded.kind === "denied" ? c.denied : c.application.unavailable; return; }
    list = loaded.value;
    // Only the initial "Loading…" goes away: a result message from the write that triggered this reload stays.
    if (notice.textContent === c.loading) notice.textContent = "";
    renderList(); renderForm();
  }

  function renderList() {
    if (!list) return;
    const { applications, registries } = list;
    if (applications.length === 0) { table.replaceChildren(h("p", { class: "status" }, p.empty)); return; }
    const columns = [p.name, p.origin, p.allowed, p.environment, p.registry, p.enabled, c.actions];
    const body = h("tbody", { role: "rowgroup" });
    for (const application of applications) {
      const controls = h("div", { class: "admin-actions" });
      const action = (label: string, run: () => void, disabled = false) => {
        const control = button(label);
        control.setAttribute("aria-label", `${label}: ${application.name}`);
        control.disabled = disabled || busy;
        control.addEventListener("click", () => { if (!busy && !signal.aborted && !control.disabled) run(); });
        controls.append(control);
      };
      action(p.edit, () => { editing = application; notice.textContent = ""; renderForm(); form()?.querySelector<HTMLElement>("input")?.focus(); });
      action(application.enabled ? p.disable : p.enable, () => { void setEnabled(application); });
      action(p.use, () => { newEditSession(application.id); navigate("editor"); }, !application.enabled);
      const registry = registries.find(choice => choice.id === application.registryId)?.label ?? application.registryId;
      const cell = (index: number, content: string | Node) => h("td", { role: "cell", "data-label": columns[index]! }, content);
      body.append(h("tr", { role: "row" }, cell(0, application.name), cell(1, application.origin),
        cell(2, h("span", { class: "admin-lines" }, application.allowedOrigins.join("\n"))), cell(3, application.environment), cell(4, registry),
        cell(5, h("span", { class: "admin-status" }, application.enabled ? p.enabledLabel : p.disabledLabel)), cell(6, controls)));
    }
    table.replaceChildren(h("table", { class: "admin-table", role: "table", "aria-label": c.applications },
      h("thead", { role: "rowgroup" }, h("tr", { role: "row" }, ...columns.map(title => h("th", { scope: "col", role: "columnheader" }, title)))), body));
  }

  const form = () => formCard.querySelector("form");
  function renderForm() {
    if (!list) return;
    const name = h("input", { id: "application-name", type: "text", maxlength: "80", autocomplete: "off" }) as HTMLInputElement;
    const origin = h("input", { id: "application-origin", type: "text", maxlength: "200", autocomplete: "off", spellcheck: "false" }) as HTMLInputElement;
    const allowed = h("textarea", { id: "application-allowed", rows: "3", spellcheck: "false", "aria-describedby": "application-allowed-help" }) as HTMLTextAreaElement;
    const environment = h("select", { id: "application-environment" }, ...ENVIRONMENTS.map(value => h("option", { value }, value))) as HTMLSelectElement;
    const registry = h("select", { id: "application-registry" }, h("option", { value: "" }, p.choose),
      ...list.registries.map(choice => h("option", { value: choice.id }, choice.label))) as HTMLSelectElement;
    if (editing) {
      name.value = editing.name; origin.value = editing.origin; allowed.value = editing.allowedOrigins.join("\n");
      environment.value = editing.environment; registry.value = editing.registryId;
    }
    const issues = h("ul", { class: "error", id: "application-issues", role: "alert", hidden: true });
    const submit = button(editing ? p.saveChanges : p.create, true);
    submit.type = "submit";
    submit.setAttribute("aria-describedby", "application-issues"); // a rejected enrollment is announced (role alert) and tied to the button that was pressed
    const cancel = button(p.cancel);
    cancel.hidden = editing === undefined;
    cancel.addEventListener("click", () => { editing = undefined; renderForm(); });
    const field = (control: HTMLElement, label: string, ...extra: HTMLElement[]) =>
      h("div", { class: "field" }, h("label", { for: control.id }, label), control, ...extra);
    const element = h("form", { novalidate: "" },
      h("h2", {}, editing ? p.editTitle : p.createTitle),
      field(name, p.name), field(origin, p.origin), field(allowed, p.allowed, h("p", { id: "application-allowed-help", class: "hint" }, p.allowedHelp)),
      field(environment, p.environment), field(registry, p.registry), issues, h("div", { class: "admin-actions" }, submit, cancel));
    element.addEventListener("submit", event => {
      event.preventDefault();
      if (busy || signal.aborted) return;
      // Exactly the five configuration fields; the host is the one validator.
      const input: ApplicationInput = {
        name: name.value.trim(), origin: origin.value.trim(),
        allowedOrigins: allowed.value.split(/\r?\n/u).map(line => line.trim()).filter(line => line !== ""),
        environment: environment.value === "test" ? "test" : "development", registryId: registry.value,
      };
      void save(input, issues);
    });
    formCard.replaceChildren(element);
  }

  function show(issues: HTMLElement, lines: readonly string[]) {
    issues.replaceChildren(...lines.map(line => h("li", {}, line)));
    issues.hidden = lines.length === 0;
  }
  async function save(input: ApplicationInput, issues: HTMLElement) {
    busy = true; show(issues, []); notice.textContent = c.saving; renderList();
    const target = editing;
    const result: AdminResult<ApplicationView> = target ? await client.updateApplication(target.id, input) : await client.createApplication(input);
    busy = false;
    if (signal.aborted) return;
    if (result.kind === "ok") {
      editing = undefined; notice.textContent = p.saved;
      await load();
      return;
    }
    notice.textContent = "";
    // Server issues are plain text, never markup: each goes through textContent.
    if (result.kind === "invalid") show(issues, [p.invalidTitle, ...result.issues]); else show(issues, [result.kind === "denied" ? c.denied : writeError(result)]);
    renderList();
  }
  async function setEnabled(application: ApplicationView) {
    busy = true; notice.textContent = c.saving; renderList();
    const result = await client.setApplicationEnabled(application.id, !application.enabled);
    busy = false;
    if (signal.aborted) return;
    if (result.kind !== "ok") { notice.textContent = result.kind === "denied" ? readError(result) : writeError(result); renderList(); return; }
    notice.textContent = p.statusChanged;
    await load();
  }

  void load();
  return page;
}
