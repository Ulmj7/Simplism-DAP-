/** The Targets page (S3/S9): table, filters, detail, status changes, page checks and the repair flow, against a fake client. */
import { createSemanticRegistry } from "@dap/walkthrough";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ApplicationView } from "./applications.js";
import type { AdminClient, AdminResult } from "./client.js";
import { targetsPage } from "./pages/targets.js";
import { focusApplication } from "./session.js";
import type { StudioCommand, StudioReply } from "./studio-client.js";
import type { TargetDetail, TargetView } from "./targets.js";

const stamp = "2026-11-23T10:00:00.000Z";
const APP: ApplicationView = { id: "app-0123456789ab", name: "Profile", origin: "http://127.0.0.1:5188", allowedOrigins: ["http://127.0.0.1:5188"], environment: "test", registryId: "studio-managed", enabled: true, updatedAt: stamp, source: "studio-managed" } as ApplicationView;
const BUILT: ApplicationView = { ...APP, id: "app-0123456789ac", name: "Reference", registryId: "reference", source: "built-in" } as ApplicationView;
const OFF: ApplicationView = { ...APP, id: "app-0123456789ad", name: "Paused", enabled: false } as ApplicationView;
const target = (over: Partial<TargetView> = {}): TargetView => ({
  id: "profile.save", marker: "profile.save", route: "profile", page: "/profile", role: "button", label: "Save", description: "Saves the profile", operations: ["highlight", "click"], privacy: "public",
  status: "active", health: "unverified", healthCheckedAt: null, revision: 1, references: { drafts: 1, published: 1 }, updatedAt: stamp, ...over,
});
const TARGETS = [target(), target({ id: "profile.displayName", marker: "profile.displayName", role: "textbox", label: "Display name", operations: ["highlight", "input"], health: "broken", references: { drafts: 0, published: 0 } }),
  target({ id: "settings.advancedToggle", marker: "settings.advancedToggle", route: "settings", page: "/settings", label: "Advanced", health: "healthy", status: "disabled", references: { drafts: 0, published: 0 } })];
const listOf = (targets: readonly TargetView[]) => ({ targets, routes: [{ route: "profile", page: "/profile" }, { route: "settings", page: "/settings" }], limits: { maxTargets: 200, maxRoutes: 20 } });
const detailOf = (base: TargetView): TargetDetail => ({ ...base, usage: { drafts: [{ id: "wt-0123456789ab", title: "Change name" }], published: [{ id: "wt-0123456789ac", title: "Onboarding", version: 2 }] },
  changes: [{ revision: 2, changedAt: stamp, changedBy: "maintainer", before: { marker: "profile.old" }, after: { marker: "profile.save", role: "button" } }] });
const ok = <T,>(value: T): AdminResult<T> => ({ kind: "ok", value });
const settle = async () => { for (let i = 0; i < 6; i += 1) await Promise.resolve(); await new Promise(resolve => setTimeout(resolve, 0)); };

interface Host { appsResult?: AdminResult<never>; targets: TargetView[]; studio: (command: StudioCommand) => AdminResult<StudioReply> | Promise<AdminResult<StudioReply>>; apps: ApplicationView[] }
const aborts: AbortController[] = [];
function mount(host: Partial<Host> = {}) {
  const state: Host = { targets: [...TARGETS], studio: command => { throw new Error(`unexpected ${command.action}`); }, apps: [APP, BUILT, OFF], ...host };
  const commands: StudioCommand[] = [];
  const statusCalls: [string, string, string][] = [];
  const client = {
    applications: vi.fn(async () => state.appsResult ?? ok({ applications: state.apps, registries: [] })),
    applicationRegistry: vi.fn(async () => ok({ routes: ["home"], elements: [{ id: "nav.home", route: "home", role: "link", label: "Home", description: "Home link", operations: ["highlight", "click"], privacy: "public" }], postconditionNames: [], previewable: true, source: "built-in", pages: {}, previewMode: "in-app", registry: createSemanticRegistry({ routes: ["home"], elements: [] }) })),
    targets: vi.fn(async () => ok(listOf(state.targets))),
    targetDetail: vi.fn(async (_app: string, id: string) => { const found = state.targets.find(item => item.id === id); return found ? ok(detailOf(found)) : { kind: "failed" as const }; }),
    setTargetStatus: vi.fn(async (app: string, id: string, status: "active" | "disabled") => { statusCalls.push([app, id, status]); state.targets = state.targets.map(item => (item.id === id ? { ...item, status } : item)); return ok(state.targets.find(item => item.id === id)!); }),
    studio: vi.fn(async (command: StudioCommand) => { commands.push(command); return state.studio(command); }),
  } as unknown as AdminClient;
  const abort = new AbortController();
  aborts.push(abort);
  const navigate = vi.fn();
  const page = targetsPage({ client, registry: createSemanticRegistry({ routes: [], elements: [] }), signal: abort.signal, navigate, preview: vi.fn(), refresh: vi.fn() });
  document.body.replaceChildren(page);
  return { page, client, state, commands, statusCalls, navigate };
}
afterEach(() => { for (const abort of aborts.splice(0)) abort.abort(); document.body.replaceChildren(); focusApplication(undefined); });

