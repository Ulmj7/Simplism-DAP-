import { fastify } from "fastify";
import type { FastifyRequest } from "fastify";
import { createAuthoringPool } from "../authoring/pool.js";
import { createAuthoringExtension } from "../authoring/capabilities.js";
import { createPostgresWalkthroughStore } from "../authoring/postgres-store.js";
import { registerAuthoringRoutes } from "../authoring/routes.js";
import { composeReferenceHost } from "../compose.js";
import { registerApplicationRoutes } from "../studio/application-routes.js";
import { createApplicationExtension } from "../studio/application-capabilities.js";
import { createTargetExtension } from "../studio/target-capabilities.js";
import { createPostgresApplicationStore } from "../studio/postgres-application-store.js";
import { createPostgresTargetStore } from "../studio/postgres-target-store.js";
import { registerStudioBrowser } from "../studio/browser.js";
import { createUiGuideOperations } from "../studio/ui-guide-operations.js";
import { createUiMapStore } from "../studio/ui-map-store.js";
import { createRegistryCatalog } from "../studio/registries.js";
import { createRegistryResolver } from "../studio/registry-resolver.js";
import { platformExtension } from "./capabilities.js";
import { operatorAuth } from "./identity.js";
import { registerWidget } from "./public-api.js";
import { platformStore, uuid } from "./store.js";
import { registerPlatformRoutes } from "./routes.js";

const env = process.env;
function required(name: string) {
  const value = env[name];
  if (!value) throw new Error(`Missing configuration: ${name}`);
  return value;
}
function secureUrl(name: string, originOnly: boolean) {
  const url = new URL(required(name));
  if (url.protocol !== "https:" || url.username || url.password || url.hash || url.search || (originOnly && url.pathname !== "/")) {
    throw new Error(`Invalid HTTPS configuration: ${name}`);
  }
  return originOnly ? url.origin : url.href;
}

async function main() {
  const assets = {
    src: secureUrl("DAP_WIDGET_ASSET_URL", false),
    apiOrigin: secureUrl("DAP_WIDGET_API_ORIGIN", true),
    integrity: required("DAP_WIDGET_ASSET_INTEGRITY"),
  };
  if (!/^sha384-[A-Za-z0-9+/]{64}$/u.test(assets.integrity)) throw new Error("Invalid widget integrity");
  const adminOrigin = secureUrl("DAP_PLATFORM_ORIGIN", true);
  const auth = operatorAuth(env);
  const databaseUrl = required("DAP_DATABASE_URL");
  const sessionKey = required("DAP_WIDGET_SESSION_KEY");
  const apiKey = required("ANTHROPIC_API_KEY");
  const bindHost = env.DAP_PLATFORM_HTTP_HOST ?? "127.0.0.1";
  if (bindHost !== "127.0.0.1" && bindHost !== "0.0.0.0") throw new Error("Invalid platform bind address");
  const port = Number(env.DAP_PLATFORM_PORT ?? 8796);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid platform port");
  const pool = createAuthoringPool(databaseUrl);
  const app = fastify({ logger: false, bodyLimit: 64 * 1024, onProtoPoisoning: "error", onConstructorPoisoning: "error" });
  try {
    const store = platformStore(pool);
    const walkthroughs = createPostgresWalkthroughStore(pool);
    const applications = createPostgresApplicationStore(pool);
    const targets = createPostgresTargetStore(pool);
    const catalog = createRegistryCatalog();
    const resolver = createRegistryResolver({ catalog, targets });
    const { host } = await composeReferenceHost(env, {
      identity: auth.identity,
      extensions: [platformExtension(store), createAuthoringExtension({ store: walkthroughs, applications, catalog, targets, resolver }).extension,
        createApplicationExtension({ store: applications, catalog }).extension, createTargetExtension({ targets }).extension],
    });
    app.addHook("onClose", () => host.close());
    app.addHook("onRequest", async (req, reply) => {
      if (req.url.startsWith("/api/widget/") || req.url === "/readyz") return;
      reply.header("cache-control", "no-store");
      if (!auth.resolve(req.headers)) return reply.code(403).send({ error: "forbidden" });
      if (req.method !== "GET" && req.headers.origin !== adminOrigin) return reply.code(403).send({ error: "forbidden" });
    });
    app.addHook("onResponse", async (req, reply) => {
      const route = req.routeOptions.url;
      if (!route?.startsWith("/api/")) return;
      const id = uuid.safeParse((req.params as { installationId?: unknown } | undefined)?.installationId);
      console.log(JSON.stringify({ route, method: req.method, status: reply.statusCode,
        durationMs: Math.round(reply.elapsedTime), ...(id.success ? { installationId: id.data } : {}) }));
    });
    app.setErrorHandler((_error, _request, reply) => reply.code(503).send({ error: "unavailable" }));
    async function resolvePrincipal(headers: FastifyRequest["headers"]) {
      const operator = auth.resolve(headers);
      const selected = uuid.safeParse(headers["x-dap-active-tenant"]);
      if (!operator || !selected.success || !await store.lookup(selected.data)) return null;
      const scoped = auth.forTenant(operator, selected.data);
      return {
        key: scoped.userId, actor: scoped.userId, tenantId: scoped.tenantId, permissions: new Set(["perm.walkthrough.maintain"]),
        submit: async (call: Parameters<NonNullable<Awaited<ReturnType<typeof host.openSession>>>["submit"]>[0]) => {
          const session = await host.openSession(scoped);
          if (!session) throw new Error("Platform session unavailable");
          return session.submit(call);
        },
      };
    }
    registerAuthoringRoutes(app, { store: walkthroughs, applications, catalog, targets, resolver, resolvePrincipal });
    registerApplicationRoutes(app, { applications, catalog, targets, resolver, resolvePrincipal });
    if (env.DAP_PLATFORM_STUDIO_BROWSER === "1") {
      registerStudioBrowser(app, { resolvePrincipal, applications, catalog, authoring: walkthroughs, targets, resolver });
    }
    registerWidget(app, { pool, platform: store, walkthroughs, applications, resolver, sessionKey, apiKey,
      ...(env.DAP_GUIDANCE_MODEL_ID ? { modelId: env.DAP_GUIDANCE_MODEL_ID } : {}) });

    app.get("/readyz", async () => {
      await pool.query("SELECT 1 FROM public.platform_installations LIMIT 0");
      return { status: "ready" };
    });
    registerPlatformRoutes(app, {
      store, host, assets, resolve: req => auth.resolve(req.headers), uiMaps: createUiMapStore(pool),
      uiGuideOperations: createUiGuideOperations(pool),
      allowWrite: req => req.headers.origin === adminOrigin,
    });
    await app.listen({ host: bindHost, port });
    console.log(`DAP platform listening on ${bindHost}:${port}`);
    let closing = false;
    for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => {
      if (closing) return;
      closing = true;
      void app.close().finally(() => pool.end());
    });
  } catch {
    await app.close().catch(() => undefined);
    await pool.end();
    throw new Error("Platform startup failed");
  }
}
main().catch(error => { console.error(error instanceof Error ? error.message : "Platform startup failed"); process.exitCode = 1; });
