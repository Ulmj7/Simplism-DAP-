import { describe, expect, it, vi } from "vitest";
import { browserWorkspace, enablement } from "./browser-workspace.js";
import type { WorkspaceState } from "./browser-workspace.js";
import type { AdminResult } from "./client.js";
import type { Candidate, StudioCommand, StudioReply, StudioTarget } from "./studio-client.js";

interface App { id: string; name: string; enabled?: boolean }
const APP: App = { id: "app-000000000001", name: "Reference application" };
const OTHER: App = { id: "app-000000000002", name: "Second application" };
const target: StudioTarget = { targetId: "profile.nameInput", route: "profile", name: "Display name", role: "textbox", operations: ["highlight", "input", "focus"] };
const nameInput: Candidate = { status: "trusted", ref: "@e21", name: "Display name", role: "textbox", route: "profile", targetId: "profile.nameInput", operations: ["highlight", "input", "focus"], privacy: "public" };
const profileLink: Candidate = { status: "trusted", ref: "@e12", name: "Profile", role: "link", route: "dashboard", targetId: "nav.profile", operations: ["highlight", "click"], privacy: "public" };
const stray: Candidate = { status: "unregistered", ref: "@e30", name: "Newsletter", role: "button", route: "profile" };
type Reply = AdminResult<StudioReply>;
const ok = (value: StudioReply): Reply => ({ kind: "ok", value });
const refused = (code: string): Reply => ({ kind: "browser-error", code });
const connected = (app = APP, sessionId = "session"): Reply => ok({ kind: "connected", sessionId, applicationId: app.id, application: app.name, origin: "http://127.0.0.1:5173" });
const snapshot = (elements: readonly Candidate[], route: string | null = "profile", url = "http://127.0.0.1:5173/#/profile"): Reply => ok({ kind: "snapshot", url, route, elements });
const closed = (): Reply => ok({ kind: "closed" });
const settle = () => new Promise<void>(resolve => setTimeout(resolve, 0));
function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

/** A fake host that answers every command from a script, so every test runs against exactly the contract shapes. */
function setup(script: Partial<Record<StudioCommand["action"], (command: StudioCommand) => Reply | Promise<Reply>>> = {}, options: { app?: App | undefined; walkthroughId?: string } = {}) {
  const abort = new AbortController();
  const call = vi.fn(async (command: StudioCommand): Promise<Reply> => {
    const handler = script[command.action];
    if (handler) return handler(command);
    switch (command.action) {
      case "connect": return connected(command.applicationId === OTHER.id ? OTHER : APP);
      case "refresh": return snapshot([profileLink, nameInput, stray]);
      case "highlight": return ok({ kind: "highlighted", ref: command.ref });
      case "capture": return ok({ kind: "captured", target });
      case "disconnect": return closed();
    }
  });
  const apply = vi.fn<(applied: StudioTarget) => boolean>(() => true);
  const bindTarget = vi.fn(() => apply);
  const workspace = browserWorkspace({
    call, signal: abort.signal, bindTarget, application: "app" in options ? options.app : APP,
    ...(options.walkthroughId === undefined ? {} : { walkthroughId: () => options.walkthroughId }),
  });
  const panel = workspace.element;
  const named = (label: string) => {
    const found = [...panel.querySelectorAll("button")].find(item => (item.getAttribute("aria-label") ?? item.textContent) === label);
    if (!found) throw new Error(`Missing button ${label}`);
    return found;
  };
  const press = async (label: string) => { named(label).click(); await settle(); };
  const states = () => ({ connect: named("Connect Chrome").disabled, inspect: named("Inspect current page").disabled, disconnect: named("Disconnect").disabled });
  const line = (label: string) => [...panel.querySelectorAll("dt")].find(item => item.textContent === label)?.nextElementSibling?.textContent;
  const notice = () => panel.querySelector('[role="status"]')?.textContent;
  const rows = () => [...panel.querySelectorAll("li.studio-candidate")] as HTMLElement[];
  const commands = (action: string) => call.mock.calls.map(([command]) => command).filter(command => command.action === action);
  return { abort, call, apply, bindTarget, workspace, panel, named, press, states, line, notice, rows, commands };
}
const connectAndInspect = async (harness: ReturnType<typeof setup>) => { await harness.press("Connect Chrome"); await harness.press("Inspect current page"); };

it("binds the highlighted live ref to a registry target and disconnects on exit", async () => {
  const harness = setup();
  await harness.press("Connect Chrome");
  expect(harness.panel.textContent).toContain("Chrome connected");
  await harness.press("Inspect current page");
  expect(harness.panel.textContent).toContain("Display name");
  await harness.press("Use: Display name");
  expect(harness.apply).toHaveBeenCalledWith(target);
  expect(harness.call).toHaveBeenCalledWith({ action: "capture", sessionId: "session", applicationId: APP.id, ref: "@e21" });
  harness.abort.abort();
  expect(harness.call).toHaveBeenLastCalledWith({ action: "disconnect", sessionId: "session", applicationId: APP.id });
});

