import type { BrowserSnapshot, ElementFacts, ElementRef } from "@dap/browser-runtime";
import { describe, expect, it } from "vitest";
import { MAX_INSPECTED, classifyControl, classifyManaged, pageOfUrl, routeOfPage, selectFactRefs, suggestLabel, suggestRouteName } from "./managed-inspector.js";
import type { ManagedRegistryView } from "./managed-inspector.js";
import type { RegistrableRole, TargetRecord } from "./registry-targets.js";
import { MAX_ROUTES_PER_APPLICATION, MAX_TARGETS_PER_APPLICATION } from "./registry-targets.js";

const ORIGIN = "http://127.0.0.1:5187";
const PUBLIC: ElementFacts = { tagName: null, inputType: null, autocomplete: null, dataAiPrivate: false, dataAiIgnore: false, dataAiRedact: false };
const ref = (n: number): ElementRef => `@e${n}`;
const target = (id: string, route: string, role: RegistrableRole, status: "active" | "disabled" = "active"): TargetRecord => ({
  id, route, page: `/#/${route}`, role, label: id, description: id, operations: role === "textbox" ? ["highlight", "input", "focus"] : ["highlight", "click"], privacy: "public", status, updatedAt: "2026-11-23T00:00:00.000Z",
});
const registry = (over: Partial<ManagedRegistryView> = {}): ManagedRegistryView => ({ routes: [{ route: "orders", page: "/#/orders" }], targets: [], ...over });

interface Control { name: string; role: string; id?: string | null; facts?: ElementFacts | null }
function input(controls: readonly Control[], url = `${ORIGIN}/#/orders`, reg: ManagedRegistryView = registry()) {
  const snapshot: BrowserSnapshot = { url, elements: controls.map((control, index) => ({ ref: ref(index + 1), role: control.role, name: control.name })) };
  const ids = new Map<ElementRef, string | null>(controls.map((control, index) => [ref(index + 1), control.id ?? null] as const));
  const facts = new Map<ElementRef, ElementFacts | null>(controls.map((control, index) => [ref(index + 1), control.facts === undefined ? PUBLIC : control.facts] as const));
  return { snapshot, ids, facts, registry: reg };
}
const only = (control: Control, url?: string, reg?: ManagedRegistryView) => classifyManaged(input([control], url, reg));

describe("pageOfUrl / routeOfPage", () => {
  it.each([
    [`${ORIGIN}/`, "/"], [`${ORIGIN}/#/orders`, "/#/orders"], [`${ORIGIN}/#/orders/open`, "/#/orders/open"],
    [`${ORIGIN}/orders`, null], [`${ORIGIN}/app/#/orders`, null], [`${ORIGIN}/?x=1#/orders`, null], [`${ORIGIN}/#orders`, null], [`${ORIGIN}/#/a?b=1`, null], ["not a url", null], [`${ORIGIN}/#/${"a".repeat(130)}`, null],
  ])("%s -> %s", (url, page) => { expect(pageOfUrl(url)).toBe(page); });
  it("maps a page to its registry route, a page that is not registered to null", () => {
    expect(routeOfPage("/#/orders", registry().routes)).toBe("orders");
    expect(routeOfPage("/#/other", registry().routes)).toBeNull();
    expect(routeOfPage(null, registry().routes)).toBeNull();
  });
});

describe("suggestRouteName", () => {
  it.each([
    ["/", [], "home"], ["/#/orders", [], "orders"], ["/#/order-list", [], "orderList"], ["/#/orders/open", [], "ordersOpen"], ["/#/Orders", [], "orders"], ["/#/2fa", [], "p2fa"], ["/#/a.b_c", [], "aBC"],
    ["/#/orders", ["orders"], "orders2"], ["/#/orders", ["orders", "orders2"], "orders3"], ["/", ["home"], "home2"],
  ])("%s with %j -> %s", (page, existing, expected) => { expect(suggestRouteName(page, existing)).toBe(expected); });
  it("never exceeds 40 characters, also with a numeric suffix, and always matches the route-name grammar", () => {
    const long = `/#/${"segment".repeat(10)}`;
    const first = suggestRouteName(long, []);
    expect(first.length).toBeLessThanOrEqual(40);
    const second = suggestRouteName(long, [first]);
    expect(second.length).toBeLessThanOrEqual(40);
    expect(second).not.toBe(first);
    expect(second).toMatch(/^[a-z][A-Za-z0-9]{0,39}$/u);
  });
});

