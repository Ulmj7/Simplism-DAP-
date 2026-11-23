import { readFileSync } from "node:fs";
import { defaultClientConditions, defineConfig } from "vite";
import type { Plugin } from "vite";
import { composeEmbedStylesheet } from "./src/embed/stylesheet.ts";

// The embed ships TWO files: `dap-embed.js` and `dap-embed.css` (an external stylesheet, so no inline style is ever needed and a strict Content-Security-Policy works).
const embedAssets = (sdk: boolean): Plugin => ({
  name: "dap-embed-stylesheet",
  generateBundle(_options, bundle) {
    if (sdk) for (const item of Object.values(bundle)) {
      if (item.type !== "chunk") continue;
      const external = item.imports.length > 0 || item.dynamicImports.length > 0;
      const server = item.moduleIds.some(id => /\/(?:reference-host|browser-runtime|security|actions|testkit|ai)\//u.test(id));
      const studio = item.moduleIds.some(id => id.includes("/src/admin/") && !id.endsWith("/admin/wire.ts"));
      if (external || server || studio) this.error("The Runtime SDK must be a self-contained browser bundle.");
    }
    const source = (name: string) => readFileSync(new URL(`./src/${name}`, import.meta.url), "utf8");
    this.emitFile({ type: "asset", fileName: sdk ? "simplism.css" : "dap-embed.css", source: composeEmbedStylesheet(source("styles/tokens.css"), source("styles/overlay.css"), source("embed/embed.css")) });
    if (sdk) {
      this.emitFile({ type: "asset", fileName: "index.d.ts", source: readFileSync(new URL("./dist/embed/sdk.d.ts", import.meta.url), "utf8").replace(/^\/\/# sourceMappingURL=.*$/mu, "") });
      this.emitFile({ type: "asset", fileName: "package.json", source: JSON.stringify({
        name: "@simplism/sdk", version: "1.0.0", type: "module", sideEffects: ["./simplism.css"],
        exports: { ".": { types: "./index.d.ts", import: "./index.js" }, "./simplism.css": "./simplism.css" },
        files: ["index.js", "index.d.ts", "simplism.css"],
      }, null, 2) + "\n" });
    }
  },
});

// root = this app. `@dap/source` makes the workspace package resolve to its TypeScript source, the same condition tsconfig.base.json and Vitest use.
export default defineConfig(({ mode }) => ({
  root: import.meta.dirname,
  resolve: { conditions: ["@dap/source", ...defaultClientConditions] },
  // C01: the AI Help calls stay same-origin; in development Vite forwards `/api` to the reference host's default address (no CORS involved).
  server: { host: "127.0.0.1", port: 5173, strictPort: true, proxy: { "/api": { target: `http://127.0.0.1:${process.env.DAP_HTTP_PORT || "8787"}` } } },
  plugins: mode === "embed" || mode === "sdk" ? [embedAssets(mode === "sdk")] : [],
  build: mode === "embed" ? {
    outDir: "dist-embed", emptyOutDir: true,
    lib: { entry: new URL("./src/embed/embed.ts", import.meta.url).pathname, name: "DapRuntime", formats: ["iife"], fileName: () => "dap-embed.js" },
  } : mode === "sdk" ? {
    outDir: "dist/sdk", emptyOutDir: true,
    lib: { entry: new URL("./src/embed/sdk.ts", import.meta.url).pathname, formats: ["es"], fileName: () => "index.js" },
  } : { outDir: "dist/web", emptyOutDir: true },
}));
