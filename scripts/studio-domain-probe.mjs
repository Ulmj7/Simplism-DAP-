import assert from "node:assert/strict";
import { BrowserRuntimeError, createPlaywrightRuntime, openChromiumSession } from "../packages/browser-runtime/dist/index.js";
import { startFixtureApp } from "../tests/fixtures/studio-app/server.mjs";

const fixtures = [];
const runtimes = [];
const delay = 750;
const blocked = error => error instanceof BrowserRuntimeError && error.code === "DOMAIN_BLOCKED";
const port = name => Number(process.env["DAP_PROBE_PORT_" + name] || 0);

async function connect(origins, url) {
  let browser;
  const runtime = createPlaywrightRuntime({ labels: "all", routes: "any", origins }, async options => {
    browser = await openChromiumSession(options);
    return browser;
  });
  runtimes.push(runtime);
  await runtime.start({ url });
  return { runtime, browser };
}
try {
  const b = await startFixtureApp({ name: "B", port: port("B"), redirectDelayMs: delay });
  fixtures.push(b);
  const a = await startFixtureApp({ name: "A", port: port("A"), leaveOrigin: b.origin, redirectDelayMs: delay });
  fixtures.push(a);
  const { runtime, browser } = await connect([a.origin], a.origin + "/");
  const home = await runtime.snapshot();
  const orders = home.elements.find(element => element.name === "Orders");
  assert.ok(orders);
  assert.equal((await runtime.inspectSemanticIds(home)).get(orders.ref), "nav.orders");
  await runtime.highlight(orders.ref, home);
  await browser.page.goto(a.origin + "/#/orders");
  await assert.rejects(runtime.highlight(orders.ref, home), { code: "REF_NOT_FOUND" });
  const current = await runtime.snapshot();
  const field = current.elements.find(element => element.name === "Order note");
  assert.ok(field);
  assert.equal((await runtime.inspectElementFacts([field.ref], current)).get(field.ref)?.tagName, "input");

  await browser.page.goto(a.origin + "/#/leave-origin");
  await browser.page.waitForTimeout(delay + 400);
  await assert.rejects(runtime.snapshot(), blocked);
  await assert.rejects(runtime.inspectDom(), blocked);
  await runtime.close();
  assert.equal(browser.page.isClosed(), true);

  const allowed = await connect([a.origin, b.origin], a.origin + "/#/leave-origin");
  await allowed.browser.page.waitForURL(b.origin + "/#/home");
  assert.equal((await allowed.runtime.snapshot()).url, b.origin + "/#/home");
  const alias = new URL(a.origin);
  alias.hostname = "localhost";
  await allowed.browser.page.goto(alias.href).catch(() => {});
  await assert.rejects(allowed.runtime.getUrl(), blocked);
  const query = await connect([a.origin], a.origin + "/");
  await query.browser.page.goto(a.origin + "/?token=fixture");
  await assert.rejects(query.runtime.inspectDom(), blocked);
  console.log("Studio domain probe passed in Chromium.");
} finally {
  await Promise.allSettled(runtimes.map(runtime => runtime.close()));
  await Promise.allSettled(fixtures.map(fixture => fixture.close()));
}
