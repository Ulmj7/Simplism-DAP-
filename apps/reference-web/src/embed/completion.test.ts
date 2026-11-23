/**
 * Studio completion in the embed: history routing, marker-based resolution, check evaluators, run diagnostics, the closed-shape parsing of all of them, and standalone delivery.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { evaluateCheck, checkPostconditions, presenceOf } from "./checks.js";
import type { CheckDef, CheckPorts } from "./checks.js";
import { installEmbed } from "./installer.js";
import { diagnose, historyPageOfPath, historyRouter, mountManagedRuntime, POLL_MS } from "./managed-runtime.js";
import { historyPageOf, parseBundle, parseStatus, runMessage, statusMessage } from "./protocol.js";
import type { ManagedBundle } from "./protocol.js";
import { composeEmbedStylesheet } from "./stylesheet.js";

const dapOrigin = "http://127.0.0.1:5186";
const name = (suffix: string) => `check.v${suffix.padStart(10, "0")}`;
const checks: CheckDef[] = [
  { name: name("a1"), kind: "route.equals", route: "profile" },
  { name: name("a2"), kind: "element.visible", targetId: "profile.savedStatus" },
  { name: name("a3"), kind: "element.text.equals", targetId: "profile.savedStatus", expected: "Saved" },
];
const make = (over: Partial<ManagedBundle["registry"]> = {}): ManagedBundle => ({
  application: { id: "app-0123456789ab", name: "Profile", origin: window.location.origin },
  version: 3,
  registry: {
    routes: ["home", "profile", "settings"], routing: "history", pages: { "/": "home", "/profile": "profile", "/settings": "settings" },
    postconditionNames: ["route.home", "route.profile", "route.settings", ...checks.map(item => item.name)], checks,
    elements: [
      { id: "nav.profile", marker: "nav.profileLink", role: "link", route: "home", label: "Profile", description: "Profile link", operations: ["highlight", "click"], privacy: "public" },
      { id: "profile.displayName", marker: "profile.nameField", role: "textbox", route: "profile", label: "Display name", description: "Display name field", operations: ["highlight", "input"], privacy: "public" },
      { id: "profile.save", role: "button", route: "profile", label: "Save", description: "Save button", operations: ["highlight", "click"], privacy: "public" },
      { id: "profile.savedStatus", marker: "profile.saved", role: "text", route: "profile", label: "Saved status", description: "Shows Saved", operations: ["highlight"], privacy: "public" },
    ],
    ...over,
  },
  definition: { id: "wt-profile", title: "Change display name", description: "Change your display name", start: "open", steps: [
    { id: "open", kind: "guide", target: "nav.profile", text: "Open your profile.", wait: "click", verify: name("a1"), next: "name" },
    { id: "name", kind: "guide", target: "profile.displayName", text: "Type a new name.", wait: "input", next: "save" },
    { id: "save", kind: "guide", target: "profile.save", text: "Press Save.", wait: "click", verify: name("a3"), next: "done" },
    { id: "done", kind: "complete", text: "Your display name was changed." },
  ] },
});

afterEach(() => {
  window.dispatchEvent(new Event("pagehide"));
  document.body.replaceChildren();
  document.head.replaceChildren();
  window.history.replaceState(null, "", "/");
  vi.useRealTimers();
  vi.restoreAllMocks();
});

/** A tiny history-routed application: links navigate with pushState (no popstate event, like a real SPA router). */
function app() {
  document.body.replaceChildren();
  const nav = document.createElement("a"); nav.dataset.aiId = "nav.profileLink"; nav.href = "/profile"; nav.textContent = "Profile";
  const input = document.createElement("input"); input.dataset.aiId = "profile.nameField"; input.type = "text";
  const save = document.createElement("button"); save.dataset.aiId = "profile.save"; save.textContent = "Save";
  const saved = document.createElement("p"); saved.dataset.aiId = "profile.saved"; saved.setAttribute("role", "status");
  document.body.append(nav, input, save, saved);
  nav.addEventListener("click", event => { event.preventDefault(); window.history.pushState(null, "", "/profile"); });
  save.addEventListener("click", () => { saved.textContent = " Saved "; });
  return { nav, input, save, saved };
}

