// The second-application fixture (tests/fixtures/studio-app) is test infrastructure: prove it serves what the
// probe and later Studio tests rely on, stays on loopback, closes cleanly and carries nothing sensitive.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { connect } from "node:net";
import { request } from "node:http";
import { JSDOM } from "jsdom";
import { afterEach, describe, expect, it } from "vitest";
import { fixtureB } from "../fixtures/studio-app/registry.mjs";
import { startFixtureApp } from "../fixtures/studio-app/server.mjs";
import type { FixtureApp, FixtureAppOptions } from "../fixtures/studio-app/server.mjs";

const running: FixtureApp[] = [];
async function start(options?: FixtureAppOptions) {
  const app = await startFixtureApp(options);
  running.push(app);
  return app;
}
afterEach(async () => { await Promise.all(running.splice(0).map(app => app.close())); });

const text = async (url: string) => {
  const response = await fetch(url);
  return { response, body: await response.text() };
};
function configOf(html: string): Record<string, unknown> {
  const match = /<script type="application\/json" id="fixture-config">(.*?)<\/script>/su.exec(html);
  return JSON.parse(match?.[1] ?? "null") as Record<string, unknown>;
}
const refuses = (port: number, host: string) => new Promise<boolean>(resolve => {
  const socket = connect({ port, host });
  socket.once("connect", () => { socket.destroy(); resolve(false); });
  socket.once("error", () => resolve(true));
});

describe("fixture application server", () => {
  it("serves the hash-routed page with the annotated controls and no cache", async () => {
    const app = await start({ name: "B" });
    const { response, body } = await text(app.origin + "/");
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/html; charset=utf-8");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-content-type-options")).toBe("nosniff");
    for (const id of ["nav.orders", "orders.submit", "orders.note"]) expect(body).toContain(`data-ai-id="${id}"`);
    for (const label of [">Orders<", ">Submit order<", ">Order note<"]) expect(body).toContain(label);
    expect(body).toContain("Fixture application B");
    expect((await text(app.origin + "/index.html")).response.status).toBe(200);
    expect((await text(app.origin + "/?x=1")).response.status).toBe(200);
    const head = await fetch(app.origin + "/", { method: "HEAD" });
    expect(head.status).toBe(200);
    expect(await head.text()).toBe("");
  });

  it("answers anything else with a closed response", async () => {
    const app = await start();
    expect((await text(app.origin + "/missing")).response.status).toBe(404);
    expect((await fetch(app.origin + "/favicon.ico")).status).toBe(204);
    const post = await fetch(app.origin + "/", { method: "POST", body: "x" });
    expect(post.status).toBe(405);
    expect(post.headers.get("allow")).toBe("GET, HEAD");
  });

  it("tells two instances apart by name and origin", async () => {
    const a = await start({ name: "A" });
    const b = await start({ name: "B" });
    expect(a.origin).not.toBe(b.origin);
    expect((await text(a.origin)).body).toContain("Fixture application A");
    expect((await text(b.origin)).body).toContain("Fixture application B");
    expect((await text(a.origin)).body).not.toContain("Fixture application B");
  });

  it("binds only to the requested loopback address and refuses to bind elsewhere", async () => {
    const app = await start({ host: "127.0.0.1" });
    expect(app.origin).toMatch(/^http:\/\/127\.0\.0\.1:\d+$/u);
    // A server bound to 0.0.0.0 would accept this other loopback address; one bound to 127.0.0.1 does not.
    expect(await refuses(app.port, "127.0.0.2")).toBe(true);
    for (const host of ["0.0.0.0", "::", "192.168.1.5", "example.com", "", "127.0.0.1:80"]) {
      await expect(startFixtureApp({ host })).rejects.toThrow(/only binds to loopback/u);
    }
  });

  it("closes cleanly, repeatedly, and stops accepting connections", async () => {
    const app = await start();
    await text(app.origin);
    await app.close();
    await app.close();
    expect(await refuses(app.port, "127.0.0.1")).toBe(true);
  });

  it("closes even while a client holds a keep-alive connection", async () => {
    const app = await start();
    const held = connect({ port: app.port, host: "127.0.0.1" });
    await new Promise(resolve => held.once("connect", resolve));
    held.write(`GET / HTTP/1.1\r\nHost: 127.0.0.1:${app.port}\r\nConnection: keep-alive\r\n\r\n`);
    await new Promise(resolve => held.once("data", resolve));
    await app.close();
    held.destroy();
    expect(await refuses(app.port, "127.0.0.1")).toBe(true);
  });

  it.each<[string, FixtureAppOptions]>([
    ["a negative port", { port: -1 }],
    ["a fractional port", { port: 1.5 }],
    ["a port above 65535", { port: 70_000 }],
    ["an empty name", { name: "" }],
    ["a markup name", { name: "<script>x</script>" }],
    ["a long name", { name: "x".repeat(41) }],
    ["a leave origin with a path", { leaveOrigin: "http://127.0.0.1:1/app" }],
    ["a leave origin with credentials", { leaveOrigin: "http://user:pw@127.0.0.1:1" }],
    ["a javascript leave origin", { leaveOrigin: "javascript:alert(1)" }],
    ["a negative delay", { redirectDelayMs: -1 }],
    ["an excessive delay", { redirectDelayMs: 31_000 }],
  ])("refuses %s with a TypeError", async (_name, options) => {
    await expect(startFixtureApp(options)).rejects.toBeInstanceOf(TypeError);
  });

  it("describes where its escape routes lead, without echoing anything unescaped", async () => {
    const app = await start({ leaveOrigin: "http://127.0.0.1:65000", redirectDelayMs: 1500 });
    const { body } = await text(app.origin);
    expect(configOf(body)).toEqual({ name: "B", leaveOrigin: "http://127.0.0.1:65000", leaveHost: `http://localhost:${app.port}`, redirectDelayMs: 1500 });
    const lookalike = await new Promise<string>((resolve, reject) => {
      request({ host: "127.0.0.1", port: app.port, path: "/", headers: { host: `localhost:${app.port}` } }, response => {
        let chunks = "";
        response.on("data", chunk => { chunks += String(chunk); });
        response.on("end", () => resolve(chunks));
      }).on("error", reject).end();
    });
    expect(configOf(lookalike).leaveHost).toBe(`http://127.0.0.1:${app.port}`);
    expect(app.requestHosts()).toEqual([`127.0.0.1:${app.port}`, `localhost:${app.port}`]);
  });

  it("has no leave origin unless configured and no alias for an unknown Host header", async () => {
    const app = await start();
    expect(configOf((await text(app.origin)).body)).toMatchObject({ leaveOrigin: null, redirectDelayMs: 800 });
    const odd = await new Promise<string>((resolve, reject) => {
      request({ host: "127.0.0.1", port: app.port, path: "/", headers: { host: "evil.example:80" } }, response => {
        let chunks = "";
        response.on("data", chunk => { chunks += String(chunk); });
        response.on("end", () => resolve(chunks));
      }).on("error", reject).end();
    });
    expect(configOf(odd).leaveHost).toBeNull();
  });

  it("carries no secrets, external addresses or third-party assets", async () => {
    const app = await start();
    const { body } = await text(app.origin);
    expect(body).not.toMatch(/password|passwd|token|secret|api[_-]?key|bearer|authorization|cookie|credential/iu);
    // The only addresses are the ones the escape routes are configured with, inside the JSON block.
    expect(body.replace(/<script type="application\/json"[^>]*>.*?<\/script>/su, "")).not.toMatch(/https?:\/\//iu);
    expect(Object.values(configOf(body)).filter(value => typeof value === "string" && /^https?:/u.test(value))).toEqual([`http://localhost:${app.port}`]);
    expect(body).not.toMatch(/<(?:link|img|iframe|object|embed)\b|<script[^>]*\ssrc=/iu);
  });
});

