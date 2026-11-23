import { h } from "../dom.js";
import { normalizedOrigin } from "../admin/wire.js";
import { mountManagedRuntime } from "./managed-runtime.js";
import { parseBundle } from "./protocol.js";
import type { ManagedBundle } from "./protocol.js";
import { getRuntimeJson, GUIDE_ID, parseGuideList, RUNTIME_KEY, SDK_INSTANCE } from "./runtime-delivery.js";
import type { GuideSummary } from "./runtime-delivery.js";
export { parseGuideList, RUNTIME_KEY } from "./runtime-delivery.js";

/**
 * STANDALONE delivery (Studio completion S8): `<script src="https://dap.example/dap-embed.js" data-dap-key="rk-…">`. The runtime API origin is the script's own origin; the embed lists the live guides
 * of the application (`GET /api/runtime/:key/guides`), offers a small accessible launcher and runs a chosen guide (`GET /api/runtime/:key/guides/:id`) in the page. Requests carry no credentials
 * and no cookies (`credentials: "omit"`, `mode: "cors"`); the host authorizes the key and the page's Origin. Inert (no DOM, no globals) when anything about the configuration or the first reply is wrong.
 */
export type StartResult = { readonly ok: true } | { readonly ok: false; readonly reason: "unavailable" | "unknown_guide" | "busy" | "invalid_guide" | "wrong_page" };
export interface DapEmbedApi { readonly version: 1; list(): Promise<readonly GuideSummary[]>; start(id: string): Promise<StartResult> }

export interface StandaloneOptions {
  readonly window: Window;
  readonly key: string;
  /** The script's own URL: its origin is the API origin. */
  readonly scriptSrc: string;
  /** The DAP API origin when it is not the script's own (`data-dap-api`, already validated by the installer; checked again here). */
  readonly apiOrigin?: string;
  readonly fetch?: typeof fetch;
  readonly trustedEventsOnly?: boolean;
  /** Resolves when the stylesheet has loaded (or failed): the launcher is not shown before. */
  readonly stylesheet?: Promise<unknown>;
  /** Removes the stylesheet link again: called when the embed goes away (pagehide, or a first reply that makes it inert). */
  readonly removeStylesheet?: () => void;
}

const copyText = {
  launcher: "Guides", panel: "Guides", intro: "Choose a guide. It runs on this page.", start: "Start", close: "Close", starting: "Starting the guide…",
  unavailable: "The guide could not be loaded.", wrongPage: "This guide is not available on this page.", busy: "A guide is already running.", empty: "No guides are available.",
};
const startLabel = (title: string) => `Start guide: ${title}`;

