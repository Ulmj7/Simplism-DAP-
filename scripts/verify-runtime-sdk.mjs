import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";

const artifact = new URL("../apps/reference-web/dist/sdk/", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("package.json", artifact), "utf8"));
assert.equal(manifest.name, "@simplism/sdk");
assert.deepEqual(Object.keys(manifest.exports).sort(), [".", "./simplism.css"]);
assert.deepEqual((await readdir(artifact)).sort(), ["index.d.ts", "index.js", "package.json", "simplism.css"]);
assert.equal(manifest.exports["."].import, "./index.js");
const sdk = await import("../apps/reference-web/dist/sdk/index.js");
assert.deepEqual(Object.keys(sdk), ["createSimplism"]);
assert.deepEqual(sdk.createSimplism({}), { ok: false, code: "INVALID_CONFIGURATION" });
const types = await readFile(new URL(manifest.exports["."].types, artifact), "utf8");
assert.match(types, /export declare function createSimplism/u);
assert.doesNotMatch(types, /(?:^|\n)import\s/u);
assert.match(await readFile(new URL(manifest.exports["./simplism.css"], artifact), "utf8"), /\.dap-sdk-controls/u);
console.log("Runtime SDK package, public exports and declarations verified.");
