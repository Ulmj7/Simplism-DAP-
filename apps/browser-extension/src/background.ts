import { readBinding, readPage, readRuntimeStatus, readSelection, settingKey, sitePattern, STATUS_REQUEST, webOrigin } from "./site.js";
import type { Binding, Page, PageAction, PageReply, Selection } from "./site.js";

const popupUrl = chrome.runtime.getURL("popup.html");
const setupUrl = chrome.runtime.getURL("setup.html");
const ready = chrome.storage.local.setAccessLevel({ accessLevel: "TRUSTED_CONTEXTS" });
const queue = new Map<string, Promise<unknown>>();
const unavailable = { status: "UNAVAILABLE" } as const;
const changed = { status: "SITE_CHANGED" } as const;
const documentKey = (tabId: number) => `document:${tabId}`;
const setupKey = (tabId: number) => `setup:${tabId}`;
const setupDuration = 5 * 60_000;

function setupHref(tabId: number, id: string) {
  return `${setupUrl}?tab=${tabId}&id=${id}`;
}

chrome.tabs.onRemoved.addListener(tabId => {
  void chrome.storage.session.remove(documentKey(tabId)).catch(() => undefined);
  void chrome.storage.session.remove(setupKey(tabId)).catch(() => undefined);
});

async function inspectPage(selection: Selection) {
  const key = documentKey(selection.tabId);
  const page = readPage((await chrome.storage.session.get(key))[key]);
  if (page?.tabId !== selection.tabId || page.origin !== selection.origin) return { page: selection, runtime: null };
  try {
    const status = await chrome.tabs.sendMessage(page.tabId, STATUS_REQUEST, { documentId: page.documentId });
    return { page, runtime: readRuntimeStatus(status) };
  } catch { return { page: selection, runtime: null }; }
}

function onSite<T>(origin: string, action: () => Promise<T>): Promise<T> {
  const work = (queue.get(origin) ?? ready).catch(() => undefined).then(async () => {
    await ready;
    return action();
  });
  queue.set(origin, work);
  void work.finally(() => { if (queue.get(origin) === work) queue.delete(origin); }).catch(() => undefined);
  return work;
}

async function pageAt(tabId: number): Promise<Page | null> {
  try {
    const [top] = await chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      func: () => window === window.top ? location.origin : null,
    });
    return top?.frameId === 0 ? readPage({ tabId, documentId: top.documentId, origin: top.result }) : null;
  } catch { return null; }
}

async function saved(origin: string) {
  const key = settingKey(origin);
  return readBinding((await chrome.storage.local.get(key))[key], origin);
}

function hasAccess(origin: string) {
  return chrome.permissions.contains({ origins: [sitePattern(origin)] });
}

async function register(origin: string, enabled: boolean) {
  const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(origin));
  const id = "site-" + Array.from(new Uint8Array(hash), byte => byte.toString(16).padStart(2, "0")).join("");
  const known = (await chrome.scripting.getRegisteredContentScripts({ ids: [id] })).length > 0;
  if (enabled && !known) await chrome.scripting.registerContentScripts([{
    id, matches: [sitePattern(origin)], js: ["content.js"], allFrames: false, runAt: "document_idle", persistAcrossSessions: true,
  }]);
  if (!enabled && known) await chrome.scripting.unregisterContentScripts({ ids: [id] });
}

const pageStatuses = new Set([
  "READY", "EMPTY", "VERIFIED", "DETACHED", "DIRECT_RUNTIME", "SITE_CHANGED", "INVALID_CONFIGURATION",
  "APPLICATION_UNAVAILABLE", "NETWORK_UNAVAILABLE", "INVALID_RESPONSE", "ACCESS_REQUIRED", "UNAVAILABLE",
]);

