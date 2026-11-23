// Opt-in real-browser operator probe (Studio V1A, order R1). NOT part of `npm test`: it launches headless
// Chromium through the vendored agent-browser CLI. Run it with `npm run probe:studio-domains`, which builds
// the packages first. It needs no database; it serves two fixture applications from ephemeral loopback ports
// of its own and touches nothing else.
//
// Question answered: does the navigation policy of a BrowserRuntime session come from the origins it was
// configured with, and does it hold in a real browser when the page itself tries to leave them?
//   (i)   configured for [A]: starts on A, snapshots, batch-inspects the labelled controls
//   (ii)  A redirects the browser to B (same hostname, other port): the vendored host-level allow-list lets it
//         through, so DAP's exact-origin check must refuse it and expose no B content
//   (iii) A redirects to the `localhost` spelling (other hostname): never a successful snapshot of it
//   (iv)  configured for [A, B]: B is observable, so the policy is configuration, not code
//   (v)   CLI level: an unlisted host is refused, and the CLI allow-list is host-level only
//   (vi)  every browser session this probe opened is closed and every process it started is gone
//   (vii) Studio V1B managed modes (`labels: "all"`, `routes: "any"`): the controls of the page are exposed with bounded names only, element facts are
//         read, any hash-routed page is accepted, and the origin policy holds exactly as before (a query, another port and another host stay refused)
// (viii) Studio completion S1: history routing (`routing: "history"`, only when DAP_PROBE_PORT_C is set): query and fragment of the observed URL are ignored and never returned, a trailing slash
//   is removed, SPA navigation by pushState is observed as a page change, `//x` is refused, and the exact origin is still enforced.
// Ports: ephemeral by default; set DAP_PROBE_PORT_A and DAP_PROBE_PORT_B to pin the two fixture applications (the V1B reviewer uses 5186 and 5187); DAP_PROBE_PORT_C pins the history-routed fixture C and turns on (viii).
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { connect } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { BrowserRuntimeError, createAgentBrowserAdapter } from "../packages/browser-runtime/dist/index.js";
import { fixtureB } from "../tests/fixtures/studio-app/registry.mjs";
import { startHistoryApp } from "../tests/fixtures/studio-app/history-app.mjs";
import { startFixtureApp } from "../tests/fixtures/studio-app/server.mjs";

const run = promisify(execFile);
const cli = fileURLToPath(new URL("../vendor/agent-browser/cli/target/release/agent-browser", import.meta.url));
const config = fileURLToPath(new URL("../packages/browser-runtime/agent-browser.json", import.meta.url));
// The same minimal environment the adapter gives the browser: no provider credentials or inherited settings.
const env = Object.fromEntries(["PATH", "HOME", "USER", "LOGNAME", "DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "XAUTHORITY", "LANG"]
  .flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]]]));

if (!existsSync(cli)) {
  console.error("The vendored agent-browser binary is missing. Run `npm run build:agent-browser` first.");
  process.exit(2);
}

const redirectDelayMs = 1500;
const routes = Object.keys(fixtureB.browser.pages);
const labels = fixtureB.browser.labels.map(label => ({ ...label }));
const blockedMessage = "The browser URL is outside the approved app origin.";
const results = [];
const latency = {};
// (viii) History routing runs only when fixture C has a pinned port (DAP_PROBE_PORT_C), so the default invocation keeps its eight checks.
const expectedChecks = process.env.DAP_PROBE_PORT_C === undefined ? 8 : 9;
const port = name => { const value = Number(process.env[`DAP_PROBE_PORT_${name}`] ?? 0); assert.ok(Number.isInteger(value) && value >= 0 && value <= 65_535, `DAP_PROBE_PORT_${name}`); return value; };
const say = message => console.log(message);
const record = (id, ok, detail) => { results.push({ id, ok, detail }); say(`${ok ? "PASS" : "FAIL"} ${id} ${detail}`); };
const ms = start => Math.round(performance.now() - start);

// ---- CLI helpers -----------------------------------------------------------------------------------------------

