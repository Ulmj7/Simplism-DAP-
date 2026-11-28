import { access } from "node:fs/promises";
import { chromium } from "playwright-core";
import { observeBrowser } from "./browser-observation.js";
import { BrowserRuntimeError } from "./errors.js";

interface SessionOptions {
  readonly headed: boolean;
  readonly allowOrigin: (url: URL) => boolean;
  readonly readOnly?: boolean;
  readonly diagnostics?: boolean;
}

async function executablePath(): Promise<string | undefined> {
  if (process.env.DAP_STUDIO_CHROME_PATH) return process.env.DAP_STUDIO_CHROME_PATH;
  for (const path of [chromium.executablePath(), "/usr/bin/chromium", "/usr/bin/google-chrome"]) {
    if (await access(path).then(() => true, () => false)) return path;
  }
  return undefined;
}

export async function openChromiumSession(options: SessionOptions) {
  const executable = await executablePath();
  const env = Object.fromEntries(["PATH", "HOME", "USER", "LOGNAME", "LANG", "DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "XAUTHORITY"]
    .flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]]]));
  const browser = await chromium.launch({ headless: !options.headed, env, timeout: 15_000,
    ...(executable ? { executablePath: executable } : {}) });
  try {
    const context = await browser.newContext({ acceptDownloads: false, serviceWorkers: "block" });
    const page = await context.newPage();
    let readOnly = options.readOnly ?? false;
    let blockedNavigation = false;
    let revision = 0;
    function allowed(raw: string) {
      if (!URL.canParse(raw)) return false;
      const url = new URL(raw);
      return (url.protocol === "http:" || url.protocol === "https:") &&
        !url.username && !url.password && options.allowOrigin(url);
    }
    await context.route("**/*", async route => {
      const request = route.request();
      if (request.isNavigationRequest() && !allowed(request.url())) {
        let main = true;
        try { main = request.frame() === page.mainFrame(); } catch { /* Early requests may lack a frame. */ }
        if (main) blockedNavigation = true;
        await route.abort();
      } else if (readOnly && !["GET", "HEAD", "OPTIONS"].includes(request.method())) {
        await route.abort();
      } else {
        await route.continue();
      }
    });
    context.on("page", popup => { if (popup !== page) void popup.close().catch(() => {}); });
    page.on("framenavigated", frame => {
      revision++;
      if (frame === page.mainFrame() && allowed(frame.url())) blockedNavigation = false;
    });
    page.on("framedetached", () => { revision++; });
    page.setDefaultTimeout(6_000);
    function checkedUrl() {
      if (page.isClosed()) throw new BrowserRuntimeError("SESSION_CLOSED");
      if (blockedNavigation || !allowed(page.url())) throw new BrowserRuntimeError("DOMAIN_BLOCKED");
      return page.url();
    }
    return {
      page, context, checkedUrl, observation: observeBrowser(page, checkedUrl, () => revision, allowed, options.diagnostics),
      revision: () => revision,
      restrictWrites() { readOnly = true; },
      async navigate(url: string, reloadOnSameDocument = false) {
        if (!allowed(url)) throw new BrowserRuntimeError("DOMAIN_BLOCKED");
        blockedNavigation = false;
        try {
          const response = await page.goto(url, { waitUntil: "domcontentloaded" });
          if (!response && reloadOnSameDocument) await page.reload({ waitUntil: "domcontentloaded" });
          checkedUrl();
        } catch (error) {
          if (blockedNavigation) throw new BrowserRuntimeError("DOMAIN_BLOCKED");
          throw error;
        }
      },
      close: () => browser.close(),
    };
  } catch (error) {
    await browser.close().catch(() => {});
    throw error;
  }
}

export type ChromiumSession = Awaited<ReturnType<typeof openChromiumSession>>;
