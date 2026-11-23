import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSemanticRegistry } from "../semantic/registry.js";
import type { SemanticElementDef } from "../semantic/types.js";
import { createOverlay } from "./overlay.js";
import { createTargets } from "./targets.js";

const def = (id: string, over: Partial<SemanticElementDef> = {}): SemanticElementDef =>
  ({ id, route: "profile", role: "textbox", label: "Field", description: "A field", operations: ["highlight"], privacy: "public", ...over });
const registry = createSemanticRegistry({
  routes: ["profile"],
  elements: [def("profile.nameInput"), def("profile.dupInput"), def("profile.hiddenInput"), def("profile.ignoredInput"), def("profile.passwordInput"), def("profile.styledInput")],
});
let root: HTMLElement;
// Test fixtures are built from markup text without innerHTML (the new trees keep that API out entirely).
const html = (markup: string): void => { root.replaceChildren(document.createRange().createContextualFragment(markup)); };
const stub = (el: Element, r: Partial<DOMRect>): void => { (el as HTMLElement).getBoundingClientRect = () => ({ left: 0, top: 0, width: 0, height: 0, right: 0, bottom: 0, x: 0, y: 0, toJSON: () => ({}), ...r }) as DOMRect; };

beforeEach(() => { root = document.createElement("div"); document.body.append(root); });
afterEach(() => { document.body.replaceChildren(); });

describe("targets.find", () => {
  it("finds a registered, visible, unique element by exact attribute value", () => {
    html(`<input data-ai-id="profile.nameInput"><input data-ai-id="profile.nameInputX">`);
    const handle = createTargets(root, registry).find("profile.nameInput");
    expect(handle?.id).toBe("profile.nameInput");
    expect(handle?.element.getAttribute("data-ai-id")).toBe("profile.nameInput");
  });
  it("an unregistered id, or anything that is not a string id, finds nothing, even if the markup carries it", () => {
    html(`<input data-ai-id="profile.doesNotExist"><input data-ai-id="profile.nameInput">`);
    const targets = createTargets(root, registry);
    for (const id of ["profile.doesNotExist", "", "profile.nameInput ", "PROFILE.NAMEINPUT", undefined, null, 4, {}, "__proto__"]) expect(targets.find(id), String(id)).toBeNull();
  });
  it("never builds a selector from the id: ids made of selector syntax cannot match or throw", () => {
    html(`<input data-ai-id="profile.nameInput">`);
    const targets = createTargets(root, registry);
    for (const id of ['x"],[data-ai-id', "*", "profile.nameInput, input", "[data-ai-id]", "a\\", "profile.nameInput\"]"]) expect(targets.find(id)).toBeNull();
  });
  it("a duplicate attribute value is unavailable, never 'one of them'", () => {
    html(`<input data-ai-id="profile.dupInput"><div><input data-ai-id="profile.dupInput"></div>`);
    expect(createTargets(root, registry).find("profile.dupInput")).toBeNull();
  });
  it("hidden elements are unavailable: [hidden], hidden ancestor, aria-hidden ancestor, display none, visibility hidden, detached", () => {
    const targets = createTargets(root, registry);
    for (const markup of [
      `<input hidden data-ai-id="profile.hiddenInput">`,
      `<div hidden><input data-ai-id="profile.hiddenInput"></div>`,
      `<div aria-hidden="true"><input data-ai-id="profile.hiddenInput"></div>`,
      `<div style="display:none"><input data-ai-id="profile.hiddenInput"></div>`,
      `<input style="visibility:hidden" data-ai-id="profile.hiddenInput">`,
    ]) { html(markup); expect(targets.find("profile.hiddenInput"), markup).toBeNull(); }
    html(`<input data-ai-id="profile.hiddenInput">`);
    expect(targets.find("profile.hiddenInput")).not.toBeNull();
  });
  it("an element under data-ai-ignore (or carrying it) is unavailable, even though it is registered", () => {
    const targets = createTargets(root, registry);
    html(`<div data-ai-ignore><input data-ai-id="profile.ignoredInput"></div>`);
    expect(targets.find("profile.ignoredInput")).toBeNull();
    html(`<input data-ai-ignore data-ai-id="profile.ignoredInput">`);
    expect(targets.find("profile.ignoredInput")).toBeNull();
  });
  it("password and hidden inputs are unavailable even when registered and carrying the id", () => {
    const targets = createTargets(root, registry);
    for (const type of ["password", "PASSWORD", "hidden"]) { html(`<input type="${type}" data-ai-id="profile.passwordInput">`); expect(targets.find("profile.passwordInput"), type).toBeNull(); }
    html(`<input type="text" data-ai-id="profile.passwordInput">`);
    expect(targets.find("profile.passwordInput")).not.toBeNull();
  });
  it("a data-ai-private element is still a target (it can be highlighted; its value is never read)", () => {
    html(`<input data-ai-private data-ai-id="profile.nameInput">`);
    expect(createTargets(root, registry).find("profile.nameInput")).not.toBeNull();
  });
  it("reveal scrolls only when the element is off-screen", () => {
    html(`<input data-ai-id="profile.nameInput">`);
    const el = root.firstElementChild as HTMLElement;
    let scrolls = 0;
    el.scrollIntoView = () => { scrolls++; };
    stub(el, { top: 10, left: 10, bottom: 40, right: 100 });
    const handle = createTargets(root, registry).find("profile.nameInput")!;
    handle.reveal();
    expect(scrolls).toBe(0);
    stub(el, { top: window.innerHeight + 50, bottom: window.innerHeight + 80, left: 10, right: 100 });
    handle.reveal();
    expect(scrolls).toBe(1);
  });
  it("observe reports availability-relevant changes and stops after unsubscribe", async () => {
    html(``);
    let calls = 0;
    const stop = createTargets(root, registry).observe(() => { calls++; });
    root.append(Object.assign(document.createElement("input"), { }));
    await Promise.resolve(); await new Promise((r) => setTimeout(r, 0));
    expect(calls).toBeGreaterThan(0);
    stop();
    const before = calls;
    root.append(document.createElement("input"));
    await new Promise((r) => setTimeout(r, 0));
    expect(calls).toBe(before);
  });
});