describe("suggestLabel", () => {
  it("removes markup characters and control characters, collapses spaces and trims", () => {
    expect(suggestLabel(`  Save <b>"all"</b> & 'go'\n\`x\`  `, "orders.save")).toBe("Save b all /b go x");
    expect(suggestLabel("a\u202eb", "orders.save")).toBe("a b");
  });
  it("is at most 80 characters and never blank (last id segment as a fallback)", () => {
    expect(suggestLabel("x".repeat(200), "orders.save")).toHaveLength(80);
    expect(suggestLabel("<>&", "orders.exportButton")).toBe("exportButton");
    expect(suggestLabel("", "orders.save")).toBe("save");
  });
});

describe("classifyManaged: what is listed and in which state", () => {
  it("a new valid marker on a registered page: registrable, with the proposal derived from the live element (never from a request)", () => {
    const res = only({ name: "Export", role: "button", id: "orders.exportButton" });
    expect(res.elements).toEqual([{
      ref: "@e1", name: "Export", role: "button", route: "orders", status: "registrable",
      proposal: { targetId: "orders.exportButton", role: "button", page: "/#/orders", route: "orders", routeIsNew: false, suggestedLabel: "Export", allowedOperations: ["highlight", "click", "focus"], defaultOperations: ["highlight", "click"], privacy: "public" },
    }]);
    expect(res.hidden).toBe(0);
    expect(res.truncated).toBe(false);
  });
  it("a new page proposes a new route name (routeIsNew) and the element's own route is null", () => {
    const res = only({ name: "Note", role: "textbox", id: "orders.note" }, `${ORIGIN}/#/order-notes`);
    expect(res.elements[0]).toMatchObject({ route: null, status: "registrable", proposal: { route: "orderNotes", routeIsNew: true, page: "/#/order-notes", role: "textbox", defaultOperations: ["highlight", "input", "focus"] } });
  });
  it("a new route name that collides with an existing route gets a numeric suffix", () => {
    const res = only({ name: "Note", role: "button", id: "orders.note" }, `${ORIGIN}/#/Orders`, registry({ routes: [{ route: "orders", page: "/#/orders" }] }));
    expect(res.elements[0]).toMatchObject({ status: "registrable", proposal: { route: "orders2", routeIsNew: true } });
  });
  it("the D5 role map: button, link, textbox, searchbox, checkbox and combobox register; everything else is hidden", () => {
    const roles: [string, RegistrableRole | null][] = [["button", "button"], ["link", "link"], ["textbox", "textbox"], ["searchbox", "textbox"], ["checkbox", "checkbox"], ["combobox", "select"], ["radio", null], ["switch", null], ["menuitem", null], ["tab", null], ["heading", null], ["", null], ["BUTTON", null]];
    for (const [role, mapped] of roles) {
      const res = only({ name: "Thing", role, id: "orders.thing" });
      if (mapped === null) { expect(res.elements, role).toEqual([]); expect(res.hidden, role).toBe(1); }
      else expect(res.elements[0], role).toMatchObject({ status: "registrable", proposal: { role: mapped } });
    }
  });
  it.each<[string, { id: string | null }]>([
    ["no marker", { id: null }], ["an invalid marker", { id: "Orders.Export" }], ["an undotted marker", { id: "export" }], ["a marker over 80 characters", { id: `orders.${"a".repeat(80)}` }],
    ...["dap", "studio", "admin", "system", "internal"].map((prefix): [string, { id: string | null }] => [`the reserved prefix ${prefix}`, { id: `${prefix}.thing` }]),
  ])("%s is hidden and counted, never named", (_why, control) => {
    const res = only({ name: "Thing", role: "button", ...control });
    expect(res).toEqual({ elements: [], hidden: 1, truncated: false });
    expect(JSON.stringify(res)).not.toContain("Thing");
  });
  describe("privacy facts", () => {
    const hidden = (facts: ElementFacts | null) => only({ name: "Thing", role: "textbox", id: "orders.thing", facts });
    it.each([
      ["data-ai-ignore", { ...PUBLIC, dataAiIgnore: true }], ["data-ai-private", { ...PUBLIC, dataAiPrivate: true }], ["data-ai-redact", { ...PUBLIC, dataAiRedact: true }],
      ["a password input", { ...PUBLIC, inputType: "password" }], ["a hidden input", { ...PUBLIC, inputType: "hidden" }],
      ["autocomplete cc-number", { ...PUBLIC, autocomplete: "cc-number" }], ["autocomplete current-password", { ...PUBLIC, autocomplete: "current-password" }],
      ["autocomplete new-password", { ...PUBLIC, autocomplete: "new-password" }], ["autocomplete one-time-code", { ...PUBLIC, autocomplete: "one-time-code" }],
    ] as const)("%s is hidden", (_why, facts) => { expect(hidden(facts)).toEqual({ elements: [], hidden: 1, truncated: false }); });
    it("facts that could not be read (null) or are missing from the map are hidden", () => {
      expect(hidden(null)).toEqual({ elements: [], hidden: 1, truncated: false });
      const bare = input([{ name: "Thing", role: "textbox", id: "orders.thing" }]);
      expect(classifyManaged({ ...bare, facts: new Map() })).toEqual({ elements: [], hidden: 1, truncated: false });
    });
    it("a harmless email or text input is registrable", () => {
      expect(hidden({ ...PUBLIC, inputType: "email", autocomplete: "email" }).elements[0]).toMatchObject({ status: "registrable" });
    });
  });
  it.each(["Password", "Confirm password", "API key", "Card number", "CVV", "cvc", "SSN", "Social security number", "One-time code", "OTP", "Secret answer", "Access token", "Passcode", "Passwords"])(
    "a secret-looking accessible name (%s) is hidden", (name) => {
      expect(only({ name, role: "textbox", id: "orders.thing" })).toEqual({ elements: [], hidden: 1, truncated: false });
    });
  it.each(["", " ", "   ", "\t\n", "\u200b", "\u00a0\u200b\u2060", "\u3000"])("a blank accessible name (%j) is hidden, whatever the marker and the facts (defence in depth)", (name) => {
    expect(only({ name, role: "button", id: "orders.thing" })).toEqual({ elements: [], hidden: 1, truncated: false });
    const reg = registry({ targets: [target("orders.thing", "orders", "button")] });
    expect(classifyManaged(input([{ name, role: "button", id: "orders.thing" }], undefined, reg))).toEqual({ elements: [], hidden: 1, truncated: false });
  });
  it("a page that is not hash-routed is not registrable: other pathname, a query string, or an invalid URL", () => {
    for (const url of [`${ORIGIN}/orders`, `${ORIGIN}/?q=1#/orders`, "not a url"]) expect(only({ name: "Export", role: "button", id: "orders.exportButton" }, url), url).toEqual({ elements: [], hidden: 1, truncated: false });
  });
  it("an existing marker of the same route and role is trusted with its operations; of a disabled target it is `disabled` with name and id only", () => {
    const reg = registry({ targets: [target("orders.save", "orders", "button"), target("orders.old", "orders", "button", "disabled")] });
    const res = classifyManaged(input([{ name: "Save", role: "button", id: "orders.save" }, { name: "Old", role: "button", id: "orders.old" }], undefined, reg));
    expect(res.elements).toEqual([
      { ref: "@e1", name: "Save", role: "button", route: "orders", status: "trusted", targetId: "orders.save", operations: ["highlight", "click"], privacy: "public" },
      { ref: "@e2", name: "Old", role: "button", route: "orders", status: "disabled", targetId: "orders.old" },
    ]);
    expect(res.hidden).toBe(0);
  });
  it("an existing marker is NOT shown on another route, with another role, or on an unregistered page (it is hidden, never registrable: the id is taken)", () => {
    const reg = registry({ routes: [{ route: "orders", page: "/#/orders" }, { route: "home", page: "/" }], targets: [target("orders.save", "orders", "button")] });
    expect(classifyManaged(input([{ name: "Save", role: "button", id: "orders.save" }], `${ORIGIN}/`, reg)).elements, "other route").toEqual([]);
    expect(classifyManaged(input([{ name: "Save", role: "link", id: "orders.save" }], undefined, reg)).elements, "other role").toEqual([]);
    expect(classifyManaged(input([{ name: "Save", role: "button", id: "orders.save" }], `${ORIGIN}/#/unknown`, reg)).elements, "unregistered page").toEqual([]);
    expect(classifyManaged(input([{ name: "Save", role: "radio", id: "orders.save" }], undefined, reg)).elements, "non-registrable role").toEqual([]);
  });
  describe("a registered control passes the SAME privacy and name gate on every inspection (E2)", () => {
    const reg = () => registry({ targets: [target("orders.save", "orders", "button"), target("orders.off", "orders", "button", "disabled")] });
    const FACTS: [string, ElementFacts][] = [
      ["data-ai-ignore", { ...PUBLIC, dataAiIgnore: true }], ["data-ai-private", { ...PUBLIC, dataAiPrivate: true }], ["data-ai-redact", { ...PUBLIC, dataAiRedact: true }],
      ["a password input", { ...PUBLIC, inputType: "password" }], ["a hidden input", { ...PUBLIC, inputType: "hidden" }],
      ["autocomplete cc-number", { ...PUBLIC, autocomplete: "cc-number" }], ["autocomplete current-password", { ...PUBLIC, autocomplete: "current-password" }],
      ["autocomplete new-password", { ...PUBLIC, autocomplete: "new-password" }], ["autocomplete one-time-code", { ...PUBLIC, autocomplete: "one-time-code" }],
    ];
    it.each(FACTS)("a trusted and a disabled control that became %s is hidden, never named and never trusted", (_why, facts) => {
      const res = classifyManaged(input([{ name: "Save", role: "button", id: "orders.save", facts }, { name: "Old", role: "button", id: "orders.off", facts }], undefined, reg()));
      expect(res).toEqual({ elements: [], hidden: 2, truncated: false });
      expect(JSON.stringify(res)).not.toMatch(/Save|Old|orders\.save|orders\.off/u);
    });
    it("facts that could not be read (null) or are missing hide a registered control too", () => {
      expect(classifyManaged(input([{ name: "Save", role: "button", id: "orders.save", facts: null }], undefined, reg()))).toEqual({ elements: [], hidden: 1, truncated: false });
      const bare = input([{ name: "Save", role: "button", id: "orders.save" }], undefined, reg());
      expect(classifyManaged({ ...bare, facts: new Map() })).toEqual({ elements: [], hidden: 1, truncated: false });
    });
    it.each(["Password", "Reveal your API key", "Card number", "OTP"])("a registered control whose accessible name is now secret-looking (%s) is hidden", (name) => {
      expect(classifyManaged(input([{ name, role: "button", id: "orders.save" }], undefined, reg()))).toEqual({ elements: [], hidden: 1, truncated: false });
    });
    it("a registered control with public facts stays trusted or disabled (the gate does not hide good controls)", () => {
      const res = classifyManaged(input([{ name: "Save", role: "button", id: "orders.save" }, { name: "Old", role: "button", id: "orders.off" }], undefined, reg()));
      expect(res.elements.map((element) => element.status)).toEqual(["trusted", "disabled"]);
    });
  });
  it("registry caps: at 200 targets nothing new is registrable; at 20 routes a NEW page is not, a known page still is", () => {
    const full = Array.from({ length: MAX_TARGETS_PER_APPLICATION }, (_, i) => target(`orders.t${i}`, "orders", "button"));
    expect(only({ name: "X", role: "button", id: "orders.fresh" }, undefined, registry({ targets: full })).elements).toEqual([]);
    const routes = Array.from({ length: MAX_ROUTES_PER_APPLICATION }, (_, i) => ({ route: `r${i}`, page: `/#/r${i}` }));
    expect(only({ name: "X", role: "button", id: "orders.fresh" }, `${ORIGIN}/#/brandNew`, registry({ routes })).elements).toEqual([]);
    expect(only({ name: "X", role: "button", id: "orders.fresh" }, `${ORIGIN}/#/r3`, registry({ routes })).elements[0]).toMatchObject({ status: "registrable", proposal: { route: "r3", routeIsNew: false } });
  });
  it("oversized names and roles never leave the host", () => {
    expect(only({ name: "x".repeat(121), role: "button", id: "orders.thing" }).elements).toEqual([]);
    expect(only({ name: "x".repeat(120), role: "button", id: "orders.thing" }).elements).toHaveLength(1);
  });
  it("only well-formed refs are listed", () => {
    const snapshot: BrowserSnapshot = { url: `${ORIGIN}/#/orders`, elements: [{ ref: "@e01" as ElementRef, role: "button", name: "A" }, { ref: "@e0" as ElementRef, role: "button", name: "B" }] };
    const ids = new Map<ElementRef, string | null>([["@e01" as ElementRef, "orders.a"], ["@e0" as ElementRef, "orders.b"]]);
    const facts = new Map<ElementRef, ElementFacts | null>([["@e01" as ElementRef, PUBLIC], ["@e0" as ElementRef, PUBLIC]]);
    expect(classifyManaged({ snapshot, ids, facts, registry: registry() })).toEqual({ elements: [], hidden: 2, truncated: false });
  });
  it("lists in document order and counts hidden = every control not listed", () => {
    const res = classifyManaged(input([
      { name: "Zeta", role: "button", id: "orders.zeta" }, { name: "Skip", role: "button" }, { name: "Alpha", role: "link", id: "orders.alpha" }, { name: "Heading", role: "heading", id: "orders.h" },
    ]));
    expect(res.elements.map((element) => element.name)).toEqual(["Zeta", "Alpha"]);
    expect(res.hidden).toBe(2);
  });
  it("at most 64 controls are inspected: the 65th is never listed and `truncated` is set; hidden counts the uninspected ones too", () => {
    const controls: Control[] = Array.from({ length: 70 }, (_, i) => ({ name: `C${i}`, role: "button", id: `orders.c${i}` }));
    const res = classifyManaged(input(controls));
    expect(MAX_INSPECTED).toBe(64);
    expect(res.elements).toHaveLength(64);
    expect(res.elements.at(-1)?.name).toBe("C63");
    expect(res.truncated).toBe(true);
    expect(res.hidden).toBe(6);
    expect(classifyManaged(input(controls.slice(0, 64))).truncated).toBe(false);
  });
  it("the reply carries no field beyond the contract (no facts, no raw ids of hidden elements)", () => {
    const res = classifyManaged(input([{ name: "Export", role: "button", id: "orders.exportButton" }, { name: "Hidden thing", role: "button", id: "dap.secret", facts: { ...PUBLIC, dataAiPrivate: true } }]));
    expect(Object.keys(res).sort()).toEqual(["elements", "hidden", "truncated"]);
    expect(JSON.stringify(res)).not.toMatch(/Hidden thing|dap\.secret|dataAi/u);
  });
});

