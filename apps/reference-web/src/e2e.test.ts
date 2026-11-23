/**
 * T221 (Feature 002): the end-to-end proof, in a real DOM (jsdom), of the three shipped guides.
 *
 * What is REAL here: `mountApp` (router, store, semantic registry, DOM bridge, availability feed, the three shipped walkthrough definitions, the
 * runtime, the overlay, the result dialog, the profile controller and its default asynchronous in-memory save). Guides are started by clicking the
 * launcher button, and the user's part is played with real DOM events on real elements (click, form submit through the Save button, typing into the field).
 *
 * What is NOT done anywhere in this file: no `runtime.dispatch`, no `store.set`, no `profile.*` call, no custom walkthrough, no replaced profile service.
 * Progress is observed only through the runtime snapshot and the DOM the app produced.
 *
 * One honest concession: jsdom cannot make a trusted (`isTrusted`) click or input event, so the bridge's `trustedEventsOnly` guard is switched off for
 * every mount except the last test, which runs with the production default and proves a synthetic event does not advance a guide.
 * Time is driven with fake timers; macrotask delivery (U1) is therefore exercised, never bypassed: every step waits for `turn()`.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mountApp } from "./main.js";
import type { MountedApp } from "./main.js";
import { copy } from "./copy.js";

const apps: MountedApp[] = [];
afterEach(() => {
  apps.splice(0).forEach(app => app.destroy());
  document.body.replaceChildren();
  vi.useRealTimers();
});

/** Let queued macrotasks (bridge delivery, hashchange, microtasks) run. */
const turn = () => vi.advanceTimersByTimeAsync(5);

function mount(route: "dashboard" | "profile" | "settings", options: { trustedEventsOnly?: boolean } = {}) {
  vi.useFakeTimers();
  window.history.replaceState(null, "", `#/${route}`);
  const root = document.createElement("div");
  document.body.append(root);
  const app = mountApp(root, { trustedEventsOnly: false, ...options });
  apps.push(app);
  return { app, root };
}

const semantic = (root: ParentNode, id: string) => root.querySelector<HTMLElement>(`[data-ai-id="${id}"]`)!;
const overlay = (part: string) => document.querySelector<HTMLElement>(`[data-ai-overlay="${part}"]`);
const overlayParts = () => document.querySelectorAll("[data-ai-overlay]");
const dialog = () => document.querySelector<HTMLElement>('dialog[role="dialog"]');
const state = (app: MountedApp) => app.runtime.getState();

/** The user clicks the launcher card of a guide, by its accessible name. */
function launch(root: ParentNode, title: string) {
  const button = root.querySelector<HTMLButtonElement>(`.guide-list button[aria-label="${copy.guide.start}: ${title}"]`);
  if (button === null) throw new Error(`no launcher button for ${title}`);
  button.click();
}
/** The user types into a text field. */
function type(field: HTMLInputElement, value: string) {
  field.value = value;
  field.dispatchEvent(new Event("input", { bubbles: true }));
}
const clickSave = (root: ParentNode) => semantic(root, "profile.saveButton").click(); // a real submit-button click: jsdom runs the form's submit event

