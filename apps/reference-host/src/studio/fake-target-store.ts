/**
 * An in-memory TargetStore for FOCUSED unit tests (Studio V1B). It applies the rules of the PostgreSQL store (application must exist in the tenant, be enabled and be managed; a page keeps its
 * route; duplicate ids; the caps; nothing but the status ever changes; tenant confinement) so executor, resolver and route tests run without a database. The proof that PostgreSQL really
 * behaves this way is tests/integration/studio-registry*.test.ts.
 */
import type { TenantClient } from "../authoring/tenant-tx.js";
import type { TrustedRegistryData } from "../authoring/trusted-registry.js";
import type { ApplicationStore } from "./application-store.js";
import { FakeApplicationStore } from "./fake-application-store.js";
import type { ApplicationScope } from "./application-store.js";
import { STUDIO_MANAGED_REGISTRY_ID, isApplicationId } from "./applications.js";
import { MAX_ROUTES_PER_APPLICATION, MAX_TARGETS_PER_APPLICATION, isPageFor, isTargetId } from "./registry-targets.js";
import type { RegistryRouteRecord, TargetHealth, TargetRecord, TargetRegistration, TargetRepair, TargetStatus, TargetView } from "./registry-targets.js";
import type { DefinitionUsing, HealthOutcome, ManagedRegistry, RegisterOutcome, RepairFields, RepairOutcome, RepairVerify, TargetChange, TargetListing, TargetStatusOutcome, TargetStore } from "./target-store.js";
import { impactOf } from "./repair-impact.js";

interface Row { readonly tenantId: string; readonly applicationId: string; readonly record: TargetRecord }

export class FakeTargetStore implements TargetStore {
  private readonly targets: Row[] = [];
  private readonly routes: { tenantId: string; applicationId: string; route: string; page: string }[] = [];
  failWith: Error | null = null;
  /** The stored workflows of an application, set by tests: `definitionsUsing` and the repair's compatibility check read them. */
  readonly definitions: { tenantId: string; applicationId: string; id: string; title: string; status: "draft" | "published"; definition: unknown }[] = [];
  private readonly changeRows: { tenantId: string; applicationId: string; targetId: string; change: TargetChange }[] = [];
  /** How many stored definitions of an application name a target (drafts, published); tests set it directly. */
  readonly references = new Map<string, { drafts: number; published: number }>();
  private tick = 0;
  constructor(private readonly applications: ApplicationStore) {}
  private check(): void { if (this.failWith !== null) throw this.failWith; }
  private stamp(): string { this.tick += 1; return new Date(Date.UTC(2026, 0, 1, 0, 0, this.tick)).toISOString(); }
  private view(row: Row): TargetView { return Object.freeze({ ...row.record, references: this.references.get(`${row.tenantId}/${row.applicationId}/${row.record.id}`) ?? { drafts: 0, published: 0 } }); }
  private routesOf(tenantId: string, applicationId: string): RegistryRouteRecord[] {
    return this.routes.filter((route) => route.tenantId === tenantId && route.applicationId === applicationId).map(({ route, page }) => ({ route, page }));
  }

  async list(tenantId: string, applicationId: string): Promise<TargetListing> {
    this.check();
    return { targets: this.targets.filter((row) => row.tenantId === tenantId && row.applicationId === applicationId).map((row) => this.view(row)), routes: this.routesOf(tenantId, applicationId) };
  }
  async get(tenantId: string, applicationId: string, targetId: string): Promise<TargetView | null> {
    this.check();
    const row = this.targets.find((candidate) => candidate.tenantId === tenantId && candidate.applicationId === applicationId && candidate.record.id === targetId);
    return row === undefined ? null : this.view(row);
  }
  async registry(tenantId: string, applicationId: string): Promise<ManagedRegistry> {
    this.check();
    return {
      routes: this.routesOf(tenantId, applicationId),
      elements: this.targets.filter((row) => row.tenantId === tenantId && row.applicationId === applicationId && row.record.status === "active").map(({ record }) => ({
        id: record.id, route: record.route, role: record.role, label: record.label, description: record.description, operations: [...record.operations], privacy: "public",
      })) as unknown as TrustedRegistryData["elements"],
      markers: Object.fromEntries(this.targets.filter((row) => row.tenantId === tenantId && row.applicationId === applicationId && row.record.status === "active").map(({ record }) => [record.id, record.marker])),
    };
  }
  async registryIn(_tx: TenantClient, tenantId: string, applicationId: string): Promise<ManagedRegistry> { return this.registry(tenantId, applicationId); }

