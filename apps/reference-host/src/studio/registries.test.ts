import { describe, expect, it } from "vitest";
import { TRUSTED_REGISTRY } from "../authoring/trusted-registry.js";
import { REFERENCE_REGISTRY_ENTRY, REFERENCE_REGISTRY_ID, RegistryCatalogError, createRegistryCatalog, publicRegistryView } from "./registries.js";
import { FIXTURE_ENTRY } from "./fixture-registry.js";
import type { RegistryEntry } from "./registries.js";

describe("the built-in reference entry", () => {
  it("is built from the existing trusted registry, unchanged", () => {
    expect(REFERENCE_REGISTRY_ENTRY.id).toBe(REFERENCE_REGISTRY_ID);
    expect(REFERENCE_REGISTRY_ENTRY.registry).toEqual(TRUSTED_REGISTRY);
    expect(REFERENCE_REGISTRY_ENTRY.previewable).toBe(true);
  });
  it("carries the six approved labels and four pages the Studio browser used before applications existed", () => {
    expect(REFERENCE_REGISTRY_ENTRY.browser.labels).toEqual([
      { role: "link", name: "Profile" }, { role: "link", name: "Settings" }, { role: "textbox", name: "Display name" },
      { role: "button", name: "Save" }, { role: "button", name: "Advanced" }, { role: "button", name: "Set up two-factor authentication" },
    ]);
    expect(REFERENCE_REGISTRY_ENTRY.browser.pages).toEqual({ "/": "dashboard", "/#/dashboard": "dashboard", "/#/profile": "profile", "/#/settings": "settings" });
  });
  it("is deeply frozen, so a consumer cannot change the trusted data", () => {
    expect(Object.isFrozen(REFERENCE_REGISTRY_ENTRY.registry.elements)).toBe(true);
    expect(Object.isFrozen(REFERENCE_REGISTRY_ENTRY.registry.elements[0])).toBe(true);
    expect(Object.isFrozen(REFERENCE_REGISTRY_ENTRY.browser.labels[0])).toBe(true);
    expect(Object.isFrozen(REFERENCE_REGISTRY_ENTRY.browser.pages)).toBe(true);
  });
  it("every page maps to a registry route and every label is a role/name of a registered public element", () => {
    for (const route of Object.values(REFERENCE_REGISTRY_ENTRY.browser.pages)) expect(TRUSTED_REGISTRY.routes).toContain(route);
  });
});

describe("the catalog", () => {
  it("holds the reference entry alone by default", () => {
    const catalog = createRegistryCatalog();
    expect(catalog.ids()).toEqual(["reference"]);
    expect(catalog.choices()).toEqual([{ id: "reference", label: "Reference application" }]);
    expect(catalog.get("reference")).toBe(REFERENCE_REGISTRY_ENTRY);
    expect(catalog.get("missing")).toBeUndefined();
  });
  it("accepts an injected second registry next to the reference one", () => {
    const catalog = createRegistryCatalog([FIXTURE_ENTRY]);
    expect(catalog.ids()).toEqual(["reference", "fixture"]);
    expect(catalog.choices().map((choice) => choice.id)).toEqual(["reference", "fixture"]);
    expect(catalog.get("fixture")?.registry.routes).toEqual(["home", "orders"]);
    expect(catalog.get("fixture")?.previewable).toBe(false);
  });
  it("copies an injected entry, so later changes to the caller's object do not reach the catalog", () => {
    const mutable = { ...FIXTURE_ENTRY, browser: { labels: [{ role: "button", name: "Export" }], pages: { "/": "home" } as Record<string, string> } };
    const catalog = createRegistryCatalog([mutable]);
    mutable.browser.labels.push({ role: "button", name: "Delete everything" });
    mutable.browser.pages["/#/evil"] = "home";
    expect(catalog.get("fixture")?.browser.labels).toEqual([{ role: "button", name: "Export" }]);
    expect(catalog.get("fixture")?.browser.pages).toEqual({ "/": "home" });
  });
  it("refuses a duplicate or shadowing id and a malformed entry at composition time", () => {
    expect(() => createRegistryCatalog([{ ...FIXTURE_ENTRY, id: "reference" }])).toThrow(RegistryCatalogError);
    expect(() => createRegistryCatalog([FIXTURE_ENTRY, FIXTURE_ENTRY])).toThrow(RegistryCatalogError);
    expect(() => createRegistryCatalog([{ ...FIXTURE_ENTRY, id: "Bad Id" }])).toThrow(RegistryCatalogError);
    expect(() => createRegistryCatalog([{ ...FIXTURE_ENTRY, label: "" }])).toThrow(RegistryCatalogError);
    expect(() => createRegistryCatalog([{ ...FIXTURE_ENTRY, browser: { ...FIXTURE_ENTRY.browser, pages: { "/": "nowhere" } } }])).toThrow(RegistryCatalogError);
    expect(() => createRegistryCatalog([{ ...FIXTURE_ENTRY, browser: { ...FIXTURE_ENTRY.browser, pages: { "home": "home" } } }])).toThrow(RegistryCatalogError);
    expect(() => createRegistryCatalog([{ ...FIXTURE_ENTRY, previewable: "yes" as unknown as boolean }])).toThrow(RegistryCatalogError);
  });
});

