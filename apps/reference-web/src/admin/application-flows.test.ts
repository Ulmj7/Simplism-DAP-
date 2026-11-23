/** Application-aware editor and Application Manager flows against a fake host: registry selection and its retry, the announced 422 issues and the strict registry parser. */
import { afterEach, expect, it, vi } from "vitest";
import { boot } from "../browser.js";
import { copy } from "../copy.js";
import type { FetchLike } from "../help/client.js";
import { setEditSession, takeRequestedEdit, writeRole } from "./session.js";

const c = copy.admin;
const REF = "app-00000000000a";
const ORD = "app-00000000000b";
const stamp = "2026-11-23T10:00:00.000Z";
const apps = [REF, ORD].map((id, index) => ({
  id, name: index === 0 ? "Reference application" : "Orders application", origin: `http://127.0.0.1:${5173 + index}`, allowedOrigins: [`http://127.0.0.1:${5173 + index}`],
  environment: "development", registryId: index === 0 ? "reference" : "fixture-b", source: "built-in", enabled: true, updatedAt: stamp, routing: "hash", runtimeAccess: false, runtimeKey: null, counts: { targets: 0, drafts: 0, published: 0 },
}));
const element = (id: string, route: string, role: string, label: string) => ({ id, route, role, label, description: `${label} control`, operations: ["highlight", "click"], privacy: "public" });
const registries: Record<string, object> = {
  [REF]: { routes: ["dashboard"], elements: [element("nav.profile", "dashboard", "link", "Profile link")], postconditionNames: ["route.profile"], previewable: true, source: "built-in", pages: {}, previewMode: "in-app" },
  [ORD]: { routes: ["home", "orders"], elements: [element("orders.submit", "orders", "button", "Submit order")], postconditionNames: ["order.submitted"], previewable: false, source: "built-in", pages: {}, previewMode: "in-app" },
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

function fakeHost() {
  const requests: string[] = [];
  const failRegistry = new Set<string>();
  const fetch: FetchLike = async (path, init) => {
    requests.push(`${init.method} ${path}`);
    if (path === "/api/walkthroughs/published") return json({ walkthroughs: [] });
    if (new Headers(init.headers).get("x-demo-role") !== "maintainer") return json({ message: "x" }, 403);
    if (path === "/api/admin/walkthroughs") return json({ builtIn: [], authored: [] });
    if (path === "/api/admin/analytics") return json({ totals: { started: 0, completed: 0, cancelled: 0, completionRate: null }, guides: [] });
    if (path === "/api/admin/applications" && init.method === "POST") return json({ kind: "invalid", message: "Invalid", issues: ["origin: must use http or https"] }, 422);
    if (path === "/api/admin/applications") return json({ applications: apps, registries: [{ id: "reference", label: "Reference", source: "built-in" }, { id: "fixture-b", label: "B", source: "built-in" }] });
    const registry = /^\/api\/admin\/applications\/(app-[a-f0-9]{12})\/registry$/u.exec(path);
    if (registry) return failRegistry.has(registry[1]!) ? json({ message: "down" }, 503) : json(registries[registry[1]!]);
    return json({}, 404);
  };
  return { fetch, requests, failRegistry };
}

let mounted: Awaited<ReturnType<typeof boot>> | undefined;
afterEach(() => {
  mounted?.destroy(); mounted = undefined; setEditSession(); takeRequestedEdit(); sessionStorage.clear();
  document.body.replaceChildren(); window.history.replaceState(null, "", "#/dashboard"); vi.useRealTimers();
});
const turn = () => vi.advanceTimersByTimeAsync(10);
async function openEditor(host = fakeHost()) {
  vi.useFakeTimers();
  window.history.replaceState(null, "", "#/editor");
  writeRole(window, "maintainer");
  const root = document.createElement("div"); document.body.append(root);
  mounted = await boot(root, { fetch: host.fetch, trustedEventsOnly: false, demoRoleEnabled: true });
  await turn();
  return { root, host };
}
const select = (root: ParentNode) => root.querySelector<HTMLSelectElement>("#editor-application")!;
const choose = async (root: ParentNode, value: string) => { const s = select(root); s.value = value; s.dispatchEvent(new Event("change", { bubbles: true })); await turn(); };
const targets = (root: ParentNode) => [...root.querySelectorAll<HTMLOptionElement>("#editor-target option")].map(item => item.value).filter(Boolean);

it("characterization: choosing another application replaces the target list and never mixes the registries", async () => {
  const { root } = await openEditor();
  await choose(root, REF);
  expect(targets(root)).toEqual(["nav.profile"]);
  await choose(root, ORD);
  expect(targets(root)).toEqual(["orders.submit"]);
});

it("characterization: when an application's registry cannot be loaded the editor offers no targets (never the previous application's) and says so", async () => {
  const host = fakeHost();
  host.failRegistry.add(ORD);
  const { root } = await openEditor(host);
  await choose(root, REF);
  await choose(root, ORD);
  expect(targets(root)).toEqual([]);
  expect(root.querySelector('[role="status"]')?.textContent).toBe(c.application.registryFailed);
});

it("after a failed registry load the selector is back at its placeholder, so choosing the same application again really retries (as the message says)", async () => {
  const host = fakeHost();
  host.failRegistry.add(ORD);
  const { root } = await openEditor(host);
  await choose(root, ORD);
  expect(root.querySelector('[role="status"]')?.textContent).toBe(c.application.registryFailed);
  expect(select(root).value).toBe(""); // nothing is selected any more: the same choice is a real change
  host.failRegistry.delete(ORD); // the host is back
  const before = host.requests.filter(request => request.endsWith("/registry")).length;
  await choose(root, ORD); // "Choose it again"
  expect(host.requests.filter(request => request.endsWith("/registry")).length).toBe(before + 1);
  expect(targets(root)).toEqual(["orders.submit"]);
  expect(select(root).value).toBe(ORD);
  expect(root.querySelector('[role="status"]')?.textContent).toBe("");
});

it("a failed load leaves the draft without an application (nothing to save against, nothing connectable) until one is chosen again", async () => {
  const host = fakeHost();
  host.failRegistry.add(ORD);
  const { root } = await openEditor(host);
  await choose(root, ORD);
  const connect = [...root.querySelectorAll("button")].find(button => button.textContent === "Connect Chrome");
  expect(connect).toBeDefined();
  expect(connect!.disabled).toBe(true);
  expect(targets(root)).toEqual([]);
});

it("switching to another application and back still works after a failure", async () => {
  const host = fakeHost();
  host.failRegistry.add(ORD);
  const { root } = await openEditor(host);
  await choose(root, ORD);
  host.failRegistry.delete(ORD);
  await choose(root, REF);
  await choose(root, ORD);
  expect(targets(root)).toEqual(["orders.submit"]);
});

it("the 422 issues of the Application Manager are announced to assistive technology (alert role) and tied to the submit button", async () => {
  vi.useFakeTimers();
  window.history.replaceState(null, "", "#/applications");
  writeRole(window, "maintainer");
  const root = document.createElement("div"); document.body.append(root);
  mounted = await boot(root, { fetch: fakeHost().fetch, trustedEventsOnly: false, demoRoleEnabled: true });
  await turn();
  const set = (id: string, value: string) => { const control = root.querySelector<HTMLInputElement>(`#${id}`)!; control.value = value; control.dispatchEvent(new Event("input", { bubbles: true })); };
  set("application-name", "App"); set("application-origin", "ftp://x");
  root.querySelector<HTMLFormElement>("form")!.requestSubmit();
  await turn();
  const issues = root.querySelector<HTMLElement>("#application-issues")!;
  expect(issues.textContent).toContain("origin: must use http or https");
  expect(issues.getAttribute("role")).toBe("alert");
  expect(issues.hidden).toBe(false);
  expect(root.querySelector('button[type="submit"]')?.getAttribute("aria-describedby")).toBe("application-issues");
  expect(root.querySelector("#application-issues")).toBe(issues);
});

it("the strict registry parser still refuses a reply whose postcondition names are not dotted (the host catalog refuses such an entry at composition time, so it can never be served)", async () => {
  const { parseApplicationRegistry } = await import("./applications.js");
  const reply = (name: string) => ({ routes: ["home"], elements: [element("nav.home", "home", "link", "Home link")], postconditionNames: [name], previewable: false, source: "built-in", pages: {}, previewMode: "in-app" });
  expect(parseApplicationRegistry(reply("saved"))).toBeNull();
  expect(parseApplicationRegistry(reply(`orders.${"a".repeat(74)}`))).toBeNull();
  expect(parseApplicationRegistry(reply("order.saved"))).not.toBeNull();
  expect(parseApplicationRegistry(reply(`orders.${"a".repeat(73)}`))).not.toBeNull();
});
