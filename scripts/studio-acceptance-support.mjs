import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { once } from "node:events";
import { access, readFile } from "node:fs/promises";
import { connect as tcpConnect } from "node:net";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createAuthoringExtension } from "../apps/reference-host/dist/authoring/capabilities.js";
import { createAuthoringPool } from "../apps/reference-host/dist/authoring/pool.js";
import { createPostgresWalkthroughStore } from "../apps/reference-host/dist/authoring/postgres-store.js";
import { createDemoPrincipalResolver } from "../apps/reference-host/dist/authoring/principal.js";
import { registerAuthoringRoutes } from "../apps/reference-host/dist/authoring/routes.js";
import { withTenant } from "../apps/reference-host/dist/authoring/tenant-tx.js";
import { composeReferenceHost } from "../apps/reference-host/dist/compose.js";
import { parseDevSessions } from "../apps/reference-host/dist/dev-auth/index.js";
import { createProposalStore } from "../apps/reference-host/dist/http/proposal-store.js";
import { createGuidanceTransport } from "../apps/reference-host/dist/http/transport.js";
import { createApplicationExtension } from "../apps/reference-host/dist/studio/application-capabilities.js";
import { registerApplicationRoutes } from "../apps/reference-host/dist/studio/application-routes.js";
import { registerStudioBrowser } from "../apps/reference-host/dist/studio/browser.js";
import { createPostgresApplicationStore } from "../apps/reference-host/dist/studio/postgres-application-store.js";
import { createPostgresTargetStore } from "../apps/reference-host/dist/studio/postgres-target-store.js";
import { registerRuntimeRoutes } from "../apps/reference-host/dist/studio/runtime-routes.js";
import { createRegistryResolver } from "../apps/reference-host/dist/studio/registry-resolver.js";
import { createTargetExtension } from "../apps/reference-host/dist/studio/target-capabilities.js";
import { createRegistryCatalog } from "../apps/reference-host/dist/studio/registries.js";
import { createAgentBrowserAdapter } from "../packages/browser-runtime/dist/index.js";
import { localCli } from "../packages/browser-runtime/dist/cli.js";
import { fixtureB } from "../tests/fixtures/studio-app/registry.mjs";
import { startHistoryApp } from "../tests/fixtures/studio-app/history-app.mjs";
import { startFixtureApp } from "../tests/fixtures/studio-app/server.mjs";

const run = promisify(execFile);
const browserEnv = Object.fromEntries(["PATH", "HOME", "USER", "LOGNAME", "DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "XAUTHORITY", "LANG"]
  .flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]]]));
const root = fileURLToPath(new URL("..", import.meta.url));
const cli = fileURLToPath(new URL("../vendor/agent-browser/cli/target/release/agent-browser", import.meta.url));
const config = fileURLToPath(new URL("../packages/browser-runtime/agent-browser.json", import.meta.url));
const managed = process.argv.includes("--managed");
const completion = process.argv.includes("--completion");
const v1bPorts = completion || managed || process.argv.includes("--v1b-ports");
const ports = completion ? [8795, 5186, 5187, 5188, 5189] : v1bPorts ? [8795, 5186, 5187] : [8794, 5184, 5185];
const hostOrigin = `http://127.0.0.1:${ports[0]}`;
export const originA = `http://127.0.0.1:${ports[1]}`;
export const standaloneOrigin = completion ? "http://127.0.0.1:5189" : undefined;
export const originB = `http://127.0.0.1:${ports[2]}`;
const useHeaded = !process.argv.includes("--headless") && (managed || Boolean(browserEnv.DISPLAY || browserEnv.WAYLAND_DISPLAY));
const deadline = 30_000;
const databaseUrl = process.env.DAP_DATABASE_URL;
const databasePort = process.env.DAP_ACCEPTANCE_DB_PORT;
assert.ok(databasePort && /^[1-9][0-9]{0,4}$/u.test(databasePort) && Number(databasePort) <= 65_535
  && !["5432", "8787"].includes(databasePort), "Set DAP_ACCEPTANCE_DB_PORT to the isolated acceptance database port");
const database = URL.parse(databaseUrl ?? "");
assert.ok(database && database.protocol === "postgresql:" && database.hostname === "127.0.0.1" && database.port === databasePort
  && database.username === "dap_app" && database.pathname === "/dap" && !database.search && !database.hash && (!v1bPorts || databasePort === "54362"), "Use the isolated acceptance database as dap_app");
await access(cli);

export const elapsed = started => Math.round(performance.now() - started);
export const metrics = { connect: [], refresh: [], highlight: [], capture: [], disconnect: [] };
export async function step(name, operation) {
  const start = performance.now();
  try {
    const detail = await operation();
    console.log(`PASS ${name} | ${elapsed(start)} ms${detail === undefined ? "" : ` | ${detail}`}`);
  } catch (error) {
    console.log(`FAIL ${name} | ${elapsed(start)} ms`);
    throw error;
  }
}