it("cleans up a Chrome connection that finishes after the editor closes", async () => {
  const pending = deferred<Reply>();
  const harness = setup({ connect: () => pending.promise });
  harness.named("Connect Chrome").click();
  harness.abort.abort();
  pending.resolve(connected(APP, "late"));
  await vi.waitFor(() => expect(harness.call).toHaveBeenLastCalledWith({ action: "disconnect", sessionId: "late", applicationId: APP.id }));
});

it("documents and enforces the enablement table for every state", () => {
  const off = { connect: false, inspect: false, disconnect: false, rows: false };
  expect(enablement("DISCONNECTED", false, true, false)).toEqual({ ...off, connect: true });
  expect(enablement("DISCONNECTED", false, false, false)).toEqual(off);
  expect(enablement("CONNECTING", false, true, false)).toEqual(off);
  expect(enablement("CONNECTED", true, true, false)).toEqual({ connect: false, inspect: true, disconnect: true, rows: true });
  expect(enablement("INSPECTING", true, true, false)).toEqual(off);
  expect(enablement("ERROR", false, true, false)).toEqual({ ...off, connect: true });
  expect(enablement("ERROR", false, false, false)).toEqual(off);
  expect(enablement("ERROR", true, true, false)).toEqual({ ...off, inspect: true, disconnect: true });
  for (const state of ["DISCONNECTED", "CONNECTING", "CONNECTED", "INSPECTING", "ERROR"] as WorkspaceState[]) {
    expect(enablement(state, true, true, true), `${state} while a command runs`).toEqual(off);
  }
});

it("starts DISCONNECTED, needs an application to connect, and shows an empty header", () => {
  const withApp = setup();
  expect(withApp.workspace.state()).toBe("DISCONNECTED");
  expect(withApp.panel.dataset.state).toBe("DISCONNECTED");
  expect(withApp.states()).toEqual({ connect: false, inspect: true, disconnect: true });
  expect(withApp.line("Application")).toBe(APP.name);
  expect(withApp.line("Status")).toBe("Disconnected");
  expect([withApp.line("Current URL"), withApp.line("Route"), withApp.line("Candidates")]).toEqual(["—", "—", "0"]);
  const none = setup({}, { app: undefined });
  expect(none.states()).toEqual({ connect: true, inspect: true, disconnect: true });
  expect(none.line("Application")).toBe("—");
});

it("walks DISCONNECTED -> CONNECTING -> CONNECTED -> INSPECTING -> CONNECTED -> DISCONNECTED with the right buttons at every step", async () => {
  const connecting = deferred<Reply>();
  const inspecting = deferred<Reply>();
  const harness = setup({ connect: () => connecting.promise, refresh: () => inspecting.promise });
  harness.named("Connect Chrome").click();
  expect(harness.workspace.state()).toBe("CONNECTING");
  expect(harness.states()).toEqual({ connect: true, inspect: true, disconnect: true });
  expect(harness.notice()).toBe("Connecting…");
  expect(harness.line("Status")).toBe("Connecting…");
  connecting.resolve(connected()); await settle();
  expect(harness.workspace.state()).toBe("CONNECTED");
  expect(harness.states()).toEqual({ connect: true, inspect: false, disconnect: false });
  expect(harness.line("Application")).toBe(APP.name);
  expect(harness.commands("connect")).toEqual([{ action: "connect", applicationId: APP.id }]);
  harness.named("Inspect current page").click();
  expect(harness.workspace.state()).toBe("INSPECTING");
  expect(harness.states()).toEqual({ connect: true, inspect: true, disconnect: true });
  inspecting.resolve(snapshot([profileLink, nameInput, stray], "profile")); await settle();
  expect(harness.workspace.state()).toBe("CONNECTED");
  expect(harness.states()).toEqual({ connect: true, inspect: false, disconnect: false });
  expect(harness.commands("refresh")).toEqual([{ action: "refresh", sessionId: "session", applicationId: APP.id }]);
  expect([harness.line("Current URL"), harness.line("Route"), harness.line("Candidates")]).toEqual(["http://127.0.0.1:5173/#/profile", "profile", "3"]);
  await harness.press("Disconnect");
  expect(harness.workspace.state()).toBe("DISCONNECTED");
  expect(harness.states()).toEqual({ connect: false, inspect: true, disconnect: true });
  expect(harness.rows()).toHaveLength(0);
  expect(harness.line("Candidates")).toBe("0");
  expect(harness.notice()).toBe("Chrome disconnected.");
  expect(harness.commands("disconnect")).toEqual([{ action: "disconnect", sessionId: "session", applicationId: APP.id }]);
});

