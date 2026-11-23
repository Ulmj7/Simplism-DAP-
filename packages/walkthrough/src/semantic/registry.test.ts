import { describe, expect, it } from "vitest";
import { createSemanticRegistry, SemanticRegistryError } from "./registry.js";
import type { SemanticElementDef } from "./types.js";

const ok: SemanticElementDef = { id: "profile.nameInput", route: "profile", role: "textbox", label: "Name", description: "Your display name", operations: ["highlight", "input"], privacy: "public" };
const make = (over: Partial<Record<keyof SemanticElementDef, unknown>> = {}, extra: unknown[] = []) =>
  createSemanticRegistry({ routes: ["profile", "settings"], elements: [{ ...ok, ...over } as SemanticElementDef, ...(extra as SemanticElementDef[])] });
const issues = (fn: () => unknown): readonly string[] => { try { fn(); } catch (error) { return (error as SemanticRegistryError).issues ?? [String(error)]; } return []; };

describe("a valid registration", () => {
  it("looks up by id, lists, filters by route, and is frozen", () => {
    const other = { ...ok, id: "settings.advancedToggle", route: "settings", role: "checkbox" as const };
    const registry = make({}, [other]);
    expect(registry.get("profile.nameInput")?.label).toBe("Name");
    expect(registry.has("settings.advancedToggle")).toBe(true);
    expect(registry.list().map((e) => e.id)).toEqual(["profile.nameInput", "settings.advancedToggle"]);
    expect(registry.forRoute("settings").map((e) => e.id)).toEqual(["settings.advancedToggle"]);
    expect(registry.forRoute("dashboard")).toEqual([]);
    expect(Object.isFrozen(registry)).toBe(true);
    expect(Object.isFrozen(registry.list())).toBe(true);
    expect(Object.isFrozen(registry.get("profile.nameInput"))).toBe(true);
    expect(Object.isFrozen(registry.get("profile.nameInput")?.operations)).toBe(true);
  });
  it("copies the input: later changes to it do not reach the registry", () => {
    const input = { ...ok, operations: ["highlight"] as ("highlight")[] };
    const registry = createSemanticRegistry({ routes: ["profile"], elements: [input] });
    input.operations.push("highlight");
    input.label = "Changed";
    expect(registry.get("profile.nameInput")?.label).toBe("Name");
    expect(registry.get("profile.nameInput")?.operations).toEqual(["highlight"]);
  });
  it("an unknown lookup is undefined and never throws, for any kind of value", () => {
    const registry = make();
    for (const value of ["nope.id", "", "__proto__", "constructor", "toString", "hasOwnProperty", undefined, null, 5, {}, [], Symbol("x"), { toString: () => { throw new Error("boom"); } }]) {
      expect(registry.get(value)).toBeUndefined();
      expect(registry.has(value)).toBe(false);
      expect(registry.forRoute(value)).toEqual([]);
    }
  });
});

describe("every rejection", () => {
  it.each([
    ["a duplicate id", () => make({}, [ok]), "duplicate id"],
    ["an id with no dot", () => make({ id: "profile" }), "malformed id"],
    ["an uppercase first letter", () => make({ id: "Profile.name" }), "malformed id"],
    ["an id with a selector character", () => make({ id: "profile.name input" }), "malformed id"],
    ["an id with a bracket", () => make({ id: "profile.name[0]" }), "malformed id"],
    ["a trailing dot", () => make({ id: "profile." }), "malformed id"],
    ["a non-string id", () => make({ id: 7 }), "malformed id"],
    ["an unknown route", () => make({ route: "billing" }), "unknown route"],
    ["an unknown role", () => make({ role: "password" }), "unknown role"],
    ["empty operations", () => make({ operations: [] }), "operations"],
    ["an unknown operation", () => make({ operations: ["highlight", "eval"] }), "operations"],
    ["a non-array operations", () => make({ operations: "highlight" }), "operations"],
    ["an unknown privacy", () => make({ privacy: "secret" }), "unknown privacy"],
    ["an empty label", () => make({ label: "  " }), "label"],
    ["a label over 80", () => make({ label: "x".repeat(81) }), "label"],
    ["markup in a label", () => make({ label: "<b>Name</b>" }), "label"],
    ["an ampersand in a description", () => make({ description: "a & b" }), "description"],
    ["a quote in a description", () => make({ description: 'say "hi"' }), "description"],
    ["a description over 240", () => make({ description: "x".repeat(241) }), "description"],
    ["a non-string description", () => make({ description: 5 }), "description"],
  ] as const)("%s", (_name, run, expected) => {
    expect(issues(run).join(" | ")).toContain(expected);
  });
  it("accepts the boundaries: label 80, description 240", () => {
    expect(make({ label: "x".repeat(80), description: "y".repeat(240) }).has("profile.nameInput")).toBe(true);
  });
  it("rejects __proto__ and friends as ids, and malformed or duplicate routes, and non-array input", () => {
    for (const id of ["__proto__", "constructor", "prototype", "__proto__.x", "constructor.x"]) {
      // `constructor.x` and `__proto__.x` are not special as ids; they must simply never match anything dangerous.
      const registry = (() => { try { return make({ id }); } catch { return undefined; } })();
      if (registry !== undefined) expect(registry.get("constructor")).toBeUndefined();
    }
    expect(issues(() => make({ id: "__proto__" }))).not.toEqual([]);
    expect(issues(() => make({ id: "constructor" }))).not.toEqual([]);
    expect(issues(() => createSemanticRegistry({ routes: ["profile", "profile"], elements: [] })).join()).toContain("duplicate route");
    expect(issues(() => createSemanticRegistry({ routes: ["bad route"], elements: [] })).join()).toContain("malformed route");
    expect(issues(() => createSemanticRegistry({ routes: "profile", elements: [] } as never))).not.toEqual([]);
    expect(issues(() => createSemanticRegistry({ routes: [], elements: [null as never] })).join()).toContain("element must be an object");
  });
  it("reports every problem at once, not only the first", () => {
    const found = issues(() => make({ route: "x", role: "y", privacy: "z" }));
    expect(found.length).toBeGreaterThanOrEqual(3);
  });
});
