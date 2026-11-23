import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { once } from "node:events";

export async function startConsumer({ port, routing, apiOrigin }) {
  const name = routing === "history" ? "History portal" : "Hash portal";
  const prefix = routing === "history" ? "history" : "hash";
  const page = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${name}</title><link rel="stylesheet" href="/portal.css">
<script src="/csp-log.js"></script><script type="module" src="/boot.js"></script></head>
<body data-routing="${routing}"><h1>${name}</h1><nav><a data-ai-id="${prefix}.profile" href="${routing === "history" ? "/profile" : "#/profile"}">Profile</a></nav>
<main hidden><label for="label">Display name</label><input id="label" data-ai-id="${prefix}.label" type="text" autocomplete="off">
<button id="save" type="button" data-ai-id="${prefix}.save">Save</button><p id="saved" role="status" data-ai-id="${prefix}.saved"></p></main>
<footer><button id="stop-guide">Stop from host</button><button id="restart-guide">Restart from host</button><button id="destroy-runtime">Destroy SDK</button></footer>
</body></html>`;
  const sdk = new URL("../../../apps/reference-web/dist/sdk/", import.meta.url);
  const assets = new Map([
    ["/sdk/index.js", ["text/javascript", await readFile(new URL("index.js", sdk))]],
    ["/sdk/simplism.css", ["text/css", await readFile(new URL("simplism.css", sdk))]],
    ["/boot.js", ["text/javascript", await readFile(new URL("boot.js", import.meta.url))]],
    ["/portal.css", ["text/css", "body { font: 1rem system-ui; margin: 1rem; } footer { margin-top: 2rem; } input { max-width: 100%; }"]],
    ["/csp-log.js", ["text/javascript", "window.cspViolations = []; addEventListener('securitypolicyviolation', event => window.cspViolations.push(event.violatedDirective));"]],
  ]);
  let options = null;
  const server = createServer((req, res) => {
    if (req.method !== "GET") { res.writeHead(405).end(); return; }
    const path = new URL(req.url, "http://127.0.0.1").pathname;
    const asset = path === "/simplism-config.json" ? ["application/json", JSON.stringify(options)] : assets.get(path);
    const headers = {
      "cache-control": "no-store",
      "content-security-policy": `default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self' ${apiOrigin}; base-uri 'none'; form-action 'none'`,
    };
    if (asset) { res.writeHead(200, { ...headers, "content-type": asset[0] }).end(asset[1]); return; }
    if (path === "/" || path === "/profile") { res.writeHead(200, { ...headers, "content-type": "text/html; charset=utf-8" }).end(page); return; }
    res.writeHead(404).end();
  });
  server.listen(port, "127.0.0.1");
  await once(server, "listening");
  return {
    origin: `http://127.0.0.1:${port}`, name, prefix, routing,
    configure(applicationId, runtimeKey) { options = { applicationId, runtimeKey, apiOrigin, stylesheetUrl: "/sdk/simplism.css" }; },
    close() { return new Promise((resolve, reject) => server.close(error => error ? reject(error) : resolve())); },
  };
}
