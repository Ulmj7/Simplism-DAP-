/** Studio COMPLETION S4 without a database: checks as registry postconditions (resolver), as `verify` of a guide (the ONE validator) and in the guide bundle. */
import { describe, expect, it } from "vitest";
import { validateAuthoredDefinition } from "../authoring/validate.js";
import type { ApplicationRecord } from "./applications.js";
import { FakeApplicationStore } from "./fake-application-store.js";
import { FakeTargetStore } from "./fake-target-store.js";
import { createRegistryCatalog } from "./registries.js";
import { buildGuideBundle } from "./guide-bundle.js";
import { checkName, validateCheckRegistration } from "./registry-checks.js";
import { createRegistryResolver } from "./registry-resolver.js";

const TENANT = "1111aaaa-2222-4333-8444-5555bbbb5555";
const SCOPE = { tenantId: TENANT, actor: "maya" };
const APP = "app-0000000000a1";
const application: ApplicationRecord = { id: APP, name: "Managed", origin: "http://127.0.0.1:5187", allowedOrigins: ["http://127.0.0.1:5187"], environment: "test", registryId: "studio-managed", routing: "hash", runtimeAccess: true, runtimeKey: null, counts: { targets: 0, drafts: 0, published: 0 }, enabled: true, createdAt: "x", updatedAt: "x" };
const target = (id: string, role: "button" | "textbox" | "text", ops: readonly ("highlight" | "click" | "input")[] = ["highlight"]) => ({ targetId: id, route: "orders", page: "/#/orders", role, label: id, description: "A control.", operations: ops, privacy: "public" as const });
const content = (input: unknown) => { const v = validateCheckRegistration(input); if (!v.ok) throw new Error(v.issues.join()); return v.value; };
const guide = (verify: string) => ({
  id: "wt-0000000000a1", title: "Submit an order", description: "Submit the order.", start: "n1",
  steps: [{ id: "n1", kind: "navigate", route: "orders", next: "s1" }, { id: "s1", kind: "guide", target: "orders.submit", text: "Press it.", wait: "click", verify, next: "done" }, { id: "done", kind: "complete", text: "Done." }],
});

async function setup() {
  const applications = new FakeApplicationStore();
  await applications.save(SCOPE, APP, { name: "Managed", origin: "http://127.0.0.1:5187", allowedOrigins: ["http://127.0.0.1:5187"], environment: "test", registryId: "studio-managed" });
  const targets = new FakeTargetStore(applications);
  await targets.register(SCOPE, APP, target("orders.submit", "button", ["highlight", "click"]));
  await targets.register(SCOPE, APP, target("orders.note", "textbox", ["highlight", "input"]));
  await targets.register(SCOPE, APP, target("orders.status", "text"));
  const resolver = createRegistryResolver({ catalog: createRegistryCatalog(), targets });
  const add = async (input: unknown) => { const value = content(input); expect(await targets.registerCheck(SCOPE, APP, value)).toMatchObject({ kind: "created" }); return value.name; };
  return { targets, resolver, add };
}