describe("history router", () => {
  it("maps the pathname to a route (a trailing slash, query and fragment do not matter) and navigates with pushState plus popstate", () => {
    const pushed: string[] = [];
    const popstate = vi.fn();
    window.addEventListener("popstate", popstate);
    const spy = vi.spyOn(window.history, "pushState").mockImplementation((_state, _title, url) => { pushed.push(String(url)); });
    const router = historyRouter(window, { "/": "home", "/profile": "profile" });
    expect(router.current()).toBe("home");
    router.navigate("profile");
    expect(pushed).toEqual(["/profile"]);
    expect(popstate).toHaveBeenCalledOnce();
    router.navigate("unknown"); expect(pushed).toEqual(["/profile"]);
    spy.mockRestore();
    window.history.replaceState(null, "", "/profile/?variant=moved#frag");
    expect(router.current()).toBe("profile");
    router.navigate("profile"); expect(popstate).toHaveBeenCalledOnce(); // already there: no push, no event
    window.history.replaceState(null, "", "/elsewhere");
    expect(router.current()).toBe("");
    window.removeEventListener("popstate", popstate);
  });
  it.each([["/", "/"], ["/a/", "/a"], ["/a/b/", "/a/b"]])("normalises %s to %s", (input, expected) => { expect(historyPageOfPath(input)).toBe(expected); });
  it("never patches window.history", () => {
    const before = [window.history.pushState, window.history.replaceState];
    const bundle = make();
    const result = mountManagedRuntime({ window, bundle, onStatus: () => undefined });
    expect(result.ok).toBe(true);
    expect([window.history.pushState, window.history.replaceState]).toEqual(before);
    if (result.ok) result.destroy();
  });
});

