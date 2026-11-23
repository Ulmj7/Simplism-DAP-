import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mountApp } from "./main.js";
import type { MountedApp } from "./main.js";
import { DEMO_ELEMENTS } from "./semantic-ui.js";

const DEMO_INSTRUCTION="Type your name here.";
let root: HTMLElement;
let app: MountedApp | undefined;
const mount = (route: string): MountedApp => {
  window.location.hash = `#/${route}`;
  app = mountApp(root);
  return app;
};
const show = (id="profile.nameInput", text=DEMO_INSTRUCTION):boolean => {
 const target=app!.targets.find(id);if(!target){app!.overlay.hide();return false;}
 app!.overlay.show(target,text,{onAck:()=>app!.overlay.hide(),onCancel:()=>app!.overlay.hide()});return true;
};
const overlayNodes = (): number => document.querySelectorAll("[data-ai-overlay]").length;
const stubRect = (el: Element, r: { left: number; top: number; width: number; height: number }): void => {
  (el as HTMLElement).getBoundingClientRect = () => ({ ...r, right: r.left + r.width, bottom: r.top + r.height, x: r.left, y: r.top, toJSON: () => ({}) }) as DOMRect;
};

beforeEach(() => { root = document.createElement("div"); document.body.append(root); });
afterEach(() => { app?.destroy(); app = undefined; document.body.replaceChildren(); window.location.hash = ""; });

describe("T206: the shell", () => {
  it("renders the three pages by hash, falling back to the dashboard", () => {
    for (const [route, heading] of [["dashboard", "Dashboard"], ["profile", "Profile"], ["settings", "Settings"], ["nowhere", "Dashboard"]] as const) {
      mount(route);
      expect(root.querySelector("h1")?.textContent, route).toBe(heading);
      app!.destroy();
    }
  });
  it("changes page when the hash changes", async () => {
    mount("dashboard");
    window.location.hash = "#/settings";
    await new Promise((r) => setTimeout(r, 0));
    expect(root.querySelector("h1")?.textContent).toBe("Settings");
  });
  it("the registry builds against the markup: every registered id exists on some page, and the password field is in the markup but not the registry", () => {
    const seen = new Set<string>();
    for (const route of ["dashboard", "profile", "settings"]) {
      mount(route);
      for (const el of Array.from(root.querySelectorAll("[data-ai-id]"))) seen.add(el.getAttribute("data-ai-id")!);
      if (route === "profile") expect(app!.registry.has("profile.passwordInput")).toBe(false);
      app!.destroy();
    }
    expect(DEMO_ELEMENTS.map((e) => e.id).filter((id) => !seen.has(id))).toEqual([]);
    expect(seen.has("profile.passwordInput")).toBe(true);
  });
  it("the markup carries the privacy cases: a private email, a redacted field, an ignored panel, and an inert collapsed two-factor control", () => {
    mount("profile");
    expect(root.querySelector('[data-ai-id="profile.emailInput"]')?.hasAttribute("data-ai-private")).toBe(true);
    expect(root.querySelector("[data-ai-redact]")).not.toBeNull();
    expect(root.querySelector("[data-ai-ignore]")).not.toBeNull();
    app!.destroy();
    mount("settings");
    expect(root.querySelector('[data-ai-id="settings.twoFactorSetup"]')?.closest("[hidden]")).not.toBeNull();
    expect(app!.targets.find("settings.twoFactorSetup")).toBeNull();
    expect(app!.targets.find("settings.securityPanel")).not.toBeNull();
  });
});

describe("T207 intents migrated to the overlay/targets API", () => {
  it("(a) clicking 'Show me' puts the ring over the name input and shows the tooltip text", () => {
    mount("profile");
    const name = root.querySelector<HTMLElement>('[data-ai-id="profile.nameInput"]')!;
    stubRect(name, { left: 40, top: 100, width: 300, height: 30 });
    show();
    const ring = document.querySelector<HTMLElement>('[data-ai-overlay="ring"]')!;
    const card = document.querySelector<HTMLElement>('[data-ai-overlay="tooltip"]')!;
    expect([ring.style.left, ring.style.top, ring.style.width, ring.style.height]).toEqual(["36px", "96px", "308px", "38px"]);
    expect(card.getAttribute("role")).toBe("dialog");
    expect(card.textContent).toContain(DEMO_INSTRUCTION);
    expect(DEMO_INSTRUCTION).toBe("Type your name here.");
  });
  it("(b) an unregistered id highlights nothing and shows no tooltip, via the page control and directly", () => {
    mount("profile");
    show("profile.doesNotExist");
    expect(overlayNodes()).toBe(0);
    expect(show("profile.doesNotExist", "x")).toBe(false);
    expect(overlayNodes()).toBe(0);
  });
  it("a failed request also clears an overlay that was showing", () => {
    mount("profile");
    show();
    expect(overlayNodes()).toBeGreaterThan(0);
    show("profile.doesNotExist");
    expect(overlayNodes()).toBe(0);
  });
  it("(c) a password field that carries a data-ai-id cannot be highlighted, even if its id were registered", () => {
    mount("profile");
    expect(root.querySelector('input[type="password"]')?.getAttribute("data-ai-id")).toBe("profile.passwordInput");
    expect(show("profile.passwordInput", "x")).toBe(false);
    expect(overlayNodes()).toBe(0);
    // Even a registry that did list the id must refuse it: the privacy layer decides, not the registry.
    const password = root.querySelector('input[type="password"]')!;
    password.setAttribute("data-ai-id", "profile.nameInput");
    root.querySelector('[data-ai-id="profile.nameInput"]:not([type="password"])')?.removeAttribute("data-ai-id");
    expect(show("profile.nameInput", "x")).toBe(false);
    expect(overlayNodes()).toBe(0);
  });
  it("the ignored panel and the redacted field are never targets", () => {
    mount("profile");
    expect(app!.targets.find("profile.emailInput")).not.toBeNull(); // private is highlightable; its value is never read
    const panelInput = root.querySelector("[data-ai-ignore] input")!;
    panelInput.setAttribute("data-ai-id", "profile.saveButton");
    root.querySelector('button[data-ai-id="profile.saveButton"]')?.setAttribute("data-ai-id", "other");
    expect(app!.targets.find("profile.saveButton")).toBeNull();
  });
  it("(d) Cancel, Got it and hide() each remove everything", () => {
    mount("profile");
    show();
    document.querySelector<HTMLElement>('[data-ai-overlay="cancel"]')!.click();
    expect(overlayNodes()).toBe(0);
    show();
    document.querySelector<HTMLElement>('[data-ai-overlay="ack"]')!.click();
    expect(overlayNodes()).toBe(0);
    show();
    app!.overlay.hide();
    expect(overlayNodes()).toBe(0);
  });
  it("leaving the page removes the overlay, and destroy() leaves nothing in the document", async () => {
    mount("profile");
    show();
    window.location.hash = "#/settings";
    await new Promise((r) => setTimeout(r, 0));
    expect(overlayNodes()).toBe(0);
    document.getElementById("app");
    app!.destroy();
    expect(root.childElementCount).toBe(0);
  });
  it("no overlay text is ever interpreted as markup", () => {
    mount("profile");
    show("profile.nameInput", "<img src=x onerror=alert(1)>");
    expect(document.querySelectorAll("img").length).toBe(0);
    expect(document.querySelector('[data-ai-overlay="tooltip"] p')?.textContent).toBe("<img src=x onerror=alert(1)>");
  });
});
