import { access, readFile, readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import type { Browser, Page } from "playwright-core";
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

export interface DiscoveryBrowser {
  begin(): void;
  roleToken(path: string): Promise<string | null>;
  currentPath(): string;
  navigate(path: string): Promise<void>;
  observe(): Promise<DiscoveryObservation>;
  perform(action: DiscoveryAction): Promise<boolean>;
  close(): Promise<void>;
}

async function executablePath(): Promise<string | undefined> {
  if (process.env.DAP_STUDIO_CHROME_PATH) return process.env.DAP_STUDIO_CHROME_PATH;
  const installed = join(homedir(), ".agent-browser", "browsers");
  const versions = await readdir(installed).catch(() => []);
  const candidates = [chromium.executablePath(), "/usr/bin/chromium", "/usr/bin/google-chrome",
    ...versions.filter(version => /^chrome-[\d.]+$/u.test(version)).sort().reverse().map(version => join(installed, version, "chrome"))];
  for (const path of candidates) {
    if (await access(path).then(() => true, () => false)) return path;
  }
  return undefined;
}

export async function openDiscoveryBrowser(origin: string, headed: boolean): Promise<DiscoveryBrowser> {
  const source = await readFile(readerFile, "utf8");
  const executable = await executablePath();
  const env = Object.fromEntries(["PATH", "HOME", "USER", "LOGNAME", "LANG", "DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "XAUTHORITY"]
    .flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]]]));
  const browser = await chromium.launch({ headless: !headed, env, timeout: 15_000, ...(executable ? { executablePath: executable } : {}) });
  try {
    return await createSession(browser, origin, source, headed);
  } catch (error) {
    await browser.close();
    throw error;
  }
}

async function createSession(browser: Browser, origin: string, source: string, headed: boolean): Promise<DiscoveryBrowser> {
  const context = await browser.newContext({ acceptDownloads: false, serviceWorkers: "block" });
  const page = await context.newPage();
  let scanning = !headed;
  await context.route("**/*", async route => {
    const request = route.request();
    const isDocument = request.isNavigationRequest();
    const safeMethod = ["GET", "HEAD", "OPTIONS"].includes(request.method());
    if ((isDocument && new URL(request.url()).origin !== origin) || (scanning && !safeMethod)) await route.abort();
    else await route.continue();
  });
  context.on("page", popup => { void popup.close().catch(() => {}); });
  page.setDefaultTimeout(6_000);
  function currentPath() {
    const url = new URL(page.url());
    if (url.origin !== origin) throw new Error("Discovery browser left the configured origin");
    return discoveryPath.parse(url.pathname + (/^#!?\//u.test(url.hash) ? url.hash : ""));
  }
  async function navigate(path: string) {
    const url = new URL(discoveryPath.parse(path), origin);
    if (url.origin !== origin) throw new Error("Invalid discovery path");
    const response = await page.goto(url.href, { waitUntil: "domcontentloaded" });
    if (!response) await page.reload({ waitUntil: "domcontentloaded" });
    currentPath();
  }
  async function onPage(action: DiscoveryAction | null): Promise<unknown> {
    currentPath();
    return runReader(page, source, origin, action);
  }
  if (headed) await navigate("/");
  return {
    begin() { scanning = true; },
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
    async observe() { return observationSchema.parse(await onPage(null)); },
    async perform(action) {
      const before = page.url();
      try { return await onPage(action) === true; }
      catch (error) {
        if (page.url() !== before && new URL(page.url()).origin === origin) return true;
        throw error;
      }
    },
    close() { return browser.close(); },
  };
}

function runReader(page: Page, source: string, origin: string, action: DiscoveryAction | null) {
  return page.evaluate(`(() => {
    ${source}
    return (${discoveryDom.toString()})(createUiReader(), ${JSON.stringify(origin)}, ${JSON.stringify(action)});
  })()`);
}
