/**
 * T403 (Feature 004): the host's trusted copy of the registry data equals the reference web app's real registry, field for field.
 *
 * Why a copy exists at all: the host may not import the reference web app, and the pure validator subpath it may import (`@dap/walkthrough/authoring`) carries no
 * registry of its own. So `apps/reference-host/src/authoring/trusted-registry.ts` repeats the data ONCE, and THIS root test, the only place that can see both sides, is the
 * REQUIRED check that it is exactly `createDemoRegistry()` (routes, the 8 elements with their operations and privacy) and `POSTCONDITION_NAMES`. The drift cases below
 * start from a perfect copy and break one thing each, proving the check can fail (the pattern of walkthrough-summary-parity.test.ts, T240). It also proves the REAL
 * built-in guides pass the host validator, so the host's rule set and the runtime's cannot have drifted apart without this failing.
 *
 * It needs no PostgreSQL and no DOM; it lives in tests/integration so `npm test` and the M1 gate run it.
 */
import { describe, expect, it } from "vitest";
import { TRUSTED_REGISTRY } from "../../apps/reference-host/src/authoring/trusted-registry.js";
import type { TrustedRegistryData } from "../../apps/reference-host/src/authoring/trusted-registry.js";
import { validateDefinition } from "../../apps/reference-host/src/authoring/validate.js";
import { POSTCONDITION_NAMES } from "../../apps/reference-web/src/postconditions.js";
import { createDemoRegistry } from "../../apps/reference-web/src/semantic-ui.js";
import { WALKTHROUGHS } from "../../apps/reference-web/src/walkthroughs/index.js";

/** Every way `host` differs from the real data, as readable problems; an empty list means exact equality (order included). */
export function driftBetween(host: TrustedRegistryData, real: TrustedRegistryData): string[] {
  const problems: string[] = [];
  if (JSON.stringify(host.routes) !== JSON.stringify(real.routes)) problems.push(`routes differ: host ${JSON.stringify(host.routes)}, real ${JSON.stringify(real.routes)}`);
  if (JSON.stringify(host.postconditionNames) !== JSON.stringify(real.postconditionNames)) problems.push(`postcondition names differ: host ${JSON.stringify(host.postconditionNames)}, real ${JSON.stringify(real.postconditionNames)}`);
  const hostById = new Map(host.elements.map((element) => [element.id, element]));
  const realById = new Map(real.elements.map((element) => [element.id, element]));
  if (hostById.size !== host.elements.length) problems.push("host data repeats an element id");
  for (const element of real.elements) {
    const copy = hostById.get(element.id);
    if (copy === undefined) { problems.push(`real element ${element.id} is missing from the host data`); continue; }
    for (const field of ["route", "role", "label", "description", "privacy"] as const) if (copy[field] !== element[field]) problems.push(`${element.id}: ${field} differs`);
    if (JSON.stringify([...copy.operations]) !== JSON.stringify([...element.operations])) problems.push(`${element.id}: operations differ`);
    const keys = Object.keys(copy).sort().join(",");
    if (keys !== Object.keys(element).sort().join(",")) problems.push(`${element.id}: host element has keys ${keys}`);
  }
  for (const element of host.elements) if (!realById.has(element.id)) problems.push(`host element ${element.id} does not exist in the real registry`);
  if (JSON.stringify(host.elements.map((e) => e.id)) !== JSON.stringify(real.elements.map((e) => e.id))) problems.push("element order differs");
  return problems;
}

const realData = (): TrustedRegistryData => {
  const registry = createDemoRegistry();
  return { routes: registry.routes, elements: registry.list(), postconditionNames: POSTCONDITION_NAMES };
};
/** A perfect mutable copy of the real data, to break one thing in. */
const copy = () => {
  const real = realData();
  return { routes: [...real.routes], elements: real.elements.map((e) => ({ ...e, operations: [...e.operations] })), postconditionNames: [...real.postconditionNames] } as { routes: string[]; elements: { -readonly [K in keyof TrustedRegistryData["elements"][number]]: TrustedRegistryData["elements"][number][K] }[]; postconditionNames: string[] };
};

