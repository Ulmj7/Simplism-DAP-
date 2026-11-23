import { afterEach, expect, it, vi } from "vitest";
import { settingKey, sitePattern, STATUS_REQUEST } from "./site.js";

const origin = "http://127.0.0.1:5187";
const otherOrigin = "http://127.0.0.1:5188";
const apiOrigin = "http://127.0.0.1:8795";
const binding = { origin, applicationId: "app-000000000001", runtimeKey: "rk-portal", apiOrigin, enabled: true };
const page = { origin, tabId: 1, documentId: "original" };

async function worker(initialAccess = true) {
  const settings: Record<string, unknown> = {};
  const documents: Record<string, unknown> = {};
  const other = { id: 2, url: otherOrigin + "/profile" };
  const active = { id: 1, url: origin + "/profile" };
  const extensionUrl = (path: string) => "chrome-extension://simplism/" + path;
  const popup = extensionUrl("popup.html");
  const registration: string[] = [];
  let documentId = page.documentId;
  let verified = true;
  let access = initialAccess;
  let popupOpen = true;
  let setupUrl: string | undefined;
  let navigateDuringVerification = false;
  let runtime: unknown = { state: "READY", count: 2 };
  let listener: ((message: unknown, sender: ExtensionSender, reply: (result: unknown) => void) => boolean | void) | undefined;
  const extension = {
    runtime: { id: "simplism", getURL: extensionUrl, onMessage: { addListener(fn: typeof listener) { listener = fn; } } },
    storage: { local: {
      setAccessLevel: vi.fn(async () => undefined),
      get: vi.fn(async (key: string) => ({ [key]: settings[key] })),
      set: vi.fn(async (pairs: Record<string, unknown>) => { Object.assign(settings, pairs); }),
    }, session: {
      get: vi.fn(async (key: string) => ({ [key]: documents[key] })),
      set: vi.fn(async (pairs: Record<string, unknown>) => { Object.assign(documents, pairs); }),
      remove: vi.fn(async (key: string) => { delete documents[key]; }),
    } },
    tabs: {
      query: vi.fn(async (query: { active?: boolean }) => query.active ? [active] : [active, other]),
      get: vi.fn(async (tabId: number) => { if (tabId !== active.id) throw new Error("Missing tab"); return active; }),
      create: vi.fn(async ({ url }: { url: string }) => { setupUrl = url; popupOpen = false; return { id: 3, url }; }),
      onRemoved: { addListener: vi.fn() },
      sendMessage: vi.fn(async (_tabId: number, _message: unknown, target: { documentId: string }) => {
        if (target.documentId !== documentId) throw new Error("Document changed");
        return runtime;
      }),
    },
    permissions: { contains: vi.fn(async ({ origins }: { origins: string[] }) => access && origins[0] === sitePattern(origin)) },
    scripting: {
      executeScript: vi.fn(async (script: { target: ExtensionTarget; world?: "MAIN"; files?: string[]; args?: string[] }) => {
        const top = { documentId, frameId: 0 };
        if (script.files) return [top];
        if (!script.world) return [{ ...top, result: origin }];
        const action = script.args?.[0];
        if (action === "verify" && navigateDuringVerification) documentId = "replacement";
        const status = action === "verify" ? verified ? "VERIFIED" : "APPLICATION_UNAVAILABLE" : action === "detach" ? "DETACHED" : "READY";
        return [{ ...top, result: { status, css: status === "READY" } }];
      }),
      insertCSS: vi.fn(async () => undefined),
      removeCSS: vi.fn(async () => undefined),
      getRegisteredContentScripts: vi.fn(async () => registration),
      registerContentScripts: vi.fn(async () => { registration.push("saved"); }),
      unregisterContentScripts: vi.fn(async () => { registration.length = 0; }),
    },
  };
  vi.stubGlobal("chrome", extension);
  vi.resetModules();
  await import("./background.js");
  function send(message: unknown, sender: ExtensionSender) {
    return new Promise(resolve => {
      if (listener?.(message, { id: "simplism", ...sender }, resolve) !== true) resolve(undefined);
    });
  }
  return { extension, settings, send, rejectBinding() { verified = false; }, navigate() { documentId = "replacement"; }, status(value: unknown) { runtime = value; },
    grant() { access = true; },
    revoke() { access = false; },
    navigateOnVerify() { navigateDuringVerification = true; },
    popup: (action: string, draft = binding) => {
      if (!popupOpen) throw new Error("Popup was destroyed");
      return send({ action, page, binding: draft }, { url: popup });
    },
    setup: (action: string, granted?: boolean) => {
      if (!setupUrl) throw new Error("Setup tab was not opened");
      const params = new URL(setupUrl).searchParams;
      return send({ action, granted, tabId: Number(params.get("tab")), id: params.get("id") },
        { url: setupUrl, tab: { id: 3 }, frameId: 0, documentLifecycle: "active" });
    },
  };
}

