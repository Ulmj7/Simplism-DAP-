import { h } from "../dom.js";
import { copy } from "../copy.js";
import { card, heading } from "../ui/pieces.js";
export function dashboardPage(launcher: HTMLElement): HTMLElement {
 const c = copy.dashboard;
 return h("section", {}, heading(c.title, c.intro), h("div", { class: "home-grid" },
  card(h("h2", {}, c.profile), h("p", {}, c.profileText), h("a", { href: "#/profile", class: "button primary" }, c.profileLink)),
  card(h("h2", {}, c.settings), h("p", {}, c.settingsText), h("a", { href: "#/settings", class: "button" }, c.settingsLink))),
  launcher);
}
