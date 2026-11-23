import { copy } from "../../copy.js";
import { h } from "../../dom.js";
import { button, card, statusMessage } from "../../ui/pieces.js";
import { emptyState, errorState, loadingState } from "../../ui/states.js";
import { ENVIRONMENTS } from "../applications.js";
import type { ApplicationInput, ApplicationList, ApplicationOverview, ApplicationRouting, ApplicationView } from "../applications.js";
import type { AdminResult } from "../client.js";
import { focusApplication, newEditSession } from "../session.js";
import { adminPage, confirmAction, readError, writeError } from "./shared.js";
import type { AdminPageOptions } from "./shared.js";

const c = copy.admin;
const p = c.application.page;
const registryText = (source: ApplicationView["source"]) => (source === "built-in" ? "Built-in" : "Studio-managed");

/** The CSP an application that embeds the delivery script needs (the origin is the DAP origin that serves `dap-embed.js`, `dap-embed.css` and the runtime API). */
export const cspExample = (origin: string) =>
  `Content-Security-Policy: default-src 'none'; script-src 'self' ${origin}; style-src 'self' ${origin}; connect-src ${origin}; img-src 'self'; base-uri 'none'; form-action 'none'`;
export const embedSnippet = (origin: string, key: string) => `<script src="${origin}/dap-embed.js" data-dap-key="${key}"></script>`;

/**
 * The Application Manager (S2): every application with its status, environment, routing, registry and counts; an overview with the health breakdown, the runtime delivery (key, copyable embed line,
 * rotation) and the actions that lead elsewhere (Open Studio, Manage Targets, Manage Workflows); enrollment and editing, with routing locked once routes exist. The host validates every field.
 */
