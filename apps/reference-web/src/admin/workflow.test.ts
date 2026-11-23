import type { WalkthroughDef } from "@dap/walkthrough";
import { afterEach, expect, it, vi } from "vitest";
import { boot } from "../browser.js";
import { copy } from "../copy.js";
import type { FetchLike } from "../help/client.js";
import { POSTCONDITION_NAMES } from "../postconditions.js";
import { createDemoRegistry } from "../semantic-ui.js";
import { WALKTHROUGHS } from "../walkthroughs/index.js";
import type { GuideRecord, GuideStatus } from "./client.js";
import { draftToDefinition } from "./draft.js";
import { requestEdit, setEditSession, takeRequestedEdit, writeRole } from "./session.js";

const c = copy.admin;
const savedId = "wt-000000000001";
const publishedId = "wt-000000000002";
const invalidId = "wt-000000000003";
const registry = createDemoRegistry();
const authored = (id: string, title: string): WalkthroughDef => draftToDefinition({
  title, description: "Look around the settings page.", completion: "Tour finished.",
  steps: [{ target: "settings.securityPanel", wait: "ack", text: "Read the Security panel." }],
}, registry, id);
const builtinList = WALKTHROUGHS.map(({ id, title, description }) => ({ id, title, description }));
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const admin = "/api/admin/walkthroughs";
const published = "/api/walkthroughs/published";
// The host half is faked to the frozen contract: one enabled reference application, whose registry is the compiled demo registry.
const appId = "app-000000000001";
const referenceApplication = {
  id: appId, name: "Reference application", origin: "http://127.0.0.1:5173", allowedOrigins: ["http://127.0.0.1:5173"],
  environment: "development", registryId: "reference", source: "built-in", enabled: true, updatedAt: "2026-11-20T00:00:00.000Z", routing: "hash", runtimeAccess: false, runtimeKey: null, counts: { targets: 0, drafts: 0, published: 0 },
};
const referenceRegistry = () => ({
  routes: registry.routes, previewable: true, source: "built-in", pages: {}, previewMode: "in-app", postconditionNames: [...POSTCONDITION_NAMES],
  elements: registry.list().filter(item => item.privacy === "public"),
});
const guide = (id: string, status: GuideStatus, definition: WalkthroughDef, applicationId: string | null = appId): GuideRecord => ({ id, status, applicationId, definition });

function fakeHost(seed: GuideRecord[] = []) {
  const rows = new Map(seed.map(row => [row.id, row]));
  const requests: { path: string; method: string; role: string | null; body: unknown }[] = [];
  const host = {
    rows, requests,
    overrides: new Map<string, () => Response | Promise<Response>>(),
    writes: () => requests.filter(request => request.method !== "GET"),
  };
  const fetch: FetchLike = async (path, init) => {
    const method = init.method!;
    const role = new Headers(init.headers).get("x-demo-role");
    const body: unknown = init.body ? JSON.parse(init.body as string) : null;
    requests.push({ path, method, role, body });
    const override = host.overrides.get(`${method} ${path}`);
    if (override) return override();
    if (path === published) return json({ walkthroughs: [...rows.values()].filter(row => row.status === "published").map(row => row.definition) });
    if (role !== "maintainer") return json({ message: "FAKE-HOST-PRIVATE" }, 403);
    if (path === "/api/admin/analytics" && method === "GET") return json({
      totals: { started: 0, completed: 0, cancelled: 0, completionRate: null }, guides: [],
    });
    if (path === "/api/admin/applications" && method === "GET") return json({ applications: [referenceApplication], registries: [{ id: "reference", label: "Reference application", source: "built-in" }] });
    if (path === `/api/admin/applications/${appId}/registry` && method === "GET") return json(referenceRegistry());
    if (path === admin && method === "GET") return json({
      builtIn: builtinList, authored: [...rows.values()].map(({ id, status, applicationId, definition }) => ({
        id, status, applicationId, title: definition.title, description: definition.description, stepCount: definition.steps.length, updatedAt: "2026-11-20T00:00:00.000Z",
      })),
    });
    if (path === admin && method === "POST") {
      const { applicationId, definition } = body as { applicationId: string; definition: WalkthroughDef };
      const record = guide(savedId, "draft", { ...definition, id: savedId }, applicationId);
      rows.set(savedId, record); return json(record, 201);
    }
    const id = path.split("/")[4]!;
    const stored = rows.get(id);
    if (!stored) return json({}, 404);
    if (method === "GET") return json(stored);
    if (method === "PUT" && stored.status === "published") return json({}, 409);
    const result = method === "PUT" ? { ...stored, definition: (body as { definition: WalkthroughDef }).definition } : { ...stored, status: (body as { status: GuideStatus }).status };
    rows.set(id, result); return json(result);
  };
  return { ...host, fetch };
}

