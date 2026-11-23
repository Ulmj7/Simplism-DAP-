import { isPlainText, MAX_LABEL } from "@dap/walkthrough";
import { parseTargetView } from "./targets.js";
import type { TargetView } from "./targets.js";
import { APPLICATION_ID, LIMITS, REF_PATTERN, applicationIdOf, bounded, count, exact, managedOperations, managedPageOf, normalizedOrigin, operationList, pageOf, record, reference, routeKey, routeOrNull, targetIdOf } from "./wire.js";

export { APPLICATION_ID, REF_PATTERN, normalizedOrigin };

/**
 * The Studio browser wire contract (Studio V1A D6/D7, V1B D8/D13/D17). Every reply is untrusted: it is parsed against an exact, hand-written shape here, and every bound comes from
 * `wire.ts`. A candidate is exactly one of:
 *   trusted        a registered, active target of this application (a registry id that may be saved in a draft)
 *   registrable    an element of a Studio-managed application that may be REGISTERED, with the host's proposal (never persisted until the maintainer confirms it)
 *   disabled       a registered target that is currently disabled (display only)
 *   unregistered   an approved-label element of a built-in application that has no target (display only)
 * `ref` (`@eN`) is session-only evidence: it exists in these types so the inspector can send it back to the host, and nowhere else.
 */
export type RegistrySource = "built-in" | "studio-managed";
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
/** What the host proposes for a registrable element. The id is read from the page's own marker: the maintainer can neither type nor change it. */
export interface TargetProposal {
  readonly targetId: string;
  readonly role: string;
  readonly page: string;
  readonly route: string;
  readonly routeIsNew: boolean;
  readonly suggestedLabel: string;
  readonly allowedOperations: readonly string[];
  readonly defaultOperations: readonly string[];
  readonly privacy: "public";
}
export interface RegistrableCandidate {
  readonly status: "registrable";
  readonly ref: string;
  readonly name: string;
  readonly role: string;
  readonly route: string | null;
  readonly proposal: TargetProposal;
}
export interface DisabledCandidate {
  readonly status: "disabled";
  readonly ref: string;
  readonly name: string;
  readonly role: string;
  readonly route: string | null;
  readonly targetId: string;
}
export interface UnregisteredCandidate {
  readonly status: "unregistered";
  readonly ref: string;
  readonly name: string;
  readonly role: string;
  readonly route: string | null;
}
export type Candidate = TrustedCandidate | RegistrableCandidate | DisabledCandidate | UnregisteredCandidate;
export interface StudioTarget { readonly targetId: string; readonly route: string; readonly name: string; readonly role: string; readonly operations: readonly string[] }
export interface RegisterFields {
  readonly targetId: string;
  readonly route: string;
  readonly operations: readonly string[];
  readonly label: string;
  readonly description: string;
  readonly privacy: "public";
}
export interface RegisteredRoute { readonly route: string; readonly page: string; readonly created: boolean }

export type StudioCommand =
  | { readonly action: "connect"; readonly applicationId: string; readonly walkthroughId?: string }
  | { readonly action: "resume"; readonly applicationId: string }
  | { readonly action: "refresh" | "disconnect"; readonly sessionId: string; readonly applicationId: string }
  | { readonly action: "highlight" | "capture"; readonly sessionId: string; readonly applicationId: string; readonly ref: string }
  | ({ readonly action: "register"; readonly sessionId: string; readonly applicationId: string; readonly ref: string } & RegisterFields);
export type StudioReply =
  | { readonly kind: "connected"; readonly sessionId: string; readonly applicationId: string; readonly application: string; readonly origin: string; readonly registrySource: RegistrySource; readonly resumed: boolean }
  | { readonly kind: "snapshot"; readonly url: string; readonly route: string | null; readonly page: string | null; readonly elements: readonly Candidate[]; readonly hidden: number; readonly truncated: boolean }
  | { readonly kind: "highlighted"; readonly ref: string }
  | { readonly kind: "captured"; readonly target: StudioTarget }
  | { readonly kind: "registered"; readonly target: TargetView; readonly route: RegisteredRoute }
  | { readonly kind: "closed" };