async function cliJson(args) {
  try {
    const { stdout } = await run(cli, ["--config", config, "--json", ...args], { env: browserEnv, timeout: 20_000 });
    return JSON.parse(stdout);
  } catch (error) {
    if (error.stdout) return JSON.parse(error.stdout);
    throw new Error("The vendored browser command returned no JSON");
  }
}
export async function inventory() {
  const result = await cliJson(["session", "list"]);
  assert.equal(result.success, true);
  return new Set(result.data.sessions.map(item => typeof item === "string" ? item : item.name));
}

const ownedSessions = new Set();
const ownedProcesses = new Map();
let vite;
let fixture;
let historyFixture;
let standaloneFixture;
export const historyApp = () => historyFixture;
export async function startStandaloneHistory(dapKey) {
  assert.ok(completion && !standaloneFixture, "Standalone fixture is only available once in completion acceptance");
  standaloneFixture = await startHistoryApp({ port: ports[4], variant: "moved", dapOrigin: hostOrigin, dapKey, csp: true });
  return standaloneFixture;
}
let host;
let app;
let pool;
let nativeSession;
const baseline = await inventory();

async function processTable() {
  const { stdout } = await run("ps", ["-eo", "pid=,ppid=,stat=,lstart=,args="], { env: browserEnv });
  return stdout.split("\n").flatMap(line => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+)\s+(.{24})\s+(.*)$/u.exec(line);
    return match && !match[3].startsWith("Z") ? [{ pid: Number(match[1]), parent: Number(match[2]), started: match[4], args: match[5] }] : [];
  });
}
export async function trackProcesses() {
  const table = await processTable();
  const pids = new Set(table.filter(row => row.pid === vite?.pid && vite.exitCode === null && vite.signalCode === null).map(row => row.pid));
  for (const row of table.filter(item => item.args === cli)) {
    const environment = await readFile(`/proc/${row.pid}/environ`, "utf8").catch(() => "");
    if (environment.split("\0").some(field => field.startsWith("AGENT_BROWSER_SESSION=")
      && ownedSessions.has(field.slice("AGENT_BROWSER_SESSION=".length)))) pids.add(row.pid);
  }
  for (let prior = -1; prior !== pids.size;) {
    prior = pids.size;
    for (const row of table) if (pids.has(row.parent)) pids.add(row.pid);
  }
  for (const row of table) if (pids.has(row.pid)) ownedProcesses.set(row.pid, row.started);
}
const remainingProcesses = async () => (await processTable()).filter(row => ownedProcesses.get(row.pid) === row.started);
export async function until(check, message, timeout = 8_000) {
  const start = performance.now();
  while (elapsed(start) < timeout) {
    if (await check()) return;
    await sleep(100);
  }
  throw new Error(message);
}
const portOpen = port => new Promise(resolve => {
  const socket = tcpConnect({ host: "127.0.0.1", port });
  socket.once("connect", () => { socket.destroy(); resolve(true); });
  socket.once("error", () => resolve(false));
});

const tenantId = randomUUID();
function demoSession(tenant, userId, permissions) {
  return { token: randomUUID(), tenantId: tenant, userId, sessionId: `s-${randomUUID()}`,
    validUntil: new Date(Date.now() + 3_600_000).toISOString(), permissions };
}
const primary = demoSession(tenantId, "studio-acceptance", ["perm.walkthrough.maintain"]);
const foreign = demoSession(randomUUID(), "studio-foreign", ["perm.walkthrough.maintain"]);
const user = demoSession(tenantId, "studio-user", []);
const peer = demoSession(tenantId, "studio-peer", ["perm.walkthrough.maintain"]);
export const requests = [];
const abort = new AbortController();
const stop = () => abort.abort();
process.once("SIGINT", stop);
process.once("SIGTERM", stop);