let mounted: Awaited<ReturnType<typeof boot>> | undefined;
afterEach(() => {
  mounted?.destroy(); mounted = undefined; setEditSession(); takeRequestedEdit(); sessionStorage.clear();
  document.body.replaceChildren(); window.history.replaceState(null, "", "#/dashboard"); vi.useRealTimers(); vi.unstubAllGlobals();
});
const turn = () => vi.advanceTimersByTimeAsync(10);
async function setup(route: string, host = fakeHost(), role: "maintainer" | "user" = "maintainer", demoRoleEnabled = true) {
  vi.useFakeTimers();
  window.history.replaceState(null, "", `#/${route}`);
  writeRole(window, role);
  const root = document.createElement("div"); document.body.append(root);
  mounted = await boot(root, { fetch: host.fetch, trustedEventsOnly: false, demoRoleEnabled });
  await turn();
  return { root, host, handle: mounted };
}
function control<T extends HTMLElement>(root: ParentNode, selector: string): T {
  const element = root.querySelector<T>(selector);
  if (!element) throw new Error(`Missing control ${selector}`);
  return element;
}
function button(root: ParentNode, name: string): HTMLButtonElement {
  const found = [...root.querySelectorAll("button")].find(item => (item.getAttribute("aria-label") ?? item.textContent) === name);
  if (!found) throw new Error(`Missing button ${name}`);
  return found;
}
function fill(root: ParentNode, id: string, value: string, event = "input") {
  const input = control<HTMLInputElement>(root, `[id="${id}"]`); input.value = value; input.dispatchEvent(new Event(event, { bubbles: true }));
}
function fillDraft(root: ParentNode) {
  fill(root, "editor-title", "Authored settings tour");
  fill(root, "editor-description", "Find the demo settings.");
  fill(root, "editor-completion", "Tour finished.");
  fill(root, "editor-target", "settings.securityPanel", "change");
  fill(root, "editor-text", "Read the Security panel.");
}
async function navigate(route: "dashboard" | "walkthroughs" | "editor" | "analytics") {
  mounted?.current()?.router.navigate(route); await turn();
}
const rowFor = (root: ParentNode, title: string) => [...root.querySelectorAll("tbody tr")].find(row => row.firstElementChild?.textContent === title)!;
const resultDialog = () => control<HTMLDialogElement>(document, 'dialog[data-ai-ignore][role="dialog"]');

