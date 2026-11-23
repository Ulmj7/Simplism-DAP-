/**
 * The inspector of a STUDIO-MANAGED application (Studio V1B, B2): pure, so the whole rule set is unit-tested without a browser. The adapter (labels "all") returns the operable controls of the
 * page with their accessible names; this module decides, from the page's own markers, the privacy facts read from the LIVE elements and the CURRENT registry, which of them may be shown and in what
 * state. NOTHING about an element that is not listed leaves the host: no name, no role, only the `hidden` count.
 *
 *   trusted      the marker equals an ACTIVE target of the SAME route and the mapped role (its operations are returned)
 *   disabled     the marker equals a DISABLED target of the same route and role (name + target id only)
 *   registrable  a new valid marker, a registrable role (D5), public by its facts, a name that is not on the secret deny-list, on a hash-routed page, with room in the registry
 *   (hidden)     everything else: no marker, an invalid or reserved marker, a non-registrable role, a target of another route or role, a non-public or secret-looking element, a page that is not
 *                hash-routed, a registry at its caps, an element whose facts could not be read
 *
 * A marker on more than one inspected control is ambiguous and hides all of them.
 * At most 64 controls are inspected (the adapter reads their markers), in document order; `truncated` is true when the page had more. `hidden` counts every control that is not listed.
 */
import type { BrowserSnapshot, ElementFacts, ElementRef } from "@dap/browser-runtime";
import { effectivePrivacyOfFacts, secretNameHit } from "./element-privacy.js";
import { REF_PATTERN } from "./browser-commands.js";
import {
  ALLOWED_OPERATIONS, DEFAULT_OPERATIONS, MAX_ROUTES_PER_APPLICATION, MAX_ROUTE_CHARS, MAX_TARGETS_PER_APPLICATION, MAX_TARGET_LABEL_CHARS, ROUTE_NAME_PATTERN, isHashPage, isHistoryPage, isTargetId, snapshotRoleToTargetRole,
} from "./registry-targets.js";
import type { RegistrableRole, RegistryRouteRecord, TargetRecord } from "./registry-targets.js";

export const MAX_INSPECTED = 64;
export const MAX_NAME_CHARS = 120;
export const MAX_ROLE_CHARS = 40;

export interface ManagedTrusted { readonly ref: ElementRef; readonly name: string; readonly role: string; readonly route: string | null; readonly status: "trusted"; readonly targetId: string; readonly operations: readonly string[]; readonly privacy: "public" }
export interface ManagedDisabled { readonly ref: ElementRef; readonly name: string; readonly role: string; readonly route: string | null; readonly status: "disabled"; readonly targetId: string }
export interface RegistrationProposal {
  readonly targetId: string;
  readonly role: RegistrableRole;
  readonly page: string;
  readonly route: string;
  readonly routeIsNew: boolean;
  readonly suggestedLabel: string;
  readonly allowedOperations: readonly string[];
  readonly defaultOperations: readonly string[];
  readonly privacy: "public";
}
export interface ManagedRegistrable { readonly ref: ElementRef; readonly name: string; readonly role: string; readonly route: string | null; readonly status: "registrable"; readonly proposal: RegistrationProposal }
export type ManagedCandidate = ManagedTrusted | ManagedDisabled | ManagedRegistrable;

/** The registry as the inspector sees it: ALL routes and ALL targets (active and disabled). */
export interface ManagedRegistryView { readonly routes: readonly RegistryRouteRecord[]; readonly targets: readonly TargetRecord[] }

/**
 * The approved page of a URL for the application's routing. `hash` (the default, exactly as V1B): `pathname + hash` of a hash-routed page (pathname `/`, no query). `history`: the PATHNAME only:
 * the query and the fragment are dropped (they are never stored, returned or compared), one trailing slash is removed except for `/`, and the result must follow the history grammar
 * (`[A-Za-z0-9._~-]` segments, at most 200 characters, no empty, `.` or `..` segment; a percent escape is not a page). Anything else is `null`.
 */
