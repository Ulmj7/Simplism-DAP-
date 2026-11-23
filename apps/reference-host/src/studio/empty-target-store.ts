/**
 * A TargetStore with no Studio-managed registries at all: every managed application resolves to an empty registry and every write is refused. It is the default of the authoring executors and
 * routes when composition passes no store (the V1A tests), so built-in applications behave byte for byte as before. Production composition always passes the PostgreSQL store.
 */
import type { TargetStore } from "./target-store.js";

export const emptyTargetStore: TargetStore = Object.freeze({
  list: async () => ({ targets: [], routes: [] }),
  get: async () => null,
  registry: async () => ({ routes: [], elements: [] as never, markers: {}, checks: [] }),
  registryIn: async () => ({ routes: [], elements: [] as never, markers: {}, checks: [] }),
  register: async () => ({ kind: "registry_not_managed" as const }),
  setStatus: async () => "registry_not_managed" as const,
  definitionsUsing: async () => [],
  changes: async () => [],
  setHealth: async () => "registry_not_managed" as const,
  checks: async () => [],
  registerCheck: async () => ({ kind: "registry_not_managed" as const }),
  setCheckStatus: async () => "registry_not_managed" as const,
  repair: async () => ({ kind: "registry_not_managed" as const }),
});
