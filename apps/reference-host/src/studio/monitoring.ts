import { randomUUID } from "node:crypto";
import type { BrowserObservation } from "@dap/browser-runtime";
import { scrubText } from "@dap/security";
import type { FastifyInstance, FastifyRequest } from "fastify";
import { z } from "zod";
import type { Operator } from "../platform/identity.js";
import type { PlatformStore } from "../platform/store.js";
import { uuid } from "../platform/store.js";
import type { DiscoveryBrowser } from "./discovery-browser.js";
import type { createUiGuideOperations } from "./ui-guide-operations.js";
import { uiTargetDigest } from "./ui-map-guide.js";
import type { createUiMapStore } from "./ui-map-store.js";

type Scope = { tenantId: string; applicationId: string; origin: string };
type Session = Scope & {
  owner: string;
  audience: string;
  kind: "Studio" | "UI зураглал";
  observe: () => BrowserObservation;
  validate?: () => Promise<boolean>;
  canObserve?: () => boolean;
  control?: {
    browser: Pick<DiscoveryBrowser, "input" | "startLiveView">;
    signal: AbortSignal;
    ready: () => boolean;
  };
};

export function createMonitoring() {
  const sessions = new Map<string, Session>();
  return {
    attach(session: Session) {
      const id = randomUUID();
      sessions.set(id, session);
      return () => sessions.delete(id);
    },
    sessions: () => sessions.entries(),
  };
}

export type Monitoring = ReturnType<typeof createMonitoring>;

