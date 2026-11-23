// Opt-in real-Chromium proof of STANDALONE embed delivery (Studio completion S8) under a STRICT Content-Security-Policy. Never part of `npm test`.
//
//   npm run smoke:studio-embed-standalone [-- --headed]
//
// What runs, all in this process:
//   - a small fake runtime API on 127.0.0.1:5186 that mimics the documented delivery shapes (the real endpoints land with the host slice): `GET /api/runtime/:key/guides` and `…/guides/:id`
//     with CORS for the application's EXACT origin only (anything else: 403 and no Access-Control-Allow-Origin), no credentials, no-store; it also serves `dap-embed.js` and `dap-embed.css`;
//   - fixture C (history-routed "Profile") on 5188 under `default-src 'none'; script-src 'self' <api>; style-src 'self' <api>; connect-src <api>; img-src 'self'; base-uri 'none'; form-action 'none'`;
//   - fixture D (the "moved" variant) on 5189 and a refused origin on 5187.
// Proven: no CSP violation or browser error; the launcher is accessible (keyboard, focus, Escape, 320 px without horizontal overflow); a complete deterministic run on history routes with real
// interactions (SPA pushState navigation, typing, clicking Save, an `element.text.equals` check on the saved status and a route check); the same stored guide runs on the moved variant through
// a marker binding; a stale binding fails closed; a wrong key and a refused Origin leave the page inert; and a strict policy really blocks an injected inline style.
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { startHistoryApp } from "../tests/fixtures/studio-app/history-app.mjs";