describe("T221 A: profileUpdate, from the launcher to the completion dialog", () => {
  it("highlights the name field, refuses an invalid name, then completes only after a real async save is verified", async () => {
    const { app, root } = mount("dashboard");
    expect(state(app).status).toBe("IDLE");

    launch(root, "Update your profile name");
    await turn();
    expect(window.location.hash).toBe("#/profile"); // the guide navigated for the user
    expect(document.title).toBe(copy.titles.profile);
    expect(state(app)).toMatchObject({ walkthroughId: "profileUpdate", stepId: "name", status: "WAITING" });
    expect(overlay("ring")).not.toBeNull(); // the highlight is on the screen...
    expect(overlay("title")?.textContent).toBe(copy.semantic["profile.nameInput"].label); // ...for the name field
    expect(overlay("hint")?.textContent).toBe(copy.guide.input);
    expect(overlay("progress")?.textContent).toBe(`${copy.guide.step} 1 ${copy.guide.of} 2`);

    const name = root.querySelector<HTMLInputElement>("#name")!;
    type(name, "a"); // one character: non-empty, so the guide moves on to Save
    await turn();
    expect(state(app).stepId).toBe("save");

    clickSave(root); // the real validation refuses a 1-character name
    await turn();
    expect(app.store.get().profile).toMatchObject({ status: "validation-error", error: "too_short" });
    expect(state(app).status).not.toBe("COMPLETED");
    expect(state(app)).toMatchObject({ stepId: "fixName", status: "WAITING" }); // recovery, not success
    expect(overlay("progress")?.textContent).toBe(copy.guide.extra);
    expect(dialog()).toBeNull();
    expect(root.querySelector("#name-error")?.textContent).toBe(copy.profile.too_short);

    type(name, "Ada Lovelace"); // fixes the name: back to Save
    await turn();
    expect(state(app).stepId).toBe("save");
    expect(app.store.get().profile.status).toBe("dirty");

    clickSave(root); // the real asynchronous save starts
    await turn();
    expect(app.store.get().profile.status).toBe("saving");
    expect(state(app).status).toBe("VERIFYING"); // not complete while the save is in flight
    expect(overlay("status")?.textContent).toBe(copy.guide.checking);
    expect(dialog()).toBeNull();

    await vi.advanceTimersByTimeAsync(250); // the in-memory save's own delay elapses
    await turn();
    expect(app.store.get().profile).toMatchObject({ status: "saved", savedName: "Ada Lovelace" });
    expect(state(app).status).toBe("COMPLETED");
    expect(overlayParts()).toHaveLength(0); // ring, scrim and tooltip are gone
    expect(dialog()?.textContent).toContain(copy.result.completed);
    expect(dialog()?.textContent).toContain("Your display name was saved");
  });

  it("a click on the wrong control does not advance the guide, a second start is refused while it runs, and an unknown guide is refused when idle", async () => {
    const { app, root } = mount("dashboard");
    expect(app.guides.startWalkthrough("adminTakeover")).toEqual({ ok: false, reason: "unknown_walkthrough" });
    expect(state(app).status).toBe("IDLE");
    launch(root, "Update your profile name");
    await turn();
    expect(state(app).stepId).toBe("name");

    clickSave(root); // a real click on a registered control, but not the one the step is waiting for (it waits for typing in the name field)
    await turn();
    expect(state(app)).toMatchObject({ walkthroughId: "profileUpdate", stepId: "name", status: "WAITING" });
    expect(app.store.get().profile.status).toBe("validation-error"); // the app itself still validated the empty name; the guide did not take it as progress

    expect(app.guides.startWalkthrough("profileUpdate")).toEqual({ ok: false, reason: "busy" }); // a run is already in progress
    expect(state(app)).toMatchObject({ walkthroughId: "profileUpdate", stepId: "name" }); // and the refused start changed nothing
  });
});

describe("T221 B: cancel", () => {
  it("cancelling after a real step removes the highlight, and a pending event cannot advance the cancelled run", async () => {
    const { app, root } = mount("dashboard");
    launch(root, "Update your profile name");
    await turn();
    type(root.querySelector<HTMLInputElement>("#name")!, "Ada");
    await turn();
    expect(state(app).stepId).toBe("save"); // at least one real step has been taken
    expect(overlay("ring")).not.toBeNull();

    // The user clicks the highlighted Save and, in the same task, Cancel: the Save delivery is still queued as a macrotask.
    clickSave(root);
    overlay("cancel")!.click();
    expect(state(app).status).toBe("CANCELLED"); // synchronous: Cancel is not a semantic event
    expect(overlayParts()).toHaveLength(0);
    expect(dialog()?.textContent).toContain(copy.result.cancelled);

    await vi.advanceTimersByTimeAsync(5000); // let the queued delivery, the save and every timer run
    expect(state(app)).toMatchObject({ walkthroughId: "profileUpdate", status: "CANCELLED" }); // never advanced, never completed
    expect(overlayParts()).toHaveLength(0); // nothing came back
    expect(dialog()?.textContent).toContain(copy.result.cancelled);
    expect(dialog()?.textContent).not.toContain(copy.result.completed);

    // The result is closable, and a new run starts clean (it does not inherit the old step).
    Array.from(dialog()!.querySelectorAll("button")).find(b => b.textContent === copy.result.close)!.click();
    expect(dialog()).toBeNull();
    const profileLink = root.querySelector<HTMLAnchorElement>('a[href="#/dashboard"]')!;
    profileLink.click();
    await turn();
    launch(root, "Update your profile name");
    await turn();
    expect(state(app)).toMatchObject({ walkthroughId: "profileUpdate", stepId: "name", status: "WAITING" });
  });

  it("Escape cancels an active guide and leaves nothing on the page", async () => {
    const { app, root } = mount("dashboard");
    launch(root, "Find the security settings");
    await turn();
    expect(state(app).status).toBe("WAITING");
    document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await vi.advanceTimersByTimeAsync(2000);
    expect(state(app).status).toBe("CANCELLED");
    expect(overlayParts()).toHaveLength(0);
  });
});

