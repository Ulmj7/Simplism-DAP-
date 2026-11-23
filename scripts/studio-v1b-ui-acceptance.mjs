// Opt-in onboarding proof against a real isolated Policy Gateway, PostgreSQL, Vite and Chromium.
import assert from "node:assert/strict";
import {
  browserCommand, browserSession, elapsed, inventory, launchOperator, originA, originB, query,
  request, requests, runStudioAcceptance, trackProcesses, until,
} from "./studio-acceptance-support.mjs";

const apps = "/api/admin/applications";
const guides = "/api/admin/walkthroughs";
const studio = "/api/studio/browser";
const nameA = "Reference acceptance";
const nameB = "Orders acceptance";
const title = "Studio V1B order walkthrough";
const completion = "The orders walkthrough finished.";
const instructions = ["Open the Orders page.", "Enter an order note.", "Submit the order."];
const metrics = { connect: [], inspect: [], register: [], handshake: [], completion: [] };
const targetIds = ["nav.orders", "orders.note", "orders.submit"];
let ui, studioTab, appA, appB, publishedId, repairId, saved, ownedChrome;

async function browser(session, ...args) {
  const result = await browserCommand(session, ...args);
  assert.equal(result.success, true, `Chromium ${args[0]}: ${result.error ?? "command failed"}`);
  return result.data;
}
const uiCmd = (...args) => browser(ui, ...args);
const browse = (...args) => browser(browserSession(), ...args);
const evaluate = (driver, expression) => driver("eval", "-b", Buffer.from(expression).toString("base64")).then(data => data.result);
const read = code => evaluate(uiCmd, code);
const click = async name => {
  await until(() => read(`[...document.querySelectorAll("button")].some(button =>
    (button.getAttribute("aria-label") || button.textContent) === ${JSON.stringify(name)} && !button.disabled && button.getClientRects().length > 0)`), `Expected enabled button: ${name}`);
  return uiCmd("find", "role", "button", "click", "--name", name, "--exact");
};
const waitText = text => uiCmd("wait", "--text", text);
const wait = selector => uiCmd("wait", selector);
const page = route => uiCmd("open", originA + "/#/" + route);
const marker = id => `[data-ai-id="${id}"]`;
const control = async label => {
  const id = await read(`[...document.querySelectorAll("label")].find(label => label.textContent.trim() === ${JSON.stringify(label)})?.control?.id ?? null`);
  assert.ok(id, `Expected labelled field ${label}`);
  return `#${id}`;
};
const fill = async (label, value) => uiCmd("fill", await control(label), value);
const select = async (label, value) => uiCmd("select", await control(label), value);
const options = id => read(`[...document.querySelector("#${id}")?.options ?? []].map(option => option.value)`);
const waitOption = (id, value) => until(async () => (await options(id)).includes(value), `Expected ${value} in ${id}`);
const role = async value => {
  await wait("#demo-role");
  await uiCmd("select", "#demo-role", value);
  await until(() => read(`document.querySelector("#demo-role")?.value === ${JSON.stringify(value)}`), "Demo role did not change");
};
const listTargets = () => request("GET", `${apps}/${appB}/targets`, 200);
const guide = id => request("GET", `${guides}/${id}`, 200);
const last = action => requests.findLast(item => item.path === studio && item.body?.action === action);
const state = value => wait(`.studio-workspace[data-state="${value}"]`);
const alert = text => until(() => read(`document.querySelector(".studio-alert")?.textContent.includes(${JSON.stringify(text)}) === true`), `Expected announced error: ${text}`);
const candidates = () => read(`[...document.querySelectorAll(".studio-candidate")].filter(row => row.closest(".studio-workspace")).map(row => ({
  name: row.querySelector("strong").textContent, status: row.dataset.status, text: row.textContent,
  buttons: [...row.querySelectorAll("button")].map(button => button.getAttribute("aria-label"))
}))`);
const ownedClosed = session => until(async () => !(await inventory()).has(session), "Studio-owned Chrome did not close");

