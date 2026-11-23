// Opt-in after the lead allocates the isolated ports. --plan is service-free.
import assert from "node:assert/strict";

const stories = [
  "Enroll history and hash applications with isolated registries",
  "Register history targets and save a workflow with verification",
  "Preview the history workflow and break its live marker",
  "Repair the target without changing the workflow identity",
  "Review, publish, revise, compare and restore immutable versions",
  "Register hash targets, author and preview a second workflow",
  "Check keyboard and responsive behavior",
  "Keep the stale edit visible when two Studio tabs save the same draft",
  "Run the published snapshot under strict CSP with Studio closed",
];
if (process.argv.includes("--plan")) {
  for (const [index, name] of stories.entries()) console.log(`STEP ${index + 1} ${name}`);
  console.log("Live run requires --run --completion and coordinated ports 8795, 5186–5189 and PostgreSQL 54362.");
} else {
  assert.ok(process.argv.includes("--run") && process.argv.includes("--completion"), "Coordinate isolated ports before passing --run --completion");
  await run();
}

async function run() {
  const { browserCommand, browserSession, elapsed, historyApp, inventory, launchOperator, originA, originB, standaloneOrigin, startStandaloneHistory, request, requests, runStudioAcceptance, trackProcesses, until } =
    await import("./studio-acceptance-support.mjs");
  const applications = "/api/admin/applications";
  const workflows = "/api/admin/walkthroughs";
  const profileTitle = "Profile acceptance workflow";
  const changedTitle = "Profile acceptance workflow v2";
  const ordersTitle = "Orders acceptance workflow";
  const steps = ["Open the profile.", "Change the display name.", "Save the display name."];
  const orderSteps = ["Open your orders.", "Write an order note.", "Submit the order."];
  const finished = "Acceptance workflow complete.";
  let operator, studioTab, historyId, ordersId, workflowId;

  async function step(index, operation) {
    const start = performance.now();
    try { await operation(); console.log(`STEP ${index + 1} PASS ${elapsed(start)} ms | ${stories[index]}`); }
    catch (error) { console.log(`STEP ${index + 1} FAIL ${elapsed(start)} ms | ${stories[index]}`); throw error; }
  }
  async function command(session, ...args) {
    const answer = await browserCommand(session, ...args);
    assert.equal(answer.success, true, `Browser ${args[0]} failed: ${answer.error ?? ""}`);
    return answer.data;
  }
  const ui = (...args) => command(operator, ...args);
  const capture = (...args) => command(browserSession(), ...args);
  const read = async code => (await ui("eval", "-b", Buffer.from(code).toString("base64"))).result;
  const route = name => ui("open", `${originA}/#/${name}`);
  const wait = selector => ui("wait", selector);
  const text = value => ui("wait", "--text", value);
  const fill = (selector, value) => ui("fill", selector, value);
  async function select(selector, value) {
    await until(() => read(`[...document.querySelector(${JSON.stringify(selector)})?.options ?? []].some(option => option.value === ${JSON.stringify(value)})`), `Missing option ${value}`);
    await ui("select", selector, value);
  }
  async function click(name) {
    await until(() => read(`[...document.querySelectorAll("button")].some(button =>
      (button.getAttribute("aria-label") || button.textContent.trim()) === ${JSON.stringify(name)} && !button.disabled && button.getClientRects().length > 0)`), `Missing enabled button ${name}`);
    await ui("find", "role", "button", "click", "--name", name, "--exact");
  }
  async function enroll(name, origin, routing, runtime = false) {
    await route("applications");
    await wait("#application-name");
    await fill("#application-name", name);
    await fill("#application-origin", origin);
    await fill("#application-allowed", runtime ? `${origin}\n${standaloneOrigin}` : origin);
    await select("#application-environment", "test");
    await select("#application-registry", "studio-managed");
    await select("#application-routing", routing);
    if (runtime) await ui("check", "#application-runtime");
    await click("Enroll application");
    await text("Application saved.");
    const item = (await request("GET", applications, 200)).applications.find(app => app.name === name);
    assert.equal(item?.routing, routing);
    assert.equal(item?.origin, origin);
    assert.equal(item?.enabled, true);
    assert.equal(item?.runtimeAccess, runtime);
    if (runtime) assert.ok(item.allowedOrigins.includes(standaloneOrigin));
    return item.id;
  }
  async function openEditor(name) {
    await route("applications");
    await click(`Open Studio: ${name}`);
    await wait("#editor-title");
  }
  async function inspect() {
    const from = requests.length;
    await click("Inspect current page");
    await until(() => requests.slice(from).some(item => item.body?.action === "refresh" && item.status === 200), "Inspector did not return a fresh result");
    await wait('.studio-workspace[data-state="CONNECTED"]');
  }
  async function register(name, marker) {
    await click(`Register target: ${name}`);
    await wait("form.studio-register");
    assert.equal(await read('document.querySelector(\'form.studio-register [id$="-register-id"]\').value'), marker);
    await fill('form.studio-register textarea', `Acceptance target ${name}.`);
    await click("Register target");
    await text("It is now a trusted target on this page.");
  }
  const stored = async (title, applicationId) => {
    const item = (await request("GET", workflows, 200)).authored.find(row => row.title === title && row.applicationId === applicationId);
    assert.ok(item, `Workflow not saved: ${title}`);
    return item.id;
  };
  async function author(title, items, instructions) {
    await fill("#editor-title", title);
    await fill("#editor-description", "An acceptance workflow.");
    await fill("#editor-completion", finished);
    for (const [index, id] of items.entries()) {
      if (index > 0) await click("Add step");
      await select("#editor-target", id);
      await select("#editor-wait", index === 1 ? "input" : "click");
      await fill("#editor-text", instructions[index]);
    }
  }
  async function popup(origin) {
    const existing = new Set((await ui("tab")).tabs.map(tab => tab.tabId));
    await click("Preview");
    let child;
    await until(async () => {
      child = (await ui("tab")).tabs.find(tab => !existing.has(tab.tabId) && tab.url.startsWith(origin + "/"));
      return Boolean(child);
    }, "Preview application tab did not open");
    await trackProcesses();
    await ui("tab", child.tabId);
    assert.equal(await read("Boolean(window.opener)"), true);
    return child.tabId;
  }
  async function returnFromPopup(tab) {
    await ui("tab", studioTab);
    await text("Preview results");
    await ui("tab", "close", tab);
  }
  async function publish() {
    await click("Publish");
    await wait(".publish-review");
    await until(() => read('document.querySelector(".publish-review button:last-child")?.disabled === false'), "Publish review did not allow this draft");
    assert.equal(await read('document.activeElement.textContent'), "Cancel");
    await ui("press", "Shift+Tab");
    assert.equal(await read('document.activeElement.textContent'), "Publish");
    await ui("press", "Enter");
    await wait('table[aria-label="Workflows"]');
  }

  await runStudioAcceptance(async () => {
    operator = await launchOperator();
    studioTab = (await ui("tab")).tabs.find(tab => tab.url.startsWith(originA)).tabId;
    await wait("#demo-role");
    await select("#demo-role", "maintainer");
    const profile = historyApp().origin;

    await step(0, async () => {
      historyId = await enroll("History acceptance", profile, "history", true);
      ordersId = await enroll("Hash acceptance", originB, "hash");
      assert.notEqual(historyId, ordersId);
    });
    await step(1, async () => {
      await openEditor("History acceptance");
      await click("Connect Chrome");
      await inspect();
      await register("Profile", "nav.profile");
      await capture("open", profile + "/profile");
      await inspect();
      await register("Display name", "profile.displayName");
      await register("Save", "profile.save");
      await capture("click", '[data-ai-id="profile.save"]');
      await inspect();
      await register("Saved", "profile.savedStatus");
      await author(profileTitle, ["nav.profile", "profile.displayName", "profile.save"], steps);
      await select("#editor-verification-condition", "text");
      await select("#editor-verification-target", "profile.savedStatus");
      await fill("#editor-verification-expected", "Saved");
      await click("Set verification");
      await text("Verification set:");
      await click("Save draft");
      await wait('#editor-save-state[data-state="saved"]');
      workflowId = await stored(profileTitle, historyId);
      const record = await request("GET", `${workflows}/${workflowId}`, 200);
      assert.match(record.definition.steps.find(item => item.target === "profile.save").verify, /^check\.v[0-9a-f]{10}$/u);
      await click("Disconnect");
    });
    await step(2, async () => {
      const successful = await popup(profile);
      await text(steps[0]); await ui("click", '[data-ai-id="nav.profile"]');
      await text(steps[1]); await ui("click", "#display-name"); await ui("press", "A");
      await text(steps[2]); await ui("click", '[data-ai-id="profile.save"]');
      await text(finished); await returnFromPopup(successful);
      await click("Edit");
      historyApp().setVariant("moved");
      const failed = await popup(profile);
      await text(steps[0]); await ui("click", '[data-ai-id="nav.profile"]');
      await text(steps[1]); await ui("click", "#display-name"); await ui("press", "B");
      await ui("tab", studioTab);
      await text("Target not found: profile.save");
      await ui("tab", "close", failed);
    });
    await step(3, async () => {
      await click("Re-record target");
      await text("Repair mode for profile.save");
      await click("Connect Chrome");
      await wait('.studio-workspace[data-state="CONNECTED"]');
      await capture("open", profile + "/profile");
      await inspect();
      await click("Use as replacement: Save");
      await click("Preview repair");
      await click("Confirm repair");
      await text("Target profile.save repaired.");
      const target = await request("GET", `${applications}/${historyId}/targets/profile.save`, 200);
      assert.equal(target.id, "profile.save");
      assert.equal(target.marker, "profile.submit");
      assert.ok(target.changes.length > 0);
      await click("Disconnect");
      await route("walkthroughs"); await click(`Edit: ${profileTitle}`);
      const repaired = await popup(profile);
      await text(steps[0]); await ui("click", '[data-ai-id="nav.profile"]');
      await text(steps[1]); await ui("click", "#display-name"); await ui("press", "C");
      await text(steps[2]); await ui("click", '[data-ai-id="profile.submit"]');
      await text(finished); await returnFromPopup(repaired); await click("Edit");
    });
    await step(4, async () => {
      await publish();
      await click(`Create draft from published: ${profileTitle}`);
      await fill("#editor-title", changedTitle);
      await click("Save draft"); await wait('#editor-save-state[data-state="saved"]');
      assert.equal((await request("GET", `${workflows}/${workflowId}`, 200)).liveVersion, 1);
      await publish();
      await click(`Version history: ${changedTitle}`);
      await text("v2 (Live)");
      await click("Compare");
      await text(`${profileTitle} → ${changedTitle}`);
      await click("Create draft from version 1");
      await click("Create draft");
      await wait("#editor-title");
      assert.equal(await read('document.querySelector("#editor-title").value'), profileTitle);
      assert.equal((await request("GET", `${workflows}/${workflowId}`, 200)).liveVersion, 2);
    });
    await step(5, async () => {
      await openEditor("Hash acceptance");
      assert.equal(await read('document.querySelector(\'#editor-target option[value="profile.save"]\') === null'), true);
      await click("Connect Chrome"); await inspect(); await register("Orders", "nav.orders");
      await capture("open", originB + "/#/orders"); await inspect();
      await register("Order note", "orders.note"); await register("Submit order", "orders.submit");
      await author(ordersTitle, ["nav.orders", "orders.note", "orders.submit"], orderSteps);
      await click("Save draft"); await wait('#editor-save-state[data-state="saved"]');
      await stored(ordersTitle, ordersId);
      await click("Disconnect");
      const tab = await popup(originB);
      await text(orderSteps[0]); await ui("click", '[data-ai-id="nav.orders"]');
      await text(orderSteps[1]); await ui("click", "#order-note"); await ui("press", "A");
      await text(orderSteps[2]); await ui("click", '[data-ai-id="orders.submit"]');
      await text(finished); await returnFromPopup(tab);
      await click("Edit");
    });
    await step(6, async () => {
      await click("Publish");
      await wait(".publish-review");
      assert.equal(await read("document.activeElement.textContent"), "Cancel");
      await ui("press", "Escape");
      assert.equal(await read('document.querySelector("dialog[open]") === null && document.activeElement.textContent === "Publish"'), true);
      for (const width of [320, 375, 768, 1024, 1280]) {
        await ui("set", "viewport", String(width), "900");
        const layout = await read('({ width: innerWidth, client: document.documentElement.clientWidth, scroll: document.documentElement.scrollWidth, columns: getComputedStyle(document.querySelector(".editor-panes")).gridTemplateColumns.split(" ").length })');
        assert.equal(layout.width, width);
        assert.ok(layout.scroll <= layout.client, `Horizontal overflow at ${width}px`);
        assert.equal(layout.columns, width < 900 ? 1 : 3);
        console.log(`WIDTH ${width} PASS client=${layout.client} scroll=${layout.scroll}`);
      }
      await publish();
      const hash = await stored(ordersTitle, ordersId);
      assert.equal((await request("GET", `${workflows}/${hash}`, 200)).liveVersion, 1);
    });
    await step(7, async () => {
      await route("walkthroughs"); await click(`Edit: ${profileTitle}`); await wait("#editor-title");
      const persisted = `${workflows}/${workflowId}`;
      const before = (await request("GET", persisted, 200)).revision;
      const oldTabs = new Set((await ui("tab")).tabs.map(tab => tab.tabId));
      await ui("tab", "new", `${originA}/#/walkthroughs`);
      const peer = (await ui("tab")).tabs.find(tab => !oldTabs.has(tab.tabId));
      assert.ok(peer, "Second Studio tab was not opened");
      await ui("tab", peer.tabId);
      await wait("#demo-role");
      await select("#demo-role", "maintainer");
      await click(`Edit: ${profileTitle}`); await wait("#editor-title");
      const from = requests.length;
      await ui("tab", studioTab);
      await fill("#editor-title", "Profile draft saved in first tab");
      await click("Save draft"); await wait('#editor-save-state[data-state="saved"]');
      await ui("tab", peer.tabId);
      await fill("#editor-title", "Profile draft kept in second tab");
      await click("Save draft");
      await wait('#editor-conflict[role="alert"]:not([hidden])');
      assert.equal(await read('document.querySelector("#editor-title").value'), "Profile draft kept in second tab");
      const writes = requests.slice(from).filter(item => item.path === persisted && item.method === "PUT");
      assert.deepEqual(writes.map(item => [item.status, item.body.expectedRevision]), [[200, before], [409, before]]);
      assert.deepEqual(writes[1].response, { kind: "conflict", code: "REVISION_CONFLICT", currentRevision: before + 1 });
      assert.equal((await request("GET", persisted, 200)).definition.title, "Profile draft saved in first tab");
      await click("Load the saved version");
      await until(() => read('document.querySelector("#editor-title")?.value === "Profile draft saved in first tab"'), "Peer did not reload the saved draft");
      await ui("tab", "close", peer.tabId);
      await ui("tab", studioTab);
    });
    await step(8, async () => {
      const application = await request("GET", `${applications}/${historyId}`, 200);
      assert.match(application.runtimeKey, /^rk-/u);
      const fixture = await startStandaloneHistory(application.runtimeKey);
      assert.equal(fixture.origin, standaloneOrigin);
      const response = await fetch(fixture.origin, { signal: AbortSignal.timeout(2000) });
      assert.equal(response.headers.get("content-security-policy"), fixture.policy());
      await response.body?.cancel();
      assert.match(fixture.policy(), /^default-src 'none';/u);
      assert.doesNotMatch(fixture.policy(), /unsafe-inline/u);

      const closed = operator;
      await ui("close");
      await until(async () => !(await inventory()).has(closed), "Studio operator still running");
      const from = requests.length;
      operator = await launchOperator(fixture.origin + "/");
      assert.equal(await read("window.opener === null"), true);
      assert.ok((await ui("tab")).tabs.every(tab => !tab.url.startsWith(originA)), "Studio must stay closed during delivery");
      await click("Guides");
      await click(`Start guide: ${changedTitle}`);
      await text(steps[0]); await ui("click", '[data-ai-id="nav.profile"]');
      await text(steps[1]); await ui("click", "#display-name"); await ui("press", "A");
      await text(steps[2]); await ui("click", '[data-ai-id="profile.submit"]');
      await text(finished);
      assert.equal(await read('document.querySelector("#saved-status").textContent'), "Saved");
      assert.deepEqual(await read("window.cspViolations"), []);
      const served = requests.slice(from).filter(item => item.path.startsWith("/api/runtime/") && item.method === "GET");
      assert.equal(served.length, 2);
      assert.ok(served.every(item => item.status === 200 && item.origin === fixture.origin && !item.role && !item.hasCookie));
    });
  });
}