it("shows a null route as a dash", async () => {
  const harness = setup({ refresh: () => snapshot([], null, "http://127.0.0.1:5173/#/elsewhere") });
  await connectAndInspect(harness);
  expect(harness.line("Route")).toBe("—");
  expect(harness.notice()).toBe("No candidates on this page.");
});

it.each([
  ["BROWSER_UNAVAILABLE", "The browser workspace is unavailable. You can still select a registry target."],
  ["NAVIGATION_FAILED", "Chrome could not open the application."],
  ["DOMAIN_BLOCKED", "The page is outside the approved application."],
  ["BROWSER_BUSY", "A browser workspace is already active."],
  ["APPLICATION_NOT_FOUND", "That application is no longer available."],
  ["APPLICATION_DISABLED", "That application is disabled. Enable it in Applications first."],
  ["APPLICATION_MISMATCH", "This browser session no longer matches the application. Disconnect and connect again."],
  ["FORBIDDEN", "A maintainer session is required."],
])("a failed connect with %s is ERROR with no session: Connect on, Inspect and Disconnect off", async (code, message) => {
  const harness = setup({ connect: () => refused(code) });
  await harness.press("Connect Chrome");
  expect(harness.workspace.state()).toBe("ERROR");
  expect(harness.states()).toEqual({ connect: false, inspect: true, disconnect: true });
  expect(harness.notice()).toBe(message);
  expect(harness.line("Status")).toBe("Error");
});

it.each(["BROWSER_UNAVAILABLE", "DOMAIN_BLOCKED", "NAVIGATION_FAILED", "SNAPSHOT_FAILED"])("%s while inspecting is ERROR with the session kept, so Inspect and Disconnect stay on", async code => {
  const harness = setup({ refresh: () => refused(code) });
  await harness.press("Connect Chrome");
  await harness.press("Inspect current page");
  expect(harness.workspace.state()).toBe("ERROR");
  expect(harness.states()).toEqual({ connect: true, inspect: false, disconnect: false });
  expect(harness.rows()).toHaveLength(0);
  expect(harness.line("Candidates")).toBe("0");
  // The session can still be inspected again and recovers.
  harness.call.mockImplementationOnce(async () => snapshot([profileLink]));
  await harness.press("Inspect current page");
  expect(harness.workspace.state()).toBe("CONNECTED");
  expect(harness.rows()).toHaveLength(1);
});

it("SESSION_CLOSED returns to DISCONNECTED and forgets the session and its candidates", async () => {
  const harness = setup();
  await connectAndInspect(harness);
  harness.call.mockImplementationOnce(async () => refused("SESSION_CLOSED"));
  await harness.press("Highlight: Profile");
  expect(harness.workspace.state()).toBe("DISCONNECTED");
  expect(harness.notice()).toBe("The browser session ended. Connect again.");
  expect(harness.states()).toEqual({ connect: false, inspect: true, disconnect: true });
  expect(harness.rows()).toHaveLength(0);
  await harness.press("Connect Chrome");
  expect(harness.commands("connect")).toHaveLength(2);
});

it("a failure outside the browser contract is shown as an unavailable workspace", async () => {
  const harness = setup({ connect: () => ({ kind: "failed" }) });
  await harness.press("Connect Chrome");
  expect(harness.workspace.state()).toBe("ERROR");
  expect(harness.notice()).toContain("The browser workspace is unavailable");
  const throwing = setup({ connect: () => { throw new Error("secret-canary"); } });
  await throwing.press("Connect Chrome");
  expect(throwing.workspace.state()).toBe("ERROR");
  expect(throwing.panel.textContent).not.toContain("secret-canary");
});

it("renders trusted rows with their registry facts and unregistered rows as display-only, all as text", async () => {
  const hostile: Candidate = { status: "unregistered", ref: "@e40", name: "<img src=x onerror=bad()>", role: "button", route: null };
  const harness = setup({ refresh: () => snapshot([profileLink, nameInput, stray, hostile]) });
  await connectAndInspect(harness);
  const [profile, name, newsletter, markup] = harness.rows() as [HTMLElement, HTMLElement, HTMLElement, HTMLElement];
  for (const [row, expected] of [[profile, ["Profile", "link · dashboard", "Trusted target ✓", "DAP target nav.profile", "Operations: highlight, click", "Public", "Live ref: @e12 Session only"]],
    [name, ["Display name", "textbox · profile", "Trusted target ✓", "DAP target profile.nameInput", "Operations: highlight, input, focus", "Public", "Live ref: @e21 Session only"]]] as const) {
    for (const text of expected) expect(row.textContent, text).toContain(text);
    expect([...row.querySelectorAll("button")].map(item => item.textContent)).toEqual(["Highlight", "Use"]);
    expect(row.dataset.status).toBe("trusted");
  }
  for (const row of [newsletter, markup]) {
    expect(row.dataset.status).toBe("unregistered");
    expect(row.textContent).toContain("Not registered for walkthrough use");
    expect(row.textContent).not.toContain("Trusted target");
    expect(row.textContent).not.toContain("DAP target");
    expect(row.querySelectorAll("button")).toHaveLength(0);
  }
  expect(newsletter.textContent).toContain("Live ref: @e30 Session only");
  expect(markup.textContent).toContain("<img src=x onerror=bad()>");
  expect(markup.textContent).toContain("button · —");
  expect(harness.panel.querySelector("img")).toBeNull();
  expect(harness.line("Candidates")).toBe("4");
});

