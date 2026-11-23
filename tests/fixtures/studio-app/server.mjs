// Second-application fixture (Studio V1A, D9): a tiny, dependency-free, hash-routed page served from loopback.
// It stands in for "application B" so tests and the real-browser probe can prove that one application's
// navigation policy is not another's. It is test infrastructure, never product code, and holds no secrets.
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";

const loopbackHosts = new Set(["127.0.0.1", "::1", "localhost"]);
const maxDelayMs = 30_000;

function page(config, dapOrigin, extras) {
  // `<` is escaped so no configured string can close the script element.
  const json = JSON.stringify(config).replaceAll("<", "\\u003c");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Fixture application ${config.name}</title>
</head>
<body>
<h1>Fixture application ${config.name}</h1>
<main data-route="home">
  <h2>Home</h2>
  <nav aria-label="Primary">
    <a href="#/orders" data-ai-id="nav.orders">Orders</a>
    <a href="#/home">Admin</a>
  </nav>
</main>
<main data-route="orders" hidden>
  <h2>Orders</h2>
  <label for="order-note">Order note</label>
  <input id="order-note" type="text" data-ai-id="orders.note">
  <button type="button" data-ai-id="orders.submit">Submit order</button>
  <p id="order-status" role="status"></p>${extras ? `
  <button type="button" data-ai-id="orders.nameless"></button>
  <button type="button">Cancel</button>
  <label>Password <input type="password" data-ai-id="orders.secret"></label>
  <button type="button" data-ai-id="orders.private" data-ai-private>Private action</button>
  <button type="button" data-ai-id="admin.reset">Reset</button>` : ""}
</main>
<main data-route="dense" hidden>
  <h2>Many approved links</h2>
</main>
<main data-route="leave" hidden>
  <h2>Leaving</h2>
  <p>This page sends the browser to another address after a short delay.</p>
</main>
<script type="application/json" id="fixture-config">${json}</script>
<script>
(function () {
  var config = JSON.parse(document.getElementById("fixture-config").textContent);
  var timer;
  var dense = document.querySelector('[data-route="dense"]');
  var ordersLink = document.querySelector('[data-ai-id="nav.orders"]');
${dapOrigin ? "  var denseLinks = document.createDocumentFragment();\n" : ""}  for (var repeat = 0; repeat < 70; repeat += 1) ${dapOrigin ? "denseLinks" : "dense"}.appendChild(ordersLink.cloneNode(true));
  function show(kind) {
    var sections = document.querySelectorAll("[data-route]");
    for (var index = 0; index < sections.length; index += 1) sections[index].hidden = sections[index].dataset.route !== kind;
  }
  function leave(target) {
    if (target) timer = setTimeout(function () { location.assign(target + "/#/home"); }, config.redirectDelayMs);
  }
  function route() {
    clearTimeout(timer);
    var name = location.hash.replace(/^#\\//, "");${dapOrigin ? `
    if (name === "dense") dense.appendChild(denseLinks);
    else while (dense.children.length > 1) denseLinks.appendChild(dense.lastElementChild);` : ""}
    if (name === "orders") show("orders");
    else if (name === "dense") show("dense");
    else if (name === "leave-origin") { show("leave"); leave(config.leaveOrigin); }
    else if (name === "leave-host") { show("leave"); leave(config.leaveHost); }
    else show("home");
  }
  document.querySelector('[data-ai-id="orders.submit"]').addEventListener("click", function () {
    document.getElementById("order-status").textContent = "Order submitted.";
  });
  addEventListener("hashchange", route);
  route();
})();
</script>${dapOrigin ? `
<script src="/dap-embed.js" data-dap-origin="${dapOrigin.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;")}"></script>` : ""}
</body>
</html>
`;
}

// The same server reached through the other loopback spelling is a different hostname to a browser.
function aliasOrigin(hostHeader) {
  const match = /^(127\.0\.0\.1|localhost)(:\d{1,5})?$/u.exec(hostHeader ?? "");
  return match ? `http://${match[1] === "localhost" ? "127.0.0.1" : "localhost"}${match[2] ?? ""}` : null;
}

function validOrigin(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && url.origin === value;
  } catch { return false; }
}

/**
 * @param {object} [options]
 * @param {string} [options.host] a loopback address; the server never binds anywhere else
 * @param {number} [options.port] 0 picks an ephemeral port
 * @param {string} [options.name] shown in the page heading to tell two instances apart
 * @param {string} [options.leaveOrigin] normalized origin that `/#/leave-origin` redirects to
 * @param {number} [options.redirectDelayMs] delay before a leave route redirects (default 800)
 * @param {string} [options.embedScriptPath] local built embed, read once at fixture startup
 * @param {string} [options.dapOrigin] exact Studio origin for the window handshake
 * @param {boolean} [options.extras] include controls for managed-registration demonstrations
 * @returns {Promise<{ origin: string, port: number, requestHosts: () => string[], close: () => Promise<void> }>}
 */
export async function startFixtureApp({ host = "127.0.0.1", port = 0, name = "B", leaveOrigin, redirectDelayMs = 800, embedScriptPath, dapOrigin, extras = false } = {}) {
  if (!loopbackHosts.has(host)) throw new TypeError("The fixture application only binds to loopback.");
  if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new TypeError("The fixture port must be 0 to 65535.");
  if (typeof name !== "string" || !/^[A-Za-z0-9 _-]{1,40}$/u.test(name)) throw new TypeError("The fixture name must be 1 to 40 plain characters.");
  if (leaveOrigin !== undefined && !validOrigin(leaveOrigin)) throw new TypeError("leaveOrigin must be a normalized http or https origin.");
  if (!Number.isInteger(redirectDelayMs) || redirectDelayMs < 0 || redirectDelayMs > maxDelayMs) throw new TypeError("redirectDelayMs must be 0 to 30000.");

  if ((embedScriptPath === undefined) !== (dapOrigin === undefined) || (dapOrigin !== undefined && !validOrigin(dapOrigin))) {
    throw new TypeError("Set both embedScriptPath and a normalized http or https dapOrigin.");
  }
  const embed = embedScriptPath === undefined ? undefined : await readFile(embedScriptPath);
  const seen = [];
  const server = createServer((request, response) => {
    seen.push(String(request.headers.host ?? ""));
    const headers = { "cache-control": "no-store", "x-content-type-options": "nosniff", "referrer-policy": "no-referrer" };
    const path = (request.url ?? "").split("?", 1)[0];
    if (path === "/dap-embed.js" && embed !== undefined) {
      if (request.method === "GET") response.writeHead(200, { ...headers, "content-type": "text/javascript; charset=utf-8" }).end(embed);
      else response.writeHead(405, { ...headers, allow: "GET" }).end();
    } else if (request.method !== "GET" && request.method !== "HEAD") {
      response.writeHead(405, { ...headers, allow: "GET, HEAD" }).end();
    } else if (path === "/" || path === "/index.html") {
      const body = page({ name, leaveOrigin: leaveOrigin ?? null, leaveHost: aliasOrigin(request.headers.host), redirectDelayMs }, dapOrigin, extras);
      response.writeHead(200, { ...headers, "content-type": "text/html; charset=utf-8", "content-length": Buffer.byteLength(body) });
      response.end(request.method === "HEAD" ? undefined : body);
    } else if (path === "/favicon.ico") {
      response.writeHead(204, headers).end();
    } else {
      response.writeHead(404, { ...headers, "content-type": "text/plain; charset=utf-8" }).end("Not found");
    }
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
    requestHosts: () => [...seen],
    // Idempotent: callers close from `finally` blocks and signal handlers.
    close: () => closing ??= new Promise((resolve, reject) => {
      server.close(error => error ? reject(error) : resolve(undefined));
      server.closeAllConnections();
    }),
  };
}