describe("fixture page routing", () => {
  async function load(app: FixtureApp, hash: string) {
    const { body } = await text(app.origin + "/");
    return new JSDOM(body, { runScripts: "dangerously", url: `${app.origin}/${hash}` });
  }
  const visible = (dom: JSDOM) => [...dom.window.document.querySelectorAll<HTMLElement>("[data-route]")].filter(node => !node.hidden).map(node => node.dataset.route);

  it("shows the home route first and the orders route on its hash, and follows hash changes", async () => {
    const app = await start();
    const dom = await load(app, "");
    expect(visible(dom)).toEqual(["home"]);
    dom.window.location.hash = "#/orders";
    await new Promise(resolve => dom.window.setTimeout(resolve, 20));
    expect(visible(dom)).toEqual(["orders"]);
    dom.window.location.hash = "#/nowhere";
    await new Promise(resolve => dom.window.setTimeout(resolve, 20));
    expect(visible(dom)).toEqual(["home"]);
    const ordersDirect = await load(app, "#/orders");
    expect(visible(ordersDirect)).toEqual(["orders"]);
    ordersDirect.window.document.querySelector<HTMLElement>('[data-ai-id="orders.submit"]')?.click();
    expect(ordersDirect.window.document.getElementById("order-status")?.textContent).toBe("Order submitted.");
    dom.window.close();
    ordersDirect.window.close();
  });

  it("serves seventy copies of the approved Orders link only on the dense route", async () => {
    const app = await start();
    const dom = await load(app, "#/dense");
    expect(visible(dom)).toEqual(["dense"]);
    const links = [...dom.window.document.querySelectorAll('[data-route="dense"] a')];
    expect(links).toHaveLength(70);
    expect(links.every(link => link.textContent === "Orders" && link.getAttribute("data-ai-id") === "nav.orders")).toBe(true);
    dom.window.close();
  });

  it("shows the leaving page on both escape routes and schedules nothing without a target", async () => {
    const app = await start();
    for (const hash of ["#/leave-origin", "#/leave-host"]) {
      const dom = await load(app, hash);
      expect(visible(dom)).toEqual(["leave"]);
      dom.window.close();
    }
  });
});

