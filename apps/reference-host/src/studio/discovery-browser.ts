import { readFile } from "node:fs/promises";
import { openChromiumSession } from "@dap/browser-runtime";
import type { ChromiumSession } from "@dap/browser-runtime";
import { z } from "zod";
import { discoveryDom } from "./discovery-dom.js";
import type { DiscoveryAction } from "./discovery-dom.js";

const readerFile = new URL("../../../../deploy/widget/v1.3.0/ui-reader.js", import.meta.url);
export const discoveryPath = z.string().max(200).regex(/^\/[A-Za-z0-9._~/%-]*(?:#!?\/[A-Za-z0-9._~/%-]*)?$/u);
const label = z.string().max(120).regex(/^[^\p{Cc}\p{Cf}]*$/u);
const targetSchema = z.strictObject({
  page: discoveryPath,
  section: z.array(label.min(1)).max(5),
  role: z.enum(["button", "link", "textbox", "select", "checkbox", "radio", "tab", "menuitem"]),
  name: label,
  marker: z.string().regex(/^[A-Za-z][A-Za-z0-9.]{0,79}$/u).nullable(),
});
const points = z.object({ x: z.number(), y: z.number(), width: z.number().positive(), height: z.number().positive() });
const actionFocus = z.strictObject({ bounds: points, view: points });
const observationSchema = z.union([
  z.strictObject({ access: z.enum(["access-required", "unreadable"]) }),
  z.strictObject({
    page: discoveryPath, targets: z.array(targetSchema).max(64), truncated: z.boolean(),
    actions: z.array(z.strictObject({
      kind: z.enum(["link", "menu", "tab"]), target: targetSchema, href: discoveryPath.nullable(),
    })).max(64),
    expanded: z.array(z.string().regex(/^(?:[01]{2}|open|closed)$/u)).max(64),
  }),
]);
export type DiscoveryObservation = z.infer<typeof observationSchema>;

export type StudioInput = { revision: number } & (
  { kind: "click"; x: number; y: number } |
  { kind: "wheel"; x: number; y: number; deltaX: number; deltaY: number } |
  { kind: "key"; key: string } |
  { kind: "text"; text: string }
);
export type StudioFrame = { data: Buffer; width: number; height: number; revision: number };

export interface DiscoveryBrowser {
  observation: ChromiumSession["observation"];
  startLiveView(send: (frame: StudioFrame) => void): Promise<() => Promise<void>>;
  input(event: StudioInput): Promise<void>;
  finishPreparation(): Promise<void>;
  begin(): void;
  roleToken(path: string): Promise<string | null>;
  currentPath(): string;
  navigate(path: string): Promise<void>;
  observe(): Promise<DiscoveryObservation>;
  perform(action: DiscoveryAction): Promise<boolean>;
  close(): Promise<void>;
}

export async function openDiscoveryBrowser(origin: string, headed: boolean, interactive = false): Promise<DiscoveryBrowser> {
  const source = await readFile(readerFile, "utf8");
  const browser = await openChromiumSession({ headed, allowOrigin: url => url.origin === origin, readOnly: !headed && !interactive, diagnostics: !interactive });
  try {
    return await createSession(browser, origin, source, headed, interactive);
  } catch (error) {
    await browser.close();
    throw error;
  }
}

async function createSession(browser: ChromiumSession, origin: string, source: string, headed: boolean, interactive: boolean): Promise<DiscoveryBrowser> {
  const { page, context } = browser;
  let manual = interactive;
  let inputTask: Promise<void> | undefined;

  function applyInput(event: StudioInput): Promise<void> {
    browser.checkedUrl();
    if (!manual || event.revision !== browser.revision()) return Promise.resolve();
    switch (event.kind) {
      case "click": {
        const size = page.viewportSize();
        return size ? page.mouse.click(event.x * size.width, event.y * size.height) : Promise.resolve();
      }
      case "wheel": {
        const size = page.viewportSize();
        return size ? page.mouse.move(event.x * size.width, event.y * size.height)
          .then(() => {
            if (manual && event.revision === browser.revision()) {
              browser.checkedUrl();
              return page.mouse.wheel(event.deltaX, event.deltaY);
            }
            return undefined;
          }) : Promise.resolve();
      }
      case "key": return page.keyboard.press(event.key);
      case "text": return page.keyboard.insertText(event.text);
    }
  }
  function currentPath() {
    const url = new URL(browser.checkedUrl());
    return discoveryPath.parse(url.pathname + (/^#!?\//u.test(url.hash) ? url.hash : ""));
  }
  async function navigate(path: string) {
    const url = new URL(discoveryPath.parse(path), origin);
    if (url.origin !== origin) throw new Error("Invalid discovery path");
    const finish = browser.observation.track("Хуудас нээх", path, "Studio");
    try {
      await browser.navigate(url.href, true);
      currentPath();
      finish(true);
    } catch (error) { finish(false); throw error; }
  }
  async function onPage(action: DiscoveryAction | null): Promise<unknown> {
    currentPath();
    return page.evaluate(`(() => {
      ${source}
      return (${discoveryDom.toString()})(createUiReader(), ${JSON.stringify(origin)}, ${JSON.stringify(action)});
    })()`);
  }
  if (headed) await navigate("/");
  return {
    observation: browser.observation,
    async startLiveView(send) {
      if (!manual) throw new Error("Studio control is unavailable");
      const cast = await page.screencast.start({
        fps: 10, quality: 66,
        onFrame: frame => {
          if (!manual) return;
          try { browser.checkedUrl(); } catch { return; }
          send({ data: frame.data, width: frame.viewportWidth, height: frame.viewportHeight, revision: browser.revision() });
        },
      });
      return () => cast.dispose();
    },
    async input(event) {
      if (!manual || inputTask) return;
      inputTask = applyInput(event);
      try { await inputTask; } finally { inputTask = undefined; }
    },
    async finishPreparation() {
      manual = false;
      await inputTask?.catch(() => {});
      browser.restrictWrites();
    },
    begin() { browser.restrictWrites(); browser.observation.enableDiagnostics(); },
    async roleToken(path) {
      const url = new URL(path, origin);
      if (url.origin !== origin) return null;
      const response = await context.request.get(url.href, { maxRedirects: 0, timeout: 6_000 });
      try {
        const value = response.ok() ? await response.json() as { token?: unknown } : null;
        return typeof value?.token === "string" && value.token.length <= 1500 ? value.token : null;
      } finally { await response.dispose(); }
    },
    currentPath,
    navigate,
    async observe() {
      const finish = browser.observation.track("UI таних");
      try {
        const result = observationSchema.parse(await onPage(null));
        finish(!("access" in result));
        return result;
      } catch (error) { finish(false); throw error; }
    },
    async perform(action) {
      const before = page.url();
      const revision = browser.revision();
      const finish = browser.observation.track("Дарах", action.target.name, "Studio");
      try {
        const focus = actionFocus.safeParse(await onPage(action));
        if (focus.success) browser.observation.highlight(focus.data.bounds, focus.data.view, revision);
        finish(focus.success);
        return focus.success;
      } catch (error) {
        const navigated = page.url() !== before && new URL(page.url()).origin === origin;
        finish(navigated);
        if (navigated) return true;
        throw error;
      }
    },
    close() { manual = false; return browser.close(); },
  };
}
