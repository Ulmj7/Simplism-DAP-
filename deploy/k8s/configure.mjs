import { execFileSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { isIPv4 } from "node:net";

const nodeIp = process.argv[2];
if (!nodeIp || !isIPv4(nodeIp)) throw new Error("Pass the IPv4 address from minikube -p dap-lab ip.");

const credentialsFile = new URL("../../.env.k8s.local", import.meta.url);
let credentials;
try {
  credentials = JSON.parse(readFileSync(credentialsFile, "utf8"));
} catch (error) {
  if (error.code !== "ENOENT") throw error;
  credentials = {
    bootstrap: randomBytes(24).toString("hex"),
    owner: randomBytes(24).toString("hex"),
    app: randomBytes(24).toString("hex"),
    token: randomUUID(),
    tenant: randomUUID(),
  };
  writeFileSync(credentialsFile, JSON.stringify(credentials), { mode: 0o600, flag: "wx" });
}

function apply(kind, name, fields) {
  execFileSync("kubectl", ["--context", "dap-lab", "-n", "dap-lab", "apply", "--server-side", "-f", "-"], {
    input: JSON.stringify({ apiVersion: "v1", kind, metadata: { name }, ...fields }),
    stdio: ["pipe", "inherit", "inherit"],
  });
}

const secret = (name, values) => apply("Secret", name, {
  data: Object.fromEntries(Object.entries(values).map(([key, value]) => [key, Buffer.from(value).toString("base64")])),
});

secret("dap-postgres", {
  POSTGRES_PASSWORD: credentials.bootstrap,
  DAP_OWNER_PASSWORD: credentials.owner,
  DAP_APP_PASSWORD: credentials.app,
});
secret("dap-migrate", {
  DAP_MIGRATE_DATABASE_URL: `postgresql://dap_owner:${credentials.owner}@postgres:5432/dap`,
});
secret("dap-app", {
  DAP_DATABASE_URL: `postgresql://dap_app:${credentials.app}@postgres:5432/dap`,
  DAP_DEMO_SESSION_TOKEN: credentials.token,
  DEV_SESSIONS: JSON.stringify([{
    token: credentials.token,
    userId: "lab",
    tenantId: credentials.tenant,
    sessionId: "minikube-lab",
    validUntil: new Date(Date.now() + 24 * 60 * 60 * 1000).toISOString(),
    permissions: ["perm.guidance.start"],
  }]),
});
apply("ConfigMap", "dap-lab-web", { data: { DAP_HTTP_ALLOWED_HOST: `${nodeIp}:30878` } });
