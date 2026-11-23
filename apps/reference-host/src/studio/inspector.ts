/**
 * The inspector's classification of one observation (Studio V1A, D7): pure, so it is unit-tested without a browser. A candidate is `trusted` ONLY when all of these hold at the
 * moment of the refresh: the `data-ai-id` read from the LIVE element equals a registry element of the application's registry, whose route is the page the browser is on, whose role is the
 * candidate's role, whose privacy is public and whose operations include `highlight`. Everything else (no id, an unknown id, a private element, another route, another role, no
 * highlight operation, a page that is not one of the application's pages) is just `unregistered`: the reply then carries NO target id, NO operations and never the id that was read.
 *
 * The adapter has already dropped every element whose role and accessible name are not an approved label, so a free-form name never reaches this function.
 */
import type { BrowserElement, BrowserSnapshot, ElementRef } from "@dap/browser-runtime";
import { REF_PATTERN } from "./browser-commands.js";
import type { RegistryEntry } from "./registries.js";

type RegistryElement = RegistryEntry["registry"]["elements"][number];

export const MAX_CANDIDATES = 64;
export const MAX_NAME_CHARS = 120;
export const MAX_ROLE_CHARS = 40;
export const MAX_URL_CHARS = 300;

export interface TrustedCandidate {
  readonly ref: ElementRef;
  readonly name: string;
  readonly role: string;
  readonly route: string | null;
  readonly status: "trusted";
  readonly targetId: string;
  readonly operations: readonly string[];
  readonly privacy: "public";
}
export interface UnregisteredCandidate {
  readonly ref: ElementRef;
  readonly name: string;
  readonly role: string;
  readonly route: string | null;
  readonly status: "unregistered";
}
export type Candidate = TrustedCandidate | UnregisteredCandidate;

/** The registry route of a page URL (`pathname + hash`), or `null` when the URL is not one of the application's pages. */
export function routeOfUrl(url: string, pages: RegistryEntry["browser"]["pages"]): string | null {
  try {
    const parsed = new URL(url);
    if (parsed.search !== "") return null;
    const route = pages[parsed.pathname + parsed.hash];
    return typeof route === "string" && Object.hasOwn(pages, parsed.pathname + parsed.hash) ? route : null;
  } catch { return null; }
}

const registered = (registry: RegistryEntry["registry"], id: string | null | undefined, route: string | null, role: string): RegistryElement | undefined =>
  id === null || id === undefined || route === null ? undefined
    : registry.elements.find((item) => item.id === id && item.route === route && item.role === role && item.privacy === "public" && item.operations.includes("highlight"));

/** At most 64 candidates, in snapshot order; one whose ref, name or role is out of bounds is left out (never truncated into a different value). */
export function classifyCandidates(snapshot: BrowserSnapshot, ids: ReadonlyMap<ElementRef, string | null>, route: string | null, registry: RegistryEntry["registry"]): readonly Candidate[] {
  const candidates: Candidate[] = [];
  for (const element of snapshot.elements.slice(0, MAX_CANDIDATES) as readonly BrowserElement[]) {
    if (!REF_PATTERN.test(element.ref) || element.name.length > MAX_NAME_CHARS || element.role.length > MAX_ROLE_CHARS) continue;
    const match = registered(registry, ids.get(element.ref), route, element.role);
    candidates.push(match === undefined
      ? Object.freeze({ ref: element.ref, name: element.name, role: element.role, route, status: "unregistered" as const })
      : Object.freeze({ ref: element.ref, name: element.name, role: element.role, route, status: "trusted" as const, targetId: match.id, operations: Object.freeze([...match.operations]), privacy: "public" as const }));
  }
  return Object.freeze(candidates);
}