describe("catalog entries the editor could not load are refused at composition time", () => {
  const withRegistry = (patch: Partial<RegistryEntry["registry"]>): RegistryEntry => ({ ...FIXTURE_ENTRY, registry: { ...FIXTURE_ENTRY.registry, ...patch } });
  const element = (index: number) => ({ ...FIXTURE_ENTRY.registry.elements[0]!, id: `orders.element${index}` });
  it.each([
    ["an undotted postcondition name", withRegistry({ postconditionNames: ["saved"] })],
    ["a postcondition name with a space", withRegistry({ postconditionNames: ["orders. exported"] })],
    ["an 81-character postcondition name", withRegistry({ postconditionNames: [`orders.${"a".repeat(74)}`] })],
    ["a duplicate postcondition name", withRegistry({ postconditionNames: ["orders.exported", "orders.exported"] })],
    ["51 postconditions", withRegistry({ postconditionNames: Array.from({ length: 51 }, (_v, i) => `orders.step${i}`) })],
    ["21 routes", withRegistry({ routes: Array.from({ length: 21 }, (_v, i) => `r${i}`) })],
    ["201 elements", withRegistry({ elements: Array.from({ length: 201 }, (_v, i) => element(i)) })],
    ["an 81-character element id", withRegistry({ elements: [{ ...FIXTURE_ENTRY.registry.elements[0]!, id: `orders.${"a".repeat(74)}` }] })],
  ])("refuses %s with a fixed message", (_name, entry) => {
    expect(() => createRegistryCatalog([entry])).toThrow(RegistryCatalogError);
    expect(() => createRegistryCatalog([entry])).toThrow(/^registry entry refused: /);
  });
  it("accepts the limits themselves: 20 routes, 200 elements, 50 dotted postconditions of 80 characters", () => {
    const routes = Array.from({ length: 20 }, (_v, i) => `r${i}`);
    const entry = withRegistry({ routes, elements: Array.from({ length: 200 }, (_v, i) => element(i)), postconditionNames: [...Array.from({ length: 49 }, (_v, i) => `orders.step${i}`), `orders.${"a".repeat(73)}`] });
    expect(createRegistryCatalog([{ ...entry, browser: { labels: entry.browser.labels, pages: { "/": "r0" } } }]).get("fixture")).toBeDefined();
    expect(`orders.${"a".repeat(73)}`).toHaveLength(80);
  });
  it("the built-in reference entry and the second fixture obey the same bounds", () => {
    expect(() => createRegistryCatalog([FIXTURE_ENTRY])).not.toThrow();
    expect(createRegistryCatalog().get("reference")).toBeDefined();
  });
});

describe("the public registry view", () => {
  it("lists public elements only: the private email field of the reference registry never appears", () => {
    const view = publicRegistryView(REFERENCE_REGISTRY_ENTRY);
    expect(view.routes).toEqual(["dashboard", "profile", "settings"]);
    expect(view.elements.map((element) => element.id)).not.toContain("profile.emailInput");
    expect(view.elements).toHaveLength(7);
    expect(view.elements.every((element) => element.privacy === "public")).toBe(true);
    expect(view.postconditionNames).toEqual(["profile.saved", "route.profile", "route.settings", "settings.advancedOpen"]);
    expect(view.previewable).toBe(true);
  });
  it("describes an injected registry, and is not previewable unless the entry says so", () => {
    const view = publicRegistryView(createRegistryCatalog([FIXTURE_ENTRY]).get("fixture")!);
    expect(view.elements).toEqual([{ id: "orders.exportButton", route: "orders", role: "button", label: "Export", description: "Exports the orders", operations: ["highlight", "click"], privacy: "public" }]);
    expect(view.previewable).toBe(false);
  });
});
