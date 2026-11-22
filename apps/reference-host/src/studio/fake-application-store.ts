/**
 * An in-memory ApplicationStore for FOCUSED unit tests (Studio V1A). It applies the same rules as the PostgreSQL store (tenant confinement, the cap of 20, `enabled` untouched
 * by a save, no delete) so route and executor tests can run without a database. The proof that PostgreSQL really behaves this way is the DB-backed tests under tests/integration.
 */
import type { ApplicationConfig, ApplicationRecord } from "./applications.js";
import { MAX_APPLICATIONS_PER_TENANT, isApplicationId, registrySourceOf } from "./applications.js";
import type { ApplicationEnabledOutcome, ApplicationSaveOutcome, ApplicationScope, ApplicationStore } from "./application-store.js";

const publicRecord = (row: ApplicationRecord & { readonly tenantId: string }): ApplicationRecord => ({
  id: row.id, name: row.name, origin: row.origin, allowedOrigins: row.allowedOrigins, environment: row.environment, registryId: row.registryId, enabled: row.enabled,
  createdAt: row.createdAt, updatedAt: row.updatedAt,
});

export class FakeApplicationStore implements ApplicationStore {
  readonly rows: (ApplicationRecord & { readonly tenantId: string })[] = [];
  /** When set, every call throws it (the store being down). */
  failWith: Error | null = null;
  private tick = 0;
  private check(): void { if (this.failWith !== null) throw this.failWith; }
  private stamp(): string { this.tick += 1; return new Date(Date.UTC(2026, 0, 1, 0, 0, this.tick)).toISOString(); }

  async list(tenantId: string): Promise<readonly ApplicationRecord[]> {
    this.check();
    return this.rows.filter((row) => row.tenantId === tenantId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)).slice(0, MAX_APPLICATIONS_PER_TENANT).map((row) => publicRecord(row));
  }
  async get(tenantId: string, id: string): Promise<ApplicationRecord | null> {
    this.check();
    if (!isApplicationId(id)) return null;
    const row = this.rows.find((candidate) => candidate.tenantId === tenantId && candidate.id === id);
    if (row === undefined) return null;
    return publicRecord(row);
  }
  async save(scope: ApplicationScope, id: string, config: ApplicationConfig): Promise<ApplicationSaveOutcome> {
    this.check();
    if (!isApplicationId(id)) return "id_refused";
    const index = this.rows.findIndex((row) => row.tenantId === scope.tenantId && row.id === id);
    if (index < 0) {
      if (this.rows.filter((row) => row.tenantId === scope.tenantId).length >= MAX_APPLICATIONS_PER_TENANT) return "limit_reached";
      const now = this.stamp();
      this.rows.push({ tenantId: scope.tenantId, id, ...config, allowedOrigins: [...config.allowedOrigins], enabled: true, createdAt: now, updatedAt: now });
      return "created";
    }
    const current = this.rows[index]!;
    if (registrySourceOf(current.registryId) !== registrySourceOf(config.registryId)) return "registry_switch";
    this.rows[index] = { ...current, ...config, allowedOrigins: [...config.allowedOrigins], updatedAt: this.stamp() };
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
}