describe("T221 C: findTwoFactorSettings recovers from a collapsed Advanced section", () => {
  it("the target is unavailable, the guide asks for a real Advanced click, then the original target resolves and the guide finishes honestly", async () => {
    const { app, root } = mount("dashboard");
    launch(root, "Find the two-factor authentication settings");
    await turn();
    expect(window.location.hash).toBe("#/settings");
    expect(app.store.get().advancedOpen).toBe(false);
    expect(semantic(root, "settings.twoFactorSetup").closest("[hidden]")).not.toBeNull(); // really hidden: the target cannot be shown
    expect(state(app).status).toBe("RESOLVING"); // waiting for a target that is not there; nothing is highlighted yet
    expect(overlay("ring")).toBeNull();

    await vi.advanceTimersByTimeAsync(400); // the bounded wait for the target elapses: the guide recovers
    expect(state(app)).toMatchObject({ stepId: "openAdvanced", status: "WAITING" });
    expect(overlay("title")?.textContent).toBe(copy.semantic["settings.advancedToggle"].label);
    expect(overlay("progress")?.textContent).toBe(copy.guide.extra);
    expect(overlay("hint")?.textContent).toBe(copy.guide.click);

    semantic(root, "settings.advancedToggle").click(); // the user's real click opens the section
    await turn();
    expect(app.store.get().advancedOpen).toBe(true);
    expect(semantic(root, "settings.twoFactorSetup").closest("[hidden]")).toBeNull();
    expect(state(app)).toMatchObject({ stepId: "twoFactor", status: "WAITING" }); // the advancedOpen postcondition held, the original step resumed
    expect(overlay("title")?.textContent).toBe(copy.semantic["settings.twoFactorSetup"].label);
    expect(overlay("ring")).not.toBeNull();
    expect(overlay("tooltip")?.textContent).not.toMatch(/enabled|turned on|activated/i); // the guide never claims it changed anything

    overlay("ack")!.click();
    await turn();
    expect(state(app).status).toBe("COMPLETED");
    expect(overlayParts()).toHaveLength(0);
    expect(dialog()?.textContent).toContain(copy.result.completed);
    expect(dialog()?.textContent).toContain("changed no authentication settings");
  });

  it("an Advanced click that leaves the section closed (open then close) is not success: verification fails and the guide says so", async () => {
    const { app, root } = mount("dashboard");
    launch(root, "Find the two-factor authentication settings");
    await turn();
    await vi.advanceTimersByTimeAsync(400);
    expect(state(app).stepId).toBe("openAdvanced");

    const toggle = semantic(root, "settings.advancedToggle");
    toggle.click(); // open
    toggle.click(); // and close again, in the same task: the real store says closed when each click is delivered
    await turn();
    expect(app.store.get().advancedOpen).toBe(false);
    expect(state(app)).toMatchObject({ status: "FAILED", failure: "verification_failed" });
    expect(dialog()?.textContent).toContain(copy.result.blocked);
    expect(dialog()?.textContent).not.toContain(copy.result.completed);
    expect(overlayParts()).toHaveLength(0);
  });

  it("with Advanced already open the guide goes straight to the target, with no recovery step", async () => {
    const { app, root } = mount("settings");
    semantic(root, "settings.advancedToggle").click();
    await turn();
    app.guides.startWalkthrough("findTwoFactorSettings");
    await turn();
    expect(state(app)).toMatchObject({ stepId: "twoFactor", status: "WAITING" });
    expect(overlay("progress")?.textContent).not.toBe(copy.guide.extra);
  });
});

