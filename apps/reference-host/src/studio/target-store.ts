/**
 * The Studio-managed registry store port (Studio V1B). Small on purpose: what registration, the managed registry read and the target status lever need, no generic repository.
 *
 * Trust: `scope` ({ tenantId, actor }) comes from the trusted context of the caller (the Gateway's `call.security` for writes, the host-resolved principal for reads), never from a request.
 * Every method is confined to the caller's tenant. The write methods run in ONE tenant transaction that first locks the application row FOR SHARE (see `application-lock.ts`), so an
 * application cannot be disabled, re-pointed or left behind between the check and the write.
 */
import type { TenantClient } from "../authoring/tenant-tx.js";
import type { TrustedRegistryData } from "../authoring/trusted-registry.js";
import type { ApplicationScope } from "./application-store.js";
import type { RegistryRouteRecord, TargetRegistration, TargetStatus, TargetView } from "./registry-targets.js";



/** The routes and the ACTIVE targets of a managed application, in registration order. A route whose targets are all disabled stays registered. */
export interface ManagedRegistry {
  readonly routes: readonly RegistryRouteRecord[];
  readonly elements: TrustedRegistryData["elements"];
}
export interface TargetListing {
  readonly targets: readonly TargetView[];
  readonly routes: readonly RegistryRouteRecord[];
}

export type RegisterOutcome =
  | { readonly kind: "created"; readonly route: { readonly route: string; readonly page: string; readonly created: boolean } }
  | { readonly kind: "application_not_found" | "application_disabled" | "registry_not_managed" | "target_exists" | "route_mismatch" | "registry_full" | "id_refused" | "page_refused" };
export type TargetStatusOutcome = "changed" | "unchanged" | "target_not_found" | "application_not_found" | "application_disabled" | "registry_not_managed" | "id_refused";

export interface TargetStore {
  /** Every target of the application (active and disabled) with its reference counts, and its routes. Empty for an unknown or foreign application. */
  list(tenantId: string, applicationId: string): Promise<TargetListing>;
  /** One target with its reference counts, or `null`. */
  get(tenantId: string, applicationId: string, targetId: string): Promise<TargetView | null>;
  /** The managed registry data a validator sees (active targets only), in its own tenant transaction. */
  registry(tenantId: string, applicationId: string): Promise<ManagedRegistry>;
  /** The same read inside a transaction the caller already holds (an executor validating inside its own write transaction). */
  registryIn(tx: TenantClient, tenantId: string, applicationId: string): Promise<ManagedRegistry>;
  /**
   * Registers one target. The application must exist in the tenant, be enabled and be Studio-managed. The page must follow the application's routing (`page_refused`). A page that already has a route must keep it (`route_mismatch`); a new page creates its
   * route in the SAME transaction. An existing id is `target_exists`; the caps (20 routes, 200 targets) are `registry_full`.
   */
  register(scope: ApplicationScope, applicationId: string, value: TargetRegistration): Promise<RegisterOutcome>;
  /** Disables (always allowed) or re-enables (needs the application enabled) a target. Nothing but the status ever changes. */
  setStatus(scope: ApplicationScope, applicationId: string, targetId: string, status: TargetStatus): Promise<TargetStatusOutcome>;
}
