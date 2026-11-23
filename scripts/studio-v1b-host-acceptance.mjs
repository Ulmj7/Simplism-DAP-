// Opt-in managed-registry host acceptance. Migrate the isolated V1B database,
// export DAP_DATABASE_URL and DAP_ACCEPTANCE_DB_PORT=54362, then run
// npm run acceptance:studio-v1b-host [-- --headless]. Uses ports 8795, 5186, 5187.
import assert from "node:assert/strict";
import {
  browserCommand, browserSession, elapsed, inventory, originB, request, runStudioAcceptance, trackProcesses, until,
} from "./studio-acceptance-support.mjs";

const apps = "/api/admin/applications";
const guides = "/api/admin/walkthroughs";
const studio = "/api/studio/browser";
const calls = {};
async function step(number, title, operation) {
  const start = performance.now();
  try {
    await operation();
    console.log(`STEP ${number} PASS ${elapsed(start)} ms | ${title}`);
  } catch (error) {
    console.log(`STEP ${number} FAIL ${elapsed(start)} ms | ${title}`);
    throw error;
  }
}
async function command(action, fields, status = 200, tenant) {
  const start = performance.now();
  const result = await request("POST", studio, status, { action, ...fields }, tenant);
  if (status === 200) (calls[action] ??= []).push(action === "refresh" ? { ms: elapsed(start), candidates: result.elements.length } : elapsed(start));
  return result;
}

await runStudioAcceptance(async () => {
  let applicationId, sessionId, chrome, publishedId;
  const bound = (action, fields = {}) => command(action, { sessionId, applicationId, ...fields });
  const register = async (candidate, description) => {
    assert.equal(candidate.status, "registrable");
    const { targetId, route, suggestedLabel, defaultOperations, page } = candidate.proposal;
    const reply = await bound("register", {
      ref: candidate.ref, targetId, route, description, label: suggestedLabel, operations: defaultOperations, privacy: "public",
    });
    assert.equal(reply.target.id, targetId);
    assert.deepEqual(reply.route, { route, page, created: candidate.proposal.routeIsNew });
  };
  await step(1, "enroll the managed application and connect Chrome", async () => {
    const enrolled = await request("POST", apps, 201, { name: "Managed orders", origin: originB, allowedOrigins: [originB], environment: "test", registryId: "studio-managed" });
    assert.equal(enrolled.source, "studio-managed");
    applicationId = enrolled.id;
    const connected = await command("connect", { applicationId });
    assert.equal(connected.registrySource, "studio-managed");
    sessionId = connected.sessionId;
    chrome = browserSession();
    assert.ok((await inventory()).has(chrome));
    await trackProcesses();
  });

  await step(2, "inspect Home, highlight and register the Orders link", async () => {
    const home = await bound("refresh");
    assert.equal(home.page, "/");
    assert.deepEqual(home.elements.map(item => item.name), ["Orders"]);
    assert.ok(home.hidden >= 1);
    assert.deepEqual(await bound("highlight", { ref: home.elements[0].ref }), { highlighted: true, ref: home.elements[0].ref });
    assert.deepEqual((await request("GET", `${apps}/${applicationId}/targets`, 200)).targets, []);
    await register(home.elements[0], "Open the orders page.");
  });

  await step(3, "browse Orders and register two controls on the same route", async () => {
    for (const args of [["click", '[data-ai-id="nav.orders"]'], ["wait", '[data-ai-id="orders.submit"]']]) {
      assert.equal((await browserCommand(chrome, ...args)).success, true);
    }
    for (const [name, description] of [["Order note", "Enter an order note."], ["Submit order", "Submit the order."]]) {
      const snapshot = await bound("refresh");
      assert.equal(snapshot.page, "/#/orders");
      assert.ok(snapshot.hidden >= 3);
      await register(snapshot.elements.find(item => item.name === name), description);
    }
    const publishedTargets = await request("GET", `${apps}/${applicationId}/registry`, 200);
    assert.equal(publishedTargets.source, "studio-managed");
    assert.deepEqual(publishedTargets.elements.map(item => item.id).sort(), ["nav.orders", "orders.note", "orders.submit"]);
    assert.deepEqual(publishedTargets.pages, { "/": "home", "/#/orders": "orders" });
  });

  const definition = {
    title: "Submit an order", description: "Complete the orders demo.", start: "go",
    steps: [
      { id: "go", kind: "navigate", route: "orders", next: "note" },
      { id: "note", kind: "guide", target: "orders.note", text: "Enter a note.", wait: "input", next: "submit" },
      { id: "submit", kind: "guide", target: "orders.submit", text: "Submit it.", wait: "click", verify: "route.orders", next: "done" },
      { id: "done", kind: "complete", text: "Done." },
    ],
  };
  await step(4, "save, reopen, publish and read the managed bundle", async () => {
    const created = await request("POST", guides, 201, { applicationId, definition });
    publishedId = created.id;
    const reopened = await request("GET", `${guides}/${publishedId}`, 200);
    assert.equal(reopened.applicationId, applicationId);
    assert.deepEqual(reopened.definition, { ...definition, id: publishedId });
    assert.doesNotMatch(JSON.stringify(reopened), /@e\d/u);
    assert.equal((await request("POST", `${guides}/${publishedId}/status`, 200, { status: "published" })).status, "published");
    assert.ok((await request("GET", "/api/walkthroughs/published", 200)).external.some(guide => guide.id === publishedId));
    const bundle = await request("GET", `/api/walkthroughs/published/${publishedId}/bundle`, 200);
    assert.deepEqual(bundle.definition, reopened.definition);
  });

  await step(5, "disable the target, check draft and publication effects, then re-enable", async () => {
    const status = `${apps}/${applicationId}/targets/orders.submit/status`;
    assert.equal((await request("POST", status, 200, { status: "disabled" })).status, "disabled");
    assert.ok(!(await request("GET", "/api/walkthroughs/published", 200)).external.some(guide => guide.id === publishedId));
    await request("GET", `/api/walkthroughs/published/${publishedId}/bundle`, 404);
    await request("POST", guides, 422, { applicationId, definition });
    assert.equal((await request("POST", status, 200, { status: "active" })).status, "active");
    await request("GET", `/api/walkthroughs/published/${publishedId}/bundle`, 200);
  });

  await step(6, "resume the workspace and disconnect the owned Chrome", async () => {
    const resumed = await command("resume", { applicationId });
    assert.equal(resumed.resumed, true);
    assert.notEqual(resumed.sessionId, sessionId);
    sessionId = resumed.sessionId;
    const active = await bound("refresh");
    assert.equal(active.elements.filter(item => item.status === "trusted").length, 2);
    assert.deepEqual(await bound("disconnect"), { closed: true });
    await until(async () => !(await inventory()).has(chrome), "Owned Chrome did not close");
  });
  console.log(`OBSERVED_MS ${JSON.stringify(calls)}`);
});
