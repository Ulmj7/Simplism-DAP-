import { createSemanticRegistry } from "@dap/walkthrough";
import type { SemanticElementDef, WalkthroughDef } from "@dap/walkthrough";
import { afterEach, expect, it, vi } from "vitest";
import { boot } from "../browser.js";
import { copy } from "../copy.js";
import type { FetchLike } from "../help/client.js";
import { POSTCONDITION_NAMES } from "../postconditions.js";
import { createDemoRegistry } from "../semantic-ui.js";
import type { GuideRecord, GuideStatus } from "./client.js";
import { draftToDefinition } from "./draft.js";
import { requestEdit, setEditSession, takeRequestedEdit, writeRole } from "./session.js";

const c = copy.admin;
const p = c.application.page;
const REF = "app-00000000000a";
const ORD = "app-00000000000b";
const OFF = "app-00000000000c";
const savedId = "wt-000000000001";
const stamp = "2026-11-23T10:00:00.000Z";

interface App { id: string; name: string; origin: string; allowedOrigins: string[]; environment: string; registryId: string; source: "built-in" | "studio-managed"; enabled: boolean; updatedAt: string; routing: "hash" | "history"; runtimeAccess: boolean; runtimeKey: string | null; counts: { targets: number; drafts: number; published: number } }
const app = (id: string, name: string, port: number, registryId: string, enabled = true): App => ({
  id, name, origin: `http://127.0.0.1:${port}`, allowedOrigins: [`http://127.0.0.1:${port}`], environment: "development", registryId, source: registryId === "studio-managed" ? "studio-managed" : "built-in", enabled, updatedAt: stamp, routing: "hash", runtimeAccess: false, runtimeKey: null, counts: { targets: 0, drafts: 0, published: 0 },
});
const demo = createDemoRegistry();
// A second application with its own, different targets: proves the editor follows the SELECTED application's registry.
const ordersElements: SemanticElementDef[] = [
  { id: "nav.orders", route: "home", role: "link", label: "Orders link", description: "Opens the orders page", operations: ["highlight", "click"], privacy: "public" },
  { id: "orders.submit", route: "orders", role: "button", label: "Submit order", description: "Submits the order", operations: ["highlight", "click"], privacy: "public" },
  { id: "orders.note", route: "orders", role: "textbox", label: "Order note", description: "A note for the order", operations: ["highlight", "input"], privacy: "public" },
];
const ordersRegistry = createSemanticRegistry({ routes: ["home", "orders"], elements: ordersElements });
const registryReply: Record<string, object> = {
  [REF]: { routes: demo.routes, elements: demo.list().filter(item => item.privacy === "public"), postconditionNames: [...POSTCONDITION_NAMES], previewable: true, source: "built-in", pages: {}, previewMode: "in-app" },
  [ORD]: { routes: ["home", "orders"], elements: ordersElements, postconditionNames: ["order.submitted", "route.orders"], previewable: false, source: "built-in", pages: {}, previewMode: "in-app" },
  [OFF]: { routes: ["home", "orders"], elements: ordersElements, postconditionNames: ["order.submitted"], previewable: false, source: "built-in", pages: {}, previewMode: "in-app" },
};
const ordersDraft = (id: string): WalkthroughDef => draftToDefinition({
  title: "Orders tour", description: "Submit an order.", completion: "Order submitted.",
  steps: [{ target: "orders.submit", wait: "click", text: "Press Submit order." }],
}, ordersRegistry, id);
const referenceDraft = (id: string, title = "Reference tour"): WalkthroughDef => draftToDefinition({
  title, description: "Look at settings.", completion: "Done.", steps: [{ target: "settings.securityPanel", wait: "ack", text: "Read the Security panel." }],
}, demo, id);
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
const guide = (id: string, status: GuideStatus, definition: WalkthroughDef, applicationId: string | null): GuideRecord => ({ id, status, applicationId, definition });
const candidates: Record<string, object[]> = {
  [REF]: [
    { ref: "@e12", name: "Profile", role: "link", route: "dashboard", status: "trusted", targetId: "nav.profile", operations: ["highlight", "click"], privacy: "public" },
    { ref: "@e30", name: "Newsletter", role: "button", route: "dashboard", status: "unregistered" },
  ],
  [ORD]: [
    { ref: "@e7", name: "Submit order", role: "button", route: "orders", status: "trusted", targetId: "orders.submit", operations: ["highlight", "click"], privacy: "public" },
    { ref: "@e8", name: "Order note", role: "textbox", route: "orders", status: "trusted", targetId: "orders.note", operations: ["highlight", "input"], privacy: "public" },
  ],
};