async function sendToPage(page: Page, action: PageAction, binding?: Binding): Promise<PageReply> {
  const target = { tabId: page.tabId, documentIds: [page.documentId] };
  const style = { target, files: ["simplism.css"] };
  if (action !== "detach") await chrome.scripting.executeScript({ target, world: "MAIN", files: ["main.js"] });
  const call = async (command: PageAction): Promise<PageReply> => {
    const [injected] = await chrome.scripting.executeScript({
      target, world: "MAIN",
      // Chrome serializes this function independently of the worker bundle.
      func: async (operation: PageAction, origin: string, configuration: Binding | null) => {
        if (window !== window.top || location.origin !== origin) return { status: "SITE_CHANGED" } as const;
        const key = Symbol.for("simplism.browser-extension.v1");
        const bridge = (window as Window & { [key]?: (cmd: PageAction, site: string, value: Binding | null) => Promise<PageReply> })[key];
        return typeof bridge === "function" ? bridge(operation, origin, configuration) : { status: "DETACHED" } as const;
      },
      args: [command, page.origin, binding ?? null],
    });
    const value = injected?.result;
    if (injected?.frameId !== 0 || injected.documentId !== page.documentId || !value || !pageStatuses.has(value.status)) return unavailable;
    return { status: value.status, css: value.css === true };
  };

  try {
    if (action === "attach" || action === "open" || action === "refresh") {
      const [receiver] = await chrome.scripting.executeScript({ target, files: ["receiver.js"] });
      if (receiver?.documentId !== page.documentId || receiver.frameId !== 0) return changed;
      await chrome.storage.session.set({ [documentKey(page.tabId)]: page });
    }
    const result = await call(action);
    if (action !== "verify") {
      // Repeated popup actions must not accumulate copies of the stylesheet.
      await chrome.scripting.removeCSS(style);
      if ((result.status === "READY" || result.status === "EMPTY") && result.css) await chrome.scripting.insertCSS(style);
    }
    return result;
  } catch {
    if (action !== "verify") {
      await call("detach").catch(() => undefined);
      await chrome.scripting.removeCSS(style).catch(() => undefined);
    }
    return unavailable;
  }
}

async function withSitePages(origin: string, current: Page, action: "detach" | "attach", binding?: Binding) {
  const tabs = await chrome.tabs.query({ url: sitePattern(origin) }).catch(() => []);
  const pages = await Promise.all(tabs.flatMap(tab =>
    tab.id === undefined || tab.id === current.tabId || webOrigin(tab.url) !== origin ? [] : [pageAt(tab.id)]));
  await Promise.allSettled(pages.flatMap(page => page?.origin === origin ? [sendToPage(page, action, binding)] : []));
}

async function stillOnPage(page: Page): Promise<boolean> {
  try {
    const tab = await chrome.tabs.get(page.tabId);
    if (tab.pendingUrl !== undefined || webOrigin(tab.url) !== page.origin) return false;
    const top = await pageAt(page.tabId);
    return top?.documentId === page.documentId && top.origin === page.origin;
  } catch { return false; }
}

async function saveBinding(page: Page, draft: Binding) {
  const verified = await sendToPage(page, "verify", draft);
  if (verified.status !== "VERIFIED") return { status: verified.status };
  if (!await stillOnPage(page)) return changed;
  await register(page.origin, true);
  if (!await stillOnPage(page)) return changed;
  await chrome.storage.local.set({ [settingKey(page.origin)]: draft });
  const reply = await sendToPage(page, "attach", draft);
  await withSitePages(page.origin, page, "attach", draft);
  return { status: reply.status, page, binding: draft, access: true };
}

async function beginSetup(page: Page, draft: Binding) {
  const key = setupKey(page.tabId);
  const id = crypto.randomUUID();
  await chrome.storage.session.set({ [key]: { id, page, draft, expires: Date.now() + setupDuration } });
  try {
    await chrome.tabs.create({ url: setupHref(page.tabId, id) });
    return { status: "SETUP_OPENED" };
  } catch {
    await chrome.storage.session.remove(key);
    return unavailable;
  }
}

async function readSetup(tabId: number, id: string) {
  const key = setupKey(tabId);
  const raw = (await chrome.storage.session.get(key))[key];
  if (!raw || typeof raw !== "object") return null;
  const record = raw as Record<string, unknown>;
  if (record.id !== id) return null;
  const page = readPage(record.page);
  const draft = page && readBinding(record.draft, page.origin);
  if (!page || page.tabId !== tabId || !draft?.enabled || typeof record.expires !== "number" || record.expires <= Date.now()) {
    await chrome.storage.session.remove(key);
    return null;
  }
  return { page, draft };
}