it("lists three read-only built-ins and both authored statuses, with text-only descriptions and client search", async () => {
  const text = '<img src=x onerror="bad()">';
  const host = fakeHost([guide(savedId, "draft", { ...authored(savedId, "A draft"), description: text }), guide(publishedId, "published", authored(publishedId, "Released tour"))]);
  const { root } = await setup("walkthroughs", host);
  expect(root.querySelectorAll("tbody tr")).toHaveLength(5);
  for (const def of WALKTHROUGHS) {
    const row = rowFor(root, def.title);
    expect([...row.querySelectorAll("td")].slice(2, 4).map(cell => cell.textContent)).toEqual([String(def.steps.filter(step => step.kind === "guide").length), c.builtIn]);
    expect([...row.querySelectorAll("button")].map(item => item.textContent)).toEqual([c.preview]);
  }
  expect(rowFor(root, "A draft").textContent).toContain(c.draft);
  expect(rowFor(root, "Released tour").textContent).toContain(c.published);
  expect(rowFor(root, "A draft").textContent).toContain(text);
  expect(root.querySelector("img")).toBeNull();
  expect(root.querySelector('label[for="walkthrough-search"]')?.textContent).toBe(c.search);
  fill(root, "walkthrough-search", "onerror");
  expect(root.querySelectorAll("tbody tr")).toHaveLength(1);
  expect(rowFor(root, "A draft")).toBeDefined();
  fill(root, "walkthrough-search", "no-match");
  expect(root.textContent).toContain(c.empty);
});

it("switches the demo principal, gates navigation on a probe, and hides Help and data on directly visited admin pages", async () => {
  const { root, host, handle } = await setup("dashboard", fakeHost([guide(savedId, "draft", authored(savedId, "Only maintainers see this"))]), "user");
  const userApp = handle.current()!;
  expect(root.querySelector('[href="#/walkthroughs"]')).toBeNull();
  expect(userApp.help.launcher.hidden).toBe(false);
  userApp.help.launcher.click();
  expect(userApp.help.state()).toBe("idle");
  for (const route of ["walkthroughs", "editor", "analytics"] as const) {
    await navigate(route);
    expect(root.textContent).toContain(c.denied);
    expect(root.textContent).not.toContain("Only maintainers see this");
    expect(root.querySelector(".admin-page")?.querySelector("[data-ai-id]")).toBeNull();
    expect(userApp.help.launcher.hidden).toBe(true);
    expect(userApp.help.state()).toBe("closed");
    userApp.help.open(); expect(userApp.help.state()).toBe("closed");
  }
  fill(root, "demo-role", "maintainer", "change"); await turn();
  expect(handle.current()).not.toBe(userApp);
  expect(document.activeElement?.id).toBe("demo-role");
  expect(root.querySelector('nav [href="#/walkthroughs"]')).not.toBeNull();
  expect(root.textContent).toContain(c.usage.empty);
  expect(host.requests.map(request => request.role)).toContain("user");
  expect(host.requests.at(-1)?.role).toBe("maintainer");
  expect(root.querySelector('label[for="demo-role"]')?.textContent).toBe(c.role);
  expect(handle.current()?.registry.routes).toEqual(["dashboard", "profile", "settings"]);
  host.overrides.set(`GET ${admin}`, () => json({ message: "PRIVATE INFORMATION" }, 503));
  await navigate("walkthroughs");
  expect(root.textContent).toContain(c.readFailed);
  expect(root.textContent).not.toContain("PRIVATE INFORMATION");
});

it("creates explicitly, strips the temporary definition id, waits for host success, and adopts the returned id for the next save", async () => {
  const { root, host } = await setup("walkthroughs");
  button(root, c.newGuide).click(); await turn();
  fillDraft(root);
  expect(host.writes()).toEqual([]);
  let finish!: (response: Response) => void;
  host.overrides.set(`POST ${admin}`, () => new Promise(resolve => { finish = resolve; }));
  button(root, c.save).click();
  expect(root.querySelector('[role="status"]')?.textContent).toBe(c.saving);
  const create = host.writes()[0]!;
  expect(create).toMatchObject({ path: admin, method: "POST", role: "maintainer" });
  expect(Object.keys(create.body as object)).toEqual(["applicationId", "definition"]);
  expect(create.body).toMatchObject({ applicationId: appId });
  const { definition } = create.body as { definition: Omit<WalkthroughDef, "id"> };
  expect(definition).not.toHaveProperty("id");
  expect(definition.steps.map(step => step.id)).toEqual(["n1", "s1", "done"]);
  const saved = guide(savedId, "draft", { ...definition, id: savedId });
  await navigate("walkthroughs");
  await navigate("editor");
  expect(root.querySelector('[role="status"]')?.textContent).toBe(c.saving);
  const pendingSave = button(root, c.save);
  expect(pendingSave.disabled).toBe(true);
  pendingSave.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  expect(host.writes()).toHaveLength(1);
  host.rows.set(savedId, saved); finish(json(saved, 201));
  await turn();
  expect(root.querySelector('[role="status"]')?.textContent).toBe(c.saved);
  fill(root, "editor-title", "Updated settings tour");
  expect(host.writes()).toHaveLength(1);
  button(root, c.save).click(); await turn();
  expect(host.writes()[1]).toMatchObject({ method: "PUT", path: `${admin}/${savedId}`, body: { applicationId: appId, definition: { id: savedId, title: "Updated settings tour" } } });
});