interface Logged { path: string; method: string; body: Record<string, unknown> | null }
function fakeHost(seed: { apps?: App[]; guides?: GuideRecord[] } = {}) {
  const apps = new Map((seed.apps ?? [app(REF, "Reference application", 5173, "reference"), app(ORD, "Orders application", 5185, "fixture-b")]).map(item => [item.id, item]));
  const rows = new Map((seed.guides ?? []).map(row => [row.id, row]));
  const requests: Logged[] = [];
  let session: { id: string; applicationId: string } | undefined;
  const host = {
    apps, rows, requests,
    overrides: new Map<string, () => Response | Promise<Response>>(),
    writes: () => requests.filter(request => request.method !== "GET" && request.path !== "/api/studio/browser"),
    studio: (action?: string) => requests.filter(request => request.path === "/api/studio/browser" && (action === undefined || request.body?.action === action)).map(request => request.body!),
    session: () => session,
  };
  const registries = [{ id: "reference", label: "Reference application", source: "built-in" }, { id: "fixture-b", label: "Fixture application B", source: "built-in" }];
  const fetch: FetchLike = async (path, init) => {
    const method = init.method!;
    const role = new Headers(init.headers).get("x-demo-role");
    const body = init.body ? JSON.parse(init.body as string) as Record<string, unknown> : null;
    requests.push({ path, method, body });
    const override = host.overrides.get(`${method} ${path}`);
    if (override) return override();
    if (path === "/api/walkthroughs/published") return json({ walkthroughs: [] });
    if (role !== "maintainer") return json({ message: "FAKE-HOST-PRIVATE" }, 403);
    if (path === "/api/admin/analytics") return json({ totals: { started: 0, completed: 0, cancelled: 0, completionRate: null }, guides: [] });
    if (path === "/api/studio/browser") {
      const command = body!;
      const target = apps.get(String(command.applicationId));
      switch (command.action) {
        case "connect":
          if (!target) return json({ error: "APPLICATION_NOT_FOUND" }, 404);
          if (!target.enabled) return json({ error: "APPLICATION_DISABLED" }, 409);
          if (session) return json({ error: "BROWSER_BUSY" }, 409);
          session = { id: `session-${target.id.slice(-1)}`, applicationId: target.id };
          return json({ sessionId: session.id, applicationId: target.id, application: target.name, origin: target.origin, registrySource: target.source });
        case "refresh": return json({ url: `${target?.origin}/#/page`, route: String((candidates[session?.applicationId ?? ""]?.[0] as { route?: string } | undefined)?.route ?? "home"), page: "/#/page", hidden: 0, truncated: false, elements: candidates[session?.applicationId ?? ""] ?? [] });
        case "highlight": return json({ highlighted: true, ref: command.ref });
        case "capture": {
          const found = (candidates[session?.applicationId ?? ""] ?? []).find(item => (item as { ref: string }).ref === command.ref) as { targetId: string; route: string; name: string; role: string; operations: string[] };
          return json({ targetId: found.targetId, route: found.route, name: found.name, role: found.role, operations: found.operations });
        }
        case "disconnect": session = undefined; return json({ closed: true });
      }
      return json({ error: "INVALID_REQUEST" }, 400);
    }
    if (path === "/api/admin/applications" && method === "GET") return json({ applications: [...apps.values()], registries });
    if (path === "/api/admin/applications" && method === "POST") {
      const input = body as unknown as Omit<App, "id" | "enabled" | "updatedAt" | "routing" | "runtimeAccess" | "runtimeKey" | "counts">;
      if (input.name === "") return json({ kind: "invalid", message: "Invalid application", issues: ["name: <b>must not be empty</b>", "origin: must be https"] }, 422);
      const created = { ...input, source: input.registryId === "studio-managed" ? "studio-managed" as const : "built-in" as const, id: `app-${String(apps.size + 100).padStart(12, "0")}`, enabled: true, updatedAt: stamp, routing: "hash" as const, runtimeAccess: false, runtimeKey: null, counts: { targets: 0, drafts: 0, published: 0 } };
      apps.set(created.id, created); return json(created, 201);
    }
    const application = /^\/api\/admin\/applications\/(app-[a-f0-9]{12})(\/status|\/registry)?$/u.exec(path);
    if (application) {
      const target = apps.get(application[1]!);
      if (!target) return json({ kind: "not_found", message: "x", code: "APPLICATION_NOT_FOUND" }, 404);
      if (application[2] === "/registry") return json(registryReply[target.id]);
      if (application[2] === "/status") { target.enabled = (body as { enabled: boolean }).enabled; return json(target); }
      if (method === "PUT") { Object.assign(target, body); return json(target); }
      return json(target);
    }
    if (path === "/api/admin/walkthroughs" && method === "GET") {
      return json({ builtIn: [], authored: [...rows.values()].map(({ id, status, applicationId, definition }) => ({ id, status, applicationId, title: definition.title, description: definition.description, stepCount: definition.steps.length, updatedAt: stamp })) });
    }
    if (path === "/api/admin/walkthroughs" && method === "POST") {
      const { applicationId, definition } = body as { applicationId: string; definition: WalkthroughDef };
      const owner = apps.get(applicationId);
      if (!owner) return json({ kind: "not_found", message: "x", code: "APPLICATION_NOT_FOUND" }, 404);
      if (!owner.enabled) return json({ kind: "conflict", message: "x", code: "APPLICATION_DISABLED" }, 409);
      const record = guide(savedId, "draft", { ...definition, id: savedId }, applicationId);
      rows.set(savedId, record); return json(record, 201);
    }
    const walkthrough = /^\/api\/admin\/walkthroughs\/(wt-[a-f0-9]{12})(\/status)?$/u.exec(path);
    const stored = walkthrough ? rows.get(walkthrough[1]!) : undefined;
    if (!walkthrough || !stored) return json({}, 404);
    if (method === "GET") return json(stored);
    if (walkthrough[2]) {
      if (stored.applicationId && !apps.get(stored.applicationId)?.enabled) return json({ kind: "conflict", message: "x", code: "APPLICATION_DISABLED" }, 409);
      const next = { ...stored, status: (body as { status: GuideStatus }).status }; rows.set(stored.id, next); return json(next);
    }
    const { applicationId, definition } = body as { applicationId: string; definition: WalkthroughDef };
    if (stored.applicationId !== null && stored.applicationId !== applicationId) return json({ kind: "conflict", message: "x", code: "APPLICATION_MISMATCH" }, 409);
    if (!apps.get(applicationId)?.enabled) return json({ kind: "conflict", message: "x", code: "APPLICATION_DISABLED" }, 409);
    const next = { ...stored, applicationId, definition }; rows.set(stored.id, next); return json(next);
  };
  return { ...host, fetch };
}

