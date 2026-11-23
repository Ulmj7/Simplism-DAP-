import { isPlainText, MAX_DESCRIPTION, MAX_LABEL } from "@dap/walkthrough";
import { h } from "../dom.js";
import { normalizedOrigin } from "../admin/wire.js";
import { mountManagedRuntime } from "./managed-runtime.js";
import { parseBundle } from "./protocol.js";
import type { ManagedBundle } from "./protocol.js";

/**
 * STANDALONE delivery (Studio completion S8): `<script src="https://dap.example/dap-embed.js" data-dap-key="rk-…">`. The runtime API origin is the script's own origin; the embed lists the live guides
 * of the application (`GET /api/runtime/:key/guides`), offers a small accessible launcher and runs a chosen guide (`GET /api/runtime/:key/guides/:id`) in the page. Requests carry no credentials
 * and no cookies (`credentials: "omit"`, `mode: "cors"`); the host authorizes the key and the page's Origin. Inert (no DOM, no globals) when anything about the configuration or the first reply is wrong.
 */
export const RUNTIME_KEY = /^rk-[0-9a-f]{32}$/u;
export const MAX_GUIDES = 50;
export const MAX_REPLY_CHARS = 262_144;
export const FETCH_TIMEOUT_MS = 10_000;
const GUIDE_ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u;

export interface GuideSummary { readonly id: string; readonly title: string; readonly description: string }
export type StartResult = { readonly ok: true } | { readonly ok: false; readonly reason: "unavailable" | "unknown_guide" | "busy" | "invalid_guide" | "wrong_page" };
export interface DapEmbedApi { readonly version: 1; list(): Promise<readonly GuideSummary[]>; start(id: string): Promise<StartResult> }

export interface StandaloneOptions {
  readonly window: Window;
  readonly key: string;
  /** The script's own URL: its origin is the API origin. */
  readonly scriptSrc: string;
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

export function parseGuideList(value: unknown): readonly GuideSummary[] | null {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== 1 || keys[0] !== "guides") return null;
    const guides = (value as { guides: unknown }).guides;
    if (!Array.isArray(guides) || guides.length > MAX_GUIDES) return null;
    const list: GuideSummary[] = [];
    for (const item of guides as unknown[]) {
      if (item === null || typeof item !== "object" || Array.isArray(item)) return null;
      const own = Reflect.ownKeys(item);
      if (own.length !== 3 || !["id", "title", "description"].every(key => own.includes(key))) return null;
      const { id, title, description } = item as Record<string, unknown>;
      if (typeof id !== "string" || !GUIDE_ID.test(id) || !isPlainText(title, MAX_LABEL) || !isPlainText(description, MAX_DESCRIPTION)) return null;
      if (list.some(entry => entry.id === id)) return null;
      list.push(Object.freeze({ id, title: title as string, description: description as string }));
    }
    return Object.freeze(list);
  } catch { return null; }
}

export function installStandalone({ window: win, key, scriptSrc, fetch: fetcher = win.fetch.bind(win), trustedEventsOnly = true, stylesheet, removeStylesheet }: StandaloneOptions): { readonly ok: boolean; destroy(): void } {
  const inert = { ok: false, destroy() {} } as const;
  let base: URL;
  try { base = new URL(scriptSrc); } catch { return inert; }
  const apiOrigin = base.origin;
  if (!RUNTIME_KEY.test(key) || !normalizedOrigin(apiOrigin) || Object.hasOwn(win, "DapEmbed")) return inert;
  const doc = win.document;
  const root = `${apiOrigin}/api/runtime/${key}/guides`;
  let alive = true;
  let running: ReturnType<typeof mountManagedRuntime> | undefined;
  let starting = false;
  let launcher: HTMLElement | undefined;
  let trigger: HTMLButtonElement | undefined;
  let panel: HTMLElement | undefined;
  let live: HTMLElement | undefined;
  const say = (text: string) => { if (live) live.textContent = text; };

  /** One GET: no credentials, no cookies, no referrer, no redirect, a bounded size and time. `null` for anything but a 200 JSON reply of an acceptable size. */
  async function getJson(url: string): Promise<unknown> {
    const abort = new AbortController();
    const timer = win.setTimeout(() => abort.abort(), FETCH_TIMEOUT_MS);
    try {
      const response = await fetcher(url, { method: "GET", mode: "cors", credentials: "omit", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer", headers: { accept: "application/json" }, signal: abort.signal });
      if (response.status !== 200 || !(response.headers.get("content-type") ?? "").toLowerCase().includes("json")) return null;
      const declared = Number(response.headers.get("content-length") ?? 0);
      if (Number.isFinite(declared) && declared > MAX_REPLY_CHARS) return null;
      const text = await response.text();
      if (text.length > MAX_REPLY_CHARS) return null;
      return JSON.parse(text) as unknown;
    } catch { return null; } finally { win.clearTimeout(timer); }
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