async function startHost() {
  pool = createAuthoringPool(databaseUrl);
  const store = createPostgresWalkthroughStore(pool);
  const applications = createPostgresApplicationStore(pool);
  const catalog = createRegistryCatalog([{ ...fixtureB, previewable: false }]);
  const targets = createPostgresTargetStore(pool);
  const resolver = createRegistryResolver({ catalog, targets });
  const targetExtension = createTargetExtension({ targets });
  const authoring = createAuthoringExtension({ store, applications, catalog, targets, resolver });
  const application = createApplicationExtension({ store: applications, catalog });
  const rawSessions = JSON.stringify([primary, foreign, user, peer]);
  ({ host } = await composeReferenceHost({
    NODE_ENV: "test", DAP_ALLOW_DEV_AUTH: "1", DAP_DATABASE_URL: databaseUrl, DEV_SESSIONS: rawSessions,
    DAP_ENABLED_ACTIONS: "demoLookup,saveWalkthroughDraft,setWalkthroughStatus,reviseWalkthrough,restoreWalkthroughVersion,saveStudioApplication,setStudioApplicationEnabled,registerStudioTarget,setStudioTargetStatus,rotateStudioRuntimeKey,setStudioTargetHealth,repairStudioTarget,registerStudioCheck,setStudioCheckStatus",
  }, { extensions: [authoring.extension, application.extension, targetExtension.extension] }));
  const resolverFor = session => createDemoPrincipalResolver({
    sessions: parseDevSessions(rawSessions), userToken: user.token, maintainerToken: session.token,
    openSession: token => host.openSession(token),
  });
  const primaryResolver = resolverFor(primary);
  const foreignResolver = resolverFor(foreign);
  const peerResolver = resolverFor(peer);
  const resolvePrincipal = headers => (headers["x-studio-acceptance-tenant"] === "foreign" ? foreignResolver
    : headers["x-studio-acceptance-tenant"] === "peer" ? peerResolver : primaryResolver)(headers);
  app = createGuidanceTransport({
    ask: async () => ({ kind: "clarify", message: "Acceptance host" }), catalog: { list: () => [] },
    resolveSession: async () => null, proposals: createProposalStore({ now: Date.now, newId: randomUUID }),
  });
  const requestStartedAt = new WeakMap();
  app.addHook("onRequest", async (request) => { requestStartedAt.set(request, performance.now()); });
  app.addHook("onSend", async (request, reply, payload) => {
    const response = (request.url === "/api/studio/browser" || (completion && request.url.startsWith("/api/admin/walkthroughs/"))) && typeof payload === "string" ? JSON.parse(payload) : undefined;
    requests.push({ method: request.method, path: request.url, role: request.headers["x-demo-role"],
      body: request.body, response, origin: request.headers.origin, hasCookie: request.headers.cookie !== undefined, status: reply.statusCode, ms: elapsed(requestStartedAt.get(request)) });
    return payload;
  });
  registerAuthoringRoutes(app, { store, applications, catalog, targets, resolver, resolvePrincipal });
  registerApplicationRoutes(app, { applications, catalog, targets, resolver, resolvePrincipal });
  if (completion) {
    registerRuntimeRoutes(app, { applications, store, catalog, targets, resolver });
    for (const [name, type] of [["dap-embed.js", "text/javascript"], ["dap-embed.css", "text/css"]]) {
      const asset = await readFile(new URL(`../apps/reference-web/dist-embed/${name}`, import.meta.url));
      app.get(`/${name}`, async (_request, reply) => reply.type(type).send(asset));
    }
  }
  const execute = localCli(cli);
  registerStudioBrowser(app, {
    resolvePrincipal, applications, catalog, authoring: store, targets, resolver,
    createRuntime: options => createAgentBrowserAdapter(options, (args, timeout) => {
      const session = args[args.indexOf("--session") + 1];
      assert.match(session, /^dap-[0-9a-f-]{36}$/u);
      assert.ok(!baseline.has(session), "Adapter must have a fresh session");
      ownedSessions.add(session);
      nativeSession = session;
      return execute(useHeaded ? args : args.filter(arg => arg !== "--headed"), timeout);
    }),
  });
  await app.listen({ host: "127.0.0.1", port: ports[0] });
}

