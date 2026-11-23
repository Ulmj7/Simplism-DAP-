// Opt-in Linux Chromium acceptance. With migrations applied to the isolated dapstudiov1 database on
// port 54359, export DAP_DATABASE_URL for its dap_app role and run npm run acceptance:studio-v1-host.
// Build/install the vendored browser first (see docs/studio-v1.md). The script owns loopback ports
// 8794, 5184 and 5185 for this run. It uses headed Chrome when a display is available, otherwise
// headless. Each run uses new test tenants. It never drives the editor or changes another session.
import assert from "node:assert/strict";
import {
  browserCommand, browserSession, inventory, metrics, originA, originB, query, request, runStudioAcceptance,
  shutdownHost, step, studio, trackProcesses, until,
} from "./studio-acceptance-support.mjs";

function errorCode(expected) {
  return { error: expected };
}
const selector = id => `[data-ai-id="${id}"]`;
async function operate(...args) {
  return browserCommand(browserSession(), ...args);
}
async function operator(...args) {
  const reply = await operate(...args);
  assert.equal(reply.success, true, `Chrome ${args[0]}: ${reply.error ?? "unexpected result"}`);
  return reply.data;
}
async function openPage(url, target) {
  await operator("open", url);
  await operator("wait", selector(target));
}
const findTrusted = (view, targetId, name, role) => {
  const candidate = view.elements.find(element => element.targetId === targetId);
  assert.ok(candidate, `Expected ${targetId} at ${view.route}: ${JSON.stringify(view.elements)}`);
  assert.match(candidate.ref, /^@e[1-9]\d{0,8}$/u);
  const { operations, ...evidence } = candidate;
  assert.deepEqual(evidence, { ref: candidate.ref, name, role, route: view.route, status: "trusted", targetId, privacy: "public" });
  assert.ok(operations.includes("highlight"));
  return candidate;
};
const walkthroughCount = () => query(async client =>
  (await client.query("SELECT count(*)::int AS count FROM public.walkthrough_definitions")).rows[0].count);

