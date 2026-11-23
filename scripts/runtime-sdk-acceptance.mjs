import assert from "node:assert/strict";
import { startConsumer } from "../tests/fixtures/runtime-consumer/server.mjs";
import {
  browserCommand, browserSession, hostOrigin, launchOperator, request, requests, runStudioAcceptance, step, studio, until,
} from "./studio-acceptance-support.mjs";

const applications = "/api/admin/applications";
const workflows = "/api/admin/walkthroughs";
const callBrowser = async (session, ...args) => {
  const result = await browserCommand(session, ...args);
  assert.equal(result.success, true, `Browser ${args[0]} failed: ${result.error ?? ""}`);
  return result.data;
};

async function seed(consumer) {
  const { name, origin, routing, prefix } = consumer;
  const app = await request("POST", applications, 201, {
    name, origin, allowedOrigins: [origin], routing, environment: "test", registryId: "studio-managed", runtimeAccess: true,
  });
  const { sessionId } = await studio("connect", { applicationId: app.id });
  const command = (action, fields) => studio(action, { sessionId, applicationId: app.id, ...fields });
  async function register(marker) {
    const { elements } = await command("refresh");
    const candidate = elements.find(item => item.proposal?.targetId === marker);
    assert.ok(candidate, `Missing registrable marker ${marker}`);
    const { targetId, route, suggestedLabel, defaultOperations } = candidate.proposal;
    return command("register", { ref: candidate.ref, targetId, route, label: suggestedLabel, description: `Public ${suggestedLabel} control.`, operations: defaultOperations, privacy: "public" });
  }
  let profile;
  try {
    await register(`${prefix}.profile`);
    await callBrowser(browserSession(), "click", `[data-ai-id="${prefix}.profile"]`);
    await callBrowser(browserSession(), "wait", "#label");
    profile = (await register(`${prefix}.label`)).route.route;
    await register(`${prefix}.save`);
    await callBrowser(browserSession(), "click", "#save");
    await register(`${prefix}.saved`);
  } finally {
    await command("disconnect");
  }
  const checks = `${applications}/${app.id}/checks`;
  const text = await request("POST", checks, 200, { kind: "element.text.equals", targetId: `${prefix}.saved`, expected: "Saved" });
  const definition = {
    title: `Set name in ${name}`, description: "Change and save the display name.", start: "open",
    steps: [
      { id: "open", kind: "guide", target: `${prefix}.profile`, text: "Open Profile.", wait: "click", verify: `route.${profile}`, next: "enter" },
      { id: "enter", kind: "guide", target: `${prefix}.label`, text: "Enter a display name.", wait: "input", next: "save" },
      { id: "save", kind: "guide", target: `${prefix}.save`, text: "Save your name.", wait: "click", verify: text.name, next: "done" },
      { id: "done", kind: "complete", text: "Your name was saved." },
    ],
  };
  const record = await request("POST", workflows, 201, { applicationId: app.id, definition });
  const draft = await request("POST", workflows, 201, { applicationId: app.id, definition: { ...definition, title: `${name} draft only` } });
  const review = await request("POST", `${workflows}/${record.id}/review`, 200, {});
  assert.equal(review.ok, true);
  await request("POST", `${workflows}/${record.id}/status`, 200, { status: "published", expectedRevision: review.revision });
  consumer.configure(app.id, app.runtimeKey);
  return { ...app, title: definition.title, guide: record.id, draft: draft.id };
}

