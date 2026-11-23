/**
 * Standalone delivery: the launcher, the API calls (no credentials), the inert cases and a complete run, with a fake fetch.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { installEmbed } from "./installer.js";
import { parseGuideList, RUNTIME_KEY } from "./standalone.js";
import type { ManagedBundle } from "./protocol.js";

const api = "http://127.0.0.1:5186";
const scriptSrc = `${api}/dap-embed.js`;
const KEY = "rk-0123456789abcdef0123456789abcdef";
const guides = { guides: [{ id: "wt-profile", title: "Change display name", description: "Change your display name" }, { id: "wt-other", title: "Other guide", description: "Something else" }] };
const bundle = (): ManagedBundle => ({
  application: { id: "app-0123456789ab", name: "Profile", origin: window.location.origin },
  registry: { routes: ["home", "profile"], routing: "history", pages: { "/": "home", "/profile": "profile" }, postconditionNames: ["route.home", "route.profile"],
    elements: [{ id: "nav.profile", marker: "nav.profileLink", role: "link", route: "home", label: "Profile", description: "Profile link", operations: ["highlight", "click"], privacy: "public" }] },
  definition: { id: "wt-profile", title: "Change display name", description: "Change your display name", start: "open", steps: [
    { id: "open", kind: "guide", target: "nav.profile", text: "Open your profile.", wait: "click", verify: "route.profile", next: "done" },
    { id: "done", kind: "complete", text: "Finished." }] },
});
const json = (body: unknown, status = 200, type = "application/json") => new Response(JSON.stringify(body), { status, headers: { "content-type": type } });
const settle = async () => { for (let i = 0; i < 8; i += 1) await Promise.resolve(); await new Promise(resolve => setTimeout(resolve, 0)); };

afterEach(() => {
  window.dispatchEvent(new Event("pagehide"));
  document.body.replaceChildren();
  document.head.replaceChildren();
  window.history.replaceState(null, "", "/");
  vi.restoreAllMocks();
});

function install(fetcher: typeof fetch, over: Record<string, unknown> = {}) {
  installEmbed(window, { key: KEY, scriptSrc, fetch: fetcher, ...over });
  // jsdom loads no resources: the stylesheet "arrives" now (a real browser fires load, or error when the policy blocks it).
  document.querySelector("link[data-dap-embed]")?.dispatchEvent(new Event("load"));
  return settle();
}
const launcher = () => document.querySelector<HTMLElement>(".dap-launcher");
const trigger = () => document.querySelector<HTMLButtonElement>(".dap-launcher-button");
const panel = () => document.querySelector<HTMLElement>(".dap-launcher-panel");

describe("standalone launcher", () => {
  it("lists the guides from the script's origin without credentials and shows an accessible launcher", async () => {
    const fetcher = vi.fn(async () => json(guides)) as unknown as typeof fetch;
    await install(fetcher);
    const [url, init] = (fetcher as unknown as { mock: { calls: [string, RequestInit][] } }).mock.calls[0]!;
    expect(url).toBe(`${api}/api/runtime/${KEY}/guides`);
    expect(init).toMatchObject({ method: "GET", mode: "cors", credentials: "omit", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer" });
    expect(Object.keys(init.headers as object)).toEqual(["accept"]);
    expect(trigger()?.textContent).toBe("Guides");
    expect(trigger()?.getAttribute("aria-expanded")).toBe("false");
    expect(panel()?.hidden).toBe(true);
    expect(document.querySelector("[role=status][aria-live=polite]")).not.toBeNull();
    expect(Object.isFrozen((window as unknown as { DapEmbed: object }).DapEmbed)).toBe(true);
    expect((window as unknown as { DapEmbed: { version: number } }).DapEmbed.version).toBe(1);
    // No inline style, no style element, no style attribute anywhere in what the embed added.
    expect(document.querySelector("style")).toBeNull();
    expect(document.querySelectorAll("[style]").length).toBe(0);
    expect(document.head.querySelector("link[rel=stylesheet]")?.getAttribute("href")).toBe(`${api}/dap-embed.css`);
  });

  it("opens the panel with the guide list, moves focus into it, closes with Escape and returns focus to the launcher", async () => {
    await install((async () => json(guides)) as unknown as typeof fetch);
    trigger()!.click();
    expect(panel()?.hidden).toBe(false);
    expect(panel()?.getAttribute("role")).toBe("dialog");
    expect(document.getElementById(panel()!.getAttribute("aria-labelledby")!)?.textContent).toBe("Guides");
    expect(trigger()?.getAttribute("aria-expanded")).toBe("true");
    expect([...panel()!.querySelectorAll("li button")].map(item => item.getAttribute("aria-label"))).toEqual(["Start guide: Change display name", "Start guide: Other guide"]);
    expect(document.activeElement).toBe(panel()!.querySelector("li button"));
    panel()!.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    expect(panel()?.hidden).toBe(true);
    expect(trigger()?.getAttribute("aria-expanded")).toBe("false");
    expect(document.activeElement).toBe(trigger());
    trigger()!.click();
    panel()!.querySelector<HTMLButtonElement>(".dap-launcher-close")!.click();
    expect(document.activeElement).toBe(trigger());
  });

  it("starts a guide: fetches its bundle, hides the launcher while it runs, shows it again after the result dialog is dismissed", async () => {
    const calls: string[] = [];
    const fetcher = (async (url: string) => { calls.push(url); return url.endsWith("/guides") ? json(guides) : json(bundle()); }) as unknown as typeof fetch;
    const nav = document.createElement("a"); nav.dataset.aiId = "nav.profileLink"; nav.href = "/profile"; nav.textContent = "Profile";
    nav.addEventListener("click", event => { event.preventDefault(); window.history.pushState(null, "", "/profile"); window.dispatchEvent(new PopStateEvent("popstate")); });
    document.body.append(nav);
    await install(fetcher, { trustedEventsOnly: false });
    trigger()!.click();
    panel()!.querySelector<HTMLButtonElement>("li button")!.click();
    await settle();
    expect(calls).toEqual([`${api}/api/runtime/${KEY}/guides`, `${api}/api/runtime/${KEY}/guides/wt-profile`]);
    expect(launcher()?.hidden).toBe(true);
    expect(document.querySelector(".dap-guide-card")?.textContent).toContain("Open your profile.");
    nav.click(); await settle();
    expect(document.querySelector("dialog")?.textContent).toContain("Finished.");
    document.querySelector<HTMLButtonElement>("dialog button")!.click();
    expect(document.querySelector(".dap-guide-card")).toBeNull();
    expect(launcher()?.hidden).toBe(false);
    expect(document.activeElement).toBe(trigger());
  });

  it("window.DapEmbed.list() and start() work, start refuses a second concurrent run and unknown ids", async () => {
    const fetcher = (async (url: string) => (url.endsWith("/guides") ? json(guides) : url.endsWith("/wt-profile") ? json(bundle()) : json({}, 404))) as unknown as typeof fetch;
    const nav = document.createElement("a"); nav.dataset.aiId = "nav.profileLink"; document.body.append(nav);
    await install(fetcher);
    const embed = (window as unknown as { DapEmbed: { list(): Promise<unknown>; start(id: string): Promise<unknown> } }).DapEmbed;
    await expect(embed.list()).resolves.toEqual(guides.guides);
    await expect(embed.start("not valid!")).resolves.toEqual({ ok: false, reason: "unknown_guide" });
    await expect(embed.start("wt-missing")).resolves.toEqual({ ok: false, reason: "unavailable" });
    await expect(embed.start("wt-profile")).resolves.toEqual({ ok: true });
    await expect(embed.start("wt-profile")).resolves.toEqual({ ok: false, reason: "busy" });
  });

  it("refuses a bundle of another application origin or another guide id, with the polite status", async () => {
    const other = { ...bundle(), application: { ...bundle().application, origin: "https://other.invalid" } };
    const mismatch = bundle(); // a bundle of guide wt-profile served for the id wt-other
    const fetcher = (async (url: string) => (url.endsWith("/guides") ? json(guides) : url.endsWith("/wt-profile") ? json(other) : json(mismatch))) as unknown as typeof fetch;
    await install(fetcher);
    const embed = (window as unknown as { DapEmbed: { start(id: string): Promise<unknown> } }).DapEmbed;
    await expect(embed.start("wt-profile")).resolves.toEqual({ ok: false, reason: "wrong_page" });
    expect(document.querySelector(".dap-live")?.textContent).toBe("This guide is not available on this page.");
    await expect(embed.start("wt-other")).resolves.toEqual({ ok: false, reason: "invalid_guide" });
    expect(document.querySelector(".dap-guide-card")).toBeNull();
  });
});

describe("standalone is inert", () => {
  const nothing = () => { expect(launcher()).toBeNull(); expect(Object.hasOwn(window, "DapEmbed")).toBe(false); };
  it.each([
    ["a wrong key shape", { key: "rk-short" }], ["an uppercase key", { key: KEY.toUpperCase() }], ["a non-string key", { key: 5 }], ["a key with a suffix", { key: KEY + "0" }],
  ])("%s: no request, no launcher, no global", async (_label, over) => {
    const fetcher = vi.fn();
    await install(fetcher as unknown as typeof fetch, over);
    expect(fetcher).not.toHaveBeenCalled();
    nothing();
  });
  it("without a script URL there is nothing to call", async () => {
    const fetcher = vi.fn();
    await install(fetcher as unknown as typeof fetch, { scriptSrc: undefined });
    expect(fetcher).not.toHaveBeenCalled(); nothing();
  });
  it.each([
    ["a refused Origin (403)", async () => json({ error: "forbidden" }, 403)], ["an unknown key (404)", async () => json({ error: "not_found" }, 404)], ["a rate limit (429)", async () => json({}, 429)],
    ["a network error", async () => { throw new TypeError("Failed to fetch"); }], ["a non-JSON reply", async () => new Response("<html>", { status: 200, headers: { "content-type": "text/html" } })],
    ["invalid JSON", async () => new Response("{", { status: 200, headers: { "content-type": "application/json" } })], ["an oversized reply", async () => new Response("x".repeat(262_145), { status: 200, headers: { "content-type": "application/json" } })],
    ["a list with an extra key", async () => json({ guides: [], extra: 1 })], ["a guide with an extra key", async () => json({ guides: [{ ...guides.guides[0], extra: 1 }] })],
    ["a guide title with markup", async () => json({ guides: [{ ...guides.guides[0], title: "<b>x</b>" }] })], ["an invalid guide id", async () => json({ guides: [{ ...guides.guides[0], id: "1 bad" }] })],
    ["51 guides", async () => json({ guides: Array.from({ length: 51 }, (_, i) => ({ id: `g${i}`, title: "t", description: "d" })) })], ["a duplicate guide id", async () => json({ guides: [guides.guides[0], guides.guides[0]] })],
    ["an array instead of an object", async () => json([])],
  ])("%s: no launcher, no global, nothing added to the page", async (_label, reply) => {
    await install(reply as unknown as typeof fetch);
    nothing();
    expect(document.body.children.length).toBe(0);
    expect(document.head.querySelector("link[data-dap-embed]")).toBeNull();
  });
  it("an empty list shows no launcher either (nothing to offer)", async () => {
    await install((async () => json({ guides: [] })) as unknown as typeof fetch);
    expect(launcher()).toBeNull();
  });
  it("Studio's own window (opener + origin) wins over a key", async () => {
    const opener = { postMessage: vi.fn() } as unknown as Window;
    Object.defineProperty(window, "opener", { value: opener, configurable: true });
    const fetcher = vi.fn();
    await install(fetcher as unknown as typeof fetch, { dapOrigin: "http://127.0.0.1:5186" });
    expect(fetcher).not.toHaveBeenCalled();
    expect(launcher()).toBeNull();
    Object.defineProperty(window, "opener", { value: null, configurable: true });
  });
  it("a second install does not replace the first API", async () => {
    await install((async () => json(guides)) as unknown as typeof fetch);
    const first = (window as unknown as { DapEmbed: object }).DapEmbed;
    await install((async () => json(guides)) as unknown as typeof fetch);
    expect((window as unknown as { DapEmbed: object }).DapEmbed).toBe(first);
    expect(document.querySelectorAll(".dap-launcher").length).toBe(1);
  });
});

describe("pagehide removes everything the embed added", () => {
  it("launcher, stylesheet link and the global", async () => {
    await install((async () => json(guides)) as unknown as typeof fetch);
    window.dispatchEvent(new Event("pagehide"));
    expect(launcher()).toBeNull();
    expect(document.head.querySelector("link[data-dap-embed]")).toBeNull();
    expect(Object.hasOwn(window, "DapEmbed")).toBe(false);
  });
});

describe("parseGuideList / key", () => {
  it("accepts the exact documented shape", () => { expect(parseGuideList(guides)).toEqual(guides.guides); expect(RUNTIME_KEY.test(KEY)).toBe(true); });
  it.each([null, undefined, 5, "x", [], {}, { guides: {} }, { guides: [null] }, { guides: [[]] }, { guides: [{ id: "a" }] }])("refuses %j", value => { expect(parseGuideList(value)).toBeNull(); });
});
