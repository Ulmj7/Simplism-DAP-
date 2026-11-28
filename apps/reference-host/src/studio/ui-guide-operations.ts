import { createPublicKey, verify } from "node:crypto";
import { z } from "zod";
import { withTenant } from "../authoring/tenant-tx.js";
import type { TenantPool } from "../authoring/tenant-tx.js";
import type { WidgetInstallation } from "../platform/store.js";

export const audienceName = z.string().regex(/^[a-z][a-z0-9-]{0,40}$/u);
export const roleEndpoint = z.string().max(160).regex(/^\/(?!\/)[A-Za-z0-9._~/-]+$/u);
export const stopReason = z.enum(["missing", "ambiguous", "link-changed", "timeout", "expired", "unexpected-page"]);
const jwtHeader = z.strictObject({ alg: z.literal("EdDSA"), typ: z.literal("JWT").optional() });
const jwtClaims = z.strictObject({
  aud: z.string(), origin: z.string(), role: audienceName,
  iat: z.number().int(), exp: z.number().int(),
});

export function normalizeRoleKey(pem: string): string | null {
  try {
    if (!/^-----BEGIN PUBLIC KEY-----\r?\n[\sA-Za-z0-9+/=]+-----END PUBLIC KEY-----$/u.test(pem.trim())) return null;
    const key = createPublicKey(pem);
    return key.asymmetricKeyType === "ed25519" ? key.export({ type: "spki", format: "pem" }).toString() : null;
  } catch { return null; }
}

export function verifySaasRole(token: string, pem: string, installation: WidgetInstallation, now = Date.now()): string | null {
  if (token.length > 1500 || !/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]{86}$/u.test(token)) return null;
  const [header, body, signature] = token.split(".") as [string, string, string];
  try {
    if (!jwtHeader.safeParse(JSON.parse(Buffer.from(header, "base64url").toString("utf8"))).success ||
        !verify(null, Buffer.from(`${header}.${body}`), createPublicKey(pem), Buffer.from(signature, "base64url"))) return null;
    const claims = jwtClaims.safeParse(JSON.parse(Buffer.from(body, "base64url").toString("utf8")));
    if (!claims.success) return null;
    const { aud, origin, role, iat, exp } = claims.data;
    const seconds = Math.floor(now / 1000);
    if (aud !== installation.installationId || origin !== installation.origin || role === "legacy" ||
        iat > seconds + 10 || exp <= seconds || exp <= iat || exp - iat > 300) return null;
    return role;
  } catch { return null; }
}

type Scope = Pick<WidgetInstallation, "tenantId" | "applicationId">;
type Feedback = { kind: "completed"; index: number } |
  { kind: "stopped"; index: number; reason: z.infer<typeof stopReason> };

type Run = { id: string; origin: string; audience: string; revision: number; steps: string[]; startedAt: string; outcome: string; finishedAt: string | null; index: number | null; reason: string | null };
type RunEvent = { kind: string; index: number; at: string; reason?: string };