export function pageOfUrl(url: string, routing: "hash" | "history" = "hash"): string | null {
  try {
    const parsed = new URL(url);
    if (routing === "history") {
      const pathname = parsed.pathname.length > 1 && parsed.pathname.endsWith("/") ? parsed.pathname.slice(0, -1) : parsed.pathname;
      return isHistoryPage(pathname) ? pathname : null;
    }
    if (parsed.search !== "" || parsed.pathname !== "/") return null;
    const page = parsed.pathname + parsed.hash;
    return isHashPage(page) ? page : null;
  } catch { return null; }
}

/** The registry route of the current page, or `null`. */
export const routeOfPage = (page: string | null, routes: readonly RegistryRouteRecord[]): string | null => (page === null ? null : (routes.find((entry) => entry.page === page)?.route ?? null));

/**
 * `/#/order-list` -> `orderList`, `/#/orders/open` -> `ordersOpen`, `/` -> `home`; a history page works the same way (`/users/123` -> `users123`, `/order-list` -> `orderList`);
 * a collision with an existing route name gets a numeric suffix; at most 40 characters; always matches the route-name pattern (A2).
 */
export function suggestRouteName(page: string, existing: readonly string[]): string {
  const hash = page.startsWith("/#/") ? page.slice(3) : page.startsWith("/") ? page.slice(1) : "";
  const words = hash.split(/[^A-Za-z0-9]+/u).filter((word) => word !== "");
  let base = words.length === 0 ? "home" : words.map((word, index) => (index === 0 ? word.charAt(0).toLowerCase() + word.slice(1) : word.charAt(0).toUpperCase() + word.slice(1))).join("");
  if (!/^[a-z]/u.test(base)) base = `p${base}`;
  base = base.slice(0, MAX_ROUTE_CHARS);
  const taken = new Set(existing);
  if (!taken.has(base)) return base;
  for (let n = 2; n < 1000; n += 1) {
    const suffix = String(n);
    const candidate = `${base.slice(0, MAX_ROUTE_CHARS - suffix.length)}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
  return base; // unreachable in practice: at most 20 routes exist
}

/** The accessible name as a label: markup characters and controls become spaces, runs of spaces collapse, at most 80 characters; never blank (falls back to the last id segment). */
export function suggestLabel(name: string, targetId: string): string {
  const cleaned = name.replace(/[<>&"'`\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/gu, " ").replace(/\s+/gu, " ").trim().slice(0, MAX_TARGET_LABEL_CHARS).trim();
  return cleaned !== "" ? cleaned : (targetId.split(".").at(-1) ?? "Target");
}

const isBlankName = (name: string): boolean => /^[\s\p{Z}\p{Cf}\p{Cc}]*$/u.test(name);
const inBounds = (name: string, role: string): boolean => name.length <= MAX_NAME_CHARS && role.length <= MAX_ROLE_CHARS;

/** The refs whose facts are worth reading: inspected controls with a registrable role and a valid marker. At most 64, document order. */
export function selectFactRefs(snapshot: BrowserSnapshot, ids: ReadonlyMap<ElementRef, string | null>): readonly ElementRef[] {
  const refs: ElementRef[] = [];
  for (const element of snapshot.elements.slice(0, MAX_INSPECTED)) {
    const marker = ids.get(element.ref);
    if (snapshotRoleToTargetRole(element.role) === null || !isTargetId(marker)) continue;
    refs.push(element.ref);
  }
  return Object.freeze(refs);
}

export interface ManagedInspection { readonly elements: readonly ManagedCandidate[]; readonly hidden: number; readonly truncated: boolean }
export interface ManagedInput {
  /** How the application's pages are addressed (default `hash`). */
  readonly routing?: "hash" | "history";
  readonly snapshot: BrowserSnapshot;
  readonly ids: ReadonlyMap<ElementRef, string | null>;
  readonly facts: ReadonlyMap<ElementRef, ElementFacts | null>;
  readonly registry: ManagedRegistryView;
}

