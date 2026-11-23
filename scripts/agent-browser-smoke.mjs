import assert from "node:assert/strict";
import { createAgentBrowserAdapter } from "../packages/browser-runtime/dist/index.js";

const url = process.argv[2];
assert.ok(url, "Pass the loopback Vite URL after running npm run typecheck.");
const browser = createAgentBrowserAdapter({
  labels: [{ role: "link", name: "Profile" }],
  routes: ["/", "/#/profile"],
  origins: [new URL(url).origin],
});
const started = performance.now();
try {
  await browser.start({ url });
  const snapshot = await browser.snapshot();
  const target = snapshot.elements.find(element => element.name === "Profile");
  assert.ok(target);
  await browser.highlight(target.ref, snapshot);
  assert.equal(await browser.getUrl(), new URL(url).href);
  assert.deepEqual(await browser.waitForChange({ timeoutMs: 600 }), { status: "timeout" });
  console.log(`Snapshot, current-ref highlight, and unchanged wait passed in ${Math.round(performance.now() - started)} ms.`);
} finally {
  await browser.close();
}
