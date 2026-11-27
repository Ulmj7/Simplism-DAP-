import { spawn } from "node:child_process";
import { loadEnvFile } from "node:process";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const children = new Set();
let stopping = false;

function terminateChildren() {
  for (const child of children) child.kill("SIGTERM");
}

function stop() {
  stopping = true;
  terminateChildren();
}

for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, stop);

function run(script, args, env) {
  const child = spawn(process.execPath, [script, ...args], { cwd: root, env, stdio: "inherit" });
  children.add(child);
  return new Promise((resolve, reject) => {
    child.once("error", error => { children.delete(child); reject(error); });
    child.once("exit", (code, signal) => {
      children.delete(child);
      if (code === 0 || stopping) resolve();
      else reject(new Error(`${script} exited with ${signal ?? code}`));
    });
  });
}

async function main() {
  try {
    loadEnvFile(new URL("../.env", import.meta.url));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }

  const env = {
    ...process.env,
    NODE_ENV: "development",
    DAP_ALLOW_DEV_AUTH: "1",
    DAP_HTTP_HOST: "127.0.0.1",
    DAP_ENABLED_ACTIONS: process.env.DAP_ENABLED_ACTIONS || "startWalkthrough",
  };
  if (Boolean(env.DAP_DATABASE_URL) !== Boolean(env.DAP_MIGRATE_DATABASE_URL)) {
    throw new Error("Set both DAP_DATABASE_URL and DAP_MIGRATE_DATABASE_URL, or use the default local PostgreSQL.");
  }
  if (!env.DAP_DATABASE_URL) {
    const port = env.DAP_POSTGRES_PORT || "54329";
    const appPassword = encodeURIComponent(env.DAP_APP_PASSWORD || "dap_app_local_only");
    const ownerPassword = encodeURIComponent(env.DAP_OWNER_PASSWORD || "dap_owner_local_only");
    env.DAP_DATABASE_URL = `postgresql://dap_app:${appPassword}@127.0.0.1:${port}/dap`;
    env.DAP_MIGRATE_DATABASE_URL = `postgresql://dap_owner:${ownerPassword}@127.0.0.1:${port}/dap`;
  }

  try {
    await run("db/migrate.mjs", [], env);
  } catch {
    throw new Error("PostgreSQL setup failed. To start the project's database, run docker compose up -d --wait postgres.");
  }
  if (stopping) return;

  await run("node_modules/typescript/bin/tsc", ["-b", "apps/reference-host"], env);
  if (stopping) return;

  const servers = [
    run("deploy/docker/start-local.mjs", [], env),
    run("deploy/docker/start-installation.mjs", [], env),
  ];
  try {
    await Promise.race(servers);
    if (!stopping) throw new Error("A development server stopped unexpectedly.");
  } finally {
    terminateChildren();
    await Promise.allSettled(servers);
  }
}

try {
  await main();
} catch (error) {
  if (!stopping) {
    console.error(error instanceof Error ? error.message : "Development startup failed.");
    process.exitCode = 1;
  }
} finally {
  for (const signal of ["SIGINT", "SIGTERM"]) process.removeListener(signal, stop);
}
