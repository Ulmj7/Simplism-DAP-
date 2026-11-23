/**
 * C01 dev server (`npm run dev:host`): the reference host composed with the guidance capability, behind the narrow browser transport.
 * DAP_HTTP_HOST defaults to 127.0.0.1. The Docker lab binds to 0.0.0.0 inside the container and publishes to host loopback.
 *
 * DEV-ONLY DEMO LIMITATION: the browser supplies no identity. The host opens its OWN demo session server-side from `DAP_DEMO_SESSION_TOKEN` (dev-auth
 * evidence, read from the environment, never from a request), so every browser that can reach 127.0.0.1 shares that one session. A real deployment needs
 * real authentication in front of this transport.
 *
 * Environment: everything `composeReferenceHost` needs (DAP_DATABASE_URL, DAP_ENABLED_ACTIONS including `startWalkthrough`, NODE_ENV, DAP_ALLOW_DEV_AUTH,
 * DEV_SESSIONS), DAP_DEMO_SESSION_TOKEN, optional DAP_HTTP_PORT (default 8787), DAP_GUIDANCE_MODEL (`fake` by default; `anthropic` needs
 * ANTHROPIC_API_KEY, which stays in this process). No value is ever printed.
 *
 * Feature 004 (authoring): this server also registers the authoring routes (`registerAuthoringRoutes`, on the SAME transport instance) and the two authoring
 * capabilities. Studio V1A adds the Application Manager routes (`registerApplicationRoutes`) and two more capabilities; every draft belongs to an enrolled application.
 * To use them, add `saveWalkthroughDraft,setWalkthroughStatus,saveStudioApplication,setStudioApplicationEnabled` to DAP_ENABLED_ACTIONS (default deny: they are off otherwise), give a DEV_SESSIONS entry
 * the permission `perm.walkthrough.maintain`, and set the optional DAP_DEMO_MAINTAINER_TOKEN to that session's token. The browser's `X-Demo-Role: user|maintainer`
 * header only chooses between the two server-held demo sessions for the demo (unknown or absent = user; `maintainer` without a configured maintainer token = user);
 * it is a DEV convenience and NOT the authority: permissions come from the host's own session table and every write goes through the Gateway. The authoring store has
 * its own small database pool built from DAP_DATABASE_URL (the unprivileged application role).
 */
import { randomBytes } from "node:crypto";
import { createAuthoringExtension } from "../authoring/capabilities.js";
import { createAuthoringPool } from "../authoring/pool.js";
import { createPostgresWalkthroughStore } from "../authoring/postgres-store.js";
import { createDemoPrincipalResolver } from "../authoring/principal.js";
import { registerAuthoringRoutes } from "../authoring/routes.js";
import { createApplicationExtension } from "../studio/application-capabilities.js";
import { registerApplicationRoutes } from "../studio/application-routes.js";
import { createPostgresApplicationStore } from "../studio/postgres-application-store.js";
import { createRegistryCatalog } from "../studio/registries.js";
import { registerStudioBrowser } from "../studio/browser.js";
import { composeReferenceHost } from "../compose.js";
import { parseDevSessions } from "../dev-auth/index.js";
import { createGuidanceHost } from "../guidance/compose-guidance.js";
import { GuidanceConfigError } from "../guidance/anthropic-model.js";
import { demoCatalogView } from "../guidance/walkthrough-summaries.js";
import { createApprovalRecorder, createGatewayStart } from "./approved-start.js";
import { createProposalStore } from "./proposal-store.js";
import { startupFailureMessage } from "./startup-message.js";
import type { StartupPhase } from "./startup-message.js";
import { HTTP_HOST, createGuidanceTransport, parseHttpPort } from "./transport.js";
import type { GuidanceSession } from "./transport.js";

const env = process.env;
let close: (() => Promise<void>) | undefined;
let phase: StartupPhase = "config";
try {
  const bindHost = env.DAP_HTTP_HOST ?? HTTP_HOST;
  if (bindHost !== HTTP_HOST && bindHost !== "0.0.0.0") {
    throw new GuidanceConfigError("DAP_HTTP_HOST must be 127.0.0.1 or 0.0.0.0");
  }
  const port = parseHttpPort(env.DAP_HTTP_PORT);
  if (port === null) throw new GuidanceConfigError("DAP_HTTP_PORT must be a port number from 1 to 65535");
  const token = env.DAP_DEMO_SESSION_TOKEN;
  if (!token) throw new GuidanceConfigError("DAP_DEMO_SESSION_TOKEN is required");
  const databaseUrl = env.DAP_DATABASE_URL;
  if (!databaseUrl) throw new GuidanceConfigError("DAP_DATABASE_URL is required");
  const recorder = createApprovalRecorder();
  const guidance = createGuidanceHost({ env, starter: recorder.starter });
  phase = "compose";
  const authoringPool = createAuthoringPool(databaseUrl);
  close = () => authoringPool.end();
  const store = createPostgresWalkthroughStore(authoringPool);
  // Studio V1A: applications are trusted, tenant-scoped configuration; the registry of each is a key into the host-trusted catalog (the built-in `reference` entry here).
  const applications = createPostgresApplicationStore(authoringPool);
  const catalog = createRegistryCatalog();
  const authoring = createAuthoringExtension({ store, applications, catalog });
  const studioApplications = createApplicationExtension({ store: applications, catalog });
  const { host } = await composeReferenceHost(env, { extensions: [guidance.extension, authoring.extension, studioApplications.extension] });
  close = async () => { await host.close(); await authoringPool.end(); };
  phase = "session";
  if ((await host.openSession(token)) === null) throw new GuidanceConfigError("DAP_DEMO_SESSION_TOKEN session was refused");
  const demoSession: GuidanceSession = Object.freeze({ key: "dev-demo-session", start: createGatewayStart({ openSession: () => host.openSession(token), recorder }) });
  const app = createGuidanceTransport({
    ask: guidance.askGuidance,
    catalog: demoCatalogView,
    resolveSession: async () => demoSession,
    proposals: createProposalStore({ now: Date.now, newId: () => randomBytes(32).toString("base64url") }),
  });
  // Feature 004: the authoring routes on the SAME instance, before listen, so every transport guard applies to them. The principal comes from the host's own
  // session table (see principal.ts); the demo role header only picks one of the two server-held sessions.
  const maintainerToken = env.DAP_DEMO_MAINTAINER_TOKEN;
  if (maintainerToken && (await host.openSession(maintainerToken)) === null) throw new GuidanceConfigError("DAP_DEMO_MAINTAINER_TOKEN session was refused");
  const resolvePrincipal = createDemoPrincipalResolver({ sessions: parseDevSessions(env.DEV_SESSIONS), userToken: token, maintainerToken, openSession: (evidence) => host.openSession(evidence) });
  registerAuthoringRoutes(app, { store, applications, catalog, resolvePrincipal });
  registerApplicationRoutes(app, { applications, catalog, resolvePrincipal });
  registerStudioBrowser(app, { resolvePrincipal, applications, catalog, authoring: store });
  close = async () => { await app.close(); await host.close(); await authoringPool.end(); };
  phase = "listen";
  await app.listen({ host: bindHost, port });
  console.log(`DAP guidance host listening on http://${bindHost}:${port} (dev only)`);
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.once(signal, () => { void close?.().finally(() => process.exit(0)); });
} catch (error) {
  console.error(startupFailureMessage(error, phase));
  await close?.().catch(() => {});
  process.exitCode = 1;
}