/**
 * A marker carried by MORE THAN ONE control of the inspected set (the first 64 controls, whatever their role, privacy or name: the runtime resolves `data-ai-id` to a single element and a private
 * or non-registrable twin still competes for it) is ambiguous: none of those controls is listed and all are counted as hidden. A twin beyond the inspected set cannot be seen (the adapter reads at most 64 markers).
 */
function isAmbiguousMarker(input: ManagedInput, marker: string): boolean {
  let seen = 0;
  for (const element of input.snapshot.elements.slice(0, MAX_INSPECTED)) {
    if (input.ids.get(element.ref) === marker) { seen += 1; if (seen > 1) return true; }
  }
  return false;
}

/** The decision for ONE control (also used to re-verify a registration against fresh facts): a candidate, or `null` for hidden. */
export function classifyControl(input: ManagedInput, element: BrowserSnapshot["elements"][number]): ManagedCandidate | null {
  if (!REF_PATTERN.test(element.ref) || !inBounds(element.name, element.role)) return null;
  if (isBlankName(element.name)) return null; // the adapter drops these already; never list or register a control without a visible name
  const targetRole = snapshotRoleToTargetRole(element.role);
  const marker = input.ids.get(element.ref);
  if (targetRole === null || !isTargetId(marker)) return null;
  if (isAmbiguousMarker(input, marker)) return null; // the runtime resolves a marker to ONE element: a marker on several controls identifies none of them
  const page = pageOfUrl(input.snapshot.url, input.routing ?? "hash");
  const route = routeOfPage(page, input.registry.routes);
  const facts = input.facts.get(element.ref);
  if (facts === undefined || facts === null || effectivePrivacyOfFacts(facts) !== "public") return null;
  if (secretNameHit(element.name)) return null;
  const existing = input.registry.targets.find((target) => target.id === marker);
  if (existing !== undefined) {
    if (route === null || existing.route !== route || existing.role !== targetRole) return null; // a target of another route or role: not this element
    return existing.status === "active"
      ? Object.freeze({ ref: element.ref, name: element.name, role: element.role, route, status: "trusted" as const, targetId: existing.id, operations: Object.freeze([...existing.operations]), privacy: "public" as const })
      : Object.freeze({ ref: element.ref, name: element.name, role: element.role, route, status: "disabled" as const, targetId: existing.id });
  }
  if (page === null) return null; // not a hash-routed page
  if (input.registry.targets.length >= MAX_TARGETS_PER_APPLICATION) return null;
  const routeIsNew = route === null;
  if (routeIsNew && input.registry.routes.length >= MAX_ROUTES_PER_APPLICATION) return null;
  const proposedRoute = route ?? suggestRouteName(page, input.registry.routes.map((entry) => entry.route));
  if (!ROUTE_NAME_PATTERN.test(proposedRoute)) return null;
  return Object.freeze({
    ref: element.ref, name: element.name, role: element.role, route, status: "registrable" as const,
    proposal: Object.freeze({
      targetId: marker, role: targetRole, page, route: proposedRoute, routeIsNew, suggestedLabel: suggestLabel(element.name, marker),
      allowedOperations: Object.freeze([...ALLOWED_OPERATIONS[targetRole]]), defaultOperations: Object.freeze([...DEFAULT_OPERATIONS[targetRole]]), privacy: "public" as const,
    }),
  });
}

export function classifyManaged(input: ManagedInput): ManagedInspection {
  const elements: ManagedCandidate[] = [];
  for (const element of input.snapshot.elements.slice(0, MAX_INSPECTED)) {
    const candidate = classifyControl(input, element);
    if (candidate !== null) elements.push(candidate);
  }
  return Object.freeze({ elements: Object.freeze(elements), hidden: input.snapshot.elements.length - elements.length, truncated: input.snapshot.elements.length > MAX_INSPECTED });
}
