import { applicationIdOf, normalizedOrigin } from "../admin/wire.js";
import { h } from "../dom.js";
import { stepProgress } from "../progress.js";
import { mountManagedRuntime } from "./managed-runtime.js";
import { parseBundle } from "./protocol.js";
import type { RunFailure } from "./protocol.js";
import { getRuntimeJson, GUIDE_ID, parseGuideList, PREVIEW_OWNER, RUNTIME_KEY, SDK_INSTANCE } from "./runtime-delivery.js";

export interface SimplismOptions {
  readonly applicationId: string;
  readonly runtimeKey: string;
  readonly apiOrigin: string;
  /** External CSS URL. Omit when the application loads simplism.css itself. */
  readonly stylesheetUrl?: string;
}

export interface Guide {
  readonly id: string;
  readonly title: string;
  readonly description: string;
}

export type ErrorCode = "INVALID_CONFIGURATION" | "ALREADY_INITIALIZED" | "RUNTIME_DESTROYED"
  | "APPLICATION_UNAVAILABLE" | "NETWORK_UNAVAILABLE" | "INVALID_RESPONSE" | "GUIDE_NOT_FOUND"
  | "GUIDE_BUSY" | "GUIDE_STOPPED" | "TARGET_NOT_FOUND" | "ROUTE_MISMATCH" | "VERIFICATION_FAILED" | "GUIDE_UNAVAILABLE";
export type RuntimeResult<T = undefined> = { readonly ok: true; readonly value: T } | { readonly ok: false; readonly code: ErrorCode };
export type GuideRun = { readonly status: "idle" } | {
  readonly status: "running" | "completed" | "stopped"; readonly guideId: string;
} | { readonly status: "failed"; readonly guideId: string; readonly code: ErrorCode };
export interface Simplism {
  start(): Promise<RuntimeResult<readonly Guide[]>>;
  listGuides(): Promise<RuntimeResult<readonly Guide[]>>;
  openLauncher(): Promise<RuntimeResult>;
  startGuide(id: string): Promise<RuntimeResult>;
  stopGuide(): void;
  getRun(): GuideRun;
  restartGuide(): Promise<RuntimeResult>;
  destroy(): void;
}

const success = <T>(value: T) => ({ ok: true, value }) as const;
const failure = (code: ErrorCode) => ({ ok: false, code }) as const;
const messages: Record<ErrorCode, string> = {
  INVALID_CONFIGURATION: "The guide launcher is not configured.",
  ALREADY_INITIALIZED: "A guide launcher is already installed.",
  RUNTIME_DESTROYED: "The guide launcher has been closed.",
  APPLICATION_UNAVAILABLE: "Guides are unavailable for this application.",
  NETWORK_UNAVAILABLE: "Guides could not be loaded. Please try again.",
  INVALID_RESPONSE: "Guides could not be loaded.",
  GUIDE_NOT_FOUND: "This guide is no longer available.",
  GUIDE_BUSY: "A guide is already running.",
  GUIDE_STOPPED: "Guide stopped.",
  TARGET_NOT_FOUND: "This guide can't find the required control on this page.",
  ROUTE_MISMATCH: "This guide can't continue on the current page.",
  VERIFICATION_FAILED: "This guide could not verify the last step.",
  GUIDE_UNAVAILABLE: "This guide can't continue right now.",
};
const runError = (reason: RunFailure["code"]): ErrorCode => {
  switch (reason) {
    case "target_unavailable": return "TARGET_NOT_FOUND";
    case "route_mismatch": return "ROUTE_MISMATCH";
    case "verification_failed": return "VERIFICATION_FAILED";
    case "cancelled": return "GUIDE_STOPPED";
    default: return "GUIDE_UNAVAILABLE";
  }
};

interface Slot { readonly key: string; readonly instance: Simplism }