afterEach(() => { vi.unstubAllGlobals(); });

it("registers one exact site after a public verification and uses the pinned document for MAIN and CSS", async () => {
  const { extension, settings, popup } = await worker();
  const css = { target: { tabId: 1, documentIds: [page.documentId] }, files: ["simplism.css"] };
  expect(await popup("inspect")).toMatchObject({ page: { tabId: 1, origin }, binding: null, access: true, runtime: null });
  expect(extension.scripting.executeScript).not.toHaveBeenCalled();
  expect(await popup("save")).toMatchObject({ status: "READY", binding });
  expect(settings).toEqual({ [settingKey(origin)]: binding });
  expect(extension.scripting.registerContentScripts).toHaveBeenCalledOnce();
  expect(extension.scripting.registerContentScripts).toHaveBeenCalledWith([expect.objectContaining({
    matches: [sitePattern(origin)], allFrames: false, persistAcrossSessions: true, js: ["content.js"],
  })]);
  expect(extension.scripting.executeScript).toHaveBeenCalledWith(expect.objectContaining({ world: "MAIN", target: css.target, args: ["verify", origin, binding] }));
  expect(extension.scripting.insertCSS).toHaveBeenCalledExactlyOnceWith(css);
  expect(await popup("disable")).toMatchObject({ status: "DETACHED", binding: { enabled: false } });
  expect(extension.scripting.unregisterContentScripts).toHaveBeenCalledOnce();
  expect(extension.scripting.removeCSS).toHaveBeenCalledTimes(2);
  expect(extension.scripting.removeCSS).toHaveBeenLastCalledWith(css);
  expect(await popup("enable")).toMatchObject({ status: "READY", binding });
  expect(extension.scripting.registerContentScripts).toHaveBeenCalledTimes(2);
  expect(extension.scripting.executeScript.mock.calls.some(([script]) => script.target.tabId === 2)).toBe(false);
});

it("reads only the pinned document's closed cached status when the popup reopens", async () => {
  const { extension, popup, status, navigate } = await worker();
  await popup("save");
  vi.clearAllMocks();
  expect(await popup("inspect")).toEqual({ status: "READY", page, binding, access: true, runtime: { state: "READY", count: 2 } });
  expect(extension.tabs.sendMessage).toHaveBeenCalledExactlyOnceWith(1, STATUS_REQUEST, { documentId: "original" });
  status({ state: "RUNNING", count: 2 });
  expect(await popup("inspect")).toMatchObject({ runtime: { state: "RUNNING", count: 2 } });
  status({ state: "ERROR", count: 1, message: "Extra detail" });
  expect(await popup("inspect")).toMatchObject({ runtime: null });
  navigate();
  expect(await popup("inspect")).toMatchObject({ runtime: null });
  expect(extension.scripting.executeScript).not.toHaveBeenCalled();
  expect(extension.scripting.registerContentScripts).not.toHaveBeenCalled();
  expect(extension.scripting.insertCSS).not.toHaveBeenCalled();
  expect(extension.scripting.removeCSS).not.toHaveBeenCalled();
  expect(extension.storage.local.set).not.toHaveBeenCalled();
  expect(extension.storage.session.set).not.toHaveBeenCalled();
});

