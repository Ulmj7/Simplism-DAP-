/** The Application Manager (S2/S9): list, overview, runtime delivery, routing lock and navigation, against a fake client. */
import { createSemanticRegistry } from "@dap/walkthrough";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseOverview } from "./applications.js";
import type { ApplicationInput, ApplicationView } from "./applications.js";
import type { AdminClient, AdminResult } from "./client.js";
import { applicationsPage, cspExample, embedSnippet } from "./pages/applications.js";
import { getEditSession, getFocusedApplication, focusApplication, setEditSession } from "./session.js";

const stamp = "2026-11-23T10:00:00.000Z";
const KEY = `rk-${"1".repeat(32)}-${"a".repeat(32)}`;
const view = (over: Partial<ApplicationView> = {}): ApplicationView => ({
  id: "app-0123456789ab", name: "Profile", origin: "http://127.0.0.1:5188", allowedOrigins: ["http://127.0.0.1:5188"], environment: "test", registryId: "studio-managed", source: "studio-managed", enabled: true,
  updatedAt: stamp, routing: "history", runtimeAccess: true, runtimeKey: KEY, counts: { targets: 3, drafts: 2, published: 1 }, ...over,
});
const BUILT = view({ id: "app-0123456789ac", name: "Reference", registryId: "reference", source: "built-in", routing: "hash", runtimeAccess: false, runtimeKey: null, counts: { targets: 0, drafts: 0, published: 0 } });
const PLAIN = view({ id: "app-0123456789ad", name: "Orders", routing: "hash", runtimeAccess: false, runtimeKey: null, counts: { targets: 0, drafts: 0, published: 0 }, enabled: false });
const ok = <T,>(value: T): AdminResult<T> => ({ kind: "ok", value });
const settle = async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve(); await new Promise(resolve => setTimeout(resolve, 0)); };
const overviewOf = (application: ApplicationView) => ({ application, targets: { total: application.counts.targets, active: application.counts.targets > 0 ? application.counts.targets - 1 : 0, disabled: application.counts.targets > 0 ? 1 : 0, healthy: application.counts.targets > 0 ? 1 : 0, unverified: application.counts.targets > 1 ? 1 : 0, broken: application.counts.targets > 2 ? 1 : 0 }, workflows: { draft: application.counts.drafts, published: application.counts.published } });