describe("the managed registry carries the active checks as postconditions", () => {
  it("postconditionNames is exactly route.* plus the names of the active checks, in registration order", async () => {
    const t = await setup();
    const names = [await t.add({ kind: "element.visible", targetId: "orders.status" }), await t.add({ kind: "route.equals", route: "orders" })];
    const resolved = await t.resolver.resolve(TENANT, application);
    expect(resolved?.registry.postconditionNames).toEqual(["route.orders", ...names]);
    expect(resolved?.checks?.map((check) => check.name)).toEqual(names);
  });
  it("a guide may name a check as its verify (the ONE validator), and a name that is not a check or a route is refused", async () => {
    const t = await setup();
    const name = await t.add({ kind: "element.text.equals", targetId: "orders.status", expected: "Order placed" });
    const registry = (await t.resolver.resolve(TENANT, application))!.registry;
    expect(validateAuthoredDefinition("wt-0000000000a1", guide(name), registry)).toMatchObject({ ok: true });
    expect(validateAuthoredDefinition("wt-0000000000a1", guide("route.orders"), registry)).toMatchObject({ ok: true });
    expect(validateAuthoredDefinition("wt-0000000000a1", guide("check.v0000000000"), registry)).toMatchObject({ ok: false });
    expect(validateAuthoredDefinition("wt-0000000000a1", guide("orders.exported"), registry)).toMatchObject({ ok: false });
  });
  it("a DISABLED check is no longer a postcondition: guides that name it stop validating, and re-enabling restores it", async () => {
    const t = await setup();
    const name = await t.add({ kind: "element.visible", targetId: "orders.status" });
    expect(await t.targets.setCheckStatus(SCOPE, APP, name, "disabled")).toBe("changed");
    let registry = (await t.resolver.resolve(TENANT, application))!.registry;
    expect(registry.postconditionNames).toEqual(["route.orders"]);
    expect(validateAuthoredDefinition("wt-0000000000a1", guide(name), registry)).toMatchObject({ ok: false });
    expect(await t.targets.setCheckStatus(SCOPE, APP, name, "active")).toBe("changed");
    registry = (await t.resolver.resolve(TENANT, application))!.registry;
    expect(validateAuthoredDefinition("wt-0000000000a1", guide(name), registry)).toMatchObject({ ok: true });
  });
  it("a check whose TARGET is disabled drops out (fail closed) and returns with the target; a route check does not depend on any target", async () => {
    const t = await setup();
    const visible = await t.add({ kind: "element.visible", targetId: "orders.status" });
    const route = await t.add({ kind: "route.equals", route: "orders" });
    expect(await t.targets.setStatus(SCOPE, APP, "orders.status", "disabled")).toBe("changed");
    let registry = (await t.resolver.resolve(TENANT, application))!.registry;
    expect(registry.postconditionNames).toEqual(["route.orders", route]);
    expect(validateAuthoredDefinition("wt-0000000000a1", guide(visible), registry)).toMatchObject({ ok: false });
    expect(await t.targets.setStatus(SCOPE, APP, "orders.status", "active")).toBe("changed");
    registry = (await t.resolver.resolve(TENANT, application))!.registry;
    expect(registry.postconditionNames).toEqual(["route.orders", visible, route]);
    expect(validateAuthoredDefinition("wt-0000000000a1", guide(visible), registry)).toMatchObject({ ok: true });
  });
  it("another application or tenant never sees these checks", async () => {
    const t = await setup();
    await t.add({ kind: "element.visible", targetId: "orders.status" });
    expect((await t.targets.registry("2222bbbb-3333-4444-8555-6666cccc6666", APP)).checks).toEqual([]);
    expect((await t.targets.registry(TENANT, "app-0000000000b2")).checks).toEqual([]);
  });
  it("an old value check whose target now has a non-value role stays out of the playable registry", async () => {
    const t = await setup();
    const name = await t.add({ kind: "element.value.equals", targetId: "orders.note", expected: "hello" });
    await t.targets.setCheckStatus(SCOPE, APP, name, "disabled");
    const { verifyRepair } = await import("./repair-impact.js");
    expect(await t.targets.repair(SCOPE, APP, "orders.note", { marker: "orders.noteButton", role: "button", label: "Note", description: "A note.", operations: ["highlight", "click"] }, verifyRepair)).toMatchObject({ kind: "repaired" });
    await t.targets.setCheckStatus(SCOPE, APP, name, "active");
    expect(await t.resolver.resolve(TENANT, application)).toMatchObject({ checks: [], registry: { postconditionNames: ["route.orders"] } });
  });
  it("a repair that would turn the target of an active VALUE check into a role without a value is incompatible", async () => {
    const t = await setup();
    await t.add({ kind: "element.value.equals", targetId: "orders.note", expected: "hello" });
    const { verifyRepair } = await import("./repair-impact.js");
    const outcome = await t.targets.repair(SCOPE, APP, "orders.note", { marker: "orders.note", role: "button", label: "Note", description: "A note.", operations: ["highlight", "click"] }, verifyRepair);
    expect(outcome).toMatchObject({ kind: "incompatible" });
    const ok = await t.targets.repair(SCOPE, APP, "orders.note", { marker: "orders.noteNew", role: "textbox", label: "Note", description: "A note.", operations: ["highlight", "input"] }, verifyRepair);
    expect(ok).toMatchObject({ kind: "repaired" });
  });
});

