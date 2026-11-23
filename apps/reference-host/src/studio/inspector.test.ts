import { describe, expect, it } from "vitest";
import type { BrowserSnapshot, ElementRef } from "@dap/browser-runtime";
import { MAX_CANDIDATES, classifyCandidates, routeOfUrl } from "./inspector.js";
import { REFERENCE_REGISTRY_ENTRY } from "./registries.js";
import { FIXTURE_ENTRY } from "./fixture-registry.js";

const ref = (n: number) => `@e${n}` as ElementRef;
const snap = (elements: BrowserSnapshot["elements"], url = "http://127.0.0.1:5173/#/profile"): BrowserSnapshot => ({ url, elements });
const registry = REFERENCE_REGISTRY_ENTRY.registry;
const ids = (entries: [number, string | null][]) => new Map(entries.map(([n, id]) => [ref(n), id] as const));

describe("routeOfUrl", () => {
  const pages = REFERENCE_REGISTRY_ENTRY.browser.pages;
  it("maps pathname + hash to the registry route", () => {
    expect(routeOfUrl("http://127.0.0.1:5173/", pages)).toBe("dashboard");
    expect(routeOfUrl("http://127.0.0.1:5173/#/dashboard", pages)).toBe("dashboard");
    expect(routeOfUrl("http://127.0.0.1:5173/#/profile", pages)).toBe("profile");
    expect(routeOfUrl("https://app.example/#/settings", pages)).toBe("settings");
  });
  it("is null for an unknown page, a query string, an inherited property name, junk and an empty value", () => {
    for (const url of ["http://127.0.0.1:5173/#/nope", "http://127.0.0.1:5173/?x=1#/profile", "http://127.0.0.1:5173/other", "not a url", "", "http://127.0.0.1:5173/#constructor", "http://127.0.0.1:5173/#/__proto__"]) expect(routeOfUrl(url, pages), url).toBeNull();
  });
});

describe("classifyCandidates", () => {
  const nameInput = { ref: ref(1), name: "Display name", role: "textbox" };
  it("is trusted only for a live id that is a public registry element of this route and role with the highlight operation", () => {
    expect(classifyCandidates(snap([nameInput]), ids([[1, "profile.nameInput"]]), "profile", registry)).toEqual([
      { ref: "@e1", name: "Display name", role: "textbox", route: "profile", status: "trusted", targetId: "profile.nameInput", operations: ["highlight", "input", "focus"], privacy: "public" },
    ]);
  });
  it.each([
    ["no id", null, "profile", "textbox"],
    ["an unknown id", "profile.nope", "profile", "textbox"],
    ["a private element", "profile.emailInput", "profile", "textbox"],
    ["another route's element", "settings.advancedToggle", "profile", "textbox"],
    ["another role", "profile.nameInput", "profile", "button"],
    ["a page that is not an application page", "profile.nameInput", null, "textbox"],
    ["an id for a route the page is not on", "profile.nameInput", "settings", "textbox"],
  ])("is unregistered for %s, with exactly the unregistered fields", (_name, id, route, role) => {
    const out = classifyCandidates(snap([{ ref: ref(1), name: "Display name", role }]), ids([[1, id]]), route, registry);
    expect(out).toEqual([{ ref: "@e1", name: "Display name", role, route, status: "unregistered" }]);
    expect(Object.keys(out[0]!).sort()).toEqual(["name", "ref", "role", "route", "status"]);
  });
  it("an element the batch read left out of the map is unregistered", () => {
    expect(classifyCandidates(snap([nameInput]), new Map(), "profile", registry)[0]).toMatchObject({ status: "unregistered" });
  });
  it("a registry element without the highlight operation is never trusted", () => {
    const noHighlight = { ...FIXTURE_ENTRY.registry, elements: [{ ...FIXTURE_ENTRY.registry.elements[0]!, operations: ["click"] as const }] };
    expect(classifyCandidates(snap([{ ref: ref(1), name: "Export", role: "button" }]), ids([[1, "orders.exportButton"]]), "orders", noHighlight)[0]).toMatchObject({ status: "unregistered" });
  });
  it("copies the operations (the registry cannot be changed through a reply) and freezes the result", () => {
    const [candidate] = classifyCandidates(snap([nameInput]), ids([[1, "profile.nameInput"]]), "profile", registry);
    expect(candidate).toBeDefined();
    expect(Object.isFrozen(candidate)).toBe(true);
    expect((candidate as { operations: unknown }).operations).not.toBe(registry.elements.find((e) => e.id === "profile.nameInput")!.operations);
  });
  it(`keeps at most ${MAX_CANDIDATES} candidates in snapshot order and drops one with an out-of-bounds ref, name or role`, () => {
    const many = Array.from({ length: 100 }, (_v, i) => ({ ref: ref(i + 1), name: "Display name", role: "textbox" }));
    expect(classifyCandidates(snap(many), new Map(), "profile", registry)).toHaveLength(MAX_CANDIDATES);
    const odd = [{ ref: ref(1), name: "n".repeat(121), role: "textbox" }, { ref: ref(2), name: "ok", role: "r".repeat(41) }, { ref: "@e03" as ElementRef, name: "ok", role: "textbox" }, { ref: ref(4), name: "n".repeat(120), role: "r".repeat(40) }];
    expect(classifyCandidates(snap(odd), new Map(), "profile", registry).map((c) => c.ref)).toEqual(["@e4"]);
  });
  it("an empty snapshot has no candidates", () => { expect(classifyCandidates(snap([]), new Map(), "profile", registry)).toEqual([]); });
});
