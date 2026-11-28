import { createMonitoring, registerMonitoringRoutes } from "../studio/monitoring.js";
import type { Monitoring } from "../studio/monitoring.js";
import websocket from "@fastify/websocket";
import { randomUUID } from "node:crypto";
import { parseKnowledgeDoc } from "@dap/ai";
import { scrubText } from "@dap/security";
import type { FastifyInstance, FastifyRequest } from "fastify";
import type { ReferenceHost } from "../compose.js";
import { registerUiMapRoutes } from "../studio/ui-map-routes.js";
import type { createUiMapStore } from "../studio/ui-map-store.js";
import type { createUiGuideOperations } from "../studio/ui-guide-operations.js";
import type { Operator } from "./identity.js";
import { documentInput, inputDigest, tenantInput, updateRequest, uuid } from "./store.js";
import type { PlatformStore } from "./store.js";

export interface WidgetAssets { readonly src: string; readonly apiOrigin: string; readonly integrity: string }

export function registerPlatformRoutes(server: FastifyInstance, deps: {
  store: PlatformStore;
  host: ReferenceHost;
  assets: WidgetAssets | null;
  resolve: (request: FastifyRequest) => Operator | null | Promise<Operator | null>;
  allowWrite: (request: FastifyRequest) => boolean;
  monitoring?: Monitoring;
  uiMaps?: ReturnType<typeof createUiMapStore>;
  uiGuideOperations?: ReturnType<typeof createUiGuideOperations>;
}) {
  const { store, host, assets } = deps;
  void server.register(async app => {
    const operators = new WeakMap<FastifyRequest, Operator>();
    app.addHook("onRequest", async (req, reply) => {
      reply.header("cache-control", "no-store");
      const operator = await deps.resolve(req);
      if (!operator || (req.method !== "GET" && !deps.allowWrite(req))) {
        return reply.code(403).send({ error: "forbidden" });
      }
      operators.set(req, operator);
    });
    if (deps.uiMaps && deps.uiGuideOperations) {
      await app.register(websocket, { options: { maxPayload: 12 * 1024 } });
      const monitoring = deps.monitoring ?? createMonitoring();
      const operator = (req: FastifyRequest) => operators.get(req);
      registerUiMapRoutes(app, store, deps.uiMaps, deps.uiGuideOperations, text => scrubText(text) === text, monitoring, operator);
      registerMonitoringRoutes(app, store, monitoring, deps.uiMaps, deps.uiGuideOperations, operator, deps.allowWrite);
    }
    async function submit(operator: Operator, action: string, params: unknown) {
      const session = await host.openSession(operator);
      if (!session) return false;
      const outcome = await session.submit({ providerCallId: randomUUID(), arguments: JSON.stringify({ action, params }) });
      return outcome.outcome === "ALLOWED" && outcome.category === "ok";
    }
    app.get("/api/platform/access", async () => ({ canManageTenants: true }));
    app.get<{ Querystring: { offset?: string } }>("/api/platform/tenants", async (req, reply) => {
      const offset = Number(req.query.offset ?? 0);
      if (!Number.isSafeInteger(offset) || offset < 0) return reply.code(422).send({ error: "invalid_offset" });
      let rows;
      try { rows = await store.list(offset); }
      catch (error) {
        if ((error as { code?: unknown } | null)?.code === "42P01") return reply.code(503).send({ error: "migration_required" });
        throw error;
      }
      return { tenants: rows.slice(0, 50), nextOffset: rows.length === 51 ? offset + 50 : null, assets };
    });
    app.get<{ Params: { id: string } }>("/api/platform/tenants/:id", async (req, reply) => {
      const id = uuid.safeParse(req.params.id);
      const tenant = id.success ? await store.lookup(id.data) : undefined;
      return tenant ? { tenant, assets } : reply.code(404).send({ error: "not_found" });
    });
    app.post("/api/platform/tenants", async (req, reply) => {
      const operator = operators.get(req);
      if (!operator) return reply.code(403).send({ error: "forbidden" });
      const input = tenantInput.safeParse(req.body);
      const key = uuid.safeParse(req.headers["idempotency-key"]);
      if (!input.success || !key.success) return reply.code(422).send({ error: "invalid_tenant" });
      const digest = inputDigest(input.data);
      if (!await store.operation(operator.userId, key.data)) {
        await submit(operator, "createTenantAndAgent", { ...input.data, organizationId: randomUUID(), requestKey: key.data });
      }
      const record = await store.operation(operator.userId, key.data);
      if (!record) {
        if (await store.byCompanyReg(input.data.companyReg)) return reply.code(409).send({ error: "company_reg_exists" });
        return reply.code(503).send({ error: "unavailable" });
      }
      if (record.digest !== digest) return reply.code(409).send({ error: "idempotency_conflict" });
      return reply.code(201).send({ tenant: await store.lookup(record.tenant_id), assets });
    });
    app.patch<{ Params: { id: string } }>("/api/platform/tenants/:id", async (req, reply) => {
      const operator = operators.get(req);
      if (!operator) return reply.code(403).send({ error: "forbidden" });
      const id = uuid.safeParse(req.params.id);
      const input = updateRequest.safeParse(req.body);
      if (!id.success || !input.success) return reply.code(422).send({ error: "invalid_tenant" });
      const tenant = await store.lookup(id.data);
      if (!tenant) return reply.code(404).send({ error: "not_found" });
      if (tenant.revision !== input.data.revision) return reply.code(409).send({ error: "tenant_changed" });
      const updated = await submit(operator, "updateTenantAndAgent", { ...input.data, organizationId: id.data });
      const current = await store.lookup(id.data);
      if (!updated) {
        const duplicate = await store.byCompanyReg(input.data.companyReg);
        if (duplicate && duplicate.tenantId !== id.data) return reply.code(409).send({ error: "company_reg_exists" });
        if (current && current.revision !== input.data.revision) return reply.code(409).send({ error: "tenant_changed" });
        return reply.code(503).send({ error: "unavailable" });
      }
      return { tenant: current, assets };
    });
    app.post<{ Params: { id: string } }>("/api/platform/tenants/:id/status", async (req, reply) => {
      const operator = operators.get(req);
      if (!operator) return reply.code(403).send({ error: "forbidden" });
      const id = uuid.safeParse(req.params.id);
      const enabled = (req.body as { enabled?: unknown } | null)?.enabled;
      if (!id.success || typeof enabled !== "boolean") return reply.code(422).send({ error: "invalid_status" });
      if (!await store.lookup(id.data)) return reply.code(404).send({ error: "not_found" });
      if (!await submit(operator, "setAgentInstallationEnabled", { organizationId: id.data, enabled })) {
        return reply.code(503).send({ error: "unavailable" });
      }
      return { tenant: await store.lookup(id.data) };
    });
    app.post<{ Params: { id: string } }>("/api/platform/tenants/:id/documents", async (req, reply) => {
      const operator = operators.get(req);
      if (!operator) return reply.code(403).send({ error: "forbidden" });
      const id = uuid.safeParse(req.params.id);
      const input = documentInput.safeParse(req.body);
      if (!id.success || !input.success || scrubText(input.data.content) !== input.data.content || scrubText(input.data.title) !== input.data.title ||
          !parseKnowledgeDoc({ id: "published-document", ...input.data, tags: [], visibility: "public" }).ok) {
        return reply.code(422).send({ error: "invalid_public_article" });
      }
      if (!await store.lookup(id.data)) return reply.code(404).send({ error: "not_found" });
      if (!await submit(operator, "publishAgentDocument", { ...input.data, organizationId: id.data })) {
        return reply.code(503).send({ error: "unavailable" });
      }
      return reply.code(201).send({ published: true });
    });
  });
}
