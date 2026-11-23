/**
 * C01 dev server: the one line printed when `npm run dev:host` fails to start. Fixed text per case; never an environment value or the raw error text
 * (a driver or socket error can carry a connection string, a host name or a path).
 */
import { ConfigError } from "../config.js";
import { DevAuthError } from "../dev-auth/index.js";
import { GuidanceConfigError } from "../guidance/anthropic-model.js";

/** Where startup was when it failed. */
export type StartupPhase = "config" | "compose" | "session" | "listen";

export const STARTUP_MESSAGES = Object.freeze({
  portInUse: "Guidance host could not start: the HTTP port on 127.0.0.1 is already in use. Stop the other process or set DAP_HTTP_PORT to a free port.",
  cannotBind: "Guidance host could not start: it cannot listen on 127.0.0.1 at the configured HTTP port (DAP_HTTP_PORT).",
  compose: "Guidance host could not start: the reference host could not be composed. Check that PostgreSQL is running and migrated and that DAP_DATABASE_URL points to it.",
  session: "Guidance host could not start: the demo session could not be opened. Check DAP_DEMO_SESSION_TOKEN and DEV_SESSIONS.",
  generic: "Guidance host startup failed.",
});

const codeOf = (error: unknown): unknown => (error !== null && typeof error === "object" && "code" in error ? error.code : undefined);

export function startupFailureMessage(error: unknown, phase: StartupPhase): string {
  // These configuration errors carry fixed messages that name a variable or a field, never its value.
  if (error instanceof GuidanceConfigError || error instanceof ConfigError || error instanceof DevAuthError) return error.message;
  if (phase === "listen") return codeOf(error) === "EADDRINUSE" ? STARTUP_MESSAGES.portInUse : STARTUP_MESSAGES.cannotBind;
  if (phase === "compose") return STARTUP_MESSAGES.compose;
  if (phase === "session") return STARTUP_MESSAGES.session;
  return STARTUP_MESSAGES.generic;
}
