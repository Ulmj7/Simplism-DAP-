import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { UiTarget } from "@dap/browser-runtime";
import type { DiscoveredUiMap } from "./discover-ui-map.js";
import { planMapGuide } from "./ui-map-guide.js";

const hash = (value: string) => createHash("sha256").update(value).digest("hex");
const id = (target: UiTarget) => hash(JSON.stringify([target.page, target.section, target.role, target.name, target.marker]));
const menu = { page: "/profile", role: "button", name: "Санхүү", section: [], marker: null };
const link = { page: "/profile", role: "link", name: "Нэхэмжлэх", section: ["Санхүү"], marker: null };
const create = { page: "/invoices", role: "button", name: "Шинэ нэхэмжлэх", section: ["Нэхэмжлэх"], marker: null };
const map: DiscoveredUiMap = {
  start: "profile",
  states: [
    { id: "profile", page: "/profile", targets: [menu], truncated: false },
    { id: "finance", page: "/profile", targets: [menu, link], truncated: false },
    { id: "invoices", page: "/invoices", targets: [create], truncated: false },
  ],
  transitions: [
    { from: "profile", to: "finance", status: "observed", action: { kind: "menu", target: menu, href: null } },
    { from: "finance", to: "invoices", status: "observed", action: { kind: "link", target: link, href: "/invoices" } },
  ],
  limited: false,
};

describe("UI map guidance", () => {
  it("returns the verified menu, page and final element using digests", () => {
    const result = planMapGuide(map, "Нэхэмжлэхээ хаана үүсгэх вэ?", hash("/profile"), [id(menu)]);
    expect(result).toEqual({ kind: "route", steps: [
      { kind: "menu", page: hash("/profile"), target: id(menu), after: hash("/profile") },
      { kind: "link", page: hash("/profile"), target: id(link), after: hash("/invoices"), href: hash("/invoices") },
      { kind: "target", page: hash("/invoices"), target: id(create) },
    ] });
  });

  it("starts at the already opened menu when its controls are visible", () => {
    const result = planMapGuide(map, "Шинэ нэхэмжлэх", hash("/profile"), [id(menu), id(link)]);
    expect(result).toMatchObject({ kind: "route", steps: [{ kind: "link" }, { kind: "target" }] });
  });

  it("does not traverse an unverified transition or start with unseen UI", () => {
    const restricted = { ...map, transitions: map.transitions.map(edge =>
      edge.action.kind === "link" ? { ...edge, status: "access-required" as const } : edge) };
    expect(planMapGuide(restricted, "Нэхэмжлэх үүсгэх", hash("/profile"), [id(menu)])).toEqual({ kind: "unmapped" });
    expect(planMapGuide(map, "Шинэ нэхэмжлэх", hash("/profile"), [id(create)])).toEqual({ kind: "unmapped" });
  });

  it("requests clarification for matching controls in different sections", () => {
    const second = { ...create, section: ["Ноорог"] };
    const ambiguous = { ...map, states: map.states.map(state =>
      state.id === "invoices" ? { ...state, targets: [create, second] } : state) };
    expect(planMapGuide(ambiguous, "Шинэ нэхэмжлэх", hash("/profile"), [id(menu)])).toEqual({ kind: "clarify" });
    const result = planMapGuide(ambiguous, "Ноорог дахь шинэ нэхэмжлэх", hash("/profile"), [id(menu)]);
    expect(result).toMatchObject({ kind: "route", steps: [{ kind: "menu" }, { kind: "link" }, { target: id(second) }] });
  });
});