/** Create or retrieve the single Simplism instance for this page. Call start() after the document body exists. */
export function createSimplism(options: SimplismOptions): RuntimeResult<Simplism> {
  const win = typeof window === "undefined" ? undefined : window;
  if (!win || !options || !applicationIdOf(options.applicationId) || typeof options.runtimeKey !== "string"
    || !RUNTIME_KEY.test(options.runtimeKey) || !normalizedOrigin(options.apiOrigin) || options.apiOrigin === win.location.origin) {
    return failure("INVALID_CONFIGURATION");
  }
  let style: URL | undefined;
  if (options.stylesheetUrl !== undefined) {
    try { style = new URL(options.stylesheetUrl, win.location.href); } catch { return failure("INVALID_CONFIGURATION"); }
    if ((style.protocol !== "https:" && style.protocol !== "http:") || style.username || style.password) return failure("INVALID_CONFIGURATION");
  }
  const slot = win as Window & { [SDK_INSTANCE]?: Slot };
  const config = JSON.stringify([options.applicationId, options.runtimeKey, options.apiOrigin, style?.href]);
  if (Object.hasOwn(win, PREVIEW_OWNER)) return failure("ALREADY_INITIALIZED");
  const previous = slot[SDK_INSTANCE];
  if (previous) return previous.key === config ? success(previous.instance) : failure("ALREADY_INITIALIZED");
  if (Object.hasOwn(win, "DapEmbed")) return failure("ALREADY_INITIALIZED");
  const instance = createInstance(win, options, style, () => { delete slot[SDK_INSTANCE]; });
  Object.defineProperty(win, SDK_INSTANCE, { configurable: true, value: { key: config, instance } });
  return success(instance);
}