it("loads a draft for editing and shows a published record as read-only even when reached from a stale list", async () => {
  const draft = guide(savedId, "draft", authored(savedId, "Editable tour"));
  const host = fakeHost([draft]);
  const { root } = await setup("walkthroughs", host);
  button(root, "Edit: Editable tour").click(); await turn();
  expect(control<HTMLInputElement>(root, '[id="editor-title"]').value).toBe("Editable tour");
  await navigate("walkthroughs");
  host.rows.set(savedId, { ...draft, status: "published" });
  button(root, "Edit: Editable tour").click(); await turn();
  expect(root.textContent).toContain(c.readOnly);
  expect(root.querySelector('[id="editor-title"]')).toBeNull();
  expect(host.writes()).toEqual([]);
});

it("offers only registered target operations and checks, supports step ordering and visibly blocks every invalid action", async () => {
  const { root, host } = await setup("editor");
  const target = control<HTMLSelectElement>(root, '[id="editor-target"]');
  // The picker is driven by the selected application's registry reply, which carries public targets only (a private target is never offered).
  expect([...target.options].slice(1).map(option => option.value)).toEqual(registry.list().filter(item => item.privacy === "public" && item.operations.includes("highlight")).map(item => item.id));
  expect([...target.options].map(option => option.value)).not.toContain("profile.emailInput");
  expect([...target.querySelectorAll("optgroup")].map(group => group.label)).toEqual(["Dashboard", "Profile", "Settings"]);
  expect([...control<HTMLSelectElement>(root, '[id="editor-verify"]').options]).toHaveLength(5);
  expect(root.querySelector('input[type="url"], input[name*="selector"]')).toBeNull();
  expect(root.querySelector('label[for="editor-target"]')?.textContent).toBe(c.target);
  expect(target.getAttribute("aria-invalid")).toBe("true");
  expect(document.getElementById(target.getAttribute("aria-describedby")!)?.textContent).toBe(c.problem.target);
  fillDraft(root);
  fill(root, "editor-target", "nav.profile", "change");
  const waits = () => control<HTMLSelectElement>(root, '[id="editor-wait"]');
  expect([...waits().options].map(option => option.value)).toEqual(["ack", "click"]);
  fill(root, "editor-wait", "click", "change");
  fill(root, "editor-target", "profile.nameInput", "change");
  expect([...waits().options].map(option => option.value)).toEqual(["", "ack", "input"]);
  expect(waits().value).toBe("");
  expect(root.textContent).toContain(c.problem.wait);
  button(root, c.add).click();
  expect(document.activeElement).toBe(button(root, "Step 2"));
  expect(root.textContent).toContain("Step 2: Select a target.");
  button(root, "Move up: Step 2").click(); expect(document.activeElement).toBe(button(root, "Step 1"));
  button(root, "Remove: Step 1").click();
  expect(button(root, "Remove: Step 1").disabled).toBe(true);
  fill(root, "editor-text", "<script>Hostile");
  expect(root.textContent).toContain(c.problem.text);
  expect(root.textContent).not.toContain("wt-local-draft");
  for (const action of [c.save, c.publish, c.preview]) {
    const trigger = button(root, action);
    expect(trigger.disabled).toBe(true);
    trigger.click(); trigger.dispatchEvent(new MouseEvent("click", { bubbles: true }));
  }
  expect(root.querySelector("script, dialog")).toBeNull();
  expect(document.querySelector("[data-ai-overlay]")).toBeNull();
  expect(host.writes()).toEqual([]);
});