async function cliJson(session, args, timeout = 20_000) {
  try {
    const { stdout } = await run(cli, ["--config", config, "--json", "--session", session, ...args], { timeout, env });
    return JSON.parse(stdout);
  } catch (error) {
    // A refused command exits non-zero but still prints its JSON verdict.
    try { return JSON.parse(error.stdout); } catch { return { success: false, error: "no JSON verdict" }; }
  }
}

async function inventory() {
  const { stdout } = await run(cli, ["--json", "session", "list"], { timeout: 20_000, env });
  return new Set(JSON.parse(stdout).data.sessions.map(entry => typeof entry === "string" ? entry : entry.name));
}

async function processTable() {
  const { stdout } = await run("ps", ["-eo", "pid=,ppid=,args="], { env });
  return stdout.split("\n").flatMap(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(.*)$/u.exec(line);
    return match ? [{ pid: Number(match[1]), ppid: Number(match[2]), args: match[3] }] : [];
  });
}

// The daemon behind a session carries the session name in its environment (Linux only). Its process tree is
// what must be gone after the session closes.
async function processesOf(session) {
  const table = await processTable();
  const roots = [];
  for (const row of table.filter(candidate => /release\/agent-browser\s*$/u.test(candidate.args))) {
    const environment = await readFile(`/proc/${row.pid}/environ`, "utf8").catch(() => "");
    if (environment.split("\0").includes(`AGENT_BROWSER_SESSION=${session}`)) roots.push(row.pid);
  }
  const owned = new Set(roots);
  for (let grew = true; grew;) {
    grew = false;
    for (const row of table) if (owned.has(row.ppid) && !owned.has(row.pid)) { owned.add(row.pid); grew = true; }
  }
  return owned;
}

const alive = pid => { try { process.kill(pid, 0); return true; } catch { return false; } };

// The page leaves on its own a fixed delay after its hash route loads. Starting on `/` and moving to the leave
// route by a hash change (as a link click would) keeps that clock independent of how long Chrome took to start.
async function sendToLeaveRoute(handle, origin, route) {
  assert.equal((await cliJson(handle.session, ["open", `${origin}${route}`])).success, true, "hash change to the leave route");
}

// ---- bookkeeping so everything this probe starts is stopped -----------------------------------------------------

const baseline = await inventory();
const started = [];      // { session, pids:Set }
const adapters = [];
const servers = [];

async function trackedAdapter(origins, policy = { labels, routes }) {
  const adapter = createAgentBrowserAdapter({ ...policy, origins });
  const handle = { adapter, session: undefined, pids: new Set() };
  adapters.push(handle);
  return handle;
}

async function begin(handle, url) {
  const before = await inventory();
  const t = performance.now();
  await handle.adapter.start({ url });
  const elapsed = ms(t);
  const added = [...await inventory()].filter(name => !before.has(name));
  assert.equal(added.length, 1, "exactly one new browser session");
  handle.session = added[0];
  handle.pids = await processesOf(handle.session);
  started.push({ session: handle.session, pids: handle.pids });
  return elapsed;
}

async function teardown() {
  for (const handle of adapters) {
    await handle.adapter.close().catch(() => undefined);
    // Fallback for a session the adapter could not close; never address a session that is already gone.
    if (handle.session && (await inventory().catch(() => new Set())).has(handle.session)) await cliJson(handle.session, ["close"]);
  }
  for (const server of servers) await server.close().catch(() => undefined);
}

// ---- the probe -------------------------------------------------------------------------------------------------

