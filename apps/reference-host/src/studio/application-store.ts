/**
 * The Application store port (Studio V1A). Small on purpose: exactly the operations the enrollment capabilities and the maintainer routes need, no generic repository.
 *
 * Trust: `scope` ({ tenantId, actor }) comes from the trusted context of the caller (the Gateway's `call.security` for writes, the host-resolved principal for reads),
 * never from a request body or a parameter. Every read is confined to the caller's tenant: another tenant's application is simply `null`. The store re-checks the SHAPE it is
 * given but does not decide what an enrollable application is: the executor validates with `validateApplicationConfig` before it calls `save`.
 */
import type { ApplicationConfig, ApplicationRecord } from "./applications.js";

export interface ApplicationScope {
  /** From the trusted context. */
  readonly tenantId: string;
  /** The safe actor id from the trusted context (`call.security.userId`). */
  readonly actor: string;
}
/** `registry_switch`: the update would move an application between a built-in and a Studio-managed registry (never allowed; the database also refuses it while routes or targets exist). */
export type ApplicationSaveOutcome = "created" | "updated" | "limit_reached" | "id_refused" | "registry_switch" | "routing_locked";
/** `registry_not_managed`: only a Studio-managed application has a runtime key. */
export type RuntimeKeyOutcome = "rotated" | "not_found" | "id_refused" | "registry_not_managed";
export type ApplicationEnabledOutcome = "changed" | "unchanged" | "not_found" | "id_refused";

export interface ApplicationStore {
  /** The tenant's applications, newest update first, at most 20, each with its target and workflow counts (ONE tenant-scoped aggregate query). */
  list(tenantId: string): Promise<readonly ApplicationRecord[]>;
  /** `null` when the id is malformed, does not exist, or belongs to another tenant (the three look the same). */
  get(tenantId: string, id: string): Promise<ApplicationRecord | null>;
  /**
   * Inserts a new application (enabled) or updates an existing one in place (`enabled` is never touched by a save). At most 20 applications per tenant: the 21st is
   * `limit_reached`, serialised per tenant so two concurrent creates cannot exceed it. `routing` changes only while the application has no registered routes (`routing_locked`).
   * `candidateKey` is a freshly generated runtime key (the store makes one when omitted) used ONLY when runtime access is on and the application holds no key yet: a key, once issued, is stable until rotated.
   */
  save(scope: ApplicationScope, id: string, config: ApplicationConfig, candidateKey?: string): Promise<ApplicationSaveOutcome>;
  /** Replaces the runtime key of a Studio-managed application (the old key stops working at once). Never changes `runtimeAccess`. */
  rotateRuntimeKey(scope: ApplicationScope, id: string, newKey: string): Promise<RuntimeKeyOutcome>;
  /** Enables or disables an existing application; never creates one. Disabling is the only way an application stops being used: there is no delete. */
  setEnabled(scope: ApplicationScope, id: string, enabled: boolean): Promise<ApplicationEnabledOutcome>;
}
