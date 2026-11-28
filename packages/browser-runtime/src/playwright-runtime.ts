/// <reference lib="dom" />

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import type { CDPSession } from "playwright-core";
import { openChromiumSession } from "./chromium-session.js";
import type { ChromiumSession } from "./chromium-session.js";
import { BrowserRuntimeError } from "./errors.js";
import type { BrowserRuntimeErrorCode } from "./errors.js";
import type { ApprovedLabel, BrowserElement, BrowserRuntime, BrowserSnapshot, ElementFacts, ElementRef, UiSnapshot } from "./types.js";

const readerFile = new URL("../../../deploy/widget/v1.3.0/ui-reader.js", import.meta.url);
const anyPage = /^\/[A-Za-z0-9._~/-]*(?:#(?:!\/|\/?)[A-Za-z0-9._~/-]*)?$/u;
const reference = /^@e[1-9]\d{0,8}$/u;
const semanticId = (value: unknown) => typeof value === "string" && /^[A-Za-z][A-Za-z0-9.]{0,79}$/u.test(value) ? value : null;
const axRoles = new Set(["button", "link", "textbox", "searchbox", "checkbox", "radio", "switch", "combobox", "listbox",
  "slider", "spinbutton", "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "treeitem"]);
const inspectLimit = 64;
const commandTimeout = 5_000;

export interface BrowserRuntimeOptions {
  readonly monitorVisual?: boolean;
  readonly labels: readonly ApprovedLabel[] | "all";
  readonly routes: readonly string[] | "any";
  readonly origins: readonly string[];
  readonly observation?: { readonly route: string; readonly selector: string; readonly states: Readonly<Record<string, string>> };
}

interface AxNode {
  backendDOMNodeId?: number;
  ignored?: boolean;
  role?: { value?: unknown };
  name?: { value?: unknown };
  properties?: Array<{ name: string; value: { value?: unknown } }>;
}

interface Observation {
  snapshot: BrowserSnapshot;
  revision: string;
  backendIds: ReadonlyMap<ElementRef, number>;
}

function normalizedOrigins(input: readonly string[]): ReadonlySet<string> {
  if (!Array.isArray(input) || input.length < 1 || input.length > 5) throw new TypeError("origins must list between 1 and 5 origins");
  const origins = new Set<string>();
  for (const value of input as readonly unknown[]) {
    const url = typeof value === "string" && URL.canParse(value) ? new URL(value) : null;
    if (!url || url.origin !== value || !["http:", "https:"].includes(url.protocol) ||
        !/^(?:\[[0-9a-f:.]+\]|\d{1,3}(?:\.\d{1,3}){3}|[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*)$/u.test(url.hostname)) {
      throw new TypeError("origins must be normalized http or https origins");
    }
    if (origins.has(url.origin)) throw new TypeError("origins must be unique");
    origins.add(url.origin);
  }
  return origins;
}

function operable(nodes: readonly AxNode[], labels: readonly ApprovedLabel[] | "all") {
  const elements: BrowserElement[] = [];
  const backendIds = new Map<ElementRef, number>();
  const seen = new Set<number>();
  for (const node of nodes) {
    const role = node.role?.value;
    const name = node.name?.value;
    const id = node.backendDOMNodeId;
    if (node.ignored || !id || seen.has(id) || typeof role !== "string" || typeof name !== "string" ||
        node.properties?.some(property => ["disabled", "readonly"].includes(property.name) && property.value.value === true)) continue;
    const allowed = labels === "all"
      ? axRoles.has(role) && name.trim() && name.length <= 120 && !/[\p{Cc}\p{Cf}\u2028\u2029]/u.test(name)
      : labels.some(label => label.role === role && label.name === name);
    if (!allowed) continue;
    seen.add(id);
    const ref = `@e${elements.length + 1}` as const;
    elements.push(Object.freeze({ ref, role, name }));
    backendIds.set(ref, id);
    if (elements.length >= 512) break;
  }
  return { elements, backendIds };
}

// Invoked in Chromium on the node returned by the accessibility tree.
function readElement(this: Element, expectedUrl: string) {
  if (!(this instanceof Element) || !this.isConnected || this.ownerDocument.URL !== expectedUrl) return null;
  const type = this.getAttribute("type");
  const autocomplete = this.getAttribute("autocomplete");
  const style = this.ownerDocument.defaultView?.getComputedStyle(this);
  const ancestorsMatch = (element: Element, selector: string) => {
    let node: Element | null = element;
    while (node) {
      if (node.matches(selector)) return true;
      const tree = node.getRootNode();
      node = node.parentElement ?? (tree instanceof ShadowRoot ? tree.host : null);
    }
    return false;
  };
  const visible = Boolean(this.getClientRects().length) && style?.visibility === "visible" &&
    style.opacity !== "0" && !ancestorsMatch(this, "[hidden],[inert],[aria-hidden=true]");
  const facts: ElementFacts | null = (type?.length ?? 0) <= 40 && (autocomplete?.length ?? 0) <= 200
    ? {
      tagName: this.localName, inputType: type?.trim().toLowerCase() || null, autocomplete: autocomplete?.trim().toLowerCase() || null,
      dataAiPrivate: ancestorsMatch(this, "[data-ai-private]"), dataAiIgnore: ancestorsMatch(this, "[data-ai-ignore]"),
      dataAiRedact: ancestorsMatch(this, "[data-ai-redact]"),
    } : null;
  const { x, y, width, height } = this.getBoundingClientRect();
  return { facts, bounds: { x, y, width, height },
    view: { width: innerWidth, height: innerHeight, x: scrollX, y: scrollY }, marker: this.getAttribute("data-ai-id"), available: visible && !this.matches(":disabled,[readonly]") &&
    !ancestorsMatch(this, "[aria-disabled=true],[aria-readonly=true]") };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createPlaywrightRuntime(options: BrowserRuntimeOptions, open = openChromiumSession): BrowserRuntime {
  if (options.labels !== "all" && !Array.isArray(options.labels)) throw new TypeError("labels must be a list of labels or \"all\"");
  if (options.routes !== "any" && !Array.isArray(options.routes)) throw new TypeError("routes must be a list of routes or \"any\"");
  const labels = options.labels === "all" ? "all" : options.labels.map(label => ({ ...label }));
  const routes = options.routes === "any" ? "any" : new Set(options.routes);
  const origins = normalizedOrigins(options.origins);
  const trusted = options.observation;
  const states = new Map(Object.entries(trusted?.states ?? {}));
  let session: ChromiumSession | undefined;
  let cdp: CDPSession | undefined;
  let closed = false;
  let busy = false;
  let home = "";
  let latest: Observation | undefined;
  let highlightTimer: ReturnType<typeof setTimeout> | undefined;

  function approved(raw: string) {
    if (!URL.canParse(raw)) throw new BrowserRuntimeError("DOMAIN_BLOCKED");
    const url = new URL(raw);
    const route = url.pathname + url.hash;
    const authorized = routes === "any" ? route.length <= 200 && anyPage.test(route) : routes.has(route);
    if (!origins.has(url.origin) || url.username || url.password || !authorized || url.search) throw new BrowserRuntimeError("DOMAIN_BLOCKED");
    return url.origin + route;
  }
  function started() {
    if (closed || session?.page.isClosed()) throw new BrowserRuntimeError("SESSION_CLOSED");
    if (!session || !cdp) throw new BrowserRuntimeError("BROWSER_NOT_STARTED");
    return { browser: session, protocol: cdp };
  }
  async function close() {
    clearTimeout(highlightTimer);
    const browser = session;
    session = undefined;
    cdp = undefined;
    latest = undefined;
    closed = true;
    if (browser) await browser.close().catch(() => { throw new BrowserRuntimeError("CLOSE_FAILED"); });
  }
  async function exclusive<T>(operation: () => Promise<T>, error: BrowserRuntimeErrorCode, timeout = commandTimeout): Promise<T> {
    if (busy) throw new BrowserRuntimeError("BROWSER_BUSY");
    busy = true;
    let deadline: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([operation(), new Promise<never>((_, reject) => {
        deadline = setTimeout(() => {
          if (session) void close().catch(() => {});
          reject(new BrowserRuntimeError("BROWSER_TIMEOUT"));
        }, timeout);
      })]);
    } catch (cause) {
      if (cause instanceof BrowserRuntimeError) throw cause;
      throw new BrowserRuntimeError(session?.page.isClosed() ? "SESSION_CLOSED" : error);
    } finally { clearTimeout(deadline); busy = false; }
  }
  const currentUrl = () => approved(started().browser.checkedUrl());

  async function observe(): Promise<Observation> {
    const { browser, protocol } = started();
    const url = currentUrl();
    const actualUrl = browser.checkedUrl();
    const revision = browser.revision();
    const { frameTree } = await protocol.send("Page.getFrameTree");
    if (frameTree.frame.url + (frameTree.frame.urlFragment ?? "") !== actualUrl) throw new BrowserRuntimeError("REF_NOT_FOUND");
    const { nodes } = await protocol.send("Accessibility.getFullAXTree", { frameId: frameTree.frame.id });
    const { elements, backendIds } = operable(nodes, labels);
    let observation: string | undefined;
    if (trusted && url === home + trusted.route) {
      const value = await browser.page.locator(trusted.selector).first().textContent({ timeout: commandTimeout });
      observation = states.get(value?.trim() ?? "");
    }
    if (currentUrl() !== url || browser.revision() !== revision) throw new BrowserRuntimeError("REF_NOT_FOUND");
    // Accessibility values can affect staleness. Only the digest stays in memory.
    const fingerprint = createHash("sha256").update(JSON.stringify([url, revision, nodes, observation])).digest("hex");
    return { snapshot: Object.freeze({ url, elements: Object.freeze(elements), ...(observation === undefined ? {} : { observation }) }),
      revision: fingerprint, backendIds };
  }

  async function current(from: BrowserSnapshot, refs: readonly ElementRef[]) {
    if (latest?.snapshot !== from || refs.some(ref => !reference.test(ref) || !latest?.backendIds.has(ref))) {
      throw new BrowserRuntimeError("REF_NOT_FOUND");
    }
    if ((await observe()).revision !== latest.revision) throw new BrowserRuntimeError("REF_NOT_FOUND");
    return latest.backendIds;
  }

  async function facts(id: number, url: string): Promise<ReturnType<typeof readElement>> {
    const { browser, protocol } = started();
    const revision = browser.revision();
    const actualUrl = browser.checkedUrl();
    if (approved(actualUrl) !== url) throw new BrowserRuntimeError("REF_NOT_FOUND");
    const objectId = await protocol.send("DOM.resolveNode", { backendNodeId: id })
      .then(reply => reply.object.objectId, () => undefined);
    if (!objectId) return null;
    try {
      const reply = await protocol.send("Runtime.callFunctionOn", { objectId, functionDeclaration: readElement.toString(),
        arguments: [{ value: actualUrl }], returnByValue: true, silent: true }).catch(() => null);
      if (browser.revision() !== revision || currentUrl() !== url) throw new BrowserRuntimeError("REF_NOT_FOUND");
      return reply && !reply.exceptionDetails ? reply.result.value as ReturnType<typeof readElement> : null;
    } finally { await protocol.send("Runtime.releaseObject", { objectId }).catch(() => {}); }
  }

  async function hideHighlight() {
    clearTimeout(highlightTimer);
    if (session && cdp) await cdp.send("Overlay.hideHighlight");
  }

  async function inspectUi(): Promise<UiSnapshot> {
    const { browser } = started();
    const url = currentUrl();
    const actualUrl = browser.checkedUrl();
    const revision = browser.revision();
    const { pathname, hash } = new URL(url);
    const page = pathname + (/^#!?\//u.test(hash) ? hash : "");
    const source = await readFile(readerFile, "utf8");
    const result: unknown = await browser.page.evaluate(`(() => {
      if (window !== top || location.href !== ${JSON.stringify(actualUrl)}) return null;
      ${source}
      return createUiReader().snapshot();
    })()`);
    if (currentUrl() !== url || browser.revision() !== revision || !isRecord(result) || result.page !== page ||
        typeof result.truncated !== "boolean" || !Array.isArray(result.targets) || result.targets.length > inspectLimit) {
      throw new BrowserRuntimeError("INVALID_BROWSER_OUTPUT");
    }
    const label = (value: unknown): value is string => typeof value === "string" && value.length <= 120 && !/[\p{Cc}\p{Cf}]/u.test(value);
    const roles = new Set(["button", "link", "textbox", "select", "checkbox", "radio", "tab", "menuitem"]);
    const targets = (result.targets as unknown[]).map(target => {
      if (!isRecord(target) || target.page !== page || !Array.isArray(target.section) || target.section.length > 5 ||
          !target.section.every(item => label(item) && item.length > 0) || typeof target.role !== "string" || !roles.has(target.role) ||
          !label(target.name) || (target.marker !== null && !semanticId(target.marker)) || (!target.name && target.marker === null)) {
        throw new BrowserRuntimeError("INVALID_BROWSER_OUTPUT");
      }
      return { page, role: target.role, name: target.name, section: target.section as string[], marker: semanticId(target.marker) };
    });
    return { page, targets, truncated: result.truncated };
  }


  return {
    start: options => exclusive(async () => {
      if (closed) throw new BrowserRuntimeError("SESSION_CLOSED");
      if (session) throw new BrowserRuntimeError("BROWSER_BUSY");
      const url = approved(options.url);
      home = new URL(url).origin;
      try {
        const displayAvailable = process.platform !== "linux" || Boolean(process.env.DISPLAY || process.env.WAYLAND_DISPLAY);
        session = await open({ headed: Boolean(options.headed && displayAvailable), allowOrigin: target => origins.has(target.origin) });
        await session.navigate(url);
        approved(session.checkedUrl());
        cdp = await session.context.newCDPSession(session.page);
        await cdp.send("Accessibility.enable");
        await cdp.send("DOM.enable");
        await cdp.send("Overlay.enable");
      } catch (error) { await close().catch(() => {}); throw error; }
    }, "NAVIGATION_FAILED", 24_000),
    snapshot: () => exclusive(async () => {
      latest = undefined;
      latest = await observe();
      return latest.snapshot;
    }, "SNAPSHOT_FAILED"),
    inspectUi: () => exclusive(inspectUi, "SNAPSHOT_FAILED"),
    inspectDom: cursor => exclusive(() => {
      currentUrl();
      return started().browser.observation.dom(cursor);
    }, "SNAPSHOT_FAILED"),
    observation: () => {
      currentUrl();
      return started().browser.observation;
    },
    inspectSemanticId: (ref, from) => exclusive(async () => {
      const ids = await current(from, [ref]);
      return semanticId((await facts(ids.get(ref)!, from.url))?.marker);
    }, "REF_NOT_FOUND"),
    inspectSemanticIds: from => exclusive(async () => {
      const refs = from.elements.slice(0, inspectLimit).map(element => element.ref);
      const ids = await current(from, refs);
      const result = await Promise.all(refs.map(async ref => [ref, semanticId((await facts(ids.get(ref)!, from.url))?.marker)] as const));
      return new Map(result);
    }, "REF_NOT_FOUND"),
    inspectElementFacts: (refs, from) => exclusive(async () => {
      if (!Array.isArray(refs) || refs.length > inspectLimit) throw new BrowserRuntimeError("REF_NOT_FOUND");
      const ids = await current(from, refs);
      const result = await Promise.all([...new Set(refs)].map(async ref => [ref, (await facts(ids.get(ref)!, from.url))?.facts ?? null] as const));
      return new Map(result);
    }, "REF_NOT_FOUND"),
    highlight: (ref, from) => exclusive(async () => {
      const { protocol } = started();
      const ids = await current(from, [ref]);
      const backendNodeId = ids.get(ref)!;
      const control = await facts(backendNodeId, from.url);
      if (!control?.available || !control.facts || control.facts.dataAiIgnore || control.facts.dataAiPrivate || control.facts.dataAiRedact) {
        throw new BrowserRuntimeError("REF_NOT_FOUND");
      }
      await hideHighlight();
      await protocol.send("DOM.scrollIntoViewIfNeeded", { backendNodeId });
      if (currentUrl() !== from.url) throw new BrowserRuntimeError("REF_NOT_FOUND");
      await protocol.send("Overlay.highlightNode", { backendNodeId, highlightConfig: { borderColor: { r: 0, g: 139, b: 139, a: 1 },
        contentColor: { r: 0, g: 139, b: 139, a: 0.12 }, showInfo: false } });
      if (options.monitorVisual) {
        const { browser } = started();
        const version = browser.revision();
        const current = await facts(backendNodeId, from.url);
        if (current?.bounds && current.view) browser.observation.highlight(current.bounds, current.view, version);
      }
      highlightTimer = setTimeout(() => { void hideHighlight().catch(() => {}); }, 3_000);
      highlightTimer.unref();
    }, "HIGHLIGHT_FAILED"),
    clearHighlight: () => exclusive(async () => { started(); await hideHighlight(); }, "HIGHLIGHT_FAILED"),
    getUrl: () => exclusive(async () => currentUrl(), "NAVIGATION_FAILED"),
    waitForChange: (options) => {
      const supplied = options?.timeoutMs;
      const timeout = typeof supplied === "number" && Number.isFinite(supplied) ? Math.min(60_000, Math.max(0, supplied)) : 30_000;
      return exclusive(async () => {
        started();
        if (timeout === 0) return { status: "timeout" };
        const deadline = performance.now() + timeout;
        const baseline = latest ?? await observe();
        while (performance.now() < deadline) {
          latest = await observe();
          if (latest.revision !== baseline.revision) return { status: "changed", snapshot: latest.snapshot };
          await sleep(Math.max(0, Math.min(250, deadline - performance.now())));
        }
        return { status: "timeout" };
      }, "SNAPSHOT_FAILED", timeout + commandTimeout);
    },
    close: () => exclusive(close, "CLOSE_FAILED"),
  };
}
