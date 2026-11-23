/** A tiny element builder. The app never assigns markup strings: text goes through `textContent` and attributes through `setAttribute`. */
export type Attrs = Readonly<Record<string, string | true>>;

export function h(tag: string, attrs: Attrs = {}, ...children: (Node | string)[]): HTMLElement {
  const element = document.createElement(tag);
  for (const [name, value] of Object.entries(attrs)) element.setAttribute(name, value === true ? "" : value);
  for (const child of children) element.append(typeof child === "string" ? document.createTextNode(child) : child);
  return element;
}
