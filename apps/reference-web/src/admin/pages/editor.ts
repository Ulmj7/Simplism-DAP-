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
import { deleteStep, duplicateStep, moveStep, saveStateText, stepSummary, stepValidity, validityText } from "../editor-model.js";
import type { SaveState } from "../editor-model.js";
import { conditionLabels, conditionSupport, checkInputOf, describeCheck, DO_NOT_ENTER_SECRETS, fieldsOf, MANAGED_CONDITIONS } from "../verification.js";
import type { Condition, VerificationFields } from "../verification.js";
import { diagnose as diagnoseRun, progressOf } from "../preview-model.js";
import type { PreviewMode, PreviewProgress } from "../preview-model.js";
import type { CheckView } from "../checks.js";
import type { TargetHealth } from "../targets.js";
import { requestRepair } from "../session.js";
import type { DraftProblem } from "../draft.js";
import { getEditSession, newEditSession, requestEdit, setEditSession, takeRequestedEdit } from "../session.js";
import type { EditSession } from "../session.js";
import { adminPage, backLink, confirmAction, confirmPublish, readError, writeError } from "./shared.js";
import type { AdminPageOptions } from "./shared.js";

const c = copy.admin;
const CHECK_ATTRIBUTE_NAMES: readonly string[] = ["aria-checked", "aria-expanded", "aria-selected", "aria-pressed", "aria-disabled", "aria-current", "disabled", "checked"];
/** What an application contributes to the editor: its targets, the checks it declares, and whether Preview can run it. */
export interface RegistryData { registry: SemanticRegistry; postconditions: readonly string[]; previewable: boolean; pages?: Readonly<Record<string, string>>; previewMode: "in-app" | "application-window"; checks?: readonly CheckView[] }
const EMPTY: RegistryData = { registry: createSemanticRegistry({ routes: [], elements: [] }), postconditions: [], previewable: false, previewMode: "in-app", checks: [] };

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
    return loaded.kind === "ok" ? { registry: loaded.value.registry, postconditions: loaded.value.postconditionNames, previewable: loaded.value.previewable, previewMode: loaded.value.previewMode, pages: loaded.value.pages, checks: loaded.value.checks } : loaded;
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
    const session: EditSession = { id: loaded.value.id, draft, selected: 0, dirty: false, ...(loaded.value.revision === undefined ? {} : { revision: loaded.value.revision }), ...(owner === undefined ? {} : { applicationId: owner, applicationLocked: true }) };
    setEditSession(session); notice.textContent = ""; renderEditor(page, notice, session, options, applications.value, data);
  });
  return page;
}