export const studioPath = "/api/studio/browser";
export const MAX_CANDIDATES = LIMITS.candidates;

const pageUrl = (value: unknown): value is string => {
  if (!bounded(value, LIMITS.url)) return false;
  try { return ["http:", "https:"].includes(new URL(value).protocol); } catch { return false; }
};
const registrySource = (value: unknown): value is RegistrySource => value === "built-in" || value === "studio-managed";

function proposal(value: unknown): TargetProposal | null {
  if (!record(value) || !exact(value, ["targetId", "role", "page", "route", "routeIsNew", "suggestedLabel", "allowedOperations", "defaultOperations", "privacy"])) return null;
  const { allowedOperations, defaultOperations } = value;
  if (!targetIdOf(value.targetId) || !bounded(value.role, LIMITS.role) || !managedPageOf(value.page) || !routeKey(value.route) || typeof value.routeIsNew !== "boolean"
    || !isPlainText(value.suggestedLabel, MAX_LABEL) || !managedOperations(value.role, allowedOperations) || !managedOperations(value.role, defaultOperations) || value.privacy !== "public"
    // `highlight` is always allowed and always part of the default; the default never goes beyond what is allowed.
    || !defaultOperations.every(operation => allowedOperations.includes(operation))) return null;
  return {
    targetId: value.targetId, role: value.role, page: value.page, route: value.route, routeIsNew: value.routeIsNew, suggestedLabel: value.suggestedLabel,
    allowedOperations: [...allowedOperations], defaultOperations: [...defaultOperations], privacy: "public",
  };
}

function candidate(item: unknown): Candidate | null {
  if (!record(item) || !reference(item.ref) || !bounded(item.name, LIMITS.candidateName) || !bounded(item.role, LIMITS.role) || !routeOrNull(item.route)) return null;
  const { ref, name, role, route } = item;
  switch (item.status) {
    case "unregistered":
      // An element that is not registered must not carry a target: nothing about it may ever reach a draft.
      return exact(item, ["ref", "name", "role", "route", "status"]) ? { status: "unregistered", ref, name, role, route } : null;
    case "disabled":
      return exact(item, ["ref", "name", "role", "route", "status", "targetId"]) && targetIdOf(item.targetId) ? { status: "disabled", ref, name, role, route, targetId: item.targetId } : null;
    case "registrable": {
      const proposed = exact(item, ["ref", "name", "role", "route", "status", "proposal"]) ? proposal(item.proposal) : null;
      return proposed ? { status: "registrable", ref, name, role, route, proposal: proposed } : null;
    }
    case "trusted":
      return exact(item, ["ref", "name", "role", "route", "status", "targetId", "operations", "privacy"]) && targetIdOf(item.targetId) && operationList(item.operations) && item.privacy === "public"
        ? { status: "trusted", ref, name, role, route, targetId: item.targetId, operations: [...item.operations], privacy: "public" } : null;
    default: return null;
  }
}

const connected = (reply: Record<string, unknown>, resumed: boolean): StudioReply | null => {
  const keys = ["sessionId", "applicationId", "application", "origin", "registrySource", ...(resumed ? ["resumed"] : [])];
  return exact(reply, keys) && bounded(reply.sessionId, LIMITS.sessionId) && applicationIdOf(reply.applicationId) && bounded(reply.application, LIMITS.applicationName)
    && normalizedOrigin(reply.origin) && registrySource(reply.registrySource) && (!resumed || reply.resumed === true)
    ? { kind: "connected", sessionId: reply.sessionId, applicationId: reply.applicationId, application: reply.application, origin: reply.origin, registrySource: reply.registrySource, resumed } : null;
};

