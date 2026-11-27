/**
 * The trusted copy of the demo app's semantic registry data (Feature 004, T403): the 3 routes, the 8 registered elements (with their REAL operations and privacy)
 * and the 4 postcondition names that an authored walkthrough may reference. Frozen, plain data.
 *
 * Retained for stored walkthroughs that use the reference registry. The password field and admin pages are excluded.
 *
 * The data is what a guide may TARGET: it is not authority. Nothing here is read from a request.
 */
import type { SemanticElementDef } from "@dap/walkthrough/authoring";

export interface TrustedRegistryData {
  readonly routes: readonly string[];
  readonly elements: readonly SemanticElementDef[];
  readonly postconditionNames: readonly string[];
}

const element = (def: SemanticElementDef): SemanticElementDef => Object.freeze({ ...def, operations: Object.freeze([...def.operations]) });

export const TRUSTED_REGISTRY: TrustedRegistryData = Object.freeze({
  routes: Object.freeze(["dashboard", "profile", "settings"]),
  elements: Object.freeze([
    element({ id: "nav.settings", route: "dashboard", role: "link", label: "Settings link", description: "Opens the settings page", operations: ["highlight", "click"], privacy: "public" }),
    element({ id: "nav.profile", route: "dashboard", role: "link", label: "Profile link", description: "Opens the profile page", operations: ["highlight", "click"], privacy: "public" }),
    element({ id: "profile.nameInput", route: "profile", role: "textbox", label: "Name", description: "Your display name", operations: ["highlight", "input", "focus"], privacy: "public" }),
    element({ id: "profile.emailInput", route: "profile", role: "textbox", label: "Email", description: "Your email address", operations: ["highlight", "input"], privacy: "private" }),
    element({ id: "profile.saveButton", route: "profile", role: "button", label: "Save", description: "Saves your profile", operations: ["highlight", "click"], privacy: "public" }),
    element({ id: "settings.advancedToggle", route: "settings", role: "button", label: "Advanced", description: "Shows or hides the advanced settings", operations: ["highlight", "click"], privacy: "public" }),
    element({ id: "settings.securityPanel", route: "settings", role: "panel", label: "Security", description: "The security settings section", operations: ["highlight"], privacy: "public" }),
    element({ id: "settings.twoFactorSetup", route: "settings", role: "button", label: "Two-factor setup", description: "Starts two-factor authentication setup", operations: ["highlight", "click"], privacy: "public" }),
  ]),
  postconditionNames: Object.freeze(["profile.saved", "route.profile", "route.settings", "settings.advancedOpen"]),
});
