/**
 * Development-only authentication stub (T132).
 *
 * !!! NOT FOR PRODUCTION. !!!
 * This is a deliberately tiny stand-in for a real authentication system: a fixed table of sessions read from trusted host configuration
 * (the environment value `DEV_SESSIONS`), looked up by an opaque token. There is no login, no password, no JWT/OAuth, no cookie handling
 * and no user database. It exists so the reference host can run end to end before a real identity provider is wired in.
 *
 * Safety properties:
 *  - It refuses to start when NODE_ENV=production, and without the explicit opt-in DAP_ALLOW_DEV_AUTH=1 (`assertDevAuthAllowed`).
 *  - Sessions come ONLY from that configuration. userId, tenantId, sessionId and the end of the session are copied from the matched
 *    session; nothing a proposal or the model says can supply or change them (the token is host transport evidence, never model output).
 *  - A malformed table (not JSON, empty, a bad field, an unknown field, a duplicate token or session id) fails startup. It never
 *    silently yields a permissive session.
 *  - Lookup uses a Map, so tokens like `__proto__` or `constructor` match nothing.
 *  - An unknown, malformed or expired token authenticates nobody (null): no context is minted downstream.
 *  - Tokens are never logged and never appear in an error message.
 */
import { z } from "zod";
import type { AuthenticatedPrincipal, AuthenticationPort, Clock } from "@dap/contracts";

/** Raised for a refused dev-auth start or a malformed `DEV_SESSIONS`. The message never contains a token or any configured value. */
export class DevAuthError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DevAuthError";
  }
}

/** One configured development session. `permissions` are what the host's demo permission checker grants to THIS session. */
export interface DevSession {
  readonly token: string;
  readonly userId: string;
  readonly tenantId: string;
  readonly sessionId: string;
  /** End of the session (ISO 8601 with a zone). A session whose end has passed authenticates nobody. */
  readonly validUntil: string;
  readonly permissions: readonly string[];
}

const MAX_SESSIONS = 100;
const identifier = z.string().regex(/^[A-Za-z0-9._:@-]{1,128}$/);
const tenant = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/).refine((value) => value !== "00000000-0000-0000-0000-000000000000");
const sessionSchema = z.strictObject({
  token: z.string().regex(/^[A-Za-z0-9._~+/=-]{16,256}$/),
  userId: identifier,
  tenantId: tenant,
  sessionId: identifier,
  validUntil: z.iso.datetime({ offset: true }),
  permissions: z.array(z.string().regex(/^perm\.[a-z0-9.-]{1,64}$/)).max(32).default([]),
});

/** Refuses to enable development authentication in production, or without the explicit opt-in. */
export function assertDevAuthAllowed(env: Readonly<Record<string, string | undefined>>): void {
  if (env.NODE_ENV?.trim().toLowerCase() === "production") throw new DevAuthError("Development authentication is refused when NODE_ENV=production");
  if (env.DAP_ALLOW_DEV_AUTH !== "1") throw new DevAuthError("Development authentication requires the explicit opt-in DAP_ALLOW_DEV_AUTH=1");
}

/** Parses and validates `DEV_SESSIONS` (a JSON array of sessions). Anything malformed throws; no partial result is ever returned. */
export function parseDevSessions(raw: string | undefined): readonly DevSession[] {
  if (raw === undefined || raw.trim().length === 0) throw new DevAuthError("DEV_SESSIONS is required");
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new DevAuthError("DEV_SESSIONS is not valid JSON"); }
  if (!Array.isArray(parsed) || parsed.length === 0 || parsed.length > MAX_SESSIONS) throw new DevAuthError(`DEV_SESSIONS must be a non-empty array of at most ${MAX_SESSIONS} sessions`);
  const sessions: DevSession[] = [];
  const tokens = new Set<string>();
  const sessionIds = new Set<string>();
  parsed.forEach((entry: unknown, index) => {
    const result = sessionSchema.safeParse(entry);
    if (!result.success) {
      // Field names only: an issue's value may be the token itself.
      const fields = [...new Set(result.error.issues.map((issue) => issue.path.join(".") || "(entry)"))].join(", ");
      throw new DevAuthError(`DEV_SESSIONS entry ${index} is malformed (fields: ${fields})`);
    }
    const session = result.data;
    if (tokens.has(session.token)) throw new DevAuthError(`DEV_SESSIONS entry ${index} repeats a token`);
    if (sessionIds.has(session.sessionId)) throw new DevAuthError(`DEV_SESSIONS entry ${index} repeats a session id`);
    if (new Set(session.permissions).size !== session.permissions.length) throw new DevAuthError(`DEV_SESSIONS entry ${index} repeats a permission`);
    tokens.add(session.token);
    sessionIds.add(session.sessionId);
    sessions.push(Object.freeze({ ...session, permissions: Object.freeze([...session.permissions]) }));
  });
  return Object.freeze(sessions);
}

/**
 * The `AuthenticationPort` over the configured sessions. The evidence is the session token the host's transport received.
 * Authentication time is "now" on the host's clock; the session ends at the configured `validUntil`.
 */
export function createDevAuthentication(sessions: readonly DevSession[], clock: Clock): AuthenticationPort<unknown> {
  const byToken = new Map<string, DevSession>(sessions.map((session) => [session.token, session]));
  return Object.freeze({
    async authenticate(evidence: unknown): Promise<AuthenticatedPrincipal | null> {
      if (typeof evidence !== "string") return null;
      const session = byToken.get(evidence);
      if (session === undefined) return null;
      const now = clock.now();
      if (Date.parse(session.validUntil) <= Date.parse(now)) return null;
      return { userId: session.userId, tenantId: session.tenantId, sessionId: session.sessionId, authenticatedAt: now, validUntil: session.validUntil };
    },
  });
}
