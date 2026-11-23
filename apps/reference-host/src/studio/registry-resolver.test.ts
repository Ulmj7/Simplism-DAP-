import { describe, expect, it } from "vitest";
import { TRUSTED_REGISTRY } from "../authoring/trusted-registry.js";
import type { ApplicationRecord } from "./applications.js";
import { FakeApplicationStore } from "./fake-application-store.js";
import { FakeTargetStore } from "./fake-target-store.js";
import { FIXTURE_ENTRY } from "./fixture-registry.js";
import { createRegistryCatalog } from "./registries.js";
import { createRegistryResolver, managedRegistryData } from "./registry-resolver.js";

const TENANT_A = "1111aaaa-2222-4333-8444-5555bbbb5555";
const TENANT_B = "2222bbbb-3333-4444-8555-6666cccc6666";
const APP = "app-0000000000a1";
const record = (registryId: string, id = APP): ApplicationRecord => ({ id, name: "App", origin: "http://127.0.0.1:5173", allowedOrigins: ["http://127.0.0.1:5173"], environment: "development", registryId, routing: "hash", runtimeAccess: false, runtimeKey: null, counts: { targets: 0, drafts: 0, published: 0 }, enabled: true, createdAt: "x", updatedAt: "x" });
const registration = (over: Record<string, unknown> = {}) => ({ targetId: "orders.submit", route: "orders", page: "/#/orders", role: "button" as const, label: "Submit", description: "Submits the order", operations: ["highlight", "click"] as const, privacy: "public" as const, ...over });

async function setup() {
  const applications = new FakeApplicationStore();
  await applications.save({ tenantId: TENANT_A, actor: "s" }, APP, { name: "Managed", origin: "http://127.0.0.1:5187", allowedOrigins: ["http://127.0.0.1:5187"], environment: "test", registryId: "studio-managed" });
  const targets = new FakeTargetStore(applications);
  return { applications, targets, resolver: createRegistryResolver({ catalog: createRegistryCatalog([FIXTURE_ENTRY]), targets }) };
}

describe("built-in applications", () => {
  it("resolve to their catalog entry with its pages and previewMode in-app; a guide without an application is the reference registry", async () => {
    const { resolver } = await setup();
    const reference = await resolver.resolve(TENANT_A, record("reference"));
    expect(reference).toMatchObject({ source: "built-in", previewMode: "in-app", previewable: true });
    expect(reference?.registry).toEqual(TRUSTED_REGISTRY);
    expect(reference?.pages).toMatchObject({ "/#/profile": "profile" });
    expect((await resolver.resolve(TENANT_A, null))?.registry).toEqual(TRUSTED_REGISTRY);
    expect(await resolver.resolve(TENANT_A, record("fixture"))).toMatchObject({ source: "built-in", previewable: false });
  });
  it("an unknown built-in key resolves to undefined (fail closed), and the reference test seam replaces the reference registry only", async () => {
    const { targets } = await setup();
    const drifted = { routes: ["only"], elements: [], postconditionNames: [] };
    const resolver = createRegistryResolver({ catalog: createRegistryCatalog([FIXTURE_ENTRY]), targets, referenceOverride: drifted });
    expect(await resolver.resolve(TENANT_A, record("gone"))).toBeUndefined();
    expect((await resolver.resolve(TENANT_A, record("reference")))?.registry).toEqual(drifted);
    expect((await resolver.resolve(TENANT_A, null))?.registry).toEqual(drifted);
    expect((await resolver.resolve(TENANT_A, record("fixture")))?.registry).toEqual(FIXTURE_ENTRY.registry);
  });
});

describe("studio-managed applications", () => {
  it("an application with no routes is an empty, not previewable registry in application-window mode", async () => {
    const { resolver } = await setup();
    const empty = await resolver.resolve(TENANT_A, record("studio-managed"));
    expect(empty).toMatchObject({ source: "studio-managed", previewMode: "application-window", previewable: false, pages: {} });
    expect(empty?.registry).toEqual({ routes: [], elements: [], postconditionNames: [] });
  });
  it("holds the registered routes, the ACTIVE public targets only and the managed postconditions route.<route>", async () => {
    const { resolver, targets } = await setup();
    const scope = { tenantId: TENANT_A, actor: "maya" };
    await targets.register(scope, APP, registration());
    await targets.register(scope, APP, registration({ targetId: "orders.note", role: "textbox", operations: ["highlight", "input"], label: "Note" }));
    await targets.register(scope, APP, registration({ targetId: "home.start", route: "home", page: "/", label: "Start" }));
    await targets.setStatus(scope, APP, "orders.note", "disabled");
    const resolved = await resolver.resolve(TENANT_A, record("studio-managed"));
    expect(resolved?.registry.routes).toEqual(["orders", "home"]);
    expect(resolved?.registry.elements.map((element) => element.id)).toEqual(["orders.submit", "home.start"]);
    expect(resolved?.registry.postconditionNames).toEqual(["route.orders", "route.home"]);
    expect(resolved?.pages).toEqual({ "/#/orders": "orders", "/": "home" });
    expect(resolved).toMatchObject({ previewable: true, previewMode: "application-window" });
  });
  it("a route whose only targets are disabled stays registered (and keeps its postcondition)", async () => {
    const { resolver, targets } = await setup();
    const scope = { tenantId: TENANT_A, actor: "maya" };
    await targets.register(scope, APP, registration());
    await targets.setStatus(scope, APP, "orders.submit", "disabled");
    const resolved = await resolver.resolve(TENANT_A, record("studio-managed"));
    expect(resolved?.registry.routes).toEqual(["orders"]);
    expect(resolved?.registry.elements).toEqual([]);
    expect(resolved?.registry.postconditionNames).toEqual(["route.orders"]);
  });
  it("is tenant-scoped: another tenant resolves an application of the same id to an empty registry", async () => {
    const { resolver, targets } = await setup();
    await targets.register({ tenantId: TENANT_A, actor: "maya" }, APP, registration());
    expect((await resolver.resolve(TENANT_B, record("studio-managed")))?.registry.routes).toEqual([]);
  });
  it("resolveIn answers the same as resolve (the executor's own transaction)", async () => {
    const { resolver, targets } = await setup();
    await targets.register({ tenantId: TENANT_A, actor: "maya" }, APP, registration());
    const inTx = await resolver.resolveIn(undefined as never, TENANT_A, record("studio-managed"));
    expect(inTx).toEqual(await resolver.resolve(TENANT_A, record("studio-managed")));
  });
  it("managedRegistryData is pure and freezes its result", () => {
    const resolved = managedRegistryData({ routes: [{ route: "orders", page: "/#/orders" }], elements: [] as never, markers: {}, checks: [] });
    expect(Object.isFrozen(resolved)).toBe(true);
    expect(resolved.registry.postconditionNames).toEqual(["route.orders"]);
  });
});