it("Highlight sends the highlight command, saves nothing and never touches the draft", async () => {
  const harness = setup();
  await connectAndInspect(harness);
  await harness.press("Highlight: Display name");
  expect(harness.commands("highlight")).toEqual([{ action: "highlight", sessionId: "session", applicationId: APP.id, ref: "@e21" }]);
  expect(harness.notice()).toBe("Highlighted in Chrome — nothing was saved");
  expect(harness.bindTarget).not.toHaveBeenCalled();
  expect(harness.apply).not.toHaveBeenCalled();
  expect(harness.commands("capture")).toEqual([]);
  expect(harness.workspace.state()).toBe("CONNECTED");
});

it("Highlight refuses a reply that names another ref", async () => {
  const harness = setup({ highlight: () => ok({ kind: "highlighted", ref: "@e99" }) });
  await connectAndInspect(harness);
  await harness.press("Highlight: Display name");
  expect(harness.notice()).not.toBe("Highlighted in Chrome — nothing was saved");
  expect(harness.workspace.state()).toBe("ERROR");
});

it("Use captures a trusted candidate, applies it to the step selected at click time and confirms it", async () => {
  const harness = setup();
  await connectAndInspect(harness);
  await harness.press("Use: Display name");
  expect(harness.bindTarget).toHaveBeenCalledTimes(1);
  expect(harness.apply).toHaveBeenCalledWith(target);
  expect(harness.notice()).toBe("Captured target — Display name · textbox · profile · DAP target profile.nameInput");
  expect(harness.workspace.state()).toBe("CONNECTED");
});

it("Use says so when the selected step changed, and refuses a capture that is not the candidate that was used", async () => {
  const harness = setup();
  harness.apply.mockReturnValue(false);
  await connectAndInspect(harness);
  await harness.press("Use: Display name");
  expect(harness.notice()).toBe("The selected step changed. Select it and use the target again.");
  const other = setup({ capture: () => ok({ kind: "captured", target: { ...target, targetId: "profile.saveButton" } }) });
  await connectAndInspect(other);
  await other.press("Use: Display name");
  expect(other.apply).not.toHaveBeenCalled();
  expect(other.notice()).toBe("This element is not registered for walkthrough use.");
});

it("a stale ref asks for a new inspection, clears the list and keeps the session", async () => {
  const harness = setup({ capture: () => refused("REF_NOT_FOUND") });
  await connectAndInspect(harness);
  expect(harness.rows()).toHaveLength(3);
  await harness.press("Use: Display name");
  expect(harness.notice()).toBe("The element changed. Inspect the current page again.");
  expect(harness.rows()).toHaveLength(0);
  expect(harness.workspace.state()).toBe("CONNECTED");
  expect(harness.states()).toEqual({ connect: true, inspect: false, disconnect: false });
  expect(harness.apply).not.toHaveBeenCalled();
});

it("TARGET_UNAVAILABLE says the element is not registered, and keeps the session and the list so another row can be tried", async () => {
  const harness = setup({ highlight: () => refused("TARGET_UNAVAILABLE") });
  await connectAndInspect(harness);
  await harness.press("Highlight: Profile");
  expect(harness.workspace.state()).toBe("CONNECTED");
  expect(harness.rows()).toHaveLength(3);
  expect(harness.notice()).toBe("This element is not registered for walkthrough use.");
  expect(harness.states()).toEqual({ connect: true, inspect: false, disconnect: false });
});

it("HIGHLIGHT_FAILED is ERROR with the session still open, so the user can navigate back and Inspect or Disconnect", async () => {
  const harness = setup({ highlight: () => refused("HIGHLIGHT_FAILED") });
  await connectAndInspect(harness);
  await harness.press("Highlight: Profile");
  expect(harness.workspace.state()).toBe("ERROR");
  expect(harness.notice()).toBe("Chrome could not highlight that element.");
  expect(harness.states()).toEqual({ connect: true, inspect: false, disconnect: false });
  expect(harness.rows()).toHaveLength(0);
  await harness.press("Inspect current page");
  expect(harness.workspace.state()).toBe("CONNECTED");
  expect(harness.rows()).toHaveLength(3);
});

