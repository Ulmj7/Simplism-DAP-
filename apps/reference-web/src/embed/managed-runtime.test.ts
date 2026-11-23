import { afterEach, expect, it, vi } from "vitest";
import { installEmbed } from "./installer.js";
import { managedRouter } from "./managed-runtime.js";
import { isReady, parseBundle, parseRun, parseStatus, readyMessage, runMessage, statusMessage } from "./protocol.js";
import type { ManagedBundle } from "./protocol.js";

const dapOrigin = "http://127.0.0.1:5186";
const make = (): ManagedBundle => ({
  application: { id: "app-0123456789ab", name: "Orders", origin: window.location.origin },
  registry: {
    routes: ["home", "orders"], pages: { "/": "home", "/#/orders": "orders" }, postconditionNames: ["route.home", "route.orders"],
    elements: [
      { id: "nav.orders", role: "link", route: "home", label: "Orders", description: "Orders link", operations: ["highlight", "click"], privacy: "public" },
      { id: "orders.note", role: "textbox", route: "orders", label: "Note", description: "Order note", operations: ["highlight", "input"], privacy: "public" },
    ],
  },
  definition: { id: "wt-0123456789ab", title: "Open Orders", description: "Guide to Orders", start: "open", steps: [
    { id: "open", kind: "guide", target: "nav.orders", text: "Open the Orders page.", wait: "click", verify: "route.orders", next: "note" },
    { id: "note", kind: "guide", target: "orders.note", text: "Enter a note.", wait: "input", next: "done" },
    { id: "done", kind: "complete", text: "Order walkthrough complete." },
  ] },
});
const beforeOpener = window.opener;
afterEach(() => {
  window.dispatchEvent(new Event("pagehide"));
  window.opener = beforeOpener;
  document.body.replaceChildren();
  window.history.replaceState(null, "", "/");
  vi.useRealTimers();
});

function harness() {
  const postMessage = vi.fn();
  const opener = { postMessage } as unknown as Window;
  window.opener = opener;
  const send = (data: unknown, origin = dapOrigin, source = opener) => window.dispatchEvent(new MessageEvent("message", { data, origin, source }));
  return { postMessage, opener, send, statuses: () => postMessage.mock.calls.map(([message]) => message.status).filter(Boolean) };
}
it("checks exact envelopes and rejects unknown versions, statuses, reasons and shapes", () => {
  const bundle = make();
  expect(isReady(readyMessage)).toBe(true);
  expect(isReady({ ...readyMessage, version: 2 })).toBe(false);
  expect(isReady({ ...readyMessage, extra: true })).toBe(false);
  expect(parseRun(runMessage(bundle))).toEqual({ ok: true, bundle });
  expect(parseRun({ ...runMessage(bundle), version: 2 })).toEqual({ ok: false, reason: "unsupported_version" });
  expect(parseRun({ ...runMessage(bundle), other: [] })).toEqual({ ok: false, reason: "invalid_bundle" });
  expect(parseRun("dap-run")).toBeNull();
  expect(parseStatus(statusMessage({ status: "refused", reason: "invalid_registry" }))).toEqual({ status: "refused", reason: "invalid_registry" });
  expect(parseStatus(statusMessage({ status: "WAITING" }))).toEqual({ status: "WAITING" });
  expect(parseStatus({ ...statusMessage({ status: "WAITING" }), extra: true })).toBeNull();
  expect(parseStatus({ ...statusMessage({ status: "WAITING" }), status: "IDLE" })).toBeNull();
  expect(parseStatus({ ...statusMessage({ status: "WAITING" }), status: "refused", reason: "raw exception" })).toBeNull();
});

it("bounds lists and strings, rejects extra keys or non-plain data, and takes an independent copy", () => {
  const bundle = make();
  const routes = Array.from({ length: 20 }, (_, i) => `route${i}`);
  const pages = Object.fromEntries(routes.map(route => [`/#/${route}`, route]));
  const elements = Array.from({ length: 200 }, (_, i) => ({ ...bundle.registry.elements[0]!, id: `nav.target${i}` }));
  const registry = { routes, pages, elements, postconditionNames: routes.map(route => `route.${route}`) };
  const steps = Array.from({ length: 24 }, () => bundle.definition.steps[0]!);
  expect(parseBundle({ ...bundle, registry, definition: { ...bundle.definition, steps } }).ok).toBe(true);
  for (const value of [
    undefined, [], { ...bundle, extra: 1 }, { ...bundle, application: { ...bundle.application, name: "n".repeat(81) } },
    { ...bundle, application: { ...bundle.application, origin: "https://test.invalid/" } },
    { ...bundle, definition: { ...bundle.definition, steps: [...steps, steps[0]] } },
    { ...bundle, definition: { ...bundle.definition, steps: [{ ...steps[0], text: "x".repeat(241) }] } },
    { ...bundle, definition: { ...bundle.definition, steps: [{ ...steps[0], targetWaitMs: 10_001 }] } },
    { ...bundle, definition: { ...bundle.definition, steps: [{ ...steps[0], maxAttempts: 11 }] } },
    { ...bundle, definition: { ...bundle.definition, steps: [Object.create(steps[0]!)] } },
    { ...bundle, definition: { ...bundle.definition, steps: [Object.defineProperty({ ...steps[0] }, "id", { enumerable: false })] } },
    { ...bundle, definition: { ...bundle.definition, steps: [{ ...steps[0], extra: 1 }] } },
    { ...bundle, definition: { ...bundle.definition, steps: Array(1) } },
    { ...bundle, registry: { ...registry, elements: [...elements, elements[0]] } },
    { ...bundle, registry: { ...registry, routes: [...routes, "extra"] } },
    { ...bundle, registry: { ...registry, postconditionNames: Array(51).fill("route.home") } },
    { ...bundle, registry: { ...registry, pages: { ...pages, "/#/wrong": "wrong" } } },
    { ...bundle, registry: { ...registry, pages: JSON.parse('{"__proto__":"home"}') } },
    { ...bundle, registry: { ...bundle.registry, elements: [{ ...bundle.registry.elements[0], privacy: "private" }] } },
  ]) expect(parseBundle(value).ok).toBe(false);
  const result = parseBundle(bundle);
  expect(result.ok && result.bundle.definition.steps[0]).not.toBe(bundle.definition.steps[0]);
});

