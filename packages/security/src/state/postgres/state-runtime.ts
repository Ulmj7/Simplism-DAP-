import { z } from "zod";
import type { PoolClient } from "pg";
import type { TenantScope } from "@dap/contracts";

const uuid = z.uuid();
export function captureStateInput(scope: TenantScope, key: string): { readonly tenantId: string; readonly key: string } {
  const tenantId: unknown = scope?.tenantId;
  if (!uuid.safeParse(tenantId).success) throw new TypeError("Security state requires a UUID tenant");
  // Rejected BEFORE any query: PostgreSQL text cannot hold NUL, and a lone surrogate has no UTF-8 form, so the driver
  // would silently turn two different keys into the same U+FFFD text.
  if (typeof key !== "string" || key.length < 1 || key.length > 1024 || key.includes("\u0000") || /\p{Cs}/u.test(key) || Buffer.byteLength(key, "utf8") > 1024) throw new TypeError("Invalid security state key");
  return { tenantId: (tenantId as string).toLowerCase(), key };
}
export function stateInteger(value: unknown, maximum: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1 || value > maximum) throw new TypeError("Invalid security state integer");
  return value;
}

/**
 * TEST seam for a deterministic clock. It is a symbol that the package barrel does not export, so a production
 * composition root, a configuration object or anything a model or tenant influences cannot reach it by name; an ordinary
 * `now` option, or any other unknown key, is refused rather than quietly honoured.
 */
export const TEST_CLOCK: unique symbol = Symbol("dap.postgres-state.test-clock");
export interface PostgresStateTestOptions { readonly [TEST_CLOCK]?: (client: PoolClient) => Promise<Date> }
type StateClock = (client: PoolClient) => Promise<Date>;
export function resolveStateClock(options: unknown): StateClock {
  if (options === null || typeof options !== "object" || Array.isArray(options)) throw new TypeError("Invalid state options");
  const prototype: unknown = Object.getPrototypeOf(options);
  if (prototype !== Object.prototype && prototype !== null) throw new TypeError("Invalid state options");
  for (const key of Reflect.ownKeys(options)) if (key !== TEST_CLOCK) throw new TypeError("Unknown state option");
  const injected: unknown = Reflect.get(options, TEST_CLOCK);
  if (injected === undefined) return databaseNow;
  if (typeof injected !== "function") throw new TypeError("Invalid state clock");
  return injected as StateClock;
}
export async function databaseNow(client: PoolClient): Promise<Date> {
  const result = await client.query("SELECT clock_timestamp() AS now");
  const { command, rowCount, rows } = result;
  if (command !== "SELECT" || rowCount !== 1 || !Array.isArray(rows) || rows.length !== 1) throw new TypeError("Invalid database clock result");
  return checkedDate(rows[0]?.now);
}
export function checkedDate(value: unknown): Date {
  if (!(value instanceof Date) || !Number.isFinite(value.getTime())) throw new TypeError("Invalid database clock");
  return new Date(value.getTime());
}
