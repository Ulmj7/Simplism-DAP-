// Opt-in Chromium proof. Uses the production launcher and popup controller with a deterministic fixture for the read-only API.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createServer } from "vite";
import { startFixtureApp } from "../tests/fixtures/studio-app/server.mjs";

const studioOrigin = "http://127.0.0.1:5186";
const appOrigin = "http://127.0.0.1:5187";
const guide = { id: "wt-123456789abc", title: "Fixture order walkthrough", description: "Open Orders and submit a note.", start: "open", steps: [
  { id: "open", kind: "guide", target: "nav.orders", text: "Open Orders from Home.", wait: "click", verify: "route.orders", next: "note" },
  { id: "note", kind: "guide", target: "orders.note", text: "Enter an order note.", wait: "input", next: "submit" },
  { id: "submit", kind: "guide", target: "orders.submit", text: "Submit this order.", wait: "click", next: "done" },
  { id: "done", kind: "complete", text: "Fixture walkthrough finished." },
] };
const application = { id: "app-123456789abc", name: "Orders fixture", origin: appOrigin };
const bundle = { application, definition: guide, registry: {
  routes: ["home", "orders"], pages: { "/": "home", "/#/orders": "orders" }, postconditionNames: ["route.home", "route.orders"],
  elements: [
    { id: "nav.orders", route: "home", role: "link", label: "Orders", description: "Open Orders.", operations: ["highlight", "click"], privacy: "public" },
    { id: "orders.note", route: "orders", role: "textbox", label: "Order note", description: "Enter a note.", operations: ["highlight", "input"], privacy: "public" },
    { id: "orders.submit", route: "orders", role: "button", label: "Submit order", description: "Submit the order.", operations: ["highlight", "click"], privacy: "public" },
  ],
} };
const cli = fileURLToPath(new URL("../vendor/agent-browser/cli/target/release/agent-browser", import.meta.url));
const config = fileURLToPath(new URL("../packages/browser-runtime/agent-browser.json", import.meta.url));
const embed = fileURLToPath(new URL("../apps/reference-web/dist-embed/dap-embed.js", import.meta.url));
const run = promisify(execFile);
const env = Object.fromEntries(["PATH", "HOME", "USER", "LOGNAME", "LANG", "XDG_RUNTIME_DIR"]
  .flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]]]));
const session = `studio-embed-${randomUUID()}`;
let chrome = false;
let vite;
let fixture;
async function command(...args) {
  const { stdout } = await run(cli, ["--session", session, "--config", config, "--json", ...args], { env, timeout: 15_000 });
  const result = JSON.parse(stdout);
  assert.equal(result.success, true, args[0]);
  return result.data;
}
const evaluate = code => command("eval", "-b", Buffer.from(code).toString("base64")).then(reply => reply.result);
const wait = text => command("wait", "--text", text);
async function findTab(match) {
  const deadline = performance.now() + 8_000;
  while (performance.now() < deadline) {
    const item = (await command("tab")).tabs.find(match);
    if (item) return item.tabId;
    await sleep(50);
  }
  throw new Error("Expected Chromium tab did not appear.");
}
const elapsed = time => Math.round(performance.now() - time);
try {
  fixture = await startFixtureApp({ port: 5187, embedScriptPath: embed, dapOrigin: studioOrigin });
  assert.equal(fixture.origin, appOrigin);
  let bundleReads = 0;
  vite = await createServer({
    configFile: fileURLToPath(new URL("../apps/reference-web/vite.config.ts", import.meta.url)),
    server: { port: 5186, strictPort: true, proxy: {} },
    plugins: [{ name: "studio-embed-smoke-api", configureServer(server) {
      server.middlewares.use((request, response, next) => {
        let body;
        if (request.url === "/api/walkthroughs/published") {
          body = { walkthroughs: [], external: [{ id: guide.id, title: guide.title, description: guide.description, application }] };
        } else if (request.url === `/api/walkthroughs/published/${guide.id}/bundle`) { body = bundle; bundleReads += 1; }
        else if (request.url?.startsWith("/api/")) body = {};
        else return next();
        response.writeHead(200, { "content-type": "application/json", "cache-control": "no-store" }).end(JSON.stringify(body));
      });
    } }],
  });
  await vite.listen();
  chrome = true;
  await command("--allowed-domains", "127.0.0.1", "--no-webmcp", "open", studioOrigin + "/");
  const studio = await findTab(tab => tab.url.startsWith(studioOrigin));
  await wait("Guides in other applications");
  await command("errors", "--clear");
  const launch = performance.now();
  await command("find", "role", "button", "click", "--name", "Start in Orders fixture: Fixture order walkthrough", "--exact");
  const target = await findTab(tab => tab.url.startsWith(appOrigin));
  await command("tab", studio);
  await wait("Walkthrough running in the application window.");
  const handshakeMs = elapsed(launch);
  await command("tab", target);
  assert.equal(await evaluate("Boolean(window.opener)"), true);
  await wait("Open Orders from Home.");
  const start = performance.now();
  await command("click", '[data-ai-id="nav.orders"]');
  await wait("Enter an order note.");
  await command("click", "#order-note");
  await command("press", "A");
  await wait("Submit this order.");
  await command("click", '[data-ai-id="orders.submit"]');
  await wait("Fixture walkthrough finished.");
  const completionMs = elapsed(start);
  assert.equal((await command("get", "text", "#order-status")).text, "Order submitted.");
  assert.deepEqual((await command("errors")).errors, []);
  await command("tab", studio);
  await wait("Walkthrough finished.");
  assert.equal(bundleReads, 1);
  console.log(`PASS production launcher handshake ${handshakeMs} ms; deterministic run ${completionMs} ms; application handler ran; zero browser errors`);

  await command("tab", target);
  const message = JSON.stringify({ type: "dap-run", version: 1, bundle });
  await evaluate(`(() => { let ready = false; addEventListener("message", event => { if (event.data?.type === "dap-embed-ready") ready = true; });
    const wrong = window.open(location.origin + "/#/home", "_blank");
    window.proof = () => ({ ready, opener: wrong.opener === window, overlay: Boolean(wrong.document.querySelector(".dap-guide-card")) });
    setTimeout(() => wrong.postMessage(${message}, location.origin), 300);
    return true;
  })()`);
  await findTab(tab => tab.url === appOrigin + "/#/home");
  await command("tab", target);
  await sleep(850);
  assert.deepEqual(await evaluate("window.proof()"), { ready: false, opener: true, overlay: false });
  console.log("PASS popup with wrong-origin opener received no ready signal and refused the forged run");
} finally {
  if (chrome) await command("close").catch(() => {});
  await vite?.close();
  await fixture?.close();
}
