import { afterEach, describe, expect, it, vi } from "vitest";
import { createSimplism } from "./sdk.js";
import type { Simplism } from "./sdk.js";
import type { ManagedBundle } from "./protocol.js";

const config = { applicationId: "app-000000000001", runtimeKey: "rk-test-runtime", apiOrigin: "https://runtime.example", stylesheetUrl: "/assets/simplism.css" };
const listed = { id: "wt-000000000001", title: "Update profile", description: "Save the profile." };
const secondGuide = { id: "wt-000000000002", title: "Update display name", description: "Save the new display name." };
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
const bundle = (): ManagedBundle => ({
  application: { id: config.applicationId, name: "Customer portal", origin: window.location.origin },
  registry: { routes: ["home", "other"], routing: "history", pages: { "/": "home", "/other": "other" },
    postconditionNames: ["route.home", "route.other"], elements: [
      { id: "profile.save", marker: "profile.saveNow", route: "home", role: "button", label: "Save", description: "Save the profile.", operations: ["highlight", "click"], privacy: "public" },
    ] },
  definition: { ...listed, start: "save", steps: [
    { id: "save", kind: "guide", wait: "click", target: "profile.save", text: "Click Save.", verify: "route.home", next: "done" },
    { id: "done", kind: "complete", text: "Changes saved." },
  ] },
});
const root = () => document.querySelector<HTMLElement>("[data-simplism-runtime]");
const panel = () => root()?.querySelector<HTMLElement>("[role=dialog]");
const launcher = () => root()?.querySelector("button.dap-launcher-button");
const owned = () => document.querySelector(".dap-guide-card, .dap-result, .dap-guide-ring");
const button = (label: string) => [...(root()?.querySelectorAll("button") ?? [])].find(item => item.textContent === label);
const fetchMock = (value = bundle()) => vi.fn<typeof fetch>(async (url): Promise<Response> => String(url).includes(`/${listed.id}?`) ? response(value) : response({ guides: [listed] }));
function init(fetcher: typeof fetch): Simplism {
  vi.stubGlobal("fetch", fetcher);
  const result = createSimplism(config);
  if (!result.ok) throw new Error(result.code);
  return result.value;
}

