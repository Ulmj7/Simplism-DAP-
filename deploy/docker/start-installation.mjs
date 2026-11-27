import { startInstallationServers } from "../../apps/reference-host/dist/platform/installation-servers.js";

const container = process.argv.includes("--container");
function port(raw, fallback) {
  if (container || !raw) return fallback;
  const value = Number(raw);
  if (!/^\d{1,5}$/u.test(raw) || value < 1 || value > 65535) throw new Error("Invalid Dashboard or widget port");
  return value;
}

const close = await startInstallationServers(process.env, {
  host: container ? "0.0.0.0" : "127.0.0.1",
  adminPort: port(process.env.DAP_WEB_PORT, 5173),
  widgetPort: port(process.env.DAP_WIDGET_PORT, 8797),
});
let stopping;
for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    stopping ??= close().catch(() => { process.exitCode = 1; });
  });
}
console.log("Dashboard and widget server are ready");