const apiPort = 5186;
const ports = { B: 5187, C: 5188, D: 5189 };
const apiOrigin = `http://127.0.0.1:${apiPort}`;
const origins = { B: `http://127.0.0.1:${ports.B}`, C: `http://127.0.0.1:${ports.C}`, D: `http://127.0.0.1:${ports.D}` };
const headed = process.argv.includes("--headed");
const root = new URL("..", import.meta.url);
const cli = fileURLToPath(new URL("vendor/agent-browser/cli/target/release/agent-browser", root));
const config = fileURLToPath(new URL("packages/browser-runtime/agent-browser.json", root));
const dist = new URL("apps/reference-web/dist-embed/", root);
const run = promisify(execFile);
const env = Object.fromEntries(["PATH", "HOME", "USER", "LOGNAME", "LANG", "DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "XAUTHORITY"].flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]]]));
const session = `studio-embed-standalone-${randomUUID()}`;
const hex = suffix => `${"0123456789abcdef".repeat(2).slice(0, 32 - suffix.length)}${suffix}`;
const keys = { C: `rk-${hex("c0")}`, D: `rk-${hex("d0")}`, stale: `rk-${hex("d1")}`, refused: `rk-${hex("b0")}`, unknown: `rk-${hex("ee")}` };

// ---- the guide, as the delivery API would serve it -----------------------------------------------------------------------------------------------------------------------------------------
const check = (name, rest) => ({ name: `check.v${name}`, ...rest });
const checks = [
  check("0a0a0a0a01", { kind: "route.equals", route: "profile" }),
  check("0a0a0a0a02", { kind: "element.text.equals", targetId: "profile.savedStatus", expected: "Saved" }),
];
const elements = (saveMarker) => [
  { id: "nav.profile", route: "home", role: "link", label: "Profile", description: "Open the profile page.", operations: ["highlight", "click"], privacy: "public" },
  { id: "profile.displayName", route: "profile", role: "textbox", label: "Display name", description: "Your display name.", operations: ["highlight", "input"], privacy: "public" },
  { id: "profile.save", ...(saveMarker === undefined ? {} : { marker: saveMarker }), route: "profile", role: saveMarker === undefined ? "button" : "link", label: "Save", description: "Saves the profile.", operations: ["highlight", "click"], privacy: "public" },
  { id: "profile.savedStatus", route: "profile", role: "text", label: "Saved status", description: "Shows Saved after saving.", operations: ["highlight"], privacy: "public" },
];
const bundle = (origin, saveMarker) => ({
  version: 1,
  application: { id: "app-0123456789ab", name: "Profile", origin },
  registry: {
    routing: "history", routes: ["home", "profile", "settings"], pages: { "/": "home", "/profile": "profile", "/settings": "settings" },
    postconditionNames: ["route.home", "route.profile", "route.settings", ...checks.map(item => item.name)], checks, elements: elements(saveMarker),
  },
  definition: { id: "wt-profile", title: "Change display name", description: "Open your profile, change the display name and save.", start: "open", steps: [
    { id: "open", kind: "guide", target: "nav.profile", text: "Open your profile.", wait: "click", verify: checks[0].name, next: "name" },
    { id: "name", kind: "guide", target: "profile.displayName", text: "Type a new display name.", wait: "input", next: "save" },
    { id: "save", kind: "guide", target: "profile.save", text: "Press Save.", wait: "click", verify: checks[1].name, next: "done" },
    { id: "done", kind: "complete", text: "Your display name was changed." },
  ] },
});
// key -> the one origin it serves and the bundle it hands out.
const applications = new Map([
  [keys.C, { origin: origins.C, bundle: bundle(origins.C) }],
  [keys.D, { origin: origins.D, bundle: bundle(origins.D, "profile.submit") }],
  [keys.stale, { origin: origins.D, bundle: bundle(origins.D) }],
  [keys.refused, { origin: origins.C, bundle: bundle(origins.C) }],
]);

// ---- the fake runtime API -------------------------------------------------------------------------------------------------------------------------------------------------------------------
const seen = [];
const api = createServer((request, response) => {
  const url = new URL(request.url ?? "/", apiOrigin);
  const origin = request.headers.origin;
  seen.push({ method: request.method, path: url.pathname, origin, cookie: request.headers.cookie !== undefined, authorization: request.headers.authorization !== undefined });
  const base = { "cache-control": "no-store", "x-content-type-options": "nosniff" };
  const send = (status, body, extra = {}) => response.writeHead(status, { "content-type": "application/json", ...base, ...extra }).end(JSON.stringify(body));
  if (request.method === "GET" && (url.pathname === "/dap-embed.js" || url.pathname === "/dap-embed.css")) {
    readFile(new URL(url.pathname.slice(1), dist)).then(
      body => response.writeHead(200, { "content-type": url.pathname.endsWith(".js") ? "text/javascript; charset=utf-8" : "text/css; charset=utf-8", ...base }).end(body),
      () => response.writeHead(404, base).end());
    return;
  }
  const match = /^\/api\/runtime\/(rk-[0-9a-f]{32})\/guides(?:\/([A-Za-z0-9_-]+))?$/u.exec(url.pathname);
  if (!match) { send(404, { error: "not_found" }); return; }
  const entry = applications.get(match[1]);
  if (!entry) { send(404, { error: "not_found" }); return; }
  // The key AND the exact Origin: anything else is refused without a CORS header, so the browser never lets the page read it.
  if (origin !== entry.origin) { send(403, { error: "forbidden" }); return; }
  const cors = { "access-control-allow-origin": origin, vary: "Origin" };
  if (request.method === "OPTIONS") { response.writeHead(204, { ...cors, "access-control-allow-methods": "GET", "access-control-max-age": "60", ...base }).end(); return; }
  if (request.method !== "GET") { send(405, { error: "method_not_allowed" }, cors); return; }
  if (match[2] === undefined) { const { definition } = entry.bundle; send(200, { guides: [{ id: definition.id, title: definition.title, description: definition.description }] }, cors); return; }
  if (match[2] !== entry.bundle.definition.id) { send(404, { error: "not_found" }, cors); return; }
  send(200, entry.bundle, cors);
});

// ---- the browser -----------------------------------------------------------------------------------------------------------------------------------------------------------------------------
async function command(...args) {
  const { stdout } = await run(cli, ["--session", session, "--config", config, "--json", ...args], { env, timeout: 20_000 });
  const result = JSON.parse(stdout);
  assert.equal(result.success, true, `${args[0]}: ${result.error ?? "command failed"}`);
  return result.data;
}
const evaluate = code => command("eval", "-b", Buffer.from(code).toString("base64")).then(reply => reply.result);
const until = async (check, message, timeout = 8_000) => {
  const start = performance.now();
  while (performance.now() - start < timeout) { if (await check()) return Math.round(performance.now() - start); await sleep(50); }
  throw new Error(message);
};
const text = value => command("wait", "--text", value);
const clickButton = name => command("find", "role", "button", "click", "--name", name, "--exact");
const open = async url => { await command("open", url); };
const metrics = { launcherVisibleMs: [], startToFirstStepMs: [], runMs: [], staleFailureMs: [] };
const timings = [];
let chrome = false;
const servers = [];
async function fixture(name, options) {
  const app = await startHistoryApp({ port: ports[name], csp: true, dapOrigin: apiOrigin, ...options });
  servers.push(app);
  assert.equal(app.origin, origins[name]);
  return app;
}
async function stop(app) { await app.close(); servers.splice(servers.indexOf(app), 1); }
const clean = async () => {
  assert.deepEqual(await evaluate("window.cspViolations"), [], "no Content-Security-Policy violation");
  assert.deepEqual((await command("errors")).errors, [], "no page errors");
  const bad = (await command("console")).messages.filter(message => ["error", "warning"].includes(message.type));
  assert.deepEqual(bad, [], "no console errors or warnings");
};
async function step(number, title, operation) {
  const start = performance.now();
  try { const detail = await operation(); const ms = Math.round(performance.now() - start); timings.push([number, ms]); console.log(`STEP ${number} PASS ${ms} ms | ${title}${detail ? ` | ${detail}` : ""}`); }
  catch (error) { console.log(`STEP ${number} FAIL ${Math.round(performance.now() - start)} ms | ${title}`); throw error; }
}
const launcherState = () => evaluate(`(() => { const b = document.querySelector(".dap-launcher-button"); const p = document.querySelector(".dap-launcher-panel");
  return b ? { name: b.textContent, expanded: b.getAttribute("aria-expanded"), panelHidden: p.hidden, active: document.activeElement?.getAttribute("aria-label") ?? document.activeElement?.className ?? null } : null; })()`);
const noOverflow = width => evaluate(`(() => { const r = document.querySelector(".dap-launcher-panel").getBoundingClientRect(); return { viewport: innerWidth, scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth, left: Math.round(r.left), right: Math.round(r.right) }; })()`)
  .then(result => { assert.equal(result.viewport, width); assert.ok(result.scroll <= result.client && result.left >= 0 && result.right <= result.viewport, JSON.stringify(result)); return result; });

try {
  await new Promise((resolve, reject) => { api.once("error", reject); api.listen({ host: "127.0.0.1", port: apiPort }, () => { api.off("error", reject); resolve(undefined); }); });
  console.log(`Chromium ${headed ? "headed" : "headless"} | api ${apiOrigin} | C ${origins.C} | D ${origins.D} | B ${origins.B}`);

  let c = await fixture("C", { dapKey: keys.C });
  chrome = true;
  await step(1, "strict CSP is enforced by the browser (an injected inline style has no effect)", async () => {
    await command("--allowed-domains", "127.0.0.1", ...(headed ? ["--headed"] : []), "--no-webmcp", "open", `${origins.C}/profile?variant=default#ignored`);
    await until(() => evaluate('document.title.startsWith("Profile")'), "fixture C did not render");
    const policy = (await fetch(`${origins.C}/profile`)).headers.get("content-security-policy");
    assert.equal(policy, `default-src 'none'; script-src 'self' ${apiOrigin}; style-src 'self' ${apiOrigin}; connect-src ${apiOrigin}; img-src 'self'; base-uri 'none'; form-action 'none'`);
    const blocked = await evaluate(`(() => { const style = document.createElement("style"); style.textContent = "body { outline: 7px solid red; }"; document.head.append(style); const outline = getComputedStyle(document.body).outlineStyle; style.remove(); return outline; })()`);
    assert.equal(blocked, "none");
    // Positive control for the violation collector (the fixture records every `securitypolicyviolation` event in window.cspViolations): an injected inline script is refused AND recorded,
    // so a violation by the embed could not go unnoticed below.
    assert.deepEqual(await evaluate("window.cspViolations"), ["style-src-elem inline"]);     // the injected inline style above was refused and recorded
    await evaluate("window.cspViolations.length = 0; true");
    await evaluate('(() => { const script = document.createElement("script"); script.textContent = "window.__inline = 1"; document.head.append(script); script.remove(); return true; })()');
    await until(async () => (await evaluate("window.cspViolations.length")) > 0, "the collector did not see a CSP violation");
    assert.equal(await evaluate("window.__inline === undefined"), true);
    assert.match((await evaluate("window.cspViolations"))[0], /^script-src/u);
    await evaluate("window.cspViolations.length = 0; true");
    return `outline-style ${blocked}; collector sees violations`;
  });

  await step(2, "the launcher appears for a valid key and Origin, and it is accessible", async () => {
    await open(`${origins.C}/`);
    const ms = await until(() => evaluate('Boolean(document.querySelector(".dap-launcher-button"))'), "no launcher");
    metrics.launcherVisibleMs.push(ms);
    const state = await launcherState();
    assert.deepEqual([state.name, state.expanded, state.panelHidden], ["Guides", "false", true]);
    const request = seen.findLast(item => item.path === `/api/runtime/${keys.C}/guides`);
    assert.deepEqual([request.method, request.origin, request.cookie, request.authorization], ["GET", origins.C, false, false]);
    assert.equal(await evaluate("Object.isFrozen(window.DapEmbed) && window.DapEmbed.version === 1"), true);
    assert.equal(await evaluate('document.querySelectorAll("[style]").length + document.querySelectorAll("style").length'), 0);
    assert.equal(await evaluate('document.querySelector(".dap-live").getAttribute("aria-live")'), "polite");
    // The stylesheet really applied: the launcher is fixed in the corner with the accent color.
    assert.deepEqual(await evaluate('(() => { const s = getComputedStyle(document.querySelector(".dap-launcher-button")); return [getComputedStyle(document.querySelector(".dap-launcher")).position, s.backgroundColor]; })()'), ["fixed", "rgb(129, 47, 116)"]);
    await clean();
    return `visible after ${ms} ms`;
  });

  await step(3, "keyboard and focus: open, focus into the panel, Escape closes and returns focus; 320 px has no horizontal overflow", async () => {
    await clickButton("Guides");
    assert.deepEqual(await launcherState(), { name: "Guides", expanded: "true", panelHidden: false, active: "Start guide: Change display name" });
    await command("press", "Escape");
    assert.deepEqual(await launcherState(), { name: "Guides", expanded: "false", panelHidden: true, active: "dap-launcher-button" });
    await clickButton("Guides");
    for (const width of [320, 375, 768, 1280]) { await command("set", "viewport", String(width), "700"); await noOverflow(width); }
    await command("set", "viewport", "1280", "800");
    await command("press", "Escape");
    await clean();
  });

  await step(4, "a complete deterministic run on history routes: pushState navigation, typing, Save, text and route checks", async () => {
    await evaluate("window.__marker = 'same document'; true");
    await clickButton("Guides");
    const start = performance.now();
    await clickButton("Start guide: Change display name");
    await text("Open your profile.");
    metrics.startToFirstStepMs.push(Math.round(performance.now() - start));
    assert.equal(await evaluate('document.querySelector(".dap-launcher").hidden'), true);
    const runStart = performance.now();
    await command("click", '[data-ai-id="nav.profile"]');      // the application's own router: pushState, no popstate event
    await text("Type a new display name.");
    assert.equal(await evaluate("location.pathname"), "/profile");
    await command("click", "#display-name");
    await command("press", "A");
    await text("Press Save.");
    await command("click", '[data-ai-id="profile.save"]');
    await text("Your display name was changed.");
    metrics.runMs.push(Math.round(performance.now() - runStart));
    assert.equal(await evaluate('document.querySelector("#saved-status").textContent'), "Saved");
    assert.equal(await evaluate("window.__marker"), "same document");          // never reloaded: SPA navigation only
    await clean();
    return `first step ${metrics.startToFirstStepMs.at(-1)} ms, run ${metrics.runMs.at(-1)} ms`;
  });

  await step(5, "dismissing the result returns the launcher; DapEmbed.list() and start() work and refuse a concurrent run", async () => {
    await clickButton("Done");
    await until(() => evaluate('!document.querySelector(".dap-launcher").hidden && !document.querySelector(".dap-guide-card")'), "launcher did not return");
    assert.equal(await evaluate("document.activeElement?.className"), "dap-launcher-button");
    await evaluate("window.__r = null; window.DapEmbed.list().then(list => { window.__r = list.map(item => item.id); }); true");
    await until(() => evaluate("window.__r !== null"), "list() did not resolve");
    assert.deepEqual(await evaluate("window.__r"), ["wt-profile"]);
    await evaluate("window.__s = null; window.DapEmbed.start('wt-profile').then(result => { window.__s = result; }); true");
    await text("Open your profile.");
    assert.deepEqual(await evaluate("window.__s"), { ok: true });
    await evaluate("window.__t = undefined; window.DapEmbed.start('wt-profile').then(result => { window.__t = result; }); true");
    await until(() => evaluate("window.__t !== undefined"), "second start did not answer");
    assert.deepEqual(await evaluate("window.__t"), { ok: false, reason: "busy" });
    await command("press", "Escape");                                 // cancel the run; the result dialog closes it
    await text("Guide cancelled");
    await clickButton("Close");
    await clean();
  });

  await step(6, "a request never carried credentials; every call went to the script's origin only", async () => {
    const calls = seen.filter(item => item.path.startsWith("/api/runtime/"));
    assert.ok(calls.length >= 4);
    assert.ok(calls.every(item => item.method === "GET" && item.origin === origins.C && !item.cookie && !item.authorization && item.path.startsWith(`/api/runtime/${keys.C}/guides`)));
    assert.deepEqual([...new Set(c.requestPaths())].filter(path => path.startsWith("/api")), []);       // the application itself never saw an API call
  });
  await stop(c);

  const d = await fixture("D", { dapKey: keys.D, variant: "moved", name: "Profile D" });
  await step(7, "the SAME stored guide runs on the moved variant through the marker binding (profile.save -> profile.submit)", async () => {
    await open(`${origins.D}/`);
    await until(() => evaluate('Boolean(document.querySelector(".dap-launcher-button"))'), "no launcher on D");
    assert.equal(await evaluate('document.querySelector(\'[data-ai-id="profile.submit"]\')?.tagName'), "A");
    await clickButton("Guides");
    await clickButton("Start guide: Change display name");
    await text("Open your profile.");
    await command("click", '[data-ai-id="nav.profile"]');
    await text("Type a new display name.");
    await command("click", "#display-name");
    await command("press", "A");
    await text("Press Save.");
    await command("click", '[data-ai-id="profile.submit"]');
    await text("Your display name was changed.");
    await clean();
    await clickButton("Done");
  });
  await stop(d);

  const stale = await fixture("D", { dapKey: keys.stale, variant: "moved", name: "Profile D" });
  await step(8, "the stale binding fails closed on the moved variant (target unavailable), nothing is clicked or written", async () => {
    await open(`${origins.D}/`);
    await until(() => evaluate('Boolean(document.querySelector(".dap-launcher-button"))'), "no launcher on D (stale)");
    await clickButton("Guides");
    await clickButton("Start guide: Change display name");
    await text("Open your profile.");
    await command("click", '[data-ai-id="nav.profile"]');
    await text("Type a new display name.");
    await command("click", "#display-name");
    await command("press", "A");
    const start = performance.now();
    await until(() => evaluate('Boolean(document.querySelector("dialog.dap-result"))'), "no result dialog", 15_000);
    metrics.staleFailureMs.push(Math.round(performance.now() - start));
    assert.equal(await evaluate('document.querySelector("#saved-status").textContent'), "");
    assert.match(await evaluate('document.querySelector("dialog.dap-result").textContent'), /unavailable/iu);
    await clickButton("Close");
    await until(() => evaluate('!document.querySelector(".dap-launcher").hidden'), "launcher did not return");
  });
  await stop(stale);

  const unknown = await fixture("D", { dapKey: keys.unknown, name: "Profile D" });
  await step(9, "a wrong key leaves the page inert: no launcher, no global, nothing added", async () => {
    const before = seen.length;
    await command("console", "--clear"); await command("errors", "--clear");
    await open(`${origins.D}/`);
    await until(() => seen.slice(before).some(item => item.path === `/api/runtime/${keys.unknown}/guides`), "the embed never asked");
    await sleep(500);
    assert.deepEqual(await evaluate('[document.querySelector(".dap-launcher"), typeof window.DapEmbed, document.querySelectorAll("link[data-dap-embed]").length, document.querySelectorAll(".dap-launcher, .dap-launcher-panel, .dap-live, .dap-guide-card").length]'), [null, "undefined", 0, 0]);
    assert.equal(seen.findLast(item => item.path.includes(keys.unknown)).origin, origins.D);
  });
  await stop(unknown);

  const refused = await fixture("B", { dapKey: keys.refused, name: "Profile B" });
  await step(10, "an API that refuses the page's Origin (403, no CORS header) leaves no launcher content", async () => {
    const before = seen.length;
    await open(`${origins.B}/`);
    await until(() => seen.slice(before).some(item => item.path === `/api/runtime/${keys.refused}/guides`), "the embed never asked");
    await sleep(500);
    assert.equal(seen.findLast(item => item.path.includes(keys.refused)).origin, origins.B);
    assert.deepEqual(await evaluate('[document.querySelector(".dap-launcher"), typeof window.DapEmbed, document.querySelectorAll("link[data-dap-embed]").length, document.querySelectorAll(".dap-launcher, .dap-launcher-panel, .dap-live, .dap-guide-card").length]'), [null, "undefined", 0, 0]);
    assert.equal(await evaluate('document.body.innerText.includes("Guides")'), false);
  });
  await stop(refused);
  console.log(`OBSERVED_MS ${JSON.stringify(metrics)}`);
} finally {
  const stopped = await Promise.allSettled([chrome ? command("close") : undefined, ...servers.map(server => server.close()), new Promise(resolve => api.close(() => resolve(undefined)))]);
  api.closeAllConnections?.();
  assert.ok(stopped.every(result => result.status === "fulfilled"), "Every owned browser and server must close.");
}