async function acceptance() {
  let applicationA;
  let applicationB;
  let session;
  let profile;
  let name;
  let save;
  let walkthroughId;

  async function attach(application, target) {
    const reply = await studio("connect", { applicationId: application.id });
    assert.match(reply.sessionId, /^[0-9a-f-]{36}$/u);
    assert.deepEqual(reply, { sessionId: reply.sessionId, applicationId: application.id, application: application.name, origin: application.origin, registrySource: "built-in" });
    assert.ok((await inventory()).has(browserSession()));
    await trackProcesses();
    await operator("wait", selector(target));
    session = { sessionId: reply.sessionId, applicationId: application.id };
  }

  async function refresh(route, url) {
    const reply = await studio("refresh", session);
    assert.equal(reply.route, route);
    if (url) assert.equal(reply.url, url);
    assert.ok(reply.elements.length <= 64);
    return reply;
  }

  async function verifyHighlight(candidate) {
    const reply = await studio("highlight", { ...session, ref: candidate.ref });
    assert.deepEqual(reply, { highlighted: true, ref: candidate.ref });
    const { result } = await operator("eval", `document.querySelector(${JSON.stringify(selector(candidate.targetId))}).style.outline`);
    assert.equal(result, "red solid 2px");
  }

  async function capture(candidate) {
    const reply = await studio("capture", { ...session, ref: candidate.ref });
    const { targetId, route, name, role, operations } = candidate;
    assert.deepEqual(reply, { targetId, route, name, role, operations });
    return reply.targetId;
  }

  async function detach() {
    const closed = browserSession();
    await trackProcesses();
    assert.deepEqual(await studio("disconnect", session), { closed: true });
    await until(async () => !(await inventory()).has(closed), "Disconnected session is still listed");
    assert.deepEqual(await studio("refresh", session, 404), errorCode("SESSION_CLOSED"));
  }

  await step("1 enroll A and B and isolate tenant", async () => {
    const create = async (name, origin, environment, registryId) => {
      const setup = { name, origin, allowedOrigins: [origin], environment, registryId };
      const record = await request("POST", "/api/admin/applications", 201, setup);
      assert.match(record.id, /^app-[0-9a-f]{12}$/u);
      assert.ok(Number.isFinite(Date.parse(record.updatedAt)));
      assert.deepEqual(record, { ...setup, id: record.id, enabled: true, updatedAt: record.updatedAt, source: "built-in" });
      return record;
    };
    applicationA = await create("Reference application", originA, "development", "reference");
    applicationB = await create("Second application", originB, "test", "fixture-b");
    const listed = await request("GET", "/api/admin/applications", 200);
    assert.deepEqual(new Set(listed.applications), new Set([applicationA, applicationB]));
    const other = await request("GET", "/api/admin/applications", 200, undefined, "foreign");
    assert.deepEqual(other.applications, []);
    for (const application of [applicationA, applicationB]) {
      const hidden = await request("GET", `/api/admin/applications/${application.id}`, 404, undefined, "foreign");
      assert.equal(hidden.code, "APPLICATION_NOT_FOUND");
    }
  });

  await step("2 inspect dashboard, highlight and use Profile", async () => {
    await attach(applicationA, "nav.profile");
    const view = await refresh("dashboard");
    const candidate = findTrusted(view, "nav.profile", "Profile", "link");
    findTrusted(view, "nav.settings", "Settings", "link");
    const before = await walkthroughCount();
    await verifyHighlight(candidate);
    assert.equal(await walkthroughCount(), before);
    profile = await capture(candidate);
    assert.equal(await walkthroughCount(), before);
    return `${view.elements.length} candidates, walkthrough rows unchanged`;
  });

  await step("3 inspect Profile and Settings; reject the private email target", async () => {
    await operator("click", selector(profile));
    await operator("wait", selector("profile.nameInput"));
    const view = await refresh("profile", `${originA}/#/profile`);
    const input = findTrusted(view, "profile.nameInput", "Display name", "textbox");
    const button = findTrusted(view, "profile.saveButton", "Save", "button");
    assert.ok(!view.elements.some(element => element.name === "Email" || element.targetId === "profile.emailInput"));
    await verifyHighlight(input);
    name = await capture(input);
    save = await capture(button);

    if (!process.argv.includes("--ordinary")) {
      // Give the private control an approved name only in this browser to test registry privacy independently of label filtering.
      const email = `document.querySelector(${JSON.stringify(selector("profile.emailInput"))})`;
      await operator("eval", `${email}.setAttribute("aria-label", "Display name")`);
      const privateView = await refresh("profile");
      const unregistered = privateView.elements.find(element => element.name === "Display name" && element.status === "unregistered");
      assert.ok(unregistered, "Approved label is visible without a private target");
      assert.doesNotMatch(JSON.stringify(privateView), /profile\.emailInput/u);
      assert.deepEqual(unregistered, { ref: unregistered.ref, name: "Display name", role: "textbox", route: "profile", status: "unregistered" });
      for (const action of ["highlight", "capture"]) {
        assert.deepEqual(await studio(action, { ...session, ref: unregistered.ref }, 409), errorCode("TARGET_UNAVAILABLE"));
      }
      await operator("eval", `${email}.removeAttribute("aria-label")`);
    }

    await openPage(`${originA}/#/settings`, "settings.advancedToggle");
    await operator("click", selector("settings.advancedToggle"));
    await operator("wait", selector("settings.twoFactorSetup"));
    const settings = await refresh("settings");
    findTrusted(settings, "settings.advancedToggle", "Advanced", "button");
    findTrusted(settings, "settings.twoFactorSetup", "Set up two-factor authentication", "button");
    return `${view.elements.length} profile candidates, ${settings.elements.length} settings candidates`;
  });

  await step("4 write, reopen and publish A draft; reject A targets for B", async () => {
    const path = "/api/admin/walkthroughs";
    const definition = {
      title: "Studio acceptance profile", description: "Update a public profile field.", start: "open",
      steps: [
        { id: "open", kind: "guide", target: profile, text: "Open the profile page.", wait: "click", verify: "route.profile", next: "navigate" },
        { id: "navigate", kind: "navigate", route: "profile", next: "enter" },
        { id: "enter", kind: "guide", target: name, text: "Enter the public name.", wait: "input", next: "save" },
        { id: "save", kind: "guide", target: save, text: "Save the change.", wait: "click", verify: "profile.saved", next: "done" },
        { id: "done", kind: "complete", text: "Profile updated." },
      ],
    };
    const invalid = await request("POST", path, 422, { applicationId: applicationB.id, definition });
    assert.equal(invalid.kind, "invalid");
    assert.ok(invalid.issues.length > 0);
    const created = await request("POST", path, 201, { applicationId: applicationA.id, definition });
    walkthroughId = created.id;
    const draftPath = `${path}/${walkthroughId}`;
    definition.description = "Update the public profile field and save it.";
    const saved = await request("PUT", draftPath, 200, { applicationId: applicationA.id, definition });
    assert.deepEqual(saved.definition, { ...definition, id: walkthroughId });
    const reopened = await request("GET", draftPath, 200);
    assert.equal(reopened.status, "draft");
    assert.equal(reopened.applicationId, applicationA.id);
    assert.deepEqual(reopened.definition, saved.definition);
    assert.equal(await walkthroughCount(), 1);
    const stored = await query(async client =>
      (await client.query("SELECT definition FROM public.walkthrough_definitions WHERE walkthrough_id = $1", [walkthroughId])).rows[0].definition);
    assert.deepEqual(stored, { ...definition, id: walkthroughId });
    assert.doesNotMatch(JSON.stringify(stored), /@e\d/u);
    assert.equal((await request("POST", `${draftPath}/status`, 200, { status: "published" })).status, "published");
    const published = await request("GET", "/api/walkthroughs/published", 200);
    assert.deepEqual(published.walkthroughs.find(guide => guide.id === walkthroughId), stored);
  });

  await step("5 switch to B and back through explicit reconnects", async () => {
    await detach();
    await attach(applicationB, "nav.orders");
    const home = await refresh("home");
    const orders = findTrusted(home, "nav.orders", "Orders", "link");
    await verifyHighlight(orders);
    await capture(orders);
    assert.deepEqual(await studio("refresh", { ...session, applicationId: applicationA.id }, 409), errorCode("APPLICATION_MISMATCH"));
    assert.deepEqual(await studio("connect", { applicationId: applicationA.id }, 409), errorCode("BROWSER_BUSY"));
    await operator("click", selector("nav.orders"));
    await operator("wait", selector("orders.submit"));
    const view = await refresh("orders", `${originB}/#/orders`);
    findTrusted(view, "orders.submit", "Submit order", "button");
    findTrusted(view, "orders.note", "Order note", "textbox");
    assert.ok([...home.elements, ...view.elements].every(element => !["Profile", "Settings", "Display name", "Save"].includes(element.name)));
    await detach();
    await attach(applicationA, "nav.profile");
    return `${home.elements.length} home candidates, ${view.elements.length} orders candidates`;
  });

  await step("6a block navigation outside A and recover in the same session", async () => {
    const checks = [];
    for (const [label, url] of [["other port", originB + "/"], ["localhost alias", `http://localhost:${new URL(originA).port}/`], ["unlisted HTTPS host", "https://example.invalid/"]]) {
      const attempt = await operate("open", url);
      const current = await operator("get", "url");
      if (current.url !== url) {
        assert.notEqual(label, "other port");
        assert.equal(attempt.success, false);
        assert.match(attempt.error, /domain|allow.list/u);
        assert.equal(current.url, originA + "/");
        if (process.argv.includes("--ordinary")) {
          await refresh("dashboard", current.url);
          checks.push(`${label}: CLI blocked; original page remained inspectable`);
          continue;
        }
        // A direct CLI open may be refused before navigation. A page-initiated navigation reaches
        // Chrome's document filter instead, so Studio observes the URL of the CLI's blocked page.
        await operator("eval", `setTimeout(() => location.assign(${JSON.stringify(url)}), 100)`);
        await until(async () => (await operator("get", "url")).url === url, "Chrome did not reach the blocked-document URL");
      }
      assert.deepEqual(await studio("refresh", session, 503), errorCode("DOMAIN_BLOCKED"));
      checks.push(`${label}: 503 DOMAIN_BLOCKED`);
      await openPage(originA + "/", "nav.profile");
      await refresh("dashboard", originA + "/");
    }
    return checks.join(", ");
  });

  await step("6b disable A, close the live session and preserve publication", async () => {
    const closed = browserSession();
    const path = `/api/admin/applications/${applicationA.id}/status`;
    assert.equal((await request("POST", path, 200, { enabled: false })).enabled, false);
    assert.deepEqual(await studio("refresh", session, 409), errorCode("APPLICATION_DISABLED"));
    await until(async () => !(await inventory()).has(closed), "Disabled application session is still listed");
    assert.deepEqual(await studio("refresh", session, 404), errorCode("SESSION_CLOSED"));
    assert.deepEqual(await studio("connect", { applicationId: applicationA.id }, 409), errorCode("APPLICATION_DISABLED"));
    assert.ok((await request("GET", "/api/walkthroughs/published", 200)).walkthroughs.some(guide => guide.id === walkthroughId));
    assert.equal((await request("POST", path, 200, { enabled: true })).enabled, true);
  });

  await step("7 disconnect cleanly and verify host shutdown closes a live session", async () => {
    await attach(applicationA, "nav.profile");
    await detach();
    await attach(applicationA, "nav.profile");
    const closed = browserSession();
    await shutdownHost();
    await until(async () => !(await inventory()).has(closed), "Host shutdown left its session listed");
  });

  await step("8 observational timings", () => {
    for (const samples of Object.values(metrics)) assert.ok(samples.length >= 3);
    return JSON.stringify(metrics);
  });
}

await runStudioAcceptance(acceptance);