it("keeps the saved configuration when validation fails or the popup's document has changed", async () => {
  const { extension, settings, popup, rejectBinding, navigate } = await worker();
  expect(await popup("save")).toMatchObject({ status: "READY" });
  rejectBinding();
  expect(await popup("save", { ...binding, applicationId: "app-000000000002" })).toMatchObject({ status: "APPLICATION_UNAVAILABLE", binding });
  navigate();
  expect(await popup("open")).toEqual({ status: "SITE_CHANGED" });
  expect(settings).toEqual({ [settingKey(origin)]: binding });
  expect(extension.scripting.registerContentScripts).toHaveBeenCalledOnce();
  expect(extension.scripting.insertCSS).toHaveBeenCalledOnce();
});

it("attaches a saved binding to a newly registered active top-level document", async () => {
  const { extension, popup, send, navigate } = await worker();
  await popup("save");
  navigate();
  const sender = {
    url: origin + "/profile", origin, documentLifecycle: "active", frameId: 0, documentId: "replacement", tab: { id: 1 },
  };
  expect(await send({ action: "attach" }, sender)).toMatchObject({ status: "READY" });
  expect(extension.scripting.insertCSS).toHaveBeenLastCalledWith({ files: ["simplism.css"], target: { tabId: 1, documentIds: ["replacement"] } });
});

it("saves on the first grant after the originating popup disappears", async () => {
  const { extension, settings, popup, setup, grant } = await worker(false);
  expect(await popup("save")).toEqual({ status: "SETUP_OPENED" });
  expect(() => popup("inspect")).toThrow("Popup was destroyed");
  expect(settings).toEqual({});
  expect(await setup("setup-inspect")).toEqual({ status: "READY", origin });
  grant();
  expect(await setup("setup-finish", true)).toMatchObject({ status: "READY", binding, page });
  expect(settings).toEqual({ [settingKey(origin)]: binding });
  expect(extension.scripting.registerContentScripts).toHaveBeenCalledOnce();
  expect(await setup("setup-finish", true)).toEqual({ status: "SITE_CHANGED" });
});

it("consumes a denied setup without enabling it even if access is granted later", async () => {
  const { extension, settings, popup, setup, grant } = await worker(false);
  await popup("save");
  expect(await setup("setup-finish", false)).toEqual({ status: "ACCESS_REQUIRED" });
  grant();
  expect(await setup("setup-finish", true)).toEqual({ status: "SITE_CHANGED" });
  expect(settings).toEqual({});
  expect(extension.scripting.registerContentScripts).not.toHaveBeenCalled();
});

it("uses the saved binding when re-enabling after Chrome access was revoked", async () => {
  const { settings, popup, setup, grant, revoke } = await worker();
  await popup("save");
  await popup("disable");
  revoke();
  expect(await popup("enable")).toEqual({ status: "SETUP_OPENED" });
  expect(settings).toEqual({ [settingKey(origin)]: { ...binding, enabled: false } });
  grant();
  expect(await setup("setup-finish", true)).toMatchObject({ status: "READY", binding });
  expect(settings).toEqual({ [settingKey(origin)]: binding });
});

it.each(["before completion", "during verification"])("rejects same-origin navigation %s after setup is opened", async when => {
  const { extension, settings, popup, setup, grant, navigate, navigateOnVerify } = await worker(false);
  await popup("save");
  expect(await setup("setup-inspect")).toMatchObject({ status: "READY" });
  grant();
  if (when === "before completion") navigate(); else navigateOnVerify();
  expect(await setup("setup-finish", true)).toEqual({ status: "SITE_CHANGED" });
  expect(settings).toEqual({});
  expect(extension.scripting.registerContentScripts).not.toHaveBeenCalled();
});
