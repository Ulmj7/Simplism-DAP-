// The history-routed fixtures C ("Profile") and D (the "moved" variant) are test infrastructure for the standalone embed and the repair story: prove what they serve and how the page behaves.
import { connect } from "node:net";
import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it } from "vitest";
import { startHistoryApp } from "../fixtures/studio-app/history-app.mjs";
import type { HistoryApp, HistoryAppOptions } from "../fixtures/studio-app/history-app.mjs";

const running: HistoryApp[] = [];
async function start(options?: HistoryAppOptions) {
  const app = await startHistoryApp(options);
  running.push(app);
  return app;
}
afterEach(async () => { await Promise.all(running.splice(0).map(app => app.close())); });
const text = async (url: string, init?: RequestInit) => { const response = await fetch(url, init); return { response, body: await response.text() }; };
const refuses = (port: number, host: string) => new Promise<boolean>(resolve => {
  const socket = connect({ port, host });
  socket.once("connect", () => { socket.destroy(); resolve(false); });
  socket.once("error", () => resolve(true));
});
async function visit(url: string) {
  const dom = await JSDOM.fromURL(url, { runScripts: "dangerously", resources: "usable", pretendToBeVisual: true });
  await new Promise<void>(resolve => { if (dom.window.document.readyState === "complete") resolve(); else dom.window.addEventListener("load", () => resolve()); });
  return dom;
}
const visible = (document: Document) => [...document.querySelectorAll<HTMLElement>("[data-page]")].filter(section => !section.hidden).map(section => section.dataset.page);

