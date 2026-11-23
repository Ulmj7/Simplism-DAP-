/**
 * An in-memory ApplicationStore for FOCUSED unit tests (Studio V1A). It applies the same rules as the PostgreSQL store (tenant confinement, the cap of 20, `enabled` untouched
 * by a save, no delete) so route and executor tests can run without a database. The proof that PostgreSQL really behaves this way is the DB-backed tests under tests/integration.
 */
import type { ApplicationConfig, ApplicationCounts, ApplicationRecord } from "./applications.js";
import { MAX_APPLICATIONS_PER_TENANT, NO_COUNTS, STUDIO_MANAGED_REGISTRY_ID, generateRuntimeKey, isApplicationId, isRuntimeKey, registrySourceOf } from "./applications.js";
import type { ApplicationEnabledOutcome, ApplicationSaveOutcome, ApplicationScope, ApplicationStore, RuntimeKeyOutcome } from "./application-store.js";

type Row = ApplicationRecord & { readonly tenantId: string };

export class FakeApplicationStore implements ApplicationStore {
  readonly rows: Row[] = [];
  /** Counts a test sets by hand (`tenant/application` -> counts); applications without an entry report zeros. */
  readonly counts = new Map<string, ApplicationCounts>();
  /** `tenant/application` of every application that has registered routes (the FakeTargetStore marks them): routing is locked for these. */
  readonly withRoutes = new Set<string>();
  private publicRecord(row: Row): ApplicationRecord {
    return { id: row.id, name: row.name, origin: row.origin, allowedOrigins: row.allowedOrigins, environment: row.environment, registryId: row.registryId, routing: row.routing, runtimeAccess: row.runtimeAccess,
      runtimeKey: row.runtimeKey, counts: this.counts.get(`${row.tenantId}/${row.id}`) ?? NO_COUNTS, enabled: row.enabled, createdAt: row.createdAt, updatedAt: row.updatedAt };
  }
  /** When set, every call throws it (the store being down). */
  failWith: Error | null = null;
  private tick = 0;
  private check(): void { if (this.failWith !== null) throw this.failWith; }
  private stamp(): string { this.tick += 1; return new Date(Date.UTC(2026, 0, 1, 0, 0, this.tick)).toISOString(); }

  async list(tenantId: string): Promise<readonly ApplicationRecord[]> {
    this.check();
    return this.rows.filter((row) => row.tenantId === tenantId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, MAX_APPLICATIONS_PER_TENANT).map((row) => this.publicRecord(row));
  }
  async get(tenantId: string, id: string): Promise<ApplicationRecord | null> {
    this.check();
    if (!isApplicationId(id)) return null;
    const row = this.rows.find((candidate) => candidate.tenantId === tenantId && candidate.id === id);
    if (row === undefined) return null;
    return this.publicRecord(row);
  }
  async save(scope: ApplicationScope, id: string, config: ApplicationConfig, candidateKey: string = generateRuntimeKey()): Promise<ApplicationSaveOutcome> {
    this.check();
    if (!isApplicationId(id)) return "id_refused";
    const index = this.rows.findIndex((row) => row.tenantId === scope.tenantId && row.id === id);
    if (index < 0) {
      if (this.rows.filter((row) => row.tenantId === scope.tenantId).length >= MAX_APPLICATIONS_PER_TENANT) return "limit_reached";
      const now = this.stamp();
      const runtimeAccess = config.runtimeAccess === true;
      this.rows.push({ tenantId: scope.tenantId, id, name: config.name, origin: config.origin, environment: config.environment, registryId: config.registryId, allowedOrigins: [...config.allowedOrigins],
        routing: config.routing ?? "hash", runtimeAccess, runtimeKey: runtimeAccess && isRuntimeKey(candidateKey) ? candidateKey : null, counts: NO_COUNTS, enabled: true, createdAt: now, updatedAt: now });
      return "created";
    }
    const current = this.rows[index]!;
    if (registrySourceOf(current.registryId) !== registrySourceOf(config.registryId)) return "registry_switch";
    const routing = config.routing ?? "hash";
    if (routing !== current.routing && this.withRoutes.has(`${scope.tenantId}/${id}`)) return "routing_locked";
    const runtimeAccess = config.runtimeAccess === true;
    const runtimeKey = current.runtimeKey ?? (runtimeAccess && isRuntimeKey(candidateKey) ? candidateKey : null);
    this.rows[index] = { ...current, name: config.name, origin: config.origin, environment: config.environment, registryId: config.registryId, allowedOrigins: [...config.allowedOrigins], routing, runtimeAccess, runtimeKey, updatedAt: this.stamp() };
    return "updated";
  }
  async setEnabled(scope: ApplicationScope, id: string, enabled: boolean): Promise<ApplicationEnabledOutcome> {
    this.check();
    if (!isApplicationId(id)) return "id_refused";
    const index = this.rows.findIndex((row) => row.tenantId === scope.tenantId && row.id === id);
    if (index < 0) return "not_found";
    const current = this.rows[index]!;
    if (current.enabled === enabled) return "unchanged";
    this.rows[index] = { ...current, enabled, updatedAt: this.stamp() };
    return "changed";
  }
  async rotateRuntimeKey(scope: ApplicationScope, id: string, newKey: string): Promise<RuntimeKeyOutcome> {
    this.check();
    if (!isApplicationId(id) || !isRuntimeKey(newKey)) return "id_refused";
    const index = this.rows.findIndex((row) => row.tenantId === scope.tenantId && row.id === id);
    if (index < 0) return "not_found";
    const current = this.rows[index]!;
    if (current.registryId !== STUDIO_MANAGED_REGISTRY_ID) return "registry_not_managed";
    this.rows[index] = { ...current, runtimeKey: newKey, updatedAt: this.stamp() };
    return "rotated";
  }
  /** The runtime lookup as the database function does it: the (tenant, application) of an ENABLED managed application with runtime access on, by key. */
  lookupRuntimeKey(key: string): { readonly tenantId: string; readonly applicationId: string } | null {
    const row = this.rows.find((candidate) => candidate.runtimeKey === key && candidate.enabled && candidate.runtimeAccess && candidate.registryId === STUDIO_MANAGED_REGISTRY_ID);
    return row === undefined ? null : { tenantId: row.tenantId, applicationId: row.id };
  }
}
