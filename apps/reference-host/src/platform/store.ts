import { createHash, randomBytes, randomUUID } from "node:crypto";
import { z } from "zod";
import { withTenant } from "../authoring/tenant-tx.js";
import type { TenantPool } from "../authoring/tenant-tx.js";

export const uuid = z.string().length(36).regex(/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/u);
const label = (limit: number) => z.string().trim().min(1).max(limit).regex(/^[^\p{Cc}<>]+$/u);
const partnerOrigin = z.string().trim().max(190).refine(value => {
  try {
    const url = new URL(value);
    if (url.origin !== value) return false;
    if (["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)) {
      return url.protocol === "http:" || url.protocol === "https:";
    }
    return url.protocol === "https:" && /^[a-z0-9-]+(?:\.[a-z0-9-]+)+$/u.test(url.hostname)
      && !/^[\d.]+$/u.test(url.hostname);
  } catch { return false; }
});
const optionalText = (limit: number) => label(limit).optional();
export const tenantInput = z.strictObject({
  name: label(80),
  companyReg: z.string().trim().toUpperCase().min(1).max(64).regex(/^[\p{L}\p{N}][\p{L}\p{N} .-]*$/u),
  allowedOrigins: z.array(partnerOrigin).min(1).max(20).refine(origins => new Set(origins).size === origins.length).readonly(),
  address: optionalText(300),
  phoneNumber: z.string().trim().min(3).max(32).regex(/^\+?[0-9(). -]+$/u).optional(),
  contactEmail: z.string().trim().max(254).pipe(z.email()).optional(),
  agentName: optionalText(100),
});
export const createInput = tenantInput.extend({ organizationId: uuid, requestKey: uuid });
const revision = z.number().int().nonnegative();
export const updateRequest = tenantInput.extend({ revision });
export const updateInput = updateRequest.extend({ organizationId: uuid });
export const statusInput = z.strictObject({ organizationId: uuid, enabled: z.boolean() });
export const documentInput = z.strictObject({ title: label(80), content: z.string().trim().min(1).max(8000) });
export type CreateInput = z.infer<typeof createInput>;

export interface WidgetInstallation {
  tenantId: string;
  applicationId: string;
  installationId: string;
  origin: string;
  agentName: string;
  sessionEpoch: number;
}

export interface Installation extends WidgetInstallation {
  agentId: string;
  name: string;
  slug: string;
  companyReg: string | null;
  allowedOrigins: string[];
  address: string | null;
  phoneNumber: string | null;
  contactEmail: string | null;
  enabled: boolean;
  revision: number;
  lastConnectedAt: Date | null;
  createdAt: Date;
}

const widgetColumns = `tenant_id AS "tenantId", application_id AS "applicationId",
  installation_id AS "installationId", agent_name AS "agentName", session_epoch AS "sessionEpoch"`;
const directory = `SELECT ${widgetColumns}, origin, agent_id AS "agentId", name, slug, company_reg AS "companyReg",
  allowed_origins AS "allowedOrigins", address, phone_number AS "phoneNumber", contact_email AS "contactEmail",
  enabled, revision, last_connected_at AS "lastConnectedAt", created_at AS "createdAt"
  FROM public.platform_installations`;

export const hash = (value: string) => createHash("sha256").update(value).digest("hex");
export const inputDigest = (input: z.infer<typeof tenantInput>) => hash(JSON.stringify([
  input.name, input.companyReg, input.allowedOrigins, input.address ?? null, input.phoneNumber ?? null,
  input.contactEmail ?? null, input.agentName ?? null,
]));

function profileValues(input: z.infer<typeof tenantInput>) {
  return [
    input.name, input.companyReg, input.allowedOrigins, input.address ?? null, input.phoneNumber ?? null,
    input.contactEmail ?? null, input.agentName ?? `${input.name} Help`, input.allowedOrigins[0]!,
  ];
}

export function platformStore(pool: TenantPool) {
  const lookup = async (id: string) => (await pool.query<Installation>(`${directory} WHERE tenant_id = $1`, [id])).rows[0];
  async function byCompanyReg(companyReg: string) {
    return (await pool.query<{ tenantId: string }>(
      'SELECT tenant_id AS "tenantId" FROM public.platform_installations WHERE company_reg = $1', [companyReg],
    )).rows[0];
  }
  async function operation(actor: string, key: string) {
    return (await pool.query<{ digest: string; tenant_id: string }>(
      "SELECT digest, tenant_id FROM public.platform_operations WHERE actor = $1 AND request_key = $2", [actor, key])).rows[0];
  }
  return {
    lookup, operation, byCompanyReg,
    async list(offset: number) {
      return (await pool.query<Installation>(`${directory} ORDER BY created_at DESC, tenant_id LIMIT 51 OFFSET $1`, [offset])).rows;
    },
    async resolve(id: string, origin: string) {
      return (await pool.query<WidgetInstallation>(
        `SELECT ${widgetColumns}, $2::text AS origin FROM public.platform_installations
         WHERE installation_id = $1 AND $2 = ANY(allowed_origins) AND enabled`, [id, origin],
      )).rows[0];
    },
    async connect(installation: WidgetInstallation) {
      await pool.query(`UPDATE public.platform_installations SET last_connected_at = now()
        WHERE installation_id = $1 AND enabled AND (last_connected_at IS NULL OR last_connected_at < now() - interval '1 minute')`, [installation.installationId]);
    },
    async create(actor: string, input: CreateInput) {
      const { organizationId: tenantId, requestKey, name, companyReg, allowedOrigins } = input;
      const slugBase = name.toLowerCase().replace(/[^a-z0-9]+/gu, "-").slice(0, 35).replace(/^-|-$/gu, "");
      const slug = `${slugBase || "org"}-${hash(companyReg).slice(0, 20)}`;
      const applicationId = `app-${randomBytes(6).toString("hex")}`;
      const origin = allowedOrigins[0]!;
      await withTenant(pool, tenantId, async tx => {
        await tx.query(`INSERT INTO public.studio_applications
          (tenant_id, application_id, name, origin, allowed_origins, environment, registry_id, created_by, updated_by)
          VALUES ($1,$2,$3,$4,ARRAY[$4]::text[],'test','studio-managed',$5,$5)`, [tenantId, applicationId, name, origin, actor]);
        await tx.query(`INSERT INTO public.platform_installations
          (tenant_id, application_id, agent_id, installation_id, slug, name, company_reg, allowed_origins,
           address, phone_number, contact_email, agent_name, origin)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13)`,
        [tenantId, applicationId, randomUUID(), randomUUID(), slug, ...profileValues(input)]);
        await tx.query("INSERT INTO public.platform_operations (actor, request_key, digest, tenant_id) VALUES ($1,$2,$3,$4)",
          [actor, requestKey, inputDigest(input), tenantId]);
        await tx.query("INSERT INTO public.platform_agent_audit (tenant_id, actor, event) VALUES ($1,$2,'TenantCreated')", [tenantId, actor]);
      });
    },
    async update(actor: string, input: z.infer<typeof updateInput>) {
      return withTenant(pool, input.organizationId, async tx => {
        const changed = await tx.query(`UPDATE public.platform_installations
          SET name = $1, company_reg = $2, allowed_origins = $3, address = $4, phone_number = $5,
              contact_email = $6, agent_name = $7, origin = $8, revision = revision + 1
          WHERE tenant_id = $9 AND revision = $10`, [...profileValues(input), input.organizationId, input.revision]);
        if (!changed.rowCount) return false;
        await tx.query("INSERT INTO public.platform_agent_audit (tenant_id, actor, event) VALUES ($1,$2,'TenantUpdated')",
          [input.organizationId, actor]);
        return true;
      });
    },
    async setEnabled(actor: string, tenantId: string, enabled: boolean) {
      await withTenant(pool, tenantId, async tx => {
        const changed = await tx.query("UPDATE public.platform_installations SET enabled = $2, session_epoch = session_epoch + 1 WHERE tenant_id = $1 AND enabled <> $2", [tenantId, enabled]);
        if (changed.rowCount) await tx.query("INSERT INTO public.platform_agent_audit (tenant_id,actor,event) VALUES ($1,$2,$3)",
          [tenantId, actor, enabled ? "InstallationEnabled" : "InstallationDisabled"]);
      });
    },
    async documents(installation: WidgetInstallation) {
      return withTenant(pool, installation.tenantId, async tx => (await tx.query(
        "SELECT id, title, content FROM public.agent_documents WHERE tenant_id = $1 AND application_id = $2 ORDER BY id LIMIT 100",
        [installation.tenantId, installation.applicationId])).rows.map(row => ({ id: String(row.id), title: String(row.title), content: String(row.content) })));
    },
    async publishDocument(installation: Installation, input: z.infer<typeof documentInput>) {
      return withTenant(pool, installation.tenantId, async tx => {
        await tx.query("SELECT pg_advisory_xact_lock(hashtextextended($1, 0))", [installation.tenantId]);
        const existing = await tx.query("SELECT count(*)::int AS count FROM public.agent_documents WHERE tenant_id = $1 AND application_id = $2",
          [installation.tenantId, installation.applicationId]);
        if (Number(existing.rows[0]?.count) >= 100) return false;
        await tx.query("INSERT INTO public.agent_documents (tenant_id, application_id, id, title, content) VALUES ($1,$2,$3,$4,$5)",
          [installation.tenantId, installation.applicationId, randomUUID(), input.title, input.content]);
        return true;
      });
    },
  };
}

export type PlatformStore = ReturnType<typeof platformStore>;