export async function request(method, path, status, body, tenant = "primary") {
  const response = await fetch(hostOrigin + path, {
    method, headers: { "x-demo-role": "maintainer", "x-studio-acceptance-tenant": tenant, "content-type": "application/json" },
    signal: AbortSignal.any([abort.signal, AbortSignal.timeout(deadline)]),
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const result = await response.json();
  assert.equal(response.status, status, `${method} ${path}: ${JSON.stringify(result)}`);
  return result;
}
export async function studio(action, fields, status = 200) {
  const start = performance.now();
  const result = await request("POST", "/api/studio/browser", status, { action, ...fields });
  const ms = elapsed(start);
  assert.ok(ms < deadline, `${action} finished within the request budget`);
  if (status === 200 && metrics[action]) metrics[action].push(action === "refresh" ? { ms, candidates: result.elements.length } : ms);
  return result;
}
export const browserSession = () => nativeSession;
export const query = operation => withTenant(pool, tenantId, operation);
export async function shutdownHost() {
  await app.close();
  app = undefined;
}
export async function browserCommand(session, ...args) {
  assert.ok(ownedSessions.has(session) && (await inventory()).has(session), "Operate only on a live acceptance session");
  return cliJson(["--session", session, ...args]);
}
export async function launchOperator(url = originA + "/") {
  assert.ok(url === originA + "/" || (completion && standaloneFixture && url === standaloneFixture.origin + "/"),
    "Launch only on an isolated acceptance fixture");
  const session = `studio-ui-${randomUUID()}`;
  assert.ok(!baseline.has(session), "Operator must have a fresh session");
  ownedSessions.add(session);
  const result = await cliJson(["--session", session, "--allowed-domains", "127.0.0.1", "--no-webmcp",
    ...(useHeaded ? ["--headed"] : []), "open", url]);
  assert.equal(result.success, true, result.error);
  await trackProcesses();
  return session;
}

async function finalManagedStep(name, operation) {
  const started = performance.now();
  try { const proof = await operation(); console.log(`STEP 14 PASS ${elapsed(started)} ms | ${proof}`); }
  catch (error) { console.log(`STEP 14 FAIL ${elapsed(started)} ms | ${name}`); throw error; }
}
export async function runStudioAcceptance(acceptance) {
  let failure;
  try {
    await step(completion ? "0 start isolated host, Vite and fixtures B/C" : "0 start isolated host, Vite and fixture B", async () => {
      for (const port of ports) assert.equal(await portOpen(port), false, `Port ${port} is already in use`);
      await startHost();
      fixture = await startFixtureApp({ port: ports[2], name: "Second application", ...((managed || completion) ? {
        embedScriptPath: fileURLToPath(new URL("../apps/reference-web/dist-embed/dap-embed.js", import.meta.url)), dapOrigin: originA, extras: true,
      } : {}) });
      assert.equal(fixture.origin, originB);
      if (completion) historyFixture = await startHistoryApp({ port: ports[3], embedScriptPath: fileURLToPath(new URL("../apps/reference-web/dist-embed/dap-embed.js", import.meta.url)), dapOrigin: originA });
      vite = spawn(process.execPath, ["node_modules/vite/bin/vite.js", "apps/reference-web", "--port", String(ports[1]), "--strictPort"], {
        cwd: root, env: { ...browserEnv, DAP_HTTP_PORT: String(ports[0]) }, stdio: ["ignore", "ignore", "inherit"],
      });
      await once(vite, "spawn");
      await until(async () => (await fetch(originA, { signal: AbortSignal.timeout(1000) }).catch(() => null))?.ok, "Reference Vite server did not start");
      return `Chromium ${useHeaded ? "headed" : "headless"}`;
    });
    await acceptance();
  } catch (error) {
    failure = error;
    console.error(error);
  } finally {
    try {
      await (managed ? finalManagedStep : step)("cleanup compare sessions, PIDs and ports", async () => {
        const tracking = trackProcesses().catch(error => { failure ??= error; });
        await tracking;
        const results = await Promise.allSettled([app?.close(), fixture?.close(), historyFixture?.close(), standaloneFixture?.close()]);
        results.push(...await Promise.allSettled([host?.close(), pool?.end()]));
        for (const session of await inventory()) {
          if (ownedSessions.has(session)) await cliJson(["--session", session, "close"]);
        }
        if (vite?.exitCode === null && vite.signalCode === null) {
          vite.kill("SIGTERM");
          try {
            await until(() => vite.exitCode !== null || vite.signalCode !== null, "Vite did not exit after SIGTERM");
          } catch (error) {
            vite.kill("SIGKILL");
            await until(() => vite.exitCode !== null || vite.signalCode !== null, "Vite did not exit after SIGKILL");
            throw error;
          }
        }
        try {
          await until(async () => (await remainingProcesses()).length === 0, "Owned browser or Vite process outlived normal cleanup");
        } catch (error) {
          for (const row of await remainingProcesses()) {
            try { process.kill(row.pid, "SIGTERM"); } catch (signalError) { if (signalError.code !== "ESRCH") throw signalError; }
          }
          await until(async () => (await remainingProcesses()).length === 0, "Owned process survived termination");
          throw error;
        }
        const sessions = await inventory();
        assert.deepEqual(sessions, baseline, "Browser session inventory must match the baseline");
        const failed = results.find(result => result.status === "rejected");
        if (failed) throw failed.reason;
        for (const port of ports) assert.equal(await portOpen(port), false, `Port ${port} is still listening`);
        assert.ok(ownedSessions.size === 0 || ownedProcesses.size > 1, "The Chromium process tree must be observed");
        return `sessions ${baseline.size} → ${sessions.size}; ${ownedSessions.size} owned sessions closed; ${ownedProcesses.size} tracked live PIDs → 0; 0 of ${ports.length} ports listening`;
      });
    } catch (error) {
      failure ??= error;
      console.error(error);
    } finally {
      process.removeListener("SIGINT", stop);
      process.removeListener("SIGTERM", stop);
    }
  }
  if (failure) process.exitCode = 1;
}
