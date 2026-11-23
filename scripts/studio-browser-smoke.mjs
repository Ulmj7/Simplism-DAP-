// Opt-in Linux Studio UI acceptance. With the native browser built and the isolated dapstudiov1
// database migrated on 54359, run npm run acceptance:studio-v1-ui. The harness starts host 8794,
// Vite 5184 and fixture 5185. The operator and Studio have separate owned Chrome sessions.
import assert from "node:assert/strict";
import {
  browserCommand, browserSession, elapsed, inventory, launchOperator, originA, originB, query,
  request, requests, runStudioAcceptance, step, trackProcesses, until,
} from "./studio-acceptance-support.mjs";

const reference = "Reference application";
const second = "Second application";
const title = "Studio acceptance display-name";
const completion = "Studio verified the display-name update.";
const instructions = ["Open the Profile page.", "Enter a display name.", "Save the display name."];
const previewLimit = "Preview is available for the reference application in this release.";
const studioPath = "/api/studio/browser";
const admin = "/api/admin/walkthroughs";
const apps = "/api/admin/applications";
const uiTimes = { connect: [], refresh: [], highlight: [], capture: [] };
let ui;

async function browser(session, ...args) {
  const reply = await browserCommand(session, ...args);
  assert.equal(reply.success, true, `Chrome ${args[0]}: ${reply.error ?? "unexpected result"}`);
  return reply.data;
}
const uiCommand = (...args) => browser(ui, ...args);
const browse = (...args) => browser(browserSession(), ...args);
const click = name => uiCommand("find", "role", "button", "click", "--name", name, "--exact");
const waitText = text => uiCommand("wait", "--text", text);
const read = async expression => (await uiCommand("eval", expression)).result;
const byLabel = label => `[...document.querySelectorAll("label")].find(label => label.textContent.trim() === ${JSON.stringify(label)})?.control`;
const control = async label => {
  const id = await read(`(${byLabel(label)})?.id ?? null`);
  assert.ok(id, `Field is present for label "${label}"`);
  return `#${id}`;
};
const fill = async (label, text) => uiCommand("fill", await control(label), text);
const select = async (label, value) => uiCommand("select", await control(label), value);
const selected = async label => (await uiCommand("get", "value", await control(label))).value;
const page = route => uiCommand("open", `${originA}/#/${route}`);
const marker = targetId => `[data-ai-id="${targetId}"]`;
const workspace = () => read(`Object.fromEntries([...document.querySelectorAll(".studio-status dt")].map(term => [term.textContent, term.nextElementSibling.textContent]))`);
const state = expected => uiCommand("wait", `.studio-workspace[data-state="${expected}"]`);
const rowCount = () => query(async client => (await client.query("SELECT count(*)::int AS count FROM public.walkthrough_definitions")).rows[0].count);
const isEnabled = name => read(`[...document.querySelectorAll("button")].some(button => (button.getAttribute("aria-label") || button.textContent) === ${JSON.stringify(name)} && !button.disabled)`);
const ready = name => until(() => isEnabled(name), `Expected enabled button: ${name}`);
const ownedClosed = session => until(async () => !(await inventory()).has(session), "The Studio-owned Chrome session did not close");

async function timed(action, operation) {
  const start = performance.now();
  const offset = requests.length;
  await operation();
  const ms = elapsed(start);
  assert.ok(ms < 30_000, `${action} exceeded browser command budget`);
  const matching = requests.slice(offset).filter(entry => entry.path === studioPath && entry.body?.action === action);
  assert.equal(matching.length, 1);
  const { status, ms: hostMs } = matching[0];
  assert.equal(status, 200);
  uiTimes[action].push(action === "refresh" ? { ms, hostMs, candidates: Number((await workspace()).Candidates) } : { ms, hostMs });
}

async function enroll(name, origin, environment, registryId) {
  const listed = await request("GET", apps, 200);
  const existing = listed.applications.find(entry => entry.name === name);
  if (!existing) {
    await fill("Name", name);
    await fill("Origin", origin);
    await fill("Allowed origins", origin);
    await select("Environment", environment);
    await select("Registry", registryId);
    await click("Enroll application");
    await waitText("Application saved.");
    await ready(`Use for authoring: ${name}`);
  }
  const record = (await request("GET", apps, 200)).applications.find(entry => entry.name === name);
  assert.ok(record?.enabled);
  assert.deepEqual([record.origin, record.allowedOrigins, record.environment, record.registryId], [origin, [origin], environment, registryId]);
  assert.equal(await read(`document.querySelector('[aria-label="Use for authoring: ${name}"]').closest("tr").cells[5].textContent`), "Enabled");
  return record.id;
}
async function connectChrome(name, origin, markerId) {
  await timed("connect", async () => {
    await click("Connect Chrome");
    await waitText("Chrome connected. Browse to a page, then inspect it.");
    await state("CONNECTED");
  });
  assert.deepEqual(await workspace(), { Application: name, Status: "Connected", "Current URL": "—", Route: "—", Candidates: "0" });
  const chrome = browserSession();
  assert.ok(chrome && chrome !== ui);
  await trackProcesses();
  assert.equal((await browse("get", "url")).url, origin + "/");
  await browse("wait", marker(markerId));
  return chrome;
}

