/** The reference host's public surface. */
export { composeReferenceHost } from "./compose.js";
export type { AiSession, ComposeOptions, ComposedHost, HostExtension, ReferenceHost } from "./compose.js";
export { ConfigError, loadConfig } from "./config.js";
export type { Environment, HostConfig } from "./config.js";
export { DevAuthError } from "./dev-auth/index.js";
export type { DevSession } from "./dev-auth/index.js";
export { DEMO_ACTION_IDS } from "./capabilities.js";
export type { Effect, ReceivedCall, TrustedHandle } from "./capabilities.js";
