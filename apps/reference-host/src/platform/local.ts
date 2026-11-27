import type { FastifyInstance } from "fastify";
import { createDevAuthentication } from "../dev-auth/index.js";
import type { DevSession } from "../dev-auth/index.js";
import { MAINTAIN_PERMISSION } from "../authoring/capabilities.js";
import { demoRoleFromHeaders } from "../authoring/principal.js";
import type { AuthoringPrincipal, RequestHeaders } from "../authoring/routes.js";
import type { TenantPool } from "../authoring/tenant-tx.js";
import type { HostExtension } from "../compose.js";
import { composeReferenceHost } from "../compose.js";
import type { IsoInstant } from "@dap/contracts";
import { platformExtension } from "./capabilities.js";
import { createPlatformIdentity, PLATFORM_SCOPE } from "./identity.js";
import { registerPlatformRoutes } from "./routes.js";
import { platformStore, uuid } from "./store.js";

export async function registerLocalPlatform(deps: {
  env: NodeJS.ProcessEnv; app: FastifyInstance; pool: TenantPool; sessions: readonly DevSession[];
  maintainerToken: string; extensions: readonly HostExtension[];
  resolvePrincipal: (headers: RequestHeaders) => Promise<AuthoringPrincipal | null>;
}) {
  const { env, app, pool, sessions, maintainerToken, extensions, resolvePrincipal } = deps;
  const clock = { now: () => new Date().toISOString() as IsoInstant };
  const authenticate = createDevAuthentication(sessions, clock);
  const store = platformStore(pool);
  const auth = createPlatformIdentity();
  const provisioning = platformExtension(store);
  const { host } = await composeReferenceHost({
    ...env,
    DAP_ENABLED_ACTIONS: [
      ...provisioning.definitions.map(action => action.id),
      ...extensions.flatMap(ext => ext.definitions.map(action => action.id))
        .filter(id => env.DAP_ENABLED_ACTIONS?.split(",").some(option => option.trim() === id)),
    ].join(","),
  }, { identity: auth.identity, extensions: [provisioning, ...extensions] });
  app.addHook("onClose", () => host.close());

  async function operator(headers: RequestHeaders) {
    if (demoRoleFromHeaders(headers) !== "maintainer") return null;
    const principal = await resolvePrincipal(headers);
    if (!principal?.permissions.has(MAINTAIN_PERMISSION)) return null;
    const evidence = await authenticate.authenticate(maintainerToken);
    return evidence ? auth.trust({ ...evidence, userId: `operator-${evidence.userId}`, tenantId: PLATFORM_SCOPE }) : null;
  }
  registerPlatformRoutes(app, {
    store, host, assets: null,
    resolve: req => operator(req.headers),
    allowWrite: req => {
      const origin = req.headers.origin;
      if (origin === undefined) return req.headers["sec-fetch-site"] === undefined;
      try {
        const url = new URL(origin);
        return url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost")
          && url.origin === origin && url.host === req.headers.host;
      } catch { return false; }
    },
  });

  return async (headers: RequestHeaders): Promise<AuthoringPrincipal | null> => {
    const selected = headers["x-dap-active-tenant"];
    if (selected === undefined || demoRoleFromHeaders(headers) !== "maintainer") return resolvePrincipal(headers);
    const id = uuid.safeParse(selected);
    const actor = await operator(headers);
    if (!id.success || !actor || !await store.lookup(id.data)) return null;
    const scoped = auth.forTenant(actor, id.data);
    return {
      key: scoped.userId, actor: scoped.userId, tenantId: scoped.tenantId, permissions: new Set([MAINTAIN_PERMISSION]),
      submit: async call => {
        const session = await host.openSession(scoped);
        if (!session) throw new Error("Local tenant session unavailable");
        return session.submit(call);
      },
    };
  };
}
