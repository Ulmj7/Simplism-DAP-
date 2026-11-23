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
import type { CheckContent, CheckRecord, CheckStatus, CheckView } from "./registry-checks.js";
import type { RegistryRouteRecord, TargetHealth, TargetRecord, TargetRegistration, TargetRepair, TargetStatus, TargetView } from "./registry-targets.js";



/** The routes and the ACTIVE targets of a managed application, in registration order. A route whose targets are all disabled stays registered. */
export interface ManagedRegistry {
  readonly routes: readonly RegistryRouteRecord[];
  readonly elements: TrustedRegistryData["elements"];
  /** Target id -> the `data-ai-id` marker the page carries for it (the runtime and the embed resolve the DOM by it). */
  readonly markers: Readonly<Record<string, string>>;
  /** The ACTIVE verification checks (S4) whose target, when they have one, is ACTIVE: a check whose target is disabled drops out of the registry, so a guide that names it stops validating. */
  readonly checks: readonly CheckRecord[];
}
export interface TargetListing {
  readonly targets: readonly TargetView[];
  readonly routes: readonly RegistryRouteRecord[];
}

export type RegisterOutcome =
  | { readonly kind: "created"; readonly route: { readonly route: string; readonly page: string; readonly created: boolean } }
  | { readonly kind: "application_not_found" | "application_disabled" | "registry_not_managed" | "target_exists" | "route_mismatch" | "registry_full" | "id_refused" | "page_refused" };
export type HealthOutcome = "changed" | "unchanged" | "target_not_found" | "application_not_found" | "registry_not_managed" | "id_refused";
/** One stored workflow that names a target: a draft or a published head (the version snapshots join with the versioning order; `version` is 1 until then, `null` for a draft). */
export interface DefinitionUsing { readonly id: string; readonly title: string; readonly status: "draft" | "published"; readonly version: number | null; readonly definition: unknown }
/** The five fields a repair can change, as stored (the change history records exactly these). */
export interface RepairFields { readonly marker: string; readonly role: string; readonly operations: readonly string[]; readonly label: string; readonly description: string }
export interface RepairImpact {
  readonly drafts: readonly { readonly id: string; readonly title: string }[];
  readonly published: readonly { readonly id: string; readonly title: string; readonly version: number }[];
}
/** Decides, inside the repair's own transaction, whether every workflow that names the target still validates against the registry AS IT IS AFTER the repair: the problems, or `[]`. */
export type RepairVerify = (definitions: readonly DefinitionUsing[], registry: ManagedRegistry, target: TargetRecord) => readonly string[];
export type RepairOutcome =
  | { readonly kind: "repaired"; readonly target: TargetView; readonly before: RepairFields; readonly after: RepairFields; readonly impact: RepairImpact }
  | { readonly kind: "incompatible"; readonly problems: readonly string[] }
  | { readonly kind: "application_not_found" | "application_disabled" | "registry_not_managed" | "target_not_found" | "marker_in_use" | "unchanged" | "id_refused" };
export type CheckRegisterOutcome =
  | { readonly kind: "created" | "existing" }
  | { readonly kind: "application_not_found" | "application_disabled" | "registry_not_managed" | "target_not_found" | "target_disabled" | "route_not_found" | "role_refused" | "registry_full" | "id_refused" };
export type CheckStatusOutcome = "changed" | "unchanged" | "check_not_found" | "application_not_found" | "application_disabled" | "registry_not_managed" | "id_refused";
export type TargetStatusOutcome = "changed" | "unchanged" | "target_not_found" | "application_not_found" | "application_disabled" | "registry_not_managed" | "id_refused";

export interface TargetChange { readonly revision: number; readonly changedAt: string; readonly changedBy: string; readonly before: RepairFields; readonly after: RepairFields }

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
  /** Every stored workflow of the application that names the target (drafts and published heads), newest first, at most 200. The single place to extend when published versions arrive. */
  definitionsUsing(tenantId: string, applicationId: string, targetId: string): Promise<readonly DefinitionUsing[]>;
  /** The newest change rows of a target (at most `limit`, newest first). */
  changes(tenantId: string, applicationId: string, targetId: string, limit: number): Promise<readonly TargetChange[]>;
  /** Records an observation of the target's health. Free to change (it is not identity); never needs the application to be enabled. */
  setHealth(scope: ApplicationScope, applicationId: string, targetId: string, health: TargetHealth): Promise<HealthOutcome>;
  /**
   * Repairs a target (D-S3): new marker, role, operations, label and description; health becomes `healthy`, the revision rises by one and a change row is written, in ONE transaction that
   * holds the application row FOR SHARE and the target row FOR UPDATE. `verify` runs inside it after the change is applied; any problem rolls everything back (`incompatible`).
   */
  repair(scope: ApplicationScope, applicationId: string, targetId: string, value: TargetRepair, verify: RepairVerify): Promise<RepairOutcome>;
  /** Every check of the application (active and disabled) with the number of stored guides that name it, oldest first. */
  checks(tenantId: string, applicationId: string): Promise<readonly CheckView[]>;
  /**
   * Registers one check (the NAME is derived by the caller from the content and re-derived by the database). Create-or-get: a check that already exists (same name) is `existing` and is left exactly as it is.
   * The application must exist, be enabled and be Studio-managed; an element check needs an ACTIVE target (`target_disabled`), `element.value.equals` a textbox, select or checkbox (`role_refused`), `route.equals` a registered route.
   */
  registerCheck(scope: ApplicationScope, applicationId: string, value: CheckContent & { readonly name: string }): Promise<CheckRegisterOutcome>;
  /** Disables (always allowed) or re-enables (needs the application enabled) a check. Nothing but the status ever changes. */
  setCheckStatus(scope: ApplicationScope, applicationId: string, name: string, status: CheckStatus): Promise<CheckStatusOutcome>;
  /** Disables (always allowed) or re-enables (needs the application enabled) a target. Nothing but the status ever changes. */
  setStatus(scope: ApplicationScope, applicationId: string, targetId: string, status: TargetStatus): Promise<TargetStatusOutcome>;
}
