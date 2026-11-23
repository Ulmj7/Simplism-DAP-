import { readRuntimeStatus, STATUS_REPLY, STATUS_REQUEST } from "./site.js";
import type { RuntimeStatus } from "./site.js";

const installed = Symbol.for("simplism.extension.receiver.v1");
if (window === window.top && !Object.hasOwn(globalThis, installed)) {
  Object.defineProperty(globalThis, installed, { value: true });
  chrome.runtime.onMessage.addListener((message, sender, reply) => {
    if (sender.id !== chrome.runtime.id || message !== STATUS_REQUEST || window !== window.top) return;
    let status: RuntimeStatus | null = null;
    function capture(event: Event) {
      const detail: unknown = (event as CustomEvent<unknown>).detail;
      if (typeof detail === "string" && detail.length <= 64) {
        try { status = readRuntimeStatus(JSON.parse(detail)); } catch { /* ignore invalid page data */ }
      }
    }
    document.addEventListener(STATUS_REPLY, capture, { once: true });
    try { document.dispatchEvent(new Event(STATUS_REQUEST)); }
    finally { document.removeEventListener(STATUS_REPLY, capture); }
    reply(status);
  });
}
