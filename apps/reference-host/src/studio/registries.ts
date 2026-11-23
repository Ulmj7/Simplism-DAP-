/**
 * The host-trusted registry catalog (Studio V1A, D3). The registry belongs to the APPLICATION: an Application stores only a `registryId`, a key into this catalog, and the
 * catalog (code the host's operator controls, never a request) holds the data behind it:
 *
 *   registry   the trusted semantic data a walkthrough may TARGET (routes, elements with their real operations and privacy, postcondition names). It is exactly what the one
 *              Feature 002 validator is given as `registryData`, for authoring, publish re-validation and the published read.
 *   browser    the Studio inspector's view of the same application: the role + accessible-name pairs that may leave the host (`labels`) and the pages (`pathname + hash`)
 *              that map to a registry route. Free-form names never leave the host: an element whose role and name are not declared here is never exposed.
 *
 * The built-in entry `reference` is built from the EXISTING `TRUSTED_REGISTRY` (unchanged export, its parity test unchanged) plus the six labels and four pages that used to
 * be hard-coded in `studio/browser.ts`. The catalog is injectable (`createRegistryCatalog(extra)`): a test or a later deployment adds entries in code; arbitrary registries are
 * NOT stored from the browser in V1A (there is no target-registration UI).
 */
import { TRUSTED_REGISTRY } from "../authoring/trusted-registry.js";
import type { TrustedRegistryData } from "../authoring/trusted-registry.js";
import { REGISTRY_ID, STUDIO_MANAGED_REGISTRY_ID } from "./applications.js";

/** The built-in registry id every legacy (application-less) walkthrough resolves to. */
export const REFERENCE_REGISTRY_ID = "reference";
export const MAX_REGISTRY_LABEL_CHARS = 60;
export const MAX_BROWSER_LABELS = 32;
export const MAX_BROWSER_PAGES = 32;
/**
 * The bounds the editor's strict registry parser enforces on the `/registry` reply (apps/reference-web/src/admin/applications.ts): a catalog entry that exceeds one could be registered
 * but never loaded by the editor, so the catalog refuses it at composition time.
 */
export const MAX_REGISTRY_ROUTES = 20;
export const MAX_REGISTRY_ELEMENTS = 200;
export const MAX_REGISTRY_POSTCONDITIONS = 50;
export const MAX_REGISTRY_NAME_CHARS = 80;
/** A postcondition name: dotted `area.name` (at least two parts of letters and digits, starting with a letter). */
export const POSTCONDITION_NAME = /^[A-Za-z][A-Za-z0-9]*(?:\.[A-Za-z0-9]+)+$/u;

export interface ApprovedLabelEntry { readonly role: string; readonly name: string }
export interface RegistryBrowserView {
  readonly labels: readonly ApprovedLabelEntry[];
  /** `"/"`-rooted `pathname + hash` of a page -> the registry route it shows (e.g. `"/#/profile"` -> `"profile"`). */
  readonly pages: Readonly<Record<string, string>>;
}
export interface RegistryEntry {
  readonly id: string;
  /** What a maintainer picks in the Application Manager. Plain text. */
  readonly label: string;
  readonly registry: TrustedRegistryData;
  readonly browser: RegistryBrowserView;
  /**
   * `true` only when this registry is the one the reference web application hosts: Preview remounts the draft INSIDE the reference web app, so it can only run a guide
   * whose targets exist there (documented V1A limit). A fixture or later application registry is not previewable.
   */
  readonly previewable: boolean;
}
export interface RegistryCatalog {
  /** The ids, in catalog order. */
  ids(): readonly string[];
  get(id: string): RegistryEntry | undefined;
  /** What the Application Manager may choose from. */
  choices(): readonly { readonly id: string; readonly label: string }[];
}

const freezeEntry = (entry: RegistryEntry): RegistryEntry => Object.freeze({
  id: entry.id, label: entry.label, previewable: entry.previewable,
  registry: Object.freeze({
    routes: Object.freeze([...entry.registry.routes]),
    elements: Object.freeze(entry.registry.elements.map((element) => Object.freeze({ ...element, operations: Object.freeze([...element.operations]) }))),
    postconditionNames: Object.freeze([...entry.registry.postconditionNames]),
  }),
  browser: Object.freeze({
    labels: Object.freeze(entry.browser.labels.map((label) => Object.freeze({ role: label.role, name: label.name }))),
    pages: Object.freeze({ ...entry.browser.pages }),
  }),
});

/** The reference application's entry: the existing trusted registry and the labels/pages the Studio browser used before applications existed. */
export const REFERENCE_REGISTRY_ENTRY: RegistryEntry = freezeEntry({
  id: REFERENCE_REGISTRY_ID,
  label: "Reference application",
  registry: TRUSTED_REGISTRY,
  browser: {
    labels: [
      { role: "link", name: "Profile" },
      { role: "link", name: "Settings" },
      { role: "textbox", name: "Display name" },
      { role: "button", name: "Save" },
      { role: "button", name: "Advanced" },
      { role: "button", name: "Set up two-factor authentication" },
    ],
    pages: { "/": "dashboard", "/#/dashboard": "dashboard", "/#/profile": "profile", "/#/settings": "settings" },
  },
  previewable: true,
});

export class RegistryCatalogError extends Error {
  constructor(message: string) { super(message); this.name = "RegistryCatalogError"; }
}