  async register(scope: ApplicationScope, applicationId: string, value: TargetRegistration): Promise<RegisterOutcome> {
    this.check();
    if (!isApplicationId(applicationId) || !isTargetId(value.targetId)) return { kind: "id_refused" };
    const application = await this.applications.get(scope.tenantId, applicationId);
    if (application === null) return { kind: "application_not_found" };
    if (!application.enabled) return { kind: "application_disabled" };
    if (application.registryId !== STUDIO_MANAGED_REGISTRY_ID) return { kind: "registry_not_managed" };
    if (!isPageFor(application.routing, value.page)) return { kind: "page_refused" };
    if (this.targets.some((row) => row.tenantId === scope.tenantId && row.applicationId === applicationId && (row.record.id === value.targetId || row.record.marker === value.targetId || row.record.id === value.targetId))) return { kind: "target_exists" };
    const routes = this.routes.filter((route) => route.tenantId === scope.tenantId && route.applicationId === applicationId);
    const byPage = routes.find((route) => route.page === value.page);
    let created = false;
    if (byPage !== undefined) { if (byPage.route !== value.route) return { kind: "route_mismatch" }; }
    else {
      if (routes.some((route) => route.route === value.route)) return { kind: "route_mismatch" };
      if (routes.length >= MAX_ROUTES_PER_APPLICATION) return { kind: "registry_full" };
      created = true;
    }
    if (this.targets.filter((row) => row.tenantId === scope.tenantId && row.applicationId === applicationId).length >= MAX_TARGETS_PER_APPLICATION) return { kind: "registry_full" };
    if (created) {
      this.routes.push({ tenantId: scope.tenantId, applicationId, route: value.route, page: value.page });
      if (this.applications instanceof FakeApplicationStore) this.applications.withRoutes.add(`${scope.tenantId}/${applicationId}`); // routing is locked from now on
    }
    this.targets.push({ tenantId: scope.tenantId, applicationId, record: Object.freeze({
      id: value.targetId, marker: value.targetId, route: value.route, page: value.page, role: value.role, label: value.label, description: value.description, operations: Object.freeze([...value.operations]),
      privacy: "public" as const, status: "active" as const, health: "unverified" as const, healthCheckedAt: null, revision: 1, updatedAt: this.stamp(),
    }) });
    return { kind: "created", route: { route: value.route, page: value.page, created } };
  }

  async setStatus(scope: ApplicationScope, applicationId: string, targetId: string, status: TargetStatus): Promise<TargetStatusOutcome> {
    this.check();
    if (!isApplicationId(applicationId) || !isTargetId(targetId)) return "id_refused";
    const application = await this.applications.get(scope.tenantId, applicationId);
    if (application === null) return "application_not_found";
    if (application.registryId !== STUDIO_MANAGED_REGISTRY_ID) return "registry_not_managed";
    if (status === "active" && !application.enabled) return "application_disabled";
    const index = this.targets.findIndex((row) => row.tenantId === scope.tenantId && row.applicationId === applicationId && row.record.id === targetId);
    if (index < 0) return "target_not_found";
    const row = this.targets[index]!;
    if (row.record.status === status) return "unchanged";
    this.targets[index] = { ...row, record: Object.freeze({ ...row.record, status, updatedAt: this.stamp() }) };
    return "changed";
  }