it("uses fixed save errors instead of host text, including refusals, 413 and the host's oversize diagnostic", async () => {
  const { root, host } = await setup("editor");
  fillDraft(root);
  for (const [status, body, expected] of [
    [403, { message: "PRIVATE-HOST" }, c.writeFailed],
    [413, {}, c.oversize],
    [422, { kind: "invalid", message: "PRIVATE-HOST", issues: ["definition: too large to save"] }, c.oversize],
  ] as const) {
    host.overrides.set(`POST ${admin}`, () => json(body, status));
    button(root, c.save).click(); await turn();
    expect(root.textContent).toContain(`${c.saveFailed}. ${expected}`);
    expect(root.textContent).not.toContain("PRIVATE-HOST");
  }
});

it("previews the real runtime and overlay, hides the temporary id from Guides, and restores unsaved editor fields", async () => {
  const { root, host, handle } = await setup("settings");
  control<HTMLElement>(root, '[data-ai-id="settings.advancedToggle"]').click();
  handle.current()?.router.navigate("profile"); await turn();
  fill(root, "name", "Normal profile");
  await navigate("editor"); fillDraft(root);
  const original = handle.current();
  button(root, c.preview).click();
  expect(handle.current()).not.toBe(original);
  expect(root.querySelector(".guide-list")?.textContent).not.toContain("Authored settings tour");
  expect(root.querySelectorAll(".guide-list button")).toHaveLength(3);
  expect(handle.current()?.help.launcher.hidden).toBe(true);
  await turn();
  expect(root.querySelector("h1")?.textContent).toBe(copy.settings.title);
  expect(handle.current()?.runtime.getState()).toMatchObject({ walkthroughId: "wt-preview", status: "WAITING" });
  expect(document.querySelector('[data-ai-overlay="ring"]')).not.toBeNull();
  expect(document.querySelector('[data-ai-overlay="title"]')?.textContent).toBe(copy.semantic["settings.securityPanel"].label);
  expect(handle.current()?.store.get().advancedOpen).toBe(false);
  expect(handle.current()?.store.get().profile.draft).toBe("");
  control<HTMLElement>(document, '[data-ai-overlay="cancel"]').click();
  expect(resultDialog().textContent).toContain(copy.result.cancelled);
  button(resultDialog(), copy.result.close).click(); await turn();
  expect(root.querySelector("h1")?.textContent).toBe(c.editor);
  expect(document.activeElement).toBe(root.querySelector("h1"));
  expect(control<HTMLInputElement>(root, '[id="editor-title"]').value).toBe("Authored settings tour");
  expect(control<HTMLTextAreaElement>(root, '[id="editor-text"]').value).toBe("Read the Security panel.");
  expect(handle.current()?.store.get()).toMatchObject({ advancedOpen: true, profile: { draft: "Normal profile" } });
  expect(host.writes()).toEqual([]);
  expect(host.requests.some(request => request.path.includes("events"))).toBe(false);
});

it("previews stored drafts and published rows from the list without changing status", async () => {
  const host = fakeHost([guide(savedId, "draft", authored(savedId, "Stored draft")), guide(publishedId, "published", authored(publishedId, "Published tour"))]);
  const { root } = await setup("walkthroughs", host);
  for (const title of ["Stored draft", "Published tour"]) {
    button(root, `Preview: ${title}`).click(); await turn();
    expect(document.querySelector('[data-ai-overlay="ring"]')).not.toBeNull();
    control<HTMLElement>(document, '[data-ai-overlay="ack"]').click(); await turn();
    expect(resultDialog().textContent).toContain(copy.result.completed);
    button(resultDialog(), copy.result.done).click(); await turn();
    expect(root.querySelector("h1")?.textContent).toBe(c.walkthroughs);
  }
  expect(host.writes()).toEqual([]);
  expect(host.rows.get(savedId)?.status).toBe("draft");
  expect(host.rows.get(publishedId)?.status).toBe("published");
});

