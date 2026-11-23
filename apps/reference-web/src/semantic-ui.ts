import { copy } from "./copy.js";
/** The demo's semantic registry: the stable ids a walkthrough may name. The password field is deliberately NOT here. */
import { createSemanticRegistry } from "@dap/walkthrough";
import type { SemanticElementDef, SemanticRegistry } from "@dap/walkthrough";

export const ROUTE_IDS = ["dashboard", "profile", "settings"] as const;

export const DEMO_ELEMENTS: readonly SemanticElementDef[] = [
  { id: "nav.settings", route: "dashboard", role: "link", label: copy.semantic["nav.settings"].label, description: copy.semantic["nav.settings"].description, operations: ["highlight", "click"], privacy: "public" },
  { id: "nav.profile", route: "dashboard", role: "link", label: copy.semantic["nav.profile"].label, description: copy.semantic["nav.profile"].description, operations: ["highlight", "click"], privacy: "public" },
  { id: "profile.nameInput", route: "profile", role: "textbox", label: copy.semantic["profile.nameInput"].label, description: copy.semantic["profile.nameInput"].description, operations: ["highlight", "input", "focus"], privacy: "public" },
  { id: "profile.emailInput", route: "profile", role: "textbox", label: copy.semantic["profile.emailInput"].label, description: copy.semantic["profile.emailInput"].description, operations: ["highlight", "input"], privacy: "private" },
  { id: "profile.saveButton", route: "profile", role: "button", label: copy.semantic["profile.saveButton"].label, description: copy.semantic["profile.saveButton"].description, operations: ["highlight", "click"], privacy: "public" },
  { id: "settings.advancedToggle", route: "settings", role: "button", label: copy.semantic["settings.advancedToggle"].label, description: copy.semantic["settings.advancedToggle"].description, operations: ["highlight", "click"], privacy: "public" },
  { id: "settings.securityPanel", route: "settings", role: "panel", label: copy.semantic["settings.securityPanel"].label, description: copy.semantic["settings.securityPanel"].description, operations: ["highlight"], privacy: "public" },
  { id: "settings.twoFactorSetup", route: "settings", role: "button", label: copy.semantic["settings.twoFactorSetup"].label, description: copy.semantic["settings.twoFactorSetup"].description, operations: ["highlight", "click"], privacy: "public" },
];

export function createDemoRegistry(): SemanticRegistry {
  return createSemanticRegistry({ routes: ROUTE_IDS, elements: DEMO_ELEMENTS });
}
