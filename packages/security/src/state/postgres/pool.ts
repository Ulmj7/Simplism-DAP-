/**
 * @dap/security: state/postgres/pool.ts
 *
 * The ONE place a composition root obtains a PostgreSQL connection pool for the security state stores. `pg` is allowed only under
 * state/postgres, so an application (the reference host) builds its pool here instead of importing the driver itself.
 *
 * The pool connects as whatever role the connection string names; the host must give it the unprivileged `dap_app` role (forced row level
 * security applies to it). An idle-client error must never crash the process: it is swallowed here, and the next statement on a broken
 * connection fails closed in the store that issued it.
 */
import { Pool } from "pg";

export interface PostgresPoolOptions {
  /** Upper bound of pooled connections (default 10). */
  readonly max?: number;
  /** How long a caller waits for a free connection before the store fails closed (default 2000 ms). */
  readonly connectionTimeoutMillis?: number;
}

export function createPostgresPool(connectionString: string, options: PostgresPoolOptions = {}): Pool {
  if (typeof connectionString !== "string" || connectionString.length === 0) throw new TypeError("A PostgreSQL connection string is required");
  let max: number; let timeout: number;
  try {
    const url = new URL(connectionString);
    max = options.max ?? 10;
    timeout = options.connectionTimeoutMillis ?? 2000;
    if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname || url.pathname.length <= 1 ||
      !Number.isSafeInteger(max) || max < 1 || !Number.isInteger(timeout) || timeout < 1 || timeout > 2147483647) throw new TypeError();
  } catch { throw new TypeError("Invalid PostgreSQL pool configuration"); }
  const pool = new Pool({ connectionString, max, connectionTimeoutMillis: timeout });
  pool.on("error", () => undefined);
  return pool;
}
