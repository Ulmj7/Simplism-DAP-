/**
 * The model of a Studio-managed registry (Studio V1B, D2-D5, D9): the routes and targets of an application whose registry lives in PostgreSQL. This file is pure: types, the grammar of
 * every field, the strict zod schemas the Gateway capabilities use as `inputSchema`, and ONE structural validator (`validateTargetRegistration`) that the persistence authority (the
 * capability executor) always runs. A request never supplies authority: whether a target may be registered at all (a live element with a marker, public, a trusted ref) is decided by the browser
 * session, the only caller; this validator decides only whether the VALUES are a legal target of THIS product.
 *
 * Grammar (the database repeats each rule as a CHECK, migration 074):
 *   target id   the walkthrough semantic-id rule `^[a-z][A-Za-z0-9]*(\.[A-Za-z0-9]+)+$`, at most 80 characters, first segment not one of dap|studio|admin|system|internal
 *   role        button | link | textbox | checkbox | select | text | heading (the snapshot roles map onto these, `snapshotRoleToTargetRole`); `text` (status and alert regions) and
 *               `heading` can only be highlighted: their operations are EXACTLY {highlight}
 *   operations  a non-empty subset allowed for the role that contains `highlight` (textbox: input and focus; the others: click and focus)
 *   privacy     always `public`: a private or redacted element is never registrable in V1B
 *   label       plain text, 1 to 80 characters, none of `< > & " ' \``  (the walkthrough registry's text rule); description the same up to 240
 *   route       a route name: lower-case first letter, then letters and digits only, at most 40 (stricter than the walkthrough route rule on purpose: the managed postcondition
 *               `route.<route>` must stay a dotted `area.name` the editor's strict registry parser accepts)
 *   page        by the application's routing: hash `/` or `/#/segment(/segment)*` (at most 120), history a '/'-rooted pathname of `[A-Za-z0-9._~-]` segments (at most 200, no query, no fragment,
 *               no trailing slash except `/`, no `.` or `..` segment). The validator below checks the STRUCTURE (either grammar); the store checks the application's own routing under its lock.
 * Issues are FIXED phrases that name the field and never repeat what was supplied.
 */
import { z } from "zod";
import { APPLICATION_ID } from "./applications.js";

