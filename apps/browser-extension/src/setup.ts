import { sitePattern, webOrigin } from "./site.js";

const params = new URLSearchParams(location.search);
const tab = params.get("tab");
const tabId = tab === null ? NaN : Number(tab);
const id = params.get("id");
const site = document.querySelector<HTMLElement>("#site")!;
const status = document.querySelector<HTMLElement>("#status")!;
const allow = document.querySelector<HTMLButtonElement>("#allow")!;
const retry = "Reopen the Simplism popup on the original site to try again.";

const messages: Record<string, string> = {
  READY: "Site saved. Published guides are available.",
  EMPTY: "Site saved. No published guides are available.",
  DIRECT_RUNTIME: "Site saved. This page already has a Simplism runtime.",
  ACCESS_REQUIRED: "Site access was not granted.",
  APPLICATION_UNAVAILABLE: "This application binding is unavailable for this site.",
  NETWORK_UNAVAILABLE: "Could not reach the guide service from this site.",
  INVALID_RESPONSE: "The guide service sent an invalid response.",
  SITE_CHANGED: "The original page changed.",
  UNAVAILABLE: "Simplism could not finish site setup.",
};

async function ask(action: "setup-inspect" | "setup-finish", granted?: boolean) {
  const result = await chrome.runtime.sendMessage({ action, tabId, id, granted });
  return result && typeof result === "object" ? result as Record<string, unknown> : {};
}

function fail(reason: string) {
  status.textContent = `${reason} ${retry}`;
}

async function initialize() {
  if (!Number.isSafeInteger(tabId) || tabId < 0 || !id || !/^[0-9a-f-]{36}$/u.test(id)) {
    fail(messages.UNAVAILABLE!);
    return;
  }
  const reply = await ask("setup-inspect");
  const origin = webOrigin(reply.origin);
  if (reply.status !== "READY" || !origin || reply.origin !== origin) {
    fail(reply.status === "SITE_CHANGED" ? messages.SITE_CHANGED! : messages.UNAVAILABLE!);
    return;
  }
  site.textContent = origin;
  status.textContent = "Allow access to save this site and open published guides there.";
  allow.disabled = false;
  allow.addEventListener("click", async () => {
    allow.disabled = true;
    status.textContent = "Waiting for site access…";
    let granted = false;
    try { granted = await chrome.permissions.request({ origins: [sitePattern(origin)] }); }
    catch { /* A failed permission request never completes setup. */ }
    try {
      const reply = await ask("setup-finish", granted);
      if (reply.status === "READY" || reply.status === "EMPTY" || reply.status === "DIRECT_RUNTIME") {
        status.textContent = messages[reply.status]!;
        try { await chrome.tabs.update(tabId, { active: true }); window.close(); }
        catch { /* The saved status remains visible if the original tab has closed. */ }
      } else {
        const code = typeof reply.status === "string" && Object.hasOwn(messages, reply.status) ? reply.status : "UNAVAILABLE";
        fail(messages[code]!);
      }
    } catch { fail(messages.UNAVAILABLE!); }
  }, { once: true });
}
void initialize().catch(() => fail(messages.UNAVAILABLE!));