describe("history fixture server", () => {
  it("answers every path with the application shell (history fallback), never caches, and keeps query/variant out of routing", async () => {
    const app = await start();
    for (const path of ["/", "/profile", "/settings", "/profile/", "/users/123", "/deep/link/anywhere", "/profile?variant=moved", "/settings?a=1#frag"]) {
      const { response, body } = await text(app.origin + path);
      expect(response.status, path).toBe(200);
      expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(body).toContain('<script src="/app.js"></script>');
      expect(body).toContain('<link rel="stylesheet" href="/app.css">');
      expect(body).not.toMatch(/<style|<script>|\sstyle=|\sonclick=/u);
    }
    const body = (await text(app.origin + "/profile")).body;
    for (const id of ["nav.profile", "nav.settings", "profile.displayName", "profile.save", "profile.savedStatus", "settings.advancedToggle"]) expect(body).toContain(`data-ai-id="${id}"`);
    expect(body).toContain('aria-expanded="false"');
    expect(body).toContain('<button type="button" data-action="save" data-ai-id="profile.save">Save</button>');
    const head = await fetch(app.origin + "/profile", { method: "HEAD" });
    expect(head.status).toBe(200); expect(await head.text()).toBe("");
    expect((await fetch(app.origin + "/favicon.ico")).status).toBe(204);
    const post = await fetch(app.origin + "/profile", { method: "POST", body: "x" });
    expect(post.status).toBe(405); expect(post.headers.get("allow")).toBe("GET, HEAD");
  });

  it("serves its own script and style, no inline code or style, and stays on loopback", async () => {
    const app = await start();
    expect((await text(app.origin + "/app.js")).response.headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    expect((await text(app.origin + "/app.css")).response.headers.get("content-type")).toBe("text/css; charset=utf-8");
    expect(app.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
    const port = app.port;
    await app.close(); await app.close();
    expect(await refuses(port, "127.0.0.1")).toBe(true);
  });

  it("the variant: default, per-request ?variant=, and a POST /__variant toggle without a restart", async () => {
    const app = await start({ variant: "default", name: "Profile C" });
    expect((await text(app.origin + "/profile")).body).toContain('data-ai-id="profile.save"');
    const moved = (await text(app.origin + "/profile?variant=moved")).body;
    expect(moved).toContain('<a href="/profile" data-action="save" data-ai-id="profile.submit">Save</a>');
    expect(moved).not.toContain('data-ai-id="profile.save"');
    expect((await text(app.origin + "/profile?variant=bogus")).body).toContain('data-ai-id="profile.save"');
    const toggle = await text(app.origin + "/__variant", { method: "POST", body: JSON.stringify({ variant: "moved" }), headers: { "content-type": "application/json" } });
    expect(toggle.response.status).toBe(200);
    expect(JSON.parse(toggle.body)).toEqual({ variant: "moved" });
    expect(app.variant()).toBe("moved");
    expect((await text(app.origin + "/settings")).body).toContain('data-ai-id="profile.submit"');
    expect((await text(app.origin + "/__variant")).body).toBe('{"variant":"moved"}');
    for (const bad of ["{}", '{"variant":"other"}', "not json", '{"variant":5}']) expect((await text(app.origin + "/__variant", { method: "POST", body: bad })).response.status).toBe(400);
    expect((await fetch(app.origin + "/__variant", { method: "PUT" })).status).toBe(405);
    expect(app.variant()).toBe("moved");
    app.setVariant("default");
    expect((await text(app.origin + "/profile")).body).toContain('data-ai-id="profile.save"');
    expect(() => app.setVariant("x")).toThrow(TypeError);
  });

  it("fixture D (variant moved at start) serves the re-marked link", async () => {
    const app = await start({ variant: "moved", name: "Profile D" });
    const body = (await text(app.origin + "/profile")).body;
    expect(body).toContain("Profile D");
    expect(body).toContain('data-ai-id="profile.submit"');
    expect(body).not.toContain('data-ai-id="profile.save"');
  });

  it("sends the strict Content-Security-Policy only when asked, naming the Studio origin only for scripts, styles and fetches", async () => {
    const plain = await start();
    expect((await fetch(plain.origin + "/profile")).headers.get("content-security-policy")).toBeNull();
    const dapOrigin = "http://127.0.0.1:5186";
    const strict = await start({ csp: true, dapOrigin, dapKey: "rk-0123456789abcdef0123456789abcdef" });
    const header = (await fetch(strict.origin + "/profile")).headers.get("content-security-policy");
    expect(header).toBe(`default-src 'none'; script-src 'self' ${dapOrigin}; style-src 'self' ${dapOrigin}; connect-src ${dapOrigin}; img-src 'self'; base-uri 'none'; form-action 'none'`);
    expect(strict.policy()).toBe(header);
    const alone = await start({ csp: true });
    expect((await fetch(alone.origin + "/")).headers.get("content-security-policy")).toBe("default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'none'; img-src 'self'; base-uri 'none'; form-action 'none'");
  });

  it("adds the standalone script tag (loaded from the runtime origin) or serves the built embed for the window handshake, never both", async () => {
    const dapOrigin = "http://127.0.0.1:5186";
    const key = "rk-0123456789abcdef0123456789abcdef";
    const standalone = await start({ dapOrigin, dapKey: key });
    expect((await text(standalone.origin + "/profile")).body).toContain(`<script src="${dapOrigin}/dap-embed.js" data-dap-key="${key}"></script>`);
    expect((await fetch(standalone.origin + "/dap-embed.js")).status).toBe(200); // the fallback shell, not a script
    expect((await fetch(standalone.origin + "/dap-embed.js")).headers.get("content-type")).toBe("text/html; charset=utf-8");
    const source = new URL("../fixtures/studio-app/history-app.mjs", import.meta.url).pathname;
    const handshake = await start({ dapOrigin, embedScriptPath: source });
    expect((await text(handshake.origin + "/profile")).body).toContain(`<script src="/dap-embed.js" data-dap-origin="${dapOrigin}"></script>`);
    expect((await fetch(handshake.origin + "/dap-embed.js")).headers.get("content-type")).toBe("text/javascript; charset=utf-8");
    const none = await start();
    expect((await text(none.origin + "/profile")).body).not.toContain("dap-embed");
  });

  it("validates its options", async () => {
    await expect(startHistoryApp({ host: "0.0.0.0" })).rejects.toThrow(/loopback/u);
    await expect(startHistoryApp({ port: -1 })).rejects.toThrow(TypeError);
    await expect(startHistoryApp({ name: "<b>" })).rejects.toThrow(TypeError);
    await expect(startHistoryApp({ variant: "other" as never })).rejects.toThrow(TypeError);
    await expect(startHistoryApp({ dapOrigin: "http://127.0.0.1:5186/" })).rejects.toThrow(TypeError);
    await expect(startHistoryApp({ dapKey: "key-1" })).rejects.toThrow(TypeError);
    await expect(startHistoryApp({ dapKey: "rk-" + "a".repeat(78) })).rejects.toThrow(TypeError);
    await expect(startHistoryApp({ dapKey: "rk-0123456789abcdef0123456789abcdef" })).rejects.toThrow(/dapOrigin/u);
    await expect(startHistoryApp({ dapOrigin: "http://127.0.0.1:5186", dapKey: "rk-0123456789abcdef0123456789abcdef", embedScriptPath: "/x" })).rejects.toThrow(/not both/u);
  });
});

describe("history fixture page behavior (real scripts in jsdom)", () => {
  it("renders the page of the PATH on a direct visit, and unknown paths as not found", async () => {
    const app = await start();
    for (const [path, page] of [["/", "/"], ["/profile", "/profile"], ["/settings", "/settings"], ["/profile/", "/profile"], ["/profile?variant=moved", "/profile"], ["/nowhere", "*"]] as const) {
      const dom = await visit(app.origin + path);
      expect(visible(dom.window.document), path).toEqual([page]);
      dom.window.close();
    }
  });

  it("SPA navigation: pushState without reload and without a popstate event, and popstate re-renders", async () => {
    const app = await start();
    const dom = await visit(app.origin + "/");
    const { window } = dom;
    let popstate = 0;
    window.addEventListener("popstate", () => { popstate += 1; });
    const before = app.requestPaths().length;
    (window.document.querySelector('[data-ai-id="nav.profile"]') as HTMLElement).click();
    expect(window.location.pathname).toBe("/profile");
    expect(visible(window.document)).toEqual(["/profile"]);
    (window.document.querySelector('[data-ai-id="nav.settings"]') as HTMLElement).click();
    expect(window.location.pathname).toBe("/settings");
    expect(visible(window.document)).toEqual(["/settings"]);
    expect(popstate).toBe(0);
    expect(app.requestPaths().length).toBe(before);
    window.history.pushState(null, "", "/profile");
    window.dispatchEvent(new window.PopStateEvent("popstate"));
    expect(visible(window.document)).toEqual(["/profile"]);
    window.close();
  });

  it("Save shows Saved in the status element (default variant and moved link variant), editing clears it", async () => {
    const app = await start();
    for (const variant of ["default", "moved"] as const) {
      app.setVariant(variant);
      const dom = await visit(app.origin + "/profile");
      const { document } = dom.window;
      const save = document.querySelector<HTMLElement>(`[data-ai-id="${variant === "moved" ? "profile.submit" : "profile.save"}"]`)!;
      expect(save.tagName).toBe(variant === "moved" ? "A" : "BUTTON");
      expect(document.querySelector('[data-ai-id="profile.savedStatus"]')?.getAttribute("role")).toBe("status");
      expect(document.querySelector('[data-ai-id="profile.savedStatus"]')?.textContent).toBe("");
      save.click();
      expect(document.querySelector('[data-ai-id="profile.savedStatus"]')?.textContent).toBe("Saved");
      expect(dom.window.location.pathname).toBe("/profile");
      const input = document.querySelector<HTMLInputElement>('[data-ai-id="profile.displayName"]')!;
      input.value = "Ada"; input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
      expect(document.querySelector('[data-ai-id="profile.savedStatus"]')?.textContent).toBe("");
      dom.window.close();
    }
  });

  it("the Advanced toggle flips aria-expanded and the panel", async () => {
    const app = await start();
    const dom = await visit(app.origin + "/settings");
    const { document } = dom.window;
    const toggle = document.querySelector<HTMLElement>('[data-ai-id="settings.advancedToggle"]')!;
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    expect(document.getElementById("advanced")?.hidden).toBe(true);
    toggle.click();
    expect(toggle.getAttribute("aria-expanded")).toBe("true");
    expect(document.getElementById("advanced")?.hidden).toBe(false);
    toggle.click();
    expect(toggle.getAttribute("aria-expanded")).toBe("false");
    dom.window.close();
  });
});
