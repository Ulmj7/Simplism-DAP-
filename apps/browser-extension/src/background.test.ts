import { afterEach, expect, it, vi } from "vitest";
import { settingKey, sitePattern } from "./site.js";

const origin = "http://127.0.0.1:5187";
const otherOrigin = "http://127.0.0.1:5188";
const apiOrigin = "http://127.0.0.1:8795";
const binding = { origin, applicationId: "app-000000000001", runtimeKey: "rk-portal", apiOrigin, enabled: true };
const page = { origin, tabId: 1, documentId: "original" };

async function worker() {
  const settings: Record<string, unknown> = {};
  const other = { id: 2, url: otherOrigin + "/profile" };
  const active = { id: 1, url: origin + "/profile" };
  const popup = "chrome-extension://simplism/popup.html";
  const registration: string[] = [];
  let documentId = page.documentId;
  let verified = true;
  let listener: ((message: unknown, sender: ExtensionSender, reply: (result: unknown) => void) => boolean | void) | undefined;
  const extension = {
    runtime: { id: "simplism", getURL: () => popup, onMessage: { addListener(fn: typeof listener) { listener = fn; } } },
    storage: { local: {
      setAccessLevel: vi.fn(async () => undefined),
      get: vi.fn(async (key: string) => ({ [key]: settings[key] })),
      set: vi.fn(async (pairs: Record<string, unknown>) => { Object.assign(settings, pairs); }),
    } },
    tabs: { query: vi.fn(async (query: { active?: boolean }) => query.active ? [active] : [active, other]) },
    permissions: { contains: vi.fn(async ({ origins }: { origins: string[] }) => origins[0] === sitePattern(origin)) },
    scripting: {
      executeScript: vi.fn(async (script: { target: ExtensionTarget; world?: "MAIN"; files?: string[]; args?: string[] }) => {
        const top = { documentId, frameId: 0 };
        if (!script.world) return [{ ...top, result: origin }];
        if (script.files) return [top];
        const action = script.args?.[0];
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
  return { extension, settings, send, rejectBinding() { verified = false; }, navigate() { documentId = "replacement"; },
    popup: (action: string, draft = binding) => send({ action, page, binding: draft }, { url: popup }) };
}

afterEach(() => { vi.unstubAllGlobals(); });

it("registers one exact site after a public verification and uses the pinned document for MAIN and CSS", async () => {
  const { extension, settings, popup } = await worker();
  const css = { target: { tabId: 1, documentIds: [page.documentId] }, files: ["simplism.css"] };
  expect(await popup("inspect")).toMatchObject({ page, binding: null, access: true });
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
  expect(extension.scripting.removeCSS).toHaveBeenLastCalledWith(css);
  expect(await popup("enable")).toMatchObject({ status: "READY", binding });
  expect(extension.scripting.registerContentScripts).toHaveBeenCalledTimes(2);
  expect(extension.scripting.executeScript.mock.calls.some(([script]) => script.target.tabId === 2)).toBe(false);
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