async function fromSetup(message: Record<string, unknown>, sender: ExtensionSender) {
  const { action, tabId, id, granted } = message;
  if ((action !== "setup-inspect" && action !== "setup-finish") || typeof tabId !== "number" || !Number.isSafeInteger(tabId) || tabId < 0
    || typeof id !== "string" || !/^[0-9a-f-]{36}$/u.test(id) || sender.frameId !== 0 || sender.tab?.id === undefined
    || sender.url !== setupHref(tabId, id) || (action === "setup-finish" && typeof granted !== "boolean")) return unavailable;
  const pending = await readSetup(tabId, id);
  if (!pending) return changed;
  return onSite(pending.page.origin, async () => {
    const current = await readSetup(tabId, id);
    if (!current) return changed;
    if (action === "setup-finish") {
      // Consume the intent before doing anything that could save a binding.
      await chrome.storage.session.remove(setupKey(tabId));
      if (granted !== true || !await hasAccess(current.page.origin)) return { status: "ACCESS_REQUIRED" };
      if (!await stillOnPage(current.page)) return changed;
      return saveBinding(current.page, current.draft);
    }
    if (!await stillOnPage(current.page)) return changed;
    return { status: "READY", origin: current.page.origin };
  });
}

const popupActions = new Set(["inspect", "save", "open", "disable", "enable", "refresh"]);
async function fromPopup(message: Record<string, unknown>) {
  const action = message.action;
  if (typeof action !== "string" || !popupActions.has(action)) return unavailable;
  const [tab, ...others] = await chrome.tabs.query({ active: true, currentWindow: true });
  const origin = webOrigin(tab?.url);
  if (others.length || tab?.id === undefined || origin === null) return unavailable;
  if (tab.pendingUrl !== undefined) return changed;
  const selection = { tabId: tab.id, origin };
  if (action === "inspect") {
    await ready;
    const binding = await saved(origin);
    const access = await hasAccess(origin);
    const inspection = binding?.enabled && access ? await inspectPage(selection) : { page: selection, runtime: null };
    return { status: "READY", binding, access, ...inspection };
  }

  const current = await pageAt(tab.id);
  if (!current || current.origin !== origin) return changed;
  const previous = readSelection(message.page);
  if (previous?.tabId !== current.tabId || previous.origin !== current.origin
    || (previous.documentId !== undefined && previous.documentId !== current.documentId)) return changed;

  return onSite(current.origin, async () => {
    const binding = await saved(current.origin);
    const access = await hasAccess(current.origin);
    const key = settingKey(current.origin);
    if (action === "disable" && binding) {
      await chrome.storage.session.remove(setupKey(current.tabId));
      const disabled = { ...binding, enabled: false };
      await chrome.storage.local.set({ [key]: disabled });
      const reply = await sendToPage(current, "detach");
      await withSitePages(current.origin, current, "detach");
      await register(current.origin, false);
      return { status: reply.status, page: current, binding: disabled, access };
    }
    if (action === "save" || action === "enable") {
      const draft = action === "save" ? readBinding(message.binding, current.origin) : binding && { ...binding, enabled: true };
      if (!draft || !draft.enabled) return { status: "INVALID_CONFIGURATION", binding, access };
      if (!access) return beginSetup(current, draft);
      await chrome.storage.session.remove(setupKey(current.tabId));
      const result = await saveBinding(current, draft);
      return { binding, access, ...result };
    }
    if (!access) return { status: "ACCESS_REQUIRED", binding, access };
    if ((action === "open" || action === "refresh") && binding?.enabled) {
      await register(current.origin, true);
      const reply = await sendToPage(current, action, binding);
      return { status: reply.status, page: current, binding, access };
    }
    return { status: "INVALID_CONFIGURATION", binding, access };
  });
}

function senderPage(sender: ExtensionSender) {
  if (sender.frameId !== 0 || sender.documentLifecycle !== "active") return null;
  const origin = webOrigin(sender.url);
  if (origin === null || sender.origin !== origin) return null;
  return readPage({ tabId: sender.tab?.id, documentId: sender.documentId, origin });
}

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  if (sender.id !== chrome.runtime.id || !message || typeof message !== "object" || Array.isArray(message)) return;
  const input = message as Record<string, unknown>;
  if (sender.url === popupUrl && sender.tab === undefined) {
    void fromPopup(input).then(reply, () => reply(unavailable));
    return true;
  }
  if (input.action === "setup-inspect" || input.action === "setup-finish") {
    void fromSetup(input, sender).then(reply, () => reply(unavailable));
    return true;
  }
  const page = senderPage(sender);
  if (input.action !== "attach" || !page) return;
  void onSite(page.origin, async () => {
    const binding = await saved(page.origin);
    if (!binding?.enabled || !await hasAccess(page.origin)) return unavailable;
    const top = await pageAt(page.tabId);
    if (top?.documentId !== page.documentId || top.origin !== page.origin) return changed;
    return sendToPage(page, "attach", binding);
  }).then(reply, () => reply(unavailable));
  return true;
});
