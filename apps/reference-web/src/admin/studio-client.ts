import { ID_PATTERN, OPERATIONS } from "@dap/walkthrough";

/**
 * The Studio browser wire contract (Studio V1A, D6/D7). Every reply is untrusted: it is parsed against an exact, hand-written shape here.
 * A candidate is either a TRUSTED target (a registry id that may be saved in a draft) or an UNREGISTERED element (display only).
 * `ref` (`@eN`) is session-only evidence: it exists in these types so the inspector can send it back to the host, and nowhere else.
 */
export interface TrustedCandidate {
  readonly status: "trusted";
  readonly ref: string;
  readonly name: string;
  readonly role: string;
  readonly route: string | null;
  readonly targetId: string;
  readonly operations: readonly string[];
  readonly privacy: "public";
}
export interface UnregisteredCandidate {
  readonly status: "unregistered";
  readonly ref: string;
  readonly name: string;
  readonly role: string;
  readonly route: string | null;
}
export type Candidate = TrustedCandidate | UnregisteredCandidate;
export interface StudioTarget { readonly targetId: string; readonly route: string; readonly name: string; readonly role: string; readonly operations: readonly string[] }

export type StudioCommand =
  | { readonly action: "connect"; readonly applicationId: string; readonly walkthroughId?: string }
  | { readonly action: "refresh" | "disconnect"; readonly sessionId: string; readonly applicationId: string }
  | { readonly action: "highlight" | "capture"; readonly sessionId: string; readonly applicationId: string; readonly ref: string };
export type StudioReply =
  | { readonly kind: "connected"; readonly sessionId: string; readonly applicationId: string; readonly application: string; readonly origin: string }
  | { readonly kind: "snapshot"; readonly url: string; readonly route: string | null; readonly elements: readonly Candidate[] }
  | { readonly kind: "highlighted"; readonly ref: string }
  | { readonly kind: "captured"; readonly target: StudioTarget }
  | { readonly kind: "closed" };

export const studioPath = "/api/studio/browser";
export const MAX_CANDIDATES = 64;
export const APPLICATION_ID = /^app-[a-f0-9]{12}$/u;
export const REF_PATTERN = /^@e[1-9]\d{0,8}$/u;
const ROUTE_KEY = /^[a-z][A-Za-z0-9-]*$/u;

type Bag = Record<string, unknown>;
const record = (value: unknown): value is Bag => value !== null && typeof value === "object" && !Array.isArray(value);
const exact = (value: Bag, keys: readonly string[]) => {
  const present = Object.keys(value);
  return present.length === keys.length && keys.every(key => present.includes(key));
};
const bounded = (value: unknown, max: number): value is string => typeof value === "string" && value.length > 0 && value.length <= max;

/** A normalized `scheme://host[:port]` origin: what a URL parser gives back unchanged. Shared by the application parsers. */
export function normalizedOrigin(value: unknown): value is string {
  if (!bounded(value, 200)) return false;
  try {
    const url = new URL(value);
    return (url.protocol === "http:" || url.protocol === "https:") && !url.username && !url.password && url.origin === value;
  } catch { return false; }
}
// The host cuts the page URL at 300 characters.
const pageUrl = (value: unknown): value is string => {
  if (!bounded(value, 300)) return false;
  try { return ["http:", "https:"].includes(new URL(value).protocol); } catch { return false; }
};
const routeOrNull = (value: unknown): value is string | null => value === null || (bounded(value, 40) && ROUTE_KEY.test(value));
const operationList = (value: unknown): value is readonly string[] => Array.isArray(value) && value.length >= 1 && value.length <= OPERATIONS.length
  && new Set(value as unknown[]).size === value.length && (value as unknown[]).every(item => (OPERATIONS as readonly unknown[]).includes(item));
const targetId = (value: unknown): value is string => bounded(value, 80) && ID_PATTERN.test(value);
const reference = (value: unknown): value is string => typeof value === "string" && REF_PATTERN.test(value);

function candidate(item: unknown): Candidate | null {
  if (!record(item) || !reference(item.ref) || !bounded(item.name, 120) || !bounded(item.role, 40) || !routeOrNull(item.route)) return null;
  const { ref, name, role, route } = item;
  if (item.status === "unregistered") {
    // An element that is not registered must not carry a target: nothing about it may ever reach a draft.
    return exact(item, ["ref", "name", "role", "route", "status"]) ? { status: "unregistered", ref, name, role, route } : null;
  }
  if (item.status === "trusted" && exact(item, ["ref", "name", "role", "route", "status", "targetId", "operations", "privacy"])
    && targetId(item.targetId) && operationList(item.operations) && item.privacy === "public") {
    return { status: "trusted", ref, name, role, route, targetId: item.targetId, operations: [...item.operations], privacy: "public" };
  }
  return null;
}

export function parseStudioReply(action: StudioCommand["action"], reply: unknown): StudioReply | null {
  if (!record(reply)) return null;
  switch (action) {
    case "connect":
      return exact(reply, ["sessionId", "applicationId", "application", "origin"]) && bounded(reply.sessionId, 64)
        && typeof reply.applicationId === "string" && APPLICATION_ID.test(reply.applicationId) && bounded(reply.application, 80) && normalizedOrigin(reply.origin)
        ? { kind: "connected", sessionId: reply.sessionId, applicationId: reply.applicationId, application: reply.application, origin: reply.origin } : null;
    case "refresh": {
      if (!exact(reply, ["url", "route", "elements"]) || !pageUrl(reply.url) || !routeOrNull(reply.route)
        || !Array.isArray(reply.elements) || reply.elements.length > MAX_CANDIDATES) return null;
      const elements: Candidate[] = [];
      for (const item of reply.elements as unknown[]) {
        const parsed = candidate(item);
        if (!parsed) return null;
        elements.push(parsed);
      }
      if (new Set(elements.map(element => element.ref)).size !== elements.length) return null;
      return { kind: "snapshot", url: reply.url, route: reply.route, elements };
    }
    case "highlight":
      return exact(reply, ["highlighted", "ref"]) && reply.highlighted === true && reference(reply.ref) ? { kind: "highlighted", ref: reply.ref } : null;
    case "capture":
      return exact(reply, ["targetId", "route", "name", "role", "operations"]) && targetId(reply.targetId) && bounded(reply.route, 40) && ROUTE_KEY.test(reply.route)
        && bounded(reply.name, 120) && bounded(reply.role, 40) && operationList(reply.operations)
        ? { kind: "captured", target: { targetId: reply.targetId, route: reply.route, name: reply.name, role: reply.role, operations: [...reply.operations] } } : null;
    case "disconnect": return exact(reply, ["closed"]) && reply.closed === true ? { kind: "closed" } : null;
  }
}
