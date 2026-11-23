import { isPlainText, MAX_DESCRIPTION, MAX_LABEL } from "@dap/walkthrough";
import { h } from "../dom.js";
import { button, card, statusMessage } from "../ui/pieces.js";
import type { AdminClient } from "./client.js";
import type { Candidate, DisabledCandidate, RegisterFields, RegistrableCandidate, RegistrySource, StudioCommand, StudioReply, StudioTarget, TrustedCandidate } from "./studio-client.js";
import type { TargetView } from "./targets.js";
import { ROUTE_KEY } from "./wire.js";

/**
 * The browser workspace: connect Chrome to ONE application, inspect the page, capture a trusted target for the selected step and, for a Studio-managed application, REGISTER a
 * new target from the page.
 *
 * States and what is enabled (the table is `enablement`, and it is tested):
 *
 *   state          Connect                     Inspect          Disconnect       row Highlight / Use / Register
 *   DISCONNECTED   on (needs an application)   off              off              off
 *   CONNECTING     off                         off              off              off   ("Connecting…")
 *   CONNECTED      off                         on               on               on
 *   INSPECTING     off                         off              off              off
 *   ERROR          on when there is no session on with session  on with session    off
 *
 * Any command still running turns everything off. Reconnect (the host's `resume`) is offered only after a Connect was refused with BROWSER_BUSY, and only while no session is held.
 * A highlight changes nothing in the draft or the registry. "Use" captures a TRUSTED candidate and binds its registry id to the selected step. "Register target…" opens a
 * confirmation that shows the live evidence apart from what will be saved; only the maintainer's explicit submit sends `register`, and the host re-verifies everything. The live ref
 * (`@eN`) is session-only evidence: it is shown, sent back to the host, and never written anywhere else (not the draft, the save body, storage or the URL).
 * Typed errors are announced in an alert region with a fixed sentence; progress and results go to a polite status region.
 */
export type WorkspaceState = "DISCONNECTED" | "CONNECTING" | "CONNECTED" | "INSPECTING" | "ERROR";
export interface Enablement { readonly connect: boolean; readonly inspect: boolean; readonly disconnect: boolean; readonly rows: boolean }
const OFF: Enablement = Object.freeze({ connect: false, inspect: false, disconnect: false, rows: false });

export function enablement(state: WorkspaceState, hasSession: boolean, hasApplication: boolean, pending: boolean): Enablement {
  if (pending) return OFF;
  switch (state) {
    case "DISCONNECTED": return { ...OFF, connect: hasApplication };
    case "CONNECTED": return { connect: false, inspect: true, disconnect: true, rows: true };
    case "ERROR": return { ...OFF, connect: !hasSession && hasApplication, inspect: hasSession, disconnect: hasSession };
    case "CONNECTING": case "INSPECTING": return OFF;
  }
}
/** Reconnect is a Connect that adopts the owner's own open session: allowed exactly when Connect is, and only once the host has said a session exists. */
export const reconnectAllowed = (offered: boolean, hasSession: boolean, hasApplication: boolean, pending: boolean) => offered && !hasSession && hasApplication && !pending;

