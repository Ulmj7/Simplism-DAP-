import { readFile } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import type { Page, Request } from "playwright-core";
import { DOM_BATCH_SIZE, readDomTree } from "./dom-tree.js";
import { BrowserRuntimeError } from "./errors.js";
import type { BrowserBounds, BrowserEvent, BrowserObservation, DomPage, DomView } from "./types.js";

const reader = new URL("../../../deploy/widget/v1.3.0/ui-reader.js", import.meta.url);
const conceal = "[data-ai-private],[data-ai-ignore],[data-ai-redact],input,textarea,select,[contenteditable],iframe,frame,canvas,video";
const confidential = /(?:bearer|password|passcode|credential|secret|authorization|cookie|token|api[-_ ]?key|нууц\s*үг|[\w.+-]+@[\w.-]+\.[a-z]{2,}|\d[\d ()-]{7,}\d|[a-z\d_+=-]{24,})/iu;

export function diagnosticLabel(value: string) {
  const clean = value.replace(/[\p{Cc}\p{Cf}]/gu, " ").slice(0, 160);
  return confidential.test(value) ? undefined : clean;
}

function safeUrl(raw: string) {
  if (!URL.canParse(raw)) return undefined;
  const url = new URL(raw);
  if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
  const fragment = /^#!?\//u.test(url.hash) ? url.hash.split("?")[0] : "";
  return url.origin + (diagnosticLabel(url.pathname + fragment) ?? "/…");
}

