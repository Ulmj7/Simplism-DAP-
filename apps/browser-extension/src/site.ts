export interface Binding {
  readonly origin: string;
  readonly applicationId: string;
  readonly runtimeKey: string;
  readonly apiOrigin: string;
  readonly enabled: boolean;
}

export interface Selection {
  readonly tabId: number;
  readonly origin: string;
  readonly documentId?: string;
}

export interface Page extends Selection {
  readonly documentId: string;
}

export type PageAction = "verify" | "attach" | "open" | "refresh" | "detach";
export type PageStatus = "READY" | "EMPTY" | "VERIFIED" | "DETACHED" | "DIRECT_RUNTIME" | "SITE_CHANGED"
  | "INVALID_CONFIGURATION" | "APPLICATION_UNAVAILABLE" | "NETWORK_UNAVAILABLE" | "INVALID_RESPONSE"
  | "ACCESS_REQUIRED" | "UNAVAILABLE";

export interface PageReply {
  readonly status: PageStatus;
  readonly css?: boolean;
}

export const STATUS_REQUEST = "simplism-extension-status-v1";
export const STATUS_REPLY = "simplism-extension-status-result-v1";
const runtimeStates = ["READY", "EMPTY", "RUNNING", "ERROR", "DIRECT_RUNTIME", "PENDING"] as const;
export interface RuntimeStatus {
  readonly state: typeof runtimeStates[number];
  readonly count: number | null;
}

export function readRuntimeStatus(value: unknown): RuntimeStatus | null {
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== 2) return null;
  const { state, count } = value as RuntimeStatus;
  if (!runtimeStates.includes(state) || (count !== null && (!Number.isInteger(count) || count < 0 || count > 50))) return null;
  if ((state === "READY" && (count === null || count < 1)) || (state === "EMPTY" && count !== 0)
    || ((state === "DIRECT_RUNTIME" || state === "PENDING") && count !== null)) return null;
  return { state, count };
}

export function webOrigin(url: unknown): string | null {
  if (typeof url !== "string") return null;
  try {
    const parsed = new URL(url);
    return (parsed.protocol === "http:" || parsed.protocol === "https:") && !parsed.username && !parsed.password
      && !parsed.hostname.includes("*") && parsed.origin.length <= 200 ? parsed.origin : null;
  } catch { return null; }
}

export function readBinding(value: unknown, origin: string): Binding | null {
  if (!value || typeof value !== "object" || Array.isArray(value) || webOrigin(origin) !== origin) return null;
  const { origin: site, applicationId, runtimeKey, apiOrigin, enabled } = value as Record<string, unknown>;
  if (site !== origin || typeof applicationId !== "string" || !/^app-[a-f0-9]{12}$/u.test(applicationId)
    || typeof runtimeKey !== "string" || !/^rk-[A-Za-z0-9_-]{1,77}$/u.test(runtimeKey)
    || typeof apiOrigin !== "string" || webOrigin(apiOrigin) !== apiOrigin || apiOrigin === origin
    || typeof enabled !== "boolean") return null;
  return { origin, applicationId, runtimeKey, apiOrigin, enabled };
}

export function readSelection(value: unknown): Selection | null {
  if (!value || typeof value !== "object") return null;
  const { tabId, documentId, origin } = value as Record<string, unknown>;
  if (typeof tabId !== "number" || !Number.isSafeInteger(tabId) || tabId < 0
    || (documentId !== undefined && (typeof documentId !== "string" || documentId.length === 0 || documentId.length > 128))
    || typeof origin !== "string" || webOrigin(origin) !== origin) return null;
  return { tabId, origin, ...(documentId === undefined ? {} : { documentId }) };
}

export function readPage(value: unknown): Page | null {
  const selected = readSelection(value);
  return selected?.documentId ? { ...selected, documentId: selected.documentId } : null;
}

export function sitePattern(origin: string): string {
  const url = new URL(origin);
  const port = url.port || (url.protocol === "https:" ? "443" : "80");
  return `${url.protocol}//${url.hostname}:${port}/*`;
}

export const settingKey = (origin: string) => `site:${origin}`;