describe("marker-based run on a history-routed page, with checks and diagnostics", () => {
  it("runs the whole guide: markers differ from DAP ids, SPA navigation is seen by the poll, checks are evaluated locally, statuses carry the step position", async () => {
    vi.useFakeTimers();
    const { nav, input, save } = app();
    const statuses: unknown[] = [];
    const result = mountManagedRuntime({ window, bundle: make(), trustedEventsOnly: false, onStatus: status => statuses.push(status) });
    expect(result.ok).toBe(true);
    expect(document.querySelector(".dap-guide-card")?.textContent).toContain("Open your profile.");
    nav.click();                                 // pushState only: no popstate, no hashchange
    await vi.advanceTimersByTimeAsync(POLL_MS * 2);
    expect(document.querySelector(".dap-guide-card")?.textContent).toContain("Type a new name.");
    input.value = "Ada"; input.dispatchEvent(new Event("input", { bubbles: true }));
    await vi.advanceTimersByTimeAsync(5);
    expect(document.querySelector(".dap-guide-card")?.textContent).toContain("Press Save.");
    save.click();
    await vi.advanceTimersByTimeAsync(5);
    expect((statuses.at(-1) as { status: string }).status).toBe("COMPLETED");
    expect(statuses.at(-1)).toMatchObject({ status: "COMPLETED", stepIndex: 3, stepCount: 4 });
    expect(statuses).toContainEqual(expect.objectContaining({ status: "WAITING", stepIndex: 0, stepCount: 4 }));
    expect(statuses).toContainEqual(expect.objectContaining({ status: "WAITING", stepIndex: 2, stepCount: 4 }));
    // Every status is a closed, parseable message that never carries page content.
    for (const status of statuses) expect(parseStatus(statusMessage(status as never))).not.toBeNull();
    expect(JSON.stringify(statuses)).not.toMatch(/Ada|Saved"|Profile"/u);
    if (result.ok) result.destroy();
  });

  it("the poll lives only while the run is active", async () => {
    vi.useFakeTimers();
    app();
    const setInterval = vi.spyOn(window, "setInterval");
    const clearInterval = vi.spyOn(window, "clearInterval");
    const result = mountManagedRuntime({ window, bundle: make(), onStatus: () => undefined });
    expect(setInterval).toHaveBeenCalledTimes(1);
    expect(setInterval.mock.calls[0]![1]).toBe(250);
    if (result.ok) { result.runtime.cancel(); }
    expect(clearInterval).toHaveBeenCalled();
    const before = setInterval.mock.calls.length;
    window.history.pushState(null, "", "/profile");
    await vi.advanceTimersByTimeAsync(2000);
    expect(setInterval.mock.calls.length).toBe(before);
    if (result.ok) result.destroy();
  });

  it("the pathname poll alone notices a route change that raises no popstate (a navigate step the user performs)", async () => {
    vi.useFakeTimers();
    app();
    const bundle = make();
    const navigate = { ...bundle, definition: { id: "wt-go", title: "Go to settings", description: "Go to settings", start: "go", steps: [
      { id: "go", kind: "navigate" as const, route: "settings", text: "Go to settings.", next: "done" }, { id: "done", kind: "complete" as const, text: "Arrived." }] } };
    // A navigate step WITH text asks the USER to navigate; the application's own router then pushes the path without raising any event.
    const statuses: string[] = [];
    const result = mountManagedRuntime({ window, bundle: navigate, onStatus: status => statuses.push(status.status) });
    expect(result.ok).toBe(true);
    expect(window.location.pathname).toBe("/");
    expect(statuses).not.toContain("COMPLETED");
    window.history.pushState(null, "", "/settings");                               // the user's own navigation: no popstate, no hashchange
    expect(statuses).not.toContain("COMPLETED");
    await vi.advanceTimersByTimeAsync(POLL_MS + 10);
    expect(statuses).toContain("COMPLETED");
    if (result.ok) result.destroy();
  });

  it("reports a target failure with the DAP id (not the marker), never the page", async () => {
    vi.useFakeTimers();
    const { nav } = app();
    nav.removeAttribute("data-ai-id");           // the page changed: the marker is gone
    const statuses: unknown[] = [];
    const result = mountManagedRuntime({ window, bundle: make(), onStatus: status => statuses.push(status) });
    await vi.advanceTimersByTimeAsync(10_000);
    expect(statuses.at(-1)).toMatchObject({ status: "FAILED", stepIndex: 0, stepCount: 4, failure: { code: "target_unavailable", targetId: "nav.profile" } });
    expect(JSON.stringify(statuses)).not.toContain("nav.profileLink");
    if (result.ok) result.destroy();
  });

  it("reports cancellation and route/verification failures with names only", () => {
    const bundle = make();
    const snapshot = (over: object) => ({ status: "FAILED", walkthroughId: "wt-profile", stepId: "open", stepKind: "guide", attempt: 1, failure: null, ...over }) as never;
    expect(diagnose({ status: "CANCELLED", walkthroughId: "wt-profile", stepId: "name", stepKind: "guide", attempt: 1, failure: null } as never, bundle.definition, checks, "profile"))
      .toEqual({ status: "CANCELLED", stepIndex: 1, stepCount: 4, failure: { code: "cancelled" } });
    expect(diagnose(snapshot({ failure: "verification_failed" }), bundle.definition, checks, "home"))
      .toEqual({ status: "FAILED", stepIndex: 0, stepCount: 4, failure: { code: "route_mismatch", expectedRoute: "profile", check: name("a1"), currentRoute: "home" } });
    expect(diagnose(snapshot({ failure: "verification_failed", stepId: "save" }), bundle.definition, checks, "profile"))
      .toEqual({ status: "FAILED", stepIndex: 2, stepCount: 4, failure: { code: "verification_failed", check: name("a3"), targetId: "profile.savedStatus" } });
    expect(diagnose(snapshot({ failure: "max_attempts" }), bundle.definition, checks, "")).toMatchObject({ failure: { code: "timeout" } });
    expect(diagnose(snapshot({ failure: "internal_error" }), bundle.definition, checks, "")).toMatchObject({ failure: { code: "invalid" } });
    expect(diagnose({ status: "IDLE", walkthroughId: null, stepId: null, stepKind: null, attempt: 0, failure: null }, bundle.definition, checks, "")).toBeNull();
  });

  it("the handshake (Preview) path sends the additive diagnostics to the opener", async () => {
    vi.useFakeTimers();
    app();
    const postMessage = vi.fn();
    const opener = { postMessage } as unknown as Window;
    Object.defineProperty(window, "opener", { value: opener, configurable: true });
    installEmbed(window, { dapOrigin, trustedEventsOnly: false });
    window.dispatchEvent(new MessageEvent("message", { data: runMessage(make()), origin: dapOrigin, source: opener }));
    const sent = postMessage.mock.calls.map(([message]) => message).filter(message => message.type === "dap-run-status");
    expect(sent.at(-1)).toMatchObject({ type: "dap-run-status", version: 1, status: "WAITING", stepIndex: 0, stepCount: 4 });
    Object.defineProperty(window, "opener", { value: null, configurable: true });
  });
});