/** Checks the SHAPE of an injected entry (the registry data itself is exercised by the one validator at its first use). Fails closed at composition time. */
function checkEntry(entry: RegistryEntry): void {
  const fail = (why: string): never => { throw new RegistryCatalogError(`registry entry refused: ${why}`); };
  if (typeof entry.id !== "string" || !REGISTRY_ID.test(entry.id)) fail("id must be lower-case letters, digits and hyphens");
  if (entry.id === STUDIO_MANAGED_REGISTRY_ID) fail("the id studio-managed is reserved for Studio-managed registries");
  if (typeof entry.label !== "string" || entry.label.length < 1 || entry.label.length > MAX_REGISTRY_LABEL_CHARS) fail("label must be 1 to 60 characters");
  if (!Array.isArray(entry.registry?.routes) || !Array.isArray(entry.registry?.elements) || !Array.isArray(entry.registry?.postconditionNames)) fail("registry data is incomplete");
  if (!Array.isArray(entry.browser?.labels) || entry.browser.labels.length > MAX_BROWSER_LABELS) fail("browser labels must be a bounded list");
  if (entry.browser.labels.some((label) => typeof label?.role !== "string" || typeof label?.name !== "string" || label.name.length < 1 || label.name.length > 120)) fail("a browser label needs a role and a name");
  const pages = entry.browser.pages;
  if (pages === null || typeof pages !== "object" || Object.keys(pages).length > MAX_BROWSER_PAGES) fail("browser pages must be a bounded map");
  for (const [page, route] of Object.entries(pages)) {
    if (!page.startsWith("/") || page.includes("?") || !entry.registry.routes.includes(route)) fail("every browser page maps to a registry route");
  }
  if (typeof entry.previewable !== "boolean") fail("previewable must be a boolean");
  const { routes, elements, postconditionNames } = entry.registry;
  if (routes.length > MAX_REGISTRY_ROUTES) fail("a registry may declare at most 20 routes");
  if (elements.length > MAX_REGISTRY_ELEMENTS) fail("a registry may declare at most 200 elements");
  if (elements.some((element) => typeof element?.id !== "string" || element.id.length > MAX_REGISTRY_NAME_CHARS)) fail("an element id may be at most 80 characters");
  if (postconditionNames.length > MAX_REGISTRY_POSTCONDITIONS) fail("a registry may declare at most 50 postconditions");
  if (postconditionNames.some((name) => typeof name !== "string" || name.length > MAX_REGISTRY_NAME_CHARS || !POSTCONDITION_NAME.test(name))) fail("a postcondition name is dotted (area.name) and at most 80 characters");
  if (new Set(postconditionNames).size !== postconditionNames.length) fail("postcondition names must be unique");
}

/** The built-in `reference` entry plus any `extra` entries (an `extra` id may not shadow a built-in one). */
export function createRegistryCatalog(extra: readonly RegistryEntry[] = []): RegistryCatalog {
  checkEntry(REFERENCE_REGISTRY_ENTRY); // the built-in entry obeys the same bounds
  const entries = new Map<string, RegistryEntry>([[REFERENCE_REGISTRY_ENTRY.id, REFERENCE_REGISTRY_ENTRY]]);
  for (const entry of extra) {
    checkEntry(entry);
    if (entries.has(entry.id)) throw new RegistryCatalogError("registry entry refused: duplicate id");
    entries.set(entry.id, freezeEntry(entry));
  }
  const ids = Object.freeze([...entries.keys()]);
  const choices = Object.freeze([...entries.values()].map((entry) => Object.freeze({ id: entry.id, label: entry.label })));
  return Object.freeze({ ids: () => ids, get: (id: string) => (typeof id === "string" ? entries.get(id) : undefined), choices: () => choices });
}

/** The application's public-eligible registry view for the `/registry` route (the contract's shape): public elements only, never a private one. */
export interface PublicRegistryView {
  readonly routes: readonly string[];
  readonly elements: readonly { readonly id: string; readonly route: string; readonly role: string; readonly label: string; readonly description: string; readonly operations: readonly string[]; readonly privacy: "public" }[];
  readonly postconditionNames: readonly string[];
  readonly previewable: boolean;
}
export function publicRegistryView(entry: RegistryEntry): PublicRegistryView {
  return Object.freeze({
    routes: entry.registry.routes,
    elements: Object.freeze(entry.registry.elements.filter((element) => element.privacy === "public").map((element) => Object.freeze({
      id: element.id, route: element.route, role: element.role, label: element.label, description: element.description, operations: Object.freeze([...element.operations]), privacy: "public" as const,
    }))),
    postconditionNames: entry.registry.postconditionNames,
    previewable: entry.previewable,
  });
}

/**
 * The registry data the validator uses for `registryId`. `referenceOverride` is a TEST SEAM kept from Feature 004: a test injects a different registry for the built-in
 * `reference` entry only (for example to prove a stale draft is refused after the registry changed) through the REAL validator. Production code never passes it.
 */
export function registryDataFor(catalog: RegistryCatalog, registryId: string, referenceOverride?: TrustedRegistryData): TrustedRegistryData | undefined {
  if (registryId === REFERENCE_REGISTRY_ID && referenceOverride !== undefined) return referenceOverride;
  return catalog.get(registryId)?.registry;
}
