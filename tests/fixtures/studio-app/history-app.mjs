// History-routed fixture application (Studio completion): "Profile". Pages `/`, `/profile` and `/settings` are real PATHS, not hashes; the server answers EVERY path with the same application
// shell (the history fallback of a single-page application); navigation inside the page uses `history.pushState` with no reload (like a real SPA router, which raises no popstate event of its own)
// and a direct visit of any path works too. `?variant=` (or `POST /__variant`) selects what the page looks like; routing never looks at the query.
//
//   variant "default"  profile.save is a <button data-ai-id="profile.save">
//   variant "moved"    the same control is re-marked `profile.submit` and became a LINK: a UI change that breaks an existing target (fixture D of the repair story)
//
// It is test infrastructure, never product code, holds no secrets, serves only loopback and needs no build step: the page script and style are EXTERNAL files, so a strict Content-Security-Policy
// (`csp: true`) works. Embedding (all optional): `embedScriptPath` + `dapOrigin` serve the built embed and its stylesheet from the application itself and add the window-handshake script tag;
// `dapOrigin` + `dapKey` add the STANDALONE script tag that loads `dap-embed.js` from the Studio/runtime origin.
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";

const loopbackHosts = new Set(["127.0.0.1", "::1", "localhost"]);
const variants = new Set(["default", "moved"]);
const escape = value => value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;");
const validOrigin = value => {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && url.origin === value;
  } catch { return false; }
};

function shell({ name, variant, embedTag }) {
  const save = variant === "moved"
    ? '<a href="/profile" data-action="save" data-ai-id="profile.submit">Save</a>'
    : '<button type="button" data-action="save" data-ai-id="profile.save">Save</button>';
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escape(name)}</title>
<link rel="stylesheet" href="/app.css">
</head>
<body data-variant="${variant}">
<h1>${escape(name)}</h1>
<nav aria-label="Primary">
  <a href="/" data-nav>Home</a>
  <a href="/profile" data-nav data-ai-id="nav.profile">Profile</a>
  <a href="/settings" data-nav data-ai-id="nav.settings">Settings</a>
</nav>
<main data-page="/">
  <h2>Home</h2>
  <p>Welcome to the profile application.</p>
</main>
<main data-page="/profile" hidden>
  <h2>Profile</h2>
  <label for="display-name">Display name</label>
  <input id="display-name" type="text" autocomplete="off" data-ai-id="profile.displayName">
  ${save}
  <p id="saved-status" role="status" data-ai-id="profile.savedStatus"></p>
</main>
<main data-page="/settings" hidden>
  <h2>Settings</h2>
  <button type="button" id="advanced-toggle" aria-expanded="false" aria-controls="advanced" data-ai-id="settings.advancedToggle">Advanced</button>
  <div id="advanced" hidden><p>Advanced options.</p></div>
</main>
<main data-page="*" hidden>
  <h2>Page not found</h2>
