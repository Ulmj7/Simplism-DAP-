import { h } from "../dom.js";
export const heading = (title: string, intro: string) => h("div", {}, h("h1", {}, title), h("p", { class: "page-intro" }, intro));
export const card = (...children: (Node | string)[]) => h("section", { class: "card" }, ...children);
export const button = (text: string, primary = false) => h("button", { type: "button", class: primary ? "button primary" : "button" }, text) as HTMLButtonElement;
export function field(id: string, label: string, attrs: Record<string, string | true> = {}) {
 const input = h("input", { id, ...attrs }) as HTMLInputElement;
 return { input, element: h("div", { class: "field" }, h("label", { for: id }, label), input) };
}
export const statusMessage = () => h("p", { role: "status", "aria-live": "polite", class: "status" });