export function createUiGuideOperations(pool: TenantPool) {
  function keyScope(scope: Scope, origin: string) { return [scope.tenantId, scope.applicationId, origin]; }
  return {
    roleConfig(scope: Scope, origin: string) {
      return withTenant(pool, scope.tenantId, async tx => {
        const result = await tx.query("SELECT public_key AS key, endpoint FROM public.studio_ui_role_keys WHERE tenant_id = $1 AND application_id = $2 AND origin = $3",
          keyScope(scope, origin));
        return result.rows[0] as { key: string; endpoint: string } | undefined;
      });
    },
    setRoleKey(scope: Scope, origin: string, config: { key: string; endpoint: string } | null) {
      return withTenant(pool, scope.tenantId, async tx => {
        if (config === null) {
          await tx.query("DELETE FROM public.studio_ui_role_keys WHERE tenant_id = $1 AND application_id = $2 AND origin = $3", keyScope(scope, origin));
          return;
        }
        await tx.query(`INSERT INTO public.studio_ui_role_keys (tenant_id, application_id, origin, public_key, endpoint)
          VALUES ($1, $2, $3, $4, $5) ON CONFLICT (tenant_id, application_id, origin)
          DO UPDATE SET public_key = EXCLUDED.public_key, endpoint = EXCLUDED.endpoint`,
        [...keyScope(scope, origin), config.key, config.endpoint]);
      });
    },
    begin(installation: WidgetInstallation, audience: string, runId: string, revision: number, steps: readonly string[]) {
      return withTenant(pool, installation.tenantId, async tx => {
        await tx.query(`INSERT INTO public.studio_ui_guide_runs (tenant_id, application_id, origin, audience, run_id, revision, steps)
          VALUES ($1,$2,$3,$4,$5,$6,$7::text[])`,
        [...keyScope(installation, installation.origin), audience, runId, revision, steps]);
      });
    },
    step(installation: WidgetInstallation, runId: string, event: { kind: "highlighted" | "confirmed"; index: number }) {
      return withTenant(pool, installation.tenantId, async tx => {
        await tx.query(`INSERT INTO public.studio_ui_guide_events (tenant_id, application_id, origin, run_id, kind, step_index)
          SELECT tenant_id, application_id, origin, run_id, $5, $6 FROM public.studio_ui_guide_runs
          WHERE tenant_id = $1 AND application_id = $2 AND origin = $3 AND run_id = $4
            AND $6 < cardinality(steps) AND ($5 <> 'confirmed' OR $6 < cardinality(steps) - 1)
            AND (step_index IS NULL OR $6 <= step_index)
          ON CONFLICT DO NOTHING`, [...keyScope(installation, installation.origin), runId, event.kind, event.index]);
      });
    },
    purgeSteps(tenantId: string) {
      return withTenant(pool, tenantId, tx => tx.query(
        "DELETE FROM public.studio_ui_guide_events WHERE tenant_id = $1 AND recorded_at < now() - interval '7 days'", [tenantId]));
    },
    recent(scope: Scope & { allowedOrigins: string[] }) {
      return withTenant(pool, scope.tenantId, async tx => {
        const { rows } = await tx.query(`SELECT run_id AS id, origin, audience, started_at AS "startedAt", outcome
          FROM public.studio_ui_guide_runs WHERE tenant_id = $1 AND application_id = $2 AND origin = ANY($3::text[]) AND started_at >= now() - interval '7 days'
          ORDER BY started_at DESC LIMIT 30`, [scope.tenantId, scope.applicationId, scope.allowedOrigins]);
        return rows as Pick<Run, "id" | "origin" | "audience" | "startedAt" | "outcome">[];
      });
    },
    history(scope: Scope & { allowedOrigins: string[] }, id: string) {
      return withTenant(pool, scope.tenantId, async tx => {
        const { rows } = await tx.query(`SELECT run_id AS id, origin, audience, started_at AS "startedAt", outcome,
          steps, revision, step_index AS index, reason, finished_at AS "finishedAt" FROM public.studio_ui_guide_runs
          WHERE tenant_id = $1 AND application_id = $2 AND origin = ANY($3::text[]) AND started_at >= now() - interval '7 days' AND run_id = $4`, [scope.tenantId, scope.applicationId, scope.allowedOrigins, id]);
        const run = rows[0] as Run | undefined;
        if (!run) return null;
        const result = await tx.query(`SELECT kind, step_index AS index, recorded_at AS at FROM public.studio_ui_guide_events
          WHERE tenant_id = $1 AND application_id = $2 AND origin = $3 AND run_id = $4
            AND recorded_at >= now() - interval '7 days'
          ORDER BY step_index, CASE kind WHEN 'highlighted' THEN 0 ELSE 1 END`, [...keyScope(scope, run.origin), id]);
        const events: RunEvent[] = [{ kind: "started", index: 0, at: run.startedAt }, ...result.rows as RunEvent[]];
        if (run.index !== null) events.push({ kind: run.outcome, index: run.index, at: run.finishedAt ?? "", ...(run.reason ? { reason: run.reason } : {}) });
        return { ...run, events };
      });
    },
    finish(installation: WidgetInstallation, runId: string, event: Feedback) {
      return withTenant(pool, installation.tenantId, async tx => {
        await tx.query(`UPDATE public.studio_ui_guide_runs SET outcome = $5, step_index = $6, reason = $7, finished_at = now()
          WHERE tenant_id = $1 AND application_id = $2 AND origin = $3 AND run_id = $4 AND outcome = 'started'
            AND $6 < cardinality(steps) AND ($5 <> 'completed' OR $6 = cardinality(steps) - 1)`,
        [...keyScope(installation, installation.origin), runId, event.kind, event.index, event.kind === "stopped" ? event.reason : null]);
      });
    },
    report(scope: Scope, origin: string, audience: string) {
      return withTenant(pool, scope.tenantId, async tx => {
        const key = [...keyScope(scope, origin), audience];
        const summary = await tx.query(`
          SELECT count(*)::int AS started,
            count(*) FILTER (WHERE outcome = 'completed')::int AS completed,
            count(*) FILTER (WHERE outcome = 'stopped')::int AS stopped
          FROM public.studio_ui_guide_runs WHERE tenant_id = $1 AND application_id = $2
            AND origin = $3 AND audience = $4 AND started_at >= now() - interval '30 days'`, key);
        const failures = await tx.query(`
          SELECT revision, steps[step_index + 1] AS target, step_index AS step, reason,
            count(*)::int AS count, max(steps[1]) AS "firstTarget"
          FROM public.studio_ui_guide_runs WHERE tenant_id = $1 AND application_id = $2 AND origin = $3 AND audience = $4
            AND outcome = 'stopped' AND started_at >= now() - interval '30 days'
          GROUP BY 1,2,3,4 ORDER BY max(started_at) DESC LIMIT 25`, key);
        return { ...summary.rows[0], failures: failures.rows };
      });
    },
  };
}
