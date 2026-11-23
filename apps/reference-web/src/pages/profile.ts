import { h } from "../dom.js";
import { copy } from "../copy.js";
import { button, card, field, heading, statusMessage } from "../ui/pieces.js";
import type { ProfileState } from "../profile-state.js";
export interface ProfileActions { readonly edit: (draft: string) => void; readonly save: () => void }
export function profilePage(actions: ProfileActions) {
 const c = copy.profile;
 const name = field("name", c.name, { type: "text", maxlength: "80", "data-ai-id": "profile.nameInput", "aria-describedby": "name-hint" });
 const hint = h("p", { id: "name-hint", class: "hint" }, c.hint); const error = h("p", { id: "name-error", class: "error", hidden: true }); name.element.append(hint, error);
 name.input.addEventListener("input", () => actions.edit(name.input.value));
 const save = button(c.save, true); save.type = "submit"; save.setAttribute("data-ai-id", "profile.saveButton");
 const status = statusMessage();
 const email = field("email", c.email, { type: "email", "data-ai-private": true, "data-ai-id": "profile.emailInput" });
 const phone = field("phone", c.phone, { type: "tel", "data-ai-redact": true });
 const password = field("password", c.password, { type: "password", "data-ai-private": true, "data-ai-id": "profile.passwordInput" });
 const form = h("form", { class: "profile-form", novalidate: true }, h("h2", {}, c.section), name.element, email.element, phone.element, password.element, save, status);
 form.addEventListener("submit", event => { event.preventDefault(); actions.save(); });
 const billing = field("billing-note", c.billingLabel, { type: "text" });
 const element = h("section", {}, heading(c.title, c.intro), card(form), h("section", { class: "panel", "data-ai-ignore": true }, h("h2", {}, c.billing), h("p", {}, c.billingText), billing.element));
 return { element, update(state: ProfileState) {
  if (name.input.value !== state.draft) name.input.value = state.draft;
  // Busy, never `disabled`: a browser drops focus from a control that is disabled while focused and does not give it back.
  const busy = state.status === "saving"; save.setAttribute("aria-disabled", String(busy)); name.input.readOnly = busy;
  save.setAttribute("aria-busy", String(state.status === "saving")); save.textContent = state.status === "saving" ? c.savingButton : c.save;
  error.hidden = state.error === null; error.textContent = state.error === null ? "" : c[state.error];
  name.input.setAttribute("aria-invalid", String(state.error !== null)); name.input.setAttribute("aria-describedby", state.error === null ? "name-hint" : "name-hint name-error");
  const messages = { ready: c.ready, dirty: c.dirty, "validation-error": c.validation, saving: c.saving, saved: c.saved, "save-failed": c.failed };
  // role="status" is a polite live region: write only a real change, or every keystroke may be announced again.
  if (status.textContent !== messages[state.status]) status.textContent = messages[state.status];
 } };
}