export const failures: Readonly<Record<string, string>> = Object.freeze({
  BROWSER_UNAVAILABLE: "The browser workspace is unavailable. You can still select a registry target.",
  NAVIGATION_FAILED: "Chrome could not open the application.",
  DOMAIN_BLOCKED: "The page is outside the approved application.",
  BROWSER_BUSY: "A browser workspace is already active.",
  REF_NOT_FOUND: "The element changed. Inspect the current page again.",
  SNAPSHOT_FAILED: "The current page could not be inspected.",
  HIGHLIGHT_FAILED: "Chrome could not highlight that element.",
  TARGET_UNAVAILABLE: "This element is not registered for walkthrough use.",
  FORBIDDEN: "A maintainer session is required.",
  SESSION_CLOSED: "The browser session ended. Connect again.",
  APPLICATION_NOT_FOUND: "That application is no longer available.",
  APPLICATION_DISABLED: "That application is disabled. Enable it in Applications first.",
  APPLICATION_MISMATCH: "This browser session no longer matches the application. Disconnect and connect again.",
  BROWSER_NOT_STARTED: "The browser session has not started.",
  BROWSER_TIMEOUT: "The browser command timed out. Try again.",
  CLOSE_FAILED: "Chrome could not be closed. The host will retry when it is idle.",
  INVALID_BROWSER_OUTPUT: "Chrome returned data Studio could not read. Inspect the page again.",
  INVALID_REQUEST: "The browser workspace could not use that request.",
  TARGET_NOT_REGISTRABLE: "This element can no longer be registered. Inspect the current page again.",
  TARGET_ID_MISMATCH: "The marker on the page changed since it was inspected. Inspect the current page again.",
  TARGET_EXISTS: "A target with this ID is already registered for this application. Inspect the current page again.",
  ROUTE_MISMATCH: "This page already has a route with another name. Inspect the current page again.",
  REGISTRY_NOT_MANAGED: "This application's registry is built in, so targets cannot be registered from the browser.",
  REGISTRY_FULL: "This application's registry is full. No additional targets or routes can be registered for this application.",
  INVALID_TARGET: "The target was not registered. Fix these problems and try again.",
});
// After a command (not a connect) the host has already closed the session for these two, so the workspace is simply disconnected.
const closedByHost: Readonly<Record<string, string>> = Object.freeze({
  APPLICATION_DISABLED: "This application was disabled. The browser session was closed.",
  APPLICATION_NOT_FOUND: "This application is no longer available. The browser session was closed.",
});
const disabledHint = "This application is disabled. Enable it in Applications to connect.";
const disconnected = "Chrome disconnected.";
const disconnectUnsure = "Disconnected. If Chrome is still open, the host closes it when it is idle.";
const reconnectHint = "A browser session may still be open from before. If it is yours, Reconnect takes it over.";
const reconnectBusy = "A browser session is already active and cannot be taken over from here. Try again in a few minutes.";
const unavailable = failures.BROWSER_UNAVAILABLE!;
// Failures that leave a usable session. The first group means the page, the marker or the route changed under the refs, so the list goes; the second keeps the list.
const STALE = new Set(["REF_NOT_FOUND", "TARGET_NOT_REGISTRABLE", "TARGET_ID_MISMATCH", "TARGET_EXISTS", "ROUTE_MISMATCH"]);
const SESSION_KEPT = new Set([...STALE, "TARGET_UNAVAILABLE", "REGISTRY_FULL", "REGISTRY_NOT_MANAGED", "INVALID_TARGET"]);
// The confirmation stays open (so it can be corrected) only for these.
const PANEL_KEPT = new Set(["INVALID_TARGET", "REGISTRY_FULL"]);
const statusText: Readonly<Record<WorkspaceState, string>> = Object.freeze({
  DISCONNECTED: "Disconnected", CONNECTING: "Connecting…", CONNECTED: "Connected", INSPECTING: "Inspecting…", ERROR: "Error",
});
const sourceText: Readonly<Record<RegistrySource, string>> = Object.freeze({ "built-in": "Built-in", "studio-managed": "Studio-managed" });
const operationLabels: Readonly<Record<string, string>> = Object.freeze({ highlight: "Highlight", click: "Click", input: "Input", focus: "Focus" });

/** `enabled: false` is only passed when the editor KNOWS the application is disabled; otherwise the host answers. */
export interface WorkspaceApplication { readonly id: string; readonly name: string; readonly enabled?: boolean }
export interface BrowserWorkspaceOptions {
  readonly call: NonNullable<AdminClient["studio"]>;
  readonly signal: AbortSignal;
  /** Read when "Use" is pressed, so the capture lands on the step that is selected at that moment. */
  readonly bindTarget: () => (target: StudioTarget) => boolean;
  readonly application?: WorkspaceApplication | undefined;
  /** The saved draft being edited, if any: the host refuses a connection for a different application than the draft's. */
  readonly walkthroughId?: (() => string | undefined) | undefined;
  /** Called after a target was registered and before the page is inspected again, so the editor can reload the registry its picker and its checks use. */
  readonly onRegistered?: ((target: TargetView) => Promise<void> | void) | undefined;
}
export interface BrowserWorkspace {
  readonly element: HTMLElement;
  /** Selecting another application closes the open session, clears the candidates and returns to DISCONNECTED: connecting again is explicit. */
  setApplication(application: WorkspaceApplication | undefined): void;
  state(): WorkspaceState;
}
interface Session { readonly sessionId: string; readonly applicationId: string }

