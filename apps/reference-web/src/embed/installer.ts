import { normalizedOrigin } from "../admin/wire.js";
import { mountManagedRuntime } from "./managed-runtime.js";
import { parseRun, readyMessage, statusMessage } from "./protocol.js";
import type { RunStatus } from "./protocol.js";

export function installEmbed(win: Window, dapOrigin: unknown, stylesheet: string, trustedEventsOnly = true) {
  const opener: Window | null = win.opener;
  if (!opener || !normalizedOrigin(dapOrigin)) return;
  let mounted: ReturnType<typeof mountManagedRuntime> | undefined;
  let accepted = false;
  let style: HTMLStyleElement | undefined;
  const send = (status: RunStatus) => opener.postMessage(statusMessage(status), dapOrigin);
  const listen = (event: MessageEvent) => {
    if (event.origin !== dapOrigin || event.source !== opener) return;
    const run = parseRun(event.data);
    if (!run) return;
    if (accepted) { send({ status: "refused", reason: "already_running" }); return; }
    if (!run.ok) { send({ status: "refused", reason: run.reason }); return; }
    if (run.bundle.application.origin !== win.location.origin) { send({ status: "refused", reason: "invalid_bundle" }); return; }
    style = win.document.createElement("style");
    style.textContent = stylesheet;
    win.document.head.append(style);
    mounted = mountManagedRuntime({ window: win, bundle: run.bundle, trustedEventsOnly,
      onStatus: ({ status }) => { if (status !== "IDLE") send({ status }); } });
    if (mounted.ok) accepted = true;
    else { style.remove(); send({ status: "refused", reason: mounted.reason }); }
  };
  const destroy = () => {
    win.removeEventListener("message", listen);
    win.removeEventListener("pagehide", destroy);
    if (mounted?.ok) mounted.destroy();
    style?.remove();
  };
  win.addEventListener("message", listen);
  win.addEventListener("pagehide", destroy, { once: true });
  opener.postMessage(readyMessage, dapOrigin);
}
