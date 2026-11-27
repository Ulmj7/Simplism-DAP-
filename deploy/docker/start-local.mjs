import { randomBytes } from "node:crypto";

const env = process.env;
if (!env.DEV_SESSIONS && !env.DAP_DEMO_SESSION_TOKEN) {
  const token = randomBytes(32).toString("base64url");
  env.DAP_DEMO_SESSION_TOKEN = token;
  env.DEV_SESSIONS = JSON.stringify([{
    token,
    userId: "compose-demo",
    tenantId: "c578f78c-21f1-4f5f-81c2-1b17721650d1",
    sessionId: "compose-demo",
    validUntil: "9999-12-31T23:59:59Z",
    permissions: ["perm.guidance.start"],
  }]);
}

await import("../../apps/reference-host/dist/http/dev-server.js");