afterEach(() => {
  window.dispatchEvent(new Event("pagehide"));
  document.body.replaceChildren();
  document.head.replaceChildren();
  history.replaceState(null, "", "/");
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("public Simplism SDK lifecycle", () => {
  it("starts once, shares pending bootstrap, refuses a competing config, and preserves host resources on destroy", async () => {
    const fetcher = fetchMock();
    const runtime = init(fetcher);
    const existing = document.createElement("link");
    existing.rel = "stylesheet";
    existing.href = "/assets/simplism.css";
    document.head.append(existing);
    const unrelated = document.createElement("button");
    document.body.append(unrelated);
    expect(createSimplism({ ...config })).toEqual({ ok: true, value: runtime });
    expect(createSimplism({ ...config, applicationId: "app-000000000002" })).toEqual({ ok: false, code: "ALREADY_INITIALIZED" });
    const first = runtime.start();
    expect(runtime.start()).toBe(first);
    expect(await first).toEqual({ ok: true, value: [listed] });
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(
      `${config.apiOrigin}/api/runtime/${config.runtimeKey}/guides?applicationId=${config.applicationId}`,
      expect.objectContaining({ credentials: "omit", redirect: "error", mode: "cors" }),
    );
    expect(document.querySelectorAll("[data-simplism-runtime]")).toHaveLength(1);
    expect(document.querySelectorAll("link")).toHaveLength(1);
    runtime.destroy();
    runtime.destroy();
    expect(root()).toBeNull();
    expect(document.querySelector("link")).toBe(existing);
    expect(unrelated.isConnected).toBe(true);
    await expect(runtime.start()).resolves.toEqual({ ok: false, code: "RUNTIME_DESTROYED" });
    const replacement = createSimplism(config);
    expect(replacement).toMatchObject({ ok: true });
    if (!replacement.ok) throw new Error(replacement.code);
    expect(replacement.value).not.toBe(runtime);
    await expect(replacement.value.start()).resolves.toEqual({ ok: true, value: [listed] });
  });

  it("removes its own stylesheet on destroy", async () => {
    const runtime = init(fetchMock());
    await runtime.start();
    const stylesheet = document.querySelector<HTMLLinkElement>('link[rel="stylesheet"]');
    expect(stylesheet?.href).toBe(new URL(config.stylesheetUrl, window.location.href).href);
    runtime.destroy();
    expect(stylesheet?.isConnected).toBe(false);
  });

  it("announces loading before empty and restores focus when dismissed with Escape", async () => {
    let resolve!: (data: Response) => void;
    const runtime = init(vi.fn(() => new Promise<Response>(resolveReply => { resolve = resolveReply; })));
    const opening = runtime.openLauncher();
    expect(panel()?.textContent).toContain("Loading guides");
    expect(panel()?.textContent).not.toContain("No guides");
    resolve(response({ guides: [] }));
    await expect(opening).resolves.toMatchObject({ ok: true });
    expect(panel()?.textContent).toContain("No guides are available for this application.");
    panel()?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(panel()?.hidden).toBe(true);
    expect(document.activeElement).toBe(launcher());
  });

  it("only offers Retry for a transient delivery failure and replaces the failure on success", async () => {
    const fetcher = vi.fn<typeof fetch>().mockRejectedValueOnce(new Error("internal error")).mockResolvedValueOnce(response({ guides: [listed] }));
    const runtime = init(fetcher);
    await expect(runtime.openLauncher()).resolves.toEqual({ ok: false, code: "NETWORK_UNAVAILABLE" });
    expect(panel()?.textContent).not.toContain("internal error");
    expect(button("Retry")).toBeDefined();
    button("Retry")?.click();
    await runtime.start();
    expect(button("Retry")).toBeUndefined();
    expect(document.activeElement?.getAttribute("aria-label")).toBe(`Start guide: ${listed.title}`);
  });

  it("starts, stops, refetches on restart, and destroys a real mounted guide without replacing host history", async () => {
    const target = document.createElement("button");
    target.dataset.aiId = "profile.saveNow";
    document.body.append(target);
    const fetcher = fetchMock();
    const runtime = init(fetcher);
    const push = history.pushState;
    const replace = history.replaceState;
    await expect(runtime.startGuide("wt-unknown")).resolves.toEqual({ ok: false, code: "GUIDE_NOT_FOUND" });
    expect(fetcher).toHaveBeenCalledTimes(1);
    await expect(runtime.startGuide(listed.id)).resolves.toMatchObject({ ok: true });
    expect(owned()).not.toBeNull();
    expect(root()?.textContent).toContain("Step 1 of 1");
    await expect(runtime.startGuide(listed.id)).resolves.toEqual({ ok: false, code: "GUIDE_BUSY" });
    runtime.stopGuide();
    expect(owned()).toBeNull();
    await expect(runtime.restartGuide()).resolves.toMatchObject({ ok: true });
    expect(fetcher.mock.calls.filter(([url]) => String(url).includes(listed.id))).toHaveLength(2);
    runtime.destroy();
    expect(owned()).toBeNull();
    expect(history.pushState).toBe(push);
    expect(history.replaceState).toBe(replace);
    expect(target.isConnected).toBe(true);
  });

  it.each(["API", "launcher"])("starts the second published guide from the %s", async (entry) => {
    const target = document.createElement("button");
    target.dataset.aiId = "profile.saveNow";
    document.body.append(target);
    const first = bundle();
    const second = { ...first, definition: { ...first.definition, ...secondGuide } };
    const fetcher = vi.fn<typeof fetch>(async url => {
      if (String(url).includes(`/guides/${listed.id}?`)) return response(first);
      if (String(url).includes(`/guides/${secondGuide.id}?`)) return response(second);
      return response({ guides: [listed, secondGuide] });
    });
    const runtime = init(fetcher);
    if (entry === "API") {
      await expect(runtime.startGuide(secondGuide.id)).resolves.toEqual({ ok: true, value: undefined });
    } else {
      await expect(runtime.openLauncher()).resolves.toEqual({ ok: true, value: undefined });
      const choice = panel()?.querySelector<HTMLButtonElement>(`[data-simplism-guide="${secondGuide.id}"]`);
      expect(choice?.getAttribute("aria-label")).toBe(`Start guide: ${secondGuide.title}`);
      choice?.click();
    }
    await vi.waitFor(() => expect(runtime.getRun()).toEqual({ status: "running", guideId: secondGuide.id }));
    const bundleRequests = fetcher.mock.calls.map(([url]) => String(url)).filter(url => url.includes("/guides/"));
    expect(bundleRequests).toEqual([`${config.apiOrigin}/api/runtime/${config.runtimeKey}/guides/${secondGuide.id}?applicationId=${config.applicationId}`]);
  });

  it("refuses a mismatched bundle and never mounts its targets", async () => {
    const value = bundle();
    const runtime = init(fetchMock({ ...value, application: { ...value.application, id: "app-000000000002" } }));
    await expect(runtime.startGuide(listed.id)).resolves.toEqual({ ok: false, code: "INVALID_RESPONSE" });
    expect(owned()).toBeNull();
  });

  it("stops on an unexpected path even if the previous target remains in the DOM", async () => {
    const runtime = init(fetchMock());
    const target = document.createElement("button");
    target.dataset.aiId = "profile.saveNow";
    document.body.append(target);
    await runtime.startGuide(listed.id);
    history.pushState(null, "", "/other?tab=1");
    target.click();
    expect(owned()).toBeNull();
    expect(runtime.getRun()).toEqual({ status: "failed", guideId: listed.id, code: "ROUTE_MISMATCH" });
    expect(root()?.textContent).toContain("can't continue on the current page");
  });

  it("aborts a pending bundle when stopped and a pending list on destruction", async () => {
    const signals: AbortSignal[] = [];
    const fetcher = vi.fn<typeof fetch>().mockImplementation((url, options) => {
      signals.push(options!.signal!);
      if (signals.length === 1 && String(url).includes("/guides?")) return Promise.resolve(response({ guides: [listed] }));
      return new Promise((_, reject) => options!.signal!.addEventListener("abort", () => reject(new Error("aborted")), { once: true }));
    });
    const runtime = init(fetcher);
    await runtime.start();
    const starting = runtime.startGuide(listed.id);
    await Promise.resolve();
    runtime.stopGuide();
    expect(signals[1]?.aborted).toBe(true);
    await expect(starting).resolves.toEqual({ ok: false, code: "GUIDE_STOPPED" });
    const refreshing = runtime.listGuides();
    runtime.destroy();
    await expect(refreshing).resolves.toEqual({ ok: false, code: "RUNTIME_DESTROYED" });
    expect(signals.slice(1)).toHaveLength(2);
    expect(signals.slice(1).every(signal => signal.aborted)).toBe(true);
    expect(root()).toBeNull();
  });
});
