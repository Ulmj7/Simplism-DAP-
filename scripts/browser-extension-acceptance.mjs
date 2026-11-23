import assert from "node:assert/strict";
import { access, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { startConsumer } from "../tests/fixtures/runtime-consumer/server.mjs";

const args = process.argv.slice(2);
const fixturesOnly = args.includes("--fixtures-only");
const bundlePath = args.find(arg => !arg.startsWith("--"));
if (args.includes("--help") || (!bundlePath && !fixturesOnly)) {
  console.log("Usage: node scripts/browser-extension-acceptance.mjs --browser-extension <unpacked bundle directory>");
  console.log("Use --fixtures-only to publish and verify the isolated fixtures without opening the extension.");
  process.exit(args.includes("--help") ? 0 : 2);
}
assert.ok(args.includes("--browser-extension") && !args.includes("--headless"), "Use the headed --browser-extension acceptance mode");
let unpacked;
if (!fixturesOnly) {
  assert.ok(process.stdin.isTTY && process.stdout.isTTY, "Run in a terminal so you can use the extension toolbar and answer its steps");
  assert.ok(process.env.DISPLAY || process.env.WAYLAND_DISPLAY, "A headed Chromium display is required");
  unpacked = resolve(bundlePath);
  const manifest = JSON.parse(await readFile(join(unpacked, "manifest.json"), "utf8"));
  assert.equal(manifest.manifest_version, 3);
  assert.ok(manifest.action?.default_popup, "The unpacked bundle must have an extension action popup");
  await access(join(unpacked, manifest.action.default_popup));
}

const { hostOrigin, launchOperator, requests, runStudioAcceptance, step, until } = await import("./studio-acceptance-support.mjs");
const { callBrowser, publishRuntimeConsumer } = await import("./runtime-consumer-support.mjs");
const runtimeReads = () => requests.filter(item => item.path.startsWith("/api/runtime/"));
const appPath = app => `/api/runtime/${encodeURIComponent(app.runtimeKey)}/guides`;
const query = app => `?applicationId=${app.id}`;
const root = "[data-simplism-runtime]";
const overlay = ".dap-guide-card, .dap-guide-ring, .dap-result";
const result = ".dap-result[open]";
const launcher = ".dap-launcher-button";
const panel = ".dap-launcher-panel";

async function operator(note) {
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  const abort = new AbortController();
  const cancel = () => abort.abort();
  prompt.once("SIGINT", cancel);
  process.once("SIGTERM", cancel);
  try {
    console.log(`\n${note}\nUse only the temporary Chromium window opened by this test.\n`);
    const answer = await prompt.question("Press Enter to verify, or type q to end the run: ", {
      signal: AbortSignal.any([abort.signal, AbortSignal.timeout(180_000)]),
    });
    assert.equal(answer.trim(), "", "Operator ended the acceptance");
  } finally {
    process.removeListener("SIGTERM", cancel);
    prompt.close();
  }
}

async function verifyFixtures(consumers, apps) {
  for (const [index, consumer] of consumers.entries()) {
    const response = await fetch(consumer.origin + "/");
    const markup = await response.text();
    assert.match(response.headers.get("content-security-policy") ?? "", /default-src 'none'; script-src 'self'; style-src 'self'/u);
    assert.doesNotMatch(markup, /src="\/boot\.js"/u);
    if (index === 0) {
      const collision = await fetch(consumer.origin + "/?sdk=1");
      assert.match(await collision.text(), /src="\/boot\.js"/u);
      assert.equal((await fetch(consumer.origin + "/sdk/index.js")).status, 200);
    }
    const app = apps[index];
    if (app) {
      const catalog = await fetch(hostOrigin + appPath(app) + query(app), { headers: { Origin: consumer.origin } });
      assert.equal(catalog.status, 200);
      assert.equal(catalog.headers.get("access-control-allow-origin"), consumer.origin);
      assert.deepEqual((await catalog.json()).guides.map(guide => guide.id), [app.guide]);
    }
  }
}

async function accept(session, hash, history, unknown, apps) {
  const ui = (...args) => callBrowser(session, ...args);
  const evaluate = async code => (await ui("eval", "-b", Buffer.from(code).toString("base64"))).result;
  const count = selector => evaluate(`document.querySelectorAll(${JSON.stringify(selector)}).length`);
  const waitVisible = selector => until(
    () => evaluate(`(document.querySelector(${JSON.stringify(selector)})?.getClientRects().length ?? 0) > 0`),
    `Missing visible ${selector}`,
  );
  // The worker inserts CSS after the SDK attaches. Wait for layout before clicking.
  const waitLauncher = () => until(
    () => evaluate(`(() => {
      const node = document.querySelector(${JSON.stringify(root)});
      return !!node && getComputedStyle(node).position === "fixed";
    })()`),
    "Simplism launcher did not become styled on the application page",
  );
  const clickButton = name => ui("find", "role", "button", "click", "--name", name, "--exact");
  const waitText = text => until(() => evaluate(`document.body.innerText.includes(${JSON.stringify(text)})`), `Missing ${text}`);
  const go = (site, path = "/") => ui("open", site.origin + path);
  const validateCsp = async () => {
    assert.deepEqual(await evaluate("window.cspViolations"), []);
    assert.equal(await count('link[href="/portal.css"]'), 1);
  };
  const noRuntime = async () => {
    assert.equal(await count(root), 0);
    assert.equal(await count(overlay), 0);
  };
  const openCatalog = async () => {
    await waitLauncher();
    if (await evaluate(`document.querySelector("${panel}").hidden`)) await ui("click", launcher);
    await waitVisible(`${panel} li button`);
  };
  const start = async () => {
    await openCatalog();
    await ui("press", "Enter");
    await waitText("Open Profile.");
    await waitVisible(".dap-guide-ring");
  };
  const enterName = async site => {
    await ui("click", `[data-ai-id="${site.prefix}.profile"]`);
    await waitText("Enter a display name.");
    await ui("click", "#label");
    await ui("press", "A");
    await waitText("Save your name.");
  };

  await step("unknown site stays inert", async () => {
    const before = runtimeReads().length;
    await go(unknown);
    await operator(`Open the Simplism toolbar popup on the unknown origin. Confirm it asks to save an application binding and disables Open Simplism. Enter Application ID 'invalid', Runtime key 'rk-invalid', and API origin ${hostOrigin}. Choose Save site and confirm that it reports invalid configuration. Close the popup.`);
    await noRuntime();
    assert.equal(runtimeReads().length, before);
    await validateCsp();
  });

  const extensionReadStart = runtimeReads().length;
  for (const [index, site] of [hash, history].entries()) {
    const app = apps[index];
    const other = apps[1 - index];
    await step(`${site.name} validates playback, catalog isolation, strict CSP and stop/restart/reload`, async () => {
      await go(site);
      await noRuntime();
      await operator(`On ${site.origin}, open the toolbar popup and enter:\nApplication ID: ${app.id}\nRuntime key: ${app.runtimeKey}\nAPI origin: ${hostOrigin}\nChoose Save site. If a setup tab opens, choose Allow site access there, approve Chrome's exact-site prompt, and wait for Simplism to return to the original tab. Reopen the toolbar popup and choose Open Simplism.`);
      await waitLauncher();
      assert.equal(await count(root), 1);
      assert.equal(await evaluate("typeof window.simplism"), "undefined", "The fixture did not bootstrap the direct SDK");
      assert.equal(await evaluate(`getComputedStyle(document.querySelector(${JSON.stringify(root)})).position`), "fixed", "Launcher CSS must apply under CSP");
      await openCatalog();
      const titles = await evaluate(`[...document.querySelectorAll("${panel} li strong")].map(item => item.textContent)`);
      assert.deepEqual(titles, [app.title]);
      assert.ok(!titles.includes(other.title));
      assert.equal(await evaluate(`document.activeElement.matches("${panel} li button")`), true);
      await ui("press", "Enter");
      await waitText("Open Profile.");
      await openCatalog();
      await clickButton("Restart guide");
      await waitText("Open Profile.");
      await openCatalog();
      await clickButton("Stop guide");
      assert.equal(await count(overlay), 0);
      await start();
      await enterName(site);
      await ui("click", "#save");
      await waitText("Your name was saved.");
      await ui("click", `${result} button`);
      await validateCsp();

      await go(site);
      await start();
      await ui("reload");
      assert.equal(await count(overlay), 0, "Reload must end the in-progress guide");
      await operator("Open the toolbar popup, confirm the saved site, choose Refresh then Open Simplism and close the popup.");
      await waitLauncher();
      assert.equal(await count(root), 1);
      await validateCsp();
    });
  }
  const extensionReads = runtimeReads().slice(extensionReadStart);
  for (const [index, site] of [hash, history].entries()) {
    const app = apps[index];
    const reads = extensionReads.filter(item => item.origin === site.origin);
    assert.ok(reads.some(item => item.path === appPath(app) + query(app)), "Site did not fetch a catalog");
    assert.ok(reads.some(item => item.path === appPath(app) + "/" + app.guide + query(app)), "Site did not fetch its published guide");
    assert.ok(reads.every(item => item.status === 200 && item.method === "GET" && !item.hasCookie && !item.hasAuthorization && item.role === undefined));
    assert.ok(reads.every(item => item.path.endsWith(query(app)) && !item.path.includes(app.draft) && !item.path.includes(apps[1 - index].guide)));
    assert.doesNotMatch(JSON.stringify(reads.map(item => item.response)), /@e\d+|draft only|privateEvidence|runtimeKey|tenantId/u);
  }
  assert.ok(extensionReads.every(item => [hash.origin, history.origin].includes(item.origin)));

  await step("a different port on the same host remains unconfigured after the two saves", async () => {
    const before = runtimeReads().length;
    await go(unknown);
    await operator("Open the toolbar popup on this different test port. Confirm it still asks to save a binding and disables Open Simplism. Close the popup.");
    await noRuntime();
    assert.equal(runtimeReads().length, before);
  });

  await step("disable removes a running launcher and persists across reload; enable restores playback", async () => {
    await go(history);
    await operator("Open Simplism from the saved History site and close the toolbar popup.");
    await start();
    await operator("With a guide running, open the toolbar popup, choose Disable on this site, and close the popup.");
    await until(async () => await count(root) === 0 && await count(overlay) === 0, "Disabled site retained runtime UI");
    assert.equal(await evaluate(`(() => {
      const probe = document.createElement("div");
      probe.className = "dap-launcher";
      document.body.append(probe);
      const position = getComputedStyle(probe).position;
      probe.remove();
      return position;
    })()`), "static", "Disable must remove the extension's injected stylesheet");
    await validateCsp();
    const disabledReads = runtimeReads().length;
    await ui("reload");
    await operator("Confirm the History site is still disabled after reload. If Open Simplism is available, try it and confirm it does not open a launcher. Close the popup.");
    await noRuntime();
    assert.equal(runtimeReads().length, disabledReads, "Disabled site must not read the Runtime API");
    await operator("Choose Enable on this site, then Open Simplism, and close the toolbar popup.");
    await start();
    await openCatalog();
    await clickButton("Stop guide");
    await validateCsp();
  });

  await step("missing control and verification failure do not advance a guide", async () => {
    await go(hash);
    await operator("Open Simplism from the saved Hash site and close the toolbar popup.");
    await evaluate(`document.querySelector('[data-ai-id="${hash.prefix}.profile"]').removeAttribute("data-ai-id")`);
    await openCatalog();
    await ui("press", "Enter");
    await waitVisible(result);
    assert.equal(await count(".dap-guide-ring"), 0);
    assert.equal(await evaluate('document.body.innerText.includes("Enter a display name.")'), false);
    await ui("click", `${result} button`);

    await go(hash);
    await operator("Open Simplism again on the restored Hash test page and close the popup.");
    await start();
    await enterName(hash);
    await evaluate('document.querySelector("#save").addEventListener("click", () => { document.querySelector("#saved").textContent = "Could not save"; }, { once: true })');
    await ui("click", "#save");
    await waitVisible(result);
    assert.equal(await evaluate('document.body.innerText.includes("Your name was saved.")'), false);
    await validateCsp();
  });

  await step("page-owned SDK excludes a second extension launcher and retains its own runtime", async () => {
    await go(hash, "/?sdk=1");
    await until(() => evaluate("window.simplismReady?.every(reply => reply.ok) === true"), "Direct SDK did not initialize");
    assert.equal(await count(root), 1);
    const before = runtimeReads().length;
    await operator("Open the toolbar popup and choose Open Simplism. Confirm the popup says this page already has a Simplism runtime. Close the popup.");
    assert.equal(await count(root), 1);
    assert.equal(await count('link[href$="/sdk/simplism.css"]'), 1);
    assert.equal(runtimeReads().length, before, "A collision must not fetch a duplicate catalog");
    await start();
    await openCatalog();
    await clickButton("Stop guide");
    await validateCsp();
  });
}

const profile = unpacked ? await mkdtemp(join(tmpdir(), "simplism-extension-chromium-")) : undefined;
try {
  await runStudioAcceptance(async () => {
    const consumers = [];
    try {
      for (const [port, routing, sdkMode] of [[5187, "hash", "opt-in"], [5188, "history", "never"], [5186, "hash", "never"]]) {
        consumers.push(await startConsumer({ port, routing, apiOrigin: hostOrigin, sdkMode }));
      }
      const apps = [];
      for (const site of consumers.slice(0, 2)) {
        await step(`publish only the reviewed guide for ${site.name}`, async () => { apps.push(await publishRuntimeConsumer(site)); });
      }
      await step("verify fixture catalogs and strict CSP without loading the extension", () => verifyFixtures(consumers, apps));
      if (!fixturesOnly) {
        const session = await launchOperator(consumers[2].origin + "/", { path: unpacked, profile });
        await accept(session, ...consumers, apps);
      }
    } finally {
      await Promise.all(consumers.map(consumer => consumer.close()));
    }
  });
} finally {
  if (profile) await rm(profile, { recursive: true, force: true });
}
