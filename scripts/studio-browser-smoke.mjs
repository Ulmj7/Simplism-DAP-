import assert from "node:assert/strict";
import { createPlaywrightRuntime, openChromiumSession } from "../packages/browser-runtime/dist/index.js";
import { startFixtureApp } from "../tests/fixtures/studio-app/server.mjs";

const fixture = await startFixtureApp({ name: "DOM smoke" });
let browser;
const runtime = createPlaywrightRuntime({ labels: "all", routes: "any", origins: [fixture.origin] }, async options => {
  browser = await openChromiumSession(options);
  return browser;
});
try {
  await runtime.start({ url: fixture.origin + "/" });
  const snapshot = await runtime.snapshot();
  const target = snapshot.elements.find(element => element.name === "Orders");
  assert.ok(target);
  await runtime.highlight(target.ref, snapshot);
  assert.deepEqual(await runtime.waitForChange({ timeoutMs: 500 }), { status: "timeout" });
  assert.ok((await runtime.inspectUi()).targets.some(control => control.name === "Orders"));

  await browser.page.evaluate(() => {
    document.body.insertAdjacentHTML("beforeend", '<section data-ai-private>hidden-canary</section><input value="value-canary"><div id="shadow"></div><iframe src="/#/orders"></iframe><iframe src="https://example.invalid"></iframe>');
    const shadow = document.getElementById("shadow").attachShadow({ mode: "open" });
    shadow.innerHTML = "<h3>Shadow heading</h3>";
    const markup = Array.from({ length: 530 }, (_, index) => "<article>Paragraph " + index + "</article>").join("");
    document.body.insertAdjacentHTML("beforeend", markup);
  });
  await browser.page.locator("iframe").first().elementHandle().then(handle => handle.contentFrame())
    .then(frame => frame.getByRole("heading", { name: "Orders", exact: true }).waitFor());
  const first = await runtime.inspectDom();
  assert.equal(first.nodes.length, 500);
  assert.ok(first.nextCursor);
  const rows = [...first.nodes];
  for (let cursor = first.nextCursor; cursor;) {
    const page = await runtime.inspectDom(cursor);
    rows.push(...page.nodes);
    cursor = page.nextCursor;
  }
  assert.ok(rows.some(row => row.kind === "shadow-root"));
  assert.ok(rows.some(row => row.unavailable === "frame"));
  const frame = rows.find(row => row.tag === "iframe" && !row.unavailable);
  assert.ok(frame && rows.some(row => row.parentId === frame.id && row.tag === "html"));
  assert.ok(rows.some(row => row.text === "Shadow heading"));
  assert.ok(rows.some(row => row.text === "Paragraph 529"));
  assert.doesNotMatch(JSON.stringify(rows), /hidden-canary|value-canary/u);
  const cursor = (await runtime.inspectDom()).nextCursor;
  await browser.page.goto(fixture.origin + "/#/orders");
  await assert.rejects(runtime.inspectDom(cursor), { code: "REF_NOT_FOUND" });
  console.log("Studio browser smoke passed with highlight and paginated DOM in Chromium.");
} finally {
  await runtime.close();
  await fixture.close();
}