export function registerMonitoringRoutes(
  app: FastifyInstance, directory: PlatformStore, monitoring: Monitoring,
  maps: ReturnType<typeof createUiMapStore>, guides: ReturnType<typeof createUiGuideOperations>,
  operator: (req: FastifyRequest) => Operator | undefined,
  allowOrigin: (req: FastifyRequest) => boolean,
) {
  const root = "/api/platform/tenants/:tenantId/monitor";
  const params = z.object({ tenantId: uuid, sessionId: uuid.optional(), runId: uuid.optional() });
  const query = z.strictObject({ after: z.coerce.number().int().nonnegative().default(0), cursor: uuid.optional() });
  const unavailable = { error: "session_unavailable" };
  let cleanup: Promise<void> | undefined;
  let closed = false;
  async function purge() {
    for (let offset = 0; !closed; offset += 50) {
      const tenants = await directory.list(offset);
      for (const tenant of tenants.slice(0, 50)) {
        if (closed) return;
        await guides.purgeSteps(tenant.tenantId);
      }
      if (tenants.length < 51) break;
    }
  }
  const timer = setInterval(() => {
    if (cleanup) return;
    cleanup = purge().catch(() => { app.log.warn("Guide event retention cleanup failed"); })
      .finally(() => { cleanup = undefined; });
  }, 60 * 60_000);
  timer.unref();
  app.addHook("onClose", async () => {
    closed = true;
    clearInterval(timer);
    await cleanup;
  });
  async function resolve(req: FastifyRequest) {
    const who = operator(req);
    const input = params.safeParse(req.params);
    if (!who || !input.success) return null;
    const installation = await directory.lookup(input.data.tenantId);
    if (!installation?.enabled) return null;
    const matching = [...monitoring.sessions()].filter(([, entry]) => entry.owner === who.userId &&
      entry.tenantId === installation.tenantId && entry.applicationId === installation.applicationId &&
      installation.allowedOrigins.includes(entry.origin));
    const valid = await Promise.all(matching.map(([, entry]) => entry.validate?.() ?? true));
    return { installation, sessions: matching.filter((_, index) => valid[index]), ...input.data };
  }

  function canControl(session: Session) {
    return session.control && !session.control.signal.aborted && session.control.ready() ? session.control : undefined;
  }
  function viewMode(session: Session) {
    if (canControl(session)) return "control";
    return session.canObserve?.() === false ? "waiting" : "observe";
  }

  const connected = new Set<string>();
  const upgrades = new WeakMap<FastifyRequest, { id: string; session: Session }>();
  const inputBase = { revision: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER) };
  const coordinate = z.number().min(0).lt(1);
  const scrollDelta = z.number().min(-2000).max(2000);
  const inputSchema = z.discriminatedUnion("kind", [
    z.strictObject({ ...inputBase, kind: z.literal("click"), x: coordinate, y: coordinate }),
    z.strictObject({ ...inputBase, kind: z.literal("wheel"), x: coordinate, y: coordinate, deltaX: scrollDelta, deltaY: scrollDelta }),
    z.strictObject({ ...inputBase, kind: z.literal("text"), text: z.string().min(1).max(2048) }),
    z.strictObject({ ...inputBase, kind: z.literal("key"), key: z.enum([
      "Tab", "Shift+Tab", "Enter", "Escape", "Backspace", "Delete", "Home", "End", "PageUp", "PageDown",
      "ArrowLeft", "ArrowRight", "ArrowUp", "ArrowDown", "ControlOrMeta+a",
    ]) }),
  ]);
  async function resolveSession(req: FastifyRequest) {
    const scope = await resolve(req);
    const found = scope?.sessions.find(([id]) => id === scope.sessionId);
    return found ? { id: found[0], session: found[1] } : undefined;
  }

  app.get(root + "/sessions/:sessionId/live", {
    websocket: true,
    preValidation: async (req, reply) => {
      if (!req.ws || !allowOrigin(req)) return reply.code(403).send(unavailable);
      const found = await resolveSession(req);
      if (!found || !canControl(found.session)) return reply.code(404).send(unavailable);
      upgrades.set(req, found);
    },
  }, (socket, req) => {
    const bound = upgrades.get(req);
    const control = bound && canControl(bound.session);
    if (!bound || !control || connected.has(bound.id)) { socket.close(1008); return; }
    const { id, session } = bound;
    connected.add(id);

    let closed = false;
    let stopView: (() => Promise<void>) | undefined;
    let revalidating = false;
    let pending = 0;
    let inputs = Promise.resolve();
    let frameRevision: number | undefined;
    async function authorized() {
      const current = await resolveSession(req);
      return !closed && current?.session === session && Boolean(canControl(session));
    }
    function stop() {
      if (closed) return;
      closed = true;
      clearInterval(revalidate);
      clearTimeout(expiry);
      control?.signal.removeEventListener("abort", stop);
      socket.close(1000);
      void starting.then(() => stopView?.()).catch(() => {}).finally(() => connected.delete(id));
    }

    const revalidate = setInterval(() => {
      if (revalidating) return;
      revalidating = true;
      void authorized().then(ok => { if (!ok) stop(); }, stop).finally(() => { revalidating = false; });
    }, 2000);
    // A reconnect refreshes the platform identity used for the upgrade.
    const expiry = setTimeout(stop, 55_000);
    socket.on("close", stop);
    socket.on("error", stop);
    socket.on("message", (raw, binary) => {
      if (closed || binary || pending >= 24) return;
      let message: unknown;
      try { message = JSON.parse(raw.toString()); } catch { return; }
      const parsed = inputSchema.safeParse(message);
      if (!parsed.success) return;
      const action = parsed.data;
      if (action.revision !== frameRevision) return;
      pending++;
      inputs = inputs.then(async () => {
        if (closed || !canControl(session)) return;
        if (!await authorized()) { stop(); return; }
        if (!closed && canControl(session)) await control.browser.input(action);
      }).catch(() => { stop(); }).finally(() => { pending--; });
    });
    const starting = control.browser.startLiveView(frame => {
      if (closed || !canControl(session) || socket.readyState !== socket.OPEN ||
          socket.bufferedAmount > 256 * 1024 || frame.data.length > 512 * 1024) return;
      frameRevision = frame.revision;
      socket.send(JSON.stringify({ width: frame.width, height: frame.height, revision: frame.revision }));
      socket.send(frame.data);
    }).then(dispose => { stopView = dispose; });
    control.signal.addEventListener("abort", stop, { once: true });
    if (control.signal.aborted) stop();
    void starting.catch(stop);
  });

  app.get(root, async (req, reply) => {
    const scope = await resolve(req);
    if (!scope) return reply.code(404).send(unavailable);
    const sessions = scope.sessions.map(([id, session]) => {
      const mode = viewMode(session);
      let url;
      if (mode === "observe") {
        try { url = session.observe().summary(Number.MAX_SAFE_INTEGER).url; } catch { /* Browser is navigating. */ }
      }
      return { id, source: session.kind, origin: session.origin, audience: session.audience, url, mode };
    });
    return { sessions, runs: await guides.recent(scope.installation) };
  });

  app.get(root + "/runs/:runId", async (req, reply) => {
    const scope = await resolve(req);
    if (!scope?.runId) return reply.code(404).send(unavailable);
    const run = await guides.history(scope.installation, scope.runId);
    if (!run) return reply.code(404).send(unavailable);
    const saved = await maps.get(scope.installation, run.origin, run.audience, true);
    const map = saved?.revision === run.revision ? saved?.map : saved?.revision === run.revision + 1 ? saved.previousMap : null;
    const labels = new Map(map?.states.flatMap(state => state.targets.map(target => [uiTargetDigest(target), target.name || target.marker] as const)));
    const { events, steps, ...metadata } = run;
    return { ...metadata, events: events.map(event => ({ ...event, target: scrubText(labels.get(steps[event.index] ?? "") ?? "") })) };
  });

  app.get(root + "/sessions/:sessionId/:resource", async (req, reply) => {
    const scope = await resolve(req);
    const session = scope?.sessions.find(([id]) => id === scope.sessionId)?.[1];
    if (!scope || !session) return reply.code(404).send(unavailable);
    if (viewMode(session) !== "observe") return reply.code(409).send(unavailable);
    const input = query.safeParse(req.query);
    if (!input.success) return reply.code(422).send({ error: "invalid_observation" });
    const { resource } = req.params as { resource: string };
    try {
      const browser = session.observe();
      if (resource === "events") {
        const result = browser.summary(input.data.after);
        return { ...result, events: result.events.map(event => ({
          ...event, detail: event.detail === undefined ? undefined : scrubText(event.detail),
          target: event.target === undefined ? undefined : scrubText(event.target),
        })) };
      }
      if (resource === "viewport") {
        const { image, view } = await browser.viewport();
        return reply.header("x-dap-view", view).type("image/jpeg").send(image);
      }
      if (resource === "storage") return await browser.storage();
      if (resource !== "dom") return reply.code(404).send(unavailable);
      const page = await browser.dom(input.data.cursor);
      const url = new URL(page.url);
      const saved = await maps.get(scope.installation, url.origin, session.audience);
      const states = saved?.map.states.filter(state => state.page === url.pathname + url.hash) ?? [];
      const known = new Set(states.flatMap(state => state.targets.map(uiTargetDigest)));
      return {
        ...page, mapRevision: saved?.revision, audience: session.audience,
        nodes: page.nodes.map(({ targetDigest, ambiguous, ...node }) => ({
          ...node, recognition: node.unavailable || ambiguous ? "unavailable"
            : targetDigest && known.has(targetDigest) ? "mapped" : targetDigest ? "recognized" : "unrecognized",
          reason: ambiguous ? "Олон ижил элемент" : !node.unavailable && targetDigest && !known.has(targetDigest) && !saved
            ? "Энэ эрхийн бүлэгт хадгалсан зураглал алга" : undefined,
        })),
      };
    } catch {
      return reply.code(409).send(unavailable);
    }
  });
}