export const TARGET_ID_PATTERN = /^[a-z][A-Za-z0-9]*(\.[A-Za-z0-9]+)+$/;
export const MAX_TARGET_ID_CHARS = 80;
export const RESERVED_TARGET_PREFIXES: readonly string[] = Object.freeze(["dap", "studio", "admin", "system", "internal"]);
export const REGISTRABLE_ROLES = ["button", "link", "textbox", "checkbox", "select", "text", "heading"] as const;
export type RegistrableRole = (typeof REGISTRABLE_ROLES)[number];
export const ALL_OPERATIONS = ["highlight", "click", "input", "focus"] as const;
export type TargetOperation = (typeof ALL_OPERATIONS)[number];
export const MAX_TARGET_LABEL_CHARS = 80;
export const MAX_TARGET_DESCRIPTION_CHARS = 240;
export const MAX_ROUTE_CHARS = 40;
export const MAX_PAGE_CHARS = 120;
export const MAX_HISTORY_PAGE_CHARS = 200;
export const ROUTE_NAME_PATTERN = /^[a-z][A-Za-z0-9]{0,39}$/;
export const PAGE_PATTERN = /^\/(#\/[A-Za-z0-9._~-]+(\/[A-Za-z0-9._~-]+)*)?$/;
export const HISTORY_PAGE_PATTERN = /^\/([A-Za-z0-9._~-]+(\/[A-Za-z0-9._~-]+)*)?$/;
/** At most this many routes and targets per application (also enforced by triggers in the database, race-safe). */
export const MAX_ROUTES_PER_APPLICATION = 20;
export const MAX_TARGETS_PER_APPLICATION = 200;
export const TARGET_STATUSES = ["active", "disabled"] as const;
export type TargetStatus = (typeof TARGET_STATUSES)[number];
/** The text rule of the walkthrough registry: non-blank and none of `< > & " ' `` ` ``. */
const MARKUP = /[<>&"'`]/;
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;
const plainText = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= max && !MARKUP.test(value) && !CONTROL.test(value);

/** The roles a target may have, and the operations each allows (D5). `highlight` is always required. */
export const ALLOWED_OPERATIONS: Readonly<Record<RegistrableRole, readonly TargetOperation[]>> = Object.freeze({
  button: Object.freeze(["highlight", "click", "focus"] as const), link: Object.freeze(["highlight", "click", "focus"] as const),
  checkbox: Object.freeze(["highlight", "click", "focus"] as const), select: Object.freeze(["highlight", "click", "focus"] as const),
  textbox: Object.freeze(["highlight", "input", "focus"] as const),
  text: Object.freeze(["highlight"] as const), heading: Object.freeze(["highlight"] as const),
});
export const DEFAULT_OPERATIONS: Readonly<Record<RegistrableRole, readonly TargetOperation[]>> = Object.freeze({
  button: Object.freeze(["highlight", "click"] as const), link: Object.freeze(["highlight", "click"] as const), checkbox: Object.freeze(["highlight", "click"] as const),
  select: Object.freeze(["highlight", "click"] as const), textbox: Object.freeze(["highlight", "input", "focus"] as const),
  text: Object.freeze(["highlight"] as const), heading: Object.freeze(["highlight"] as const),
});

/** The accessibility role the browser reports -> the registry role, or `null` when the element is not registrable in V1B. */
export function snapshotRoleToTargetRole(role: unknown): RegistrableRole | null {
  switch (role) {
    case "button": return "button";
    case "link": return "link";
    case "textbox": case "searchbox": return "textbox";
    case "checkbox": return "checkbox";
    case "combobox": return "select";
    case "status": case "alert": return "text";
    case "heading": return "heading";
    default: return null;
  }
}

export const isTargetId = (value: unknown): value is string =>
  typeof value === "string" && value.length <= MAX_TARGET_ID_CHARS && TARGET_ID_PATTERN.test(value) && !RESERVED_TARGET_PREFIXES.includes(value.split(".")[0] ?? "");
export const isRouteName = (value: unknown): value is string => typeof value === "string" && ROUTE_NAME_PATTERN.test(value);
export const isHashPage = (value: unknown): value is string => typeof value === "string" && value.length <= MAX_PAGE_CHARS && PAGE_PATTERN.test(value);
export const isHistoryPage = (value: unknown): value is string =>
  typeof value === "string" && value.length <= MAX_HISTORY_PAGE_CHARS && HISTORY_PAGE_PATTERN.test(value) && !value.split("/").some((segment) => segment === "." || segment === "..");
/** A page of the application's own routing: hash for `hash`, a pathname for `history` (the database repeats this rule as a trigger, migration 076). */
export const isPageFor = (routing: "hash" | "history", value: unknown): value is string => (routing === "history" ? isHistoryPage(value) : isHashPage(value));
/** A page in EITHER grammar (the structural check of the validator; the store applies the application's routing). */
export const isPage = (value: unknown): value is string => isHashPage(value) || isHistoryPage(value);
export const managedPostconditionName = (route: string): string => `route.${route}`;

// --- stored shapes ----------------------------------------------------------------------------------------------------------------------------------------
export interface RegistryRouteRecord { readonly route: string; readonly page: string }
export const HEALTH_STATES = ["unverified", "healthy", "broken"] as const;
export type TargetHealth = (typeof HEALTH_STATES)[number];
export interface TargetRecord {
  readonly id: string;
  /** The `data-ai-id` the page carries for this target (the runtime resolves the DOM by it). Equal to `id` until a repair changes it; the DAP id never changes. */
  readonly marker: string;
  readonly route: string;
  readonly page: string;
  readonly role: RegistrableRole;
  readonly label: string;
  readonly description: string;
  readonly operations: readonly TargetOperation[];
  readonly privacy: "public";
  readonly status: TargetStatus;
  readonly health: TargetHealth;
  readonly healthCheckedAt: string | null;
  /** 1 for a new target; +1 for every repair. */
  readonly revision: number;
  readonly updatedAt: string;
}
/** What the maintainer routes return (the contract's `TargetView`). */
export interface TargetView extends TargetRecord { readonly references: { readonly drafts: number; readonly published: number } }

export const TARGET_ISSUE_PHRASES = Object.freeze({
  shape: "target: must be an object with exactly the target fields",
  targetId: "targetId: must be a dotted id (for example orders.submitButton) of at most 80 characters that does not start with dap, studio, admin, system or internal",
  route: "route: must be a name of at most 40 letters and digits starting with a lower-case letter",
  page: "page: must be / , /#/ followed by path segments, or a path of segments, without a query or fragment",
  role: "role: must be button, link, textbox, checkbox, select, text or heading",
  operations: "operations: must be a non-empty set allowed for the role that includes highlight",
  privacy: "privacy: must be public",
  label: "label: must be plain text of 1 to 80 characters without < > & \" ' or `",
  description: "description: must be plain text of 1 to 240 characters without < > & \" ' or `",
  status: "status: must be active or disabled",
  health: "health: must be unverified, healthy or broken",
  marker: "marker: must be a dotted id (for example orders.submitButton) of at most 80 characters that does not start with dap, studio, admin, system or internal",
});

/** The values the persistence authority writes. `routeIsNew` is decided by the store inside the transaction, not here. */
export interface TargetRegistration {
  readonly targetId: string;
  readonly route: string;
  readonly page: string;
  readonly role: RegistrableRole;
  readonly label: string;
  readonly description: string;
  readonly operations: readonly TargetOperation[];
  readonly privacy: "public";
}
export type TargetValidation = { readonly ok: true; readonly value: TargetRegistration } | { readonly ok: false; readonly issues: readonly string[] };

const KEYS: readonly string[] = ["targetId", "route", "page", "elementRole", "label", "description", "operations", "privacy"];

/**
 * The structural check of one registration, in the capability's parameter shape (`elementRole`: the name `role` is a reserved Gateway parameter name). The label and description are
 * trimmed; the operations are de-duplicated and kept in the canonical order. A fresh frozen object is returned.
 */
export function validateTargetRegistration(input: unknown): TargetValidation {
  const issues: string[] = [];
  const P = TARGET_ISSUE_PHRASES;
  if (input === null || typeof input !== "object" || Array.isArray(input)) return Object.freeze({ ok: false, issues: Object.freeze([P.shape]) });
  let bag: Record<string, unknown>;
  try {
    if (Object.keys(input).some((key) => !KEYS.includes(key))) issues.push(P.shape);
    bag = Object.fromEntries(KEYS.map((key) => [key, (input as Record<string, unknown>)[key]]));
  } catch { return Object.freeze({ ok: false, issues: Object.freeze([P.shape]) }); }
  if (!isTargetId(bag.targetId)) issues.push(P.targetId);
  if (!isRouteName(bag.route)) issues.push(P.route);
  if (!isPage(bag.page)) issues.push(P.page);
  const role = (REGISTRABLE_ROLES as readonly unknown[]).includes(bag.elementRole) ? (bag.elementRole as RegistrableRole) : null;
  if (role === null) issues.push(P.role);
  const label = typeof bag.label === "string" ? bag.label.trim() : bag.label;
  if (!plainText(label, MAX_TARGET_LABEL_CHARS)) issues.push(P.label);
  const description = typeof bag.description === "string" ? bag.description.trim() : bag.description;
  if (!plainText(description, MAX_TARGET_DESCRIPTION_CHARS)) issues.push(P.description);
  if (bag.privacy !== "public") issues.push(P.privacy);
  let operations: TargetOperation[] = [];
  if (!Array.isArray(bag.operations) || bag.operations.length === 0 || bag.operations.length > ALL_OPERATIONS.length || bag.operations.some((operation: unknown) => !(ALL_OPERATIONS as readonly unknown[]).includes(operation))) issues.push(P.operations);
  else if (role !== null) {
    const wanted = new Set(bag.operations as TargetOperation[]);
    const allowed = ALLOWED_OPERATIONS[role];
    if (!wanted.has("highlight") || [...wanted].some((operation) => !allowed.includes(operation))) issues.push(P.operations);
    else operations = allowed.filter((operation) => wanted.has(operation));
  }
  if (issues.length > 0) return Object.freeze({ ok: false, issues: Object.freeze(issues) });
  return Object.freeze({ ok: true, value: Object.freeze({
    targetId: bag.targetId as string, route: bag.route as string, page: bag.page as string, role: role as RegistrableRole, label: label as string, description: description as string,
    operations: Object.freeze(operations), privacy: "public" as const }) });
}

/** What a repair writes (everything else of a target is fixed). */
export interface TargetRepair {
  readonly marker: string;
  readonly role: RegistrableRole;
  readonly label: string;
  readonly description: string;
  readonly operations: readonly TargetOperation[];
}
export type RepairValidation = { readonly ok: true; readonly value: TargetRepair } | { readonly ok: false; readonly issues: readonly string[] };
const REPAIR_KEYS: readonly string[] = ["marker", "elementRole", "label", "description", "operations"];

/** The structural check of a repair in the capability's parameter shape (the same field rules as a registration; no route, no page, no privacy: they cannot change). */
export function validateTargetRepair(input: unknown): RepairValidation {
  const P = TARGET_ISSUE_PHRASES;
  if (input === null || typeof input !== "object" || Array.isArray(input)) return Object.freeze({ ok: false, issues: Object.freeze([P.shape]) });
  const issues: string[] = [];
  let bag: Record<string, unknown>;
  try {
    if (Object.keys(input).some((key) => !REPAIR_KEYS.includes(key))) issues.push(P.shape);
    bag = Object.fromEntries(REPAIR_KEYS.map((key) => [key, (input as Record<string, unknown>)[key]]));
  } catch { return Object.freeze({ ok: false, issues: Object.freeze([P.shape]) }); }
  if (!isTargetId(bag.marker)) issues.push(P.marker);
  const role = (REGISTRABLE_ROLES as readonly unknown[]).includes(bag.elementRole) ? (bag.elementRole as RegistrableRole) : null;
  if (role === null) issues.push(P.role);
  const label = typeof bag.label === "string" ? bag.label.trim() : bag.label;
  if (!plainText(label, MAX_TARGET_LABEL_CHARS)) issues.push(P.label);
  const description = typeof bag.description === "string" ? bag.description.trim() : bag.description;
  if (!plainText(description, MAX_TARGET_DESCRIPTION_CHARS)) issues.push(P.description);
  let operations: TargetOperation[] = [];
  if (!Array.isArray(bag.operations) || bag.operations.length === 0 || bag.operations.length > ALL_OPERATIONS.length || bag.operations.some((operation: unknown) => !(ALL_OPERATIONS as readonly unknown[]).includes(operation))) issues.push(P.operations);
  else if (role !== null) {
    const wanted = new Set(bag.operations as TargetOperation[]);
    const allowed = ALLOWED_OPERATIONS[role];
    if (!wanted.has("highlight") || [...wanted].some((operation) => !allowed.includes(operation))) issues.push(P.operations);
    else operations = allowed.filter((operation) => wanted.has(operation));
  }
  if (issues.length > 0) return Object.freeze({ ok: false, issues: Object.freeze(issues) });
  return Object.freeze({ ok: true, value: Object.freeze({ marker: bag.marker as string, role: role as RegistrableRole, label: label as string, description: description as string, operations: Object.freeze(operations) }) });
}

// --- the capability input schemas (shape and size only; the rules live in the validator above) -------------------------------------------------------------------
const bounded = (max: number) => z.string().min(1).max(max);
/** `registerStudioTarget` input. `elementRole`, not `role`: `role` is a reserved Gateway parameter name. */
export const registerTargetInputSchema = z.strictObject({
  applicationId: z.string().max(16).regex(APPLICATION_ID),
  targetId: bounded(MAX_TARGET_ID_CHARS),
  route: bounded(MAX_ROUTE_CHARS),
  page: bounded(MAX_HISTORY_PAGE_CHARS),
  elementRole: bounded(16),
  label: bounded(MAX_TARGET_LABEL_CHARS),
  description: bounded(MAX_TARGET_DESCRIPTION_CHARS),
  operations: z.array(bounded(16)).min(1).max(ALL_OPERATIONS.length),
  privacy: bounded(8),
});
/** `setStudioTargetStatus` input. */
export const targetStatusInputSchema = z.strictObject({
  applicationId: z.string().max(16).regex(APPLICATION_ID),
  targetId: bounded(MAX_TARGET_ID_CHARS),
  status: z.string().max(8).pipe(z.enum(TARGET_STATUSES)),
});
/** `setStudioTargetHealth` input. The HTTP route only ever sends `broken` or `unverified`; `healthy` is written by the session `check` command and by a repair. */
export const targetHealthInputSchema = z.strictObject({
  applicationId: z.string().max(16).regex(APPLICATION_ID),
  targetId: bounded(MAX_TARGET_ID_CHARS),
  health: z.string().max(10).pipe(z.enum(HEALTH_STATES)),
});
/** `repairStudioTarget` input: the new marker and, with it, the role, operations and texts of the replacement control. `elementRole`: `role` is a reserved Gateway parameter name. */
export const repairTargetInputSchema = z.strictObject({
  applicationId: z.string().max(16).regex(APPLICATION_ID),
  targetId: bounded(MAX_TARGET_ID_CHARS),
  marker: bounded(MAX_TARGET_ID_CHARS),
  elementRole: bounded(16),
  operations: z.array(bounded(16)).min(1).max(ALL_OPERATIONS.length),
  label: bounded(MAX_TARGET_LABEL_CHARS),
  description: bounded(MAX_TARGET_DESCRIPTION_CHARS),
});
export type RegisterTargetInput = z.infer<typeof registerTargetInputSchema>;
export type TargetHealthInput = z.infer<typeof targetHealthInputSchema>;
export type RepairTargetInput = z.infer<typeof repairTargetInputSchema>;
export type TargetStatusInput = z.infer<typeof targetStatusInputSchema>;