  async definitionsUsing(tenantId: string, applicationId: string, targetId: string): Promise<readonly DefinitionUsing[]> {
    this.check();
    return this.definitions.filter((item) => item.tenantId === tenantId && item.applicationId === applicationId
      && Array.isArray((item.definition as { steps?: unknown }).steps) && ((item.definition as { steps: { target?: unknown }[] }).steps).some((step) => step?.target === targetId))
      .map((item) => ({ id: item.id, title: item.title, status: item.status, version: item.status === "published" ? 1 : null, definition: item.definition }));
  }
  async changes(tenantId: string, applicationId: string, targetId: string, limit: number): Promise<readonly TargetChange[]> {
    this.check();
    return this.changeRows.filter((row) => row.tenantId === tenantId && row.applicationId === applicationId && row.targetId === targetId).map((row) => row.change).sort((a, b) => b.revision - a.revision).slice(0, limit);
  }
  async setHealth(scope: ApplicationScope, applicationId: string, targetId: string, health: TargetHealth): Promise<HealthOutcome> {
    this.check();
    if (!isApplicationId(applicationId) || !isTargetId(targetId)) return "id_refused";
    const application = await this.applications.get(scope.tenantId, applicationId);
    if (application === null) return "application_not_found";
    if (application.registryId !== STUDIO_MANAGED_REGISTRY_ID) return "registry_not_managed";
    const index = this.targets.findIndex((row) => row.tenantId === scope.tenantId && row.applicationId === applicationId && row.record.id === targetId);
    if (index < 0) return "target_not_found";
    const row = this.targets[index]!;
    this.targets[index] = { ...row, record: Object.freeze({ ...row.record, health, healthCheckedAt: this.stamp(), updatedAt: this.stamp() }) };
    return row.record.health === health ? "unchanged" : "changed";
  }
  async repair(scope: ApplicationScope, applicationId: string, targetId: string, value: TargetRepair, verify: RepairVerify): Promise<RepairOutcome> {
    this.check();
    if (!isApplicationId(applicationId) || !isTargetId(targetId) || !isTargetId(value.marker)) return { kind: "id_refused" };
    const application = await this.applications.get(scope.tenantId, applicationId);
    if (application === null) return { kind: "application_not_found" };
    if (!application.enabled) return { kind: "application_disabled" };
    if (application.registryId !== STUDIO_MANAGED_REGISTRY_ID) return { kind: "registry_not_managed" };
    const index = this.targets.findIndex((row) => row.tenantId === scope.tenantId && row.applicationId === applicationId && row.record.id === targetId);
    if (index < 0) return { kind: "target_not_found" };
    const row = this.targets[index]!;
    const before: RepairFields = { marker: row.record.marker, role: row.record.role, operations: [...row.record.operations], label: row.record.label, description: row.record.description };
    const after: RepairFields = { marker: value.marker, role: value.role, operations: [...value.operations], label: value.label, description: value.description };
    if (JSON.stringify(before) === JSON.stringify(after)) return { kind: "unchanged" };
    if (this.targets.some((other) => other.tenantId === scope.tenantId && other.applicationId === applicationId && other.record.id !== targetId && (other.record.id === value.marker || other.record.marker === value.marker))) return { kind: "marker_in_use" };
    const repaired: TargetRecord = Object.freeze({ ...row.record, marker: value.marker, role: value.role, operations: Object.freeze([...value.operations]), label: value.label, description: value.description,
      health: "healthy" as const, healthCheckedAt: this.stamp(), revision: row.record.revision + 1, updatedAt: this.stamp() });
    const next = [...this.targets]; next[index] = { ...row, record: repaired };
    const registry: ManagedRegistry = {
      routes: this.routesOf(scope.tenantId, applicationId),
      elements: next.filter((item) => item.tenantId === scope.tenantId && item.applicationId === applicationId && item.record.status === "active").map(({ record }) => ({
        id: record.id, route: record.route, role: record.role, label: record.label, description: record.description, operations: [...record.operations], privacy: "public",
      })) as unknown as TrustedRegistryData["elements"],
      markers: Object.fromEntries(next.filter((item) => item.tenantId === scope.tenantId && item.applicationId === applicationId && item.record.status === "active").map(({ record }) => [record.id, record.marker])),
    };
    const definitions = await this.definitionsUsing(scope.tenantId, applicationId, targetId);
    const problems = verify(definitions, registry, repaired);
    if (problems.length > 0) return { kind: "incompatible", problems };
    this.targets[index] = { ...row, record: repaired };
    this.changeRows.push({ tenantId: scope.tenantId, applicationId, targetId, change: { revision: repaired.revision, changedAt: this.stamp(), changedBy: scope.actor, before, after } });
    return { kind: "repaired", target: this.view(this.targets[index]!), before, after, impact: impactOf(definitions) };
  }
}
