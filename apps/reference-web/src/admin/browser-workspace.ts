import { h } from "../dom.js";
import { button, card, statusMessage } from "../ui/pieces.js";
import type { AdminClient } from "./client.js";
import type { Candidate, StudioCommand, StudioReply, StudioTarget, TrustedCandidate } from "./studio-client.js";

/**
 * The browser workspace: connect Chrome to ONE application, inspect the page, and capture a trusted target for the selected step.
 *
 * States and what is enabled (the table is `enablement`, and it is tested):
 *
 *   state          Connect                     Inspect          Disconnect       row Highlight / Use
 *   DISCONNECTED   on (needs an application)   off              off              off
 *   CONNECTING     off                         off              off              off   ("Connecting…")
 *   CONNECTED      off                         on               on               on
 *   INSPECTING     off                         off              off              off
 *   ERROR          on when there is no session on with session  on with session    off
 *
 * Any command still running turns everything off. A highlight changes nothing in the draft. "Use" captures a TRUSTED candidate and binds
 * its registry id to the selected step. The live ref (`@eN`) is session-only evidence: it is shown, sent back to the host, and never
 * written anywhere else (not the draft, the save body, storage or the URL).
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

const failures: Readonly<Record<string, string>> = Object.freeze({
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
  INVALID_REQUEST: "The browser workspace could not use that request.",
});
// After a command (not a connect) the host has already closed the session for these two, so the workspace is simply disconnected.
const closedByHost: Readonly<Record<string, string>> = Object.freeze({
  APPLICATION_DISABLED: "This application was disabled. The browser session was closed.",
  APPLICATION_NOT_FOUND: "This application is no longer available. The browser session was closed.",
});
const disabledHint = "This application is disabled. Enable it in Applications to connect.";
const disconnected = "Chrome disconnected.";
const disconnectUnsure = "Disconnected. If Chrome is still open, the host closes it when it is idle.";
const unavailable = failures.BROWSER_UNAVAILABLE!;
// 409s that leave a usable session and page: the page changed (REF_NOT_FOUND) or the element has no trusted target (TARGET_UNAVAILABLE).
// Everything else that fails with a session open (HIGHLIGHT_FAILED, DOMAIN_BLOCKED, APPLICATION_MISMATCH, …) is ERROR with Inspect and Disconnect on.
const SESSION_KEPT = new Set(["REF_NOT_FOUND", "TARGET_UNAVAILABLE"]);
const statusText: Readonly<Record<WorkspaceState, string>> = Object.freeze({
  DISCONNECTED: "Disconnected", CONNECTING: "Connecting…", CONNECTED: "Connected", INSPECTING: "Inspecting…", ERROR: "Error",
});

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
}
export interface BrowserWorkspace {
  readonly element: HTMLElement;
  /** Selecting another application closes the open session, clears the candidates and returns to DISCONNECTED: connecting again is explicit. */
  setApplication(application: WorkspaceApplication | undefined): void;
  state(): WorkspaceState;
}
interface Session { readonly sessionId: string; readonly applicationId: string }

