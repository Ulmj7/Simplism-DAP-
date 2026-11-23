import { afterEach, expect, it, vi } from "vitest";
import { mountApp } from "./main.js";
import type { MountedApp } from "./main.js";
// Browsers drop focus from a control that becomes `disabled` while focused, and never give it back. A keyboard user who presses
// Save (Enter in the field, or Space on the button) would be left on <body> after every save. Busy controls must stay focusable.
const apps: MountedApp[] = [];
afterEach(() => { apps.splice(0).forEach(a => a.destroy()); document.body.replaceChildren(); });
function mount(profileService: Parameters<typeof mountApp>[1]) {
 window.location.hash = "#/profile"; const root = document.createElement("div"); document.body.append(root);
 const app = mountApp(root, { trustedEventsOnly: false, ...profileService }); apps.push(app); return { app, root };
}
it("while saving, Save and the name field are busy but never disabled, so focus stays where the user is", async () => {
 let finish!: (v: { ok: boolean }) => void; const save = vi.fn(() => new Promise<{ ok: boolean }>(resolve => { finish = resolve; }));
 const { root } = mount({ profileService: { save } });
 const name = root.querySelector<HTMLInputElement>("#name")!; const button = root.querySelector<HTMLButtonElement>('[data-ai-id="profile.saveButton"]')!;
 name.focus(); name.value = "Ada"; name.dispatchEvent(new Event("input", { bubbles: true })); button.focus(); button.click();
 expect(root.querySelector('[role="status"]')?.textContent).toMatch(/Saving/);
 expect(button.disabled).toBe(false); expect(name.disabled).toBe(false);
 expect(button.getAttribute("aria-disabled")).toBe("true"); expect(button.getAttribute("aria-busy")).toBe("true"); expect(name.readOnly).toBe(true);
 expect(document.activeElement).toBe(button);
 button.click(); button.click(); expect(save).toHaveBeenCalledTimes(1); // a busy Save still cannot start a second save
 finish({ ok: true }); await Promise.resolve(); await Promise.resolve();
 expect(button.getAttribute("aria-disabled")).toBe("false"); expect(button.getAttribute("aria-busy")).toBe("false"); expect(name.readOnly).toBe(false);
 expect(document.activeElement).toBe(button);
});
it("the polite status line is rewritten only when its text changes, not on every keystroke", () => {
 const { root } = mount({});
 const name = root.querySelector<HTMLInputElement>("#name")!; const status = root.querySelector('[role="status"]')!;
 const type = (value: string) => { name.value = value; name.dispatchEvent(new Event("input", { bubbles: true })); };
 type("A"); expect(status.textContent).toMatch(/unsaved/i);
 const observer = new MutationObserver(() => {}); observer.observe(status, { subtree: true, childList: true, characterData: true });
 type("Ad"); type("Ada");
 expect(observer.takeRecords()).toEqual([]); observer.disconnect();
});