it("turns every control off while a command is pending, so Use cannot run twice", async () => {
  const capture = deferred<Reply>();
  const harness = setup({ capture: () => capture.promise });
  await connectAndInspect(harness);
  const use = harness.named("Use: Display name");
  use.click();
  expect(harness.states()).toEqual({ connect: true, inspect: true, disconnect: true });
  for (const item of harness.rows().flatMap(row => [...row.querySelectorAll("button")])) expect(item.disabled).toBe(true);
  use.click(); harness.named("Highlight: Profile").click(); harness.named("Inspect current page").click();
  capture.resolve(ok({ kind: "captured", target })); await settle();
  expect(harness.commands("capture")).toHaveLength(1);
  expect(harness.commands("highlight")).toHaveLength(0);
  expect(harness.commands("refresh")).toHaveLength(1);
  expect(harness.apply).toHaveBeenCalledTimes(1);
  for (const item of harness.rows().flatMap(row => [...row.querySelectorAll("button")])) expect(item.disabled).toBe(false);
});

it("ignores a double click on Connect and on Disconnect", async () => {
  const connecting = deferred<Reply>();
  const harness = setup({ connect: () => connecting.promise });
  const connect = harness.named("Connect Chrome");
  connect.click(); connect.click();
  connecting.resolve(connected()); await settle();
  expect(harness.commands("connect")).toHaveLength(1);
  const disconnect = harness.named("Disconnect");
  disconnect.click(); disconnect.click(); await settle();
  expect(harness.commands("disconnect")).toHaveLength(1);
});

it("sends the walkthrough id only when a saved draft is being edited", async () => {
  const saved = setup({}, { walkthroughId: "wt-000000000001" });
  await saved.press("Connect Chrome");
  expect(saved.commands("connect")).toEqual([{ action: "connect", applicationId: APP.id, walkthroughId: "wt-000000000001" }]);
  const fresh = setup();
  await fresh.press("Connect Chrome");
  expect(fresh.commands("connect")[0]).not.toHaveProperty("walkthroughId");
});

it("closes a session whose reply names another application than the one that was asked for", async () => {
  const harness = setup({ connect: () => connected(OTHER, "wrong") });
  await harness.press("Connect Chrome");
  expect(harness.workspace.state()).toBe("ERROR");
  expect(harness.notice()).toBe("This browser session no longer matches the application. Disconnect and connect again.");
  expect(harness.line("Application")).toBe(APP.name);
  expect(harness.commands("disconnect")).toEqual([{ action: "disconnect", sessionId: "wrong", applicationId: OTHER.id }]);
  expect(harness.states()).toEqual({ connect: false, inspect: true, disconnect: true });
});

it("selecting another application closes the session, clears the candidates and requires an explicit reconnect", async () => {
  const harness = setup();
  await connectAndInspect(harness);
  expect(harness.rows()).toHaveLength(3);
  harness.workspace.setApplication(OTHER);
  expect(harness.workspace.state()).toBe("DISCONNECTED");
  expect(harness.rows()).toHaveLength(0);
  expect(harness.line("Application")).toBe(OTHER.name);
  expect(harness.line("Candidates")).toBe("0");
  expect(harness.states()).toEqual({ connect: false, inspect: true, disconnect: true });
  await settle();
  expect(harness.commands("disconnect")).toEqual([{ action: "disconnect", sessionId: "session", applicationId: APP.id }]);
  expect(harness.commands("connect")).toHaveLength(1);
  await harness.press("Connect Chrome");
  expect(harness.commands("connect")[1]).toEqual({ action: "connect", applicationId: OTHER.id });
  await harness.press("Inspect current page");
  expect(harness.commands("refresh").at(-1)).toEqual({ action: "refresh", sessionId: "session", applicationId: OTHER.id });
});

it("selecting the same application again changes nothing, and clearing the application disables Connect", async () => {
  const harness = setup();
  await connectAndInspect(harness);
  harness.workspace.setApplication({ ...APP });
  expect(harness.workspace.state()).toBe("CONNECTED");
  expect(harness.rows()).toHaveLength(3);
  harness.workspace.setApplication(undefined);
  expect(harness.workspace.state()).toBe("DISCONNECTED");
  expect(harness.line("Application")).toBe("—");
  expect(harness.states()).toEqual({ connect: true, inspect: true, disconnect: true });
});