export function parseStudioReply(action: StudioCommand["action"], reply: unknown): StudioReply | null {
  if (!record(reply)) return null;
  switch (action) {
    case "connect": return connected(reply, false);
    case "resume": return connected(reply, true);
    case "refresh": {
      if (!exact(reply, ["url", "route", "page", "elements", "hidden", "truncated"]) || !pageUrl(reply.url) || !routeOrNull(reply.route) || !(reply.page === null || pageOf(reply.page))
        || !Array.isArray(reply.elements) || reply.elements.length > LIMITS.candidates || !count(reply.hidden, LIMITS.hidden) || typeof reply.truncated !== "boolean") return null;
      const elements: Candidate[] = [];
      for (const item of reply.elements as unknown[]) {
        const parsed = candidate(item);
        if (!parsed) return null;
        elements.push(parsed);
      }
      if (new Set(elements.map(element => element.ref)).size !== elements.length) return null;
      return { kind: "snapshot", url: reply.url, route: reply.route, page: reply.page, elements, hidden: reply.hidden, truncated: reply.truncated };
    }
    case "highlight":
      return exact(reply, ["highlighted", "ref"]) && reply.highlighted === true && reference(reply.ref) ? { kind: "highlighted", ref: reply.ref } : null;
    case "capture":
      return exact(reply, ["targetId", "route", "name", "role", "operations"]) && targetIdOf(reply.targetId) && routeKey(reply.route)
        && bounded(reply.name, LIMITS.candidateName) && bounded(reply.role, LIMITS.role) && operationList(reply.operations)
        ? { kind: "captured", target: { targetId: reply.targetId, route: reply.route, name: reply.name, role: reply.role, operations: [...reply.operations] } } : null;
    case "register": {
      if (!exact(reply, ["target", "route"]) || !record(reply.route) || !exact(reply.route, ["route", "page", "created"])) return null;
      const target = parseTargetView(reply.target);
      const { route, page, created } = reply.route;
      // The target was registered on the route the reply names, on that route's page.
      return target && routeKey(route) && pageOf(page) && typeof created === "boolean" && target.route === route && target.page === page
        ? { kind: "registered", target, route: { route, page, created } } : null;
    }
    case "disconnect": return exact(reply, ["closed"]) && reply.closed === true ? { kind: "closed" } : null;
  }
}

const STUDIO_ERRORS = new Set([
  "INVALID_REQUEST", "SESSION_CLOSED", "FORBIDDEN", "APPLICATION_NOT_FOUND", "BROWSER_BUSY", "REF_NOT_FOUND",
  "TARGET_UNAVAILABLE", "APPLICATION_DISABLED", "APPLICATION_MISMATCH", "TARGET_NOT_REGISTRABLE", "TARGET_ID_MISMATCH",
  "TARGET_EXISTS", "ROUTE_MISMATCH", "REGISTRY_NOT_MANAGED", "REGISTRY_FULL", "BROWSER_UNAVAILABLE",
  "BROWSER_NOT_STARTED", "BROWSER_TIMEOUT", "SNAPSHOT_FAILED", "HIGHLIGHT_FAILED", "NAVIGATION_FAILED", "DOMAIN_BLOCKED",
  "CLOSE_FAILED", "INVALID_BROWSER_OUTPUT",
]);

export function parseStudioError(status: number, value: unknown): { code: string; issues?: readonly string[] } | null {
  if (!record(value) || typeof value.error !== "string") return null;
  if (value.error === "INVALID_TARGET") {
    if (status !== 422 || !exact(value, ["error", "issues"]) || !Array.isArray(value.issues)
      || value.issues.length > LIMITS.issues || !value.issues.every(issue => bounded(issue, LIMITS.issueChars))) return null;
    return { code: value.error, issues: [...value.issues] };
  }
  return exact(value, ["error"]) && STUDIO_ERRORS.has(value.error) ? { code: value.error } : null;
}
