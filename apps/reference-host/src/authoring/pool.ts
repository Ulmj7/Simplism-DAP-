/**
 * The authoring store's own database pool (Feature 004). The dev server builds ONE from `DAP_DATABASE_URL` (the unprivileged `dap_app` role, forced row-level security
 * applies) next to the Gateway's pool, because `composeReferenceHost` keeps its pool private. `createPostgresPool` is the public `@dap/security` entry for exactly this;
 * this file is the authoring code's only import of that package, and the pool type the rest of it uses comes from here, so no module declares a database driver.
 */
import { createPostgresPool } from "@dap/security";

export type TenantPool = ReturnType<typeof createPostgresPool>;

/** A small pool: authoring is a handful of maintainer requests, never a hot path. */
export function createAuthoringPool(databaseUrl: string): TenantPool {
  return createPostgresPool(databaseUrl, { max: 4 });
}
