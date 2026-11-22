/**
 * The async registry resolver (Studio V1B, D1): one answer to "which trusted registry does this application use?", for both sources.
 *
 *   built-in        the host-code catalog entry named by `registryId` (V1A, unchanged; `referenceOverride` is the Feature 004 test seam for the `reference` entry only)
 *   studio-managed  the application's ACTIVE targets and its routes from PostgreSQL (`TargetStore`), with the managed postconditions `route.<route>` (D10)
 *
 * A guide written before Studio has no application and resolves to `reference`. Resolution is always tenant-scoped. `resolveIn` runs the managed read inside a transaction the caller already
 * holds (a capability executor validating inside its own write transaction); the built-in path needs no database. `undefined` means the application's registry cannot be found (a catalog no
 * longer holding its key): callers fail closed.
 */
import type { TenantClient } from "../authoring/tenant-tx.js";
import type { TrustedRegistryData } from "../authoring/trusted-registry.js";
import type { ApplicationRecord, RegistrySource } from "./applications.js";
import { STUDIO_MANAGED_REGISTRY_ID, registrySourceOf } from "./applications.js";
import { managedPostconditionName } from "./registry-targets.js";
import { REFERENCE_REGISTRY_ID } from "./registries.js";
import type { RegistryCatalog } from "./registries.js";
import type { ManagedRegistry, TargetStore } from "./target-store.js";

export interface ResolvedRegistry {
  readonly source: RegistrySource;
  readonly registry: TrustedRegistryData;
  /** `pathname + hash` of a page -> the registry route it shows. */
  readonly pages: Readonly<Record<string, string>>;
  /** `in-app`: Preview remounts the draft inside the reference web app; `application-window`: it runs in the application's own window through the embed. */
  readonly previewMode: "in-app" | "application-window";
  readonly previewable: boolean;
}
export interface RegistryResolver {
  resolve(tenantId: string, application: ApplicationRecord | null): Promise<ResolvedRegistry | undefined>;
  resolveIn(tx: TenantClient, tenantId: string, application: ApplicationRecord | null): Promise<ResolvedRegistry | undefined>;
}

/** The registry data of a managed application from its stored routes and active targets. Pure. */
export function managedRegistryData(managed: ManagedRegistry): ResolvedRegistry {
  const routes = managed.routes.map((entry) => entry.route);
  const pages = Object.freeze(Object.fromEntries(managed.routes.map((entry) => [entry.page, entry.route])));
  return Object.freeze({
    source: "studio-managed" as const,
    registry: Object.freeze({ routes: Object.freeze(routes), elements: managed.elements, postconditionNames: Object.freeze(routes.map(managedPostconditionName)) }),
    pages, previewMode: "application-window" as const, previewable: routes.length > 0,
  });
}

export function createRegistryResolver(deps: { readonly catalog: RegistryCatalog; readonly targets: TargetStore; readonly referenceOverride?: TrustedRegistryData }): RegistryResolver {
  const builtIn = (registryId: string): ResolvedRegistry | undefined => {
    const entry = deps.catalog.get(registryId);
    if (entry === undefined) return undefined;
    const registry = registryId === REFERENCE_REGISTRY_ID && deps.referenceOverride !== undefined ? deps.referenceOverride : entry.registry;
    return Object.freeze({ source: "built-in" as const, registry, pages: entry.browser.pages, previewMode: "in-app" as const, previewable: entry.previewable });
  };
  const resolver: RegistryResolver = {
    async resolve(tenantId, application) {
      if (application === null) return builtIn(REFERENCE_REGISTRY_ID);
      if (registrySourceOf(application.registryId) === "studio-managed") return managedRegistryData(await deps.targets.registry(tenantId, application.id));
      return builtIn(application.registryId);
    },
    async resolveIn(tx, tenantId, application) {
      if (application === null) return builtIn(REFERENCE_REGISTRY_ID);
      if (application.registryId === STUDIO_MANAGED_REGISTRY_ID) return managedRegistryData(await deps.targets.registryIn(tx, tenantId, application.id));
      return builtIn(application.registryId);
    },
  };
  return Object.freeze(resolver);
}