describe("a marker on more than one control of the inspected set is ambiguous: none of them is listed, all are counted as hidden (H5)", () => {
  const reg = () => registry({ targets: [target("orders.save", "orders", "button"), target("orders.off", "orders", "button", "disabled")] });
  it("two controls with one new marker: neither is registrable, both are hidden, neither name leaks", () => {
    const res = classifyManaged(input([{ name: "First twin", role: "button", id: "orders.twin" }, { name: "Second twin", role: "link", id: "orders.twin" }, { name: "Other", role: "button", id: "orders.other" }]));
    expect(res.elements.map((e) => e.name)).toEqual(["Other"]);
    expect(res.hidden).toBe(2);
    expect(JSON.stringify(res)).not.toMatch(/twin/iu);
  });
  it("three controls with one marker: all three are hidden", () => {
    const res = classifyManaged(input([{ name: "A", role: "button", id: "orders.twin" }, { name: "B", role: "button", id: "orders.twin" }, { name: "C", role: "button", id: "orders.twin" }]));
    expect(res).toEqual({ elements: [], hidden: 3, truncated: false });
  });
  it("a duplicate of a REGISTERED target hides both: neither is trusted (active) nor disabled", () => {
    expect(classifyManaged(input([{ name: "Save", role: "button", id: "orders.save" }, { name: "Save again", role: "button", id: "orders.save" }], undefined, reg()))).toEqual({ elements: [], hidden: 2, truncated: false });
    expect(classifyManaged(input([{ name: "Old", role: "button", id: "orders.off" }, { name: "Old again", role: "button", id: "orders.off" }], undefined, reg()))).toEqual({ elements: [], hidden: 2, truncated: false });
  });
  it("the rule counts every control of the inspected set with the marker, whatever its role, privacy or name: a private, non-registrable or secret-named twin still makes the visible one ambiguous", () => {
    const twins: Control[] = [
      { name: "Hidden twin", role: "button", id: "orders.twin", facts: { ...PUBLIC, dataAiPrivate: true } },
      { name: "Heading twin", role: "heading", id: "orders.twin" },
      { name: "Password twin", role: "textbox", id: "orders.twin" },
      { name: "Unreadable twin", role: "button", id: "orders.twin", facts: null },
    ];
    for (const twin of twins) {
      const res = classifyManaged(input([{ name: "Visible", role: "button", id: "orders.twin" }, twin]));
      expect(res, twin.name).toEqual({ elements: [], hidden: 2, truncated: false });
    }
  });
  it("a twin beyond the 64 inspected controls is not seen (the adapter reads at most 64 markers): the documented limit", () => {
    const filler: Control[] = Array.from({ length: 63 }, (_, i) => ({ name: `F${i}`, role: "button", id: `orders.f${i}` }));
    const res = classifyManaged(input([{ name: "Visible", role: "button", id: "orders.twin" }, ...filler, { name: "Twin past the bound", role: "button", id: "orders.twin" }]));
    expect(res.elements.map((e) => e.name)).toContain("Visible");
    expect(res.truncated).toBe(true);
  });
  it("different markers and controls without a marker are never ambiguous", () => {
    const res = classifyManaged(input([{ name: "A", role: "button", id: "orders.a" }, { name: "B", role: "button", id: "orders.b" }, { name: "N1", role: "button" }, { name: "N2", role: "button" }]));
    expect(res.elements.map((e) => e.name)).toEqual(["A", "B"]);
  });
  it("classifyControl applies the same rule (used to re-verify a registration)", () => {
    const i = input([{ name: "A", role: "button", id: "orders.twin" }, { name: "B", role: "button", id: "orders.twin" }]);
    expect(classifyControl(i, i.snapshot.elements[0]!)).toBeNull();
    expect(classifyControl(i, i.snapshot.elements[1]!)).toBeNull();
  });
});