export function applicationsPage({ client, signal, navigate }: AdminPageOptions) {
  const page = adminPage(c.applications);
  const notice = statusMessage();
  const alert = h("div", { role: "alert", class: "error" });
  page.append(h("p", { class: "page-intro" }, p.intro), notice, alert);
  notice.textContent = c.loading;
  let list: ApplicationList | undefined;
  let editing: ApplicationView | undefined;
  let overviewOf: string | undefined;
  let busy = false;

  const table = h("div");
  const overviewCard = card();
  overviewCard.hidden = true;
  const formCard = card();
  page.append(card(table), overviewCard, formCard);
  const say = (text: string) => { alert.textContent = ""; notice.textContent = text; };
  const warn = (text: string) => { notice.textContent = ""; alert.textContent = text; };

  async function load() {
    const loaded = await client.applications();
    if (signal.aborted) return;
    if (loaded.kind !== "ok") {
      notice.textContent = "";
      table.replaceChildren(errorState(loaded.kind === "denied" ? c.denied : c.application.unavailable, loaded.kind === "denied" ? undefined : () => { void load(); }));
      return;
    }
    list = loaded.value;
    // Only the initial "Loading…" goes away: a result message from the write that triggered this reload stays.
    if (notice.textContent === c.loading) notice.textContent = "";
    renderList(); renderForm();
    if (overviewOf !== undefined) {
      const open = list.applications.find(application => application.id === overviewOf);
      if (open) void showOverview(open, false); else { overviewCard.hidden = true; overviewOf = undefined; }
    }
  }

  function renderList() {
    if (!list) return;
    const { applications } = list;
    if (applications.length === 0) { table.replaceChildren(emptyState("No applications", p.empty)); return; }
    const columns = [p.name, p.environment, "Routing", p.registry, "Targets", "Drafts", "Published", c.actions];
    const body = h("tbody", { role: "rowgroup" });
    for (const application of applications) {
      const controls = h("div", { class: "admin-actions" });
      const action = (label: string, run: (trigger: HTMLButtonElement) => void, disabled = false) => {
        const control = button(label);
        control.setAttribute("aria-label", `${label}: ${application.name}`);
        control.disabled = disabled || busy;
        control.addEventListener("click", () => { if (!busy && !signal.aborted && !control.disabled) run(control); });
        controls.append(control);
      };
      action("Overview", () => { void showOverview(application, true); });
      action(p.edit, () => { editing = application; notice.textContent = ""; renderForm(); form()?.querySelector<HTMLElement>("input")?.focus(); });
      action(application.enabled ? p.disable : p.enable, () => { void setEnabled(application); });
      action("Open Studio", () => { newEditSession(application.id); navigate("editor"); }, !application.enabled);
      const cell = (index: number, content: string | Node) => h("td", { role: "cell", "data-label": columns[index]! }, content);
      const name = h("span", {}, application.name, " ", h("span", { class: "badge", "data-state": application.enabled ? "enabled" : "disabled" }, application.enabled ? p.enabledLabel : p.disabledLabel));
      body.append(h("tr", { role: "row" }, cell(0, name), cell(1, application.environment), cell(2, application.routing), cell(3, registryText(application.source)),
        cell(4, String(application.counts.targets)), cell(5, String(application.counts.drafts)), cell(6, String(application.counts.published)), cell(7, controls)));
    }
    table.replaceChildren(h("table", { class: "admin-table", role: "table", "aria-label": c.applications },
      h("thead", { role: "rowgroup" }, h("tr", { role: "row" }, ...columns.map(title => h("th", { scope: "col", role: "columnheader" }, title)))), body));
  }

  // ---- overview ----------------------------------------------------------------------------------------------------
  async function showOverview(application: ApplicationView, focus: boolean) {
    overviewOf = application.id;
    overviewCard.hidden = false;
    if (focus) overviewCard.replaceChildren(loadingState("Loading overview…"));
    const result = await client.overview(application.id);
    if (signal.aborted || overviewOf !== application.id) return;
    if (result.kind !== "ok") { overviewCard.replaceChildren(errorState(readError(result), () => { void showOverview(application, true); })); return; }
    renderOverview(result.value, focus);
  }
  function renderOverview({ application, targets, workflows }: ApplicationOverview, focus: boolean) {
    const title = h("h2", { tabindex: "-1" }, `${application.name} · overview`);
    const fact = (term: string, value: string | Node) => [h("dt", {}, term), h("dd", {}, value)];
    const origin = (document.defaultView ?? window).location.origin;
    const runtime = h("div", { class: "overview-runtime" });
    const delivery = application.source === "built-in" ? "Not available for a built-in application."
      : !application.runtimeAccess ? "Off. Switch it on in Edit to deliver published workflows to the application's own pages." : "On";
    runtime.append(h("p", {}, delivery));
    if (application.runtimeAccess && application.runtimeKey !== null) {
      const key = application.runtimeKey;
      const snippet = embedSnippet(origin, key);
      const copyButton = button("Copy embed line");
      copyButton.setAttribute("aria-label", `Copy embed line: ${application.name}`);
      copyButton.addEventListener("click", () => {
        const clipboard = (document.defaultView ?? window).navigator.clipboard;
        void (clipboard ? clipboard.writeText(snippet).then(() => "Embed line copied.", () => "Select the embed line and copy it.") : Promise.resolve("Select the embed line and copy it.")).then(text => { if (!signal.aborted) say(text); });
      });
      const rotate = button("Rotate key");
      rotate.setAttribute("aria-label", `Rotate runtime key: ${application.name}`);
      rotate.addEventListener("click", () => {
        confirmAction(rotate, page, "Rotate the runtime key?", "The current key stops working at once. Every page that embeds it must be updated with the new embed line.", "Rotate key", () => { void rotateKey(application); });
      });
      runtime.append(h("p", {}, "Runtime key: ", h("code", {}, key)),
        h("p", { class: "hint" }, "The key is a public identifier. Delivery also requires the page's origin to be one of the allowed origins of this application."),
        h("code", { class: "snippet", "aria-label": "Embed line" }, snippet), h("div", { class: "admin-actions" }, copyButton, rotate),
        h("details", {}, h("summary", {}, "Content-Security-Policy example"),
          h("p", { class: "hint" }, `Pages with a strict policy must allow the origin that serves the embed and the runtime API: ${origin}.`), h("code", { class: "snippet" }, cspExample(origin))));
    } else if (application.runtimeAccess) {
      runtime.append(h("p", { class: "hint" }, "The key is not available yet. Rotate it to create one."));
    }
    const go = (label: string, run: () => void, disabled = false) => {
      const control = button(label);
      control.setAttribute("aria-label", `${label}: ${application.name}`);
      control.disabled = disabled;
      control.addEventListener("click", () => { if (!signal.aborted && !control.disabled) run(); });
      return control;
    };
    overviewCard.replaceChildren(title,
      h("dl", { class: "overview-grid" },
        ...fact("Application", application.name), ...fact("Status", h("span", { class: "badge", "data-state": application.enabled ? "enabled" : "disabled" }, application.enabled ? p.enabledLabel : p.disabledLabel)),
        ...fact("Environment", application.environment), ...fact("Origin", application.origin), ...fact("Allowed origins", h("span", { class: "admin-lines" }, application.allowedOrigins.join("\n"))), ...fact("Routing", application.routing), ...fact("Registry", registryText(application.source)),
        ...fact("Targets", application.source === "built-in" ? "Built-in registry" : `${targets.total} (${targets.healthy} healthy, ${targets.unverified} unverified, ${targets.broken} broken; ${targets.active} active, ${targets.disabled} disabled)`),
        ...fact("Draft workflows", String(workflows.draft)), ...fact("Published workflows", String(workflows.published)), ...fact("Runtime delivery", runtime)),
      h("div", { class: "admin-actions" },
        go("Open Studio", () => { newEditSession(application.id); navigate("editor"); }, !application.enabled),
        go("Manage Targets", () => { focusApplication(application.id); navigate("targets"); }),
        go("Manage Workflows", () => { focusApplication(application.id); navigate("walkthroughs"); })));
    if (focus) title.focus();
  }
  async function rotateKey(application: ApplicationView) {
    if (busy) return;
    busy = true; say(c.saving);
    const result = await client.rotateRuntimeKey(application.id);
    busy = false;
    if (signal.aborted) return;
    if (result.kind !== "ok") { warn(result.kind === "denied" ? c.denied : writeError(result)); return; }
    say("Runtime key rotated. Update the embed line of every page that used the old key.");
    await load();
  }

  // ---- enrollment and editing -----------------------------------------------------------------------------------------
  const form = () => formCard.querySelector("form");
  function renderForm() {
    if (!list) return;
    const name = h("input", { id: "application-name", type: "text", maxlength: "80", autocomplete: "off" }) as HTMLInputElement;
    const origin = h("input", { id: "application-origin", type: "text", maxlength: "200", autocomplete: "off", spellcheck: "false" }) as HTMLInputElement;
    const allowed = h("textarea", { id: "application-allowed", rows: "3", spellcheck: "false", "aria-describedby": "application-allowed-help" }) as HTMLTextAreaElement;
    const environment = h("select", { id: "application-environment" }, ...ENVIRONMENTS.map(value => h("option", { value }, value))) as HTMLSelectElement;
    const registry = h("select", { id: "application-registry" }, h("option", { value: "" }, p.choose),
      ...list.registries.filter(choice => !editing || choice.source === editing.source).map(choice => h("option", { value: choice.id }, choice.label))) as HTMLSelectElement;
    const routing = h("select", { id: "application-routing", "aria-describedby": "application-routing-help" }, h("option", { value: "hash" }, "Hash (/#/orders)"), h("option", { value: "history" }, "History (/orders)")) as HTMLSelectElement;
    const routingHelp = h("p", { id: "application-routing-help", class: "hint" }, "How the application addresses its pages. Static paths only: /users/123 is just a page.");
    const access = h("input", { id: "application-runtime", type: "checkbox", "aria-describedby": "application-runtime-help" }) as HTMLInputElement;
    const accessHelp = h("p", { id: "application-runtime-help", class: "hint" }, "Deliver this application's published workflows to its own pages with the runtime key. Do not rely on it for secrets: anyone who can load an allowed origin can read the guides.");
    if (editing) {
      name.value = editing.name; origin.value = editing.origin; allowed.value = editing.allowedOrigins.join("\n");
      environment.value = editing.environment; registry.value = editing.registryId; routing.value = editing.routing; access.checked = editing.runtimeAccess;
    }
    // Routing is fixed once routes exist (the host answers ROUTING_LOCKED); built-in registries are hash-routed with no runtime delivery.
    const lockRules = () => {
      const managed = list?.registries.find(choice => choice.id === registry.value)?.source === "studio-managed" || (editing?.source === "studio-managed" && registry.value === "");
      const locked = editing !== undefined && editing.counts.targets > 0;
      routing.disabled = !managed || locked;
      if (!managed) routing.value = "hash";
      access.disabled = !managed;
      if (!managed) access.checked = false;
      routingHelp.textContent = locked ? "Routing cannot change once this application has registered routes." : !managed ? "A built-in registry is hash-routed." : "How the application addresses its pages. Static paths only: /users/123 is just a page.";
    };
    registry.addEventListener("change", lockRules);
    lockRules();
    const issues = h("ul", { class: "error", id: "application-issues", role: "alert", hidden: true });
    const submit = button(editing ? p.saveChanges : p.create, true);
    submit.type = "submit";
    submit.setAttribute("aria-describedby", "application-issues"); // a rejected enrollment is announced (role alert) and tied to the button that was pressed
    const cancel = button(p.cancel);
    cancel.hidden = editing === undefined;
    cancel.addEventListener("click", () => { editing = undefined; renderForm(); });
    const field = (control: HTMLElement, label: string, ...extra: HTMLElement[]) => h("div", { class: "field" }, h("label", { for: control.id }, label), control, ...extra);
    const element = h("form", { novalidate: "" },
      h("h2", {}, editing ? p.editTitle : p.createTitle),
      field(name, p.name), field(origin, p.origin), field(allowed, p.allowed, h("p", { id: "application-allowed-help", class: "hint" }, p.allowedHelp)),
      field(environment, p.environment), field(registry, p.registry), field(routing, "Routing", routingHelp),
      h("div", { class: "field" }, h("label", { class: "studio-check", for: access.id }, access, " Runtime access"), accessHelp), issues, h("div", { class: "admin-actions" }, submit, cancel));
    element.addEventListener("submit", event => {
      event.preventDefault();
      if (busy || signal.aborted) return;
      const input: ApplicationInput = {
        name: name.value.trim(), origin: origin.value.trim(),
        allowedOrigins: allowed.value.split(/\r?\n/u).map(line => line.trim()).filter(line => line !== ""),
        environment: environment.value === "test" ? "test" : "development", registryId: registry.value,
        routing: (routing.value === "history" ? "history" : "hash") satisfies ApplicationRouting, runtimeAccess: access.checked,
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
