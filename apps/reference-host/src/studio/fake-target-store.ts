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
import type { RegistryRouteRecord, TargetRecord, TargetRegistration, TargetStatus, TargetView } from "./registry-targets.js";
import type { ManagedRegistry, RegisterOutcome, TargetListing, TargetStatusOutcome, TargetStore } from "./target-store.js";

interface Row { readonly tenantId: string; readonly applicationId: string; readonly record: TargetRecord }

export class FakeTargetStore implements TargetStore {
  private readonly targets: Row[] = [];
  private readonly routes: { tenantId: string; applicationId: string; route: string; page: string }[] = [];
  failWith: Error | null = null;
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
    if (this.targets.some((row) => row.tenantId === scope.tenantId && row.applicationId === applicationId && row.record.id === value.targetId)) return { kind: "target_exists" };
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
      id: value.targetId, route: value.route, page: value.page, role: value.role, label: value.label, description: value.description, operations: Object.freeze([...value.operations]),
      privacy: "public" as const, status: "active" as const, updatedAt: this.stamp(),
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
}