const $ = <T extends HTMLElement>(selector: string, root: ParentNode = document) => root.querySelector<T>(selector)!;
const buttonNamed = (name: string) => [...document.querySelectorAll<HTMLButtonElement>("button")].find(item => (item.getAttribute("aria-label") ?? item.textContent) === name)!;
const rows = () => [...document.querySelectorAll("tbody tr")].map(row => [...row.querySelectorAll("td")].map(cell => cell.textContent ?? ""));
const pick = async (selector: string, value: string) => { const select = $<HTMLSelectElement>(selector); select.value = value; select.dispatchEvent(new Event("change", { bubbles: true })); await settle(); };

describe("the table", () => {
  it("selects the first enabled managed application, lists every target with status, health and usage, and labels the page", async () => {
    const { client } = mount();
    await settle();
    expect($("h1").textContent).toBe("Targets");
    expect($<HTMLSelectElement>("#targets-application").value).toBe(APP.id);
    expect(client.targets).toHaveBeenCalledWith(APP.id);
    expect(rows()).toEqual([
      ["profile.save", "Save", "button", "profile", "highlight, click", "public", "Active", "Unverified", "1 drafts, 1 published"],
      ["profile.displayName", "Display name", "textbox", "profile", "highlight, input", "public", "Active", "Broken", "0 drafts, 0 published"],
      ["settings.advancedToggle", "Advanced", "button", "settings", "highlight, click", "public", "Disabled", "Healthy", "0 drafts, 0 published"],
    ]);
    expect(document.body.textContent).toContain("Targets (3/200) · showing 3");
    expect($("nav[aria-label=Breadcrumb]").textContent).toBe("ApplicationsProfileTargets");
    expect($("nav[aria-label=Breadcrumb] [aria-current=page]").textContent).toBe("Targets");
    // Health is text as well as colour.
    expect([...document.querySelectorAll(".badge[data-health]")].map(badge => badge.textContent)).toEqual(["Unverified", "Broken", "Healthy"]);
  });
  it("filters by status, health and route and says how many are shown", async () => {
    mount(); await settle();
    await pick("#targets-filter-status", "disabled");
    expect(rows().map(row => row[0])).toEqual(["settings.advancedToggle"]);
    await pick("#targets-filter-status", "all"); await pick("#targets-filter-health", "broken");
    expect(rows().map(row => row[0])).toEqual(["profile.displayName"]);
    await pick("#targets-filter-health", "all"); await pick("#targets-filter-route", "profile");
    expect(rows().map(row => row[0])).toEqual(["profile.save", "profile.displayName"]);
    expect(document.body.textContent).toContain("showing 2");
    await pick("#targets-filter-health", "healthy");
    expect(document.querySelector("table")).toBeNull();
    expect(document.body.textContent).toContain("No target matches");
    expect($("[role=status].state-empty, .state-empty").textContent).toContain("Change the filters");
  });
  it("an empty registry offers the next step", async () => {
    mount({ targets: [] }); await settle();
    expect(document.body.textContent).toContain("No targets yet");
    expect(document.body.textContent).toContain("register its controls");
  });
  it("a built-in registry is read-only: no filters, no workspace, no actions", async () => {
    focusApplication(BUILT.id);
    const { client } = mount(); await settle();
    expect($<HTMLSelectElement>("#targets-application").value).toBe(BUILT.id);
    expect(client.targets).not.toHaveBeenCalled();
    expect(document.body.textContent).toContain("Built-in registry · read-only");
    expect($(".admin-filters").hidden).toBe(true);
    expect(document.querySelector(".studio-workspace")).toBeNull();
    expect(buttonNamed("Connect Chrome")).toBeUndefined();
  });
  it("shows the shared error state with Retry when the load fails, and loads on Retry", async () => {
    const { client } = mount(); await settle();
    (client.targets as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ kind: "failed" });
    await pick("#targets-application", OFF.id);
    expect($(".state-error").getAttribute("role")).toBe("alert");
    expect($(".state-error").textContent).toContain("could not be loaded");
    $<HTMLButtonElement>(".state-error button").click(); await settle();
    expect(document.querySelector(".state-error")).toBeNull();
    expect(rows()).toHaveLength(3);
  });
  it("no applications: an empty state, no table", async () => {
    mount({ apps: [] }); await settle();
    expect(document.body.textContent).toContain("Enroll an application in Applications first.");
    expect(document.querySelector("table")).toBeNull();
  });
  it("an application list that cannot be read is an alert with Retry, and a denied one says so", async () => {
    const { client, state } = mount({ appsResult: { kind: "denied" } }); await settle();
    expect($(".state-error").getAttribute("role")).toBe("alert");
    expect($(".state-error").textContent).toContain("You do not have access to this page");
    delete state.appsResult;
    $<HTMLButtonElement>(".state-error button").click(); await settle();
    expect(client.applications).toHaveBeenCalledTimes(2);
    expect(rows()).toHaveLength(3);
  });
});

