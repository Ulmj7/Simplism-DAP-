/**
 * T311 contract test (Feature 003): `parseSemanticContextInput` mirrors Feature 002's `runtime.context()` shape. `@dap/ai` cannot import
 * `@dap/walkthrough` (dependency-cruiser), so this root test, which may import both, builds a REAL registry and runtime over fake ports and checks that
 * every real context validates against the AI-side schema and comes back unchanged. If either side drifts, this test fails. It needs no PostgreSQL.
 *
 * Drift found when this test was written: for a page whose route is not in the registry the runtime returns `{ route: "", elements: [] }`; the AI-side
 * schema refused the empty route. The AI-side mirror was fixed (Feature 002 is untouched).
 */
import { describe, expect, it } from "vitest";
import { WALKTHROUGH_ID, parseCatalogSummaries, parseSemanticContextInput } from "../../packages/ai/src/index.js";
import { createSemanticRegistry, createWalkthroughCatalog, createWalkthroughRuntime, defineWalkthrough } from "../../packages/walkthrough/src/index.js";
import type { SemanticElementDef, TargetAvailability } from "../../packages/walkthrough/src/index.js";
import type { WalkthroughStarter } from "../../apps/reference-host/src/guidance/capability.js";

const el = (id: string, route: string, role: SemanticElementDef["role"], privacy: SemanticElementDef["privacy"] = "public"): SemanticElementDef =>
  ({ id, route, role, label: `Label of ${id}`, description: `Description of ${id}`, operations: ["highlight"], privacy });
const ELEMENTS: readonly SemanticElementDef[] = [
  el("nav.settings", "dashboard", "link"),
  el("profile.nameInput", "profile", "textbox"),
  el("profile.emailInput", "profile", "textbox", "private"),
  el("profile.phoneInput", "profile", "textbox", "redact"),
  el("profile.saveButton", "profile", "button"),
  el("settings.securityPanel", "settings", "panel"),
  el("settings.twoFactorSetup", "settings", "button"),
  ...(["button", "link", "textbox", "checkbox", "select", "panel", "nav", "heading", "text"] as const).map((role) => el(`roles.${role}Sample`, "roles", role)),
];
const ROUTES = ["dashboard", "profile", "settings", "roles"] as const;
const TRIVIAL = defineWalkthrough({
  id: "profileUpdate", title: "Update your profile", description: "Change your name and save", start: "a1",
  steps: [{ id: "a1", kind: "navigate", route: "profile", next: "adone" }, { id: "adone", kind: "complete", text: "Done." }],
});

function runtimeAt(route: string, availability: (id: string) => TargetAvailability) {
  const registry = createSemanticRegistry({ routes: ROUTES, elements: ELEMENTS });
  const catalog = createWalkthroughCatalog(registry, [], [TRIVIAL]);
  return createWalkthroughRuntime({
    registry, catalog,
    targets: { resolve: availability },
    router: { current: () => route, navigate: () => undefined },
    presenter: { apply: () => undefined },
    timers: { set: () => () => undefined },
    postconditions: {},
  });
}

describe("the AI-side semantic context schema accepts every real runtime.context() output", () => {
  it.each(["dashboard", "profile", "settings", "roles"])("route %s, with available and unavailable targets, private and redact elements", (route) => {
    const context = runtimeAt(route, (id) => (id.length % 2 === 0 ? "available" : "unavailable")).context();
    const parsed = parseSemanticContextInput(context);
    expect(parsed).not.toBeNull();
    expect(parsed).toEqual(context);
  });
  it("includes elements marked private and redact, and elements that are unavailable", () => {
    const context = runtimeAt("profile", (id) => (id === "profile.nameInput" ? "available" : "unavailable")).context();
    expect(context.elements.map((e) => e.privacy).sort()).toEqual(["private", "public", "public", "redact"]);
    expect(context.elements.filter((e) => !e.available).length).toBeGreaterThan(0);
    expect(parseSemanticContextInput(context)).toEqual(context);
  });
  it("every role the runtime can produce is accepted", () => {
    const context = runtimeAt("roles", () => "available").context();
    expect(new Set(context.elements.map((e) => e.role))).toEqual(new Set(["button", "link", "textbox", "checkbox", "select", "panel", "nav", "heading", "text"]));
    expect(parseSemanticContextInput(context)).toEqual(context);
  });
  it("a page the registry does not know yields the empty route with no elements, and that is accepted (the drift this test found)", () => {
    const context = runtimeAt("not-a-registered-route", () => "available").context();
    expect(context).toEqual({ route: "", elements: [] });
    expect(parseSemanticContextInput(context)).toEqual({ route: "", elements: [] });
  });
  it("a router or availability port that throws still gives an accepted, fail-closed context", () => {
    const registry = createSemanticRegistry({ routes: ROUTES, elements: ELEMENTS });
    const runtime = createWalkthroughRuntime({
      registry, catalog: createWalkthroughCatalog(registry, [], [TRIVIAL]),
      targets: { resolve: () => { throw new Error("boom"); } },
      router: { current: () => "profile", navigate: () => undefined },
      presenter: { apply: () => undefined }, timers: { set: () => () => undefined }, postconditions: {},
    });
    const context = runtime.context();
    expect(context.elements.every((e) => e.available === false)).toBe(true);
    expect(parseSemanticContextInput(context)).toEqual(context);
  });
  it("the real shape carries exactly the keys the mirror allows: nothing extra is dropped silently", () => {
    const context = runtimeAt("profile", () => "available").context();
    expect(Object.keys(context).sort()).toEqual(["elements", "route"]);
    for (const element of context.elements) expect(Object.keys(element).sort()).toEqual(["available", "description", "id", "label", "privacy", "role"]);
  });
});