it("selecting another application during a connect closes the session that connect opens", async () => {
  const connecting = deferred<Reply>();
  const harness = setup({ connect: () => connecting.promise });
  harness.named("Connect Chrome").click();
  harness.workspace.setApplication(OTHER);
  expect(harness.workspace.state()).toBe("DISCONNECTED");
  connecting.resolve(connected(APP, "stale")); await settle();
  expect(harness.workspace.state()).toBe("DISCONNECTED");
  expect(harness.line("Application")).toBe(OTHER.name);
  expect(harness.commands("disconnect")).toEqual([{ action: "disconnect", sessionId: "stale", applicationId: APP.id }]);
  expect(harness.states()).toEqual({ connect: false, inspect: true, disconnect: true });
});

it("selecting another application during an inspect discards that result and closes the session afterwards, never during the command", async () => {
  const inspecting = deferred<Reply>();
  const harness = setup({ refresh: () => inspecting.promise });
  await harness.press("Connect Chrome");
  harness.named("Inspect current page").click();
  harness.workspace.setApplication(OTHER);
  expect(harness.commands("disconnect")).toHaveLength(0);
  inspecting.resolve(snapshot([profileLink])); await settle();
  expect(harness.rows()).toHaveLength(0);
  expect(harness.workspace.state()).toBe("DISCONNECTED");
  expect(harness.commands("disconnect")).toEqual([{ action: "disconnect", sessionId: "session", applicationId: APP.id }]);
});

it("aborting while idle disconnects an open session and does nothing without one", async () => {
  const harness = setup();
  await connectAndInspect(harness);
  harness.abort.abort();
  expect(harness.commands("disconnect")).toEqual([{ action: "disconnect", sessionId: "session", applicationId: APP.id }]);
  const quiet = setup();
  quiet.abort.abort();
  expect(quiet.call).not.toHaveBeenCalled();
  quiet.named("Connect Chrome").click();
  expect(quiet.call).not.toHaveBeenCalled();
});

it("aborting during a command disconnects once that command finishes", async () => {
  const inspecting = deferred<Reply>();
  const harness = setup({ refresh: () => inspecting.promise });
  await harness.press("Connect Chrome");
  harness.named("Inspect current page").click();
  harness.abort.abort();
  expect(harness.commands("disconnect")).toHaveLength(0);
  inspecting.resolve(snapshot([profileLink])); await settle();
  expect(harness.commands("disconnect")).toEqual([{ action: "disconnect", sessionId: "session", applicationId: APP.id }]);
  expect(harness.rows()).toHaveLength(0);
});

it("never puts a live ref anywhere but its own evidence line", async () => {
  const harness = setup();
  await connectAndInspect(harness);
  const withRef = [...harness.panel.querySelectorAll("*")].filter(node => /@e\d+/.test(node.textContent ?? "") && node.children.length === 0);
  expect(withRef.map(node => node.textContent)).toEqual(["Live ref: @e12 Session only", "Live ref: @e21 Session only", "Live ref: @e30 Session only"]);
  expect(JSON.stringify(Object.fromEntries(Object.entries(localStorage)))).not.toMatch(/@e\d/);
  expect(location.href).not.toMatch(/@e\d/);
});

it("APPLICATION_MISMATCH after a command is ERROR with the session still held, then SESSION_CLOSED returns to DISCONNECTED", async () => {
  const harness = setup();
  await connectAndInspect(harness);
  harness.call.mockImplementationOnce(async () => refused("APPLICATION_MISMATCH"));
  await harness.press("Inspect current page");
  expect(harness.workspace.state()).toBe("ERROR");
  expect(harness.notice()).toBe("This browser session no longer matches the application. Disconnect and connect again.");
  expect(harness.states()).toEqual({ connect: true, inspect: false, disconnect: false });
  expect(harness.rows()).toHaveLength(0);
  // The host may already have closed the session; the next command finds out and the workspace follows.
  harness.call.mockImplementationOnce(async () => refused("SESSION_CLOSED"));
  await harness.press("Inspect current page");
  expect(harness.workspace.state()).toBe("DISCONNECTED");
  expect(harness.notice()).toBe("The browser session ended. Connect again.");
  expect(harness.states()).toEqual({ connect: false, inspect: true, disconnect: true });
});

it("Disconnect still works after APPLICATION_MISMATCH and does not need the session to exist on the host", async () => {
  const harness = setup();
  await connectAndInspect(harness);
  harness.call.mockImplementationOnce(async () => refused("APPLICATION_MISMATCH"));
  await harness.press("Highlight: Profile");
  expect(harness.workspace.state()).toBe("ERROR");
  await harness.press("Disconnect");
  expect(harness.workspace.state()).toBe("DISCONNECTED");
  expect(harness.commands("disconnect")).toEqual([{ action: "disconnect", sessionId: "session", applicationId: APP.id }]);
});