async function step(number, title, run) {
  const start = performance.now();
  try { await run(); console.log(`STEP ${number} PASS ${elapsed(start)} ms | ${title}`); }
  catch (error) { console.log(`STEP ${number} FAIL ${elapsed(start)} ms | ${title}`); throw error; }
}

async function enroll(name, origin, registryId, source) {
  await wait("#application-name");
  await fill("Name", name); await fill("Origin", origin); await fill("Allowed origins", origin);
  await select("Environment", "test"); await select("Registry", registryId);
  await click("Enroll application"); await waitText("Application saved.");
  const item = (await request("GET", apps, 200)).applications.find(item => item.name === name);
  assert.ok(item);
  assert.equal(item.enabled, true);
  assert.equal(item.origin, origin);
  assert.equal(item.source, source);
  const row = await read(`[...document.querySelectorAll("tbody tr")].find(row => row.cells[0].textContent === ${JSON.stringify(name)})?.textContent`);
  assert.match(row, /Enabled/u);
  if (source === "studio-managed") assert.match(row, /Studio-managed/u);
  return item.id;
}
async function connect() {
  const start = performance.now();
  await click("Connect Chrome"); await state("CONNECTED");
  metrics.connect.push(elapsed(start));
  assert.equal(last("connect").status, 200);
  ownedChrome = browserSession();
  assert.ok(ownedChrome && ownedChrome !== ui);
  await trackProcesses();
  assert.equal((await browse("get", "url")).url, originB + "/");
}
async function inspect(url) {
  const offset = requests.length;
  const start = performance.now();
  await click("Inspect current page"); await state("CONNECTED");
  const observed = requests.slice(offset).find(item => item.body?.action === "refresh");
  assert.equal(observed?.status, 200);
  assert.equal(observed.response.url, url);
  assert.equal(await read('document.querySelector(".studio-status").textContent.includes(' + JSON.stringify(url) + ')'), true);
  metrics.inspect.push(elapsed(start));
  return observed.response;
}
async function openRegistration(name, id) {
  await click(`Register target: ${name}`); await wait("form.studio-register");
  const fields = await read(`(() => { const f = document.querySelector("form.studio-register"), id = f.querySelector('[id$="-register-id"]');
    return { text: f.textContent, id: id.value, readOnly: id.readOnly, route: f.querySelector('[id$="-register-route"]')?.value ?? null,
      operations: [...f.querySelectorAll('input[type="checkbox"]:checked')].map(box => box.value) }; })()`);
  assert.equal(fields.id, id); assert.equal(fields.readOnly, true);
  assert.match(fields.text, /Live evidence[\s\S]*What will be saved[\s\S]*Read from the page[\s\S]*Public/u);
  return fields;
}
async function register(name, id) {
  await openRegistration(name, id);
  await fill("Description", `Use the ${name} control.`);
  const start = performance.now();
  await click("Register target"); await waitText("It is now a trusted target on this page.");
  assert.equal(last("register").status, 200);
  await waitOption("editor-target", id);
  metrics.register.push(elapsed(start));
}
async function showApplications() { await page("applications"); await wait("#application-name"); }
async function edit(title) { await page("walkthroughs"); await click(`Edit: ${title}`); }
async function showManagedEditor() {
  await showApplications();
  await click(`Use for authoring: ${nameB}`); await wait("#editor-target");
}
async function gotoOrders() {
  await browse("open", originB + "/#/orders");
  await until(async () => (await evaluate(browse, '!document.querySelector(\'[data-route="orders"]\').hidden')) === true, "Fixture did not render Orders");
}
async function authorFields() {
  await fill("Title", title); await fill("Description", "Go to Orders and submit a note."); await fill("Completion message", completion);
  for (const [index, id] of targetIds.entries()) {
    if (index !== 0) await click("Add step");
    await select("Semantic target", id);
    await fill("Instruction", instructions[index]);
    await select("Interaction", index === 1 ? "input" : "click");
    if (index === 2) await select("Check after this step", "route.orders");
  }
}
async function runGuide(buttonName) {
  const prior = new Set((await uiCmd("tab")).tabs.map(tab => tab.tabId));
  const start = performance.now();
  await click(buttonName);
  let popup;
  await until(async () => {
    popup = (await uiCmd("tab")).tabs.find(tab => !prior.has(tab.tabId) && tab.url.startsWith(originB));
    return Boolean(popup);
  }, "The application window did not open");
  await uiCmd("tab", studioTab); await waitText("Walkthrough running in the application window.");
  metrics.handshake.push(elapsed(start));
  await uiCmd("tab", popup.tabId);
  await waitText(instructions[0]);
  assert.equal(await read("Boolean(window.opener)"), true);
  const runStarted = performance.now();
  await uiCmd("click", marker("nav.orders")); await waitText(instructions[1]);
  await uiCmd("click", "#order-note"); await uiCmd("press", "A"); await waitText(instructions[2]);
  await uiCmd("click", marker("orders.submit")); await waitText(completion);
  assert.equal((await uiCmd("get", "text", "#order-status")).text, "Order submitted.");
  metrics.completion.push(elapsed(runStarted));
  await trackProcesses();
  await uiCmd("tab", studioTab); await waitText("Walkthrough finished.");
  await uiCmd("tab", "close", popup.tabId);
}

