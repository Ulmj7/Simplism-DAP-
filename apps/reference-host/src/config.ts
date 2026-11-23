/**
 * Reference host configuration (T131): the validated environment. No configuration framework: a plain function over a plain environment
 * record. A missing or malformed value fails STARTUP; nothing falls back to a permissive default, and no error message carries a secret
 * (database password, session token).
 *
 *   DAP_DATABASE_URL     required   postgres(ql):// URL of the unprivileged application role (dap_app), from the environment only
 *   DAP_ENABLED_ACTIONS  required   comma-separated ids of the capabilities the GLOBAL allowlist enables (default deny): the demo capabilities,
 *                                   plus the ids added by host extensions passed to `composeReferenceHost` (none by default)
 *   DAP_GATEWAY_CONFIG   optional   a complete JSON GatewayConfig replacing the defaults (validated by the security package)
 *   NODE_ENV, DAP_ALLOW_DEV_AUTH, DEV_SESSIONS   development authentication (see dev-auth/)
 */
import type { GatewayConfig } from "@dap/contracts";
import { DEFAULT_GATEWAY_CONFIG, validateGatewayConfig } from "@dap/security";
import { DEMO_ACTION_IDS } from "./capabilities.js";
import { assertDevAuthAllowed, parseDevSessions } from "./dev-auth/index.js";
import type { DevSession } from "./dev-auth/index.js";

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

export interface HostConfig {
  readonly databaseUrl: string;
  readonly enabledActions: readonly string[];
  readonly gateway: GatewayConfig;
  readonly devSessions: readonly DevSession[];
}

export type Environment = Readonly<Record<string, string | undefined>>;

function databaseUrl(raw: string | undefined): string {
  if (raw === undefined || raw.length === 0) throw new ConfigError("DAP_DATABASE_URL is required");
  let url: URL;
  try { url = new URL(raw); } catch { throw new ConfigError("DAP_DATABASE_URL is not a valid URL"); }
  if (url.protocol !== "postgres:" && url.protocol !== "postgresql:") throw new ConfigError("DAP_DATABASE_URL must be a postgres:// or postgresql:// URL");
  if (url.hostname.length === 0 || url.pathname.length <= 1) throw new ConfigError("DAP_DATABASE_URL must name a host and a database");
  return raw;
}

function enabledActions(raw: string | undefined, extensionActionIds: readonly string[]): readonly string[] {
  if (raw === undefined || raw.trim().length === 0) throw new ConfigError("DAP_ENABLED_ACTIONS is required (the global allowlist is default deny)");
  const ids = raw.split(",").map((id) => id.trim());
  const known = new Set<string>([...DEMO_ACTION_IDS, ...extensionActionIds]);
  for (const id of ids) if (!known.has(id)) throw new ConfigError("DAP_ENABLED_ACTIONS names an unknown or empty capability id");
  if (new Set(ids).size !== ids.length) throw new ConfigError("DAP_ENABLED_ACTIONS repeats a capability id");
  return Object.freeze(ids);
}

function gatewayConfig(raw: string | undefined): GatewayConfig {
  if (raw === undefined) return DEFAULT_GATEWAY_CONFIG;
  let parsed: unknown;
  try { parsed = JSON.parse(raw); } catch { throw new ConfigError("DAP_GATEWAY_CONFIG is not valid JSON"); }
  try { return validateGatewayConfig(parsed); } catch { throw new ConfigError("DAP_GATEWAY_CONFIG is not a valid gateway configuration"); }
}

/**
 * Validates the environment. Throws `ConfigError` / `DevAuthError` (no secret in either message) on the first problem.
 * `extensionActionIds` are the capability ids contributed by host extensions; they only widen the list of KNOWN ids. Whether one is ENABLED is still decided
 * solely by `DAP_ENABLED_ACTIONS` (default deny). Without extensions the known list is exactly the demo list.
 */
export function loadConfig(env: Environment, extensionActionIds: readonly string[] = []): HostConfig {
  assertDevAuthAllowed(env);
  return Object.freeze({
    databaseUrl: databaseUrl(env.DAP_DATABASE_URL),
    enabledActions: enabledActions(env.DAP_ENABLED_ACTIONS, extensionActionIds),
    gateway: gatewayConfig(env.DAP_GATEWAY_CONFIG),
    devSessions: parseDevSessions(env.DEV_SESSIONS),
  });
}