describe("T221 D: findSecuritySettings", () => {
  it("navigates to Settings, highlights the Security panel and finishes after acknowledgement", async () => {
    const { app, root } = mount("dashboard");
    launch(root, "Find the security settings");
    await turn();
    expect(window.location.hash).toBe("#/settings");
    expect(state(app)).toMatchObject({ stepId: "security", status: "WAITING" });
    expect(overlay("title")?.textContent).toBe(copy.semantic["settings.securityPanel"].label);
    expect(overlay("ring")).not.toBeNull();
    expect(overlay("ack")!.hidden).toBe(false);
    overlay("ack")!.click();
    await turn();
    expect(state(app).status).toBe("COMPLETED");
    expect(dialog()?.textContent).toContain(copy.result.completed);
    expect(overlayParts()).toHaveLength(0);
  });
});

describe("T221 privacy: private, redacted, unregistered and ignored fields never reach the guidance layer", () => {
  // Obviously fake values; the test never prints them.
  const SECRETS = { password: "Pw-Never-Shared-1", email: "private.person@example.invalid", phone: "+1-555-0100-REDACTED", billing: "Billing-Note-Secret-1", name: "Grace Hopper" } as const;

  it("typing into them does not advance the guide, and the context, state, overlay and dialog never contain their values", async () => {
    const { app, root } = mount("dashboard");
    launch(root, "Update your profile name");
    await turn();
    expect(state(app).stepId).toBe("name");

    const field = (selector: string) => root.querySelector<HTMLInputElement>(selector)!;
    type(field("#password"), SECRETS.password);
    type(field("#email"), SECRETS.email);
    type(field("#phone"), SECRETS.phone);
    type(field("#billing-note"), SECRETS.billing);
    await turn();
    expect(state(app)).toMatchObject({ stepId: "name", status: "WAITING" }); // none of them is a guide event

    type(field("#name"), SECRETS.name);
    await turn();
    expect(state(app).stepId).toBe("save");
    clickSave(root);
    await turn();
    await vi.advanceTimersByTimeAsync(250);
    await turn();
    expect(state(app).status).toBe("COMPLETED"); // the guide finished without any of the private fields

    const everythingTheGuidanceLayerCanSee = [
      JSON.stringify(app.runtime.context()),
      JSON.stringify(state(app)),
      JSON.stringify(app.guides.catalog.list()),
      document.querySelector('dialog[role="dialog"]')?.textContent ?? "",
      Array.from(overlayParts()).map(part => part.textContent).join(" "),
    ].join("\n");
    for (const [kind, value] of Object.entries(SECRETS)) expect(everythingTheGuidanceLayerCanSee.includes(value), `${kind} value leaked`).toBe(false);

    // The structure the guidance layer does see is exactly the registry: the unregistered password field and the ignored billing note are not in it.
    const ids = app.runtime.context().elements.map(element => element.id);
    expect(ids).not.toContain("profile.passwordInput");
    expect(JSON.stringify(app.runtime.context())).not.toMatch(/billing|phone/i);
  });
});

describe("T221 production default: a synthetic event does not advance a guide", () => {
  it("with trustedEventsOnly left at its default, scripted clicks and input are ignored", async () => {
    const { app, root } = mount("dashboard", { trustedEventsOnly: true });
    launch(root, "Update your profile name"); // the launcher is the app's own control, not a semantic event
    await turn();
    expect(state(app).stepId).toBe("name");

    type(root.querySelector<HTMLInputElement>("#name")!, "Ada Lovelace"); // dispatched from script: isTrusted is false, so it is dropped
    await turn();
    expect(state(app)).toMatchObject({ stepId: "name", status: "WAITING" });
    semantic(root, "profile.saveButton").click();
    await turn();
    expect(state(app).status).not.toBe("COMPLETED");
  });
});