describe("the host's trusted registry data is exactly the reference web app's real registry", () => {
  it("the real registry has the shape the host copy assumes (3 routes, 8 elements, 4 postcondition names), so the comparison is not vacuous", () => {
    const real = realData();
    expect(real.routes).toHaveLength(3);
    expect(real.elements).toHaveLength(8);
    expect(real.postconditionNames).toHaveLength(4);
  });
  it("matches field for field: routes, elements (id, route, role, label, description, operations, privacy, in order) and postcondition names", () => {
    expect(driftBetween(TRUSTED_REGISTRY, realData())).toEqual([]);
    expect(TRUSTED_REGISTRY.elements).toEqual(realData().elements);
    expect([...TRUSTED_REGISTRY.routes]).toEqual([...realData().routes]);
    expect([...TRUSTED_REGISTRY.postconditionNames]).toEqual([...POSTCONDITION_NAMES]);
  });
  it("the real built-in guides pass the host validator against the trusted data (one rule set: the host and the runtime agree)", () => {
    for (const definition of WALKTHROUGHS) {
      const result = validateDefinition(JSON.parse(JSON.stringify(definition)));
      expect(result, definition.id).toMatchObject({ ok: true });
    }
  });
  it("a draft built from the real registry's own elements is accepted by the host validator for EVERY element that allows highlight", () => {
    for (const element of realData().elements) {
      const wait = element.operations.includes("click") ? "click" : element.operations.includes("input") ? "input" : "ack";
      const result = validateDefinition({
        id: "wt-0123456789ab", title: "Probe", description: "Probe", start: "n1",
        steps: [{ id: "n1", kind: "navigate", route: element.route, next: "s1" }, { id: "s1", kind: "guide", target: element.id, text: "Probe.", wait, next: "done" }, { id: "done", kind: "complete", text: "Done." }],
      });
      expect(result, element.id).toMatchObject({ ok: true });
    }
  });
});

describe("the parity check can fail: deliberately drifted copies are caught", () => {
  const drift = (mutate: (data: ReturnType<typeof copy>) => void): string[] => { const data = copy(); mutate(data); return driftBetween(data as unknown as TrustedRegistryData, realData()); };
  it("a perfect copy has no drift", () => { expect(drift(() => undefined)).toEqual([]); });
  it("a changed label, description, role, privacy or route of one element", () => {
    expect(drift((d) => { d.elements[0]!.label = "Other"; })).toEqual(["nav.settings: label differs"]);
    expect(drift((d) => { d.elements[2]!.description = "Other"; })).toEqual(["profile.nameInput: description differs"]);
    expect(drift((d) => { d.elements[4]!.role = "link"; })).toEqual(["profile.saveButton: role differs"]);
    expect(drift((d) => { d.elements[3]!.privacy = "public"; })).toEqual(["profile.emailInput: privacy differs"]);
    expect(drift((d) => { d.elements[6]!.route = "profile"; })).toEqual(["settings.securityPanel: route differs"]);
  });
  it("an operation added or removed (the very thing that decides which waits a guide may use)", () => {
    expect(drift((d) => { d.elements[6]!.operations = ["highlight", "click"]; })).toEqual(["settings.securityPanel: operations differ"]);
    expect(drift((d) => { d.elements[4]!.operations = ["highlight"]; })).toEqual(["profile.saveButton: operations differ"]);
  });
  it("an element missing from, or extra in, the host data", () => {
    expect(drift((d) => { d.elements.pop(); })).toEqual(expect.arrayContaining(["real element settings.twoFactorSetup is missing from the host data"]));
    expect(drift((d) => { d.elements.push({ id: "profile.passwordInput", route: "profile", role: "textbox", label: "Password", description: "x", operations: ["highlight", "input"], privacy: "public" }); })).toEqual(expect.arrayContaining(["host element profile.passwordInput does not exist in the real registry"]));
  });
  it("a different element order, an extra key on an element", () => {
    expect(drift((d) => { d.elements.reverse(); })).toEqual(["element order differs"]);
    expect(drift((d) => { (d.elements[0] as Record<string, unknown>).extra = 1; }).join(" ")).toMatch(/nav.settings: host element has keys/);
  });
  it("a route added, removed or renamed", () => {
    expect(drift((d) => { d.routes.push("admin"); })).toHaveLength(1);
    expect(drift((d) => { d.routes.pop(); })).toHaveLength(1);
    expect(drift((d) => { d.routes[1] = "profile2"; })).toHaveLength(1);
  });
  it("a postcondition added, removed, renamed or reordered", () => {
    expect(drift((d) => { d.postconditionNames.push("profile.deleted"); })).toHaveLength(1);
    expect(drift((d) => { d.postconditionNames.pop(); })).toHaveLength(1);
    expect(drift((d) => { d.postconditionNames[0] = "profile.saved2"; })).toHaveLength(1);
    expect(drift((d) => { d.postconditionNames.reverse(); })).toHaveLength(1);
  });
  it("a drifted host copy changes what the host validator accepts (the failure mode the test guards against)", () => {
    const probe = { id: "wt-0123456789ab", title: "P", description: "P", start: "n1", steps: [{ id: "n1", kind: "navigate", route: "settings", next: "s1" }, { id: "s1", kind: "guide", target: "settings.securityPanel", text: "x", wait: "click", next: "done" }, { id: "done", kind: "complete", text: "x" }] };
    const drifted: TrustedRegistryData = { ...TRUSTED_REGISTRY, elements: TRUSTED_REGISTRY.elements.map((e) => (e.id === "settings.securityPanel" ? { ...e, operations: ["highlight", "click"] as const } : e)) };
    expect(validateDefinition(probe)).toMatchObject({ ok: false });
    expect(validateDefinition(probe, drifted)).toMatchObject({ ok: true });
    expect(driftBetween(drifted, realData())).not.toEqual([]);
  });
});