describe("check evaluators compare locally and fail closed", () => {
  const ports = (route = "profile"): CheckPorts => ({ root: document.body, route: () => route, markerOf: id => ({ "profile.savedStatus": "profile.saved", "profile.displayName": "profile.nameField", "settings.advancedToggle": "settings.advancedToggle", "profile.agree": "profile.agree" })[id], roleOf: id => ({ "profile.displayName": "textbox", "profile.savedStatus": "text", "settings.advancedToggle": "button", "profile.agree": "checkbox" })[id] });
  const add = (tag: string, marker: string, attrs: Record<string, string> = {}, text = "") => {
    const element = document.createElement(tag); element.dataset.aiId = marker; element.textContent = text;
    for (const [key, value] of Object.entries(attrs)) element.setAttribute(key, value);
    document.body.append(element); return element;
  };
  const run = (check: Record<string, unknown>, p = ports()) => evaluateCheck({ name: name("1"), ...check } as CheckDef, p);

  it("route.equals, element.visible, element.hidden", () => {
    expect(run({ kind: "route.equals", route: "profile" })).toBe(true);
    expect(run({ kind: "route.equals", route: "home" })).toBe(false);
    expect(run({ kind: "element.visible", targetId: "profile.savedStatus" })).toBe(false);          // absent
    expect(run({ kind: "element.hidden", targetId: "profile.savedStatus" })).toBe(true);
    const status = add("p", "profile.saved", {}, "Saved");
    expect(run({ kind: "element.visible", targetId: "profile.savedStatus" })).toBe(true);
    expect(run({ kind: "element.hidden", targetId: "profile.savedStatus" })).toBe(false);
    status.hidden = true;
    expect(run({ kind: "element.visible", targetId: "profile.savedStatus" })).toBe(false);
    expect(run({ kind: "element.hidden", targetId: "profile.savedStatus" })).toBe(true);
    status.hidden = false;
    add("p", "profile.saved", {}, "twin");                                                         // ambiguous: neither visible nor hidden
    expect(run({ kind: "element.visible", targetId: "profile.savedStatus" })).toBe(false);
    expect(run({ kind: "element.hidden", targetId: "profile.savedStatus" })).toBe(false);
    expect(presenceOf(document.body, "profile.saved").state).toBe("ambiguous");
  });
  it("element.text.equals trims both sides and is exact otherwise", () => {
    add("p", "profile.saved", {}, "  Saved \n");
    expect(run({ kind: "element.text.equals", targetId: "profile.savedStatus", expected: "Saved" })).toBe(true);
    expect(run({ kind: "element.text.equals", targetId: "profile.savedStatus", expected: " Saved " })).toBe(true);
    expect(run({ kind: "element.text.equals", targetId: "profile.savedStatus", expected: "saved" })).toBe(false);
    expect(run({ kind: "element.text.equals", targetId: "profile.savedStatus", expected: "Saved!" })).toBe(false);
  });
  it("element.value.equals: textbox, select and checkbox only, exact", () => {
    const input = add("input", "profile.nameField", { type: "text" }) as HTMLInputElement; input.value = "Ada";
    expect(run({ kind: "element.value.equals", targetId: "profile.displayName", expected: "Ada" })).toBe(true);
    expect(run({ kind: "element.value.equals", targetId: "profile.displayName", expected: "ada" })).toBe(false);
    const box = add("input", "profile.agree", { type: "checkbox" }) as HTMLInputElement; box.checked = true;
    expect(run({ kind: "element.value.equals", targetId: "profile.agree", expected: "true" })).toBe(true);
    box.checked = false;
    expect(run({ kind: "element.value.equals", targetId: "profile.agree", expected: "false" })).toBe(true);
    // A button's value is not readable through a value check, whatever it holds.
    const button = add("button", "settings.advancedToggle", { value: "secret-canary" });
    expect(run({ kind: "element.value.equals", targetId: "settings.advancedToggle", expected: "secret-canary" })).toBe(false);
    button.remove();
  });
  it("a private, ignored, redacted or password element is never read", () => {
    const input = add("input", "profile.nameField", { type: "password" }) as HTMLInputElement; input.value = "secret-canary";
    expect(run({ kind: "element.value.equals", targetId: "profile.displayName", expected: "secret-canary" })).toBe(false);
    expect(run({ kind: "element.visible", targetId: "profile.displayName" })).toBe(false);
    expect(run({ kind: "element.hidden", targetId: "profile.displayName" })).toBe(false);
    input.type = "text";
    expect(run({ kind: "element.value.equals", targetId: "profile.displayName", expected: "secret-canary" })).toBe(true);
    for (const attribute of ["data-ai-private", "data-ai-redact", "data-ai-ignore"]) {
      input.setAttribute(attribute, "");
      expect(run({ kind: "element.value.equals", targetId: "profile.displayName", expected: "secret-canary" }), attribute).toBe(false);
      input.removeAttribute(attribute);
    }
    const wrapper = document.createElement("div"); wrapper.setAttribute("data-ai-ignore", ""); input.replaceWith(wrapper); wrapper.append(input);
    expect(run({ kind: "element.value.equals", targetId: "profile.displayName", expected: "secret-canary" })).toBe(false);
  });
  it("element.attribute.equals reads the allow-listed attribute", () => {
    const toggle = add("button", "settings.advancedToggle", { "aria-expanded": "true" });
    expect(run({ kind: "element.attribute.equals", targetId: "settings.advancedToggle", attribute: "aria-expanded", expected: "true" })).toBe(true);
    expect(run({ kind: "element.attribute.equals", targetId: "settings.advancedToggle", attribute: "aria-expanded", expected: "false" })).toBe(false);
    expect(run({ kind: "element.attribute.equals", targetId: "settings.advancedToggle", attribute: "aria-pressed", expected: "true" })).toBe(false); // absent never equals
    expect(run({ kind: "element.attribute.equals", targetId: "settings.advancedToggle", attribute: "disabled", expected: "false" })).toBe(true);
    toggle.setAttribute("disabled", "");
    expect(run({ kind: "element.attribute.equals", targetId: "settings.advancedToggle", attribute: "disabled", expected: "true" })).toBe(true);
  });
  it("an unknown target, a thrown error and a missing marker are false", () => {
    expect(run({ kind: "element.visible", targetId: "unknown.target" })).toBe(false);
    expect(evaluateCheck({ name: name("1"), kind: "element.visible", targetId: "profile.savedStatus" }, { ...ports(), root: null as never })).toBe(false);
  });
  it("registers route.<route> and one named postcondition per check", () => {
    const named = checkPostconditions(["home", "profile"], checks, ports());
    expect(Object.keys(named).sort()).toEqual(["route.home", "route.profile", ...checks.map(item => item.name)].sort());
    expect(named["route.profile"]!()).toBe(true);
    expect(named["route.home"]!()).toBe(false);
    expect(Object.isFrozen(named)).toBe(true);
  });
  it("never posts, logs or stores what it compared", () => {
    const input = add("input", "profile.nameField", { type: "text" }) as HTMLInputElement; input.value = "value-canary";
    const sinks = [vi.spyOn(console, "log"), vi.spyOn(console, "warn"), vi.spyOn(console, "error"), vi.spyOn(console, "info")];
    const post = vi.spyOn(window, "postMessage");
    run({ kind: "element.value.equals", targetId: "profile.displayName", expected: "value-canary" });
    run({ kind: "element.value.equals", targetId: "profile.displayName", expected: "other" });
    for (const sink of sinks) expect(sink).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
    expect(window.localStorage.length + window.sessionStorage.length).toBe(0);
  });
});