describe("fixture application registry data", () => {
  it("is plain, public-only and consistent with the page", async () => {
    const app = await start();
    const { body } = await text(app.origin);
    const annotated = [...body.matchAll(/\sdata-ai-id="([^"]+)"/gu)].map(match => match[1]);
    expect(annotated.toSorted()).toEqual(fixtureB.registry.elements.map(element => element.id).toSorted());
    for (const element of fixtureB.registry.elements) {
      expect(element.privacy).toBe("public");
      expect(fixtureB.registry.routes).toContain(element.route);
      expect(element.operations).toContain("highlight");
    }
    expect(fixtureB.browser.labels).toEqual([
      { role: "link", name: "Orders" }, { role: "button", name: "Submit order" }, { role: "textbox", name: "Order note" },
    ]);
    for (const { name } of fixtureB.browser.labels) expect(body).toContain(`>${name}<`);
  });

  it("maps every adapter page key to a registry route, including the two escape routes", () => {
    expect(fixtureB.browser.pages).toEqual({
      "/": "home", "/#/home": "home", "/#/orders": "orders", "/#/dense": "home", "/#/leave-origin": "home", "/#/leave-host": "home",
    });
    for (const route of Object.values(fixtureB.browser.pages)) expect(fixtureB.registry.routes).toContain(route);
    for (const key of Object.keys(fixtureB.browser.pages)) expect(key).toMatch(/^\/(?:#\/[a-z-]+)?$/u);
  });

  it("is deeply frozen", () => {
    const frozen = (value: unknown): boolean =>
      typeof value !== "object" || value === null || (Object.isFrozen(value) && Object.values(value).every(frozen));
    expect(frozen(fixtureB)).toBe(true);
  });
});

it("serves only an explicitly configured embed and keeps optional registration fixtures out of the default page", async () => {
  const defaultApp = await start();
  const defaultPage = await text(defaultApp.origin);
  expect(defaultPage.body).not.toContain("/dap-embed.js");
  expect(defaultPage.body).not.toContain("orders.secret");
  expect(defaultPage.body).not.toContain("orders.twin");
  expect((await fetch(defaultApp.origin + "/dap-embed.js")).status).toBe(404);
  const dapOrigin = "http://127.0.0.1:5186";
  const source = new URL("../fixtures/studio-app/server.mjs", import.meta.url);
  const app = await start({ dapOrigin, embedScriptPath: fileURLToPath(source), extras: true });
  const page = await text(app.origin);
  expect(page.body).toContain(`<script src="/dap-embed.js" data-dap-origin="${dapOrigin}"></script>`);
  expect(page.body).toContain('type="password" data-ai-id="orders.secret"');
  expect(page.body).toContain('data-ai-id="orders.private" data-ai-private');
  expect(page.body).toContain('data-ai-id="admin.reset"');
  expect(page.body.match(/data-ai-id="orders\.twin"/g)).toHaveLength(2);
  const script = await text(app.origin + "/dap-embed.js");
  expect(script.response.headers.get("cache-control")).toBe("no-store");
  expect(script.response.headers.get("content-type")).toContain("text/javascript");
  expect(script.body).toBe(await readFile(source, "utf8"));
  for (const method of ["HEAD", "POST"]) expect((await fetch(app.origin + "/dap-embed.js", { method })).status).toBe(405);
  await expect(start({ dapOrigin })).rejects.toThrow(/both embedScriptPath/);
});

it("serves the embed's stylesheet from next to the script (an external file, so no inline style is needed), only when it exists", async () => {
  const directory = await mkdtemp(join(tmpdir(), "dap-embed-fixture-"));
  try {
    await writeFile(join(directory, "dap-embed.js"), "// script");
    const dapOrigin = "http://127.0.0.1:5186";
    const without = await start({ dapOrigin, embedScriptPath: join(directory, "dap-embed.js") });
    expect((await fetch(without.origin + "/dap-embed.css")).status).toBe(404);
    await writeFile(join(directory, "dap-embed.css"), ".dap-result { color: red; }");
    const app = await start({ dapOrigin, embedScriptPath: join(directory, "dap-embed.js") });
    const sheet = await text(app.origin + "/dap-embed.css");
    expect(sheet.response.status).toBe(200);
    expect(sheet.response.headers.get("content-type")).toBe("text/css; charset=utf-8");
    expect(sheet.response.headers.get("cache-control")).toBe("no-store");
    expect(sheet.body).toBe(".dap-result { color: red; }");
    expect((await fetch(app.origin + "/dap-embed.css", { method: "POST" })).status).toBe(405);
    expect((await text((await start()).origin + "/dap-embed.css")).response.status).toBe(404);
  } finally { await rm(directory, { recursive: true, force: true }); }
});