export function browserWorkspace({ call, signal, bindTarget, application: initial, walkthroughId }: BrowserWorkspaceOptions): BrowserWorkspace {
  const connect = button("Connect Chrome");
  const inspect = button("Inspect current page");
  const disconnect = button("Disconnect");
  const applicationLine = h("dd");
  const statusLine = h("dd");
  const urlLine = h("dd");
  const routeLine = h("dd");
  const countLine = h("dd");
  const header = h("dl", { class: "studio-status" },
    h("dt", {}, "Application"), applicationLine, h("dt", {}, "Status"), statusLine, h("dt", {}, "Current URL"), urlLine,
    h("dt", {}, "Route"), routeLine, h("dt", {}, "Candidates"), countLine);
  const list = h("ul", { class: "studio-candidates", "aria-label": "Page candidates" });
  const notice = statusMessage();
  const panel = card(h("h2", {}, "Browser workspace"),
    h("p", { class: "hint" }, "Navigate and interact in the separate Chrome window, then inspect the page."),
    h("div", { class: "admin-actions" }, connect, inspect, disconnect), header, list, notice);
  panel.classList.add("studio-workspace");

  let application = initial;
  let state: WorkspaceState = "DISCONNECTED";
  let session: Session | undefined;
  let connectedName: string | undefined;
  let candidates: readonly Candidate[] = [];
  let url = "";
  let route: string | null = null;
  let pending = false;
  // Bumped when the application changes: a command that started before cannot touch the new state, and a session it opened is closed.
  let epoch = 0;
  let retired: Session | undefined;
  // The host refuses a connect while a session exists (BROWSER_BUSY): switching application is "disconnect first, then connect", never a connect.
  let closing: Promise<unknown> = Promise.resolve();
  let closings = 0;
  const rowButtons: { highlight: HTMLButtonElement; use: HTMLButtonElement }[] = [];

  const connectable = () => application !== undefined && application.enabled !== false;
  const allowedNow = () => enablement(state, session !== undefined, connectable(), pending);
  function render() {
    const allowed = allowedNow();
    connect.disabled = !allowed.connect;
    inspect.disabled = !allowed.inspect;
    disconnect.disabled = !allowed.disconnect;
    for (const row of rowButtons) row.highlight.disabled = row.use.disabled = !allowed.rows;
    panel.dataset.state = state;
    applicationLine.textContent = connectedName ?? application?.name ?? "—";
    statusLine.textContent = statusText[state];
    urlLine.textContent = url || "—";
    routeLine.textContent = route ?? "—";
    countLine.textContent = String(candidates.length);
  }
  function setCandidates(next: readonly Candidate[]) {
    candidates = next;
    rowButtons.length = 0;
    list.replaceChildren(...next.map(row));
  }
  function row(candidate: Candidate): HTMLElement {
    const facts = h("p", { class: "hint" }, `${candidate.role} · ${candidate.route ?? "—"}`);
    const evidence = h("p", { class: "hint studio-evidence" }, `Live ref: ${candidate.ref} Session only`);
    if (candidate.status === "unregistered") {
      return h("li", { class: "studio-candidate", "data-status": "unregistered" },
        h("strong", {}, candidate.name), facts, h("p", { class: "hint" }, "Not registered for walkthrough use"), evidence);
    }
    const highlight = button("Highlight");
    const use = button("Use");
    highlight.setAttribute("aria-label", `Highlight: ${candidate.name}`);
    use.setAttribute("aria-label", `Use: ${candidate.name}`);
    // Handlers check the state table itself, not the button attribute: a button forced on in the DOM still cannot run a command.
    highlight.addEventListener("click", () => { if (allowedNow().rows) void highlightRow(candidate); });
    use.addEventListener("click", () => { if (allowedNow().rows) void useRow(candidate); });
    rowButtons.push({ highlight, use });
    return h("li", { class: "studio-candidate", "data-status": "trusted" },
      h("strong", {}, candidate.name), facts,
      h("p", { class: "hint" }, `Trusted target ✓ · DAP target ${candidate.targetId}`),
      h("p", { class: "hint" }, `Operations: ${candidate.operations.join(", ")} · Public`),
      evidence, h("div", { class: "admin-actions" }, highlight, use));
  }
  function flushRetired() {
    const old = retired;
    retired = undefined;
    if (!old) return;
    closings += 1;
    closing = Promise.all([closing, call({ action: "disconnect", sessionId: old.sessionId, applicationId: old.applicationId }).catch(() => {})]).finally(() => { closings -= 1; });
  }
  function lost() {
    session = undefined; connectedName = undefined; url = ""; route = null; setCandidates([]);
  }
  function fail(code: string | undefined, action: StudioCommand["action"]) {
    const message = code === undefined ? unavailable : failures[code] ?? unavailable;
    notice.textContent = message;
    if (action === "disconnect") {
      // However the host answers (closed already, application gone, mismatch, unreachable), an explicit Disconnect ends with no session and no stuck ERROR.
      notice.textContent = code !== undefined && closedByHost[code] !== undefined ? closedByHost[code]!
        : code === "SESSION_CLOSED" || code === "APPLICATION_MISMATCH" ? disconnected : disconnectUnsure;
      lost(); state = "DISCONNECTED";
      return;
    }
    if (code === "SESSION_CLOSED") { lost(); state = "DISCONNECTED"; return; }
    if (action !== "connect" && code !== undefined && closedByHost[code] !== undefined) {
      notice.textContent = closedByHost[code]!;
      lost(); state = "DISCONNECTED";
      return;
    }
    if (code !== undefined && SESSION_KEPT.has(code) && session) {
      // The page changed under the refs: they can no longer be trusted, so the list goes and the session stays.
      if (code === "REF_NOT_FOUND") setCandidates([]);
      state = "CONNECTED";
      return;
    }
    setCandidates([]);
    state = "ERROR";
  }

  /** Runs one command. Only one is ever in flight; results from before an application change or an editor exit are discarded. */
  async function run(command: StudioCommand, working: WorkspaceState | undefined, onReply: (reply: StudioReply) => void): Promise<void> {
    if (signal.aborted || pending) return;
    pending = true;
    const started = epoch;
    if (working) state = working;
    notice.textContent = working === "CONNECTING" ? "Connecting…" : working === "INSPECTING" ? "Inspecting…" : "Working…";
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
      else fail(result.kind === "browser-error" ? result.code : undefined, command.action);
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

  const connectNow = () => {
    if (!application) return;
    const wanted = application;
    const draft = walkthroughId?.();
    void run({ action: "connect", applicationId: wanted.id, ...(draft === undefined ? {} : { walkthroughId: draft }) }, "CONNECTING", reply => {
      if (reply.kind !== "connected") { fail(undefined, "connect"); return; }
      if (reply.applicationId !== wanted.id) {
        // A host that connected a different application than was asked for is not trusted: close it and say so.
        retired = { sessionId: reply.sessionId, applicationId: reply.applicationId };
        fail("APPLICATION_MISMATCH", "connect");
        return;
      }
      session = { sessionId: reply.sessionId, applicationId: reply.applicationId };
      connectedName = reply.application;
      state = "CONNECTED";
      notice.textContent = "Chrome connected. Browse to a page, then inspect it.";
    });
  };
  const inspectNow = () => {
    if (!session) return;
    const open = session;
    void run({ action: "refresh", sessionId: open.sessionId, applicationId: open.applicationId }, "INSPECTING", reply => {
      if (reply.kind !== "snapshot") { fail(undefined, "refresh"); return; }
      url = reply.url; route = reply.route; setCandidates(reply.elements); state = "CONNECTED";
      notice.textContent = reply.elements.length ? "Highlight a trusted target to find it in Chrome, or use it for the selected step." : "No candidates on this page.";
    });
  };
  const disconnectNow = () => {
    if (!session) return;
    const open = session;
    void run({ action: "disconnect", sessionId: open.sessionId, applicationId: open.applicationId }, undefined, reply => {
      if (reply.kind !== "closed") { fail(undefined, "disconnect"); return; }
      lost(); state = "DISCONNECTED"; notice.textContent = disconnected;
    });
  };
  async function highlightRow(candidate: TrustedCandidate) {
    if (!session) return;
    const open = session;
    await run({ action: "highlight", sessionId: open.sessionId, applicationId: open.applicationId, ref: candidate.ref }, undefined, reply => {
      // Highlighting persists nothing: no draft, no registry, no storage.
      if (reply.kind !== "highlighted" || reply.ref !== candidate.ref) { fail(undefined, "highlight"); return; }
      notice.textContent = "Highlighted in Chrome — nothing was saved";
    });
  }
  async function useRow(candidate: TrustedCandidate) {
    if (!session) return;
    const open = session;
    const apply = bindTarget();
    await run({ action: "capture", sessionId: open.sessionId, applicationId: open.applicationId, ref: candidate.ref }, undefined, reply => {
      if (reply.kind !== "captured" || reply.target.targetId !== candidate.targetId) { fail("TARGET_UNAVAILABLE", "capture"); return; }
      const { target } = reply;
      notice.textContent = apply(target)
        ? `Captured target — ${target.name} · ${target.role} · ${target.route} · DAP target ${target.targetId}`
        : "The selected step changed. Select it and use the target again.";
    });
  }
  connect.addEventListener("click", () => { if (allowedNow().connect) connectNow(); });
  inspect.addEventListener("click", () => { if (allowedNow().inspect) inspectNow(); });
  disconnect.addEventListener("click", () => { if (allowedNow().disconnect) disconnectNow(); });
  if (application?.enabled === false) notice.textContent = disabledHint;
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
      lost(); state = "DISCONNECTED"; notice.textContent = next?.enabled === false ? disabledHint : "";
      if (!pending) flushRetired();
      render();
    },
  };
}
