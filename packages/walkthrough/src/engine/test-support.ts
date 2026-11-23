/** Shared fixtures for the core's tests: a registry, sample walkthroughs that mirror the demo's shapes (TEST FIXTURES only, not product definitions), and fake ports. */
import { createSemanticRegistry } from "../semantic/registry.js";
import type { SemanticElementDef } from "../semantic/types.js";
import { createWalkthroughCatalog } from "../walkthrough/catalog.js";
import { defineWalkthrough } from "../walkthrough/definition.js";
import type { WalkthroughDef } from "../walkthrough/definition.js";
import { createWalkthroughRuntime } from "./runtime.js";
import type { RuntimeOptions } from "./runtime.js";
import type { PresentationEffect } from "./machine.js";

const el = (id: string, route: string, role: SemanticElementDef["role"], operations: SemanticElementDef["operations"], privacy: SemanticElementDef["privacy"] = "public"): SemanticElementDef =>
  ({ id, route, role, label: `Label of ${id}`, description: `Description of ${id}`, operations, privacy });

export const ELEMENTS: readonly SemanticElementDef[] = [
  el("nav.settings", "dashboard", "link", ["highlight", "click"]),
  el("profile.nameInput", "profile", "textbox", ["highlight", "input", "focus"]),
  el("profile.emailInput", "profile", "textbox", ["highlight", "input"], "private"),
  el("profile.phoneInput", "profile", "textbox", ["highlight", "input"], "redact"),
  el("profile.saveButton", "profile", "button", ["highlight", "click"]),
  el("profile.cancelButton", "profile", "button", ["highlight", "click"]),
  el("settings.advancedToggle", "settings", "button", ["highlight", "click"]),
  el("settings.securityPanel", "settings", "panel", ["highlight"]),
  el("settings.twoFactorSetup", "settings", "button", ["highlight", "click"]),
];
export const ROUTES = ["dashboard", "profile", "settings"] as const;
export const makeRegistry = () => createSemanticRegistry({ routes: ROUTES, elements: ELEMENTS });

/** A: navigate -> input -> click + verify, with a failed-save recovery that loops back to the click. */
export const walkthroughA = defineWalkthrough({
  id: "profileUpdate", title: "Update your profile", description: "Change your name and save", start: "a1",
  steps: [
    { id: "a1", kind: "navigate", route: "profile", next: "a2" },
    { id: "a2", kind: "guide", target: "profile.nameInput", text: "Type your name.", wait: "input", next: "a3" },
    { id: "a3", kind: "guide", target: "profile.saveButton", text: "Press Save.", wait: "click", verify: "profileSaved", next: "adone", recover: "a4" },
    { id: "a4", kind: "guide", target: "profile.nameInput", text: "Fix your name and try again.", wait: "input", next: "a3" },
    { id: "adone", kind: "complete", text: "Your profile is saved." },
  ],
});
/** B: click + route verify -> ack -> complete. */
export const walkthroughB = defineWalkthrough({
  id: "findSecurity", title: "Find security settings", description: "Open the settings and find the security section", start: "b1",
  steps: [
    { id: "b1", kind: "guide", target: "nav.settings", text: "Open the settings.", wait: "click", verify: "onSettings", next: "b2" },
    { id: "b2", kind: "guide", target: "settings.securityPanel", text: "This is the security section.", wait: "ack", next: "bdone" },
    { id: "bdone", kind: "complete", text: "You found it." },
  ],
});
/** C: the target is missing -> recover to open a prerequisite -> retry -> ack -> complete. */
export const walkthroughC = defineWalkthrough({
  id: "findTwoFactor", title: "Find two-factor settings", description: "Open the advanced area to find two-factor setup", start: "c1",
  steps: [
    { id: "c1", kind: "guide", target: "settings.twoFactorSetup", text: "Press two-factor setup.", wait: "click", next: "c3", recover: "c2", targetWaitMs: 500 },
    { id: "c2", kind: "guide", target: "settings.advancedToggle", text: "Open the advanced area first.", wait: "click", next: "c1" },
    { id: "c3", kind: "guide", target: "settings.securityPanel", text: "Review the security section.", wait: "ack", next: "cdone" },
    { id: "cdone", kind: "complete", text: "Done." },
  ],
});
/** Verification fixtures: one step with a recovery, one without, one that can loop forever. */
export const walkthroughV = defineWalkthrough({
  id: "verifyOnly", title: "Verify", description: "A step whose postcondition decides", start: "v1",
  steps: [
    { id: "v1", kind: "guide", target: "profile.saveButton", text: "Press Save.", wait: "click", verify: "check", next: "vdone" },
    { id: "vdone", kind: "complete", text: "Done." },
  ],
});
export const walkthroughR = defineWalkthrough({
  id: "verifyRecover", title: "Verify with recovery", description: "A failing postcondition goes to a recovery step", start: "r1",
  steps: [
    { id: "r1", kind: "guide", target: "profile.saveButton", text: "Press Save.", wait: "click", verify: "check", next: "rdone", recover: "r2" },
    { id: "r2", kind: "guide", target: "profile.nameInput", text: "Fix the name.", wait: "input", next: "r1" },
    { id: "rdone", kind: "complete", text: "Done." },
  ],
});
export const walkthroughL = defineWalkthrough({
  id: "loopForever", title: "Loop", description: "A recovery loop that only maxAttempts can end", start: "l1",
  steps: [
    { id: "l1", kind: "guide", target: "profile.saveButton", text: "Press Save.", wait: "click", verify: "check", next: "ldone", recover: "l2", maxAttempts: 2 },
    { id: "l2", kind: "guide", target: "profile.nameInput", text: "Try again.", wait: "ack", next: "l1" },
    { id: "ldone", kind: "complete", text: "Done." },
  ],
});
/** Navigation: the runtime navigates (N), and the user navigates (U). */
export const walkthroughN = defineWalkthrough({
  id: "goSettings", title: "Go to settings", description: "Navigate to the settings route", start: "n1",
  steps: [{ id: "n1", kind: "navigate", route: "settings", next: "ndone" }, { id: "ndone", kind: "complete", text: "Arrived." }],
});
export const walkthroughU = defineWalkthrough({
  id: "userGoesSettings", title: "Go to settings yourself", description: "The user navigates", start: "u1",
  steps: [{ id: "u1", kind: "navigate", route: "settings", text: "Open the settings page.", next: "udone" }, { id: "udone", kind: "complete", text: "Arrived." }],
});
export const ALL: readonly WalkthroughDef[] = [walkthroughA, walkthroughB, walkthroughC, walkthroughV, walkthroughR, walkthroughL, walkthroughN, walkthroughU];
export const POSTCONDITION_NAMES = ["profileSaved", "onSettings", "check"] as const;

