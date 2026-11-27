import { createHash, randomBytes } from "node:crypto";
import { readFile } from "node:fs/promises";
import { fastify } from "fastify";
import { createAuthoringPool } from "../authoring/pool.js";
import { createPostgresWalkthroughStore } from "../authoring/postgres-store.js";
import { composeReferenceHost } from "../compose.js";
import type { Environment } from "../config.js";
import { createPostgresApplicationStore } from "../studio/postgres-application-store.js";
import { createPostgresTargetStore } from "../studio/postgres-target-store.js";
import { createRegistryCatalog } from "../studio/registries.js";
import { createRegistryResolver } from "../studio/registry-resolver.js";
import { createUiMapStore } from "../studio/ui-map-store.js";
import { createUiGuideOperations } from "../studio/ui-guide-operations.js";
import { platformExtension } from "./capabilities.js";
import { createPlatformIdentity, PLATFORM_SCOPE } from "./identity.js";
import { registerWidget } from "./public-api.js";
import { registerPlatformRoutes } from "./routes.js";
import { platformStore } from "./store.js";

const sdkVersion = "v1.5.0";
const root = new URL("../../../../", import.meta.url);
const dashboardDir = new URL("apps/admin-dashboard/", root);
const widgetDir = new URL("deploy/widget/", root);
const loopbackHost = /^(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?$/u;

async function readWidgetAsset(version: string): Promise<Buffer> {
  const agentFile = new URL(`${version}/agent.js`, widgetDir);
  if (!["v1.3.0", "v1.4.0", "v1.5.0"].includes(version)) return readFile(agentFile);
  const files = [new URL("v1.3.0/ui-reader.js", widgetDir)];
  if (version !== "v1.3.0") files.push(new URL(`${version}/mapped-guide.js`, widgetDir));
  files.push(agentFile);
  const sources = await Promise.all(files.map(file => readFile(file, "utf8")));
  return Buffer.from(`(() => {\n${sources.join("\n")}\n})();\n`);
}

export async function startInstallationServers(env: Environment, listen: {
  host: "127.0.0.1" | "0.0.0.0";
  adminPort: number;
  widgetPort: number;
}): Promise<() => Promise<void>> {
  const databaseUrl = env.DAP_DATABASE_URL;
  if (!databaseUrl) throw new Error("DAP_DATABASE_URL is required");
  const publicOrigin = env.DAP_WIDGET_PUBLIC_ORIGIN;
  if (publicOrigin) {
    const url = new URL(publicOrigin);
    if (url.protocol !== "https:" || url.origin !== publicOrigin) throw new Error("DAP_WIDGET_PUBLIC_ORIGIN must be an HTTPS origin");
  }
  const sessionKey = env.DAP_WIDGET_SESSION_KEY || (publicOrigin ? "" : randomBytes(32).toString("base64url"));
  if (sessionKey.length < 32) throw new Error("Set DAP_WIDGET_SESSION_KEY to at least 32 characters for the public widget");
  const apiOrigin = publicOrigin || `http://localhost:${env.DAP_WIDGET_PORT || listen.widgetPort}`;
  const sdk = await readWidgetAsset(sdkVersion);
  const assets = {
    src: `${apiOrigin}/agent/${sdkVersion}/agent.js`,
    apiOrigin,
    integrity: `sha384-${createHash("sha384").update(sdk).digest("base64")}`,
  };

  const admin = fastify({ logger: false, bodyLimit: 64 * 1024 });
  const widget = fastify({ logger: false, bodyLimit: 64 * 1024 });
  const pool = createAuthoringPool(databaseUrl);
  const close = async () => {
    await Promise.allSettled([admin.close(), widget.close()]);
    await pool.end();
  };

  try {
    const store = platformStore(pool);
    const auth = createPlatformIdentity();
    const extension = platformExtension(store);
    const { host } = await composeReferenceHost({
      ...env, DAP_ENABLED_ACTIONS: extension.definitions.map(({ id }) => id).join(","),
    }, { identity: auth.identity, extensions: [extension] });
    admin.addHook("onClose", () => host.close());
    admin.addHook("onRequest", async (request, reply) => {
      reply.header("cache-control", "no-store");
      reply.header("content-security-policy", "default-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");
      if (!loopbackHost.test(request.headers.host ?? "")) return reply.code(403).send({ error: "forbidden" });
    });
    admin.setErrorHandler((_error, _request, reply) => reply.code(503).send({ error: "unavailable" }));
    widget.setErrorHandler((_error, _request, reply) => reply.code(503).send({ error: "unavailable" }));
    registerPlatformRoutes(admin, {
      store, host, assets, uiMaps: createUiMapStore(pool), uiGuideOperations: createUiGuideOperations(pool),
      resolve: () => {
        const now = Date.now();
        return auth.trust({
          userId: "operator-local-dashboard", sessionId: "local-dashboard", tenantId: PLATFORM_SCOPE,
          authenticatedAt: new Date(now).toISOString(), validUntil: new Date(now + 60_000).toISOString(),
        });
      },
      allowWrite: request => request.headers.origin === `http://${request.headers.host}`,
    });
    for (const [url, file, type] of [
      ["/", "index.html", "text/html; charset=utf-8"],
      ["/dashboard.js", "dashboard.js", "text/javascript; charset=utf-8"],
      ["/dashboard.css", "dashboard.css", "text/css; charset=utf-8"],
    ] as const) {
      const content = await readFile(new URL(file, dashboardDir));
      admin.get(url, async (_request, reply) => reply.type(type).send(content));
    }

    const applications = createPostgresApplicationStore(pool);
    const targets = createPostgresTargetStore(pool);
    registerWidget(widget, {
      pool, platform: store, applications, walkthroughs: createPostgresWalkthroughStore(pool),
      resolver: createRegistryResolver({ catalog: createRegistryCatalog(), targets }), sessionKey,
      ...(env.ANTHROPIC_API_KEY ? { apiKey: env.ANTHROPIC_API_KEY } : {}),
      ...(env.DAP_GUIDANCE_MODEL_ID ? { modelId: env.DAP_GUIDANCE_MODEL_ID } : {}),
    });
    widget.get<{ Params: { version: string } }>("/agent/:version/agent.js", async (req, reply) => {
      const { version } = req.params;
      if (!/^v\d+\.\d+\.\d+$/u.test(version)) return reply.code(404).send();
      const content = version === sdkVersion ? sdk : await readWidgetAsset(version).catch(() => null);
      if (!content) return reply.code(404).send();
      return reply.type("text/javascript; charset=utf-8")
        .header("access-control-allow-origin", "*")
        .header("cache-control", "public, max-age=31536000, immutable")
        .header("x-content-type-options", "nosniff").send(content);
    });
    await admin.listen({ host: listen.host, port: listen.adminPort });
    await widget.listen({ host: listen.host, port: listen.widgetPort });
    return close;
  } catch (error) {
    await close();
    throw error;
  }
}
