import { h } from "../dom.js";
import { copy } from "../copy.js";
import { button, card, heading, statusMessage } from "../ui/pieces.js";
export function settingsPage(toggle: () => void) {
 const c = copy.settings; const advanced = button(c.advanced); advanced.setAttribute("data-ai-id", "settings.advancedToggle"); advanced.setAttribute("aria-controls", "advanced-settings"); advanced.addEventListener("click", toggle);
 const setup = button(c.twoFactor); setup.setAttribute("data-ai-id", "settings.twoFactorSetup"); const note = statusMessage(); setup.addEventListener("click", () => { note.textContent = c.demoNote; });
 const details = h("div", { id: "advanced-settings", hidden: true }, setup, note);
 const element = h("section", {}, heading(c.title, c.intro), h("section", { class: "panel", "data-ai-id": "settings.securityPanel" }, h("h2", {}, c.security), h("p", {}, c.securityText)), card(advanced, details));
 return { element, update(open: boolean) { advanced.setAttribute("aria-expanded", String(open)); details.hidden = !open; } };
}
