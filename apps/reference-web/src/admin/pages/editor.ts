import { applicationRunResult, applicationRunStatus, runInApplicationWindow } from "../application-window.js";
import { createSemanticRegistry, MAX_DESCRIPTION as MAX_TEXT, MAX_LABEL as MAX_TITLE } from "@dap/walkthrough";
import type { SemanticRegistry, WaitKind } from "@dap/walkthrough";
import { copy } from "../../copy.js";
import { h } from "../../dom.js";
import { POSTCONDITION_NAMES } from "../../postconditions.js";
import { button, card, statusMessage } from "../../ui/pieces.js";
import type { ApplicationList, ApplicationView } from "../applications.js";
import type { AdminResult, GuideRecord } from "../client.js";
import { browserWorkspace } from "../browser-workspace.js";
import { definitionToDraft, emptyStep, MAX_EDITOR_STEPS, validateDraft } from "../draft.js";
import type { DraftProblem } from "../draft.js";
import { getEditSession, newEditSession, setEditSession, takeRequestedEdit } from "../session.js";
import type { EditSession } from "../session.js";
import { adminPage, backLink, confirmPublish, readError, writeError } from "./shared.js";
import type { AdminPageOptions } from "./shared.js";

const c = copy.admin;
/** What an application contributes to the editor: its targets, the checks it declares, and whether Preview can run it. */
export interface RegistryData { registry: SemanticRegistry; postconditions: readonly string[]; previewable: boolean; pages?: Readonly<Record<string, string>>; previewMode: "in-app" | "application-window" }
const EMPTY: RegistryData = { registry: createSemanticRegistry({ routes: [], elements: [] }), postconditions: [], previewable: false, previewMode: "in-app" };

export function editorPage(options: AdminPageOptions) {
  const { client, registry: referenceRegistry, signal } = options;
  const page = adminPage(c.editor);
  const notice = statusMessage();
  page.append(backLink(), notice);
  notice.textContent = c.loading;
  const requested = takeRequestedEdit();
  const current = getEditSession();
  // The legacy default: a draft that predates applications is validated against the reference registry, like the host does.
  const reference: RegistryData = { registry: referenceRegistry, postconditions: POSTCONDITION_NAMES, previewable: true, previewMode: "in-app" };
  async function registryFor(applicationId: string | undefined, legacy: boolean): Promise<RegistryData | AdminResult<never>> {
    if (applicationId === undefined) return legacy ? reference : EMPTY;
    const loaded = await client.applicationRegistry(applicationId);
    return loaded.kind === "ok" ? { registry: loaded.value.registry, postconditions: loaded.value.postconditionNames, previewable: loaded.value.previewable, previewMode: loaded.value.previewMode, pages: loaded.value.pages } : loaded;
  }
  const resumed = requested !== undefined && current?.id === requested && current.saving !== undefined;
  void Promise.all([client.list(), client.applications(), requested === undefined || resumed ? undefined : client.get(requested)]).then(async ([access, applications, loaded]) => {
    if (signal.aborted) return;
    if (access.kind !== "ok") { notice.textContent = readError(access); return; }
    if (applications.kind !== "ok") { notice.textContent = readError(applications) === c.denied ? c.denied : c.application.unavailable; return; }
    const render = async (session: EditSession) => {
      const data = await registryFor(session.applicationId, session.id !== undefined);
      if (signal.aborted) return;
      if (!("registry" in data)) { notice.textContent = data.kind === "application" ? c.application.failures[data.code] : c.application.registryFailed; return; }
      notice.textContent = ""; renderEditor(page, notice, session, options, applications.value, data);
    };
    if (requested === undefined) {
      const session = getEditSession() ?? newEditSession();
      if (session.id && access.value.authored.some(row => row.id === session.id && row.status === "published")) {
        notice.textContent = c.readOnly; return;
      }
      // A new draft starts on the only enabled application, so a single-application setup needs no extra click.
      const enabled = applications.value.applications.filter(application => application.enabled);
      if (session.id === undefined && session.applicationId === undefined && enabled.length === 1) session.applicationId = enabled[0]!.id;
      await render(session);
      return;
    }
    if (resumed && current) { await render(current); return; }
    setEditSession();
    if (loaded?.kind !== "ok") { notice.textContent = loaded ? readError(loaded) : c.readFailed; return; }
    if (loaded.value.status === "published") { notice.textContent = c.readOnly; return; }
    const owner = loaded.value.applicationId ?? undefined;
    const data = await registryFor(owner, true);
    if (signal.aborted) return;
    if (!("registry" in data)) { notice.textContent = data.kind === "application" ? c.application.failures[data.code] : c.application.registryFailed; return; }
    const draft = definitionToDraft(loaded.value.definition, data.registry);
    if (!draft) { notice.textContent = c.foreign; return; }
    const session: EditSession = { id: loaded.value.id, draft, selected: 0, dirty: false, ...(owner === undefined ? {} : { applicationId: owner, applicationLocked: true }) };
    setEditSession(session); notice.textContent = ""; renderEditor(page, notice, session, options, applications.value, data);
  });
  return page;
}