async function runConsumer(consumer, app, other) {
  const index = requests.length;
  const session = await launchOperator(`${consumer.origin}/`);
  const ui = (...args) => callBrowser(session, ...args);
  const evaluate = async code => (await ui("eval", "-b", Buffer.from(code).toString("base64"))).result;
  async function waitText(value) {
    try {
      await until(() => evaluate(`document.body.innerText.includes(${JSON.stringify(value)})`), `Missing ${value}`);
    } catch (error) {
      const state = await evaluate("({page: location.pathname + location.hash, run: simplism.getRun(), runtimeText: document.querySelector('[data-simplism-runtime]')?.innerText})");
      throw new Error(`${error.message}: ${JSON.stringify(state)}`, { cause: error });
    }
  }
  const visible = selector => ui("wait", selector);
  async function startGuide() {
    await ui("click", ".dap-launcher-button");
    await visible(".dap-launcher-panel li button");
    assert.equal(await evaluate("document.querySelector('.dap-launcher-panel ul').innerText.includes(" + JSON.stringify(other.title) + ")"), false);
    assert.equal(await evaluate("document.querySelectorAll('.dap-launcher-panel li').length"), 1);
    assert.equal(await evaluate("document.activeElement.matches('.dap-launcher-panel li button')"), true);
    await ui("press", "Enter");
    await waitText("Open Profile.");
    await visible(".dap-guide-ring");
  }
  await step(`${consumer.name} SDK bootstrap, app-local list and keyboard launch`, async () => {
    await until(() => evaluate("window.simplismReady?.every(reply => reply.ok) === true"), "SDK did not initialize");
    assert.deepEqual(await evaluate("window.simplismReady[0].value.map(item => item.id)"), [app.guide]);
    assert.equal(await evaluate("window.opener === null && document.querySelectorAll('[data-simplism-runtime]').length === 1"), true);
    assert.equal(await evaluate("performance.getEntriesByName(location.origin + '/sdk/simplism.css').length"), 1);
    const inactive = await evaluate(`window.simplism.startGuide(${JSON.stringify(other.guide)})`);
    assert.deepEqual(inactive, { ok: false, code: "GUIDE_NOT_FOUND" });
    await startGuide();
    await ui("click", `[data-ai-id="${consumer.prefix}.profile"]`);
    await waitText("Enter a display name.");
    assert.equal(await evaluate("document.querySelector('[data-ai-overlay=progress]').textContent"), "Step 2 of 3");
    await ui("click", "#label");
    await ui("press", "A");
    await waitText("Save your name.");
    await ui("click", "#save");
    await waitText("Your name was saved.");
    await ui("click", ".dap-result button");
    assert.equal(await evaluate("document.activeElement.matches('.dap-launcher-button')"), true);
  });
  await step(`${consumer.name} reload, restart, manual stop and destroy`, async () => {
    await ui("open", `${consumer.origin}/`);
    await until(() => evaluate("window.simplismReady?.every(reply => reply.ok) === true"), "Reload did not bootstrap");
    assert.equal(await evaluate("document.querySelectorAll('[data-simplism-runtime]').length"), 1);
    await startGuide();
    await ui("click", ".dap-launcher-button");
    await ui("find", "role", "button", "click", "--name", "Restart guide", "--exact");
    await waitText("Open Profile.");
    await ui("click", ".dap-launcher-button");
    await ui("find", "role", "button", "click", "--name", "Stop guide", "--exact");
    assert.equal(await evaluate("document.querySelector('.dap-guide-card, .dap-guide-ring, .dap-result') === null"), true);
    await startGuide();
    await evaluate("window.simplism.destroy()");
    assert.equal(await evaluate("document.querySelector('[data-simplism-runtime], .dap-guide-card, .dap-guide-ring, .dap-result, link[href$=\"/sdk/simplism.css\"]') === null"), true);
    assert.equal(await evaluate("document.querySelector('link[href=\\\"/portal.css\\\"]').isConnected"), true);
    assert.deepEqual(await evaluate("window.cspViolations"), []);
    await ui("reload");
    await until(() => evaluate("window.simplismReady?.every(reply => reply.ok) === true"), "Page reload did not reinitialize the SDK");
    assert.equal(await evaluate("document.querySelectorAll('[data-simplism-runtime]').length"), 1);
    await evaluate("document.querySelector('a[data-ai-id]').removeAttribute('data-ai-id')");
    await evaluate(`window.simplism.startGuide(${JSON.stringify(app.guide)})`);
    await until(() => evaluate("window.simplism.getRun().code === 'TARGET_NOT_FOUND'"), "Missing marker did not stop the run");
    assert.equal(await evaluate("document.querySelector('.dap-guide-ring') === null"), true);
    await ui("click", ".dap-result button");
    assert.equal(await evaluate("document.activeElement.matches('.dap-launcher-button')"), true);
  });
  const reads = requests.slice(index).filter(item => item.path.startsWith("/api/runtime/"));
  assert.ok(reads.some(item => item.path.includes(`/guides/${app.guide}?`)));
  assert.ok(reads.every(item => item.status === 200 && item.origin === consumer.origin && !item.hasCookie && !item.hasAuthorization && item.role === undefined));
  assert.doesNotMatch(JSON.stringify(reads.map(item => item.response)), /@e\d+|draft only|privateEvidence|runtimeKey|tenantId/u);
  assert.ok(reads.every(item => item.path.endsWith(`?applicationId=${app.id}`) && !item.path.includes(other.guide) && !item.path.includes(app.draft)));
  await ui("close");
}

await runStudioAcceptance(async () => {
  const consumers = [];
  try {
    for (const [port, routing] of [[5187, "hash"], [5188, "history"]]) {
      consumers.push(await startConsumer({ port, routing, apiOrigin: hostOrigin }));
    }
    const [hash, history] = consumers;
    let a;
    let b;
    await step("publish the hash application guide and retain its draft", async () => { a = await seed(hash); });
    await step("publish the history application guide and retain its draft", async () => { b = await seed(history); });
    await runConsumer(hash, a, b);
    await runConsumer(history, b, a);
  } finally { await Promise.all(consumers.map(consumer => consumer.close())); }
});
