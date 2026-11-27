import type { FastifyInstance } from "fastify";
import { z } from "zod";
import type { Installation, PlatformStore } from "../platform/store.js";
import { uuid } from "../platform/store.js";
import { discoveryPath, openDiscoveryBrowser } from "./discovery-browser.js";
import type { DiscoveryBrowser } from "./discovery-browser.js";
import { discoverUiMap } from "./discover-ui-map.js";
import type { createUiMapStore } from "./ui-map-store.js";
import { audienceName, normalizeRoleKey, roleEndpoint, verifySaasRole } from "./ui-guide-operations.js";
import type { createUiGuideOperations } from "./ui-guide-operations.js";
import { uiTargetDigest } from "./ui-map-guide.js";

type JobStatus = "preparing" | "ready" | "scanning" | "complete" | "paused" | "access-required" | "failed";
interface Job {
  tenantId: string;
  origin: string;
  audience: string;
  status: JobStatus;
  browser?: DiscoveryBrowser;
  timer?: ReturnType<typeof setTimeout>;
  task?: Promise<void>;
  abort: AbortController;
}

const originField = z.string().min(1).max(190);
const readQuery = z.strictObject({ origin: originField, audience: audienceName.default("public") });
const requestBody = z.discriminatedUnion("action", [
  readQuery.extend({ action: z.enum(["prepare", "start", "resume", "close"]), startPath: discoveryPath.optional() }),
  z.strictObject({ origin: originField, action: z.literal("key"), publicKey: z.string().max(512).nullable(), endpoint: roleEndpoint.default("/api/dap/role") }),
]);
const active = (job: Job | undefined) => job && ["preparing", "ready", "scanning"].includes(job.status);

