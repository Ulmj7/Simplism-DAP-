import { copyFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const root = fileURLToPath(new URL("../apps/browser-extension/", import.meta.url));
const sdk = fileURLToPath(new URL("../apps/reference-web/dist/sdk/", import.meta.url));
const outDir = join(root, "dist");

await rm(outDir, { recursive: true, force: true });
await mkdir(outDir, { recursive: true });
for (const name of ["background", "content", "main", "popup", "receiver"]) {
  await build({
    configFile: false,
    root,
    build: {
      outDir,
      emptyOutDir: false,
      target: "chrome116",
      lib: { entry: join(root, "src", name + ".ts"), name: "SimplismExtension", formats: ["iife"], fileName: () => name + ".js" },
    },
    plugins: [{
      name: "extension-local-bundles",
      generateBundle(_options, bundle) {
        for (const chunk of Object.values(bundle)) {
          if (chunk.type !== "chunk" || chunk.imports.length || chunk.dynamicImports.length) this.error("Expected a self-contained extension script.");
          const publishedEntry = join(sdk, "index.js");
          if (name === "main" && !chunk.moduleIds.includes(publishedEntry)) this.error("The main-world loader must consume the packaged SDK entry.");
          if (chunk.moduleIds.some(id => !id.startsWith(root) && (name !== "main" || id !== publishedEntry))) {
            this.error("Unexpected extension input outside the local extension and packaged SDK entry.");
          }
        }
      },
    }],
  });
}
for (const asset of ["manifest.json", "popup.html", "popup.css"]) await copyFile(join(root, asset), join(outDir, asset));
await copyFile(join(sdk, "simplism.css"), join(outDir, "simplism.css"));