const fixtureTitle = "Fixture application";
let failedHard;
try {
  say(`agent-browser ${(await run(cli, ["--version"], { env })).stdout.trim()} | headless | redirect delay ${redirectDelayMs} ms`);
  const b = await startFixtureApp({ name: "B", redirectDelayMs, port: port("B") });
  servers.push(b);
  const a = await startFixtureApp({ name: "A", leaveOrigin: b.origin, redirectDelayMs, port: port("A") });
  servers.push(a);
  const alias = new URL(a.origin);
  alias.hostname = "localhost";
  const localhostOrigin = alias.origin;
  say(`A ${a.origin} | B ${b.origin} | localhost alias ${localhostOrigin}`);

  // An error from the adapter must be the fixed, closed message: no page content, no URLs.
  const refusal = error => error instanceof BrowserRuntimeError && error.code === "DOMAIN_BLOCKED" && error.message === blockedMessage
    && !error.message.includes(b.origin) && !JSON.stringify(error).includes(fixtureTitle);

  // Poll the adapter until it refuses (or the window ends), keeping every URL it was willing to return.
  async function watch(adapter, windowMs, stopOn) {
    const seen = [];
    let last;
    const deadline = performance.now() + windowMs;
    while (performance.now() < deadline) {
      try {
        const snapshot = await adapter.snapshot();
        seen.push(snapshot.url);
        if (stopOn?.(snapshot)) return { seen, last, snapshot };
      } catch (error) {
        last = error;
        // A navigation in flight can fail a snapshot transiently; only a policy refusal ends the watch early.
        if (error instanceof BrowserRuntimeError && error.code === "DOMAIN_BLOCKED") return { seen, last };
      }
      await sleep(250);
    }
    return { seen, last };
  }

  // (i) configured for [A] ----------------------------------------------------------------------------------
  {
    const handle = await trackedAdapter([a.origin]);
    latency.connectMs = await begin(handle, a.origin + "/");
    let t = performance.now();
    const home = await handle.adapter.snapshot();
    latency.snapshotMs = ms(t);
    const homeNames = home.elements.map(element => `${element.role}:${element.name}`);
    t = performance.now();
    const homeIds = await handle.adapter.inspectSemanticIds(home);
    latency.batchInspectMs = ms(t);
    latency.batchCandidates = homeIds.size;
    const orders = home.elements.find(element => element.name === "Orders");
    assert.ok(orders, "the Orders link is a candidate");
    t = performance.now();
    await handle.adapter.highlight(orders.ref, home);
    latency.highlightMs = ms(t);
    // Move to the orders route inside the same session, as a user clicking the link would.
    assert.equal((await cliJson(handle.session, ["click", '[data-ai-id="nav.orders"]'])).success, true);
    await sleep(300);
    const page = await handle.adapter.snapshot();
    const pageIds = await handle.adapter.inspectSemanticIds(page);
    const found = [...pageIds].map(([ref, id]) => `${page.elements.find(element => element.ref === ref).name}=${id}`).sort();
    const ok = new URL(home.url).origin === a.origin
      && JSON.stringify(homeNames) === JSON.stringify(["link:Orders"]) && homeIds.get(orders.ref) === "nav.orders"
      && page.url === `${a.origin}/#/orders`
      && JSON.stringify(found) === JSON.stringify(["Order note=orders.note", "Submit order=orders.submit"]);
    record("(i) configured [A]", ok,
      `start ${latency.connectMs} ms, snapshot ${latency.snapshotMs} ms, batch ${latency.batchInspectMs} ms/${latency.batchCandidates}, highlight ${latency.highlightMs} ms; `
      + `home ${JSON.stringify(homeNames)} -> ${[...homeIds.values()]}; orders -> ${found}; unapproved label "Admin" ${homeNames.some(name => name.includes("Admin")) ? "EXPOSED" : "withheld"}`);
    await handle.adapter.close();
  }

  // (ii) A redirects the browser to B's origin: same hostname, other port -----------------------------------
  {
    const handle = await trackedAdapter([a.origin]);
    await begin(handle, a.origin + "/");
    const requestsBefore = b.requestHosts().length;
    await sendToLeaveRoute(handle, a.origin, "/#/leave-origin");
    const { seen, last } = await watch(handle.adapter, redirectDelayMs + 6000);
    const reachedB = b.requestHosts().length > requestsBefore;
    // The adapter is exclusive, so the follow-up reads run one after the other.
    const afterwards = [];
    for (const read of [() => handle.adapter.getUrl(), () => handle.adapter.snapshot(), () => handle.adapter.waitForChange({ timeoutMs: 300 })]) {
      afterwards.push(await read().then(() => ({ ok: true }), error => ({ ok: false, error })));
    }
    const allRefused = afterwards.every(outcome => !outcome.ok && refusal(outcome.error));
    const onlyA = seen.every(url => new URL(url).origin === a.origin);
    const ok = refusal(last) && onlyA && allRefused;
    record("(ii) leave-origin -> B refused", ok,
      `${last?.code ?? "no refusal"}; the browser reached B (the CLI host-level allow-list let it through): ${reachedB}; `
      + `${seen.length} snapshot(s) returned, only ever on A: ${onlyA}; later getUrl/snapshot/waitForChange refused: ${allRefused}`);
    await handle.adapter.close();
  }

  // (iii) A redirects to the localhost spelling: another hostname ------------------------------------------------
  {
    const handle = await trackedAdapter([a.origin]);
    await begin(handle, a.origin + "/");
    await sendToLeaveRoute(handle, a.origin, "/#/leave-host");
    const { seen, last } = await watch(handle.adapter, redirectDelayMs + 4000);
    const neverLocalhost = seen.every(url => new URL(url).hostname === "127.0.0.1");
    const reachedLocalhost = a.requestHosts().some(host => host.startsWith("localhost:"));
    const safeError = last === undefined || (last instanceof BrowserRuntimeError && ["DOMAIN_BLOCKED", "SNAPSHOT_FAILED", "NAVIGATION_FAILED"].includes(last.code));
    const ok = neverLocalhost && !reachedLocalhost && safeError;
    record("(iii) leave-host -> localhost blocked", ok,
      `outcome ${last?.code ?? "page stayed on A (navigation never happened)"}; the localhost spelling reached the server: ${reachedLocalhost}; `
      + `${seen.length} snapshot(s), none on localhost: ${neverLocalhost}`);
    await handle.adapter.close();

    // Control: the redirect really fires, and only configuration decides whether it is allowed.
    const control = await trackedAdapter([a.origin, localhostOrigin]);
    await begin(control, a.origin + "/");
    await sendToLeaveRoute(control, a.origin, "/#/leave-host");
    const moved = await watch(control.adapter, redirectDelayMs + 6000, snapshot => new URL(snapshot.url).hostname === "localhost");
    const controlOk = moved.snapshot !== undefined && moved.snapshot.url === `${localhostOrigin}/#/home`;
    record("(iii-control) configured [A, localhost alias] observes it", controlOk,
      controlOk ? `snapshot at ${moved.snapshot.url}` : `never reached the alias; last ${moved.last?.code ?? "none"}; saw ${moved.seen.length} snapshot(s)`);
    await control.adapter.close();
  }

  // (iv) configured for [A, B]: B is legitimately observable ------------------------------------------------------
  {
    const handle = await trackedAdapter([a.origin, b.origin]);
    await begin(handle, a.origin + "/");
    await sendToLeaveRoute(handle, a.origin, "/#/leave-origin");
    const moved = await watch(handle.adapter, redirectDelayMs + 6000, snapshot => new URL(snapshot.url).origin === b.origin);
    let ids = new Map();
    if (moved.snapshot) ids = await handle.adapter.inspectSemanticIds(moved.snapshot);
    const ok = moved.snapshot?.url === `${b.origin}/#/home` && [...ids.values()].join() === "nav.orders";
    record("(iv) configured [A, B] observes B", ok,
      ok ? `snapshot at ${moved.snapshot.url}, batch ${[...ids.values()]}` : `never observed B; last ${moved.last?.code ?? "none"}; saw ${moved.seen.length} snapshot(s)`);
    await handle.adapter.close();
  }


  // (vii) Studio V1B managed modes -------------------------------------------------------------------------------
  {
    const handle = await trackedAdapter([a.origin], { labels: "all", routes: "any" });
    await begin(handle, a.origin + "/");
    const home = await handle.adapter.snapshot();
    const homeNames = home.elements.map(element => `${element.role}:${element.name}`);
    const homeIds = await handle.adapter.inspectSemanticIds(home);
    // The same page as (i), but nothing is pre-approved: the decoy "Admin" link is exposed by name too (the host forwards only marked controls).
    assert.equal((await cliJson(handle.session, ["click", '[data-ai-id="nav.orders"]'])).success, true);
    await sleep(300);
    const orders = await handle.adapter.snapshot();
    const refs = orders.elements.map(element => element.ref);
    let t = performance.now();
    const found = await handle.adapter.inspectElementFacts(refs, orders);
    latency.factsMs = ms(t);
    latency.factsRefs = refs.length;
    const byName = Object.fromEntries(orders.elements.map(element => [element.name, found.get(element.ref)]));
    const factsOk = byName["Order note"]?.inputType === "text" && byName["Order note"]?.autocomplete === null && byName["Order note"]?.dataAiPrivate === false
      && byName["Submit order"]?.inputType === "button" && byName["Order note"]?.tagName === null;
    // Any hash-routed page is accepted; a query is not; another port and another host are not (the origin policy is unchanged).
    await cliJson(handle.session, ["open", `${a.origin}/#/anywhere-at-all`]);
    await sleep(300);
    const anywhere = await handle.adapter.snapshot().then(snapshot => snapshot.url, error => error.code);
    await cliJson(handle.session, ["open", `${a.origin}/?token=canary#/orders`]);
    await sleep(300);
    const withQuery = await handle.adapter.snapshot().then(() => "accepted", error => error.code);
    await cliJson(handle.session, ["open", `${a.origin}/#/leave-origin`]);
    const { seen, last } = await watch(handle.adapter, redirectDelayMs + 6000);
    const otherPort = refusal(last) && seen.every(url => new URL(url).origin === a.origin);
    // Named headings are exposed too (document order, text elements); only the two links are operable controls.
    const controls = home.elements.filter(element => element.role !== "heading");
    const ok = JSON.stringify(homeNames) === JSON.stringify(["heading:Fixture application A", "heading:Home", "link:Orders", "link:Admin"]) && homeIds.get(controls[0].ref) === "nav.orders" && homeIds.get(controls[1].ref) === null
      && factsOk && anywhere === `${a.origin}/#/anywhere-at-all` && withQuery === "DOMAIN_BLOCKED" && otherPort;
    record("(vii) managed modes (all + any)", ok,
      `home ${JSON.stringify(homeNames)}; facts for ${refs.length} refs in ${latency.factsMs} ms (Order note: ${JSON.stringify(byName["Order note"])}); /#/anywhere-at-all: ${anywhere}; query: ${withQuery}; `
      + `redirect to B's origin refused: ${otherPort}`);
    await handle.adapter.close();
  }

  // (viii) Studio completion S1: history routing ---------------------------------------------------------------
  if (process.env.DAP_PROBE_PORT_C !== undefined) {
    const c = await startHistoryApp({ name: "C", port: port("C") });
    servers.push(c);
    const handle = await trackedAdapter([c.origin], { labels: "all", routes: "any", routing: "history" });
    latency.historyStartMs = await begin(handle, `${c.origin}/profile?variant=moved&token=canary-secret#frag-secret`);
    const deep = await handle.adapter.snapshot();
    const names = deep.elements.map(element => `${element.role}:${element.name}`);
    const seen = [deep.url, await handle.adapter.getUrl()];
    // SPA navigation: a click on a link pushes a new pathname without a reload.
    const served = () => c.requestPaths().filter(path => path !== "/favicon.ico").length;
    const requestsBefore = served();
    assert.equal((await cliJson(handle.session, ["click", '[data-ai-id="nav.settings"]'])).success, true);
    await sleep(300);
    const settings = await handle.adapter.snapshot();
    seen.push(settings.url);
    const reloaded = served() !== requestsBefore;
    // A trailing slash and a query are not part of the page; a double slash is refused; the other port and host are refused.
    const outcomes = {};
    for (const [label, path] of [["trailing", "/profile/?a=1#b"], ["double", "//evil"], ["unicode", "/%C3%A9"], ["deep", "/users/123?x=y"]]) {
      await cliJson(handle.session, ["open", `${c.origin}${path}`]);
      await sleep(300);
      outcomes[label] = await handle.adapter.snapshot().then(snapshot => snapshot.url.slice(c.origin.length), error => error.code);
      seen.push(outcomes[label]);
    }
    // The other spelling of the host: refused by the CLI allow-list (host level) and, if a redirect ever got there, by the adapter (exact origin); the page never moves.
    const cliRefused = (await cliJson(handle.session, ["open", `http://localhost:${c.port}/profile`])).success === false;
    await sleep(300);
    const otherHost = await handle.adapter.snapshot().then(snapshot => (snapshot.url.endsWith("/users/123") ? "stayed" : "moved"), error => error.code);
    const leaked = /canary-secret|frag-secret|variant|token/u.test(JSON.stringify([seen, names]));
    const ok = deep.url === `${c.origin}/profile` && names.includes("textbox:Display name") && names.includes("button:Save") && settings.url === `${c.origin}/settings` && !reloaded
      && outcomes.trailing === "/profile" && outcomes.double === "DOMAIN_BLOCKED" && outcomes.unicode === "DOMAIN_BLOCKED" && outcomes.deep === "/users/123" && cliRefused && otherHost === "stayed" && !leaked;
    record("(viii) history routing", ok,
      `deep link with query+fragment -> ${deep.url.slice(c.origin.length)}; SPA click -> ${settings.url.slice(c.origin.length)} (reloaded: ${reloaded}); ${JSON.stringify(outcomes)}; localhost spelling refused by the CLI: ${cliRefused} (page ${otherHost}); query/fragment ever returned: ${leaked}`);
    await handle.adapter.close();
  }

  // (v) CLI level -----------------------------------------------------------------------------------------------
  {
    const session = `studio-probe-${randomUUID()}`;
    // The control in (iii) legitimately reached the localhost spelling earlier; only requests from here on count.
    const localhostRequests = () => a.requestHosts().filter(host => host.startsWith("localhost:")).length;
    const servedBefore = localhostRequests();
    const flags = ["--allowed-domains", new URL(a.origin).hostname, "--no-webmcp"];
    const unlisted = await cliJson(session, [...flags, "open", "http://example.invalid/"]);
    started.push({ session, pids: await processesOf(session) });
    const unlistedLocalhost = await cliJson(session, ["open", `${localhostOrigin}/`]);
    const servedLocalhost = localhostRequests() > servedBefore;
    const sameHostOtherPort = await cliJson(session, ["open", `${b.origin}/`]);
    const ok = unlisted.success === false && unlistedLocalhost.success === false && !servedLocalhost && sameHostOtherPort.success === true;
    record("(v) CLI allow-list", ok,
      `example.invalid refused: ${unlisted.success === false}; localhost spelling refused: ${unlistedLocalhost.success === false} and never served: ${!servedLocalhost}; `
      + `other port on the listed host allowed by the CLI (host-level only; DAP enforces scheme and port): ${sameHostOtherPort.success === true}`);
    started.at(-1).pids = new Set([...started.at(-1).pids, ...await processesOf(session)]);
    await cliJson(session, ["close"]);
  }
} catch (error) {
  failedHard = error;
  say(`FAIL probe aborted: ${error instanceof BrowserRuntimeError ? error.code : error?.message ?? error}`);
} finally {
  await teardown();
}