it("confirms Publish through a labelled keyboard dialog and only publishes after acceptance; User can run the released guide and Unpublish removes it", async () => {
  const host = fakeHost([guide(savedId, "draft", authored(savedId, "Release candidate"))]);
  const { root, handle } = await setup("walkthroughs", host);
  const trigger = button(root, "Publish: Release candidate");
  const open = async () => { trigger.click(); await turn(); return control<HTMLDialogElement>(root, "dialog"); };
  let dialog = await open();
  expect(dialog.open).toBe(true);
  expect(document.getElementById(dialog.getAttribute("aria-labelledby")!)?.textContent).toBe(c.publishTitle);
  expect(document.activeElement).toBe(button(dialog, c.cancel));
  document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Tab", shiftKey: true, bubbles: true, cancelable: true }));
  expect(document.activeElement).toBe(button(dialog, c.publish));
  document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  expect(root.querySelector("dialog")).toBeNull(); expect(document.activeElement).toBe(trigger);
  dialog = await open(); button(dialog, c.cancel).click(); expect(host.writes()).toEqual([]);
  dialog = await open(); button(dialog, c.publish).click(); await turn();
  expect(host.rows.get(savedId)?.status).toBe("published");
  expect(rowFor(root, "Release candidate").textContent).toContain(c.published);
  expect(rowFor(root, "Release candidate").textContent).not.toContain(c.edit);

  fill(root, "demo-role", "user", "change"); await turn();
  await navigate("dashboard");
  button(root, "Start guide: Release candidate").click(); await turn();
  expect(handle.current()?.runtime.getState()).toMatchObject({ walkthroughId: savedId, status: "WAITING" });
  control<HTMLElement>(document, '[data-ai-overlay="ack"]').click(); await turn();
  expect(handle.current()?.runtime.getState().status).toBe("COMPLETED");
  expect(resultDialog().textContent).toContain("Tour finished.");
  button(resultDialog(), copy.result.done).click();

  fill(root, "demo-role", "maintainer", "change"); await turn();
  await navigate("walkthroughs");
  button(root, "Unpublish: Release candidate").click(); await turn();
  expect(button(root, "Edit: Release candidate")).toBeDefined();
  await navigate("dashboard");
  expect(root.querySelector(".guide-list")?.textContent).not.toContain("Release candidate");
});

it("keeps only valid published definitions and degrades to the three built-ins on a failed fetch", async () => {
  const good = authored(publishedId, "Available tour");
  const bad = authored(invalidId, "Unavailable tour");
  const invalid = { ...bad, steps: bad.steps.map(step => step.kind === "guide" ? { ...step, target: "admin.editor" } : step) };
  const host = fakeHost([guide(publishedId, "published", good), guide(invalidId, "published", invalid), guide(savedId, "draft", authored(savedId, "Hidden draft"))]);
  const { root } = await setup("dashboard", host);
  expect(root.querySelectorAll(".guide-list button")).toHaveLength(4);
  expect(root.querySelector(".guide-list")?.textContent).toContain(good.title);
  expect(root.querySelector(".guide-list")?.textContent).not.toMatch(/Hidden draft|Unavailable tour/);
  host.overrides.set(`GET ${published}`, () => json({}, 503));
  fill(root, "demo-role", "user", "change"); await turn();
  expect(root.querySelectorAll(".guide-list button")).toHaveLength(3);
  expect(root.querySelector(".guide-list")?.textContent).not.toContain(good.title);
});

