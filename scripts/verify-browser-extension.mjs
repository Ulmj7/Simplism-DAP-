import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { runInContext } from "node:vm";
import { JSDOM } from "jsdom";

const artifact = new URL("../apps/browser-extension/dist/", import.meta.url);
const bytes = name => readFile(new URL(name, artifact));
const source = async name => (await bytes(name)).toString("utf8");
const expectedFiles = [
  "background.js", "content.js", "main.js", "manifest.json", "popup.css", "popup.html", "popup.js", "receiver.js", "simplism.css",
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
const receiver = await source("receiver.js");
const popupScript = await source("popup.js");
const bridgeKey = Symbol.for("simplism.browser-extension.v1");
const sdkOwner = Symbol.for("simplism.runtime.v1");
const statusRequest = "simplism-extension-status-v1";
const guideBundle = {
  application: { id: binding.applicationId, name: "Portal", origin: site },
  registry: { routes: ["profile"], routing: "history", pages: { "/profile": "profile" },
    postconditionNames: ["route.profile"], elements: [
      { id: "profile.save", route: "profile", role: "button", label: "Save", description: "Save profile.", operations: ["highlight", "click"], privacy: "public" },
    ] },
  definition: { ...guide, start: "save", steps: [
    { id: "save", kind: "guide", wait: "click", target: "profile.save", text: "Click Save.", verify: "route.profile", next: "done" },
    { id: "done", kind: "complete", text: "Saved." },
  ] },
};

function loadMain() {
  const dom = new JSDOM("<!doctype html><body><button id='host' data-ai-id='profile.save'>Save</button>", { url: site + "/profile", runScripts: "outside-only" });
  const { window } = dom;
  window.TextDecoder = TextDecoder;
  const reads = [];
  let catalog = [guide];
  let responseCode = 200;
  window.fetch = async (url, options) => {
    reads.push({ url, options });
    return new Response(JSON.stringify(url.includes(`/${guide.id}?`) ? guideBundle : { guides: catalog }),
      { status: responseCode, headers: { "content-type": "application/json" } });
  };
  let listener;
  window.chrome = { runtime: { id: "test-extension", onMessage: { addListener(fn) { listener = fn; } } } };
  runInContext(receiver, dom.getInternalVMContext(), { filename: "receiver.js" });
  const status = () => {
    let result;
    listener(statusRequest, { id: "test-extension" }, value => { result = value; });
    return result === null ? null : JSON.parse(JSON.stringify(result));
  };
  const run = () => runInContext(main, dom.getInternalVMContext(), { filename: "main.js" });
  return { window, reads, run, status, setCatalog(value) { catalog = value; }, setCode(value) { responseCode = value; } };
}

{
  const { window, reads, run, status, setCatalog, setCode } = loadMain();
  assert.equal(status(), null);
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
  assert.deepEqual(status(), { state: "READY", count: 1 });
  assert.equal(reads.length, 4);
  assert.equal((await window[sdkOwner].instance.startGuide(guide.id)).ok, true);
  assert.deepEqual(status(), { state: "RUNNING", count: 1 });
  assert.equal(reads.length, 5);
  window.history.pushState(null, "", "/other");
  window.document.querySelector("#host").click();
  assert.deepEqual(status(), { state: "ERROR", count: 1 });
  window.history.pushState(null, "", "/profile");
  assert.equal((await bridge("detach", site)).status, "DETACHED");
  assert.equal(window.document.querySelector("[data-simplism-runtime]"), null);
  setCatalog([]);
  assert.equal((await bridge("attach", site, binding)).status, "EMPTY");
  assert.deepEqual(status(), { state: "EMPTY", count: 0 });
  setCode(404);
  assert.equal((await bridge("refresh", site, binding)).status, "APPLICATION_UNAVAILABLE");
  assert.deepEqual(status(), { state: "ERROR", count: null });
  assert.ok(window.document.querySelector("#host"));
  window.close();
}

{
  const { window, reads, run, status } = loadMain();
  const existing = Object.freeze({});
  Object.defineProperty(window, sdkOwner, { value: existing, configurable: true });
  run();
  assert.equal((await window[bridgeKey]("attach", site, binding)).status, "DIRECT_RUNTIME");
  assert.deepEqual(status(), { state: "DIRECT_RUNTIME", count: null });
  await window[bridgeKey]("detach", site);
  assert.equal(window[sdkOwner], existing);
  delete window[sdkOwner];
  assert.deepEqual(status(), { state: "PENDING", count: null });
  assert.equal(reads.length, 0);
  window.close();
}

for (const [runtime, expected] of [
  [{ state: "READY", count: 1 }, "1 published guide available."],
  [{ state: "EMPTY", count: 0 }, "No published guides are available for this site."],
  [{ state: "RUNNING", count: 3 }, "A guide is running. 3 published guides available."],
  [{ state: "ERROR", count: null }, "Simplism encountered an error."],
  [{ state: "DIRECT_RUNTIME", count: null }, "This page already has a Simplism runtime."],
  [{ state: "READY", count: 1, message: "<span>unexpected text</span>" }, "Simplism is enabled. Open Simplism to check for published guides."],
]) {
  const dom = new JSDOM(html, { runScripts: "outside-only" });
  const { window } = dom;
  const requests = [];
  window.chrome = { runtime: { async sendMessage(message) {
    requests.push(message.action);
    return { status: "READY", page: { tabId: 1, documentId: "document", origin: site }, binding, access: true, runtime };
  } } };
  runInContext(popupScript, dom.getInternalVMContext(), { filename: "popup.js" });
  await new Promise(resolve => setImmediate(resolve));
  assert.deepEqual(requests, ["inspect"]);
  assert.equal(window.document.querySelector("#status").textContent, expected);
  assert.equal(window.document.querySelector("#open").textContent, "Open Simplism");
  assert.equal(window.document.querySelector("#toggle").textContent, "Disable on this site");
  assert.equal(window.document.querySelector("#refresh").textContent, "Refresh");
  window.close();
}

console.log("Chromium manifest, packaged SDK/CSS and main-world lifecycle verified.");