describe("the detail panel", () => {
  it("separates the durable DAP identity from the live browser evidence, and lists usage and change history", async () => {
    mount(); await settle();
    buttonNamed("Details: profile.save").click(); await settle();
    const identity = $("[aria-labelledby=target-identity]"); const evidence = $("[aria-labelledby=target-evidence]");
    expect(identity.querySelector("h3")!.textContent).toBe("Durable DAP identity");
    expect(evidence.querySelector("h3")!.textContent).toBe("Live browser evidence");
    const text = (node: Element) => [...node.querySelectorAll("dt, dd")].map(item => item.textContent);
    expect(text(identity)).toEqual(["Target ID", "profile.save", "Application", "Profile", "Route", "profile", "Page", "/profile", "Role", "button", "Operations", "highlight, click", "Privacy", "public", "Status", "Active", "Revision", "1", "Label", "Save", "Description", "Saves the profile"]);
    expect(text(evidence)).toEqual(["Marker", "profile.save", "Health", "Unverified", "Last checked", "Never checked"]);
    expect(evidence.textContent).toContain("Evidence only");
    expect(document.querySelector("#target-usage")!.parentElement!.textContent).toContain("Change name");
    expect(document.querySelector("#target-usage")!.parentElement!.textContent).toContain("Onboarding · version 2");
    expect(document.querySelector("#target-history")!.parentElement!.textContent).toContain("Revision 2");
    expect(document.activeElement?.textContent).toBe("Target profile.save");
    expect(buttonNamed("Details: profile.save").getAttribute("aria-pressed")).toBe("true");
  });
  it("a detail that cannot be read is an alert with Retry", async () => {
    const { client } = mount(); await settle();
    (client.targetDetail as unknown as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ kind: "failed" });
    buttonNamed("Details: profile.save").click(); await settle();
    expect($(".state-error").textContent).toContain("could not be loaded");
    $<HTMLButtonElement>(".state-error button").click(); await settle();
    expect(document.querySelector("#target-identity")).not.toBeNull();
  });
});

