import { h } from "../dom.js";

export interface Crumb { readonly label: string; readonly href?: string }

/** "Applications › Orders › Targets": a labelled list, every ancestor a link, the current page marked with aria-current. */
export function breadcrumb(crumbs: readonly Crumb[]): HTMLElement {
  const items = crumbs.map((crumb, index) => {
    const last = index === crumbs.length - 1;
    return h("li", {}, crumb.href !== undefined && !last ? h("a", { href: crumb.href }, crumb.label) : h("span", last ? { "aria-current": "page" } : {}, crumb.label));
  });
  return h("nav", { class: "breadcrumb", "aria-label": "Breadcrumb" }, h("ol", {}, ...items));
}
