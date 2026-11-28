/// <reference lib="dom" />

import type { DomNode, DomView, UiTarget } from "./types.js";

export const DOM_BATCH_SIZE = 500;

// Serialized by Playwright and run inside the approved browser document.
export function readDomTree(expectedUrl: string, reader?: {
  scan(): Array<{ node: HTMLElement; target: UiTarget }>;
}): { nodes: Array<DomNode & { target?: UiTarget }>; truncated: boolean; view: Omit<DomView, "revision"> } | null {
  if (location.href !== expectedUrl) return null;
  const maximumNodes = 25_000;
  const maximumText = 120;
  const privateSelector = "[data-ai-private],[data-ai-ignore],[data-ai-redact],input,textarea,select,[contenteditable]:not([contenteditable=false]),script,style,template,noscript,meta";
  const states = ["aria-expanded", "aria-selected", "aria-checked", "aria-disabled", "aria-hidden", "aria-invalid", "aria-pressed", "aria-required"];
  const nativeRoles: Record<string, string> = {
    article: "article", aside: "complementary", button: "button", summary: "button", dialog: "dialog", img: "img",
    main: "main", nav: "navigation", ol: "list", ul: "list", li: "listitem", option: "option",
    p: "paragraph", progress: "progressbar", table: "table", td: "cell", textarea: "textbox", tr: "row",
  };
  function roleOf(element: Element, tag: string) {
    const role = element.getAttribute("role")?.trim().split(/\s+/u)[0];
    if (role && /^[a-z][a-z\d-]{0,31}$/u.test(role)) return role;
    if (/^h[1-6]$/u.test(tag)) return "heading";
    if (tag === "a" || tag === "area") return element.hasAttribute("href") ? "link" : undefined;
    if (tag === "select") return element.matches("[multiple]") ? "listbox" : "combobox";
    if (tag === "input") {
      const type = (element as HTMLInputElement).type;
      if (["hidden", "password"].includes(type)) return undefined;
      if (["checkbox", "radio"].includes(type)) return type;
      if (["button", "submit", "reset", "image"].includes(type)) return "button";
      if (type === "range") return "slider";
      if (type === "number") return "spinbutton";
      return type === "search" ? "searchbox" : "textbox";
    }
    return Object.hasOwn(nativeRoles, tag) ? nativeRoles[tag] : undefined;
  }
  function safeText(raw: string | null): string | null {
    const text = raw?.normalize("NFKC").replace(/[\p{Cc}\p{Cf}\s]+/gu, " ").trim();
    if (!text || /(?:password|passcode|credential|secret|(?:access|refresh|api)[-_ ]?(?:key|token)|нууц\s*үг|bearer\s+|-----BEGIN)/iu.test(text) ||
        /(?:\b[A-Za-z0-9_+=/-]{24,}\b|\b[\w.+-]+@[\w.-]+\.[a-z]{2,}\b|\b\d[\d\s()-]{7,}\d\b)/iu.test(text)) return null;
    return text.slice(0, maximumText);
  }

  const entries = reader?.scan().filter(({ target }) => target.page && (target.name || target.marker)) ?? [];
  const targets = new Map(entries.map(entry => [entry.node, entry.target]));
  const identities = new Map<string, number>();
  const identity = (target: UiTarget) => JSON.stringify(target.marker ? [target.marker] : [target.role, target.name, target.section]);
  for (const { target } of entries) {
    const key = identity(target);
    identities.set(key, (identities.get(key) ?? 0) + 1);
  }
  const selectorCounts = new Map<string, number>();
  if (reader) for (const node of document.querySelectorAll("[data-ai-id],[data-testid]")) {
    for (const attribute of ["data-ai-id", "data-testid"]) {
      const key = node.getAttribute(attribute);
      if (!key) continue;
      const selector = `[${attribute}="${key}"]`;
      selectorCounts.set(selector, (selectorCounts.get(selector) ?? 0) + 1);
    }
  }
  function selectorFor(element: Element, attribute: string) {
    const value = element.getAttribute(attribute);
    if (!value || !/^[A-Za-z][A-Za-z0-9._-]{0,63}$/u.test(value) || !safeText(value)) return undefined;
    const selector = `[${attribute}="${value}"]`;
    return element.getRootNode() === document && selectorCounts.get(selector) === 1 ? selector : undefined;
  }

  const nodes: Array<DomNode & { target?: UiTarget }> = [];
  type Work = { node: Node; parentId: number | null; visible: boolean; siblings?: boolean };
  const iterator = document.documentElement ? [{ node: document.documentElement, parentId: null, visible: true }] : [];
  const stack: Work[] = iterator;
  while (stack.length && nodes.length < maximumNodes) {
    const { node, parentId, visible, siblings } = stack.pop()!;
    if (siblings && node.nextSibling) stack.push({ node: node.nextSibling, parentId, visible, siblings });
    const id = nodes.length + 1;
    if (node.nodeType === Node.TEXT_NODE) {
      const text = visible ? safeText(node.nodeValue) : null;
      if (text) nodes.push({ id, parentId, kind: "text", text });
      continue;
    }
    if (node.nodeType === Node.DOCUMENT_FRAGMENT_NODE) {
      nodes.push({ id, parentId, kind: "shadow-root" });
      if (node.firstChild) stack.push({ node: node.firstChild, parentId: id, visible, siblings: true });
      continue;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) continue;
    const element = node as Element;
    const tag = element.localName.slice(0, 64);
    const css = element.ownerDocument.defaultView?.getComputedStyle(element);
    const shown = visible && !element.matches("[hidden],[aria-hidden=true],[inert]") &&
      css?.display !== "none" && css?.visibility !== "hidden" && css?.visibility !== "collapse" && css?.opacity !== "0";
    const masked = element.matches(privateSelector) || tag === "iframe" && element.hasAttribute("srcdoc");
    const info: DomNode & { target?: UiTarget } = { id, parentId, kind: "element", tag, visible: shown };
    const role = roleOf(element, tag);
    if (role) info.role = role;
    nodes.push(info);
    const protectedElement = element.matches("[data-ai-private],[data-ai-ignore],[data-ai-redact],input[type=password],[contenteditable]:not([contenteditable=false]),script,style,template,noscript,meta") ||
      (tag === "iframe" && element.hasAttribute("srcdoc"));
    if (!protectedElement && reader) {
      const selector = selectorFor(element, "data-ai-id") ?? selectorFor(element, "data-testid");
      if (selector) info.selector = selector;
      const target = targets.get(element as HTMLElement);
      if (target) {
        info.target = target;
        const name = safeText(target.name);
        if (name) info.name = name;
        info.ambiguous = (identities.get(identity(target)) ?? 0) > 1;
      }
      if (shown && (target || info.selector) && element.getRootNode() === document) {
        const { x, y, width, height } = element.getBoundingClientRect();
        if (width > 0 && height > 0) info.bounds = { x, y, width, height };
      }
    }
    if (masked) {
      if (protectedElement) info.unavailable = "private";
      continue;
    }
    const aria: Record<string, string> = {};
    for (const name of states) {
      const value = element.getAttribute(name);
      if (value && /^(?:true|false|mixed|grammar|spelling)$/u.test(value)) aria[name] = value;
    }
    if (shown) {
      const label = safeText(element.getAttribute("aria-label"));
      if (label) aria["aria-label"] = label;
    }
    if (Object.keys(aria).length) info.aria = aria;

    if (tag === "iframe" || tag === "frame") {
      const frameDocument = (element as HTMLIFrameElement).contentDocument;
      if (!frameDocument?.documentElement || !/^https?:/u.test(frameDocument.URL) ||
          frameDocument.location?.origin !== document.location.origin) {
        info.unavailable = "frame";
      } else {
        stack.push({ node: frameDocument.documentElement, parentId: id, visible: shown });
      }
    }
    if (element.shadowRoot) stack.push({ node: element.shadowRoot, parentId: id, visible: shown });
    if (node.firstChild) stack.push({ node: node.firstChild, parentId: id, visible: shown, siblings: true });
  }
  return { nodes, truncated: stack.length > 0, view: { width: innerWidth, height: innerHeight, x: scrollX, y: scrollY } };
}
