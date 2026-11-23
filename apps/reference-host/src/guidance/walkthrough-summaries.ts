/**
 * The ONE trusted source of the three walkthrough summaries of the demo host (Feature 003). They mirror the real Feature 002 catalog (apps/reference-web, T217-T219).
 * The host may not import the walkthrough runtime or the web app, so the list stays here as static data, and the REQUIRED parity test
 * tests/integration/walkthrough-summary-parity.test.ts (T240) fails when its ids, titles or descriptions drift from `catalog.list()`.
 *
 * A summary is `{ id, title, description }` and nothing else: no steps, no selectors, no executable definition. The guidance service shows these to the
 * model, the lexical guard checks a proposal against them, and the `startWalkthrough` executor re-validates every id against the same list. Nothing else in
 * the host lists walkthroughs: the capability, the executor and every host test import THIS module.
 *
 * The wording is deliberate: the two settings guides share the word "settings", so "Help me with settings" is genuinely ambiguous between them, and none of
 * the three contains an administrator guide (there is none to start). Titles and descriptions are plain text (no markup characters).
 */
import type { SafeWalkthroughSummary, WalkthroughCatalogView } from "@dap/ai";

export const DEMO_WALKTHROUGH_SUMMARIES: readonly SafeWalkthroughSummary[] = Object.freeze([
  Object.freeze({ id: "profileUpdate", title: "Update your profile name", description: "Change the display name on your profile and save it." }),
  Object.freeze({ id: "findSecuritySettings", title: "Find the security settings", description: "Open the settings page and locate the security panel." }),
  Object.freeze({ id: "findTwoFactorSettings", title: "Find the two-factor authentication settings", description: "Open the settings page and locate the two-factor authentication option." }),
]);

/** The catalog view over a fixed, frozen list of summaries (the demo list by default). `list()` returns the list itself: it is frozen, so no caller can change it. */
export function createCatalogView(summaries: readonly SafeWalkthroughSummary[] = DEMO_WALKTHROUGH_SUMMARIES): WalkthroughCatalogView {
  const frozen = Object.freeze([...summaries]);
  return Object.freeze({ list: (): readonly SafeWalkthroughSummary[] => frozen });
}

/** The demo host's catalog view. */
export const demoCatalogView: WalkthroughCatalogView = createCatalogView();