it("leaves a draft unchanged when the host rejects registry drift on Publish", async () => {
  const host = fakeHost([guide(savedId, "draft", authored(savedId, "Stale guide"))]);
  host.overrides.set(`POST ${admin}/${savedId}/status`, () => json({ kind: "invalid", message: "HOST-PRIVATE", issues: ["steps.1: unknown target"] }, 422));
  const { root } = await setup("walkthroughs", host);
  button(root, "Publish: Stale guide").click(); await turn();
  button(control(root, "dialog"), c.publish).click(); await turn();
  expect(host.rows.get(savedId)?.status).toBe("draft");
  expect(root.textContent).toContain(c.writeFailed);
  expect(root.textContent).not.toContain("HOST-PRIVATE");
});

it("refuses a directly requested published record and a foreign draft shape with safe copy", async () => {
  const def = authored(savedId, "Foreign tour");
  const foreign = { ...def, steps: def.steps.map(step => step.kind === "guide" ? { ...step, targetWaitMs: 100 } : step) };
  const host = fakeHost([guide(savedId, "draft", foreign), guide(publishedId, "published", authored(publishedId, "Published record"))]);
  requestEdit(publishedId);
  const { root } = await setup("editor", host);
  expect(root.textContent).toContain(c.readOnly);
  await navigate("walkthroughs"); button(root, "Edit: Foreign tour").click(); await turn();
  expect(root.textContent).toContain(c.foreign);
});


it.each(["Guides", "Help"])("refreshes the launcher when late Unpublish finishes during a real guide started from %s", async source => {
  const securityTitle = "Find the security settings";
  if (source === "Help") vi.stubGlobal("fetch", async (path: string) => path === "/api/guidance"
    ? json({ kind: "walkthrough", proposalId: "fake-proposal", title: securityTitle })
    : json({ kind: "start", walkthroughId: "findSecuritySettings" }));
  const def = authored(publishedId, "Release being removed");
  const host = fakeHost([guide(publishedId, "published", def)]);
  let finish!: (response: Response) => void;
  host.overrides.set(`POST ${admin}/${publishedId}/status`, () => new Promise(resolve => { finish = resolve; }));
  const { root, handle } = await setup("walkthroughs", host);
  button(root, "Unpublish: Release being removed").click();
  await navigate("dashboard");
  expect(button(root, "Start guide: Release being removed")).toBeDefined();
  if (source === "Help") {
    button(document, copy.help.title).click();
    const panel = control<HTMLElement>(document, '[id="dap-help-panel"]');
    fill(panel, "dap-help-query", "Where are the security settings?");
    button(panel, copy.help.ask).click(); await turn();
    button(panel, `Start guide: ${securityTitle}`).click();
  } else button(root, `Start guide: ${securityTitle}`).click();
  await turn();
  const runningApp = handle.current();
  const draft = guide(publishedId, "draft", def);
  host.rows.set(publishedId, draft); finish(json(draft)); await turn();
  expect(handle.current()).toBe(runningApp);
  expect(runningApp?.runtime.getState().status).toBe("WAITING");
  control<HTMLElement>(document, '[data-ai-overlay="ack"]').click(); await turn();
  expect(resultDialog().textContent).toContain(copy.result.completed);
  expect(handle.current()).toBe(runningApp);
  button(resultDialog(), copy.result.done).click(); await turn();
  expect(handle.current()).not.toBe(runningApp);
  expect(document.activeElement).toBe(root.querySelector("h1"));
  await navigate("dashboard");
  expect(root.querySelector("h1")?.textContent).toBe(copy.dashboard.title);
  expect(root.querySelector(".guide-list")?.textContent).not.toContain(def.title);
});

it("ignores the stored demo role outside development and omits the role selector and header", async () => {
  const { root, host } = await setup("dashboard", fakeHost(), "maintainer", false);
  expect(root.querySelector('[id="demo-role"]')).toBeNull();
  expect(root.querySelector('nav [href="#/walkthroughs"]')).toBeNull();
  expect(host.requests.map(request => request.role)).toEqual([null, null]);
  await navigate("walkthroughs");
  expect(root.textContent).toContain(c.denied);
});