async function inspect(route, url) {
  await timed("refresh", async () => {
    await click("Inspect current page");
    await waitText("Highlight a trusted target to find it in Chrome, or use it for the selected step.");
    await state("CONNECTED");
    await until(async () => {
      const data = await workspace();
      return data?.Route === route && data["Current URL"] === url;
    }, `Expected workspace to inspect ${url}`);
  });
}
async function rows() {
  return read(`[...document.querySelectorAll('[aria-label="Page candidates"] li')].map(row => ({
    name: row.querySelector("strong").textContent, text: row.textContent, status: row.dataset.status,
    actions: [...row.querySelectorAll("button")].map(button => button.getAttribute("aria-label"))
  }))`);
}
async function trusted(name, id, role, route, operations) {
  const candidates = await rows();
  const target = candidates.find(row => row.name === name && row.status === "trusted");
  assert.ok(target, `Missing trusted ${name}`);
  assert.ok(target.text.includes(`${role} · ${route}`));
  assert.ok(target.text.includes("Trusted target ✓"));
  assert.ok(target.text.includes(id));
  for (const operation of operations) assert.ok(target.text.includes(operation));
  assert.ok(target.text.includes("Public"));
  assert.match(target.text, /Live ref: @e[1-9]\d* Session only/u);
  assert.deepEqual(target.actions, [`Highlight: ${name}`, `Use: ${name}`]);
  for (const row of candidates.filter(candidate => candidate.status === "unregistered")) {
    assert.ok(row.text.includes("Not registered for walkthrough use"));
    assert.deepEqual(row.actions, []);
  }
}
async function highlight(name, id) {
  await timed("highlight", async () => {
    await click(`Highlight: ${name}`);
    await waitText("Highlighted in Chrome — nothing was saved");
  });
  assert.equal((await browse("eval", `document.querySelector(${JSON.stringify(marker(id))}).style.outline`)).result, "red solid 2px");
}
async function use(name, id, role, route) {
  await timed("capture", async () => {
    await click(`Use: ${name}`);
    await waitText(`Captured target — ${name} · ${role} · ${route} · DAP target ${id}`);
  });
  assert.equal(await selected("Semantic target"), id);
}
async function authorStep(index, interaction, check) {
  await fill("Instruction", instructions[index]);
  await select("Interaction", interaction);
  if (check) await select("Check after this step", check);
}
async function completeGuide() {
  await waitText(instructions[0]);
  await uiCommand("find", "role", "link", "click", "--name", "Profile", "--exact");
  await waitText(instructions[1]);
  await fill("Display name", "Studio Example");
  await waitText(instructions[2]);
  await uiCommand("click", marker("profile.saveButton"));
  await waitText(completion);
}