it.each([
  ["refresh", "Inspect current page", "APPLICATION_DISABLED", "This application was disabled. The browser session was closed."],
  ["refresh", "Inspect current page", "APPLICATION_NOT_FOUND", "This application is no longer available. The browser session was closed."],
  ["highlight", "Highlight: Profile", "APPLICATION_DISABLED", "This application was disabled. The browser session was closed."],
  ["highlight", "Highlight: Profile", "APPLICATION_NOT_FOUND", "This application is no longer available. The browser session was closed."],
  ["capture", "Use: Display name", "APPLICATION_DISABLED", "This application was disabled. The browser session was closed."],
  ["capture", "Use: Display name", "APPLICATION_NOT_FOUND", "This application is no longer available. The browser session was closed."],
] as const)("%s refused with %s means the host closed the session: DISCONNECTED, nothing held, candidates cleared", async (action, label, code, message) => {
  const harness = setup();
  await connectAndInspect(harness);
  expect(harness.rows()).toHaveLength(3);
  harness.call.mockImplementationOnce(async () => refused(code));
  await harness.press(label);
  expect(harness.commands(action).at(-1)).toMatchObject({ action });
  expect(harness.workspace.state()).toBe("DISCONNECTED");
  expect(harness.notice()).toBe(message);
  expect(harness.rows()).toHaveLength(0);
  expect(harness.line("Candidates")).toBe("0");
  expect(harness.line("Application")).toBe(APP.name);
  expect(harness.states()).toEqual({ connect: false, inspect: true, disconnect: true });
  // No session is held, so leaving the editor has nothing to close and a reconnect is a plain connect.
  harness.abort.abort();
  expect(harness.commands("disconnect")).toEqual([]);
});

it("REF_NOT_FOUND from Highlight clears the list and asks for a new inspection", async () => {
  const harness = setup({ highlight: () => refused("REF_NOT_FOUND") });
  await connectAndInspect(harness);
  await harness.press("Highlight: Profile");
  expect(harness.notice()).toBe("The element changed. Inspect the current page again.");
  expect(harness.rows()).toHaveLength(0);
  expect(harness.workspace.state()).toBe("CONNECTED");
});

it("switching application is disconnect first, then connect: a connect clicked while the old session is closing waits for it", async () => {
  const closing = deferred<Reply>();
  const harness = setup({ disconnect: () => closing.promise });
  await connectAndInspect(harness);
  harness.workspace.setApplication(OTHER);
  harness.named("Connect Chrome").click();
  await settle();
  expect(harness.notice()).toBe("Connecting…");
  expect(harness.commands("disconnect")).toHaveLength(1);
  expect(harness.commands("connect")).toHaveLength(1);
  closing.resolve(closed()); await settle();
  expect(harness.commands("connect")).toHaveLength(2);
  expect(harness.commands("connect")[1]).toEqual({ action: "connect", applicationId: OTHER.id });
  const order = harness.call.mock.calls.map(([command]) => command.action);
  expect(order.lastIndexOf("connect")).toBeGreaterThan(order.indexOf("disconnect"));
  expect(harness.workspace.state()).toBe("CONNECTED");
});

it("never connects while a session is open: Connect is off, and a button forced on in the DOM still sends nothing", async () => {
  const harness = setup();
  await harness.press("Connect Chrome");
  expect(harness.states().connect).toBe(true);
  const connect = harness.named("Connect Chrome");
  connect.removeAttribute("disabled");
  connect.click();
  await settle();
  expect(harness.commands("connect")).toHaveLength(1);
  const inspect = harness.named("Inspect current page");
  const forced = setup();
  forced.named("Inspect current page").removeAttribute("disabled");
  forced.named("Inspect current page").click();
  forced.named("Disconnect").removeAttribute("disabled");
  forced.named("Disconnect").click();
  await settle();
  expect(forced.call).not.toHaveBeenCalled();
  expect(inspect.disabled).toBe(false);
});

const MISMATCH = "This browser session no longer matches the application. Disconnect and connect again.";
const CLOSED_BY_HOST = { APPLICATION_DISABLED: "This application was disabled. The browser session was closed.", APPLICATION_NOT_FOUND: "This application is no longer available. The browser session was closed." } as const;
const actions = [["refresh", "Inspect current page"], ["highlight", "Highlight: Profile"], ["capture", "Use: Display name"], ["disconnect", "Disconnect"]] as const;
const codes = ["APPLICATION_DISABLED", "APPLICATION_NOT_FOUND", "APPLICATION_MISMATCH", "SESSION_CLOSED"] as const;