describe("closed-shape parsing of the additive bundle fields", () => {
  const ok = (bundle: unknown) => parseBundle(bundle).ok;
  it("accepts the complete shape, with and without the additive fields, and takes independent copies", () => {
    const bundle = make();
    const parsed = parseBundle(bundle);
    expect(parsed.ok && parsed.bundle).toEqual(bundle);
    expect(parsed.ok && parsed.bundle.registry.checks).not.toBe(bundle.registry.checks);
    const { checks: _checks, routing: _routing, ...bare } = bundle.registry;
    void _checks; void _routing;
    const old = { ...bundle, version: undefined, registry: { ...bare, postconditionNames: ["route.home", "route.profile", "route.settings"], pages: { "/": "home", "/#/profile": "profile", "/#/settings": "settings" }, elements: bundle.registry.elements.filter(item => item.role !== "text").map(item => { const copy = { ...item }; delete (copy as { marker?: string }).marker; return copy; }) } };
    delete (old as { version?: unknown }).version;
    expect(ok({ ...old, definition: { ...bundle.definition, steps: [{ id: "done", kind: "complete", text: "x" }], start: "done" } })).toBe(true);
  });
  it("accepts the bundle exactly as the host's shared builder emits it (marker = id, empty checks, hash routing, version)", () => {
    const hostStyle = {
      definition: { id: "wt-0123456789ab", title: "Open Orders", description: "Guide", start: "open", steps: [
        { id: "open", kind: "guide", target: "nav.orders", text: "Open Orders.", wait: "click", verify: "route.orders", next: "done" }, { id: "done", kind: "complete", text: "Done." }] },
      application: { id: "app-0123456789ab", name: "Orders", origin: "http://127.0.0.1:5187" },
      registry: { routes: ["home", "orders"], elements: [{ id: "nav.orders", marker: "nav.orders", route: "home", role: "link", label: "Orders", description: "Open Orders.", operations: ["highlight", "click"], privacy: "public" }],
        postconditionNames: ["route.home", "route.orders"], checks: [], routing: "hash", pages: { "/": "home", "/#/orders": "orders" } },
      version: 1,
    };
    expect(parseBundle(hostStyle).ok).toBe(true);
  });
  it.each([
    ["an unknown routing", (b: ManagedBundle) => ({ ...b, registry: { ...b.registry, routing: "path" } })],
    ["a history page with a trailing slash", (b: ManagedBundle) => ({ ...b, registry: { ...b.registry, pages: { ...b.registry.pages, "/profile/": "profile" }, } })],
    ["a history page with a query", (b: ManagedBundle) => ({ ...b, registry: { ...b.registry, pages: { "/": "home", "/profile?x=1": "profile", "/settings": "settings" } } })],
    ["a history page with a hash", (b: ManagedBundle) => ({ ...b, registry: { ...b.registry, pages: { "/": "home", "/profile#x": "profile", "/settings": "settings" } } })],
    ["a history page with an empty segment", (b: ManagedBundle) => ({ ...b, registry: { ...b.registry, pages: { "/": "home", "//profile": "profile", "/settings": "settings" } } })],
    ["a history page of 201 characters", (b: ManagedBundle) => ({ ...b, registry: { ...b.registry, pages: { "/": "home", ["/" + "a".repeat(200)]: "profile", "/settings": "settings" } } })],
    ["hash pages under history routing... is fine, a history page under hash routing is not", (b: ManagedBundle) => ({ ...b, registry: { ...b.registry, routing: "hash" } })],
    ["an unknown check kind", (b: ManagedBundle) => ({ ...b, registry: { ...b.registry, checks: [{ name: name("a1"), kind: "script.run", route: "profile" }] } })],
    ["a check with an extra key", (b: ManagedBundle) => ({ ...b, registry: { ...b.registry, checks: [{ ...checks[0], extra: 1 }, ...checks.slice(1)] } })],
    ["a check name that is not check.v + 10 hex", (b: ManagedBundle) => ({ ...b, registry: { ...b.registry, checks: [{ ...checks[0], name: "check.vXYZ" }, ...checks.slice(1)] } })],
    ["a check of an unknown target", (b: ManagedBundle) => ({ ...b, registry: { ...b.registry, checks: [...checks, { name: name("b1"), kind: "element.visible", targetId: "nope.target" }], postconditionNames: [...b.registry.postconditionNames, name("b1")] } })],
    ["a check of an unknown route", (b: ManagedBundle) => ({ ...b, registry: { ...b.registry, checks: [{ name: name("a1"), kind: "route.equals", route: "unknown" }, ...checks.slice(1)] } })],
    ["an expected value of 121 characters", (b: ManagedBundle) => ({ ...b, registry: { ...b.registry, checks: [checks[0], checks[1], { ...checks[2], expected: "x".repeat(121) }] } })],
    ["an empty expected value", (b: ManagedBundle) => ({ ...b, registry: { ...b.registry, checks: [checks[0], checks[1], { ...checks[2], expected: "" }] } })],
    ["a control character in an expected value", (b: ManagedBundle) => ({ ...b, registry: { ...b.registry, checks: [checks[0], checks[1], { ...checks[2], expected: "a\u0000b" }] } })],
    ["an attribute outside the allow-list", (b: ManagedBundle) => ({ ...b, registry: { ...b.registry, checks: [...checks, { name: name("b2"), kind: "element.attribute.equals", targetId: "profile.save", attribute: "onclick", expected: "x" }], postconditionNames: [...b.registry.postconditionNames, name("b2")] } })],
    ["an attribute expected value of 41 characters", (b: ManagedBundle) => ({ ...b, registry: { ...b.registry, checks: [...checks, { name: name("b3"), kind: "element.attribute.equals", targetId: "profile.save", attribute: "aria-expanded", expected: "x".repeat(41) }], postconditionNames: [...b.registry.postconditionNames, name("b3")] } })],
    ["a value check on a button", (b: ManagedBundle) => ({ ...b, registry: { ...b.registry, checks: [...checks, { name: name("b4"), kind: "element.value.equals", targetId: "profile.save", expected: "x" }], postconditionNames: [...b.registry.postconditionNames, name("b4")] } })],
    ["a duplicated postcondition name", (b: ManagedBundle) => ({ ...b, registry: { ...b.registry, postconditionNames: [...b.registry.postconditionNames, "route.home"] } })],
    ["a postcondition name without a check", (b: ManagedBundle) => ({ ...b, registry: { ...b.registry, postconditionNames: [...b.registry.postconditionNames, name("c1")] } })],
    ["a check without its postcondition name", (b: ManagedBundle) => ({ ...b, registry: { ...b.registry, postconditionNames: b.registry.postconditionNames.slice(0, 4) } })],
    ["101 checks", (b: ManagedBundle) => { const many = Array.from({ length: 101 }, (_, i) => ({ name: name(i.toString(16)), kind: "route.equals", route: "home" })); return { ...b, registry: { ...b.registry, checks: many, postconditionNames: [...b.registry.routes.map(r => `route.${r}`), ...many.map(c => c.name)] } }; }],
    ["a duplicate marker", (b: ManagedBundle) => ({ ...b, registry: { ...b.registry, elements: b.registry.elements.map(item => (item.id === "profile.save" ? { ...item, marker: "profile.nameField" } : item)) } })],
    ["a marker that is not a valid id", (b: ManagedBundle) => ({ ...b, registry: { ...b.registry, elements: b.registry.elements.map(item => (item.id === "profile.save" ? { ...item, marker: "x y" } : item)) } })],
    ["a duplicate element id", (b: ManagedBundle) => ({ ...b, registry: { ...b.registry, elements: [...b.registry.elements, b.registry.elements[0]] } })],
    ["a text element with a click operation", (b: ManagedBundle) => ({ ...b, registry: { ...b.registry, elements: b.registry.elements.map(item => (item.role === "text" ? { ...item, operations: ["highlight", "click"] } : item)) } })],
    ["a version of 0", (b: ManagedBundle) => ({ ...b, version: 0 })],
    ["a non-integer version", (b: ManagedBundle) => ({ ...b, version: 1.5 })],
    ["a verify name that is neither route.* nor check.v*", (b: ManagedBundle) => ({ ...b, definition: { ...b.definition, steps: [{ ...b.definition.steps[0], verify: "orders.done" }, ...b.definition.steps.slice(1)] } })],
  ])("refuses %s", (_label, change) => { expect(ok(change(make()))).toBe(false); });
  it("refuses a step whose verify names a check that does not exist (the catalog validates the MAPPED definition)", () => {
    const bundle = make();
    const result = mountManagedRuntime({ window, bundle: { ...bundle, definition: { ...bundle.definition, steps: [{ ...bundle.definition.steps[0]!, verify: name("ffff") } as never, ...bundle.definition.steps.slice(1)] } }, onStatus: () => undefined });
    expect(result.ok).toBe(false);
  });
  it.each(["/", "/a", "/a/b.c-d_e~f", "/users/123"])("history page %s is valid", page => { expect(historyPageOf(page)).toBe(true); });
  it.each(["", "a", "/a/", "//", "/a//b", "/a?b", "/a#b", "/é", "/a%2fb", "/a b", "/" + "a".repeat(200)])("history page %j is not valid", page => { expect(historyPageOf(page)).toBe(false); });
});