describe("the guide bundle", () => {
  it("emits the real markers and the active checks in the closed shapes of their kinds; postconditionNames is exactly route.* + the check names", async () => {
    const t = await setup();
    const names = [
      await t.add({ kind: "route.equals", route: "orders" }),
      await t.add({ kind: "element.visible", targetId: "orders.status" }),
      await t.add({ kind: "element.hidden", targetId: "orders.submit" }),
      await t.add({ kind: "element.text.equals", targetId: "orders.status", expected: "Order placed" }),
      await t.add({ kind: "element.value.equals", targetId: "orders.note", expected: "hello" }),
      await t.add({ kind: "element.attribute.equals", targetId: "orders.submit", attribute: "aria-disabled", expected: "true" }),
    ];
    const disabled = await t.add({ kind: "element.hidden", targetId: "orders.note" });
    await t.targets.setCheckStatus(SCOPE, APP, disabled, "disabled");
    await t.targets.repair(SCOPE, APP, "orders.submit", { marker: "orders.submitNew", role: "button", label: "Submit", description: "A control.", operations: ["highlight", "click"] }, () => []);
    const resolved = (await t.resolver.resolve(TENANT, application))!;
    const definition = validateAuthoredDefinition("wt-0000000000a1", guide(names[3]!), resolved.registry);
    if (!definition.ok) throw new Error("fixture guide must validate");
    const bundle = buildGuideBundle({ definition: definition.definition, application, resolved });
    expect(bundle.registry.checks.map((check) => check.name)).toEqual(names);
    expect(bundle.registry.checks.map((check) => Object.keys(check).sort())).toEqual([
      ["kind", "name", "route"], ["kind", "name", "targetId"], ["kind", "name", "targetId"], ["expected", "kind", "name", "targetId"], ["expected", "kind", "name", "targetId"], ["attribute", "expected", "kind", "name", "targetId"],
    ]);
    expect(bundle.registry.postconditionNames).toEqual(["route.orders", ...names]);
    expect(bundle.registry.elements.find((element) => element.id === "orders.submit")).toMatchObject({ id: "orders.submit", marker: "orders.submitNew" });
    expect(bundle.registry.elements.find((element) => element.id === "orders.status")).toMatchObject({ marker: "orders.status" });
    expect(JSON.stringify(bundle)).not.toContain(disabled);
    expect(names[3]).toBe(checkName({ kind: "element.text.equals", targetId: "orders.status", route: null, attribute: null, expected: "Order placed" }));
  });
  it("a built-in registry has no checks", async () => {
    const applications = new FakeApplicationStore();
    const resolver = createRegistryResolver({ catalog: createRegistryCatalog(), targets: new FakeTargetStore(applications) });
    const builtIn = { ...application, registryId: "reference" };
    const resolved = (await resolver.resolve(TENANT, builtIn))!;
    const definition = validateAuthoredDefinition("wt-0000000000a1", { id: "wt-0000000000a1", title: "Review your profile", description: "Review profile details.", start: "n1", steps: [{ id: "n1", kind: "navigate", route: "profile", next: "s1" }, { id: "s1", kind: "guide", target: "profile.saveButton", text: "Press Save.", wait: "click", verify: "profile.saved", next: "done" }, { id: "done", kind: "complete", text: "Done." }] }, resolved.registry);
    if (!definition.ok) throw new Error("fixture must validate");
    expect(buildGuideBundle({ definition: definition.definition, application: builtIn, resolved }).registry.checks).toEqual([]);
  });
});