const aborts: AbortController[] = [];
function mount(apps: ApplicationView[] = [view(), BUILT, PLAIN]) {
  const state = { apps: [...apps], writes: [] as { kind: string; id?: string; input?: ApplicationInput }[], failure: undefined as AdminResult<ApplicationView> | undefined };
  const client = {
    applications: vi.fn(async () => ok({ applications: state.apps, registries: [{ id: "studio-managed", label: "Studio-managed", source: "studio-managed" as const }, { id: "reference", label: "Reference", source: "built-in" as const }] })),
    overview: vi.fn(async (id: string) => { const found = state.apps.find(item => item.id === id); return found ? ok(overviewOf(found)) : { kind: "failed" as const }; }),
    createApplication: vi.fn(async (input: ApplicationInput) => { state.writes.push({ kind: "create", input }); return state.failure ?? ok(view({ ...input, id: "app-0123456789ae", source: input.registryId === "studio-managed" ? "studio-managed" : "built-in", runtimeKey: null, counts: { targets: 0, drafts: 0, published: 0 } })); }),
    updateApplication: vi.fn(async (id: string, input: ApplicationInput) => { state.writes.push({ kind: "update", id, input }); return state.failure ?? ok(view({ ...input, id })); }),
    setApplicationEnabled: vi.fn(async (id: string, enabled: boolean) => { state.writes.push({ kind: enabled ? "enable" : "disable", id }); state.apps = state.apps.map(item => (item.id === id ? { ...item, enabled } : item)); return ok(state.apps.find(item => item.id === id)!); }),
    rotateRuntimeKey: vi.fn(async (id: string) => { state.writes.push({ kind: "rotate", id }); const next = `rk-${"2".repeat(32)}-${"b".repeat(32)}`; state.apps = state.apps.map(item => (item.id === id ? { ...item, runtimeKey: next } : item)); return state.failure ?? ok(state.apps.find(item => item.id === id)!); }),
  } as unknown as AdminClient;
  const abort = new AbortController();
  aborts.push(abort);
  const navigate = vi.fn();
  const page = applicationsPage({ client, registry: createSemanticRegistry({ routes: [], elements: [] }), signal: abort.signal, navigate, preview: vi.fn(), refresh: vi.fn() });
  document.body.replaceChildren(page);
  return { page, client, state, navigate };
}
afterEach(() => { for (const abort of aborts.splice(0)) abort.abort(); document.body.replaceChildren(); focusApplication(undefined); setEditSession(undefined); vi.restoreAllMocks(); });
const $ = <T extends HTMLElement>(selector: string) => document.querySelector<T>(selector)!;
const buttonNamed = (name: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find(item => (item.getAttribute("aria-label") ?? item.textContent) === name)!;
const click = async (name: string) => { buttonNamed(name).click(); await settle(); };
const rows = () => [...document.querySelectorAll("tbody tr")].map(row => [...row.querySelectorAll("td")].map(cell => cell.textContent ?? ""));

describe("the list", () => {
  it("shows status badge, environment, routing, registry source and the three counts for every application", async () => {
    mount(); await settle();
    expect(rows()).toEqual([
      ["Profile Enabled", "test", "history", "Studio-managed", "3", "2", "1", "OverviewEditDisableOpen Studio"],
      ["Reference Enabled", "test", "hash", "Built-in", "0", "0", "0", "OverviewEditDisableOpen Studio"],
      ["Orders Disabled", "test", "hash", "Studio-managed", "0", "0", "0", "OverviewEditEnableOpen Studio"],
    ]);
    expect([...document.querySelectorAll("th")].map(item => item.textContent)).toEqual(["Name", "Environment", "Routing", "Registry", "Targets", "Drafts", "Published", "Actions"]);
    expect([...document.querySelectorAll(".badge")].map(badge => badge.getAttribute("data-state"))).toEqual(["enabled", "enabled", "disabled"]);
    expect(buttonNamed("Open Studio: Orders").disabled).toBe(true);
  });
  it("an empty list says what to do next", async () => {
    mount([]); await settle();
    expect($(".state-empty").textContent).toContain("No applications are enrolled yet.");
    expect(document.querySelector("table")).toBeNull();
  });
  it("a failed load is an alert with Retry that reloads, and a denial has no Retry", async () => {
    const calls: AdminResult<never>[] = [{ kind: "failed" }, { kind: "denied" }];
    const client = { applications: vi.fn(async () => calls.shift() ?? ok({ applications: [view()], registries: [] })) } as unknown as AdminClient;
    const abort = new AbortController(); aborts.push(abort);
    document.body.replaceChildren(applicationsPage({ client, registry: createSemanticRegistry({ routes: [], elements: [] }), signal: abort.signal, navigate: vi.fn(), preview: vi.fn(), refresh: vi.fn() }));
    await settle();
    expect($(".state-error").getAttribute("role")).toBe("alert");
    $<HTMLButtonElement>(".state-error button").click(); await settle();
    expect($(".state-error").textContent).toContain("You do not have access");
    expect(document.querySelector(".state-error button")).toBeNull();
  });
});

describe("the overview", () => {
  it("lists every fact of S2: application, status, environment, origin, allowed origins, routing, registry, targets with health, workflows and runtime delivery", async () => {
    mount(); await settle();
    await click("Overview: Profile");
    const grid = $(".overview-grid");
    expect([...grid.querySelectorAll("dt")].map(item => item.textContent)).toEqual(["Application", "Status", "Environment", "Origin", "Allowed origins", "Routing", "Registry", "Targets", "Draft workflows", "Published workflows", "Runtime delivery"]);
    const text = [...grid.querySelectorAll("dd")].map(item => item.textContent);
    expect(text.slice(0, 10)).toEqual(["Profile", "Enabled", "test", "http://127.0.0.1:5188", "http://127.0.0.1:5188", "history", "Studio-managed", "3 (1 healthy, 1 unverified, 1 broken; 2 active, 1 disabled)", "2", "1"]);
    expect(document.activeElement?.textContent).toBe("Profile · overview");
    expect(grid.textContent).toContain(KEY);
  });
  it("runtime delivery: key, copyable embed line with the Studio origin and a CSP example in a disclosure", async () => {
    mount(); await settle();
    await click("Overview: Profile");
    const origin = window.location.origin;
    expect($("code.snippet[aria-label='Embed line']").textContent).toBe(`<script src="${origin}/dap-embed.js" data-dap-key="${KEY}"></script>`);
    expect(embedSnippet(origin, KEY)).toBe($("code.snippet[aria-label='Embed line']").textContent);
    const details = $<HTMLDetailsElement>("details");
    expect(details.open).toBe(false);
    expect(details.querySelector("summary")!.textContent).toBe("Content-Security-Policy example");
    expect(details.textContent).toContain(cspExample(origin));
    expect(cspExample("https://dap.example")).toBe("Content-Security-Policy: default-src 'none'; script-src 'self' https://dap.example; style-src 'self' https://dap.example; connect-src https://dap.example; img-src 'self'; base-uri 'none'; form-action 'none'");
    expect(document.body.textContent).toContain("The key is a public identifier");
  });
  it("Copy writes the embed line to the clipboard and announces it; without a clipboard it says what to do", async () => {
    mount(); await settle();
    await click("Overview: Profile");
    const write = vi.fn(async () => undefined);
    Object.defineProperty(window.navigator, "clipboard", { value: { writeText: write }, configurable: true });
    await click("Copy embed line: Profile");
    expect(write).toHaveBeenCalledWith(`<script src="${window.location.origin}/dap-embed.js" data-dap-key="${KEY}"></script>`);
    expect($("[role=status]").textContent).toBe("Embed line copied.");
    Object.defineProperty(window.navigator, "clipboard", { value: undefined, configurable: true });
    await click("Copy embed line: Profile");
    expect($("[role=status]").textContent).toBe("Select the embed line and copy it.");
  });
  it("Rotate asks first (Escape cancels and returns focus), then rotates, announces and shows the new key", async () => {
    const { state } = mount(); await settle();
    await click("Overview: Profile");
    const trigger = buttonNamed("Rotate runtime key: Profile");
    trigger.click();
    const dialog = $<HTMLDialogElement>("dialog");
    expect(dialog.textContent).toContain("The current key stops working at once");
    dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(document.querySelector("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(state.writes).toEqual([]);
    trigger.click();
    [...$<HTMLDialogElement>("dialog").querySelectorAll("button")].find(item => item.textContent === "Rotate key")!.click(); await settle();
    expect(state.writes).toEqual([{ kind: "rotate", id: "app-0123456789ab" }]);
    expect($("[role=status]").textContent).toContain("Runtime key rotated");
    expect($(".overview-grid").textContent).toContain(`rk-${"2".repeat(32)}-${"b".repeat(32)}`);
    expect($(".overview-grid").textContent).not.toContain(KEY);
  });
  it("a failed rotation says so and keeps the old key", async () => {
    const { state } = mount(); await settle();
    await click("Overview: Profile");
    state.failure = { kind: "failed" };
    buttonNamed("Rotate runtime key: Profile").click();
    [...$<HTMLDialogElement>("dialog").querySelectorAll("button")].find(item => item.textContent === "Rotate key")!.click(); await settle();
    expect($("[role=alert]").textContent).toBe("This change could not be saved. Please wait a moment and try again.");
    expect($(".overview-grid").textContent).toContain(KEY);
  });
  it("runtime access off: no key, no embed line; built-in: not available", async () => {
    mount(); await settle();
    await click("Overview: Orders");
    expect(document.querySelector("code.snippet")).toBeNull();
    expect($(".overview-runtime").textContent).toContain("Off. Switch it on in Edit");
    await click("Overview: Reference");
    expect($(".overview-runtime").textContent).toContain("Not available for a built-in application.");
    expect($(".overview-grid").textContent).toContain("Built-in registry");
  });
  it("Open Studio starts a new draft for the application; Manage Targets and Manage Workflows remember it and navigate", async () => {
    const { navigate } = mount(); await settle();
    await click("Overview: Profile");
    await click("Open Studio: Profile");
    expect(getEditSession()?.applicationId).toBe("app-0123456789ab");
    expect(navigate).toHaveBeenLastCalledWith("editor");
    await click("Manage Targets: Profile");
    expect(getFocusedApplication()).toBe("app-0123456789ab");
    expect(navigate).toHaveBeenLastCalledWith("targets");
    focusApplication(undefined);
    await click("Manage Workflows: Profile");
    expect(getFocusedApplication()).toBe("app-0123456789ab");
    expect(navigate).toHaveBeenLastCalledWith("walkthroughs");
  });
  it("Open Studio is off for a disabled application, in the list and in the overview", async () => {
    mount(); await settle();
    await click("Overview: Orders");
    expect(buttonNamed("Open Studio: Orders").disabled).toBe(true);
  });
  it("a failed overview is an alert with Retry", async () => {
    const { client } = mount(); await settle();
    (client.overview as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ kind: "failed" });
    await click("Overview: Profile");
    expect($(".state-error").textContent).toContain("could not be loaded");
    $<HTMLButtonElement>(".state-error button").click(); await settle();
    expect(document.querySelector(".overview-grid")).not.toBeNull();
  });
});

describe("enroll and edit with routing and runtime access", () => {
  const set = (selector: string, value: string) => { const control = $<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>(selector); control.value = value; control.dispatchEvent(new Event("input", { bubbles: true })); control.dispatchEvent(new Event("change", { bubbles: true })); };
  it("enrolls with the seven fields: hash by default, runtime access off", async () => {
    const { state } = mount(); await settle();
    set("#application-name", "Shop"); set("#application-origin", "http://127.0.0.1:5190"); set("#application-allowed", "http://127.0.0.1:5190"); set("#application-registry", "studio-managed");
    expect($<HTMLSelectElement>("#application-routing").value).toBe("hash");
    expect($<HTMLInputElement>("#application-runtime").checked).toBe(false);
    $<HTMLFormElement>("form").dispatchEvent(new Event("submit", { cancelable: true })); await settle();
    expect(state.writes).toEqual([{ kind: "create", input: { name: "Shop", origin: "http://127.0.0.1:5190", allowedOrigins: ["http://127.0.0.1:5190"], environment: "development", registryId: "studio-managed", routing: "hash", runtimeAccess: false } }]);
  });
  it("chooses history routing and runtime access for a managed application", async () => {
    const { state } = mount(); await settle();
    set("#application-name", "Shop"); set("#application-origin", "http://127.0.0.1:5190"); set("#application-allowed", "http://127.0.0.1:5190"); set("#application-registry", "studio-managed");
    set("#application-routing", "history"); $<HTMLInputElement>("#application-runtime").checked = true;
    $<HTMLFormElement>("form").dispatchEvent(new Event("submit", { cancelable: true })); await settle();
    expect(state.writes[0]!.input).toMatchObject({ routing: "history", runtimeAccess: true });
  });
  it("a built-in registry forces hash routing and switches runtime access off and disabled", async () => {
    mount(); await settle();
    set("#application-registry", "studio-managed");
    set("#application-routing", "history"); $<HTMLInputElement>("#application-runtime").checked = true;
    set("#application-registry", "reference");
    expect($<HTMLSelectElement>("#application-routing").value).toBe("hash");
    expect($<HTMLSelectElement>("#application-routing").disabled).toBe(true);
    expect($<HTMLInputElement>("#application-runtime").checked).toBe(false);
    expect($<HTMLInputElement>("#application-runtime").disabled).toBe(true);
    expect($("#application-routing-help").textContent).toBe("A built-in registry is hash-routed.");
  });
  it("editing an application with targets locks routing and says why; the body still carries it unchanged", async () => {
    const { state } = mount(); await settle();
    await click("Edit: Profile");
    expect($<HTMLSelectElement>("#application-routing").value).toBe("history");
    expect($<HTMLSelectElement>("#application-routing").disabled).toBe(true);
    expect($("#application-routing-help").textContent).toBe("Routing cannot change once this application has registered routes.");
    expect($("#application-routing").getAttribute("aria-describedby")).toBe("application-routing-help");
    expect($<HTMLInputElement>("#application-runtime").checked).toBe(true);
    $<HTMLFormElement>("form").dispatchEvent(new Event("submit", { cancelable: true })); await settle();
    expect(state.writes[0]).toMatchObject({ kind: "update", id: "app-0123456789ab", input: { routing: "history", runtimeAccess: true } });
  });
  it("an application without routes may change routing; ROUTING_LOCKED from the host is announced with its fixed sentence", async () => {
    const { state } = mount([view({ counts: { targets: 0, drafts: 0, published: 0 } })]); await settle();
    await click("Edit: Profile");
    expect($<HTMLSelectElement>("#application-routing").disabled).toBe(false);
    set("#application-routing", "hash");
    state.failure = { kind: "application", code: "ROUTING_LOCKED" };
    $<HTMLFormElement>("form").dispatchEvent(new Event("submit", { cancelable: true })); await settle();
    expect($("#application-issues").textContent).toBe("Routing cannot change once this application has registered routes.");
    expect($("#application-issues").getAttribute("role")).toBe("alert");
    expect($<HTMLSelectElement>("#application-routing").value).toBe("hash");
  });
  it("turning runtime access on shows no key until the host provides one", async () => {
    mount([view({ runtimeAccess: true, runtimeKey: null })]); await settle();
    await click("Overview: Profile");
    expect(document.querySelector("code.snippet")).toBeNull();
    expect($(".overview-runtime").textContent).toContain("The key is not available yet. Rotate it to create one.");
  });
});

describe("parseOverview", () => {
  const good = () => overviewOf(view());
  it("accepts a consistent overview and refuses anything looser", () => {
    expect(parseOverview(good())).toMatchObject({ targets: { total: 3 }, workflows: { draft: 2, published: 1 } });
    type Loose = { [key: string]: unknown; targets: Record<string, unknown>; workflows?: Record<string, unknown>; application: Record<string, unknown> };
    const change = (mutate: (value: Loose) => void) => { const value = JSON.parse(JSON.stringify(good())) as Loose; mutate(value); return parseOverview(value); };
    expect(change(value => { value.extra = 1; })).toBeNull();
    expect(change(value => { delete value.workflows; })).toBeNull();
    expect(change(value => { value.targets.extra = 1; })).toBeNull();
    expect(change(value => { value.targets.total = 4; })).toBeNull();                       // does not add up and disagrees with the application
    expect(change(value => { value.targets.healthy = 3; })).toBeNull();                     // health split does not add up
    expect(change(value => { value.targets.active = 3; })).toBeNull();                      // status split does not add up
    expect(change(value => { if (value.workflows) value.workflows.draft = 5; })).toBeNull();                     // disagrees with the application's counts
    expect(change(value => { value.targets.broken = -1; })).toBeNull();
    expect(change(value => { value.targets.healthy = 0.5; })).toBeNull();
    expect(change(value => { value.application.routing = "path"; })).toBeNull();
    expect(parseOverview(good(), "app-0123456789ff")).toBeNull();                           // another application than asked for
    expect(parseOverview(good(), "app-0123456789ab")).not.toBeNull();
  });
});

const tabbable = (root: ParentNode) => [...root.querySelectorAll<HTMLElement>("a[href], button, input, select, textarea, summary, [tabindex]")]
  .filter(node => !node.hasAttribute("disabled") && !node.hidden && !node.closest("[hidden]") && node.getAttribute("tabindex") !== "-1")
  .map(node => node.getAttribute("aria-label") ?? (node as HTMLInputElement).labels?.[0]?.textContent?.trim() ?? node.textContent);
describe("tab order", () => {
  it("manager: the row actions in order, then the enrollment form in reading order", async () => {
    mount([view()]); await settle();
    expect(tabbable(document)).toEqual(["Overview: Profile", "Edit: Profile", "Disable: Profile", "Open Studio: Profile", "Name", "Origin", "Allowed origins", "Environment", "Registry", "Enroll application"]);
    // Routing and runtime access are tab stops only for a Studio-managed registry.
    const registry = $<HTMLSelectElement>("#application-registry");
    registry.value = "studio-managed"; registry.dispatchEvent(new Event("change", { bubbles: true }));
    expect(tabbable(document).slice(4)).toEqual(["Name", "Origin", "Allowed origins", "Environment", "Registry", "Routing", "Runtime access", "Enroll application"]);
  });
  it("overview: the facts' actions follow the list; runtime delivery controls come before the page actions", async () => {
    mount([view()]); await settle();
    await click("Overview: Profile");
    const tabs = tabbable(document);
    const start = tabs.indexOf("Copy embed line: Profile");
    expect(tabs.slice(start, start + 6)).toEqual(["Copy embed line: Profile", "Rotate runtime key: Profile", "Content-Security-Policy example", "Open Studio: Profile", "Manage Targets: Profile", "Manage Workflows: Profile"]);
    expect(tabs.slice(0, 4)).toEqual(["Overview: Profile", "Edit: Profile", "Disable: Profile", "Open Studio: Profile"]);
  });
});