export interface FakeTimer { readonly ms: number; readonly fire: () => void; cancelled: boolean; fired: boolean }
export function makeHarness(over: { readonly definitions?: readonly WalkthroughDef[]; readonly overrides?: Partial<RuntimeOptions> } = {}) {
  const registry = makeRegistry();
  const catalog = createWalkthroughCatalog(registry, [...POSTCONDITION_NAMES], over.definitions ?? ALL);
  const available = new Set<string>(ELEMENTS.map((e) => e.id));
  const effects: PresentationEffect[] = [];
  const timers: FakeTimer[] = [];
  const navigations: string[] = [];
  const answers: Record<string, () => unknown> = { profileSaved: () => true, onSettings: () => true, check: () => true };
  const world = { route: "dashboard" };
  const presenter = { throws: false };
  const ports = {
    targets: { resolve: (id: string) => (available.has(id) ? "available" as const : "unavailable" as const) },
    router: { current: () => world.route, navigate: (route: string) => { navigations.push(route); world.route = route; } },
    presenter: { apply: (effect: PresentationEffect) => { if (presenter.throws) throw new Error("render failed"); effects.push(effect); } },
    timers: { set: (fn: () => void, ms: number) => { const timer: FakeTimer = { ms, fire: () => { if (!timer.cancelled && !timer.fired) { timer.fired = true; fn(); } }, cancelled: false, fired: false }; timers.push(timer); return () => { timer.cancelled = true; }; } },
    postconditions: { profileSaved: () => answers.profileSaved!() as boolean, onSettings: () => answers.onSettings!() as boolean, check: () => answers.check!() as boolean },
  };
  const options: RuntimeOptions = { registry, catalog, ...ports, ...over.overrides };
  const runtime = createWalkthroughRuntime(options);
  const pending = () => timers.filter((t) => !t.cancelled && !t.fired);
  return { registry, catalog, runtime, available, effects, timers, navigations, answers, world, presenter, ports, options, pending };
}
export type Harness = ReturnType<typeof makeHarness>;
export const click = (id: string) => ({ type: "click", id });
export const input = (id: string, nonEmpty: boolean) => ({ type: "input", id, nonEmpty });