</main>
<script src="/app.js"></script>${embedTag}
</body>
</html>
`;
}

const appScript = `(function () {
  // Diagnostics for the Content-Security-Policy proofs: this script is loaded before any embed, so every later violation of the page's policy is recorded here (names only).
  window.cspViolations = [];
  document.addEventListener("securitypolicyviolation", function (event) { window.cspViolations.push(event.violatedDirective + " " + event.blockedURI); });
  var pages = ["/", "/profile", "/settings"];
  var titles = { "/": "Home", "/profile": "Profile", "/settings": "Settings" };
  function current() {
    var path = location.pathname;
    return path.length > 1 && path.charAt(path.length - 1) === "/" ? path.slice(0, -1) : path;
  }
  function render() {
    var path = current();
    var key = pages.indexOf(path) >= 0 ? path : "*";
    var sections = document.querySelectorAll("[data-page]");
    for (var i = 0; i < sections.length; i += 1) sections[i].hidden = sections[i].getAttribute("data-page") !== key;
    document.title = (titles[key] || "Page not found") + " - " + document.querySelector("h1").textContent;
  }
  // SPA navigation: pushState and render, no reload, NO popstate event (as a real router does).
  document.addEventListener("click", function (event) {
    var link = event.target.closest ? event.target.closest("a[data-nav]") : null;
    if (!link || event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    var url = new URL(link.href, location.href);
    if (url.origin !== location.origin) return;
    event.preventDefault();
    history.pushState(null, "", url.pathname);
    render();
  });
  addEventListener("popstate", render);
  var save = document.querySelector('[data-action="save"]');
  save.addEventListener("click", function (event) {
    event.preventDefault();
    document.getElementById("saved-status").textContent = "Saved";
  });
  document.getElementById("display-name").addEventListener("input", function () {
    document.getElementById("saved-status").textContent = "";
  });
  var toggle = document.getElementById("advanced-toggle");
  toggle.addEventListener("click", function () {
    var open = toggle.getAttribute("aria-expanded") !== "true";
    toggle.setAttribute("aria-expanded", open ? "true" : "false");
    document.getElementById("advanced").hidden = !open;
  });
  render();
})();
`;
const appStyle = `[hidden] { display: none !important; }
body { font-family: system-ui, Arial, sans-serif; margin: 16px; line-height: 1.5; }
nav a { margin-right: 12px; }
label, input, button { font: inherit; }
input { display: block; margin: 4px 0 12px; max-width: 100%; box-sizing: border-box; }
`;

/**
 * @param {object} [options]
 * @param {string} [options.host] a loopback address; the server never binds anywhere else
 * @param {number} [options.port] 0 picks an ephemeral port
 * @param {string} [options.name] heading of the application (1 to 40 plain characters)
 * @param {"default"|"moved"} [options.variant] the variant served unless a request says otherwise
 * @param {string} [options.embedScriptPath] the built `dap-embed.js`: served at `/dap-embed.js`, with `dap-embed.css` read from the same directory (window handshake, needs `dapOrigin`)
 * @param {string} [options.dapOrigin] exact origin of Studio / the runtime API
 * @param {string} [options.dapKey] opaque runtime key (`rk-…`, at most 80 URL-safe characters): adds the STANDALONE script tag (the script is loaded from `dapOrigin`)
 * @param {boolean} [options.csp] send a strict Content-Security-Policy (see policy())
 * @returns {Promise<{ origin: string, port: number, variant: () => string, setVariant: (value: string) => void, requestHosts: () => string[], requestPaths: () => string[], policy: () => string | null, close: () => Promise<void> }>}
 */
export async function startHistoryApp({ host = "127.0.0.1", port = 0, name = "Profile", variant = "default", embedScriptPath, dapOrigin, dapKey, csp = false } = {}) {
  if (!loopbackHosts.has(host)) throw new TypeError("The fixture application only binds to loopback.");
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new TypeError("The fixture port must be 0 to 65535.");
  if (typeof name !== "string" || !/^[A-Za-z0-9 _-]{1,40}$/u.test(name)) throw new TypeError("The fixture name must be 1 to 40 plain characters.");
  if (!variants.has(variant)) throw new TypeError("The variant must be default or moved.");
  if (dapOrigin !== undefined && !validOrigin(dapOrigin)) throw new TypeError("dapOrigin must be a normalized http or https origin.");
  if (dapKey !== undefined && !/^rk-[A-Za-z0-9_-]{1,77}$/u.test(dapKey)) throw new TypeError("dapKey must be an opaque runtime key: rk- and up to 77 URL-safe characters.");
  if ((embedScriptPath !== undefined || dapKey !== undefined) && dapOrigin === undefined) throw new TypeError("embedScriptPath and dapKey need dapOrigin.");
  if (embedScriptPath !== undefined && dapKey !== undefined) throw new TypeError("Use either embedScriptPath (window handshake) or dapKey (standalone), not both.");
  const embed = embedScriptPath === undefined ? undefined : await readFile(embedScriptPath);
  const embedCss = embedScriptPath === undefined ? undefined : await readFile(new URL("dap-embed.css", new URL(`file://${embedScriptPath}`))).catch(() => undefined);
  const embedTag = embedScriptPath !== undefined ? `\n<script src="/dap-embed.js" data-dap-origin="${escape(dapOrigin)}"></script>`
    : dapKey !== undefined ? `\n<script src="${escape(dapOrigin)}/dap-embed.js" data-dap-key="${dapKey}"></script>` : "";
  // The strict policy of the brief: nothing inline, scripts and styles only from this origin and the Studio/runtime origin, fetches only to the runtime origin.
  const policy = () => (csp
    ? `default-src 'none'; script-src 'self'${dapOrigin ? ` ${dapOrigin}` : ""}; style-src 'self'${dapOrigin ? ` ${dapOrigin}` : ""}; connect-src ${dapOrigin ?? "'none'"}; img-src 'self'; base-uri 'none'; form-action 'none'`
    : null);
  let current = variant;
  const hosts = [];
  const paths = [];
  const server = createServer((request, response) => {
    hosts.push(String(request.headers.host ?? ""));
    const url = new URL(request.url ?? "/", "http://fixture.invalid");
    paths.push(url.pathname);
    const headers = { "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" };
    const send = (status, type, body, extra = {}) => {
      response.writeHead(status, { ...headers, "content-type": type, "content-length": Buffer.byteLength(body), ...extra });
      response.end(request.method === "HEAD" ? undefined : body);
    };
    if (url.pathname === "/__variant") {
      if (request.method === "GET") { send(200, "application/json", JSON.stringify({ variant: current })); return; }
      if (request.method !== "POST") { response.writeHead(405, { ...headers, allow: "GET, POST" }).end(); return; }
      let body = "";
      request.setEncoding("utf8");
      request.on("data", chunk => { body += chunk; if (body.length > 256) request.destroy(); });
      request.on("end", () => {
        let next;
        try { next = JSON.parse(body).variant; } catch { next = undefined; }
        if (!variants.has(next)) { send(400, "application/json", JSON.stringify({ error: "variant must be default or moved" })); return; }
        current = next;
        send(200, "application/json", JSON.stringify({ variant: current }));
      });
      return;
    }
    if (request.method !== "GET" && request.method !== "HEAD") { response.writeHead(405, { ...headers, allow: "GET, HEAD" }).end(); return; }
    if (url.pathname === "/app.js") { send(200, "text/javascript; charset=utf-8", appScript); return; }
    if (url.pathname === "/app.css") { send(200, "text/css; charset=utf-8", appStyle); return; }
    if (url.pathname === "/dap-embed.js" && embed !== undefined) { response.writeHead(200, { ...headers, "content-type": "text/javascript; charset=utf-8", "content-length": embed.length }).end(request.method === "HEAD" ? undefined : embed); return; }
    if (url.pathname === "/dap-embed.css" && embedCss !== undefined) { response.writeHead(200, { ...headers, "content-type": "text/css; charset=utf-8", "content-length": embedCss.length }).end(request.method === "HEAD" ? undefined : embedCss); return; }
    if (url.pathname === "/favicon.ico") { response.writeHead(204, headers).end(); return; }
    // The history fallback: ANY other path is the application shell (the query only picks the variant).
    const asked = url.searchParams.get("variant");
    const shown = variants.has(asked) ? asked : current;
    send(200, "text/html; charset=utf-8", shell({ name, variant: shown, embedTag }), policy() ? { "content-security-policy": policy() } : {});
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen({ host, port }, () => { server.off("error", reject); resolve(undefined); });
  });
  const address = server.address();
  if (address === null || typeof address === "string") throw new Error("The fixture application did not bind a TCP port.");
  let closing;
  return {
    origin: `http://${host.includes(":") ? `[${host}]` : host}:${address.port}`,
    port: address.port,
    variant: () => current,
    setVariant(value) { if (!variants.has(value)) throw new TypeError("The variant must be default or moved."); current = value; },
    requestHosts: () => [...hosts],
    requestPaths: () => [...paths],
    policy,
    close: () => closing ??= new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve(undefined));
      server.closeAllConnections();
    }),
  };
}