async function acceptance() {
  let a;
  let b;
  let nativeA;
  let id;

  await step("1 enroll both applications and open a reference draft", async () => {
    ui = await launchOperator();
    await uiCommand("wait", "#demo-role");
    await select("Demo role (development only)", "maintainer");
    await page("applications");
    await waitText("Enroll an application");
    a = await enroll(reference, originA, "development", "reference");
    b = await enroll(second, originB, "test", "fixture-b");
    await click(`Use for authoring: ${reference}`);
    await uiCommand("wait", "#editor-application");
    assert.equal(await selected("Application"), a);
  });

  await step("2 connect Chrome and inspect trusted dashboard links", async () => {
    await fill("Title", title);
    await fill("Description", "Update the public name in the reference application.");
    await fill("Completion message", completion);
    await fill("Instruction", instructions[0]);
    nativeA = await connectChrome(reference, originA, "nav.profile");
    await inspect("dashboard", originA + "/");
    assert.equal((await workspace()).Candidates, "2");
    await trusted("Profile", "nav.profile", "link", "dashboard", ["highlight", "click"]);
    await trusted("Settings", "nav.settings", "link", "dashboard", ["highlight", "click"]);
  });

  await step("3 highlight without writing, then use Profile", async () => {
    const before = await rowCount();
    const target = await selected("Semantic target");
    const offset = requests.length;
    await highlight("Profile", "nav.profile");
    assert.equal(await selected("Semantic target"), target);
    assert.equal(await rowCount(), before);
    assert.deepEqual(requests.slice(offset).filter(entry => entry.method !== "GET").map(entry => [entry.path, entry.body?.action]), [[studioPath, "highlight"]]);
    await use("Profile", "nav.profile", "link", "dashboard");
    assert.equal(await rowCount(), before);
    await authorStep(0, "click", "route.profile");
  });

  await step("4 browse Profile and capture Display name and Save", async () => {
    await browse("click", marker("nav.profile"));
    await browse("wait", marker("profile.nameInput"));
    await inspect("profile", originA + "/#/profile");
    await trusted("Display name", "profile.nameInput", "textbox", "profile", ["highlight", "input", "focus"]);
    await trusted("Save", "profile.saveButton", "button", "profile", ["highlight", "click"]);
    assert.ok((await rows()).some(row => row.status === "unregistered"), "Out-of-route links exercise the unregistered row");
    await click("Add step");
    await highlight("Display name", "profile.nameInput");
    await use("Display name", "profile.nameInput", "textbox", "profile");
    await authorStep(1, "input");
    await click("Add step");
    await use("Save", "profile.saveButton", "button", "profile");
    await authorStep(2, "click", "profile.saved");
  });

  await step("5 save, leave and reopen with fixed application and registry IDs", async () => {
    await click("Save draft");
    await waitText("Saved");
    const stored = (await query(async client => (await client.query(
      "SELECT walkthrough_id, application_id, definition FROM public.walkthrough_definitions")).rows))[0];
    id = stored.walkthrough_id;
    assert.equal(stored.application_id, a);
    assert.deepEqual(stored.definition.steps.filter(item => item.kind === "guide").map(item => item.target), [
      "nav.profile", "profile.nameInput", "profile.saveButton",
    ]);
    assert.doesNotMatch(JSON.stringify(stored.definition), /@e\d/u);
    const created = requests.find(entry => entry.path === admin && entry.method === "POST" && entry.status === 201);
    const { id: generatedId, ...definition } = stored.definition;
    assert.equal(generatedId, id);
    assert.deepEqual(created?.body, { applicationId: a, definition });
    await page("walkthroughs");
    await ready(`Edit: ${title}`);
    await ownedClosed(nativeA);
    await click(`Edit: ${title}`);
    await waitText("This walkthrough belongs to this application. It cannot be moved.");
    assert.equal(await read('document.querySelector("#editor-application-fixed").textContent'), reference);
    assert.equal(await read(`Boolean(${byLabel("Application")})`), false);
    assert.equal(await selected("Semantic target"), "nav.profile");
  });

  await step("6 complete Preview, publish, then complete from the ordinary user launcher", async () => {
    await click("Preview");
    await completeGuide();
    assert.equal((await request("GET", `${admin}/${id}`, 200)).status, "draft");
    await click("Done");
    await ready("Publish");
    await click("Publish");
    await waitText("Publish this walkthrough?");
    await uiCommand("click", 'dialog[open] button.primary');
    await ready(`Unpublish: ${title}`);
    await select("Demo role (development only)", "user");
    await page("dashboard");
    await ready(`Start guide: ${title}`);
    await click(`Start guide: ${title}`);
    await completeGuide();
    await click("Done");
    assert.ok(!(await inventory()).has(nativeA));
    await until(() => requests.some(entry => entry.path === "/api/walkthrough-events" && entry.role === undefined
      && entry.body?.walkthroughId === id && entry.body.event === "completed" && entry.status === 204), "Ordinary user completion was not accepted");
  });

  await step("7 switch applications, use fixture registry, and disable/re-enable the reference app", async () => {
    await select("Demo role (development only)", "maintainer");
    await page("applications");
    await ready(`Use for authoring: ${second}`);
    await click(`Use for authoring: ${second}`);
    await uiCommand("wait", "#editor-application");
    assert.equal(await selected("Application"), b);
    const picker = await read(`[...(${byLabel("Semantic target")}).options].filter(option => option.value).map(option => [option.textContent, option.value])`);
    assert.deepEqual(new Map(picker), new Map([
      ["Orders link", "nav.orders"], ["Submit order", "orders.submit"], ["Order note", "orders.note"],
    ]));
    await fill("Title", "Fixture draft");
    await fill("Description", "Open the fixture orders page.");
    await fill("Completion message", "Fixture done.");
    await select("Semantic target", "nav.orders");
    await fill("Instruction", "Find the Orders link.");
    await ready("Save draft");
    await waitText(previewLimit);
    assert.equal(await isEnabled("Preview"), false);
    const chromeB = await connectChrome(second, originB, "nav.orders");
    await inspect("home", originB + "/");
    await trusted("Orders", "nav.orders", "link", "home", ["highlight", "click"]);
    await browse("click", marker("nav.orders"));
    await browse("wait", marker("orders.submit"));
    await inspect("orders", originB + "/#/orders");
    await trusted("Submit order", "orders.submit", "button", "orders", ["highlight", "click"]);
    await trusted("Order note", "orders.note", "textbox", "orders", ["highlight", "input"]);
    let cap;
    if (process.argv.includes("--measure-cap")) {
      await browse("open", originB + "/#/dense");
      await browse("wait", '[data-route="dense"]:not([hidden]) a');
      await inspect("home", originB + "/#/dense");
      cap = uiTimes.refresh.at(-1);
      assert.equal(cap.candidates, 64);
      assert.equal((await rows()).filter(row => row.status === "trusted").length, 64);
    }
    await select("Application", a);
    await state("DISCONNECTED");
    assert.deepEqual(await rows(), []);
    assert.equal(await isEnabled("Inspect current page"), false);
    await ownedClosed(chromeB);
    await ready("Connect Chrome");

    await page("applications");
    await ready(`Disable: ${reference}`);
    await click(`Disable: ${reference}`);
    await ready(`Enable: ${reference}`);
    assert.equal(await isEnabled(`Use for authoring: ${reference}`), false);
    assert.deepEqual(await request("POST", studioPath, 409, { action: "connect", applicationId: a }), { error: "APPLICATION_DISABLED" });
    await page("walkthroughs");
    await ready("New walkthrough");
    await click("New walkthrough");
    await uiCommand("wait", "#editor-application");
    assert.equal(await read(`[...(${byLabel("Application")}).options].find(option => option.value === ${JSON.stringify(a)}).disabled`), true);
    await select("Demo role (development only)", "user");
    await page("dashboard");
    await ready(`Start guide: ${title}`);
    await click(`Start guide: ${title}`);
    await completeGuide();
    await click("Done");
    await select("Demo role (development only)", "maintainer");
    await page("applications");
    await ready(`Enable: ${reference}`);
    await click(`Enable: ${reference}`);
    await ready(`Use for authoring: ${reference}`);
    return cap === undefined ? undefined : `64-candidate refresh: ${cap.hostMs} ms host, ${cap.ms} ms UI, already connected`;
  });

  await step("8 block other port and localhost in the UI, then inspect the recovered session", async () => {
    await click(`Use for authoring: ${reference}`);
    await uiCommand("wait", "#editor-application");
    const current = await connectChrome(reference, originA, "nav.profile");
    for (const url of [originB + "/", `http://localhost:${new URL(originA).port}/`]) {
      const attempt = await browserCommand(current, "open", url);
      if ((await browse("get", "url")).url !== url) {
        assert.equal(attempt.success, false);
        assert.match(attempt.error, /domain|allow.list/u);
        if (process.argv.includes("--ordinary")) {
          await inspect("dashboard", originA + "/");
          continue;
        }
        await browse("eval", `setTimeout(() => location.assign(${JSON.stringify(url)}), 100)`);
        await until(async () => (await browse("get", "url")).url === url, "Chrome did not show the blocked-document URL");
      }
      const offset = requests.length;
      await click("Inspect current page");
      await waitText("The page is outside the approved application.");
      await state("ERROR");
      assert.deepEqual(await rows(), []);
      assert.ok(await isEnabled("Inspect current page"));
      assert.ok(await isEnabled("Disconnect"));
      assert.ok((await inventory()).has(current));
      assert.ok(requests.slice(offset).some(entry => entry.path === studioPath && entry.body?.action === "refresh" && entry.status === 503));
      await browse("open", originA + "/");
      await browse("wait", marker("nav.profile"));
      await inspect("dashboard", originA + "/");
    }
    await click("Disconnect");
    await state("DISCONNECTED");
    await ownedClosed(current);
  });

  await step("9 record UI-to-result and host HTTP timings", () => JSON.stringify(uiTimes));
}

await runStudioAcceptance(acceptance);