it("maps exact pages and sets only a hash for a page on the current pathname", () => {
  const location = { pathname: "/", hash: "" };
  const router = managedRouter(location, { "/": "home", "/#/orders": "orders", "/another#/orders": "another" });
  expect(router.current()).toBe("home");
  router.navigate("orders"); expect(location.hash).toBe("#/orders");
  expect(router.current()).toBe("orders");
  router.navigate("another"); expect(location.hash).toBe("#/orders");
  router.navigate("unknown"); expect(location.hash).toBe("#/orders");
  location.hash = "#/unmapped"; expect(router.current()).toBe("");
  router.navigate("home"); expect(location.hash).toBe("");
});

it("ignores foreign origins and sources, then completes the real deterministic run from application DOM events", async () => {
  vi.useFakeTimers();
  window.history.replaceState(null, "", "/");
  const link = document.createElement("a");
  link.dataset.aiId = "nav.orders"; link.href = "#/orders"; link.textContent = "Orders";
  const input = document.createElement("input");
  input.dataset.aiId = "orders.note"; input.hidden = true;
  document.body.append(link, input);
  link.addEventListener("click", event => {
    event.preventDefault(); input.hidden = false; history.replaceState(null, "", "/#/orders"); window.dispatchEvent(new Event("hashchange"));
  });
  const { postMessage, send, statuses } = harness();
  installEmbed(window, dapOrigin, "/* scoped test style */", false);
  expect(postMessage).toHaveBeenCalledExactlyOnceWith(readyMessage, dapOrigin);
  const command = runMessage(make());
  send(command, "https://wrong.test");
  send(command, dapOrigin, window);
  expect(document.querySelector(".dap-guide-card")).toBeNull();
  send(command);
  expect(document.querySelector(".dap-guide-card")?.textContent).toContain("Open the Orders page.");
  send(command);
  expect(postMessage).toHaveBeenLastCalledWith(statusMessage({ status: "refused", reason: "already_running" }), dapOrigin);
  link.click(); await vi.advanceTimersByTimeAsync(5);
  expect(statuses()).toContain("VERIFYING");
  expect(document.querySelector(".dap-guide-card")?.textContent).toContain("Enter a note.");
  input.value = "Test note"; input.dispatchEvent(new Event("input", { bubbles: true })); await vi.advanceTimersByTimeAsync(5);
  expect(statuses().at(-1)).toBe("COMPLETED");
  expect(document.querySelector("dialog")?.textContent).toContain("Order walkthrough complete.");
  window.dispatchEvent(new Event("pagehide"));
  expect(document.querySelector("dialog")).toBeNull();
  expect(document.head.textContent).not.toContain("scoped test style");
});

it("stays inert without an opener or with invalid configuration and cancels an active run on pagehide", () => {
  window.opener = null;
  expect(() => installEmbed(window, dapOrigin, "")).not.toThrow();
  const { send, statuses, postMessage } = harness();
  installEmbed(window, dapOrigin + "/", "");
  expect(postMessage).not.toHaveBeenCalled();
  installEmbed(window, dapOrigin, "");
  send(runMessage(make()));
  window.dispatchEvent(new Event("pagehide"));
  expect(statuses().at(-1)).toBe("CANCELLED");
  expect(document.querySelector(".dap-guide-card")).toBeNull();
});

it("refuses a definition that does not validate against the actual registry", () => {
  const { send, postMessage } = harness();
  installEmbed(window, dapOrigin, "");
  const bundle = make();
  send(runMessage({ ...bundle, registry: { ...bundle.registry, elements: [] } }));
  expect(postMessage).toHaveBeenLastCalledWith(statusMessage({ status: "refused", reason: "invalid_bundle" }), dapOrigin);
  expect(document.querySelector(".dap-guide-card")).toBeNull();
});
