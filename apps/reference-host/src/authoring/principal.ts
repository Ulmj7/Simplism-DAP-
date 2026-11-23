/**
 * The DEV demo principal resolver (Feature 004, T406). NOT the authority.
 *
 * The browser has no login in this demo, so the dev server holds TWO server-side demo sessions, read from the environment: `DAP_DEMO_SESSION_TOKEN` (an ordinary user)
 * and an optional `DAP_DEMO_MAINTAINER_TOKEN` (a maintainer). The SPA sends `X-Demo-Role: user|maintainer` only to choose between the two for the demo; an unknown or
 * absent value means user, and `maintainer` without a configured maintainer token also means user. The header grants NOTHING by itself: the principal's permissions
 * come from the host's own session table (`DEV_SESSIONS`, the same table the Gateway's permission checker uses), so the security boundary is the per-request permission
 * check and the Gateway, exactly as for a real session. A real deployment replaces this file with real authentication. Tokens are never logged or returned.
 */
import type { IsoInstant } from "@dap/contracts";
import type { AiSession } from "../compose.js";
import { createDevAuthentication } from "../dev-auth/index.js";
import type { DevSession } from "../dev-auth/index.js";
import type { AuthoringPrincipal, RequestHeaders } from "./routes.js";

export type DemoRole = "user" | "maintainer";

/** `maintainer` only for the exact string "maintainer" (one header, not a list); everything else, including absence, is `user`. */
export function demoRoleFromHeaders(headers: RequestHeaders): DemoRole {
  return headers["x-demo-role"] === "maintainer" ? "maintainer" : "user";
}

export interface DemoPrincipalDeps {
  /** The host's own session table (parsed `DEV_SESSIONS`): where permissions come from. */
  readonly sessions: readonly DevSession[];
  readonly userToken: string;
  /** Optional: without it the maintainer role is unavailable and falls back to user. */
  readonly maintainerToken?: string | undefined;
  /** Opens a FRESH Gateway session for a token (one per write). */
  readonly openSession: (token: string) => Promise<AiSession | null>;
}

export function createDemoPrincipalResolver(deps: DemoPrincipalDeps): (headers: RequestHeaders) => Promise<AuthoringPrincipal | null> {
  const authentication = createDevAuthentication(deps.sessions, { now: () => new Date().toISOString() as IsoInstant });
  const byToken = new Map<string, DevSession>(deps.sessions.map((session) => [session.token, session]));
  const principalFor = (token: string, key: string): AuthoringPrincipal | null => {
    const session = byToken.get(token);
    if (session === undefined) return null;
    return Object.freeze({
      key, tenantId: session.tenantId, actor: session.userId, permissions: new Set(session.permissions),
      submit: async (call: Parameters<AiSession["submit"]>[0]) => { const opened = await deps.openSession(token); if (opened === null) throw new Error("no session"); return opened.submit(call); },
    });
  };
  const user = principalFor(deps.userToken, "dev-demo-user");
  const maintainer = deps.maintainerToken === undefined || deps.maintainerToken === "" ? null : principalFor(deps.maintainerToken, "dev-demo-maintainer");
  return async (headers) => {
    const useMaintainer = demoRoleFromHeaders(headers) === "maintainer" && maintainer !== null;
    const principal = useMaintainer ? maintainer : user;
    const token = useMaintainer ? deps.maintainerToken : deps.userToken;
    if (principal === null || await authentication.authenticate(token) === null) return null;
    return principal;
  };
}