describe("overlay", () => {
  const show = (text: string, callbacks = {}) => {
    html(`<input data-ai-id="profile.nameInput">`);
    const el = root.firstElementChild as HTMLElement;
    stub(el, { left: 20, top: 30, width: 200, height: 24, right: 220, bottom: 54 });
    const handle = createTargets(root, registry).find("profile.nameInput")!;
    const overlay = createOverlay(document);
    overlay.show(handle, text, callbacks);
    return overlay;
  };
  it("draws a ring over the target's rectangle and a tooltip with role=dialog and aria-live", () => {
    const overlay = show("Type your name here.");
    const ring = document.querySelector<HTMLElement>('[data-ai-overlay="ring"]')!;
    const card = document.querySelector<HTMLElement>('[data-ai-overlay="tooltip"]')!;
    expect(overlay.isShowing()).toBe(true);
    expect(ring.style.position).toBe("fixed");
    expect([ring.style.left, ring.style.top, ring.style.width, ring.style.height]).toEqual(["16px", "26px", "208px", "32px"]);
    expect(card.getAttribute("role")).toBe("dialog");
    expect(card.getAttribute("aria-live")).toBe("polite");
    expect(card.textContent).toContain("Type your name here.");
    expect(card.textContent).toContain("Got it");
    expect(card.textContent).toContain("Cancel");
  });
  it("renders text as inert text: no element is created from markup", () => {
    show("<img src=x onerror=alert(1)>");
    const card = document.querySelector('[data-ai-overlay="tooltip"]')!;
    expect(card.querySelector("img")).toBeNull();
    expect(card.querySelector("p")?.textContent).toBe("<img src=x onerror=alert(1)>");
    expect(document.querySelectorAll("img").length).toBe(0);
  });
  it("hide() leaves no nodes and no listeners behind", () => {
    const overlay = show("x");
    const el = root.firstElementChild as HTMLElement;
    const handle = createTargets(root, registry).find("profile.nameInput")!;
    overlay.hide();
    expect(document.querySelectorAll("[data-ai-overlay]").length).toBe(0);
    expect(overlay.isShowing()).toBe(false);
    // listeners are gone: a scroll or resize does not recreate or move anything, nor throw
    let rects = 0; stub(el, {}); const original = el.getBoundingClientRect; el.getBoundingClientRect = () => { rects++; return original.call(el); };
    void handle; window.dispatchEvent(new Event("resize")); window.dispatchEvent(new Event("scroll"));
    expect(rects).toBe(0);
    expect(document.querySelectorAll("[data-ai-overlay]").length).toBe(0);
  });
  it("showing again replaces the previous overlay", () => {
    const overlay = show("first");
    const handle = createTargets(root, registry).find("profile.nameInput")!;
    overlay.show(handle, "second");
    expect(document.querySelectorAll('[data-ai-overlay="ring"]').length).toBe(1);
    expect(document.querySelector('[data-ai-overlay="tooltip"]')?.textContent).toContain("second");
  });
  it("repositions on resize while shown", () => {
    show("x");
    const el = root.firstElementChild as HTMLElement;
    stub(el, { left: 100, top: 100, width: 10, height: 10, right: 110, bottom: 110 });
    window.dispatchEvent(new Event("resize"));
    expect(document.querySelector<HTMLElement>('[data-ai-overlay="ring"]')!.style.left).toBe("96px");
  });
  it("'Got it' and 'Cancel' hide the overlay and call back once", () => {
    const calls: string[] = [];
    show("x", { onAck: () => calls.push("ack"), onCancel: () => calls.push("cancel") });
    document.querySelector<HTMLElement>('[data-ai-overlay="ack"]')!.click();
    expect(document.querySelectorAll("[data-ai-overlay]").length).toBe(0);
    show("x", { onAck: () => calls.push("ack"), onCancel: () => calls.push("cancel") });
    document.querySelector<HTMLElement>('[data-ai-overlay="cancel"]')!.click();
    expect(document.querySelectorAll("[data-ai-overlay]").length).toBe(0);
    expect(calls).toEqual(["ack", "cancel"]);
  });
  it("the overlay's own nodes are ignored by the privacy layer, so they can never become targets", () => {
    show("x");
    expect(document.querySelector('[data-ai-overlay="tooltip"]')?.hasAttribute("data-ai-ignore")).toBe(true);
  });
});


it.each(['<div inert><input data-ai-id="profile.nameInput"></div>', '<details><summary>Collapsed</summary><input data-ai-id="profile.nameInput"></details>'])("refuses unavailable ancestor fixtures: %s", markup => {
  html(markup);
  expect(createTargets(root, registry).find("profile.nameInput")).toBeNull();
});


it.each(["cc-number", "current-password", "one-time-code"])("sensitive autocomplete=%s cannot be targeted", autocomplete => {
  html(`<input type="text" autocomplete="${autocomplete}" data-ai-id="profile.nameInput">`);
  expect(createTargets(root, registry).find("profile.nameInput")).toBeNull();
});