describe("the host's structural WalkthroughStarter adapts Feature 002's runtime with a one-line wrapper (type and shape compatibility only; the end-to-end start is T318)", () => {
  it("runtime.startWalkthrough(id) fits WalkthroughStarter.start(id): { ok: true } for a catalog id, { ok: false, reason } otherwise", () => {
    const runtime = runtimeAt("dashboard", () => "available");
    const starter: WalkthroughStarter = { start: (id) => runtime.startWalkthrough(id) }; // compiles only if StartResult is assignable to the host's result type
    expect(starter.start("profileUpdate")).toEqual({ ok: true });
    runtime.cancel();
    expect(starter.start("adminTakeover")).toEqual({ ok: false, reason: "unknown_walkthrough" });
    expect(starter.start("__proto__")).toMatchObject({ ok: false });
    runtime.cancel();
  });
});

describe("the AI walkthrough id grammar agrees with the REAL catalog (Feature 002's ID_GRAMMAR)", () => {
  const registry = createSemanticRegistry({ routes: ROUTES, elements: ELEMENTS });
  const defOf = (id: string) => defineWalkthrough({
    id, title: `Title of ${id.slice(0, 20)}`, description: "A walkthrough used to probe the id grammar", start: "a1",
    steps: [{ id: "a1", kind: "navigate", route: "profile", next: "adone" }, { id: "adone", kind: "complete", text: "Done." }],
  });
  const realAccepts = (id: string): boolean => { try { createWalkthroughCatalog(registry, [], [defOf(id)]); return true; } catch { return false; } };
  const SAMPLE = [
    "profileUpdate", "find-security", "find_two_factor", "a", "Z", "a-", "a_", "a1-b_2", "a".repeat(64), "a".repeat(65), "1abc", "_abc", "-abc", " abc", "abc ", "ab c", "abc\n",
    "a.b", "a/b", "a:b", "caf\u00e9", "\u0430bc", "\uff41bc", "abc\u200b", "a\u2010b", "", "__proto__", "constructor", "prototype", "toString", "hasOwnProperty", "valueOf",
  ];
  const RESERVED = new Set(["__proto__", "constructor", "prototype", "toString", "hasOwnProperty", "valueOf"]);
  it.each(SAMPLE)("the AI grammar and the real catalog agree on %j", (id) => {
    expect(WALKTHROUGH_ID.test(id) && !RESERVED.has(id)).toBe(realAccepts(id));
  });
  it("the real catalog accepts find-security, find_two_factor and a 64-character id, and the AI catalog parse accepts its list()", () => {
    const ids = ["find-security", "find_two_factor", "a".repeat(64)];
    const catalog = createWalkthroughCatalog(registry, [], ids.map(defOf));
    const parsed = parseCatalogSummaries(catalog.list());
    expect(parsed?.map((s) => s.id)).toEqual(ids);
  });
  it("an id the real catalog refuses (65 characters, a leading digit) is refused by the AI grammar too", () => {
    for (const id of ["a".repeat(65), "1profile"]) { expect(realAccepts(id)).toBe(false); expect(WALKTHROUGH_ID.test(id)).toBe(false); }
  });
});
