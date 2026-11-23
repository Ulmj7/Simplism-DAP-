import { isReady, parseBundle, parseStatus, runMessage, terminal } from "../embed/protocol.js";
import type { EmbeddedApplication, ManagedBundle, Refusal, RunStatus } from "../embed/protocol.js";
import { normalizedOrigin } from "./wire.js";

export type ApplicationRunResult = { readonly kind: "started" | "popup_blocked" | "no_embed" | "closed" }
  | { readonly kind: "refused"; readonly reason: Refusal };
const running = new WeakSet<Window>();

/** Keep the opener for the handshake. Invoke synchronously from the launch button to retain popup permission. */
export function runInApplicationWindow({ window: win, application, bundle, timeoutMs = 10_000, onStatus }: {
  window: Window; application: EmbeddedApplication; bundle: ManagedBundle | (() => Promise<ManagedBundle | null>);
  timeoutMs?: number; onStatus: (status: RunStatus) => void;
}): Promise<ApplicationRunResult> {
  const origin = application.origin;
  if (!normalizedOrigin(origin)) return Promise.resolve({ kind: "refused", reason: "invalid_bundle" });
  if (running.has(win)) return Promise.resolve({ kind: "refused", reason: "already_running" });
  let popup: Window | null;
  try { popup = win.open(origin + "/", "_blank"); } catch { popup = null; }
  if (!popup) return Promise.resolve({ kind: "popup_blocked" });
  const child = popup;
  running.add(win);

  return new Promise(resolve => {
    let ready = false, sent = false, finished = false;
    let parsed: ManagedBundle | undefined;
    const finish = (result: ApplicationRunResult) => {
      if (finished) return;
      finished = true;
      win.clearTimeout(timeout); win.clearInterval(poll);
      win.removeEventListener("message", receive);
      win.removeEventListener("pagehide", onClose);
      running.delete(win);
      resolve(result);
    };
    const send = () => {
      if (finished || sent || !ready || !parsed) return;
      sent = true;
      try { child.postMessage(runMessage(parsed), origin); } catch { finish({ kind: "closed" }); }
    };
    const receive = (event: MessageEvent) => {
      if (event.origin !== origin || event.source !== child) return;
      if (isReady(event.data)) { ready = true; send(); return; }
      if (!sent) return;
      const status = parseStatus(event.data);
      if (!status) return;
      win.clearTimeout(timeout);
      // Finish after the final status so callers can keep one run active and unsubscribe in one place.
      if (status.status === "refused") finish({ kind: "refused", reason: status.reason });
      else if (terminal(status.status)) finish({ kind: "started" });
      try { onStatus(status); } catch { /* The caller's UI cannot interrupt cleanup. */ }
    };
    const onClose = () => finish({ kind: "closed" });
    const timeout = win.setTimeout(() => finish({ kind: "no_embed" }), timeoutMs);
    const poll = win.setInterval(() => { if (child.closed) onClose(); }, 250);
    win.addEventListener("message", receive);
    win.addEventListener("pagehide", onClose);
    void Promise.resolve().then(() => typeof bundle === "function" ? bundle() : bundle).then(value => {
      const result = parseBundle(value);
      if (!result.ok || result.bundle.application.id !== application.id || result.bundle.application.origin !== origin) {
        finish({ kind: "refused", reason: result.ok ? "invalid_bundle" : result.reason });
        return;
      }
      parsed = result.bundle;
      send();
    }).catch(() => finish({ kind: "refused", reason: "invalid_bundle" }));
  });
}

export function applicationRunStatus(status: RunStatus): string {
  switch (status.status) {
    case "COMPLETED": return "Walkthrough finished.";
    case "CANCELLED": return "Walkthrough cancelled.";
    case "FAILED": return "The walkthrough could not finish.";
    case "refused": return "";
    default: return "Walkthrough running in the application window.";
  }
}

export function applicationRunResult(result: ApplicationRunResult): string {
  switch (result.kind) {
    case "started": return "";
    case "popup_blocked": return "The application window was blocked. Allow pop-ups and try again.";
    case "no_embed": return "The application did not answer. Make sure the application includes the DAP runtime script.";
    case "closed": return "The application window closed.";
    case "refused": return result.reason === "already_running" ? "A walkthrough is already running in an application window."
      : "The application could not start this walkthrough.";
  }
}
