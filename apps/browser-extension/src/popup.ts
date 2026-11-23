import { readBinding, readRuntimeStatus, readSelection, sitePattern } from "./site.js";
import type { Binding, Selection } from "./site.js";

const form = document.querySelector<HTMLFormElement>("#binding")!;
const fields = form.querySelector("fieldset")!;
const site = document.querySelector<HTMLElement>("#site")!;
const status = document.querySelector<HTMLElement>("#status")!;
const open = document.querySelector<HTMLButtonElement>("#open")!;
const toggle = document.querySelector<HTMLButtonElement>("#toggle")!;
const refresh = document.querySelector<HTMLButtonElement>("#refresh")!;
const inputs = {
  applicationId: form.elements.namedItem("applicationId") as HTMLInputElement,
  runtimeKey: form.elements.namedItem("runtimeKey") as HTMLInputElement,
  apiOrigin: form.elements.namedItem("apiOrigin") as HTMLInputElement,
};

let page: Selection | null = null;
let binding: Binding | null = null;
let access = false;
let busy = false;

function display() {
  fields.disabled = busy || !page;
  refresh.disabled = busy || !page;
  open.disabled = busy || !binding?.enabled || !access;
  toggle.disabled = busy || !page || !binding;
  toggle.textContent = binding?.enabled ? "Disable on this site" : "Enable on this site";
}

const messages: Record<string, string> = {
  READY: "Published guides are available.",
  EMPTY: "No published guides are available for this site.",
  DIRECT_RUNTIME: "This page already has a Simplism runtime.",
  DETACHED: "Simplism is disabled on this site.",
  SITE_CHANGED: "The page changed. Refresh or reopen this popup.",
  INVALID_CONFIGURATION: "Enter a valid application ID, runtime key, and API origin.",
  APPLICATION_UNAVAILABLE: "This application binding is unavailable for this site.",
  NETWORK_UNAVAILABLE: "Could not reach the guide service from this site.",
  INVALID_RESPONSE: "The guide service sent an invalid response.",
  ACCESS_REQUIRED: "Allow access to this site to enable Simplism.",
  UNAVAILABLE: "Simplism cannot access this page.",
};

async function send(action: string, current: Selection | null, draft?: Binding | null) {
  const response = await chrome.runtime.sendMessage({ action, page: current, binding: draft ?? null });
  return response && typeof response === "object" ? response as Record<string, unknown> : {};
}

function inspect(reply: Record<string, unknown>) {
  page = readSelection(reply.page);
  site.textContent = page?.origin ?? "This browser page is unavailable.";
  access = reply.access === true;
  binding = page ? readBinding(reply.binding, page.origin) : null;
  inputs.applicationId.value = binding?.applicationId ?? "";
  inputs.runtimeKey.value = binding?.runtimeKey ?? "";
  inputs.apiOrigin.value = binding?.apiOrigin ?? "";
  if (!binding?.enabled) return binding ? messages.DETACHED! : page ? "Save an application binding to get started." : messages.UNAVAILABLE!;
  if (!access) return messages.ACCESS_REQUIRED!;
  const runtime = readRuntimeStatus(reply.runtime);
  const count = runtime?.count;
  const published = count === null || count === undefined ? "" : ` ${count} published ${count === 1 ? "guide" : "guides"} available.`;
  switch (runtime?.state) {
    case "READY": return published.trim();
    case "EMPTY": return messages.EMPTY!;
    case "RUNNING": return "A guide is running." + published;
    case "ERROR": return "Simplism encountered an error." + published;
    case "DIRECT_RUNTIME": return messages.DIRECT_RUNTIME!;
    default: return "Simplism is enabled. Open Simplism to check for published guides.";
  }
}

async function request(action: "inspect" | "save" | "open" | "disable" | "enable" | "refresh") {
  if (busy) return;
  const current = page;
  const draft = action === "save" && current ? readBinding({
    origin: current.origin,
    applicationId: inputs.applicationId.value.trim(),
    runtimeKey: inputs.runtimeKey.value.trim(),
    apiOrigin: inputs.apiOrigin.value.trim(),
    enabled: true,
  }, current.origin) : null;
  if (action === "save" && !draft) { status.textContent = messages.INVALID_CONFIGURATION!; return; }
  busy = true;
  display();
  status.textContent = "Checking…";
  try {
    if ((action === "save" || action === "enable") && current && !access) {
      const granted = await chrome.permissions.request({ origins: [sitePattern(current.origin)] });
      if (!granted) { status.textContent = messages.ACCESS_REQUIRED!; return; }
    }
    if (action === "inspect" || action === "refresh") {
      status.textContent = inspect(await send("inspect", null));
      if (action === "inspect" || !binding?.enabled || !access) return;
    }
    const reply = await send(action, action === "refresh" ? page : current, draft);
    const outcome = typeof reply.status === "string" && Object.hasOwn(messages, reply.status) ? reply.status : "UNAVAILABLE";
    page = readSelection(reply.page) ?? page;
    if (Object.hasOwn(reply, "access")) access = reply.access === true;
    if (page && Object.hasOwn(reply, "binding")) binding = readBinding(reply.binding, page.origin);
    if (action === "open" && (outcome === "READY" || outcome === "EMPTY")) { window.close(); return; }
    const success = outcome === "READY" || outcome === "EMPTY" || outcome === "DIRECT_RUNTIME";
    const prefix = success && action === "save" ? "Site saved. " : success && action === "enable" ? "Site enabled. " : "";
    status.textContent = prefix + messages[outcome]!;
  } catch { status.textContent = messages.UNAVAILABLE!; }
  finally { busy = false; display(); }
}

form.addEventListener("submit", event => { event.preventDefault(); void request("save"); });
open.addEventListener("click", () => { void request("open"); });
toggle.addEventListener("click", () => { void request(binding?.enabled ? "disable" : "enable"); });
refresh.addEventListener("click", () => { void request("refresh"); });
void request("inspect");