describe("enable and disable", () => {
  it("disabling a referenced target asks first (Escape cancels and returns focus), then sends only the status", async () => {
    const { statusCalls } = mount(); await settle();
    buttonNamed("Details: profile.save").click(); await settle();
    const trigger = buttonNamed("Disable profile.save");
    trigger.click();
    const dialog = $<HTMLDialogElement>("dialog");
    expect(dialog.textContent).toContain("1 drafts and 1 published workflows");
    dialog.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(document.querySelector("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(statusCalls).toEqual([]);
    trigger.click();
    [...$<HTMLDialogElement>("dialog").querySelectorAll("button")].find(item => item.textContent === "Disable target")!.click(); await settle();
    expect(statusCalls).toEqual([[APP.id, "profile.save", "disabled"]]);
    expect(document.body.textContent).toContain("Target profile.save is now disabled.");
    expect(rows()[0]![6]).toBe("Disabled");
  });
  it("an unreferenced target changes at once, and a disabled application cannot enable one", async () => {
    const { statusCalls } = mount(); await settle();
    buttonNamed("Details: profile.displayName").click(); await settle();
    buttonNamed("Disable profile.displayName").click(); await settle();
    expect(statusCalls).toEqual([[APP.id, "profile.displayName", "disabled"]]);
    await pick("#targets-application", OFF.id);
    buttonNamed("Details: settings.advancedToggle").click(); await settle();
    expect(buttonNamed("Enable settings.advancedToggle").disabled).toBe(true);
  });
});

// ---- page check and repair ------------------------------------------------------------------------------------------------
const connected = (applicationId = APP.id): AdminResult<StudioReply> => ok({ kind: "connected", sessionId: "s1", applicationId, application: "Profile", origin: APP.origin, registrySource: "studio-managed", resumed: false });
const snapshot = (elements: unknown[]): AdminResult<StudioReply> => ok({ kind: "snapshot", url: "http://127.0.0.1:5188/profile", route: "profile", page: "/profile", elements, hidden: 0, truncated: false } as StudioReply);
const mismatched = { ref: "@e4", name: "Save", role: "link", route: "profile", status: "mismatched", targetId: "profile.save" };
const registrable = { ref: "@e5", name: "Submit", role: "button", route: "profile", status: "registrable", proposal: { targetId: "profile.submit", role: "button", page: "/profile", route: "profile", routeIsNew: false, suggestedLabel: "Submit", allowedOperations: ["highlight", "click", "focus"], defaultOperations: ["highlight", "click"], privacy: "public" } };
const impact = (compatible = true) => ({ drafts: [{ id: "wt-0123456789ab", title: "Change name" }], published: [{ id: "wt-0123456789ac", title: "Onboarding", version: 2 }], compatible, problems: compatible ? [] : ["Draft \"Change name\" step 2 would have no valid interaction."] });
const fields = (marker = "profile.save", role = "button", label = "Save") => ({ marker, role, operations: ["highlight", "click"], label, description: "Saves the profile" });
async function connectAndInspect() {
  buttonNamed("Connect Chrome").click(); await settle();
  buttonNamed("Inspect current page").click(); await settle();
}

describe("check targets on this page", () => {
  it("runs the host's check, announces the counts and reloads the health badges", async () => {
    const host = mount({ studio: command => {
      if (command.action === "connect") return connected();
      if (command.action === "refresh") return snapshot([]);
      if (command.action === "check") { host.state.targets = host.state.targets.map(item => (item.route === "profile" ? { ...item, health: "healthy" as const, healthCheckedAt: stamp } : item)); return ok({ kind: "checked", page: "/profile", route: "profile", results: [{ targetId: "profile.save", state: "healthy" }, { targetId: "profile.displayName", state: "broken", reason: "not_found" }] }); }
      throw new Error(command.action);
    } });
    await settle();
    expect(buttonNamed("Check targets on this page").disabled).toBe(true);
    buttonNamed("Connect Chrome").click(); await settle();
    expect(buttonNamed("Check targets on this page").disabled).toBe(false);
    buttonNamed("Check targets on this page").click(); await settle();
    expect(host.commands.map(command => command.action)).toEqual(["connect", "check"]);
    expect(document.body.textContent).toContain("Health updated for 2 targets: 1 healthy, 1 broken.");
    expect(rows()[0]![7]).toBe("Healthy");
  });
  it("an empty page says so", async () => {
    mount({ studio: command => (command.action === "connect" ? connected() : ok({ kind: "checked", page: null, route: null, results: [] })) }); await settle();
    buttonNamed("Connect Chrome").click(); await settle();
    buttonNamed("Check targets on this page").click(); await settle();
    expect(document.body.textContent).toContain("No active target is registered for this page.");
  });
});

describe("the repair flow", () => {
  const host = (previewImpact = impact(), after = fields("profile.submit", "button")) => mount({ studio: command => {
    switch (command.action) {
      case "connect": return connected();
      case "refresh": return snapshot([mismatched, registrable]);
      case "repair":
        return command.confirm ? ok({ kind: "repaired", target: target({ marker: after.marker, health: "healthy", healthCheckedAt: stamp, revision: 2 }), impact: previewImpact })
          : ok({ kind: "repairPreview", target: target(), current: fields(), proposed: after, impact: previewImpact });
      case "disconnect": return ok({ kind: "closed" });
      default: throw new Error(command.action);
    }
  } });
  const startRepair = async () => {
    await settle();
    buttonNamed("Details: profile.save").click(); await settle();
    buttonNamed("Repair: profile.save").click();
    await connectAndInspect();
  };
  it("enters repair mode, offers only registrable and mismatched candidates, and never repairs on its own", async () => {
    const h = host();
    await startRepair();
    expect($(".studio-repair-mode").hidden).toBe(false);
    expect($(".studio-repair-mode").textContent).toContain("choose the element that replaces target profile.save");
    expect(document.body.textContent).toContain("Marker of registered target profile.save · role or page differs from the target");
    expect(buttonNamed("Use as replacement: Save")).toBeDefined();
    expect(buttonNamed("Use as replacement: Submit")).toBeDefined();
    expect(buttonNamed("Register target: Submit")).toBeUndefined();
    expect(h.commands.map(command => command.action)).toEqual(["connect", "refresh"]);
  });
  it("dry run: shows old vs new evidence and the impact, then confirms only after the preview; refs stay out of everything but the commands", async () => {
    const h = host();
    await startRepair();
    buttonNamed("Use as replacement: Save").click();
    const form = $<HTMLFormElement>("form.studio-repair");
    expect(form.querySelector("h3")!.textContent).toBe("Repair target profile.save");
    expect(form.textContent).toContain("The durable ID, page, route and privacy never change");
    expect(buttonNamed("Confirm repair").hidden).toBe(true);
    form.dispatchEvent(new Event("submit", { cancelable: true })); await settle();
    const dry = h.commands.at(-1) as Extract<StudioCommand, { action: "repair" }>;
    expect(dry).toMatchObject({ action: "repair", targetId: "profile.save", ref: "@e4", confirm: false, label: "Save", operations: ["highlight", "click"] });
    const table = $("table.studio-compare");
    expect([...table.querySelectorAll("tbody tr")].map(row => [...row.children].map(cell => cell.textContent))).toEqual([
      ["Marker", "profile.save", "profile.submit"], ["Role", "button", "button"], ["Operations", "highlight, click", "highlight, click"], ["Label", "Save", "Save"], ["Description", "Saves the profile", "Saves the profile"]]);
    expect(form.textContent).toContain("Draft workflows that use this target (1)");
    expect(form.textContent).toContain("Onboarding · version 2");
    expect(form.textContent).toContain("Compatible: every workflow stays valid.");
    expect(buttonNamed("Confirm repair").hidden).toBe(false);
    expect(buttonNamed("Confirm repair").disabled).toBe(false);
    expect(h.commands.filter(command => command.action === "repair" && command.confirm)).toHaveLength(0);
    buttonNamed("Confirm repair").click(); await settle();
    expect((h.commands.at(-2) as { confirm?: boolean }).confirm).toBe(true);
    expect(document.body.textContent).toContain("Target profile.save repaired. Health: Healthy.");
    expect(document.querySelector("form.studio-repair")).toBeNull();
    expect($(".studio-repair-mode").hidden).toBe(true);
    // The ref is session evidence: it is in the commands and in the visible row text, and nowhere persistent.
    expect(document.location.href).not.toContain("@e");
    expect(JSON.stringify([window.localStorage, window.sessionStorage])).not.toContain("@e");
    expect(h.client.setTargetStatus).not.toHaveBeenCalled();
  });
  it("an incompatible repair announces the problems and cannot be confirmed", async () => {
    const h = host(impact(false));
    await startRepair();
    buttonNamed("Use as replacement: Submit").click();
    $<HTMLFormElement>("form.studio-repair").dispatchEvent(new Event("submit", { cancelable: true })); await settle();
    expect($("form.studio-repair").textContent).toContain("Not compatible: the repair cannot be applied.");
    expect(buttonNamed("Confirm repair").disabled).toBe(true);
    expect($("[role=alert].studio-alert").textContent).toContain("The repair was not applied");
    expect($("[role=alert].studio-alert").textContent).toContain("step 2 would have no valid interaction");
    buttonNamed("Confirm repair").click(); await settle();
    expect(h.commands.filter(command => command.action === "repair" && command.confirm)).toHaveLength(0);
  });
  it("changing a field after the preview withdraws it: the maintainer must preview again", async () => {
    const h = host();
    await startRepair();
    buttonNamed("Use as replacement: Save").click();
    const form = $<HTMLFormElement>("form.studio-repair");
    form.dispatchEvent(new Event("submit", { cancelable: true })); await settle();
    const label = $<HTMLInputElement>("input[id$=repair-label]");
    label.value = "Save changes"; label.dispatchEvent(new Event("input", { bubbles: true }));
    expect(buttonNamed("Confirm repair").hidden).toBe(true);
    expect(document.querySelector("table.studio-compare")).toBeNull();
    form.dispatchEvent(new Event("submit", { cancelable: true })); await settle();
    expect((h.commands.at(-1) as { label?: string }).label).toBe("Save changes");
  });
  it("validates the label before asking the host", async () => {
    const h = host();
    await startRepair();
    buttonNamed("Use as replacement: Save").click();
    const label = $<HTMLInputElement>("input[id$=repair-label]");
    label.value = "<b>x</b>";
    $<HTMLFormElement>("form.studio-repair").dispatchEvent(new Event("submit", { cancelable: true })); await settle();
    expect(label.getAttribute("aria-invalid")).toBe("true");
    expect(document.activeElement).toBe(label);
    expect(h.commands.some(command => command.action === "repair")).toBe(false);
  });
  it("Cancel and Escape close the panel and return focus to the row action", async () => {
    host();
    await startRepair();
    const trigger = buttonNamed("Use as replacement: Save");
    trigger.click();
    buttonNamed("Cancel repair").click();
    expect(document.querySelector("form.studio-repair")).toBeNull();
    expect(document.activeElement).toBe(trigger);
    trigger.click();
    $("form.studio-repair").dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(document.querySelector("form.studio-repair")).toBeNull();
  });
  it.each([
    ["REPAIR_ROUTE_MISMATCH", "That element is on another page than the target"], ["MARKER_IN_USE", "That marker already belongs to another target"], ["TARGET_NOT_REGISTRABLE", "can no longer be registered"],
    ["REF_NOT_FOUND", "The element changed"], ["TARGET_NOT_FOUND", "This target no longer exists"], ["BROWSER_BUSY", "already active"], ["INVALID_REQUEST", "could not use that request"],
  ])("%s is announced with a fixed sentence in the alert region", async (code, sentence) => {
    const h = mount({ studio: command => {
      if (command.action === "connect") return connected();
      if (command.action === "refresh") return snapshot([mismatched]);
      return { kind: "browser-error", code } as AdminResult<StudioReply>;
    } });
    await settle();
    buttonNamed("Details: profile.save").click(); await settle();
    buttonNamed("Repair: profile.save").click();
    await connectAndInspect();
    buttonNamed("Use as replacement: Save").click();
    $<HTMLFormElement>("form.studio-repair").dispatchEvent(new Event("submit", { cancelable: true })); await settle();
    expect($("[role=alert].studio-alert").textContent).toContain(sentence);
    expect(h.client.setTargetStatus).not.toHaveBeenCalled();
  });
  it("REPAIR_INCOMPATIBLE on confirm lists the host's problems and keeps the panel", async () => {
    const h = mount({ studio: command => {
      if (command.action === "connect") return connected();
      if (command.action === "refresh") return snapshot([mismatched]);
      return (command as { confirm?: boolean }).confirm ? { kind: "browser-error", code: "REPAIR_INCOMPATIBLE", issues: ["Published \"Onboarding\" version 2 would no longer validate."] } as AdminResult<StudioReply>
        : ok({ kind: "repairPreview", target: target(), current: fields(), proposed: fields("profile.save", "link"), impact: impact() });
    } });
    await settle();
    buttonNamed("Details: profile.save").click(); await settle();
    buttonNamed("Repair: profile.save").click();
    await connectAndInspect();
    buttonNamed("Use as replacement: Save").click();
    $<HTMLFormElement>("form.studio-repair").dispatchEvent(new Event("submit", { cancelable: true })); await settle();
    buttonNamed("Confirm repair").click(); await settle();
    expect($("[role=alert].studio-alert").textContent).toContain("Published \"Onboarding\" version 2 would no longer validate.");
    expect(document.querySelector("form.studio-repair")).not.toBeNull();
    void h;
  });
  it("Repair is only available for an active target of an enabled application", async () => {
    mount(); await settle();
    buttonNamed("Details: settings.advancedToggle").click(); await settle();
    expect(buttonNamed("Repair: settings.advancedToggle").disabled).toBe(true);
    buttonNamed("Details: profile.save").click(); await settle();
    expect(buttonNamed("Repair: profile.save").disabled).toBe(false);
  });
});

// ---- tab order ---------------------------------------------------------------------------------------------------------------
const tabbable = (root: ParentNode) => [...root.querySelectorAll<HTMLElement>("a[href], button, input, select, textarea, [tabindex]")]
  .filter(node => !node.hasAttribute("disabled") && !node.hidden && !node.closest("[hidden]") && node.getAttribute("tabindex") !== "-1" && !(node as HTMLInputElement).readOnly)
  .map(node => node.getAttribute("aria-label") ?? (node as HTMLInputElement).labels?.[0]?.textContent?.trim() ?? node.textContent);
describe("tab order", () => {
  it("page: breadcrumb links, application, the three filters, then the row buttons, then the browser workspace", async () => {
    mount(); await settle();
    expect(tabbable(document)).toEqual(["Applications", "Application", "Status", "Health", "Route",
      "Details: profile.save", "Details: profile.displayName", "Details: settings.advancedToggle", "Connect Chrome"]);
  });
  it("detail: the row buttons, then the detail actions, then the workspace (the detail heading takes programmatic focus only)", async () => {
    mount(); await settle();
    buttonNamed("Details: profile.save").click(); await settle();
    expect(tabbable(document).slice(5)).toEqual(["Details: profile.save", "Details: profile.displayName", "Details: settings.advancedToggle", "Disable profile.save", "Repair: profile.save", "Connect Chrome"]);
  });
  it("repair panel: operations, label, description, then Preview and Cancel", async () => {
    host2();
    await settle();
    buttonNamed("Details: profile.save").click(); await settle();
    buttonNamed("Repair: profile.save").click(); await connectAndInspect();
    buttonNamed("Use as replacement: Save").click();
    const form = $("form.studio-repair");
    // The heading is focused by script; the highlight operation is always on and disabled, so the tab stops are the two optional operations, both fields and the buttons.
    expect(tabbable(form)).toEqual(["Click", "Focus", "Label", "Description", "Preview repair", "Cancel repair"]);
  });
  function host2() { return mount({ studio: command => (command.action === "connect" ? connected() : command.action === "refresh" ? snapshot([mismatched]) : ok({ kind: "closed" })) }); }
});

describe("layout rules", () => {
  it("the new styles use tokens and relative sizes only: no fixed pixel widths on the page, table, grids or panels", async () => {
    const { readFileSync } = await import("node:fs");
    const css = readFileSync("apps/reference-web/src/styles/app.css", "utf8");
    const added = css.slice(css.indexOf("Studio completion: breadcrumbs"));
    expect(added).not.toMatch(/\b(?:width|min-width|max-width)\s*:\s*\d+px/u);
    expect(added).toMatch(/\.detail-columns \{[^}]*minmax\(min\(100%, 18rem\), 1fr\)/u);
    expect(added).toMatch(/\.studio-compare \{[^}]*table-layout: fixed/u);
    expect(added).not.toMatch(/#[0-9a-fA-F]{3,8}\b/u);
  });
});
