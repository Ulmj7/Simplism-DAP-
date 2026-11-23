import { defaultClientConditions, defineConfig } from "vite";

// root = this app. `@dap/source` makes the workspace package resolve to its TypeScript source, the same condition tsconfig.base.json and Vitest use.
export default defineConfig({
  root: import.meta.dirname,
  resolve: { conditions: ["@dap/source", ...defaultClientConditions] },
  // C01: the AI Help calls stay same-origin; in development Vite forwards `/api` to the reference host's default address (no CORS involved).
  server: { host: "127.0.0.1", port: 5173, strictPort: true, proxy: { "/api": { target: `http://127.0.0.1:${process.env.DAP_HTTP_PORT || "8787"}` } } },
  build: { outDir: "dist/web", emptyOutDir: true },
});