let instances = 0;

export function browserWorkspace({ call, signal, bindTarget, application: initial, walkthroughId, onRegistered }: BrowserWorkspaceOptions): BrowserWorkspace {
  const instance = instances += 1;
  const uid = (name: string) => `studio-${instance}-${name}`;
  const connect = button("Connect Chrome");
  const reconnect = button("Reconnect");
  const inspect = button("Inspect current page");
  const disconnect = button("Disconnect");
  reconnect.hidden = true;
  const applicationLine = h("dd");
  const registryLine = h("dd");
  const statusLine = h("dd");
  const urlLine = h("dd");
  const routeLine = h("dd");
  const pageLine = h("dd");
  const countLine = h("dd");
  const header = h("dl", { class: "studio-status" },
    h("dt", {}, "Application"), applicationLine, h("dt", {}, "Registry"), registryLine, h("dt", {}, "Status"), statusLine, h("dt", {}, "Current URL"), urlLine,
    h("dt", {}, "Route"), routeLine, h("dt", {}, "Page"), pageLine, h("dt", {}, "Candidates"), countLine);
  const list = h("ul", { class: "studio-candidates", "aria-label": "Page candidates" });
  const listNote = h("p", { class: "hint studio-list-note" });
  const reconnectNote = h("p", { class: "hint", hidden: true }, reconnectHint);
  const registerHost = h("div", { class: "studio-register-host" });
  const notice = statusMessage();
  // Typed errors: one persistent live region (it must exist before its text changes to be announced).
  const alert = h("div", { role: "alert", class: "error studio-alert" });
  const panel = card(h("h2", {}, "Browser workspace"),
    h("p", { class: "hint" }, "Navigate and interact in the separate Chrome window, then inspect the page."),
    h("div", { class: "admin-actions" }, connect, reconnect, inspect, disconnect), reconnectNote, header, list, listNote, registerHost, alert, notice);
  panel.classList.add("studio-workspace");
  reconnect.setAttribute("aria-describedby", uid("reconnect-note"));
  reconnectNote.id = uid("reconnect-note");

  let application = initial;
  let state: WorkspaceState = "DISCONNECTED";
  let session: Session | undefined;
  let connectedName: string | undefined;
  let source: RegistrySource | undefined;
  let origin = "";
  let candidates: readonly Candidate[] = [];
  let url = "";
  let route: string | null = null;
  let page: string | null = null;
  let hidden = 0;
  let truncated = false;
  let pending = false;
  let offeredReconnect = false;
  // Bumped when the application changes: a command that started before cannot touch the new state, and a session it opened is closed.
  let epoch = 0;
  let retired: Session | undefined;
  // The host refuses a connect while a session exists (BROWSER_BUSY): switching application is "disconnect first, then connect", never a connect.
  let closing: Promise<unknown> = Promise.resolve();
  let closings = 0;
  const rowButtons: HTMLButtonElement[] = [];
  let registerForm: { readonly element: HTMLElement; readonly submit: HTMLButtonElement } | undefined;
  let registeredNote = "";

  const say = (text: string) => { alert.replaceChildren(); notice.textContent = text; };
  const warn = (text: string, issues: readonly string[] = []) => {
    notice.textContent = "";
    alert.replaceChildren(h("p", {}, text), ...(issues.length > 0 ? [h("ul", {}, ...issues.map(issue => h("li", {}, issue)))] : []));
  };

  const connectable = () => application !== undefined && application.enabled !== false;
  const allowedNow = () => enablement(state, session !== undefined, connectable(), pending);
  const reconnectNow = () => reconnectAllowed(offeredReconnect, session !== undefined, connectable(), pending);
  function render() {
    const allowed = allowedNow();
    connect.disabled = !allowed.connect;
    inspect.disabled = !allowed.inspect;
    disconnect.disabled = !allowed.disconnect;
    reconnect.hidden = reconnectNote.hidden = !offeredReconnect || session !== undefined;
    reconnect.disabled = !reconnectNow();
    for (const control of rowButtons) control.disabled = !allowed.rows;
    if (registerForm) registerForm.submit.disabled = pending || state !== "CONNECTED";
    panel.dataset.state = state;
    applicationLine.textContent = connectedName ?? application?.name ?? "—";
    registryLine.textContent = source === undefined ? "—" : sourceText[source];
    statusLine.textContent = statusText[state];
    urlLine.textContent = url || "—";
    routeLine.textContent = route ?? "—";
    pageLine.textContent = page ?? "—";
    countLine.textContent = String(candidates.length);
    const notes: string[] = [];
    if (hidden > 0) notes.push(`${hidden} ${hidden === 1 ? "element is" : "elements are"} not shown: no DAP marker or not eligible.`);
    if (truncated) notes.push(`Only the first ${candidates.length === 0 ? "" : "64 "}elements of this page were inspected. Narrow the page and inspect again to see the rest.`);
    listNote.textContent = notes.join(" ");
    listNote.hidden = notes.length === 0;
  }
  function setCandidates(next: readonly Candidate[]) {
    candidates = next;
    rowButtons.length = 0;
    list.replaceChildren(...next.map(row));
  }

  // ---- rows ------------------------------------------------------------------------------------------------------
  function action(label: string, candidate: Candidate, run: (trigger: HTMLButtonElement) => void): HTMLButtonElement {
    const control = button(label);
    control.setAttribute("aria-label", `${label.replace("…", "")}: ${candidate.name}`);
    // Handlers check the state table itself, not the button attribute: a button forced on in the DOM still cannot run a command.
    control.addEventListener("click", () => { if (allowedNow().rows && candidates.includes(candidate)) run(control); });
    rowButtons.push(control);
    return control;
  }
  function row(candidate: Candidate): HTMLElement {
    const facts = h("p", { class: "hint" }, `${candidate.role} · ${candidate.route ?? "—"}`);
    const evidence = h("p", { class: "hint studio-evidence" }, `Live ref: ${candidate.ref} Session only`);
    switch (candidate.status) {
      case "unregistered":
        return h("li", { class: "studio-candidate", "data-status": "unregistered" },
          h("strong", {}, candidate.name), facts, h("p", { class: "hint" }, "Not registered for walkthrough use"), evidence);
      case "disabled":
        return h("li", { class: "studio-candidate", "data-status": "disabled" },
          h("strong", {}, candidate.name), facts, h("p", { class: "hint" }, `Disabled target · DAP target ${candidate.targetId}`),
          h("p", { class: "hint" }, "This target is disabled in the registry. Enable it in Applications to use it."), evidence);
      case "registrable":
        return h("li", { class: "studio-candidate", "data-status": "registrable" },
          h("strong", {}, candidate.name), facts,
          h("p", { class: "hint" }, `Registrable · not registered yet · marker ${candidate.proposal.targetId}`),
          h("p", { class: "hint" }, `Page ${candidate.proposal.page}`), evidence,
          h("div", { class: "admin-actions" }, action("Highlight", candidate, () => { void highlightRow(candidate); }), action("Register target…", candidate, trigger => openRegister(candidate, trigger))));
      case "trusted":
        return h("li", { class: "studio-candidate", "data-status": "trusted" },
          h("strong", {}, candidate.name), facts,
          h("p", { class: "hint" }, `Trusted target ✓ · DAP target ${candidate.targetId}`),
          h("p", { class: "hint" }, `Operations: ${candidate.operations.join(", ")} · Public`),
          evidence, h("div", { class: "admin-actions" }, action("Highlight", candidate, () => { void highlightRow(candidate); }), action("Use", candidate, () => { void useRow(candidate); })));
    }
  }

  // ---- the registration confirmation -----------------------------------------------------------------------------
  function closeRegister(focus?: HTMLElement) {
    registerForm = undefined;
    registerHost.replaceChildren();
    focus?.focus();
  }
  /** "Live evidence" (read-only facts the host read from the page) kept visibly apart from "What will be saved" (what the maintainer confirms). */
  function openRegister(candidate: RegistrableCandidate, trigger: HTMLButtonElement) {
    if (!session) return;
    const proposal = candidate.proposal;
    const field = (name: string) => uid(`register-${name}`);
    const fact = (term: string, value: string) => [h("dt", {}, term), h("dd", {}, value)];
    const evidence = h("section", { class: "studio-register-section", "aria-labelledby": field("evidence-title") },
      h("h4", { id: field("evidence-title") }, "Live evidence"),
      h("p", { class: "hint" }, "Read from the page just now. Nothing here is saved."),
      h("dl", { class: "studio-facts" },
        ...fact("Accessible name", candidate.name), ...fact("Role on the page", candidate.role), ...fact("Application", connectedName ?? application?.name ?? "—"),
        ...fact("Origin", origin || "—"), ...fact("Current page", proposal.page), ...fact("Current route", candidate.route ?? "No route for this page yet"),
        ...fact("Live ref", `${candidate.ref} Session only`)));

    const label = h("input", { id: field("label"), type: "text", maxlength: String(MAX_LABEL), autocomplete: "off", "aria-describedby": field("label-issue") }) as HTMLInputElement;
    label.value = proposal.suggestedLabel;
    const description = h("textarea", { id: field("description"), rows: "3", maxlength: String(MAX_DESCRIPTION), "aria-describedby": field("description-issue") }) as HTMLTextAreaElement;
    const routeName = h("input", { id: field("route"), type: "text", maxlength: "40", autocomplete: "off", spellcheck: "false", "aria-describedby": field("route-issue") }) as HTMLInputElement;
    routeName.value = proposal.route;
    const issueOf = (name: string) => h("p", { id: field(`${name}-issue`), class: "error hint", hidden: true });
    const issues = { label: issueOf("label"), description: issueOf("description"), route: issueOf("route"), operations: issueOf("operations") };
    const checks = proposal.allowedOperations.map(operation => {
      const box = h("input", { type: "checkbox", value: operation, "aria-describedby": field("operations-issue") }) as HTMLInputElement;
      box.checked = proposal.defaultOperations.includes(operation);
      // `highlight` is part of every target: it is shown, checked and cannot be unchecked.
      if (operation === "highlight") { box.checked = true; box.disabled = true; }
      return { operation, box, element: h("label", { class: "studio-check" }, box, ` ${operationLabels[operation] ?? operation}`) };
    });
    const save = h("section", { class: "studio-register-section", "aria-labelledby": field("save-title") },
      h("h4", { id: field("save-title") }, "What will be saved"),
      h("div", { class: "field" }, h("label", { for: field("id") }, "Target ID"),
        h("input", { id: field("id"), type: "text", readonly: "", value: proposal.targetId, "aria-describedby": field("id-hint") }),
        h("p", { id: field("id-hint"), class: "hint" }, "Read from the page's data-ai-id. It cannot be edited here: to change it, change the marker in your application.")),
      h("dl", { class: "studio-facts" }, ...fact("Role", proposal.role), ...fact("Privacy", "Public")),
      h("p", { class: "hint" }, "Only public elements can be registered."),
      h("fieldset", { class: "field" }, h("legend", {}, "Operations"), ...checks.map(item => item.element), issues.operations),
      h("div", { class: "field" }, h("label", { for: field("label") }, "Label"), label, issues.label),
      h("div", { class: "field" }, h("label", { for: field("description") }, "Description"), description, issues.description),
      proposal.routeIsNew
        ? h("div", { class: "field" }, h("label", { for: field("route") }, "Route name"), routeName,
          h("p", { class: "hint" }, `A new route for the page ${proposal.page}. Use camelCase, starting with a lowercase letter.`), issues.route)
        : h("dl", { class: "studio-facts" }, ...fact("Route", `${proposal.route} (existing)`)));

    const submit = button("Register target", true);
    submit.type = "submit";
    const cancel = button("Cancel registration");
    const title = h("h3", { id: field("title"), tabindex: "-1" }, "Register target");
    const element = h("form", { class: "studio-register", "aria-labelledby": field("title"), novalidate: "" }, title, evidence, save, h("div", { class: "admin-actions" }, submit, cancel));
    registerForm = { element, submit };
    cancel.addEventListener("click", () => closeRegister(trigger));
    element.addEventListener("keydown", event => { if (event.key === "Escape") { event.preventDefault(); closeRegister(trigger); } });
    element.addEventListener("submit", event => {
      event.preventDefault();
      if (state !== "CONNECTED" || pending || registerForm?.element !== element) return;
      // The same rules the host applies, so an obvious mistake is shown next to its field instead of costing a round trip. The host decides anyway.
      const problems: [HTMLElement, HTMLElement, string][] = [];
      const labelText = label.value.trim();
      const descriptionText = description.value.trim();
      const routeText = proposal.routeIsNew ? routeName.value.trim() : proposal.route;
      if (!isPlainText(labelText, MAX_LABEL)) problems.push([label, issues.label, `Enter a label of 1 to ${MAX_LABEL} characters in plain text.`]);
      if (!isPlainText(descriptionText, MAX_DESCRIPTION)) problems.push([description, issues.description, `Enter a description of 1 to ${MAX_DESCRIPTION} characters in plain text.`]);
      if (proposal.routeIsNew && (routeText.length > 40 || !ROUTE_KEY.test(routeText))) problems.push([routeName, issues.route, "Use letters and digits, starting with a lowercase letter (at most 40)."]);
      for (const [control, hint] of [[label, issues.label], [description, issues.description], [routeName, issues.route]] as const) {
        control.removeAttribute("aria-invalid"); hint.textContent = ""; hint.hidden = true;
      }
      if (problems.length > 0) {
        for (const [control, hint, message] of problems) { control.setAttribute("aria-invalid", "true"); hint.textContent = message; hint.hidden = false; }
        warn("Check the highlighted fields before registering.");
        problems[0]![0].focus();
        return;
      }
      const operations = checks.filter(item => item.box.checked).map(item => item.operation);
      const fields: RegisterFields = { targetId: proposal.targetId, route: routeText, operations, label: labelText, description: descriptionText, privacy: "public" };
      void registerNow(candidate, fields);
    });
    registerHost.replaceChildren(element);
    render();
    title.focus();
  }

  // ---- session bookkeeping -----------------------------------------------------------------------------------------
  function flushRetired() {
    const old = retired;
    retired = undefined;
    if (!old) return;
    closings += 1;
    closing = Promise.all([closing, call({ action: "disconnect", sessionId: old.sessionId, applicationId: old.applicationId }).catch(() => {})]).finally(() => { closings -= 1; });
  }
  function lost() {
    session = undefined; connectedName = undefined; source = undefined; origin = ""; url = ""; route = null; page = null; hidden = 0; truncated = false; registeredNote = "";
    closeRegister(); setCandidates([]);
  }
  function fail(code: string | undefined, action: StudioCommand["action"], issues?: readonly string[]) {
    const message = code === undefined ? unavailable : failures[code] ?? unavailable;
    if (action === "disconnect") {
      // However the host answers (closed already, application gone, mismatch, unreachable), an explicit Disconnect ends with no session and no stuck ERROR.
      if (code !== undefined && closedByHost[code] !== undefined) warn(closedByHost[code]!);
      else say(code === "SESSION_CLOSED" || code === "APPLICATION_MISMATCH" ? disconnected : disconnectUnsure);
      lost(); state = "DISCONNECTED"; offeredReconnect = false;
      return;
    }
    if (action === "resume") {
      // Nothing to take over: no session exists (it closed, or was never opened), or it is not this editor's to take. Never say whose.
      if (code === "BROWSER_BUSY") { warn(reconnectBusy); state = "ERROR"; return; }
      offeredReconnect = false;
      if (code === "SESSION_CLOSED") { warn("No browser session is open. Connect again."); lost(); state = "DISCONNECTED"; return; }
    }
    if (action === "connect" && code === "BROWSER_BUSY") offeredReconnect = true;
    warn(message, issues);
    if (code === "SESSION_CLOSED") { lost(); state = "DISCONNECTED"; return; }
    if (action !== "connect" && action !== "resume" && code !== undefined && closedByHost[code] !== undefined) {
      warn(closedByHost[code]!);
      lost(); state = "DISCONNECTED";
      return;
    }
    if (code !== undefined && SESSION_KEPT.has(code) && session) {
      // The page changed under the refs (or the marker, or the route): they can no longer be trusted, so the list goes and the session stays.
      if (STALE.has(code)) setCandidates([]);
      if (!PANEL_KEPT.has(code)) closeRegister();
      state = "CONNECTED";
      return;
    }
    closeRegister(); setCandidates([]);
    state = "ERROR";
  }

  /** Runs one command. Only one is ever in flight; results from before an application change or an editor exit are discarded. */
  async function run(command: StudioCommand, working: WorkspaceState | undefined, onReply: (reply: StudioReply) => void): Promise<void> {
    if (signal.aborted || pending) return;
    pending = true;
    const started = epoch;
    if (working) state = working;
    say(working === "CONNECTING" ? "Connecting…" : working === "INSPECTING" ? "Inspecting…" : "Working…");
    render();
    try {
      // Only wait when a disconnect is really in flight, so an ordinary command is sent in the same turn as the click.
      if (closings > 0) { await closing; if (signal.aborted || epoch !== started) return; }
      const result = await call(command);
      if (signal.aborted || epoch !== started) {
        // Whatever session this command opened must not outlive the editor or the application it was opened for.
        if (result.kind === "ok" && result.value.kind === "connected") retired = { sessionId: result.value.sessionId, applicationId: result.value.applicationId };
        return;
      }
      if (result.kind === "ok") onReply(result.value);
      else fail(result.kind === "browser-error" ? result.code : undefined, command.action, result.kind === "browser-error" ? result.issues : undefined);
    } catch {
      if (!signal.aborted && epoch === started) fail(undefined, command.action);
    } finally {
      pending = false;
      if (signal.aborted) {
        flushRetired();
        if (session && command.action !== "disconnect") void call({ action: "disconnect", sessionId: session.sessionId, applicationId: session.applicationId }).catch(() => {});
      } else {
        flushRetired();
        render();
      }
    }
  }

  // ---- commands ----------------------------------------------------------------------------------------------------
  function adopt(reply: Extract<StudioReply, { kind: "connected" }>, wanted: WorkspaceApplication): void {
    if (reply.applicationId !== wanted.id) {
      // A host that connected a different application than was asked for is not trusted: close it and say so.
      retired = { sessionId: reply.sessionId, applicationId: reply.applicationId };
      fail("APPLICATION_MISMATCH", "connect");
      return;
    }
    session = { sessionId: reply.sessionId, applicationId: reply.applicationId };
    connectedName = reply.application; source = reply.registrySource; origin = reply.origin; offeredReconnect = false;
    state = "CONNECTED";
    say(reply.resumed ? "Reconnected to your open browser session. Inspect the current page." : "Chrome connected. Browse to a page, then inspect it.");
  }
  const connectNow = () => {
    if (!application) return;
    const wanted = application;
    const draft = walkthroughId?.();
    void run({ action: "connect", applicationId: wanted.id, ...(draft === undefined ? {} : { walkthroughId: draft }) }, "CONNECTING", reply => {
      if (reply.kind !== "connected") { fail(undefined, "connect"); return; }
      adopt(reply, wanted);
    });
  };
  const resumeNow = () => {
    if (!application) return;
    const wanted = application;
    void run({ action: "resume", applicationId: wanted.id }, "CONNECTING", reply => {
      if (reply.kind !== "connected" || !reply.resumed) { fail(undefined, "resume"); return; }
      adopt(reply, wanted);
    });
  };
  const inspectNow = (): Promise<void> => {
    if (!session) return Promise.resolve();
    const open = session;
    return run({ action: "refresh", sessionId: open.sessionId, applicationId: open.applicationId }, "INSPECTING", reply => {
      if (reply.kind !== "snapshot") { fail(undefined, "refresh"); return; }
      closeRegister();
      url = reply.url; route = reply.route; page = reply.page; hidden = reply.hidden; truncated = reply.truncated; setCandidates(reply.elements); state = "CONNECTED";
      if (registeredNote) { say(registeredNote); registeredNote = ""; return; }
      say(reply.elements.length > 0 ? "Highlight a target to find it in Chrome, use a trusted one for the selected step, or register a registrable one." : "No candidates on this page.");
    });
  };
  const disconnectNow = () => {
    if (!session) return;
    const open = session;
    void run({ action: "disconnect", sessionId: open.sessionId, applicationId: open.applicationId }, undefined, reply => {
      if (reply.kind !== "closed") { fail(undefined, "disconnect"); return; }
      lost(); state = "DISCONNECTED"; say(disconnected);
    });
  };
  async function highlightRow(candidate: TrustedCandidate | RegistrableCandidate) {
    if (!session) return;
    const open = session;
    await run({ action: "highlight", sessionId: open.sessionId, applicationId: open.applicationId, ref: candidate.ref }, undefined, reply => {
      // Highlighting persists nothing: no draft, no registry, no storage.
      if (reply.kind !== "highlighted" || reply.ref !== candidate.ref) { fail(undefined, "highlight"); return; }
      say("Highlighted in Chrome — nothing was saved");
    });
  }
  async function useRow(candidate: TrustedCandidate) {
    if (!session) return;
    const open = session;
    const apply = bindTarget();
    await run({ action: "capture", sessionId: open.sessionId, applicationId: open.applicationId, ref: candidate.ref }, undefined, reply => {
      if (reply.kind !== "captured" || reply.target.targetId !== candidate.targetId) { fail("TARGET_UNAVAILABLE", "capture"); return; }
      const { target } = reply;
      say(apply(target)
        ? `Captured target — ${target.name} · ${target.role} · ${target.route} · DAP target ${target.targetId}`
        : "The selected step changed. Select it and use the target again.");
    });
  }
  async function registerNow(candidate: RegistrableCandidate, fields: RegisterFields) {
    if (!session) return;
    const open = session;
    let registered: TargetView | undefined;
    await run({ action: "register", sessionId: open.sessionId, applicationId: open.applicationId, ref: candidate.ref, ...fields }, undefined, reply => {
      // The host registered exactly what was confirmed (the same id), or this reply is not trusted.
      if (reply.kind !== "registered" || reply.target.id !== fields.targetId) { fail(undefined, "register"); return; }
      registered = reply.target;
      closeRegister();
      say(`Registered target — ${reply.target.label} · ${candidate.proposal.role} · ${reply.route.route} · DAP target ${reply.target.id}${reply.route.created ? ` · new route ${reply.route.route}` : ""}`);
    });
    if (!registered || signal.aborted || session !== open) return;
    registeredNote = `Registered target — ${registered.label} · ${candidate.proposal.role} · ${registered.route} · DAP target ${registered.id}. It is now a trusted target on this page.`;
    // The editor reloads the registry its picker and checks use, then the page is inspected again: the new target shows as trusted and Use works at once.
    try { await onRegistered?.(registered); } catch { /* The editor keeps its registry; the list below is still the host's. */ }
    if (!signal.aborted && session === open) await inspectNow();
  }
  connect.addEventListener("click", () => { if (allowedNow().connect) connectNow(); });
  reconnect.addEventListener("click", () => { if (reconnectNow()) resumeNow(); });
  inspect.addEventListener("click", () => { if (allowedNow().inspect) void inspectNow(); });
  disconnect.addEventListener("click", () => { if (allowedNow().disconnect) disconnectNow(); });
  if (application?.enabled === false) say(disabledHint);
  signal.addEventListener("abort", () => {
    if (session && !pending) void call({ action: "disconnect", sessionId: session.sessionId, applicationId: session.applicationId }).catch(() => {});
  }, { once: true });
  render();

  return {
    element: panel,
    state: () => state,
    setApplication(next) {
      if (next?.id === application?.id) { application = next; render(); return; }
      application = next;
      epoch += 1;
      if (session) retired = session;
      offeredReconnect = false;
      lost(); state = "DISCONNECTED"; say(next?.enabled === false ? disabledHint : "");
      if (!pending) flushRetired();
      render();
    },
  };
}

// The candidate kinds the rows distinguish are exported for the tests that build them.
export type { Candidate, DisabledCandidate, RegistrableCandidate, TrustedCandidate };