// (vi) cleanup -------------------------------------------------------------------------------------------------------
{
  const leftSessions = [...await inventory()].filter(name => !baseline.has(name));
  const deadline = performance.now() + 8000;
  const owned = new Set(started.flatMap(entry => [...entry.pids]));
  while (performance.now() < deadline && [...owned].some(alive)) await sleep(200);
  const leaked = [...owned].filter(alive);
  // Only processes this probe provably started (by PID) are ever signalled.
  for (const pid of leaked) { try { process.kill(pid, "SIGTERM"); } catch { /* already gone */ } }
  if (leaked.length) { await sleep(1500); for (const pid of leaked.filter(alive)) { try { process.kill(pid, "SIGKILL"); } catch { /* already gone */ } } }
  const unreachable = [];
  for (const server of servers) {
    const closed = await new Promise(resolve => {
      const socket = connect({ port: server.port, host: "127.0.0.1" });
      socket.once("connect", () => { socket.destroy(); resolve(false); });
      socket.once("error", () => resolve(true));
    });
    if (!closed) unreachable.push(server.origin);
  }
  record("(vi) cleanup", leftSessions.length === 0 && leaked.length === 0 && unreachable.length === 0 && !failedHard,
    `sessions left: ${leftSessions.length}; processes tracked ${owned.size}, still alive after close: ${leaked.length}; fixture servers still listening: ${unreachable.length}`);
}

const failed = results.filter(result => !result.ok);
say(`PROBE_RESULT ${JSON.stringify({ ok: failed.length === 0 && results.length === expectedChecks, checks: results.length, failed: failed.map(result => result.id), latencyMs: latency })}`);
process.exit(failed.length === 0 && results.length === expectedChecks && !failedHard ? 0 : 1);