// Every application/session code the host can answer, on every command that follows a connect.
describe.each(actions)("%s", (action, label) => {
  it.each(codes)(`answered with %s ends in the state the host's session now has`, async code => {
    const harness = setup();
    await connectAndInspect(harness);
    expect(harness.rows()).toHaveLength(3);
    harness.call.mockImplementationOnce(async () => refused(code));
    await harness.press(label);
    expect(harness.commands(action).at(-1)).toMatchObject({ action, sessionId: "session", applicationId: APP.id });
    expect(harness.rows()).toHaveLength(0);
    expect(harness.line("Candidates")).toBe("0");
    const closedMessage = code === "APPLICATION_DISABLED" || code === "APPLICATION_NOT_FOUND" ? CLOSED_BY_HOST[code] : undefined;
    const disconnectsBefore = harness.commands("disconnect").length;
    if (action === "disconnect" || code !== "APPLICATION_MISMATCH") {
      // The host closed the session (or an explicit Disconnect finished): no session id is kept, and never a stuck ERROR.
      expect(harness.workspace.state()).toBe("DISCONNECTED");
      expect(harness.states()).toEqual({ connect: false, inspect: true, disconnect: true });
      expect(harness.notice()).toBe(closedMessage ?? (action === "disconnect" ? "Chrome disconnected." : "The browser session ended. Connect again."));
      harness.abort.abort();
      expect(harness.commands("disconnect")).toHaveLength(disconnectsBefore);
    } else {
      // Wrong application for the session, or the application changed since connect: ERROR, and Disconnect stays available while the id is held.
      expect(harness.workspace.state()).toBe("ERROR");
      expect(harness.notice()).toBe(MISMATCH);
      expect(harness.states()).toEqual({ connect: true, inspect: false, disconnect: false });
      harness.abort.abort();
      expect(harness.commands("disconnect").at(-1)).toEqual({ action: "disconnect", sessionId: "session", applicationId: APP.id });
    }
  });
});

it("an explicit Disconnect never leaves a stuck ERROR, whatever goes wrong with the answer", async () => {
  for (const reply of [() => ({ kind: "failed" }) as Reply, () => refused("BROWSER_UNAVAILABLE"), () => refused("FORBIDDEN"), () => { throw new Error("network-canary"); }]) {
    const harness = setup({ disconnect: reply });
    await connectAndInspect(harness);
    await harness.press("Disconnect");
    expect(harness.workspace.state()).toBe("DISCONNECTED");
    expect(harness.states()).toEqual({ connect: false, inspect: true, disconnect: true });
    expect(harness.rows()).toHaveLength(0);
    expect(harness.notice()).toBe("Disconnected. If Chrome is still open, the host closes it when it is idle.");
    expect(harness.panel.textContent).not.toContain("network-canary");
    harness.abort.abort();
    expect(harness.commands("disconnect")).toHaveLength(1);
  }
});

it("after the host closes the session for a disabled application, Connect follows the normal rule and the host answers", async () => {
  const harness = setup();
  await connectAndInspect(harness);
  harness.call.mockImplementationOnce(async () => refused("APPLICATION_DISABLED"));
  await harness.press("Inspect current page");
  expect(harness.states().connect).toBe(false);
  harness.call.mockImplementationOnce(async () => refused("APPLICATION_DISABLED"));
  await harness.press("Connect Chrome");
  expect(harness.workspace.state()).toBe("ERROR");
  expect(harness.notice()).toBe("That application is disabled. Enable it in Applications first.");
  expect(harness.commands("connect")).toHaveLength(2);
});

it("keeps Connect off, with a plain hint, only when the editor knows the application is disabled", async () => {
  const known = setup({}, { app: { ...APP, enabled: false } });
  expect(known.states()).toEqual({ connect: true, inspect: true, disconnect: true });
  expect(known.notice()).toBe("This application is disabled. Enable it in Applications to connect.");
  known.named("Connect Chrome").removeAttribute("disabled");
  known.named("Connect Chrome").click();
  await settle();
  expect(known.call).not.toHaveBeenCalled();
  known.workspace.setApplication({ ...OTHER, enabled: true });
  expect(known.states().connect).toBe(false);
  expect(known.notice()).toBe("");
  const unknown = setup({}, { app: { ...APP } });
  expect(unknown.states().connect).toBe(false);
  expect(unknown.notice()).toBe("");
  await unknown.press("Connect Chrome");
  expect(unknown.workspace.state()).toBe("CONNECTED");
});

it("switching to an application known to be disabled closes the session and keeps Connect off with the hint", async () => {
  const harness = setup();
  await connectAndInspect(harness);
  harness.workspace.setApplication({ ...OTHER, enabled: false });
  await settle();
  expect(harness.commands("disconnect")).toEqual([{ action: "disconnect", sessionId: "session", applicationId: APP.id }]);
  expect(harness.workspace.state()).toBe("DISCONNECTED");
  expect(harness.states().connect).toBe(true);
  expect(harness.notice()).toBe("This application is disabled. Enable it in Applications to connect.");
});
