import { normalizedOrigin } from "../admin/wire.js";
import { mountManagedRuntime } from "./managed-runtime.js";
import { parseRun, readyMessage, statusMessage } from "./protocol.js";
import { installStandalone } from "./standalone.js";

export interface InstallOptions {
  /** `data-dap-origin`: the exact Studio origin for the window handshake (Preview). */
  readonly dapOrigin?: unknown;
  /** `data-dap-key`: the runtime key of standalone delivery. */
  readonly key?: unknown;
  /** `data-dap-api`: optional normalized http(s) origin of the DAP API for a customer who self-hosts the two embed files; absent = the script's own origin. Present but invalid = inert. */
  readonly api?: unknown;
  /** The script's own URL: the API origin of standalone delivery and the home of `dap-embed.css`. */
  readonly scriptSrc?: string | undefined;
  readonly trustedEventsOnly?: boolean;
  readonly fetch?: typeof fetch;
}

export const STYLESHEET_WAIT_MS = 3_000;

/**
 * The stylesheet is an EXTERNAL file next to the script (`dap-embed.css`), never an injected `<style>` and never a style attribute: a strict `style-src 'self' <origin>` policy is enough.
 * Resolves when it has loaded, failed or taken too long: the embed then continues (unstyled at worst) instead of waiting forever.
 */
function linkStylesheet(win: Window, scriptSrc: string | undefined): { readonly ready: Promise<void>; remove(): void } {
  if (scriptSrc === undefined) return { ready: Promise.resolve(), remove() {} };
  let href: string;
  try { href = new URL("dap-embed.css", scriptSrc).href; } catch { return { ready: Promise.resolve(), remove() {} }; }
  const link = win.document.createElement("link");
  link.rel = "stylesheet";
  link.href = href;
  link.setAttribute("data-dap-embed", "");
  const ready = new Promise<void>(resolve => {
    const done = () => { win.clearTimeout(timer); resolve(); };
    const timer = win.setTimeout(done, STYLESHEET_WAIT_MS);
    link.addEventListener("load", done, { once: true });
    link.addEventListener("error", done, { once: true });
  });
  win.document.head.append(link);
  return { ready, remove: () => link.remove() };
}

export function installEmbed(win: Window, options: InstallOptions = {}) {
  const { dapOrigin, key, api, scriptSrc, trustedEventsOnly = true } = options;
  const opener: Window | null = win.opener;
  const handshake = opener !== null && normalizedOrigin(dapOrigin);
  // Studio's own window (Preview) always wins: a page that also carries a key does not get a launcher on top of a Preview run.
  if (!handshake) {
    const apiGiven = api !== undefined && api !== null;
    if (typeof key === "string" && scriptSrc !== undefined && (!apiGiven || normalizedOrigin(api))) {
      const sheet = linkStylesheet(win, scriptSrc);
      const standalone = installStandalone({ window: win, key, scriptSrc, ...(apiGiven ? { apiOrigin: api as string } : {}), trustedEventsOnly, stylesheet: sheet.ready, removeStylesheet: sheet.remove, ...(options.fetch === undefined ? {} : { fetch: options.fetch }) });
      if (!standalone.ok) sheet.remove();
    }
    return;
  }
  let mounted: ReturnType<typeof mountManagedRuntime> | undefined;
  let accepted = false;
  const sheet = linkStylesheet(win, scriptSrc);
  const send = (status: Parameters<typeof statusMessage>[0]) => opener.postMessage(statusMessage(status), dapOrigin);
  const listen = (event: MessageEvent) => {
    if (event.origin !== dapOrigin || event.source !== opener) return;
    const run = parseRun(event.data);
    if (!run) return;
    if (accepted) { send({ status: "refused", reason: "already_running" }); return; }
    if (!run.ok) { send({ status: "refused", reason: run.reason }); return; }
    if (run.bundle.application.origin !== win.location.origin) { send({ status: "refused", reason: "invalid_bundle" }); return; }
    mounted = mountManagedRuntime({ window: win, bundle: run.bundle, trustedEventsOnly, onStatus: status => { send(status); } });
    if (mounted.ok) accepted = true;
    else send({ status: "refused", reason: mounted.reason });
  };
  const destroy = () => {
    win.removeEventListener("message", listen);
    win.removeEventListener("pagehide", destroy);
    if (mounted?.ok) mounted.destroy();
    sheet.remove();
  };
  win.addEventListener("message", listen);
  win.addEventListener("pagehide", destroy, { once: true });
  opener.postMessage(readyMessage, dapOrigin);
}
