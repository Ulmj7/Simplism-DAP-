import { describe, expect, it } from "vitest";
import { createSemanticRegistry } from "../semantic/registry.js";
import { buildSemanticContext, describeValue, effectivePrivacy, REDACTED_MARKER } from "./privacy.js";
import type { ElementFacts } from "./privacy.js";

const base: ElementFacts = { ignoredByAncestorOrSelf: false, private: false, redact: false, tagName: "INPUT", inputType: "text" };
const facts = (over: Partial<ElementFacts>): ElementFacts => ({ ...base, ...over });

describe("effectivePrivacy", () => {
  it("is public for a plain field", () => expect(effectivePrivacy(base)).toBe("public"));
  it("ignores an element inside (or carrying) data-ai-ignore, even when registered as public", () => {
    expect(effectivePrivacy(facts({ ignoredByAncestorOrSelf: true, registryPrivacy: "public" }))).toBe("ignore");
  });
  it.each(["password", "PASSWORD", " hidden ", "hidden"])("always ignores input type=%j, registered or not", (inputType) => {
    expect(effectivePrivacy(facts({ inputType }))).toBe("ignore");
    expect(effectivePrivacy(facts({ inputType, registryPrivacy: "public", private: false }))).toBe("ignore");
  });
  it("does not treat other tags or types as ignored", () => {
    expect(effectivePrivacy(facts({ tagName: "div", inputType: "password" }))).toBe("public");
    expect(effectivePrivacy(facts({ inputType: "email" }))).toBe("public");
    expect(effectivePrivacy(facts({ inputType: null }))).toBe("public");
  });
  it("private and redact come from the markup or the registry; private is the stricter", () => {
    expect(effectivePrivacy(facts({ private: true }))).toBe("private");
    expect(effectivePrivacy(facts({ redact: true }))).toBe("redact");
    expect(effectivePrivacy(facts({ registryPrivacy: "private" }))).toBe("private");
    expect(effectivePrivacy(facts({ registryPrivacy: "redact" }))).toBe("redact");
    expect(effectivePrivacy(facts({ redact: true, registryPrivacy: "private" }))).toBe("private");
  });
});

describe("describeValue never returns the value", () => {
  const SECRET = "hunter2-SECRET <b>html</b>";
  it.each(["ignore", "private", "redact", "public"] as const)("%s", (privacy) => {
    const view = describeValue(privacy, SECRET);
    expect(JSON.stringify(view)).not.toContain("hunter2");
    expect(JSON.stringify(view)).not.toContain("html");
  });
  it("shapes", () => {
    expect(describeValue("private", SECRET)).toEqual({ kind: "omitted" });
    expect(describeValue("ignore", SECRET)).toEqual({ kind: "omitted" });
    expect(describeValue("redact", SECRET)).toEqual({ kind: "redacted", marker: REDACTED_MARKER });
    expect(REDACTED_MARKER).toBe("[REDACTED]");
    expect(describeValue("public", SECRET)).toEqual({ kind: "present" });
    expect(describeValue("public", "")).toEqual({ kind: "empty" });
    expect(describeValue("public", undefined)).toEqual({ kind: "empty" });
    expect(describeValue("public", 12345)).toEqual({ kind: "empty" });
  });
  it("fixtures: ignored, private, redacted, password and hidden fields leak nothing through effectivePrivacy + describeValue", () => {
    const fixtures: [string, ElementFacts][] = [
      ["ignored", facts({ ignoredByAncestorOrSelf: true })], ["private", facts({ private: true })], ["redacted", facts({ redact: true })],
      ["password", facts({ inputType: "password" })], ["hidden", facts({ inputType: "hidden" })],
    ];
    for (const [name, f] of fixtures) expect(JSON.stringify(describeValue(effectivePrivacy(f), SECRET)), name).not.toMatch(/hunter2|SECRET|html/);
  });
});

describe("buildSemanticContext", () => {
  const registry = createSemanticRegistry({
    routes: ["profile", "settings"],
    elements: [
      { id: "profile.nameInput", route: "profile", role: "textbox", label: "Name", description: "Your display name", operations: ["highlight"], privacy: "public" },
      { id: "profile.emailInput", route: "profile", role: "textbox", label: "Email", description: "Your email address", operations: ["highlight"], privacy: "private" },
      { id: "settings.advancedToggle", route: "settings", role: "checkbox", label: "Advanced", description: "Show advanced settings", operations: ["click"], privacy: "public" },
    ],
  });
  it("contains registry metadata and availability for the route, and nothing else", () => {
    const context = buildSemanticContext(registry, "profile", (id) => id === "profile.nameInput");
    expect(context).toEqual({
      route: "profile",
      elements: [
        { id: "profile.nameInput", role: "textbox", label: "Name", description: "Your display name", privacy: "public", available: true },
        { id: "profile.emailInput", role: "textbox", label: "Email", description: "Your email address", privacy: "private", available: false },
      ],
    });
    expect(Object.keys(context).sort()).toEqual(["elements", "route"]);
    for (const element of context.elements) expect(Object.keys(element).sort()).toEqual(["available", "description", "id", "label", "privacy", "role"]);
    expect(Object.isFrozen(context)).toBe(true);
  });
  it("an unknown route is empty, a throwing or non-boolean availability counts as unavailable, and it never reads a value", () => {
    expect(buildSemanticContext(registry, "billing", () => true)).toEqual({ route: "billing", elements: [] });
    expect(buildSemanticContext(registry, "settings", () => { throw new Error("x"); }).elements[0]?.available).toBe(false);
    expect(buildSemanticContext(registry, "settings", (() => "yes") as never).elements[0]?.available).toBe(false);
  });
});


it.each(["cc-number", "current-password", "one-time-code"])("ignores sensitive autocomplete hint %s even on a public text input", autocomplete => {
  expect(effectivePrivacy(facts({ autocomplete }))).toBe("ignore");
});