describe("run diagnostics message bounds", () => {
  it("accepts the documented shape and nothing else", () => {
    const base = { type: "dap-run-status", version: 1 } as const;
    expect(parseStatus({ ...base, status: "FAILED", stepIndex: 1, stepCount: 4, failure: { code: "target_unavailable", targetId: "profile.save" } })).toEqual({ status: "FAILED", stepIndex: 1, stepCount: 4, failure: { code: "target_unavailable", targetId: "profile.save" } });
    expect(parseStatus({ ...base, status: "FAILED", failure: { code: "route_mismatch", expectedRoute: "profile", currentRoute: "home", check: name("a1") } })).not.toBeNull();
    expect(parseStatus({ ...base, status: "CANCELLED", failure: { code: "cancelled" } })).not.toBeNull();
    for (const bad of [
      { stepIndex: -1 }, { stepIndex: 24 }, { stepCount: 0 }, { stepCount: 25 }, { stepIndex: 1.5 }, { stepIndex: 3, stepCount: 3 }, { stepIndex: "1" },
      { failure: { code: "boom" } }, { failure: {} }, { failure: { code: "invalid", extra: 1 } }, { failure: { code: "invalid", targetId: "not an id" } }, { failure: { code: "invalid", currentRoute: "Bad Route" } },
      { failure: { code: "invalid", check: "x".repeat(81) } }, { failure: { code: "invalid", text: "page content" } }, { failure: "invalid" }, { extra: 1 },
    ]) expect(parseStatus({ ...base, status: "FAILED", ...bad }), JSON.stringify(bad)).toBeNull();
  });
});

describe("stylesheet", () => {
  it("is composed once, scoped to the embed's own elements, with no import, url or inline-style construct", () => {
    const css = composeEmbedStylesheet(":root { --a: 1; }", ".dap-result .x{} .result-actions { a: b } .guides-card { c: d }", ".dap-launcher { e: f }");
    expect(css).toBe(":is(.dap-guide-card, .dap-guide-scrim, .dap-guide-ring, .dap-result, .dap-launcher, .dap-launcher-panel) { --a: 1; }.dap-result .x{} .dap-result .result-actions { a: b } .dap-launcher { e: f }");
  });
});