await runStudioAcceptance(async () => {
  ui = await launchOperator();
  studioTab = (await uiCmd("tab")).tabs.find(tab => tab.url.startsWith(originA)).tabId;
  await role("maintainer");
  await step(1, "enroll managed B and built-in reference A", async () => {
    await showApplications();
    appB = await enroll(nameB, originB, "studio-managed", "studio-managed");
    appA = await enroll(nameA, originA, "reference", "built-in");
    assert.notEqual(appA, appB);
  });
  await step(2, "new managed draft has no targets and Preview is disabled", async () => {
    await showManagedEditor();
    assert.deepEqual(await options("editor-target"), [""]);
    assert.equal(await read('document.querySelector(".admin-toolbar button:nth-child(2)").disabled'), true);
    await waitText("Add a route and select an enabled application to preview in its window.");
  });
  await step(3, "inspect Home, verify limited disclosure and highlight without writing", async () => {
    await connect();
    const refreshed = await inspect(originB + "/");
    assert.ok(refreshed.hidden >= 1);
    assert.deepEqual((await candidates()).map(row => [row.name, row.status, row.buttons]), [["Orders", "registrable", ["Highlight: Orders", "Register target: Orders"]]]);
    await waitText("no DAP marker or not eligible");
    await click("Highlight: Orders"); await waitText("Highlighted in Chrome — nothing was saved");
    assert.equal(await evaluate(browse, 'document.querySelector(\'[data-ai-id="nav.orders"]\').style.outline'), "red solid 2px");
    assert.deepEqual((await listTargets()).targets, []);
  });
  await step(4, "confirm Home registration, refuse an invalid route, then trust the target", async () => {
    const fields = await openRegistration("Orders", "nav.orders");
    assert.equal(fields.route, "home"); assert.deepEqual(fields.operations, ["highlight", "click"]);
    await fill("Description", "Open the Orders page.");
    await fill("Route name", "order-list"); await click("Register target"); await alert("Check the highlighted fields");
    assert.deepEqual((await listTargets()).targets, []);
    await fill("Route name", "home"); const start = performance.now();
    await click("Register target"); await waitText("It is now a trusted target on this page.");
    metrics.register.push(elapsed(start));
    await waitOption("editor-target", "nav.orders");
    assert.deepEqual((await candidates()).map(row => row.status), ["trusted"]);
  });
  await step(5, "register order controls and refuse stale and duplicate registration", async () => {
    await gotoOrders();
    const refreshed = await inspect(originB + "/#/orders");
    assert.ok(refreshed.hidden >= 3);
    assert.deepEqual((await candidates()).map(row => row.name).sort(), ["Order note", "Submit order"]);
    const visible = await read('document.querySelector(".studio-workspace").textContent');
    assert.doesNotMatch(visible, /orders\.secret|orders\.private|admin\.reset|Private action|Password|Reset|Cancel/u);
    const fields = await openRegistration("Order note", "orders.note");
    assert.deepEqual(fields.operations, ["highlight", "input", "focus"]);
    await fill("Description", "Enter the order note.");
    await browse("open", originB + "/");
    await click("Register target"); await alert("The element changed. Inspect the current page again.");
    assert.deepEqual((await listTargets()).targets.map(target => target.id), ["nav.orders"]);
    await gotoOrders(); await inspect(originB + "/#/orders");
    await register("Order note", "orders.note");

    // Deliberately create two live refs for one durable ID to exercise the duplicate race while the second confirmation remains open.
    await evaluate(browse, `(() => { const original = document.querySelector('${marker("orders.submit")}'); const copy = original.cloneNode(true);
      copy.id = "duplicate-submit"; copy.textContent = "Second submit control"; original.after(copy); return true; })()`);
    const duplicate = await inspect(originB + "/#/orders");
    await openRegistration("Second submit control", "orders.submit");
    await fill("Description", "Submit the current order.");
    const original = duplicate.elements.find(item => item.name === "Submit order");
    assert.equal(original.status, "registrable");
    const start = performance.now();
    await request("POST", studio, 200, { action: "register", applicationId: appB, sessionId: last("connect").response.sessionId, ref: original.ref,
      targetId: "orders.submit", route: "orders", label: "Submit order", description: "Submit the current order.", operations: ["highlight", "click"], privacy: "public" });
    metrics.register.push(elapsed(start));
    await click("Register target"); await alert("A target with this ID is already registered");
    assert.equal(last("register").response.error, "TARGET_EXISTS");
    await evaluate(browse, 'document.querySelector("#duplicate-submit").remove()');
    await inspect(originB + "/#/orders");
  });
  await step(6, "registry presents the three durable targets and two routes, without live refs", async () => {
    await showApplications();
    await ownedClosed(ownedChrome);
    await click(`View registry: ${nameB}`);
    await waitText("Targets (3/200)"); await waitText("Routes (2/20)");
    const listing = await listTargets();
    assert.deepEqual(listing.targets.map(target => target.id).sort(), [...targetIds].sort());
    assert.deepEqual(listing.routes.map(route => route.route).sort(), ["home", "orders"]);
    for (const target of listing.targets) {
      assert.deepEqual(target.references, { drafts: 0, published: 0 });
      assert.equal(target.status, "active");
      const row = await read(`[...document.querySelectorAll("li.studio-candidate")].find(row => row.textContent.includes(${JSON.stringify(target.id)}))?.textContent`);
      for (const field of [target.label, target.role, target.route, ...target.operations, "Active", "0 drafts, 0 published"]) assert.ok(row.includes(field));
    }
    assert.doesNotMatch(JSON.stringify(listing), /@e\d+/u);
    const raw = await query(async client => (await client.query("SELECT to_jsonb(t) AS target FROM public.studio_registry_targets t WHERE application_id = $1", [appB])).rows);
    assert.equal(raw.length, 3); assert.doesNotMatch(JSON.stringify(raw), /@e\d+/u);
  });
  await step(7, "save and reopen the managed workflow, and close capture Chrome on editor exit", async () => {
    await showManagedEditor(); await connect(); await authorFields();
    await click("Save draft"); await waitText("Saved");
    const entry = (await request("GET", guides, 200)).authored.find(item => item.title === title);
    assert.equal(entry.applicationId, appB); publishedId = entry.id;
    saved = await guide(publishedId);
    assert.deepEqual(saved.definition.steps.filter(step => step.kind === "guide").map(step => step.target), targetIds);
    assert.equal(saved.definition.steps.find(step => step.target === "orders.submit").verify, "route.orders");
    assert.doesNotMatch(JSON.stringify(saved), /@e\d+/u);
    await uiCmd("click", 'a[href="#/walkthroughs"]'); await ownedClosed(ownedChrome);
    await click(`Edit: ${title}`); await wait("#editor-application-fixed"); await waitText(nameB);
    await click("Step 3"); assert.equal((await uiCmd("get", "value", "#editor-target")).value, "orders.submit");
    assert.equal(await read('document.querySelector("#editor-application")'), null);
  });
  await step(8, "preview in B, complete real interactions, and keep the stored draft unchanged", async () => {
    await runGuide("Preview");
    assert.deepEqual(await guide(publishedId), saved);
  });
  await step(9, "publish and complete the guide as an ordinary user without changing built-ins", async () => {
    await click("Publish"); await waitText("Publish this walkthrough?");
    await uiCmd("click", "dialog[open] button.primary");
    await waitText("Published");
    await role("user"); await page("dashboard"); await waitText("Guides in other applications");
    assert.equal(await read('document.querySelector("#guides .guide-list").children.length'), 3);
    await runGuide(`Start in ${nameB}: ${title}`);
  });
  await step(10, "disable a referenced target, verify publication/draft effects, and re-enable", async () => {
    await role("maintainer");
    const { title: originalTitle, description, start, steps } = saved.definition;
    assert.equal(originalTitle, title);
    const repair = await request("POST", guides, 201, { applicationId: appB, definition: { title: "Repairable order draft", description, start, steps } });
    repairId = repair.id;
    await showApplications();
    await click(`View registry: ${nameB}`); await waitText("1 drafts, 1 published");
    assert.equal(await read('[...document.querySelectorAll("li.studio-candidate button")].every(b => /^(Enable|Disable) /.test(b.getAttribute("aria-label")))'), true);
    await click("Disable orders.submit"); await waitText("1 drafts and 1 published walkthroughs");
    await click("Disable target"); await waitText("Disabled · References: 1 drafts, 1 published");
    await role("user"); await page("dashboard"); await wait("#guides");
    assert.equal(await read('document.querySelector(".external-guides") === null'), true);
    await role("maintainer"); await edit("Repairable order draft"); await waitText("Select an available target.");
    assert.equal(await read('document.querySelector("#editor-problems").hidden'), false);
    assert.equal(await read('document.querySelector("#editor-problems").parentElement.getAttribute("aria-live")'), "polite");
    await showApplications(); await click(`View registry: ${nameB}`); await click("Enable orders.submit"); await waitText("Active · References: 1 drafts, 1 published");
    await edit("Repairable order draft"); await waitOption("editor-target", "orders.submit");
    assert.equal(await read('document.querySelector("#editor-problems").hidden'), true);
    await role("user"); await page("dashboard"); await waitText("Guides in other applications");
    assert.equal(await read('document.querySelector(".external-guides").textContent.includes(' + JSON.stringify(title) + ')'), true);
    assert.equal((await guide(repairId)).status, "draft");
  });
  await step(11, "reference targets remain separate and saved ownership is fixed", async () => {
    await role("maintainer"); await showApplications(); await click(`Use for authoring: ${nameA}`); await wait("#editor-target");
    const refIds = await options("editor-target");
    assert.ok(refIds.includes("profile.nameInput")); assert.ok(targetIds.every(id => !refIds.includes(id)));
    await fill("Title", "Reference isolation"); await fill("Description", "Open the profile."); await fill("Completion message", "Done.");
    await select("Semantic target", "nav.profile"); await fill("Instruction", "Open the profile."); await select("Interaction", "click");
    await select("Application", appB); await waitOption("editor-target", "orders.submit"); await waitText("Select an available target.");
    const bIds = await options("editor-target"); assert.ok(targetIds.every(id => bIds.includes(id))); assert.ok(!bIds.includes("nav.profile"));
    await select("Application", appA); await waitOption("editor-target", "nav.profile");
    await click("Save draft"); await wait("#editor-application-fixed");
    const entry = (await request("GET", guides, 200)).authored.find(item => item.title === "Reference isolation");
    const record = await guide(entry.id);
    const mismatch = await request("PUT", `${guides}/${entry.id}`, 409, { applicationId: appB, definition: record.definition });
    assert.equal(mismatch.code, "APPLICATION_MISMATCH");
    assert.equal(await read('document.querySelector("#editor-application") === null'), true);
  });
  await step(12, "reconnect after reload and refuse a different maintainer", async () => {
    await showManagedEditor(); await connect();
    const initial = last("connect").response.sessionId;
    assert.equal((await request("POST", studio, 409, { action: "resume", applicationId: appB }, "peer")).error, "BROWSER_BUSY");
    await uiCmd("reload"); await wait("#editor-application"); await select("Application", appB); await waitOption("editor-target", "nav.orders");
    await click("Connect Chrome"); await alert("A browser workspace is already active.");
    await click("Reconnect"); await state("CONNECTED");
    const adopted = last("resume").response;
    assert.equal(adopted.resumed, true); assert.notEqual(adopted.sessionId, initial);
    assert.equal((await request("POST", studio, 404, { action: "refresh", applicationId: appB, sessionId: initial })).error, "SESSION_CLOSED");
    await inspect(originB + "/");
  });
  await step(13, "verify registration and registry manager layout plus keyboard focus", async () => {
    const longId = "orders." + "a".repeat(72);
    await evaluate(browse, `(() => { const node = document.createElement("button"); node.textContent = "Long target"; node.dataset.aiId = ${JSON.stringify(longId)};
      document.querySelector('[data-route="home"]').append(node); return true; })()`);
    await inspect(originB + "/");
    await read('document.querySelector(\'button[aria-label="Highlight: Long target"]\').focus()');
    await uiCmd("press", "Tab");
    assert.equal(await read('document.activeElement.getAttribute("aria-label")'), "Register target: Long target");
    assert.ok(await read('document.activeElement.matches(":focus-visible") && getComputedStyle(document.activeElement).outlineStyle !== "none"'));
    await uiCmd("press", "Enter"); await wait("form.studio-register");
    const widths = [320, 375, 768, 1024, 1280];
    async function widthProof(kind, selector) {
      for (const width of widths) {
        await uiCmd("set", "viewport", String(width), "900");
        const result = await read(`(() => { const node = document.querySelector(${JSON.stringify(selector)}); return { viewport: window.innerWidth, client: document.documentElement.clientWidth,
          scroll: document.documentElement.scrollWidth, box: node.clientWidth, content: node.scrollWidth }; })()`);
        assert.equal(result.viewport, width);
        assert.ok(result.scroll <= result.client && result.content <= result.box, JSON.stringify(result));
        if (kind === "registration" && width <= 375) {
          assert.ok(await read(`(() => { const row = document.querySelector(${JSON.stringify(selector)}); const marker = [...row.querySelectorAll("p")].find(p => p.textContent.includes(${JSON.stringify(longId)}));
            const range = document.createRange(); range.selectNodeContents(marker); return range.getClientRects().length > 1; })()`), "Long marker must wrap at narrow widths");
        }
        console.log(`WIDTH ${width} ${kind} PASS viewport=${result.viewport} client=${result.client} scroll=${result.scroll}`);
      }
    }
    await widthProof("registration", 'li[data-status="registrable"]');
    await uiCmd("press", "Escape");
    assert.equal(await read('document.activeElement.getAttribute("aria-label")'), "Register target: Long target");
    await click("Disconnect"); await state("DISCONNECTED"); await ownedClosed(ownedChrome);
    const sessionId = last("disconnect").body.sessionId;
    assert.equal((await request("POST", studio, 404, { action: "refresh", applicationId: appB, sessionId })).error, "SESSION_CLOSED");
    await showApplications(); await click(`View registry: ${nameB}`); await waitText("Targets (3/200)");
    await widthProof("manager", "li.studio-candidate");
  });
  console.log(`OBSERVED_MS ${JSON.stringify(metrics)}`);
});