function renderEditor(page: HTMLElement, notice: HTMLElement, session: EditSession, options: AdminPageOptions, applications: ApplicationList, initial: RegistryData) {
  const { client, signal, preview, navigate, refresh } = options;
  const { draft } = session;
  // The registry belongs to the SELECTED application and is replaced when a new draft selects another one.
  let { registry, postconditions, previewable, previewMode, pages } = initial;
  const save = button(c.save, true);
  const showPreview = button(c.preview);
  let previewRunning = false;
  const publish = button(c.publish);
  const errors = h("ul", { id: "editor-problems", class: "error" });
  const publishHint = h("p", { id: "editor-publish-hint", class: "hint" }, c.saveBeforePublish);
  const previewHint = h("p", { id: "editor-preview-hint", class: "hint", hidden: true }, c.application.noPreview);
  save.setAttribute("aria-describedby", errors.id);
  showPreview.setAttribute("aria-describedby", `${errors.id} ${previewHint.id}`);
  publish.setAttribute("aria-describedby", `${errors.id} ${publishHint.id}`);
  const left = card();
  const right = card();
  const metadata = h("div");
  const inspector = h("div");
  right.append(metadata, inspector);
  const panes = h("div", { class: "editor-panes" }, left, right);
  const applicationBox = h("div", { class: "editor-application" });
  page.append(applicationBox, h("div", { class: "admin-toolbar" }, h("div", { class: "admin-actions" }, save, showPreview, publish)), previewHint, publishHint, errors, panes);

  let busy = false;
  const fields = new Map<string, { control: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement; hint: HTMLElement }>();
  function field(name: string, label: string, control: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, parent: HTMLElement) {
    control.id = `editor-${name}`;
    const hint = h("p", { id: `${control.id}-issue`, class: "error hint", hidden: true });
    control.setAttribute("aria-describedby", hint.id);
    fields.set(name, { control, hint });
    parent.append(h("div", { class: "field" }, h("label", { for: control.id }, label), control, hint));
  }
  function input(name: "title" | "description" | "completion" | "text", label: string, value: string, set: (value: string) => void, parent: HTMLElement) {
    const control = (name === "title" ? h("input", { type: "text" }) : h("textarea", { rows: "2" })) as HTMLInputElement | HTMLTextAreaElement;
    control.maxLength = name === "title" ? MAX_TITLE : MAX_TEXT;
    control.value = value;
    field(name, label, control, parent);
    control.addEventListener("input", () => { if (!busy) { set(control.value); changed(); } });
  }
  const option = (value: string, text: string) => h("option", { value }, text);
  const select = () => h("select") as HTMLSelectElement;
  const stepLabel = (index: number) => `${c.step} ${index + 1}`;
  const checkLabel = (name: string) => (c.checks as Readonly<Record<string, string>>)[name] ?? name;
  function canEdit() { return !busy && !signal.aborted; }
  function changed() {
    session.dirty = true; session.saved = false; notice.textContent = ""; update();
  }
  const applicationNamed = (id: string | undefined): ApplicationView | undefined => applications.applications.find(application => application.id === id);
  function stepControls(focus = false) {
    left.replaceChildren(h("h2", {}, c.steps));
    const list = h("ol", { class: "editor-steps" });
    let selected: HTMLButtonElement | undefined;
    const add = button(c.add);
    add.disabled = busy || draft.steps.length >= MAX_EDITOR_STEPS;
    add.addEventListener("click", () => {
      if (!canEdit() || add.disabled) return;
      draft.steps.push(emptyStep()); session.selected = draft.steps.length - 1; stepControls(true); changed();
    });
    draft.steps.forEach((_step, i) => {
      const pick = button(stepLabel(i));
      pick.setAttribute("aria-pressed", String(i === session.selected)); pick.disabled = busy;
      pick.addEventListener("click", () => {
        if (!canEdit()) return;
        session.selected = i; stepControls(true); update();
      });
      const actions = h("div", { class: "admin-actions" }, pick);
      if (i === session.selected) {
        selected = pick;
        const action = (label: string, disabled: boolean, run: () => void) => {
          const control = button(label); control.disabled = disabled || busy;
          control.setAttribute("aria-label", `${label}: ${stepLabel(i)}`);
          control.addEventListener("click", () => {
            if (!canEdit() || control.disabled) return;
            run(); stepControls(true); changed();
          });
          actions.append(control);
        };
        const move = (next: number) => { [draft.steps[i], draft.steps[next]] = [draft.steps[next]!, draft.steps[i]!]; session.selected = next; };
        action(c.up, i === 0, () => move(i - 1));
        action(c.down, i === draft.steps.length - 1, () => move(i + 1));
        action(c.remove, draft.steps.length <= 1, () => { draft.steps.splice(i, 1); session.selected = Math.min(i, draft.steps.length - 1); });
      }
      list.append(h("li", {}, actions));
    });
    left.append(list, add);
    renderInspector();
    if (focus) selected?.focus();
  }
  function renderInspector() {
    for (const name of ["target", "wait", "text", "verify"]) fields.delete(name);
    inspector.replaceChildren(h("h2", {}, stepLabel(session.selected)));
    const step = draft.steps[session.selected]!;
    const target = select();
    target.append(option("", c.problem.target));
    for (const route of registry.routes) {
      const group = h("optgroup", { label: copy.nav[route as keyof typeof copy.nav] ?? route });
      for (const item of registry.forRoute(route)) if (item.operations.includes("highlight")) group.append(option(item.id, item.label));
      if (group.childElementCount > 0) target.append(group);
    }
    target.value = step.target;
    field("target", c.target, target, inspector);
    const wait = select();
    if (step.wait === "") wait.append(option("", c.chooseWait));
    const operations = registry.get(step.target)?.operations;
    wait.append(option("ack", c.waits.ack));
    for (const kind of ["click", "input"] as const) if (operations?.includes(kind)) wait.append(option(kind, c.waits[kind]));
    wait.value = step.wait;
    field("wait", c.wait, wait, inspector);
    input("text", c.text, step.text, value => { step.text = value; }, inspector);
    const verify = select();
    verify.append(option("", c.none), ...postconditions.map(name => option(name, checkLabel(name))));
    verify.value = step.verify ?? "";
    field("verify", c.verify, verify, inspector);
    target.addEventListener("change", () => {
      if (!canEdit()) return;
      step.target = target.value;
      if (step.wait !== "" && step.wait !== "ack" && registry.get(step.target)?.operations.includes(step.wait) !== true) step.wait = "";
      renderInspector(); fields.get("target")?.control.focus(); changed();
    });
    wait.addEventListener("change", () => {
      if (!canEdit()) return;
      if ([...wait.options].some(item => item.value === wait.value)) step.wait = wait.value as WaitKind | "";
      changed();
    });
    verify.addEventListener("change", () => {
      if (!canEdit()) return;
      if (verify.value) step.verify = verify.value; else delete step.verify;
      changed();
    });
  }
  function update() {
    const validation = validateDraft(draft, registry, session.id, postconditions);
    const problems: readonly DraftProblem[] = validation.ok ? [] : validation.problems;
    const unassigned = session.applicationId === undefined;
    errors.replaceChildren(...problems.map(issue => h("li", {}, issue.step === undefined ? issue.message : `${stepLabel(issue.step)}: ${issue.message}`)),
      ...(unassigned ? [h("li", {}, c.application.required)] : []));
    errors.hidden = validation.ok && !unassigned;
    for (const [name, { control, hint }] of fields) {
      const issue = problems.find(p => p.field === name && (p.step === undefined || p.step === session.selected));
      control.disabled = busy;
      if (issue) control.setAttribute("aria-invalid", "true"); else control.removeAttribute("aria-invalid");
      hint.textContent = issue?.message ?? "";
      hint.hidden = hint.textContent === "";
    }
    // Preview runs the reference application's own runtime, so only its registry can be previewed in this release.
    const canPreview = previewable && (previewMode === "in-app" || (registry.routes.length > 0 && applicationNamed(session.applicationId)?.enabled === true));
    previewHint.textContent = previewMode === "application-window" ? "Add a route and select an enabled application to preview in its window." : c.application.noPreview;
    previewHint.hidden = canPreview || unassigned;
    save.disabled = busy || !validation.ok || unassigned;
    showPreview.disabled = busy || !validation.ok || !canPreview || previewRunning;
    publish.disabled = busy || !validation.ok || session.dirty || session.id === undefined;
    publishHint.hidden = !session.dirty && session.id !== undefined;
    return validation;
  }
  function setBusy(value: boolean) { busy = value; stepControls(); update(); renderApplication(); }
  async function showSaving(pending: Promise<AdminResult<GuideRecord>>, restoreFocus: boolean) {
    setBusy(true); notice.textContent = c.saving;
    const result = await pending;
    if (signal.aborted) return;
    setBusy(false);
    notice.textContent = result.kind === "ok" ? c.saved : `${c.saveFailed}. ${writeError(result)}`;
    if (restoreFocus) save.focus();
  }

  // ---- the application this draft is written for
  const workspace = client.studio ? browserWorkspace({
    call: client.studio, signal, application: workspaceApplication(), walkthroughId: () => session.id,
    async onRegistered() {
      const id = session.applicationId;
      if (!id) return;
      const loaded = await client.applicationRegistry(id);
      if (signal.aborted || session.applicationId !== id) return;
      if (loaded.kind === "ok") {
        ({ registry, postconditionNames: postconditions, previewable, previewMode, pages } = loaded.value);
        renderInspector(); update();
      } else {
        notice.textContent = c.application.registryFailed;
      }
    },
    bindTarget: () => {
      const step = draft.steps[session.selected];
      return evidence => {
        if (!canEdit() || !step || step !== draft.steps[session.selected]) return false;
        const target = registry.get(evidence.targetId);
        if (!target || target.privacy !== "public" || target.route !== evidence.route
          || target.role !== evidence.role || !target.operations.includes("highlight")) return false;
        step.target = target.id;
        if (step.wait !== "" && step.wait !== "ack" && !target.operations.includes(step.wait)) step.wait = "";
        renderInspector(); changed();
        return true;
      };
    },
  }) : undefined;
  function workspaceApplication() {
    const found = applicationNamed(session.applicationId);
    // `enabled` is what the editor knows now; a later change on the host is answered by the host on Connect.
    return found ? { id: found.id, name: found.name, enabled: found.enabled } : undefined;
  }
  let loads = 0;
  /** A new draft chose another application: close the session, drop the old registry and load the new one. Steps keep their targets so the check can flag them. */
  async function chooseApplication(id: string) {
    if (!canEdit() || session.applicationLocked || id === (session.applicationId ?? "")) return;
    const attempt = ++loads;
    if (id === "") delete session.applicationId; else session.applicationId = id;
    workspace?.setApplication(workspaceApplication());
    ({ registry, postconditions, previewable, previewMode, pages } = EMPTY);
    changed();
    if (id === "") { stepControls(); update(); return; }
    setBusy(true); notice.textContent = c.application.loadingRegistry;
    const loaded = await client.applicationRegistry(id);
    if (signal.aborted || attempt !== loads) return;
    busy = false;
    if (loaded.kind === "ok") ({ registry, postconditions, previewable, previewMode, pages } = { registry: loaded.value.registry, postconditions: loaded.value.postconditionNames, previewable: loaded.value.previewable, previewMode: loaded.value.previewMode, pages: loaded.value.pages });
    else {
      // A failed load leaves NO application selected (the selector shows its placeholder), so choosing the same application again is a real change and retries the load.
      delete session.applicationId;
      workspace?.setApplication(undefined);
      changed();
    }
    stepControls(); update(); renderApplication();
    notice.textContent = loaded.kind === "ok" ? "" : loaded.kind === "application" ? c.application.failures[loaded.code] : c.application.registryFailed;
    applicationBox.querySelector("select")?.focus();
  }
  function renderApplication() {
    const current = applicationNamed(session.applicationId);
    if (session.applicationLocked) {
      applicationBox.replaceChildren(card(h("h2", {}, c.application.label),
        h("p", { id: "editor-application-fixed", class: "admin-status" }, current ? `${current.name}${current.enabled ? "" : c.application.disabledSuffix}` : "—"),
        h("p", { class: "hint" }, c.application.fixedHint)));
      return;
    }
    const choice = select();
    choice.append(option("", c.application.choose));
    for (const application of applications.applications) {
      const entry = option(application.id, application.enabled ? application.name : `${application.name}${c.application.disabledSuffix}`);
      if (!application.enabled) entry.setAttribute("disabled", "");
      choice.append(entry);
    }
    choice.id = "editor-application";
    choice.value = session.applicationId ?? "";
    choice.disabled = busy;
    choice.addEventListener("change", () => { void chooseApplication(choice.value); });
    const hint = applications.applications.some(application => application.enabled) ? c.application.chooseFirst : c.application.none;
    applicationBox.replaceChildren(card(h("div", { class: "field" }, h("label", { for: choice.id }, c.application.label), choice,
      h("p", { class: "hint" }, session.applicationId === undefined ? hint : ""))));
  }

  save.addEventListener("click", () => {
    if (!canEdit() || save.disabled) return;
    const check = update();
    const owner = session.applicationId;
    if (!check.ok || owner === undefined) return;
    const id = session.id;
    // Keep the pending write with the model, so leaving and returning cannot create a second record.
    session.saving = (id === undefined ? client.create(owner, check.definition) : client.update(id, owner, check.definition)).then(result => {
      delete session.saving;
      if (result.kind === "ok") { session.id = result.value.id; session.dirty = false; session.saved = true; session.applicationLocked = true; }
      return result;
    });
    void showSaving(session.saving, true);
  });
  showPreview.addEventListener("click", () => {
    if (!canEdit() || showPreview.disabled) return;
    const check = update();
    if (!check.ok) return;
    if (previewMode === "in-app") { preview(check.definition); return; }
    const application = applicationNamed(session.applicationId);
    const win = page.ownerDocument.defaultView;
    if (!win || !application || !pages) return;
    previewRunning = true;
    notice.textContent = "Opening the application window…";
    update();
    void runInApplicationWindow({ window: win, application, bundle: {
      application: { id: application.id, name: application.name, origin: application.origin },
      definition: check.definition, registry: { routes: registry.routes, elements: registry.list(), postconditionNames: postconditions, pages },
    }, onStatus(status) {
      if (!signal.aborted) notice.textContent = applicationRunStatus(status);
    } }).then(result => {
      if (signal.aborted) return;
      previewRunning = false;
      if (result.kind !== "started") notice.textContent = applicationRunResult(result);
      update();
    });
  });
  publish.addEventListener("click", () => {
    const id = session.id;
    if (!canEdit() || publish.disabled || id === undefined || session.dirty || !update().ok) return;
    confirmPublish(publish, page, () => {
      if (!canEdit() || session.dirty || !update().ok) return;
      setBusy(true); notice.textContent = c.saving;
      void client.setStatus(id, "published").then(result => {
        if (result.kind === "ok") {
          if (getEditSession() === session) setEditSession();
          if (!signal.aborted) navigate("walkthroughs");
          refresh(!signal.aborted);
        } else if (!signal.aborted) { setBusy(false); notice.textContent = writeError(result); publish.focus(); }
      });
    });
  });

  if (workspace) { panes.insertBefore(workspace.element, right); panes.classList.add("editor-panes-studio"); }
  input("title", c.title, draft.title, value => { draft.title = value; }, metadata);
  input("description", c.description, draft.description, value => { draft.description = value; }, metadata);
  input("completion", c.completion, draft.completion, value => { draft.completion = value; }, metadata);
  renderApplication();
  if (session.saved) notice.textContent = c.saved;
  if (session.saving) void showSaving(session.saving, false);
  else { stepControls(); update(); }
}
