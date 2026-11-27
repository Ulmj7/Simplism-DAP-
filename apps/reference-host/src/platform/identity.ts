import { timingSafeEqual } from "node:crypto";
import type { FastifyRequest } from "fastify";
import type { AuthenticatedPrincipal, ResourceRef } from "@dap/contracts";
import type { ComposeOptions } from "../compose.js";
import { hash } from "./store.js";

export const PLATFORM_SCOPE = "9da201c6-2f54-4e13-9f27-459caba8cb2a";
export type Operator = AuthenticatedPrincipal;

export function operatorAuth(env: NodeJS.ProcessEnv) {
  const secret = env.DAP_PLATFORM_PROXY_SECRET;
  const subjectList = env.DAP_PLATFORM_OPERATOR_SUBJECTS;
  const issuer = env.DAP_PLATFORM_OIDC_ISSUER;
  if (!secret || secret.length < 32 || !subjectList || !issuer) throw new Error("Missing platform identity configuration");
  const subjects = new Set(subjectList.split(",").map(subject => subject.trim()).filter(Boolean));
  if (!subjects.size || new URL(issuer).protocol !== "https:") throw new Error("Invalid platform identity configuration");
  const authority = createPlatformIdentity();

  function resolve(headers: FastifyRequest["headers"]): Operator | null {
    const key = headers["x-dap-proxy-key"];
    const subject = headers["x-dap-oidc-subject"];
    if (typeof key !== "string" || key.length > 512 || !timingSafeEqual(Buffer.from(hash(key)), Buffer.from(hash(secret!)))) return null;
    if (typeof subject !== "string" || !subjects.has(subject) || headers["x-dap-oidc-issuer"] !== issuer || headers["x-dap-oidc-mfa"] !== "1") return null;
    const now = Date.now();
    return authority.trust({
      userId: `operator-${hash(JSON.stringify([issuer, subject]))}`,
      tenantId: PLATFORM_SCOPE,
      sessionId: `platform-${hash(JSON.stringify([issuer, subject]))}`,
      authenticatedAt: new Date(now).toISOString(),
      validUntil: new Date(now + 60_000).toISOString(),
    });
  }
  return { resolve, forTenant: authority.forTenant, identity: authority.identity };
}

export function createPlatformIdentity() {
  const trusted = new WeakSet<object>();

  function forTenant(operator: Operator, tenantId: string): Operator {
    const scoped = Object.freeze({ ...operator, tenantId });
    trusted.add(scoped);
    return scoped;
  }
  const identity: NonNullable<ComposeOptions["identity"]> = {
    authentication: { authenticate: async candidate =>
      typeof candidate === "object" && candidate !== null && trusted.has(candidate) ? candidate as Operator : null },
    permissions: { has: async (context, permission) =>
      context.userId.startsWith("operator-") &&
      (context.tenantId === PLATFORM_SCOPE ? permission === "perm.platform.tenant.manage" : permission === "perm.walkthrough.maintain") },
    resources: { resolve: async (context, ref: ResourceRef, permission) =>
      (context.tenantId === PLATFORM_SCOPE
        ? ref.type === "platformTenant" && permission === "perm.platform.tenant.manage"
        : ["studioApplication", "walkthrough"].includes(ref.type) && permission === "perm.walkthrough.maintain")
        ? { ref, tenantId: context.tenantId, displayName: "Platform installation" } : null },
  };
  function trust(operator: Operator): Operator {
    const principal = Object.freeze({ ...operator });
    trusted.add(principal);
    return principal;
  }
  return { trust, forTenant, identity };
}