export function installStandalone({ window: win, key, scriptSrc, fetch: fetcher = win.fetch.bind(win), trustedEventsOnly = true, stylesheet, removeStylesheet, apiOrigin: given }: StandaloneOptions): { readonly ok: boolean; destroy(): void } {
  const inert = { ok: false, destroy() {} } as const;
  let base: URL;
  try { base = new URL(scriptSrc); } catch { return inert; }
  const apiOrigin = given ?? base.origin;
  if (!RUNTIME_KEY.test(key) || !normalizedOrigin(apiOrigin) || (Object.hasOwn(win, "DapEmbed") || Object.hasOwn(win, SDK_INSTANCE))) return inert;
  const doc = win.document;
  const root = `${apiOrigin}/api/runtime/${encodeURIComponent(key)}/guides`;
  let alive = true;
  let running: ReturnType<typeof mountManagedRuntime> | undefined;
  let starting = false;
  let launcher: HTMLElement | undefined;
  let trigger: HTMLButtonElement | undefined;
  let panel: HTMLElement | undefined;
  let live: HTMLElement | undefined;
  const say = (text: string) => { if (live) live.textContent = text; };

  const lifetime = new AbortController();
  async function getJson(url: string): Promise<unknown> {
    const result = await getRuntimeJson(win, fetcher, url, lifetime.signal);
    return result.ok ? result.body : null;
  }
  const fetchList = async (): Promise<readonly GuideSummary[] | null> => parseGuideList(await getJson(root));

  async function start(id: string): Promise<StartResult> {
    if (!alive) return { ok: false, reason: "unavailable" };
    if (running || starting) { say(copyText.busy); return { ok: false, reason: "busy" }; }
    if (typeof id !== "string" || !GUIDE_ID.test(id)) return { ok: false, reason: "unknown_guide" };
    starting = true;
    say(copyText.starting);
    try {
      const reply = await getJson(`${root}/${id}`);
      if (!alive) return { ok: false, reason: "unavailable" };
      if (reply === null) { say(copyText.unavailable); return { ok: false, reason: "unavailable" }; }
      const parsed = parseBundle(reply);
      if (!parsed.ok || parsed.bundle.definition.id !== id) { say(copyText.unavailable); return { ok: false, reason: "invalid_guide" }; }
      const bundle: ManagedBundle = parsed.bundle;
      if (bundle.application.origin !== win.location.origin) { say(copyText.wrongPage); return { ok: false, reason: "wrong_page" }; }
      closePanel(false);
      if (launcher) launcher.hidden = true;
      const mounted = mountManagedRuntime({ window: win, bundle, trustedEventsOnly,
        // The result dialog ends the run for the user; the run is torn down when it is dismissed.
        onStatus: () => undefined,
        onDismiss: () => { stop(); trigger?.focus(); } });
      if (!mounted.ok) { if (launcher) launcher.hidden = false; say(copyText.unavailable); return { ok: false, reason: "invalid_guide" }; }
      running = mounted;
      say("");
      return { ok: true };
    } finally { starting = false; }
  }
  function stop() {
    const current = running;
    running = undefined;
    if (current?.ok) current.destroy();
    if (launcher && alive) launcher.hidden = false;
  }

  function openPanel() {
    if (!panel || !trigger) return;
    panel.hidden = false;
    trigger.setAttribute("aria-expanded", "true");
    (panel.querySelector<HTMLElement>("li button") ?? panel.querySelector<HTMLElement>("h2"))?.focus();
  }
  function closePanel(restoreFocus = true) {
    if (!panel || !trigger || panel.hidden) return;
    panel.hidden = true;
    trigger.setAttribute("aria-expanded", "false");
    if (restoreFocus) trigger.focus();
  }

  function build(list: readonly GuideSummary[]) {
    const heading = h("h2", { id: "dap-launcher-title", tabindex: "-1" }, copyText.panel);
    const items = list.map(guide => {
      const go = h("button", { type: "button", "aria-label": startLabel(guide.title) }, copyText.start) as HTMLButtonElement;
      go.addEventListener("click", () => { void start(guide.id); });
      return h("li", {}, h("strong", {}, guide.title), h("p", {}, guide.description), go);
    });
    const close = h("button", { type: "button", class: "dap-launcher-close" }, copyText.close) as HTMLButtonElement;
    close.addEventListener("click", () => closePanel());
    const dialog = h("section", { class: "dap-launcher-panel", role: "dialog", "aria-labelledby": "dap-launcher-title", "aria-modal": "false", hidden: true },
      heading, h("p", {}, copyText.intro), h("ul", { "aria-label": copyText.panel }, ...items), close);
    dialog.addEventListener("keydown", event => { if ((event as KeyboardEvent).key === "Escape") { event.preventDefault(); event.stopPropagation(); closePanel(); } });
    panel = dialog;
    trigger = h("button", { type: "button", class: "dap-launcher-button", "aria-haspopup": "dialog", "aria-expanded": "false", "aria-controls": "dap-launcher-panel" }, copyText.launcher) as HTMLButtonElement;
    dialog.id = "dap-launcher-panel";
    trigger.addEventListener("click", () => { if (panel?.hidden) openPanel(); else closePanel(); });
    live = h("p", { class: "dap-live", role: "status", "aria-live": "polite" });
    launcher = h("div", { class: "dap-launcher", "data-ai-ignore": "" }, panel, trigger, live);
    doc.body.append(launcher);
  }

  const api: DapEmbedApi = Object.freeze({
    version: 1 as const,
    async list() { const list = await fetchList(); if (list === null || !alive) return []; return list; },
    start,
  });
  Object.defineProperty(win, "DapEmbed", { value: api, writable: false, configurable: true, enumerable: false });
  const teardown = () => {
    alive = false;
    lifetime.abort();
    stop();
    launcher?.remove();
    removeStylesheet?.();
    win.removeEventListener("pagehide", teardown);
    if (Object.getOwnPropertyDescriptor(win, "DapEmbed")?.value === api) delete (win as unknown as Record<string, unknown>).DapEmbed;
  };
  win.addEventListener("pagehide", teardown, { once: true });
  // The launcher only appears for a valid, non-empty list: a wrong key, a refused Origin or a broken reply leaves the page untouched.
  void (async () => {
    const list = await fetchList();
    await Promise.resolve(stylesheet).catch(() => undefined);
    if (!alive) return;
    if (list === null) { teardown(); return; }
    if (list.length > 0) build(list);
  })();
  return { ok: true, destroy: teardown };
}