export function observeBrowser(page: Page, checkedUrl: () => string, revision: () => number, allowed: (raw: string) => boolean,
  diagnostics = true): BrowserObservation & { enableDiagnostics(): void } {
  const events: BrowserEvent[] = [];
  const requests = new WeakMap<Request, { started: number; actionId?: number | undefined; status?: number | undefined }>();
  let sequence = 0;
  const actions: number[] = [];
  const active = () => actions.at(-1);
  let highlight: { bounds: BrowserBounds; view: DomView; until: number } | undefined;
  function add(entry: Omit<BrowserEvent, "id" | "at">) {
    const event: BrowserEvent = { ...entry, id: ++sequence, at: Date.now() };
    events.push(event);
    if (events.length > 200) events.shift();
    return event;
  }
  function consoleEvent(action: string, message: string) {
    if (diagnostics && allowed(page.url())) add({ channel: "console", source: "Browser", action, detail: diagnosticLabel(message) ?? "Агуулга далд", related: active() });
  }
  page.on("console", message => {
    if (message.type() === "warning" || message.type() === "error") consoleEvent(message.type(), message.text());
  });
  page.on("pageerror", error => consoleEvent("error", error.message));
  page.on("request", request => {
    if (diagnostics) requests.set(request, { started: Date.now(), actionId: active() });
  });
  page.on("response", response => {
    const pending = requests.get(response.request());
    if (pending) pending.status = response.status();
  });
  function finish(request: Request, failed: boolean) {
    const pending = requests.get(request);
    const detail = safeUrl(request.url());
    if (!pending || !detail || !(allowed(page.url()) || allowed(request.url()))) return;
    add({ channel: "network", source: "Browser", action: request.method(), detail, status: pending.status,
      outcome: failed || (pending.status ?? 0) >= 400 ? "failed" : "success",
      durationMs: Date.now() - pending.started, related: pending.actionId });
  }
  page.on("requestfinished", request => finish(request, false));
  page.on("requestfailed", request => finish(request, true));
  page.on("framenavigated", frame => {
    if (diagnostics && frame === page.mainFrame() && allowed(frame.url())) {
      add({ channel: "activity", source: active() === undefined ? "Хэрэглэгч" : "Browser",
        action: "Хуудас нээсэн", detail: safeUrl(frame.url()), related: active(), outcome: "success" });
    }
  });

  function track(action: string, target?: string | undefined, source: BrowserEvent["source"] = "Studio") {
    if (!diagnostics) return () => {};
    const event = add({ channel: "activity", source, action, target: target ? diagnosticLabel(target) : undefined, outcome: "running" });
    actions.push(event.id);
    return (ok: boolean) => {
      add({ channel: "activity", source, action, target: event.target, related: event.id, outcome: ok ? "success" : "failed", durationMs: Date.now() - event.at });
      const index = actions.indexOf(event.id);
      if (index !== -1) actions.splice(index, 1);
    };
  }

  function captureContext() {
    const url = checkedUrl();
    const version = revision();
    return { url, version, verify: () => {
      if (checkedUrl() !== url || revision() !== version) throw new BrowserRuntimeError("REF_NOT_FOUND");
    } };
  }

  let dom: { view: DomView; nodes: DomPage["nodes"]; truncated: boolean; cursor: string | null; offset: number; url: string } | undefined;
  return {
    enableDiagnostics() { diagnostics = true; },
    track,
    highlight(bounds, view, version) {
      if (version !== revision()) return;
      highlight = { bounds, view: { ...view, revision: version }, until: Date.now() + 3_000 };
    },
    summary(after: number) {
      let url;
      try { url = safeUrl(checkedUrl()); } catch { /* The current page is unavailable. */ }
      return { url, revision: revision(),
        highlight: highlight?.view.revision === revision() && highlight.until > Date.now()
          ? { bounds: highlight.bounds, view: highlight.view } : undefined,
        events: events.filter(event => event.id > after), lastEvent: sequence };
    },
    async dom(cursor?: string): Promise<DomPage> {
      const state = captureContext();
      if (cursor === undefined) {
        const end = track("DOM уншсан");
        try {
          const source = await readFile(reader, "utf8");
          const result = await page.evaluate(`(() => {
            ${source}
            return (${readDomTree.toString()})(${JSON.stringify(state.url)}, createUiReader());
          })()`) as ReturnType<typeof readDomTree>;
          state.verify();
          if (!result) throw new BrowserRuntimeError("REF_NOT_FOUND");
          const nodes = result.nodes.map(({ target, ...node }) => target
            ? { ...node, targetDigest: createHash("sha256").update(JSON.stringify([target.page, target.section, target.role, target.name, target.marker])).digest("hex") }
            : node);
          dom = { ...result, nodes, view: { ...result.view, revision: state.version }, url: state.url, offset: 0, cursor: null };
          end(true);
        } catch (error) { end(false); throw error; }
      } else if (!dom || dom.cursor !== cursor || dom.url !== state.url || dom.view.revision !== state.version) {
        throw new BrowserRuntimeError("REF_NOT_FOUND");
      }
      const snapshot = dom!;
      const nodes = snapshot.nodes.slice(snapshot.offset, snapshot.offset + DOM_BATCH_SIZE);
      snapshot.offset += nodes.length;
      snapshot.cursor = snapshot.offset < snapshot.nodes.length ? randomUUID() : null;
      if (!snapshot.cursor) dom = undefined;
      return { url: safeUrl(state.url) ?? "", view: snapshot.view, nodes, nextCursor: snapshot.cursor, truncated: snapshot.truncated };
    },
    async viewport() {
      const state = captureContext();
      if (await page.locator('input[type="password"]:visible').count()) throw new BrowserRuntimeError("DOMAIN_BLOCKED");
      const position = () => page.evaluate(() => [innerWidth, innerHeight, scrollX, scrollY]);
      for (let attempt = 0; attempt < 2; attempt++) {
        const before = await position();
        const image = await page.screenshot({ type: "jpeg", quality: 65, timeout: 1_500,
          style: `${conceal} { opacity: 0 !important; }`, animations: "allow" });
        const after = await position();
        state.verify();
        if (before.join() === after.join()) return { image, view: [state.version, ...before].join(",") };
      }
      throw new BrowserRuntimeError("REF_NOT_FOUND");
    },
    async storage() {
      const state = captureContext();
      const keys = await page.evaluate(() => {
        const names = (kind: "localStorage" | "sessionStorage") => {
          try {
            const storage = window[kind];
            return Array.from({ length: Math.min(storage.length, 100) }, (_, index) => storage.key(index) ?? "");
          } catch { return []; }
        };
        return { localStorage: names("localStorage"), sessionStorage: names("sessionStorage") };
      });
      const cookies = (await page.context().cookies([state.url])).slice(0, 100).map(cookie => cookie.name);
      state.verify();
      const clean = (values: string[]) => values.map(value => diagnosticLabel(value) ?? "Далд түлхүүр");
      return { cookies: clean(cookies), localStorage: clean(keys.localStorage), sessionStorage: clean(keys.sessionStorage) };
    },
  };
}

