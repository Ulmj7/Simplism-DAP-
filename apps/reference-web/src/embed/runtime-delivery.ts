import { isPlainText, MAX_DESCRIPTION, MAX_LABEL } from "@dap/walkthrough";

/** The runtime key is an OPAQUE public identifier `rk-…` (at most 80 characters of URL-safe characters): the embed never parses its inside; the host decides what it names. */
export const RUNTIME_KEY = /^rk-[A-Za-z0-9_-]{1,77}$/u;
export const MAX_GUIDES = 50;
export const MAX_REPLY_CHARS = 262_144;
export const FETCH_TIMEOUT_MS = 10_000;
export const GUIDE_ID = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/u;

export interface GuideSummary { readonly id: string; readonly title: string; readonly description: string }
export function parseGuideList(value: unknown): readonly GuideSummary[] | null {
  try {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
    const keys = Reflect.ownKeys(value);
    if (keys.length !== 1 || keys[0] !== "guides") return null;
    const guides = (value as { guides: unknown }).guides;
    if (!Array.isArray(guides) || guides.length > MAX_GUIDES) return null;
    const list: GuideSummary[] = [];
    for (const item of guides as unknown[]) {
      if (item === null || typeof item !== "object" || Array.isArray(item)) return null;
      const own = Reflect.ownKeys(item);
      if (own.length !== 3 || !["id", "title", "description"].every(key => own.includes(key))) return null;
      const { id, title, description } = item as Record<string, unknown>;
      if (typeof id !== "string" || !GUIDE_ID.test(id) || !isPlainText(title, MAX_LABEL) || !isPlainText(description, MAX_DESCRIPTION)) return null;
      if (list.some(entry => entry.id === id)) return null;
      list.push(Object.freeze({ id, title: title as string, description: description as string }));
    }
    return Object.freeze(list);
  } catch { return null; }
}

export const SDK_INSTANCE = Symbol.for("simplism.runtime.v1");

type JsonResult = { readonly ok: true; readonly body: unknown }
  | { readonly ok: false; readonly reason: "not_found" | "unavailable" | "invalid" };

export async function getRuntimeJson(win: Window, fetcher: typeof fetch, url: string, signal: AbortSignal): Promise<JsonResult> {
  const invalid = { ok: false, reason: "invalid" } as const;
  const abort = new AbortController();
  const timer = win.setTimeout(() => abort.abort(), FETCH_TIMEOUT_MS);
  try {
    const response = await fetcher(url, {
      method: "GET", mode: "cors", credentials: "omit", cache: "no-store", redirect: "error", referrerPolicy: "no-referrer",
      headers: { accept: "application/json" }, signal: AbortSignal.any([signal, abort.signal]),
    });
    if (response.status !== 200) return { ok: false, reason: response.status === 404 ? "not_found" : "unavailable" };
    if (!(response.headers.get("content-type") ?? "").toLowerCase().includes("json")
      || Number(response.headers.get("content-length")) > MAX_REPLY_CHARS || !response.body) return invalid;
    const reader = response.body.getReader();
    const decoder = new TextDecoder("utf-8", { fatal: true });
    let text = "";
    let size = 0;
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        size += chunk.value.byteLength;
        if (size > MAX_REPLY_CHARS) {
          void reader.cancel().catch(() => undefined);
          return invalid;
        }
        text += decoder.decode(chunk.value, { stream: true });
      }
      return { ok: true, body: JSON.parse(text + decoder.decode()) as unknown };
    } catch { return signal.aborted || abort.signal.aborted ? { ok: false, reason: "unavailable" } : invalid; }
    finally { reader.releaseLock(); }
  } catch { return { ok: false, reason: "unavailable" }; }
  finally { win.clearTimeout(timer); }
}