function createInstance(win: Window, { applicationId, runtimeKey, apiOrigin }: SimplismOptions, style: URL | undefined, release: () => void): Simplism {
  const doc = win.document;
  const lifetime = new AbortController();
  const url = (id?: string) => `${apiOrigin}/api/runtime/${encodeURIComponent(runtimeKey)}/guides${id ? "/" + id : ""}?applicationId=${applicationId}`;
  const fetchJson = (path: string, signal: AbortSignal) => getRuntimeJson(win, win.fetch.bind(win), path, signal);
  let root: HTMLElement | undefined;
  let stylesheet: HTMLLinkElement | undefined;
  let guideList: readonly Guide[] | undefined;
  let loading: { controller: AbortController; result: Promise<RuntimeResult<readonly Guide[]>> } | undefined;
  let pending: AbortController | undefined;
  let mounted: Extract<ReturnType<typeof mountManagedRuntime>, { ok: true }> | undefined;
  let lastGuide: string | undefined;
  let run: GuideRun = { status: "idle" };
  const trigger = h("button", { type: "button", class: "dap-launcher-button", "aria-haspopup": "dialog", "aria-expanded": "false" }, "Guides");
  const heading = h("h2", { tabindex: "-1" }, "Available guides");
  const contents = h("div");
  const status = h("p", { class: "dap-live", role: "status", "aria-live": "polite" });
  const controls = h("div", { class: "dap-sdk-controls", hidden: true });
  const stop = h("button", { type: "button" }, "Stop guide");
  const restart = h("button", { type: "button" }, "Restart guide");
  const close = h("button", { type: "button", class: "dap-launcher-close" }, "Close");
  const panel = h("section", { class: "dap-launcher-panel", role: "dialog", "aria-label": "Available guides", hidden: true }, heading, contents, controls, close);
  controls.append(stop, restart);

  function showPanel(open: boolean) {
    panel.hidden = !open;
    trigger.setAttribute("aria-expanded", String(open));
    if (open) (panel.querySelector("li button:not(:disabled)") as HTMLElement | null ?? heading).focus();
    else trigger.focus();
  }
  function showList(guides: readonly Guide[], focusedGuide?: string) {
    if (guides.length === 0) { contents.replaceChildren(h("p", {}, "No guides are available for this application.")); return; }
    const list = h("ul", { "aria-label": "Published guides" });
    for (const guide of guides) {
      const button = h("button", { type: "button", "aria-label": `Start guide: ${guide.title}`, "data-simplism-guide": guide.id }, "Start");
      list.append(h("li", {}, h("strong", {}, guide.title), h("p", {}, guide.description), button));
    }
    contents.replaceChildren(list);
    if (!panel.hidden && doc.activeElement === heading) {
      const buttons = Array.from(list.querySelectorAll("button"));
      (buttons.find(button => button.dataset.simplismGuide === focusedGuide) ?? buttons[0])?.focus();
    }
  }
  function announce(code: ErrorCode) { status.textContent = messages[code]; }
  function showError(code: ErrorCode) {
    const message = h("p", { role: "alert" }, messages[code]);
    if (code !== "NETWORK_UNAVAILABLE") { contents.replaceChildren(message); return; }
    const retry = h("button", { type: "button", "data-simplism-retry": "" }, "Retry");
    contents.replaceChildren(message, retry);
    if (!panel.hidden && doc.activeElement === heading) retry.focus();
  }
  function mountLauncher() {
    root = h("div", { class: "dap-launcher", "data-ai-ignore": "", "data-simplism-runtime": "" }, panel, trigger, status);
    if (style && ![...doc.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')].some(link => link.href === style.href)) {
      stylesheet = doc.createElement("link");
      stylesheet.rel = "stylesheet";
      stylesheet.href = style.href;
      doc.head.append(stylesheet);
    }
    doc.body.append(root);
  }

  async function load(signal: AbortSignal, focusedGuide?: string): Promise<RuntimeResult<readonly Guide[]>> {
    const reply = await fetchJson(url(), AbortSignal.any([lifetime.signal, signal]));
    if (lifetime.signal.aborted) return failure("RUNTIME_DESTROYED");
    if (signal.aborted) return failure("NETWORK_UNAVAILABLE");
    if (!reply.ok) {
      const code = reply.reason === "not_found" ? "APPLICATION_UNAVAILABLE" : reply.reason === "invalid" ? "INVALID_RESPONSE" : "NETWORK_UNAVAILABLE";
      showError(code);
      return failure(code);
    }
    const guides = parseGuideList(reply.body);
    if (!guides) { showError("INVALID_RESPONSE"); return failure("INVALID_RESPONSE"); }
    guideList = guides;
    showList(guides, focusedGuide);
    return success(guides);
  }

  function start(): Promise<RuntimeResult<readonly Guide[]>> {
    if (lifetime.signal.aborted) return Promise.resolve(failure("RUNTIME_DESTROYED"));
    if (!doc.body) return Promise.resolve(failure("INVALID_CONFIGURATION"));
    if (!root) mountLauncher();
    if (guideList) return Promise.resolve(success(guideList));
    if (loading) return loading.result;
    const controller = new AbortController();
    const focused = doc.activeElement;
    const moveFocus = !panel.hidden && contents.contains(focused);
    const focusedGuide = focused?.getAttribute("data-simplism-guide") ?? undefined;
    contents.replaceChildren(h("p", { role: "status" }, "Loading guides…"));
    const result = load(controller.signal, focusedGuide).finally(() => {
      if (loading?.controller === controller) loading = undefined;
    });
    loading = { controller, result };
    if (moveFocus) heading.focus();
    return result;
  }

  function listGuides() {
    guideList = undefined;
    return start();
  }

  function stopGuide() {
    pending?.abort();
    pending = undefined;
    const current = mounted;
    mounted = undefined;
    current?.destroy();
    controls.hidden = true;
    if (current && !lifetime.signal.aborted && lastGuide) {
      run = { status: "stopped", guideId: lastGuide };
      announce("GUIDE_STOPPED");
      trigger.focus();
    }
  }

  async function openLauncher(): Promise<RuntimeResult> {
    const ready = listGuides();
    if (root && !lifetime.signal.aborted) showPanel(true);
    const loaded = await ready;
    return loaded.ok ? success(undefined) : loaded;
  }

  async function startGuide(id: string): Promise<RuntimeResult> {
    if (lifetime.signal.aborted) return failure("RUNTIME_DESTROYED");
    if (pending || mounted) return failure("GUIDE_BUSY");
    if (typeof id !== "string" || !GUIDE_ID.test(id)) { announce("GUIDE_NOT_FOUND"); return failure("GUIDE_NOT_FOUND"); }
    const operation = new AbortController();
    pending = operation;
    const signal = AbortSignal.any([lifetime.signal, operation.signal]);
    const stopped = () => failure(lifetime.signal.aborted ? "RUNTIME_DESTROYED" : "GUIDE_STOPPED");
    const reject = (code: ErrorCode) => { announce(code); return failure(code); };
    try {
      const ready = await start();
      if (signal.aborted) return stopped();
      if (!ready.ok) return ready;
      if (!ready.value.some(guide => guide.id === id)) return reject("GUIDE_NOT_FOUND");
      status.textContent = "Starting guide…";
      const reply = await fetchJson(url(id), signal);
      if (signal.aborted) return stopped();
      if (!reply.ok) return reject(reply.reason === "not_found" ? "GUIDE_NOT_FOUND" : reply.reason === "invalid" ? "INVALID_RESPONSE" : "NETWORK_UNAVAILABLE");
      const parsed = parseBundle(reply.body);
      if (!parsed.ok || parsed.bundle.definition.id !== id || parsed.bundle.application.id !== applicationId) return reject("INVALID_RESPONSE");
      if (parsed.bundle.application.origin !== win.location.origin) return reject("ROUTE_MISMATCH");
      if (!panel.hidden) { panel.hidden = true; trigger.setAttribute("aria-expanded", "false"); }
      run = { status: "running", guideId: id };
      const guide = mountManagedRuntime({
        window: win, bundle: parsed.bundle,
        onStatus(state) {
          if (state.status === "COMPLETED") {
            run = { status: "completed", guideId: id };
            status.textContent = "Guide complete.";
          } else if ("failure" in state && state.failure) {
            const code = runError(state.failure.code);
            run = code === "GUIDE_STOPPED" ? { status: "stopped", guideId: id } : { status: "failed", guideId: id, code };
            announce(code);
          }
          else if (state.status !== "refused" && state.stepIndex !== undefined) {
            const step = parsed.bundle.definition.steps[state.stepIndex];
            const progress = step && stepProgress(parsed.bundle.definition, step.id);
            status.textContent = progress && progress.index > 0
              ? `Guide running. Step ${progress.index} of ${progress.total}.`
              : "Guide running.";
          }
        },
        onDismiss() {
          const finalMessage = status.textContent;
          const finalRun = run;
          stopGuide();
          run = finalRun;
          status.textContent = finalMessage;
        },
        onUnexpectedRoute() {
          stopGuide();
          run = { status: "failed", guideId: id, code: "ROUTE_MISMATCH" };
          announce("ROUTE_MISMATCH");
        },
      });
      if (!guide.ok) { run = { status: "failed", guideId: id, code: "GUIDE_UNAVAILABLE" }; return reject("GUIDE_UNAVAILABLE"); }
      mounted = guide;
      lastGuide = id;
      controls.hidden = false;
      return success(undefined);
    } finally {
      if (pending === operation) pending = undefined;
    }
  }

  async function restartGuide(): Promise<RuntimeResult> {
    if (lifetime.signal.aborted) return failure("RUNTIME_DESTROYED");
    if (!lastGuide) return failure("GUIDE_NOT_FOUND");
    stopGuide();
    return startGuide(lastGuide);
  }

  function cancelLoad() {
    loading?.controller.abort();
    loading = undefined;
  }

  function destroy() {
    if (lifetime.signal.aborted) return;
    lifetime.abort();
    cancelLoad();
    stopGuide();
    run = { status: "idle" };
    root?.remove();
    stylesheet?.remove();
    release();
  }

  const ownedListener = { signal: lifetime.signal };
  contents.addEventListener("click", event => {
    const button = (event.target as Element | null)?.closest<HTMLButtonElement>("button");
    if (button?.dataset.simplismGuide) void startGuide(button.dataset.simplismGuide);
    if (button?.hasAttribute("data-simplism-retry")) { heading.focus(); void start(); }
  }, ownedListener);
  trigger.addEventListener("click", () => {
    if (panel.hidden) void openLauncher();
    else showPanel(false);
  }, ownedListener);
  close.addEventListener("click", () => showPanel(false), ownedListener);
  stop.addEventListener("click", () => { stopGuide(); showPanel(false); }, ownedListener);
  restart.addEventListener("click", () => { void restartGuide(); }, ownedListener);
  panel.addEventListener("keydown", event => {
    if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); showPanel(false); }
  }, ownedListener);
  win.addEventListener("pagehide", event => {
    if (!event.persisted) { destroy(); return; }
    stopGuide();
    guideList = undefined;
    cancelLoad();
  }, ownedListener);
  win.addEventListener("pageshow", event => {
    if (event.persisted && root) void listGuides();
  }, ownedListener);

  return Object.freeze({ start, listGuides, openLauncher, startGuide, stopGuide, getRun: () => ({ ...run }), restartGuide, destroy });
}