let mounted: Awaited<ReturnType<typeof boot>> | undefined;
afterEach(() => {
  mounted?.destroy(); mounted = undefined; setEditSession(); takeRequestedEdit(); sessionStorage.clear(); localStorage.clear();
  document.body.replaceChildren(); window.history.replaceState(null, "", "#/dashboard"); vi.useRealTimers();
});
const turn = () => vi.advanceTimersByTimeAsync(10);
async function setup(route: string, host = fakeHost(), role: "maintainer" | "user" = "maintainer") {
  vi.useFakeTimers();
  window.history.replaceState(null, "", `#/${route}`);
  writeRole(window, role);
  const root = document.createElement("div"); document.body.append(root);
  mounted = await boot(root, { fetch: host.fetch, trustedEventsOnly: false, demoRoleEnabled: true });
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
const click = async (root: ParentNode, name: string) => { button(root, name).click(); await turn(); };
const navigate = async (route: "dashboard" | "walkthroughs" | "applications" | "editor" | "analytics") => { mounted?.current()?.router.navigate(route); await turn(); };
const options = (root: ParentNode, id: string) => [...control<HTMLSelectElement>(root, `[id="${id}"]`).options].map(item => item.value);
const rowFor = (root: ParentNode, name: string) => [...root.querySelectorAll("tbody tr")].find(row => row.firstElementChild?.textContent === name)!;
const notice = (root: ParentNode) => root.querySelector('[role="status"]')?.textContent;

// ---------------------------------------------------------------------------------------------------------------- Application Manager

it("shows Applications | Workflows | Targets | Studio | Analytics for a maintainer only, and denies a user who opens the page directly", async () => {
  const { root } = await setup("dashboard");
  expect([...root.querySelectorAll("nav a")].map(link => link.textContent).filter(text => ["Workflows", "Applications", "Targets", "DAP Studio", "Analytics"].includes(text ?? ""))).toEqual(["Applications", "Workflows", "Targets", "DAP Studio", "Analytics"]);
  mounted?.destroy();
  document.body.replaceChildren();
  const user = await setup("applications", fakeHost(), "user");
  expect(user.root.querySelector('nav [href="#/applications"]')).toBeNull();
  expect(user.root.textContent).toContain(c.denied);
  expect(user.root.querySelector("table")).toBeNull();
  expect(user.host.requests.every(request => request.method === "GET")).toBe(true);
});

it("lists every application with its origins, environment, registry label and state, as text only", async () => {
  const hostile = { ...app(OFF, "<img src=x onerror=bad()>", 5199, "fixture-b", false), allowedOrigins: ["http://127.0.0.1:5199", "http://localhost:5199"] };
  const host = fakeHost({ apps: [app(REF, "Reference application", 5173, "reference"), hostile] });
  const { root } = await setup("applications", host);
  expect(root.querySelector("h1")?.textContent).toBe(c.applications);
  const row = rowFor(root, "<img src=x onerror=bad()>");
  expect([...row.querySelectorAll("td")].map(cell => cell.textContent)).toEqual([
    "<img src=x onerror=bad()>", "http://127.0.0.1:5199", "http://127.0.0.1:5199\nhttp://localhost:5199", "development", "Fixture application B", p.disabledLabel,
    "View registryEditEnableUse for authoring",
  ]);
  expect(root.querySelector("img")).toBeNull();
  expect(rowFor(root, "Reference application").textContent).toContain("Reference application" + "http://127.0.0.1:5173");
  expect(rowFor(root, "Reference application").textContent).toContain(p.enabledLabel);
  expect(root.textContent).toContain("Loopback addresses are allowed for development and test");
  expect(root.textContent).toContain("any other address must use https");
  expect(root.textContent).toContain("Only development and test are available in this release.");
});

it("offers only development and test and the registries the host lists", async () => {
  const { root } = await setup("applications");
  expect(options(root, "application-environment")).toEqual(["development", "test"]);
  expect(options(root, "application-registry")).toEqual(["", "reference", "fixture-b"]);
  expect(root.querySelector('label[for="application-allowed"]')?.textContent).toBe(p.allowed);
  expect(root.querySelector("#application-allowed-help")?.textContent).toBe(p.allowedHelp);
});

it("enrolls an application with exactly the five configuration fields and refreshes the list", async () => {
  const { root, host } = await setup("applications");
  fill(root, "application-name", "  Orders test app ");
  fill(root, "application-origin", " http://127.0.0.1:5190 ");
  fill(root, "application-allowed", "http://127.0.0.1:5190\n\n  http://localhost:5190  \n");
  fill(root, "application-environment", "test", "change");
  fill(root, "application-registry", "fixture-b", "change");
  expect(host.writes()).toEqual([]);
  control<HTMLFormElement>(root, "form").requestSubmit(); await turn();
  const [create] = host.writes();
  expect(create).toMatchObject({ method: "POST", path: "/api/admin/applications" });
  expect(Object.keys(create!.body!)).toEqual(["name", "origin", "allowedOrigins", "environment", "registryId"]);
  expect(create!.body).toEqual({ name: "Orders test app", origin: "http://127.0.0.1:5190", allowedOrigins: ["http://127.0.0.1:5190", "http://localhost:5190"], environment: "test", registryId: "fixture-b" });
  expect(notice(root)).toBe(p.saved);
  expect(rowFor(root, "Orders test app").textContent).toContain("test");
  expect(control<HTMLInputElement>(root, "#application-name").value).toBe("");
});

it("shows 422 issues as plain text, keeps the form values, and maps a limit, a denial and other failures to fixed messages", async () => {
  const { root, host } = await setup("applications");
  fill(root, "application-name", "");
  fill(root, "application-origin", "http://127.0.0.1:5190");
  control<HTMLFormElement>(root, "form").requestSubmit(); await turn();
  const issues = [...root.querySelectorAll("#application-issues li")].map(item => item.textContent);
  expect(issues).toEqual([p.invalidTitle, "name: <b>must not be empty</b>", "origin: must be https"]);
  expect(root.querySelector("#application-issues b")).toBeNull();
  expect(control<HTMLInputElement>(root, "#application-origin").value).toBe("http://127.0.0.1:5190");
  expect(host.writes()).toHaveLength(1);
  const failures: [number, unknown, string][] = [
    [409, { kind: "conflict", message: "HOST-PRIVATE", code: "APPLICATION_LIMIT" }, c.application.limit],
    [403, { message: "HOST-PRIVATE" }, c.writeFailed],
    [500, { message: "HOST-PRIVATE" }, c.writeFailed],
  ];
  for (const [status, body, expected] of failures) {
    host.overrides.set("POST /api/admin/applications", () => json(body, status));
    control<HTMLFormElement>(root, "form").requestSubmit(); await turn();
    expect(root.textContent).toContain(expected);
    expect(root.textContent).not.toContain("HOST-PRIVATE");
  }
  expect(control<HTMLInputElement>(root, "#application-origin").value).toBe("http://127.0.0.1:5190");
});

it("edits an application with the full body and cancels an edit without writing", async () => {
  const { root, host } = await setup("applications");
  await click(root, "Edit: Orders application");
  expect(root.querySelector("form h2")?.textContent).toBe(p.editTitle);
  expect(control<HTMLInputElement>(root, "#application-name").value).toBe("Orders application");
  expect(control<HTMLTextAreaElement>(root, "#application-allowed").value).toBe("http://127.0.0.1:5185");
  expect(control<HTMLSelectElement>(root, "#application-registry").value).toBe("fixture-b");
  await click(root, p.cancel);
  expect(root.querySelector("form h2")?.textContent).toBe(p.createTitle);
  expect(host.writes()).toEqual([]);
  await click(root, "Edit: Orders application");
  fill(root, "application-name", "Orders application v2");
  fill(root, "application-allowed", "http://127.0.0.1:5185\nhttp://localhost:5185");
  control<HTMLFormElement>(root, "form").requestSubmit(); await turn();
  expect(host.writes()).toEqual([{ method: "PUT", path: `/api/admin/applications/${ORD}`, body: {
    name: "Orders application v2", origin: "http://127.0.0.1:5185", allowedOrigins: ["http://127.0.0.1:5185", "http://localhost:5185"], environment: "development", registryId: "fixture-b",
  } }]);
  expect(Object.keys(host.writes()[0]!.body!)).toEqual(["name", "origin", "allowedOrigins", "environment", "registryId"]);
  expect(rowFor(root, "Orders application v2")).toBeDefined();
  expect(root.querySelector("form h2")?.textContent).toBe(p.createTitle);
});

it("enables and disables an application, and offers Use for authoring only while it is enabled", async () => {
  const { root, host } = await setup("applications");
  expect(button(root, "Use for authoring: Orders application").disabled).toBe(false);
  await click(root, "Disable: Orders application");
  expect(host.writes()).toEqual([{ method: "POST", path: `/api/admin/applications/${ORD}/status`, body: { enabled: false } }]);
  expect(rowFor(root, "Orders application").textContent).toContain(p.disabledLabel);
  expect(button(root, "Use for authoring: Orders application").disabled).toBe(true);
  expect(button(root, "Enable: Orders application")).toBeDefined();
  await click(root, "Enable: Orders application");
  expect(host.writes()[1]!.body).toEqual({ enabled: true });
  expect(button(root, "Use for authoring: Orders application").disabled).toBe(false);
});

it("Use for authoring opens a new draft in the editor with that application already chosen", async () => {
  const { root, host } = await setup("applications");
  await click(root, "Use for authoring: Orders application");
  expect(root.querySelector("h1")?.textContent).toBe(c.editor);
  expect(control<HTMLSelectElement>(root, "#editor-application").value).toBe(ORD);
  expect(options(root, "editor-target")).toContain("orders.submit");
  expect(host.requests.some(request => request.path === `/api/admin/applications/${ORD}/registry`)).toBe(true);
  expect(host.writes()).toEqual([]);
});

// ---------------------------------------------------------------------------------------------------------------- editor selector and registry

it("makes a new draft choose an application, lists disabled ones as not selectable, and shows no targets until one is chosen", async () => {
  const host = fakeHost({ apps: [app(REF, "Reference application", 5173, "reference"), app(ORD, "Orders application", 5185, "fixture-b"), app(OFF, "Retired application", 5190, "fixture-b", false)] });
  const { root } = await setup("editor", host);
  const selector = control<HTMLSelectElement>(root, "#editor-application");
  expect(root.querySelector('label[for="editor-application"]')?.textContent).toBe(c.application.label);
  expect([...selector.options].map(item => [item.value, item.textContent, item.disabled])).toEqual([
    ["", c.application.choose, false], [REF, "Reference application", false], [ORD, "Orders application", false], [OFF, "Retired application (disabled)", true],
  ]);
  expect(selector.value).toBe("");
  expect(options(root, "editor-target")).toEqual([""]);
  expect(root.querySelector("#editor-problems")?.textContent).toContain(c.application.required);
  expect(button(root, c.save).disabled).toBe(true);
  expect(button(root, c.preview).disabled).toBe(true);
  expect(host.requests.some(request => request.path.endsWith("/registry"))).toBe(false);
  expect(root.textContent).toContain(c.application.chooseFirst);
});

it("starts on the only enabled application", async () => {
  const host = fakeHost({ apps: [app(REF, "Reference application", 5173, "reference"), app(OFF, "Retired application", 5190, "fixture-b", false)] });
  const { root } = await setup("editor", host);
  expect(control<HTMLSelectElement>(root, "#editor-application").value).toBe(REF);
  expect(options(root, "editor-target")).toContain("settings.securityPanel");
  expect(root.querySelector("#editor-problems")?.textContent).not.toContain(c.application.required);
});

it("drives the picker, the checks and the routes from the SELECTED application's registry: application A is not application B", async () => {
  const { root, host } = await setup("editor");
  fill(root, "editor-application", REF, "change"); await turn();
  const reference = options(root, "editor-target");
  expect(reference).toContain("profile.nameInput");
  expect(reference).not.toContain("orders.submit");
  expect(reference).not.toContain("profile.emailInput");
  expect([...root.querySelectorAll("#editor-target optgroup")].map(group => (group as HTMLOptGroupElement).label)).toEqual(["Dashboard", "Profile", "Settings"]);
  expect(options(root, "editor-verify")).toEqual(["", ...POSTCONDITION_NAMES]);
  fill(root, "editor-application", ORD, "change"); await turn();
  expect(options(root, "editor-target")).toEqual(["", "nav.orders", "orders.submit", "orders.note"]);
  expect([...root.querySelectorAll("#editor-target optgroup")].map(group => (group as HTMLOptGroupElement).label)).toEqual(["home", "orders"]);
  expect(options(root, "editor-verify")).toEqual(["", "order.submitted", "route.orders"]);
  expect([...control<HTMLSelectElement>(root, "#editor-verify").options].map(item => item.textContent)).toEqual([c.none, "order.submitted", "route.orders"]);
  expect(host.requests.filter(request => request.path.endsWith("/registry")).map(request => request.path)).toEqual([
    `/api/admin/applications/${REF}/registry`, `/api/admin/applications/${ORD}/registry`,
  ]);
  fill(root, "editor-target", "orders.submit", "change");
  expect([...control<HTMLSelectElement>(root, "#editor-wait").options].map(item => item.value)).toEqual(["ack", "click"]);
  // Reference-only targets are unknown here: choosing one cannot happen, and a stale one is flagged by the checker.
  expect(options(root, "editor-target")).not.toContain("settings.securityPanel");
});

it("saves a draft for the second application with its own targets and then fixes the application", async () => {
  const { root, host } = await setup("editor");
  fill(root, "editor-application", ORD, "change"); await turn();
  fill(root, "editor-title", "Orders tour"); fill(root, "editor-description", "Submit an order."); fill(root, "editor-completion", "Order submitted.");
  fill(root, "editor-target", "orders.submit", "change"); fill(root, "editor-wait", "click", "change"); fill(root, "editor-text", "Press Submit order.");
  fill(root, "editor-verify", "order.submitted", "change");
  await click(root, c.save);
  const [create] = host.writes();
  expect(Object.keys(create!.body!)).toEqual(["applicationId", "definition"]);
  expect(create!.body).toMatchObject({ applicationId: ORD });
  expect((create!.body!.definition as { steps: { id: string; target?: string; verify?: string }[] }).steps.filter(step => step.target).map(step => [step.target, step.verify])).toEqual([["orders.submit", "order.submitted"]]);
  expect(notice(root)).toBe(c.saved);
  expect(root.querySelector("#editor-application")).toBeNull();
  expect(root.querySelector("#editor-application-fixed")?.textContent).toBe("Orders application");
  expect(root.textContent).toContain(c.application.fixedHint);
});

it("shows the application of an existing draft as a fixed label and validates it against that application's registry", async () => {
  const host = fakeHost({ guides: [guide(savedId, "draft", ordersDraft(savedId), ORD)] });
  const { root } = await setup("walkthroughs", host);
  await click(root, "Edit: Orders tour");
  expect(root.querySelector("#editor-application")).toBeNull();
  expect(root.querySelector("#editor-application-fixed")?.textContent).toBe("Orders application");
  expect(control<HTMLSelectElement>(root, "#editor-target").value).toBe("orders.submit");
  expect(control<HTMLElement>(root, "#editor-problems").hidden).toBe(true);
  expect(button(root, c.save).disabled).toBe(false);
  fill(root, "editor-text", "Press Submit order now.");
  await click(root, c.save);
  expect(host.writes().at(-1)).toMatchObject({ method: "PUT", path: `/api/admin/walkthroughs/${savedId}`, body: { applicationId: ORD } });
});

it("lets a legacy draft without an application choose one on its first save, then fixes it", async () => {
  const host = fakeHost({ guides: [guide(savedId, "draft", referenceDraft(savedId, "Legacy tour"), null)] });
  const { root } = await setup("walkthroughs", host);
  await click(root, "Edit: Legacy tour");
  const selector = control<HTMLSelectElement>(root, "#editor-application");
  expect(selector.value).toBe("");
  // Until it is assigned, a legacy draft is read against the reference registry, like the host does.
  expect(control<HTMLSelectElement>(root, "#editor-target").value).toBe("settings.securityPanel");
  expect(button(root, c.save).disabled).toBe(true);
  expect(root.querySelector("#editor-problems")?.textContent).toContain(c.application.required);
  fill(root, "editor-application", REF, "change"); await turn();
  expect(button(root, c.save).disabled).toBe(false);
  await click(root, c.save);
  expect(host.writes().at(-1)).toMatchObject({ method: "PUT", path: `/api/admin/walkthroughs/${savedId}`, body: { applicationId: REF } });
  expect(root.querySelector("#editor-application")).toBeNull();
  expect(root.querySelector("#editor-application-fixed")?.textContent).toBe("Reference application");
});

it("disables Preview with a plain sentence for an application whose registry is not previewable, and enables it for the reference application", async () => {
  const { root } = await setup("editor");
  fill(root, "editor-application", REF, "change"); await turn();
  fill(root, "editor-title", "Tour"); fill(root, "editor-description", "A tour."); fill(root, "editor-completion", "Done.");
  fill(root, "editor-target", "settings.securityPanel", "change"); fill(root, "editor-text", "Read this.");
  expect(button(root, c.preview).disabled).toBe(false);
  expect(control<HTMLElement>(root, "#editor-preview-hint").hidden).toBe(true);
  fill(root, "editor-application", ORD, "change"); await turn();
  fill(root, "editor-target", "orders.submit", "change"); fill(root, "editor-text", "Press it."); fill(root, "editor-wait", "click", "change");
  expect(control<HTMLElement>(root, "#editor-problems").hidden).toBe(true);
  expect(button(root, c.preview).disabled).toBe(true);
  expect(control<HTMLElement>(root, "#editor-preview-hint").hidden).toBe(false);
  expect(control<HTMLElement>(root, "#editor-preview-hint").textContent).toBe("Preview is available for the reference application in this release.");
  expect(button(root, c.preview).getAttribute("aria-describedby")).toContain("editor-preview-hint");
  expect(document.querySelector("[data-ai-overlay]")).toBeNull();
});

it("flags targets of the old application instead of silently keeping or clearing them when a new draft switches application", async () => {
  const { root } = await setup("editor");
  fill(root, "editor-application", REF, "change"); await turn();
  fill(root, "editor-title", "Tour"); fill(root, "editor-description", "A tour."); fill(root, "editor-completion", "Done.");
  fill(root, "editor-target", "settings.securityPanel", "change"); fill(root, "editor-text", "Read this.");
  expect(button(root, c.save).disabled).toBe(false);
  fill(root, "editor-application", ORD, "change"); await turn();
  expect(control<HTMLSelectElement>(root, "#editor-target").getAttribute("aria-invalid")).toBe("true");
  expect(root.querySelector("#editor-problems")?.textContent).toContain(c.problem.unknownTarget);
  expect(button(root, c.save).disabled).toBe(true);
  expect(control<HTMLInputElement>(root, "#editor-title").value).toBe("Tour");
  fill(root, "editor-target", "orders.submit", "change");
  expect(control<HTMLSelectElement>(root, "#editor-target").getAttribute("aria-invalid")).toBeNull();
});

it("answers the application failures with plain messages and never shows host text", async () => {
  const host = fakeHost({ guides: [guide(savedId, "draft", ordersDraft(savedId), ORD)] });
  const { root } = await setup("walkthroughs", host);
  await click(root, "Edit: Orders tour");
  fill(root, "editor-text", "Press Submit order again.");
  host.apps.get(ORD)!.enabled = false;
  await click(root, c.save);
  expect(notice(root)).toBe(`${c.saveFailed}. ${c.application.failures.APPLICATION_DISABLED}`);
  host.apps.get(ORD)!.enabled = true;
  host.overrides.set(`PUT /api/admin/walkthroughs/${savedId}`, () => json({ kind: "conflict", message: "HOST-PRIVATE", code: "APPLICATION_MISMATCH" }, 409));
  await click(root, c.save);
  expect(notice(root)).toBe(`${c.saveFailed}. ${c.application.failures.APPLICATION_MISMATCH}`);
  host.overrides.set(`PUT /api/admin/walkthroughs/${savedId}`, () => json({ kind: "not_found", message: "HOST-PRIVATE", code: "APPLICATION_NOT_FOUND" }, 404));
  await click(root, c.save);
  expect(notice(root)).toBe(`${c.saveFailed}. ${c.application.failures.APPLICATION_NOT_FOUND}`);
  expect(root.textContent).not.toContain("HOST-PRIVATE");
});

it("answers a disabled application on Publish and on opening a draft whose application is gone", async () => {
  const host = fakeHost({ guides: [guide(savedId, "draft", ordersDraft(savedId), ORD)] });
  const { root } = await setup("walkthroughs", host);
  await click(root, "Edit: Orders tour");
  host.apps.get(ORD)!.enabled = false;
  await click(root, c.publish);
  await click(control(root, "dialog"), c.publish);
  expect(notice(root)).toBe(c.application.failures.APPLICATION_DISABLED);
  expect(host.rows.get(savedId)?.status).toBe("draft");
  host.apps.delete(ORD);
  await navigate("walkthroughs");
  await click(root, "Edit: Orders tour");
  expect(root.textContent).toContain(c.application.failures.APPLICATION_NOT_FOUND);
  expect(root.querySelector("#editor-title")).toBeNull();
});

// ---------------------------------------------------------------------------------------------------------------- the workspace inside the editor

it("lays the editor out as steps, browser workspace and step properties", async () => {
  const { root } = await setup("editor");
  const panes = control(root, ".editor-panes");
  expect(panes.classList.contains("editor-panes-studio")).toBe(true);
  expect([...panes.children].map(child => child.querySelector("h2")?.textContent)).toEqual([c.steps, "Browser workspace", `${c.step} 1`]);
  expect(panes.children[1]!.classList.contains("studio-workspace")).toBe(true);
});

it("captures a trusted target for the selected step with Use, keeps the live ref out of the draft and the save body, and persists nothing on Highlight", async () => {
  const { root, host } = await setup("editor");
  fill(root, "editor-application", ORD, "change"); await turn();
  fill(root, "editor-title", "Orders tour"); fill(root, "editor-description", "Submit an order."); fill(root, "editor-completion", "Order submitted.");
  fill(root, "editor-text", "Press Submit order.");
  await click(root, "Connect Chrome");
  expect(host.studio("connect")).toEqual([{ action: "connect", applicationId: ORD }]);
  expect(root.querySelector(".studio-status")?.textContent).toContain("Orders application");
  await click(root, "Inspect current page");
  expect(host.studio("refresh")).toEqual([{ action: "refresh", sessionId: "session-b", applicationId: ORD }]);
  expect(root.querySelectorAll("li.studio-candidate")).toHaveLength(2);
  await click(root, "Highlight: Submit order");
  expect(host.studio("highlight")).toEqual([{ action: "highlight", sessionId: "session-b", applicationId: ORD, ref: "@e7" }]);
  expect(root.querySelector(".studio-workspace [role=status]")?.textContent).toBe("Highlighted in Chrome — nothing was saved");
  expect(control<HTMLSelectElement>(root, "#editor-target").value).toBe("");
  expect(host.writes()).toEqual([]);
  await click(root, "Use: Submit order");
  expect(root.querySelector(".studio-workspace [role=status]")?.textContent).toBe("Captured target — Submit order · button · orders · DAP target orders.submit");
  expect(control<HTMLSelectElement>(root, "#editor-target").value).toBe("orders.submit");
  fill(root, "editor-wait", "click", "change");
  await click(root, c.save);
  const [create] = host.writes();
  expect(JSON.stringify(create!.body)).not.toMatch(/@e\d/);
  expect(JSON.stringify(create!.body)).toContain("orders.submit");
  for (const store of [localStorage, sessionStorage]) expect(JSON.stringify(Object.fromEntries(Object.entries(store)))).not.toMatch(/@e\d/);
  expect(window.location.href).not.toMatch(/@e\d/);
  const draft = JSON.stringify(host.rows.get(savedId));
  expect(draft).not.toMatch(/@e\d/);
  expect(root.querySelector(".studio-workspace")?.textContent).toContain("Live ref: @e7 Session only");
});

it("shows an unregistered element as display-only and refuses a reply that gives it a target", async () => {
  const { root, host } = await setup("editor");
  fill(root, "editor-application", REF, "change"); await turn();
  await click(root, "Connect Chrome");
  await click(root, "Inspect current page");
  const newsletter = [...root.querySelectorAll("li.studio-candidate")].find(row => row.textContent?.includes("Newsletter"))!;
  expect(newsletter.textContent).toContain("Not registered for walkthrough use");
  expect(newsletter.querySelector("button")).toBeNull();
  expect(root.textContent).not.toContain("Highlight: Newsletter");
  const poisoned = candidates[REF]!.map(item => ({ ...item }));
  (poisoned[1] as Record<string, unknown>).targetId = "nav.profile";
  host.overrides.set("POST /api/studio/browser", () => json({ url: "http://127.0.0.1:5173/#/page", route: "dashboard", page: "/#/page", hidden: 0, truncated: false, elements: poisoned }));
  await click(root, "Inspect current page");
  expect(root.querySelector(".studio-workspace")?.getAttribute("data-state")).toBe("ERROR");
  expect(root.querySelectorAll("li.studio-candidate")).toHaveLength(0);
});

it("closes the session, clears the candidates and needs an explicit reconnect when a new draft selects another application", async () => {
  const { root, host } = await setup("editor");
  fill(root, "editor-application", REF, "change"); await turn();
  await click(root, "Connect Chrome");
  await click(root, "Inspect current page");
  expect(root.querySelectorAll("li.studio-candidate")).toHaveLength(2);
  expect(host.session()).toMatchObject({ applicationId: REF });
  fill(root, "editor-application", ORD, "change"); await turn();
  expect(host.studio("disconnect")).toEqual([{ action: "disconnect", sessionId: "session-a", applicationId: REF }]);
  expect(host.session()).toBeUndefined();
  expect(root.querySelector(".studio-workspace")?.getAttribute("data-state")).toBe("DISCONNECTED");
  expect(root.querySelectorAll("li.studio-candidate")).toHaveLength(0);
  expect(host.studio("connect")).toHaveLength(1);
  await click(root, "Connect Chrome");
  expect(host.studio("connect")[1]).toEqual({ action: "connect", applicationId: ORD });
  expect(root.querySelector(".studio-status")?.textContent).toContain("Orders application");
});

it("sends the saved draft's id when connecting for an existing draft", async () => {
  const host = fakeHost({ guides: [guide(savedId, "draft", ordersDraft(savedId), ORD)] });
  const { root } = await setup("walkthroughs", host);
  await click(root, "Edit: Orders tour");
  await click(root, "Connect Chrome");
  expect(host.studio("connect")).toEqual([{ action: "connect", applicationId: ORD, walkthroughId: savedId }]);
});

it("keeps manual authoring fully usable when the browser workspace is unavailable", async () => {
  const host = fakeHost();
  host.overrides.set("POST /api/studio/browser", () => json({ error: "BROWSER_UNAVAILABLE" }, 503));
  const { root } = await setup("editor", host);
  fill(root, "editor-application", ORD, "change"); await turn();
  await click(root, "Connect Chrome");
  expect(root.querySelector(".studio-workspace")?.getAttribute("data-state")).toBe("ERROR");
  expect(root.querySelector(".studio-workspace [role=alert]")?.textContent).toBe("The browser workspace is unavailable. You can still select a registry target.");
  fill(root, "editor-title", "Manual tour"); fill(root, "editor-description", "Picked by hand."); fill(root, "editor-completion", "Done.");
  fill(root, "editor-target", "orders.note", "change"); fill(root, "editor-wait", "input", "change"); fill(root, "editor-text", "Type a note.");
  expect(control<HTMLElement>(root, "#editor-problems").hidden).toBe(true);
  await click(root, c.save);
  expect(host.writes()[0]).toMatchObject({ method: "POST", body: { applicationId: ORD } });
  expect(notice(root)).toBe(c.saved);
});

it("disconnects when the editor is left", async () => {
  const { root, host } = await setup("editor");
  fill(root, "editor-application", REF, "change"); await turn();
  await click(root, "Connect Chrome");
  expect(host.session()).toBeDefined();
  await navigate("walkthroughs");
  expect(host.studio("disconnect")).toEqual([{ action: "disconnect", sessionId: "session-a", applicationId: REF }]);
  expect(host.session()).toBeUndefined();
  expect(root.querySelector(".studio-workspace")).toBeNull();
});

it("reports a disabled or unknown application on Connect without leaving a session", async () => {
  const host = fakeHost({ apps: [app(REF, "Reference application", 5173, "reference"), app(ORD, "Orders application", 5185, "fixture-b")] });
  const { root } = await setup("editor", host);
  fill(root, "editor-application", ORD, "change"); await turn();
  host.apps.get(ORD)!.enabled = false;
  await click(root, "Connect Chrome");
  expect(root.querySelector(".studio-workspace [role=alert]")?.textContent).toBe("That application is disabled. Enable it in Applications first.");
  expect(root.querySelector(".studio-workspace")?.getAttribute("data-state")).toBe("ERROR");
  host.apps.delete(ORD);
  await click(root, "Connect Chrome");
  expect(root.querySelector(".studio-workspace [role=alert]")?.textContent).toBe("That application is no longer available.");
  expect(host.session()).toBeUndefined();
});

it("still opens an existing draft read-only when it has been published", async () => {
  const host = fakeHost({ guides: [guide(savedId, "published", ordersDraft(savedId), ORD)] });
  requestEdit(savedId);
  const { root } = await setup("editor", host);
  expect(root.textContent).toContain(c.readOnly);
  expect(root.querySelector("#editor-title")).toBeNull();
});

it("applies Use to the step that is selected, not to another one, and leaves the other steps alone", async () => {
  const { root } = await setup("editor");
  fill(root, "editor-application", ORD, "change"); await turn();
  fill(root, "editor-target", "nav.orders", "change");
  await click(root, c.add);
  expect(control<HTMLSelectElement>(root, "#editor-target").value).toBe("");
  await click(root, "Connect Chrome");
  await click(root, "Inspect current page");
  await click(root, "Use: Order note");
  expect(control<HTMLSelectElement>(root, "#editor-target").value).toBe("orders.note");
  expect([...control<HTMLSelectElement>(root, "#editor-wait").options].map(item => item.value)).toEqual(["ack", "input"]);
  await click(root, "Step 1");
  expect(control<HTMLSelectElement>(root, "#editor-target").value).toBe("nav.orders");
  await click(root, "Step 2");
  expect(control<HTMLSelectElement>(root, "#editor-target").value).toBe("orders.note");
  expect(root.querySelector(".studio-workspace [role=status]")?.textContent).toBe("Captured target — Order note · textbox · orders · DAP target orders.note");
});

it("explains plainly that the list Preview is only for the reference application instead of calling the draft invalid", async () => {
  const host = fakeHost({ guides: [guide(savedId, "draft", ordersDraft(savedId), ORD), guide("wt-000000000002", "draft", referenceDraft("wt-000000000002", "Reference draft"), REF)] });
  const { root } = await setup("walkthroughs", host);
  await click(root, "Preview: Orders tour");
  expect(notice(root)).toBe(c.application.noPreview);
  expect(document.querySelector("[data-ai-overlay]")).toBeNull();
  expect(root.textContent).not.toContain(c.previewFailed);
  await click(root, "Preview: Reference draft");
  expect(document.querySelector('[data-ai-overlay="ring"]')).not.toBeNull();
});

it("follows the host when it has closed the session because the application changed: disconnected, candidates cleared, authoring unaffected", async () => {
  const { root, host } = await setup("editor");
  fill(root, "editor-application", ORD, "change"); await turn();
  await click(root, "Connect Chrome");
  await click(root, "Inspect current page");
  expect(root.querySelectorAll("li.studio-candidate")).toHaveLength(2);
  host.overrides.set("POST /api/studio/browser", () => json({ error: "APPLICATION_DISABLED" }, 409));
  await click(root, "Inspect current page");
  const workspace = control(root, ".studio-workspace");
  expect(workspace.getAttribute("data-state")).toBe("DISCONNECTED");
  expect(workspace.querySelector("[role=alert]")?.textContent).toContain("The browser session was closed");
  expect(workspace.querySelectorAll("li.studio-candidate")).toHaveLength(0);
  host.overrides.delete("POST /api/studio/browser");
  host.overrides.set("POST /api/studio/browser", () => json({ error: "APPLICATION_MISMATCH" }, 409));
  await click(root, "Connect Chrome");
  expect(workspace.getAttribute("data-state")).toBe("ERROR");
  expect(workspace.querySelector("[role=alert]")?.textContent).toBe("This browser session no longer matches the application. Disconnect and connect again.");
  expect(control<HTMLSelectElement>(root, "#editor-target").disabled).toBe(false);
});

it("keeps Connect off with a hint for a draft whose application the editor knows is disabled, and still lets the draft be read", async () => {
  const host = fakeHost({ guides: [guide(savedId, "draft", ordersDraft(savedId), ORD)] });
  host.apps.get(ORD)!.enabled = false;
  const { root } = await setup("walkthroughs", host);
  await click(root, "Edit: Orders tour");
  expect(control<HTMLElement>(root, "#editor-application-fixed").textContent).toBe("Orders application (disabled)");
  expect(button(root, "Connect Chrome").disabled).toBe(true);
  expect(root.querySelector(".studio-workspace [role=status]")?.textContent).toBe("This application is disabled. Enable it in Applications to connect.");
  expect(control<HTMLSelectElement>(root, "#editor-target").value).toBe("orders.submit");
  expect(host.studio()).toEqual([]);
});

const managed = app(ORD, "Managed orders", 5187, "studio-managed");
const managedTarget = {
  id: "orders.submit", marker: "orders.submit", route: "orders", page: "/#/orders", role: "button", label: "Submit order", description: "Submits the order",
  operations: ["highlight", "click"], privacy: "public", status: "active", health: "unverified", healthCheckedAt: null, revision: 1, references: { drafts: 2, published: 1 }, updatedAt: stamp,
};
const managedRegistry = (active: boolean) => ({
  routes: active ? ["orders"] : [], elements: active ? [ordersElements[1]] : [], postconditionNames: active ? ["route.orders"] : [],
  previewable: active, source: "studio-managed", pages: active ? { "/#/orders": "orders" } : {}, previewMode: "application-window",
});
const proposed = {
  ref: "@e7", name: "Submit order", role: "button", route: null, status: "registrable",
  proposal: { targetId: "orders.submit", role: "button", page: "/#/orders", route: "orders", routeIsNew: true,
    suggestedLabel: "Submit order", allowedOperations: ["highlight", "click", "focus"], defaultOperations: ["highlight", "click"], privacy: "public" },
};

it("registers, refreshes the editor registry, and saves only the durable target ID in a managed draft", async () => {
  const host = fakeHost({ apps: [managed] });
  let registered = false;
  host.overrides.set(`GET /api/admin/applications/${ORD}/registry`, () => json(managedRegistry(registered)));
  const original = host.fetch;
  const browserFetch: FetchLike = async (url, init) => {
    if (url !== "/api/studio/browser") return original(url, init);
    const command = JSON.parse(init.body as string);
    if (command.action === "register") {
      expect(command).toEqual({ action: "register", applicationId: ORD, sessionId: "session-b", ref: "@e7",
        targetId: "orders.submit", route: "orders", operations: ["highlight", "click", "focus"],
        label: "Submit order", description: "Submits the order", privacy: "public" });
      registered = true;
      return json({ target: { ...managedTarget, operations: ["highlight", "click", "focus"] }, route: { route: "orders", page: "/#/orders", created: true } });
    }
    if (command.action === "refresh") return json({ url: managed.origin + "/#/orders", route: registered ? "orders" : null,
      page: "/#/orders", hidden: 8, truncated: true, elements: registered ? [candidates[ORD]![0]] : [proposed] });
    return original(url, init);
  };
  const { root } = await setup("editor", { ...host, fetch: browserFetch });
  expect(options(root, "editor-target")).toEqual([""]);
  expect(button(root, c.preview).disabled).toBe(true);
  await click(root, "Connect Chrome"); await click(root, "Inspect current page");
  expect(root.querySelector(".studio-list-note")?.textContent).toContain("8 elements are not shown");
  expect(root.querySelector(".studio-list-note")?.textContent).toContain("64");
  await click(root, "Register target: Submit order");
  const form = control<HTMLFormElement>(root, "form.studio-register");
  const input = <T extends HTMLElement>(suffix: string) => control<T>(form, `[id$="-register-${suffix}"]`);
  expect(document.activeElement).toBe(form.querySelector("h3"));
  expect(form.textContent).toContain("Live evidence");
  expect(form.textContent).toContain("What will be saved");
  expect(input<HTMLInputElement>("id").readOnly).toBe(true);
  expect(input<HTMLInputElement>("id").value).toBe("orders.submit");
  input<HTMLInputElement>("route").value = "order-list";
  input<HTMLTextAreaElement>("description").value = "Submits the order";
  control<HTMLInputElement>(form, 'input[value="focus"]').checked = true;
  form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
  expect(root.querySelector(".studio-alert")?.getAttribute("role")).toBe("alert");
  expect(root.querySelector(".studio-alert")?.textContent).toContain("Check the highlighted fields");
  expect(document.activeElement).toBe(input("route"));
  expect(registered).toBe(false);
  input<HTMLInputElement>("route").value = "orders";
  form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true })); await turn();
  expect(registered).toBe(true);
  expect(root.querySelector('[data-status="trusted"]')?.textContent).toContain("orders.submit");
  expect(options(root, "editor-target")).toContain("orders.submit");
  expect(control<HTMLSelectElement>(root, "#editor-target").value).toBe("");
  await click(root, "Use: Submit order");
  fill(root, "editor-title", "Orders tour"); fill(root, "editor-description", "Submit orders."); fill(root, "editor-completion", "Done.");
  fill(root, "editor-text", "Press Submit order."); fill(root, "editor-wait", "click", "change");
  expect(button(root, c.preview).disabled).toBe(false);
  const postMessage = vi.fn();
  const child = { closed: false, postMessage } as unknown as Window;
  const send = (data: unknown) => window.dispatchEvent(new MessageEvent("message", { data, origin: managed.origin, source: child }));
  const open = vi.spyOn(window, "open").mockReturnValueOnce(null).mockReturnValue(child);
  try {
    await click(root, c.preview);
    expect(open).toHaveBeenCalledExactlyOnceWith(managed.origin + "/", "_blank");
    expect(notice(root)).toContain("The application window was blocked.");
    await click(root, c.preview);
    expect(notice(root)).toBe("Opening the application window…");
    expect(button(root, c.preview).disabled).toBe(true);
    send({ type: "dap-embed-ready", version: 1 });
    expect(postMessage).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({
      type: "dap-run", version: 1, bundle: expect.objectContaining({
        application: { id: ORD, name: managed.name, origin: managed.origin },
        definition: expect.objectContaining({ title: "Orders tour", steps: expect.arrayContaining([expect.objectContaining({ target: "orders.submit" })]) }),
        registry: expect.objectContaining({ pages: { "/#/orders": "orders" }, postconditionNames: ["route.orders"] }),
      }),
    }), managed.origin);
    send({ type: "dap-run-status", version: 1, status: "WAITING" });
    expect(notice(root)).toBe("Walkthrough running in the application window.");
    send({ type: "dap-run-status", version: 1, status: "COMPLETED" }); await turn();
    expect(notice(root)).toBe("Walkthrough finished.");
    expect(button(root, c.preview).disabled).toBe(false);
    expect(host.writes()).toEqual([]);
  } finally { open.mockRestore(); }
  await click(root, c.save);
  const body = JSON.stringify(host.writes().at(-1)?.body);
  expect(body).toContain("orders.submit");
  expect(body).not.toMatch(/@e\d/);
  expect(JSON.stringify([Object.entries(localStorage), Object.entries(sessionStorage), location.href])).not.toMatch(/@e\d/);
});

