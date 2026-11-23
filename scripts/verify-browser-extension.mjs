import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { runInContext } from "node:vm";
import { JSDOM } from "jsdom";

const artifact = new URL("../apps/browser-extension/dist/", import.meta.url);
const bytes = name => readFile(new URL(name, artifact));
const source = async name => (await bytes(name)).toString("utf8");
const expectedFiles = [
  "background.js", "content.js", "main.js", "manifest.json", "popup.css", "popup.html", "popup.js", "simplism.css",
];
assert.deepEqual((await readdir(artifact)).sort(), expectedFiles);
const manifest = JSON.parse(await source("manifest.json"));
assert.equal(manifest.manifest_version, 3);
assert.deepEqual(manifest.permissions, ["activeTab", "scripting", "storage"]);
assert.deepEqual(manifest.optional_host_permissions, ["http://*/*", "https://*/*"]);
assert.deepEqual(manifest.background, { service_worker: "background.js" });
assert.equal(manifest.action.default_popup, "popup.html");
for (const key of ["host_permissions", "content_scripts", "externally_connectable", "web_accessible_resources"]) assert.equal(manifest[key], undefined);
assert.deepEqual(await bytes("simplism.css"), await readFile(new URL("../apps/reference-web/dist/sdk/simplism.css", import.meta.url)));
const html = await source("popup.html");
const popup = new JSDOM(html);
assert.deepEqual([...popup.window.document.scripts].map(script => [script.getAttribute("src"), script.textContent]), [["popup.js", ""]]);
popup.window.close();

const site = "http://portal.example:5187";
const api = "http://guides.example:8795";
const binding = { origin: site, apiOrigin: api, applicationId: "app-000000000001", runtimeKey: "rk-public-runtime", enabled: true };
const guide = { id: "wt-000000000001", title: "Edit profile", description: "Update your name." };
const main = await source("main.js");
const bridgeKey = Symbol.for("simplism.browser-extension.v1");
const sdkOwner = Symbol.for("simplism.runtime.v1");

function loadMain() {
  const dom = new JSDOM("<!doctype html><body><button id='host'>Host</button>", { url: site + "/profile", runScripts: "outside-only" });
  const { window } = dom;
  window.TextDecoder = TextDecoder;
  const reads = [];
  window.fetch = async (url, options) => {
    reads.push({ url, options });
    return new Response(JSON.stringify({ guides: [guide] }), { headers: { "content-type": "application/json" } });
  };
  const run = () => runInContext(main, dom.getInternalVMContext(), { filename: "main.js" });
  return { window, reads, run };
}

{
  const { window, reads, run } = loadMain();
  run();
  const bridge = window[bridgeKey];
  assert.equal((await bridge("verify", site, binding)).status, "VERIFIED");
  assert.equal(window.document.querySelector("[data-simplism-runtime]"), null);
  assert.equal((await bridge("attach", site, binding)).status, "READY");
  run(); // repeat injection caused by another popup action retains the same page instance
  assert.equal(window[bridgeKey], bridge);
  assert.equal((await bridge("open", site, binding)).status, "READY");
  assert.equal(window.document.querySelectorAll("[data-simplism-runtime]").length, 1);
  assert.match(window.document.querySelector(".dap-launcher-panel")?.textContent ?? "", /Edit profile/u);
  assert.equal(window.document.querySelector(".dap-launcher-panel")?.hidden, false);
  assert.equal(window.document.querySelectorAll("link").length, 0);
  assert.equal((await bridge("refresh", site, binding)).status, "READY");
  assert.equal(reads.length, 4);
  for (const { url, options } of reads) {
    assert.equal(url, api + "/api/runtime/" + binding.runtimeKey + "/guides?applicationId=" + binding.applicationId);
    assert.equal(options.credentials, "omit");
    assert.equal(options.mode, "cors");
    assert.equal(options.redirect, "error");
  }
  assert.equal((await bridge("detach", site)).status, "DETACHED");
  assert.equal(window.document.querySelector("[data-simplism-runtime]"), null);
  assert.ok(window.document.querySelector("#host"));
  window.close();
}

{
  const { window, reads, run } = loadMain();
  const existing = Object.freeze({});
  Object.defineProperty(window, sdkOwner, { value: existing });
  run();
  assert.equal((await window[bridgeKey]("attach", site, binding)).status, "DIRECT_RUNTIME");
  await window[bridgeKey]("detach", site);
  assert.equal(window[sdkOwner], existing);
  assert.equal(reads.length, 0);
  window.close();
}

console.log("Chromium manifest, packaged SDK/CSS and main-world lifecycle verified.");