export function registerUiMapRoutes(
  app: FastifyInstance,
  directory: PlatformStore,
  maps: ReturnType<typeof createUiMapStore>,
  operations: ReturnType<typeof createUiGuideOperations>,
  allowText: (text: string) => boolean,
) {
  let current: Job | undefined;

  async function release(job: Job) {
    clearTimeout(job.timer);
    const browser = job.browser;
    delete job.browser;
    await browser?.close().catch(() => {});
  }

  async function close(job: Job) {
    job.abort.abort();
    await release(job);
    await job.task;
    if (current === job) current = undefined;
  }

  function same(job: Job | undefined, installation: Installation, origin: string, audience: string): job is Job {
    return job?.tenantId === installation.tenantId && job.origin === origin && job.audience === audience;
  }

  async function verifyBrowserRole(browser: DiscoveryBrowser, installation: Installation, job: Job) {
    if (job.audience === "public") return true;
    const config = await operations.roleConfig(installation, job.origin);
    const token = config && await browser.roleToken(config.endpoint).catch(() => null);
    return Boolean(config && token && verifySaasRole(token, config.key, { ...installation, origin: job.origin }) === job.audience);
  }

  async function scan(job: Job, installation: Installation, prepared: boolean, continueScan: boolean, startPath?: string) {
    let status: JobStatus = "failed";
    job.timer = setTimeout(() => {
      job.abort.abort();
      void release(job);
    }, 135_000);
    job.timer.unref();
    try {
      const saved = await maps.get(installation, job.origin, job.audience);
      const progress = continueScan ? await maps.checkpoint(installation, job.origin, job.audience) : undefined;
      if (continueScan && !progress) return;
      if (!job.browser) job.browser = await openDiscoveryBrowser(job.origin, false);
      if (job.abort.signal.aborted) return;
      const browser = job.browser;
      if (!await verifyBrowserRole(browser, installation, job)) {
        status = "access-required";
        return;
      }
      browser.begin();
      const seed = progress?.startPath ?? startPath ?? (prepared ? browser.currentPath() : "/");
      if (!prepared || progress || startPath) await browser.navigate(seed);
      const focus = progress?.focus ?? Boolean(startPath && startPath !== "/");
      const result = await discoverUiMap(browser, seed, job.abort.signal, allowText,
        { focus, ...(progress ? { resume: progress } : {}) });
      if (job.abort.signal.aborted) return;
      if ("access" in result) {
        if (result.access === "access-required") status = "access-required";
        return;
      }
      if (!await verifyBrowserRole(browser, installation, job)) {
        status = "access-required";
        return;
      }
      if (await maps.save(installation, job.origin, job.audience, saved?.revision ?? 0, { ...result, focus })) {
        status = result.checkpoint ? "paused" : "complete";
      }
    } catch {
      status = "failed";
    } finally {
      await release(job);
      job.status = status;
    }
  }

  async function prepare(job: Job) {
    try {
      job.browser = await openDiscoveryBrowser(job.origin, true);
      if (job.abort.signal.aborted) { await release(job); return; }
      job.status = "ready";
      job.timer = setTimeout(() => { void close(job); }, 5 * 60_000);
      job.timer.unref();
    } catch {
      job.status = "failed";
      await release(job);
    }
  }

  app.addHook("onClose", async () => { if (current) await close(current); });
  const path = "/api/platform/tenants/:id/ui-map";
  app.get<{ Params: { id: string } }>(path, async (req, reply) => {
    const id = uuid.safeParse(req.params.id);
    const query = readQuery.safeParse(req.query);
    const installation = id.success && query.success ? await directory.lookup(id.data) : undefined;
    if (!query.success || !installation?.allowedOrigins.includes(query.data.origin)) {
      return reply.code(404).send({ error: "not_found" });
    }
    const { origin, audience } = query.data;
    const [saved, draft, audiences, key, usage] = await Promise.all([
      maps.get(installation, origin, audience, true), maps.checkpoint(installation, origin, audience),
      maps.audiences(installation, origin), operations.roleConfig(installation, origin), operations.report(installation, origin, audience),
    ]);
    const currentTargets = new Map(saved?.map.states.flatMap(state =>
      state.targets.map(target => [uiTargetDigest(target), target] as const)));
    const previousTargets = new Map(saved?.previousMap?.states.flatMap(state =>
      state.targets.map(target => [uiTargetDigest(target), target] as const)));
    const failures = usage.failures.map(failure => {
      const targets = failure.revision === saved?.revision ? currentTargets
        : failure.revision === (saved?.revision ?? 0) - 1 ? previousTargets : undefined;
      const target = targets?.get(String(failure.target));
      const seed = targets?.get(String(failure.firstTarget))?.page ?? target?.page;
      return { ...failure, page: target?.page, label: target?.name || target?.marker, seed };
    });
    return { status: same(current, installation, origin, audience) ? current.status : draft ? "paused" : "idle",
      saved: saved ?? null, audiences, roleEndpoint: key?.endpoint ?? null, usage: { ...usage, failures },
      draft: draft ? { map: draft.map, pending: draft.pending.flatMap(item => item.actions.slice(item.next)) } : null };
  });

  app.post<{ Params: { id: string } }>(path, async (req, reply) => {
    const id = uuid.safeParse(req.params.id);
    const body = requestBody.safeParse(req.body);
    if (!id.success || !body.success) return reply.code(422).send({ error: "invalid_discovery" });
    const installation = await directory.lookup(id.data);
    const { origin, action } = body.data;
    if (!installation?.allowedOrigins.includes(origin)) return reply.code(404).send({ error: "not_found" });
    if (action === "key") {
      const key = body.data.publicKey === null ? null : normalizeRoleKey(body.data.publicKey);
      if (!key && body.data.publicKey !== null) return reply.code(422).send({ error: "invalid_role_key" });
      await operations.setRoleKey(installation, origin, key ? { key, endpoint: body.data.endpoint } : null);
      return { keyConfigured: Boolean(key) };
    }
    const { audience, startPath } = body.data;
    if (action === "close") {
      if (same(current, installation, origin, audience)) await close(current);
      return { status: "idle" };
    }
    if (!installation.enabled) return reply.code(409).send({ error: "discovery_disabled" });
    if (audience === "legacy" || (audience === "public" && action === "prepare")) return reply.code(422).send({ error: "invalid_audience" });
    if (audience !== "public" && !await operations.roleConfig(installation, origin)) return reply.code(409).send({ error: "role_key_required" });
    if (startPath && (!allowText(startPath) || new URL(startPath, origin).origin !== origin)) return reply.code(422).send({ error: "invalid_discovery" });
    const prepared = same(current, installation, origin, audience) && current.status === "ready" && action !== "prepare" ? current : undefined;
    if (active(current) && !prepared) return reply.code(409).send({ error: "discovery_busy" });
    if (audience !== "public" && action !== "prepare" && !prepared) return reply.code(409).send({ error: "studio_login_required" });
    const job: Job = prepared ?? { tenantId: installation.tenantId, origin, audience, status: "preparing", abort: new AbortController() };
    current = job;
    clearTimeout(job.timer);
    if (action === "prepare") job.task = prepare(job);
    else {
      job.status = "scanning";
      job.task = scan(job, installation, Boolean(prepared), action === "resume", startPath);
    }
    return reply.code(202).send({ status: job.status });
  });
}
