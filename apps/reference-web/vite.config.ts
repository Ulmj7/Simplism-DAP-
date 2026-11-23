import { readFileSync } from "node:fs";
import { defaultClientConditions, defineConfig } from "vite";
import type { Plugin } from "vite";
import { composeEmbedStylesheet } from "./src/embed/stylesheet.ts";

// The embed ships TWO files: `dap-embed.js` and `dap-embed.css` (an external stylesheet, so no inline style is ever needed and a strict Content-Security-Policy works).
const embedStylesheet = (): Plugin => ({
  name: "dap-embed-stylesheet",
  generateBundle() {
    const source = (name: string) => readFileSync(new URL(`./src/${name}`, import.meta.url), "utf8");
    this.emitFile({ type: "asset", fileName: "dap-embed.css", source: composeEmbedStylesheet(source("styles/tokens.css"), source("styles/overlay.css"), source("embed/embed.css")) });
  },
});

// root = this app. `@dap/source` makes the workspace package resolve to its TypeScript source, the same condition tsconfig.base.json and Vitest use.
export default defineConfig(({ mode }) => ({
  root: import.meta.dirname,
  resolve: { conditions: ["@dap/source", ...defaultClientConditions] },
  // C01: the AI Help calls stay same-origin; in development Vite forwards `/api` to the reference host's default address (no CORS involved).
  server: { host: "127.0.0.1", port: 5173, strictPort: true, proxy: { "/api": { target: `http://127.0.0.1:${process.env.DAP_HTTP_PORT || "8787"}` } } },
  plugins: mode === "embed" ? [embedStylesheet()] : [],
  build: mode === "embed" ? {
    outDir: "dist-embed", emptyOutDir: true,
    lib: { entry: new URL("./src/embed/embed.ts", import.meta.url).pathname, name: "DapRuntime", formats: ["iife"], fileName: () => "dap-embed.js" },
  } : { outDir: "dist/web", emptyOutDir: true },
}));