function renderEditor(page: HTMLElement, notice: HTMLElement, session: EditSession, options: AdminPageOptions, applications: ApplicationList, initial: RegistryData) {
  const { client, signal, preview, navigate, refresh } = options;
  const { draft } = session;
  // The registry belongs to the SELECTED application and is replaced when a new draft selects another one.
  let { registry, postconditions, previewable, previewMode, pages } = initial;
  let checks: readonly CheckView[] = initial.checks ?? [];
  const save = button(c.save, true);
  const showPreview = button(c.preview);
  let previewRunning = false;
  const publish = button(c.publish);
  const errors = h("ul", { id: "editor-problems", class: "error" });
  const saveIndicator = h("p", { class: "save-state", id: "editor-save-state" });
  const conflictBox = h("div", { id: "editor-conflict", class: "error state-error", role: "alert", hidden: true });
  const publishHint = h("p", { id: "editor-publish-hint", class: "hint" }, c.saveBeforePublish);
  const previewHint = h("p", { id: "editor-preview-hint", class: "hint", hidden: true }, c.application.noPreview);
  save.setAttribute("aria-describedby", errors.id);
  showPreview.setAttribute("aria-describedby", `${errors.id} ${previewHint.id}`);
  publish.setAttribute("aria-describedby", `${errors.id} ${publishHint.id}`);
  const previewPanel = h("section", { class: "card preview-panel", id: "editor-preview-panel", "aria-labelledby": "editor-preview-title", hidden: true });
  const left = card();
  const right = card();
  const metadata = h("div");
  const inspector = h("div");
  right.append(metadata, inspector);
  const panes = h("div", { class: "editor-panes" }, left, right);
  const applicationBox = h("div", { class: "editor-application" });
  page.append(applicationBox, h("div", { class: "admin-toolbar" }, h("div", { class: "admin-actions" }, save, showPreview, publish)), previewHint, publishHint, h("div", { "aria-live": "polite" }, errors), conflictBox, saveIndicator, previewPanel, panes);

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
  // ---- what the editor knows about the application's targets (Studio-managed): health and the page marker of each (best effort; the editor works without it)
  const health = new Map<string, TargetHealth>();
  const markers = new Map<string, string>();
  const managed = () => applicationNamed(session.applicationId)?.source === "studio-managed";
  const labelOf = (id: string) => registry.get(id)?.label ?? id;
  const verifyWords = (name: string): string => {
    const found = checks.find(item => item.name === name);
    if (found) return describeCheck(found, labelOf);
    return name.startsWith("route.") ? `The page is “${name.slice(6)}”` : checkLabel(name);
  };
  async function loadManaged() {
    health.clear(); markers.clear();
    const id = session.applicationId;
    if (id === undefined || !managed()) return;
    const result = await client.targets(id);
    if (signal.aborted || session.applicationId !== id || result.kind !== "ok") return;
    for (const target of result.value.targets) { health.set(target.id, target.health); markers.set(target.id, target.marker); }
    stepControls(); update();
  }
  let saveFailed = false;
  let conflict: number | undefined;
  let mode: PreviewMode = "edit";
  const hasContent = () => draft.title !== "" || draft.description !== "" || draft.completion !== "" || draft.steps.some(step => step.target !== "" || step.text !== "");
  /** Unsaved changes the maintainer would lose: a saved workflow that was edited, or a new one that has content. */
  const hasUnsaved = () => session.dirty && session.saving === undefined && (session.id !== undefined || hasContent());
  const saveState = (): SaveState => (session.saving !== undefined ? "saving" : saveFailed ? "failed" : session.dirty ? "unsaved" : "saved");
  function canEdit() { return !busy && !signal.aborted && mode === "edit"; }
  function changed() {
    session.dirty = true; session.saved = false; saveFailed = false; notice.textContent = ""; update();
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
    const context = () => ({ registry, postconditions, health });
    draft.steps.forEach((_step, i) => {
      const pick = button(stepLabel(i));
      pick.setAttribute("aria-pressed", String(i === session.selected)); pick.disabled = busy;
      pick.addEventListener("click", () => {
        if (!canEdit()) return;
        session.selected = i; stepControls(true); update();
      });
      // The summary and the validity sit beside the button, in plain text (icon + words, never colour alone), and describe it.
      const validity = stepValidity(draft, i, context());
      const summary = h("span", { id: `editor-step-${i}-summary`, class: "step-summary" }, stepSummary(draft, i));
      const state = h("span", { id: `editor-step-${i}-validity`, class: "step-validity", "data-validity": validity.level }, validityText(validity));
      pick.setAttribute("aria-describedby", `${summary.id} ${state.id}`);
      const actions = h("div", { class: "admin-actions" }, pick);
      if (i === session.selected) {
        selected = pick;
        const action = (label: string, disabled: boolean, run: () => number | null) => {
          const control = button(label); control.disabled = disabled || busy;
          control.setAttribute("aria-label", `${label}: ${stepLabel(i)}`);
          control.addEventListener("click", () => {
            if (!canEdit() || control.disabled) return;
            const next = run();
            if (next === null) return;
            session.selected = next; stepControls(true); changed();
          });
          actions.append(control);
        };
        action(c.up, i === 0, () => moveStep(draft, i, -1));
        action(c.down, i === draft.steps.length - 1, () => moveStep(draft, i, 1));
        action("Duplicate", draft.steps.length >= MAX_EDITOR_STEPS, () => duplicateStep(draft, i));
        action(c.remove, draft.steps.length <= 1, () => deleteStep(draft, i));
      }
      list.append(h("li", { class: "editor-step-row" }, actions, summary, " ", state));
    });
    left.append(list, add);
    renderInspector();
    if (focus) selected?.focus();
  }
  function renderVerification(step: EditorStep) {
    const box = h("fieldset", { class: "field verification" }, h("legend", {}, "Verification"));
    const existing = step.verify === undefined ? undefined : checks.find(item => item.name === step.verify);
    const now: { condition: Condition; targetId: string; route: string; attribute: string; expected: string } = { condition: "none", targetId: "", route: "", attribute: "aria-expanded", expected: "" };
    if (existing) { const f: VerificationFields = fieldsOf(existing); now.condition = f.condition; now.targetId = f.targetId ?? ""; now.route = f.route ?? ""; now.attribute = f.attribute ?? "aria-expanded"; now.expected = f.expected ?? ""; }
    else if (step.verify?.startsWith("route.")) { now.condition = "route"; now.route = step.verify.slice(6); }
    const words = h("p", { id: "editor-verification-words", class: "hint" }, step.verify === undefined ? "No verification." : `Current verification: ${verifyWords(step.verify)}`);
    const alert = h("p", { id: "editor-verification-alert", class: "error", role: "alert" });
    const condition = h("select", { id: "editor-verification-condition" }) as HTMLSelectElement;
    const target = h("select", { id: "editor-verification-target" }) as HTMLSelectElement;
    const routeChoice = h("select", { id: "editor-verification-route" }) as HTMLSelectElement;
    const attribute = h("select", { id: "editor-verification-attribute" }, ...CHECK_ATTRIBUTE_NAMES.map(name => option(name, name))) as HTMLSelectElement;
    const expected = h("input", { id: "editor-verification-expected", type: "text", maxlength: "120", autocomplete: "off", "aria-describedby": "editor-verification-secrets" }) as HTMLInputElement;
    const secrets = h("p", { id: "editor-verification-secrets", class: "hint" }, DO_NOT_ENTER_SECRETS);
    target.append(option("", c.problem.target));
    for (const route of registry.routes) {
      const group = h("optgroup", { label: route });
      for (const item of registry.forRoute(route)) group.append(option(item.id, item.label));
      if (group.childElementCount > 0) target.append(group);
    }
    routeChoice.append(option("", "Choose a route"), ...registry.routes.map(route => option(route, route)));
    const roleOf = (id: string) => registry.get(id)?.role;
    function refresh() {
      const picked = target.value === "" ? undefined : roleOf(target.value);
      condition.replaceChildren(...MANAGED_CONDITIONS.map(value => {
        const support = value === "value" || value === "text" ? conditionSupport(value, picked) : { ok: true };
        const entry = option(value, support.ok ? conditionLabels[value] : `${conditionLabels[value]} (not available for this target)`);
        if (!support.ok) entry.setAttribute("disabled", "");
        return entry;
      }));
      condition.value = now.condition;
      const kind = now.condition;
      const show = (node: HTMLElement, visible: boolean) => { (node.closest(".field") as HTMLElement).hidden = !visible; };
      show(target, kind !== "none" && kind !== "route"); show(routeChoice, kind === "route"); show(attribute, kind === "attribute");
      show(expected, kind === "text" || kind === "value" || kind === "attribute");
      secrets.hidden = !(kind === "text" || kind === "value" || kind === "attribute");
    }
    const row = (control: HTMLElement, label: string) => h("div", { class: "field" }, h("label", { for: control.id }, label), control);
    const set = button("Set verification");
    const remove = button("Remove verification");
    remove.disabled = step.verify === undefined;
    box.append(words, row(condition, "Condition"), row(target, "Target"), row(routeChoice, "Route"), row(attribute, "Attribute"), row(expected, "Expected value"), secrets, alert, h("div", { class: "admin-actions" }, set, remove));
    inspector.append(box);
    target.value = now.targetId; routeChoice.value = now.route; attribute.value = now.attribute; expected.value = now.expected;
    refresh();
    condition.addEventListener("change", () => { now.condition = condition.value as Condition; alert.textContent = ""; refresh(); });
    target.addEventListener("change", () => {
      now.targetId = target.value;
      // A condition the new target cannot support falls back to the first one it can.
      if (!conditionSupport(now.condition, roleOf(now.targetId)).ok) now.condition = "visible";
      refresh();
    });
    routeChoice.addEventListener("change", () => { now.route = routeChoice.value; });
    attribute.addEventListener("change", () => { now.attribute = attribute.value; });
    expected.addEventListener("input", () => { now.expected = expected.value; });
    remove.addEventListener("click", () => {
      if (!canEdit() || step.verify === undefined) return;
      delete step.verify; renderInspector(); changed();
      notice.textContent = "Verification removed.";
    });
    set.addEventListener("click", () => {
      if (!canEdit()) return;
      alert.textContent = "";
      if (now.condition === "none") { if (step.verify !== undefined) { delete step.verify; renderInspector(); changed(); } return; }
      if (now.condition === "route") {
        const name = `route.${now.route}`;
        if (now.route === "" || !postconditions.includes(name)) { alert.textContent = "Choose a route."; return; }
        step.verify = name; renderInspector(); changed(); notice.textContent = `Verification set: ${verifyWords(name)}.`;
        return;
      }
      const request = checkInputOf({ condition: now.condition, targetId: now.targetId, attribute: now.attribute, expected: now.expected }, roleOf);
      if ("problem" in request) { alert.textContent = request.problem; return; }
      const owner = session.applicationId;
      if (owner === undefined) return;
      busy = true; set.disabled = true;
      void client.createCheck(owner, request.input).then(result => {
        busy = false;
        if (signal.aborted) return;
        if (result.kind !== "ok") {
          renderInspector();
          const message = result.kind === "denied" ? c.denied : result.kind === "invalid" ? result.issues.join(" ") : writeError(result);
          const next = inspector.querySelector<HTMLElement>("#editor-verification-alert"); if (next) next.textContent = message;
          return;
        }
        const created = result.value;
        if (!checks.some(item => item.name === created.name)) checks = [...checks, created];
        if (!postconditions.includes(created.name)) postconditions = [...postconditions, created.name];
        step.verify = created.name;
        renderInspector(); changed();
        notice.textContent = `Verification set: ${verifyWords(created.name)}.`;
      });
    });
  }
  function renderInspector() {
    for (const name of ["target", "wait", "text", "verify"]) fields.delete(name);
    inspector.replaceChildren(h("h2", {}, stepLabel(session.selected)), h("p", { id: "editor-step-validity", class: "step-validity", role: "status", "aria-live": "polite" }));
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
    if (managed()) renderVerification(step);
    else {
      const verify = select();
      verify.append(option("", c.none), ...postconditions.map(name => option(name, checkLabel(name))));
      verify.value = step.verify ?? "";
      field("verify", c.verify, verify, inspector);
      verify.addEventListener("change", () => {
        if (!canEdit()) return;
        if (verify.value) step.verify = verify.value; else delete step.verify;
        changed();
      });
    }
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
    // The registry names the preview runtime. A managed preview needs at least one registered route.
    const canPreview = previewable && (previewMode === "in-app" || (registry.routes.length > 0 && applicationNamed(session.applicationId)?.enabled === true));
    previewHint.textContent = previewMode === "application-window" ? "Add a route and select an enabled application to preview in its window." : c.application.noPreview;
    previewHint.hidden = canPreview || unassigned;
    save.disabled = busy || !validation.ok || unassigned || mode !== "edit";
    showPreview.disabled = busy || !validation.ok || !canPreview || previewRunning || mode !== "edit";
    publish.disabled = busy || !validation.ok || session.dirty || session.id === undefined || mode !== "edit";
    const state = saveState();
    saveIndicator.textContent = saveStateText[state];
    saveIndicator.setAttribute("data-state", state);
    saveIndicator.hidden = session.id === undefined && !hasContent() && !saveFailed;
    const line = inspector.querySelector<HTMLElement>("#editor-step-validity");
    if (line) {
      const own = stepValidity(draft, session.selected, { registry, postconditions, health });
      const text = `${stepLabel(session.selected)}: ${validityText(own)}`;
      if (line.textContent !== text) line.textContent = text;
      line.setAttribute("data-validity", own.level);
    }
    publishHint.hidden = !session.dirty && session.id !== undefined;
    return validation;
  }
  function setBusy(value: boolean) { busy = value; stepControls(); update(); renderApplication(); }
  async function showSaving(pending: Promise<AdminResult<GuideRecord>>, restoreFocus: boolean) {
    setBusy(true); notice.textContent = c.saving;
    const result = await pending;
    if (signal.aborted) return;
    setBusy(false);
    saveFailed = result.kind !== "ok";
    conflict = result.kind === "conflict" ? result.currentRevision : undefined;
    notice.textContent = result.kind === "ok" ? c.saved : `${c.saveFailed}. ${writeError(result)}`;
    renderConflict();
    update();
    if (restoreFocus) (conflict === undefined ? save : conflictBox.querySelector<HTMLElement>("button") ?? save).focus();
  }
  /** REVISION_CONFLICT (S5): the stored copy moved on. The local copy stays exactly as it is; nothing is overwritten unless the maintainer saves again after loading the saved version. */
  function renderConflict() {
    if (conflict === undefined) { conflictBox.replaceChildren(); conflictBox.hidden = true; return; }
    const load = button("Load the saved version");
    const keep = button("Keep editing");
    load.addEventListener("click", () => {
      const id = session.id;
      if (id === undefined || signal.aborted) return;
      setEditSession(); requestEdit(id); refresh(true);
    });
    keep.addEventListener("click", () => { conflict = undefined; renderConflict(); save.focus(); });
    conflictBox.hidden = false;
    conflictBox.replaceChildren(h("p", {}, `This workflow was changed somewhere else (it is now at revision ${conflict}). Your changes are still here and were not saved.`),
      h("p", { class: "hint" }, "Load the saved version to see what changed (your unsaved changes are discarded), or keep editing and copy what you need."), h("div", { class: "admin-actions" }, load, keep));
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
        ({ registry, postconditionNames: postconditions, previewable, previewMode, pages, checks } = loaded.value);
        renderInspector(); update(); void loadManaged();
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
  let confirmedSwitch = false;
  /** A new draft chose another application: close the session, drop the old registry and load the new one. Steps keep their targets so the check can flag them. */
  async function chooseApplication(id: string) {
    if (!canEdit() || session.applicationLocked || id === (session.applicationId ?? "")) return;
    // Switching application drops the registry the steps' targets belong to: ask first when there is something to lose.
    if (hasUnsaved() && draft.steps.some(step => step.target !== "") && !confirmedSwitch) {
      const choice = applicationBox.querySelector<HTMLSelectElement>("select");
      confirmAction(choice ?? page, page, "Switch application?", "The steps keep their targets, but those targets belong to the current application and will be flagged as unavailable.", "Switch application",
        () => { confirmedSwitch = true; void chooseApplication(id).finally(() => { confirmedSwitch = false; }); }, () => { if (choice) choice.value = session.applicationId ?? ""; });
      return;
    }
    const attempt = ++loads;
    if (id === "") delete session.applicationId; else session.applicationId = id;
    workspace?.setApplication(workspaceApplication());
    ({ registry, postconditions, previewable, previewMode, pages } = EMPTY); checks = [];
    changed();
    if (id === "") { stepControls(); update(); return; }
    setBusy(true); notice.textContent = c.application.loadingRegistry;
    const loaded = await client.applicationRegistry(id);
    if (signal.aborted || attempt !== loads) return;
    busy = false;
    if (loaded.kind === "ok") ({ registry, postconditions, previewable, previewMode, pages } = { registry: loaded.value.registry, postconditions: loaded.value.postconditionNames, previewable: loaded.value.previewable, previewMode: loaded.value.previewMode, pages: loaded.value.pages });
    if (loaded.kind === "ok") checks = loaded.value.checks;
    else {
      // A failed load leaves NO application selected (the selector shows its placeholder), so choosing the same application again is a real change and retries the load.
      delete session.applicationId;
      workspace?.setApplication(undefined);
      changed();
    }
    stepControls(); update(); renderApplication(); void loadManaged();
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
    session.saving = (id === undefined ? client.create(owner, check.definition) : client.update(id, owner, check.definition, session.revision)).then(result => {
      delete session.saving;
      if (result.kind === "ok") {
        session.id = result.value.id; session.dirty = false; session.saved = true; session.applicationLocked = true;
        if (result.value.revision !== undefined) session.revision = result.value.revision;
      }
      return result;
    });
    void showSaving(session.saving, true);
  });
  // ---- Preview as a mode: Edit -> Preview -> Results -> Edit
  let progress: PreviewProgress | null = null;
  let resultView: { ok: boolean; title: string; detail: string; action?: { targetId: string; label: string } } | undefined;
  let reported = false;
  function setMode(next: PreviewMode) {
    mode = next;
    previewPanel.hidden = next === "edit";
    panes.hidden = next !== "edit";
    renderPreviewPanel();
    update();
  }
  function renderPreviewPanel() {
    if (mode === "edit") { previewPanel.replaceChildren(); return; }
    const title = h("h2", { id: "editor-preview-title", tabindex: "-1" }, mode === "preview" ? "Preview" : "Preview results");
    const info = h("p", { class: "hint" }, "Preview always starts from Step 1 and runs the whole workflow in the application's own window.");
    const status = h("div", { id: "editor-preview-status", role: "status", "aria-live": "polite", class: "preview-status" });
    if (mode === "preview") {
      status.append(h("p", {}, progress === null ? "Starting the preview…" : `Step ${progress.step} of ${progress.count}`),
        ...(progress === null ? [] : [h("p", {}, progress.waitingFor), h("p", {}, `Target: ${progress.target}`), h("p", {}, `Verification: ${progress.verification}`)]));
    } else if (resultView) {
      status.append(h("p", { class: resultView.ok ? "" : "error" }, `${resultView.ok ? "✓" : "✕"} ${resultView.title}`), h("p", {}, resultView.detail));
    }
    const buttons = h("div", { class: "admin-actions" });
    const restart = button("Restart Preview", true);
    restart.disabled = previewRunning;
    restart.addEventListener("click", () => { startPreview(); });
    const edit = button("Edit");
    edit.addEventListener("click", () => { progress = null; resultView = undefined; setMode("edit"); showPreview.focus(); });
    if (mode === "results" && resultView?.action) {
      const rerecord = button(resultView.action.label);
      const { targetId } = resultView.action;
      rerecord.addEventListener("click", () => { const owner = session.applicationId; if (owner === undefined) return; requestRepair(owner, targetId); navigate("targets"); });
      buttons.append(rerecord);
    }
    buttons.append(restart, edit);
    previewPanel.replaceChildren(title, info, status, buttons);
  }
  function embeddedChecks() {
    const names = new Set(postconditions);
    return checks.filter(item => names.has(item.name) && item.status === "active").map(item => ({ name: item.name, kind: item.kind,
      ...(item.targetId === null ? {} : { targetId: item.targetId }), ...(item.route === null ? {} : { route: item.route }), ...(item.attribute === null ? {} : { attribute: item.attribute }), ...(item.expected === null ? {} : { expected: item.expected }) }));
  }
  function startPreview() {
    const check = update();
    if (!check.ok) return;
    if (previewMode === "in-app") { preview(check.definition); return; }
    const application = applicationNamed(session.applicationId);
    const win = page.ownerDocument.defaultView;
    if (!win || !application || !pages) return;
    const definition = check.definition;
    previewRunning = true; reported = false; progress = null;
    let entered = false;
    notice.textContent = "Opening the application window…";
    update(); renderPreviewPanel();
    const known = embeddedChecks();
    const bundleChecks = known as never;
    void runInApplicationWindow({ window: win, application, bundle: {
      application: { id: application.id, name: application.name, origin: application.origin },
      definition, registry: { routes: registry.routes,
        elements: registry.list().map(element => (markers.has(element.id) && markers.get(element.id) !== element.id ? { ...element, marker: markers.get(element.id)! } : element)),
        postconditionNames: postconditions.filter(name => name.startsWith("route.") || known.some(item => item.name === name)), pages,
        ...(known.length > 0 ? { checks: bundleChecks } : {}), ...(application.routing === "history" ? { routing: "history" as const } : {}) },
    }, onStatus(status) {
      if (signal.aborted) return;
      notice.textContent = applicationRunStatus(status);
      progress = progressOf(status, definition, labelOf, verifyWords);
      // The preview becomes the page's mode only once the application's window answered: a blocked window or a missing embed leaves the editor as it was.
      if (!entered && status.status !== "refused") { entered = true; resultView = undefined; setMode("preview"); }
      if (status.status === "COMPLETED") { resultView = { ok: true, title: "Preview completed.", detail: "Every step ran and every verification passed." }; setMode("results"); return; }
      if (status.status === "FAILED" || status.status === "CANCELLED") {
        const failure = status.failure ?? { code: status.status === "CANCELLED" ? "cancelled" as const : "invalid" as const };
        const found = diagnoseRun(failure, verifyWords);
        resultView = { ok: false, title: found.title, detail: found.detail, ...(found.action ? { action: { targetId: found.action.targetId, label: found.action.label } } : {}) };
        setMode("results");
        // A target the page no longer offers is reported to the host as broken (the client may only ever report broken).
        if (failure.code === "target_unavailable" && failure.targetId !== undefined && !reported) {
          reported = true;
          const id = failure.targetId;
          void client.setTargetHealth(application.id, id, "broken").then(result => {
            if (signal.aborted || result.kind !== "ok") return;
            health.set(id, "broken"); stepControls(); update();
            notice.textContent = `Target ${id} was reported as broken.`;
          });
        }
        return;
      }
      renderPreviewPanel();
    } }).then(result => {
      if (signal.aborted) return;
      previewRunning = false;
      if (result.kind !== "started" && mode === "preview") {
        resultView = { ok: false, title: "Preview did not run", detail: applicationRunResult(result) };
        setMode("results");
      } else update();
      if (result.kind !== "started") notice.textContent = applicationRunResult(result);
      renderPreviewPanel();
    });
  }
  showPreview.addEventListener("click", () => {
    if (!canEdit() || showPreview.disabled) return;
    startPreview();
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

  // ---- the dirty guard: unsaved changes are never lost silently (page unload, in-app navigation, application switch)
  const win = page.ownerDocument.defaultView;
  const onUnload = (event: BeforeUnloadEvent) => { if (hasUnsaved()) { event.preventDefault(); event.returnValue = ""; } };
  win?.addEventListener("beforeunload", onUnload);
  options.setNavigationGuard?.((_to, proceed) => {
    if (!hasUnsaved() || signal.aborted) return false;
    confirmAction(page.querySelector<HTMLElement>("h1") ?? page, page, "Leave with unsaved changes?", "Your changes to this workflow have not been saved. If you leave now they are lost.", "Leave without saving", () => { setEditSession(); proceed(); });
    return true;
  });
  signal.addEventListener("abort", () => { win?.removeEventListener("beforeunload", onUnload); options.setNavigationGuard?.(undefined); }, { once: true });
  if (workspace) { panes.insertBefore(workspace.element, right); panes.classList.add("editor-panes-studio"); }
  input("title", c.title, draft.title, value => { draft.title = value; }, metadata);
  input("description", c.description, draft.description, value => { draft.description = value; }, metadata);
  input("completion", c.completion, draft.completion, value => { draft.completion = value; }, metadata);
  renderApplication();
  if (session.saved) notice.textContent = c.saved;
  void loadManaged();
  if (session.saving) void showSaving(session.saving, false);
  else { stepControls(); update(); }
}
