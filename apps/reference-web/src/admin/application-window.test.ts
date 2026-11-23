import { afterEach, expect, it, vi } from "vitest";
import { runInApplicationWindow } from "./application-window.js";
import { createExternalGuides } from "../external-guides.js";
import { readyMessage, statusMessage } from "../embed/protocol.js";
import type { ManagedBundle, RunStatus } from "../embed/protocol.js";

const app = { id: "app-0123456789ab", name: "Orders app", origin: "http://127.0.0.1:5187" };
const bundle: ManagedBundle = {
  application: app,
  definition: { id: "wt-0123456789ab", title: "Order guide", description: "Use orders.", start: "done", steps: [{ id: "done", kind: "complete", text: "Done." }] },
  registry: { routes: ["home"], elements: [], postconditionNames: ["route.home"], pages: { "/": "home" } },
};
afterEach(() => {
  window.dispatchEvent(new Event("pagehide"));
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.useRealTimers();
});
function harness() {
  vi.useFakeTimers();
  const child = { closed: false, postMessage: vi.fn() };
  const source = child as unknown as Window;
  const open = vi.spyOn(window, "open").mockReturnValue(source);
  const remove = vi.spyOn(window, "removeEventListener");
  const onStatus = vi.fn();
  const send = (data: unknown, origin = app.origin, from = source) => window.dispatchEvent(new MessageEvent("message", { data, origin, source: from }));
  const start = (value: ManagedBundle | (() => Promise<ManagedBundle | null>) = bundle) => runInApplicationWindow({ window, application: app, bundle: value, timeoutMs: 500, onStatus });
  return { child, open, remove, onStatus, send, start };
}
const tick = () => vi.advanceTimersByTimeAsync(0);

it("opens the enrolled origin synchronously, waits for both bundle and a trusted ready, and relays statuses through terminal cleanup", async () => {
  const h = harness();
  let provide!: (value: ManagedBundle) => void;
  const pending = h.start(() => new Promise(resolve => { provide = resolve; }));
  expect(h.open).toHaveBeenCalledExactlyOnceWith(app.origin + "/", "_blank");
  await tick();
  h.send(readyMessage, "https://wrong.example");
  h.send(readyMessage, app.origin, window);
  provide(bundle); await tick();
  expect(h.child.postMessage).not.toHaveBeenCalled();
  h.send(readyMessage); h.send(readyMessage);
  expect(h.child.postMessage).toHaveBeenCalledExactlyOnceWith({ type: "dap-run", version: 1, bundle }, app.origin);
  h.send(statusMessage({ status: "COMPLETED" }), "https://wrong.example");
  h.send(statusMessage({ status: "COMPLETED" }), app.origin, window);
  expect(h.onStatus).not.toHaveBeenCalled();
  h.send(statusMessage({ status: "WAITING" }));
  await vi.advanceTimersByTimeAsync(600);
  expect(h.onStatus.mock.calls).toEqual([[{ status: "WAITING" }]]);
  h.send(statusMessage({ status: "COMPLETED" }));
  expect(await pending).toEqual({ kind: "started" });
  expect(h.onStatus.mock.calls).toEqual([[{ status: "WAITING" }], [{ status: "COMPLETED" }]]);
  expect(h.remove.mock.calls.map(([type]) => type)).toEqual(["message", "pagehide"]);
  expect(vi.getTimerCount()).toBe(0);
});

it("reports a blocked popup, missing embed, owned close, mismatch or explicit refusal", async () => {
  const h = harness();
  h.open.mockReturnValueOnce(null);
  expect(await h.start()).toEqual({ kind: "popup_blocked" });
  const missing = h.start();
  expect(await h.start()).toEqual({ kind: "refused", reason: "already_running" });
  await vi.advanceTimersByTimeAsync(500);
  expect(await missing).toEqual({ kind: "no_embed" });
  const closed = h.start();
  h.child.closed = true; await vi.advanceTimersByTimeAsync(250);
  expect(await closed).toEqual({ kind: "closed" });
  h.child.closed = false;
  const invalid = h.start({ ...bundle, application: { ...app, origin: "https://other.example" } });
  expect(await invalid).toEqual({ kind: "refused", reason: "invalid_bundle" });
  const refused = h.start(); await tick(); h.send(readyMessage);
  const status: RunStatus = { status: "refused", reason: "invalid_registry" };
  h.send(statusMessage(status));
  expect(await refused).toEqual({ kind: "refused", reason: "invalid_registry" });
  expect(h.onStatus).toHaveBeenLastCalledWith(status);
  expect(vi.getTimerCount()).toBe(0);
});

it("starts an external guide with a keyboard-focusable name and announces a missing published bundle", async () => {
  const h = harness();
  const publishedBundle = vi.fn(async () => ({ kind: "not-found" as const }));
  const ui = createExternalGuides(window, [{ id: bundle.definition.id, title: "Order guide", description: "Use orders.", application: app }], { publishedBundle });
  document.body.append(ui);
  const button = ui.querySelector("button")!;
  expect(button.getAttribute("aria-label")).toBe("Start in Orders app: Order guide");
  button.focus();
  expect(document.activeElement).toBe(button);
  button.click();
  expect(button.disabled).toBe(true);
  expect(h.open).toHaveBeenCalledExactlyOnceWith(app.origin + "/", "_blank");
  await tick();
  expect(ui.querySelector('[role="status"][aria-live="polite"]')?.textContent).toBe("This published walkthrough is no longer available.");
  expect(publishedBundle).toHaveBeenCalledExactlyOnceWith(bundle.definition.id);
  expect(h.child.postMessage).not.toHaveBeenCalled();
  expect(button.disabled).toBe(false);
});
