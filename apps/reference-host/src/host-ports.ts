/**
 * The reference host's demo ports (T131): the trusted facts the Gateway asks the host for. Minimum explicit demo behavior, not a framework.
 * Every answer is derived from the trusted AuthorizationContext (and the host's own configuration). Nothing here reads a proposal, a
 * parameter, or anything the model wrote as authority.
 */
import type { AuthorizationContext, PageContextProvider, PermissionChecker, PermissionId, ResolvedResource, ResourceAuthorizer, ResourceRef } from "@dap/contracts";
import { isAuthoredId } from "./authoring/ids.js";
import type { DevSession } from "./dev-auth/index.js";
import { isApplicationId } from "./studio/applications.js";

/** What each session may do, from the dev-session table. Keyed by the trusted session id of the context. */
export function createPermissionChecker(sessions: readonly DevSession[]): PermissionChecker {
  const grants = new Map<string, ReadonlySet<string>>(sessions.map((session) => [session.sessionId, new Set(session.permissions)]));
  return Object.freeze({ has: async (ctx: AuthorizationContext, permission: PermissionId): Promise<boolean> => grants.get(ctx.sessionId)?.has(permission) === true });
}

/**
 * Notes are private to the tenant of the caller: a note reference resolves only inside the caller's OWN tenant (taken from the context)
 * and only for a session that holds the permission. A reference to anything else resolves to null, which is also what "not found" and
 * "another tenant's" look like to the Gateway. (Feature 004 adds the same rule for `walkthrough` references.)
 */
export function createResourceAuthorizer(sessions: readonly DevSession[]): ResourceAuthorizer {
  const permissions = createPermissionChecker(sessions);
  return Object.freeze({
    async resolve(ctx: AuthorizationContext, ref: ResourceRef, permission: PermissionId): Promise<ResolvedResource | null> {
      if (ref.type === "note" && await permissions.has(ctx, permission)) return { ref: { type: "note", id: ref.id }, tenantId: ctx.tenantId, displayName: `Note ${ref.id}` };
      // Feature 004: an authored walkthrough resolves by the SAME rule as a note: only inside the caller's OWN tenant (from the context), only for a session holding the
      // permission, and only for a well-formed authored id. Whether the guide exists is the executor's business (`not_found`), exactly as for a note.
      if (ref.type === "walkthrough" && isAuthoredId(ref.id) && await permissions.has(ctx, permission)) return { ref: { type: "walkthrough", id: ref.id }, tenantId: ctx.tenantId, displayName: `Walkthrough ${ref.id}` };
      // Studio V1A: an application resolves by the SAME rule: only inside the caller's OWN tenant (from the context), only for a session holding the permission and only for a
      // well-formed application id. Whether the application exists is the executor's business (`not_found`).
      if (ref.type === "studioApplication" && isApplicationId(ref.id) && await permissions.has(ctx, permission)) return { ref: { type: "studioApplication", id: ref.id }, tenantId: ctx.tenantId, displayName: `Application ${ref.id}` };
      return null;
    },
  });
}

/** The demo has no page model: no page narrowing (the capabilities allow any page). */
export function createPageContextProvider(): PageContextProvider {
  return Object.freeze({ currentPage: async () => null });
}