it("shows managed routes and target references and confirms a referenced disable before sending the status", async () => {
  let status = "active";
  const host = fakeHost({ apps: [managed] });
  const path = `/api/admin/applications/${ORD}/targets`;
  host.overrides.set(`GET ${path}`, () => json({ targets: [{ ...managedTarget, status }],
    routes: [{ route: "orders", page: "/#/orders" }], limits: { maxTargets: 200, maxRoutes: 20 } }));
  host.overrides.set(`POST ${path}/orders.submit/status`, () => {
    status = String(host.writes().at(-1)?.body?.status);
    return json({ ...managedTarget, status });
  });
  const { root } = await setup("applications", host);
  await click(root, "View registry: Managed orders");
  expect(root.textContent).toContain("orders · /#/orders");
  expect(root.textContent).toContain("2 drafts, 1 published");
  await click(root, "Disable orders.submit");
  const confirm = control(root, "dialog[open]");
  expect(confirm.textContent).toContain("2 drafts and 1 published walkthroughs");
  expect(host.writes()).toEqual([]);
  expect(document.activeElement?.textContent).toBe(c.cancel);
  await click(confirm, "Disable target");
  expect(host.writes().at(-1)?.body).toEqual({ status: "disabled" });
  await click(root, "Enable orders.submit");
  expect(host.writes().at(-1)?.body).toEqual({ status: "active" });
});

it("uses the managed registry for list Publish and defers list Preview to the application window", async () => {
  const host = fakeHost({ apps: [managed], guides: [guide(savedId, "draft", ordersDraft(savedId), ORD)] });
  const registryForOrders = { ...managedRegistry(true), routes: ["home", "orders"], elements: ordersElements,
    pages: { "/": "home", "/#/orders": "orders" }, postconditionNames: ["route.home", "route.orders"] };
  host.overrides.set(`GET /api/admin/applications/${ORD}/registry`, () => json(registryForOrders));
  const { root } = await setup("walkthroughs", host);
  await click(root, "Preview: Orders tour");
  expect(notice(root)).toBe(c.application.windowPreviewFromEditor);
  expect(document.querySelector("[data-ai-overlay]")).toBeNull();
  await click(root, "Publish: Orders tour");
  expect(root.querySelector("dialog[open]")).not.toBeNull();
});