describe("selectFactRefs: facts are read for every control that could be listed", () => {
  it("selects registrable-role controls with a valid marker, registered or not, at most 64, in document order", () => {
    const reg = registry({ targets: [target("orders.known", "orders", "button")] });
    const { snapshot, ids } = input([
      { name: "A", role: "button", id: "orders.a" }, { name: "Known", role: "button", id: "orders.known" }, { name: "R", role: "radio", id: "orders.r" }, { name: "N", role: "button" }, { name: "Bad", role: "button", id: "Orders.bad" },
      { name: "B", role: "textbox", id: "orders.b" },
    ], undefined, reg);
    expect(selectFactRefs(snapshot, ids)).toEqual(["@e1", "@e2", "@e6"]);
  });
  it("never selects past the 64th control", () => {
    const controls: Control[] = Array.from({ length: 70 }, (_, i) => ({ name: `C${i}`, role: "button", id: `orders.c${i}` }));
    const { snapshot, ids } = input(controls);
    expect(selectFactRefs(snapshot, ids)).toHaveLength(64);
  });
});

describe("classifyControl", () => {
  it("is the same decision classifyManaged makes for one control (used to re-verify a registration against fresh facts)", () => {
    const i = input([{ name: "Export", role: "button", id: "orders.exportButton" }]);
    expect(classifyControl(i, i.snapshot.elements[0]!)).toEqual(classifyManaged(i).elements[0]);
    const closed = { ...i, facts: new Map<ElementRef, ElementFacts | null>([["@e1", { ...PUBLIC, dataAiPrivate: true }]]) };
    expect(classifyControl(closed, closed.snapshot.elements[0]!)).toBeNull();
  });
});
