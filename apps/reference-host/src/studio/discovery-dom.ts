/// <reference lib="dom" />

import type { UiTarget } from "@dap/browser-runtime";

export type DiscoveryAction = {
  target: UiTarget;
  kind: "link" | "menu" | "tab";
  href: string | null;
};

type Reader = {
  scan(): Array<{ node: HTMLElement; target: UiTarget; disabled: boolean }>;
  resolve(target: UiTarget): { status: "found"; node: HTMLElement } | { status: "ambiguous" | "not-found" };
  snapshot(): { page: string | null; targets: UiTarget[]; truncated: boolean };
};

// This function runs in the browser together with the versioned widget reader.
export function discoveryDom(reader: Reader, origin: string, action: DiscoveryAction | null) {
  if (window !== top || location.origin !== origin) return null;
  const mutating = /(?:\b(?:logout|log[- ]?out|sign[- ]?out|delete|remove|destroy|pay|purchase|checkout|submit|export|download)\b|устга|төлөх|илгээх|гарах|татах)/iu;
  const pagePattern = /^\/[A-Za-z0-9._~/%-]*(?:#!?\/[A-Za-z0-9._~/%-]*)?$/u;
  const status = (performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming | undefined)?.responseStatus ?? 0;
  const form = document.querySelector('form input[type="password"]:not([autocomplete="new-password"])')?.closest("form");
  const signIn = Boolean(form && (
    /(?:^|\/)(?:login|signin|sign-in|log-in)(?:\/|$)/iu.test(location.pathname + location.hash.replace(/^#/u, "")) ||
    /(?:sign\s*in|log\s*in|нэвтрэх)/iu.test(form.textContent ?? "")
  ));
  const access = status === 401 || status === 403 || signIn ? "access-required"
    : status >= 400 ? "unreadable" : null;
  const view = reader.snapshot();
  if (access || !view.page) return action ? false : { access: access || "unreadable" };

  function classify(node: HTMLElement, target: UiTarget): DiscoveryAction | null {
    if (!target.name || mutating.test(target.name) || node.closest("form,[contenteditable=true]")) return null;
    if (node instanceof HTMLAnchorElement) {
      if (node.hasAttribute("download") || (node.target && node.target !== "_self")) return null;
      if (!URL.canParse(node.href, location.href)) return null;
      const url = new URL(node.href, location.href);
      const href = url.pathname + url.hash;
      if (url.origin !== origin || url.username || url.password || url.search || href.length > 200 ||
          !pagePattern.test(href) || href === view.page || mutating.test(href) ||
          /\.(?:pdf|zip|csv|xlsx?|docx?|png|jpe?g)(?:#|$)/iu.test(href)) return null;
      return { target, kind: "link", href };
    }
    if (node.matches("details:not([open]) > summary:first-of-type")) return { target, kind: "menu", href: null };
    const controls = node.getAttribute("aria-controls");
    const panel = controls ? document.getElementById(controls) : null;
    if (target.role === "tab" && node.matches('[role="tab"][aria-selected="false"]') &&
        node.closest('[role="tablist"]') && panel?.matches('[role="tabpanel"]')) {
      return { target, kind: "tab", href: null };
    }
    if (target.role === "button" && node.matches('[aria-expanded="false"]') &&
        (node.closest('nav,[role="navigation"]') || node.matches('[aria-haspopup="menu"],[aria-haspopup="true"]') ||
          panel?.matches('nav,[role="menu"],[role="navigation"]'))) {
      return { target, kind: "menu", href: null };
    }
    return null;
  }

  if (action) {
    const resolved = reader.resolve(action.target);
    if (resolved.status !== "found") return false;
    const current = classify(resolved.node, action.target);
    if (!current || current.kind !== action.kind || current.href !== action.href) return false;
    resolved.node.click();
    return true;
  }

  const targets = new Set(view.targets.map(target => JSON.stringify(target)));
  const facts = reader.scan().filter(({ target }) => targets.has(JSON.stringify(target))).slice(0, 64);
  const actions = facts.flatMap(({ node, target, disabled }) => {
    const candidate = disabled ? null : classify(node, target);
    return candidate ? [candidate] : [];
  });
  const expanded = facts.map(({ node }) => {
    if (node.matches("details > summary:first-of-type")) return node.parentElement?.hasAttribute("open") ? "open" : "closed";
    return [
      node.getAttribute("aria-expanded") === "true",
      node.getAttribute("aria-selected") === "true",
    ].map(Number).join("");
  });
  return { ...view, actions, expanded };
}
