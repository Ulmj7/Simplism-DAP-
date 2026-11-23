/**
 * The trusted Application model (Studio V1A, D1). An Application is trusted, tenant-scoped configuration: where a walkthrough may be authored (an origin and the
 * origins its navigation may stay within), which registry of trusted targets it uses (a key into the host-trusted catalog, `registries.ts`) and whether it is enabled.
 * Authorization to browse an origin comes from this ENROLLED record, never from a global allowlist or from what the browser or a model says.
 *
 * This file is pure: no I/O, no clock, no random source except the optional injectable id generator. It holds
 *
 *   - the types (`ApplicationConfig` is what a maintainer submits, `ApplicationRecord` what is stored, `ApplicationView` what the routes return),
 *   - the strict zod schema (`applicationConfigSchema`) that the Gateway capability uses as its `inputSchema` (it satisfies the Feature 001 `inspectInputSchema` rules:
 *     every object `additionalProperties: false`, every string a `maxLength`, every array `maxItems`, no reserved parameter name), and
 *   - the ONE enrollment validator (`validateApplicationConfig`) that the route and the capability executor both call, so the Gateway and the executor can never
 *     disagree about what an enrollable application is.
 *
 * What the validator refuses (D1): non-http(s) protocols (`javascript:`, `data:`, `file:`, `ftp:` ...), credentials, a missing host, a path, query or fragment in an origin, a
 * malformed URL, duplicates, an `origin` that is not one of `allowedOrigins`, more than five origins, an unknown environment, an unknown registry id, IP literals other than
 * `127.0.0.1` and `[::1]`, and plain `http` for any host that is not loopback. Loopback (`localhost`, `127.0.0.1`, `[::1]`) stays valid for the reference application and for
 * tests; it is just no longer product logic: the enrolled record is the authority. Origins are NORMALISED (lower-case scheme and host, default port dropped, IDN as punycode,
 * no trailing slash, `[::1]` canonical) and the stored form is the normalised one.
 *
 * Issues are fixed phrases that name the FIELD (and an origin's position), never the author's own text: nothing a maintainer typed is echoed back.
 */
import { randomBytes } from "node:crypto";
import { z } from "zod";

export const ENVIRONMENTS = ["development", "test"] as const;
export type ApplicationEnvironment = (typeof ENVIRONMENTS)[number];
export const MAX_APPLICATIONS_PER_TENANT = 20;
export const MAX_ALLOWED_ORIGINS = 5;
export const MAX_NAME_CHARS = 80;
export const MAX_ORIGIN_CHARS = 200;
export const MAX_REGISTRY_ID_CHARS = 32;
export const MAX_APPLICATION_ISSUES = 20;
export const MAX_APPLICATION_ISSUE_CHARS = 200;

/** Generated ids only: `app-` + 12 lowercase hex characters. The database (migration 072) checks the same shape. */
export const APPLICATION_ID = /^app-[a-f0-9]{12}$/;
export const isApplicationId = (value: unknown): value is string => typeof value === "string" && APPLICATION_ID.test(value);
/** A registry key: lower-case letters, digits and hyphens, starting with a letter. */
export const REGISTRY_ID = /^[a-z][a-z0-9-]{0,31}$/;

export function generateApplicationId(random: (size: number) => Buffer = randomBytes): string {
  const id = `app-${random(6).toString("hex")}`;
  if (!isApplicationId(id)) throw new Error("The id source did not produce an application id");
  return id;
}

/** What a maintainer submits (also the capability's parameters, plus the generated `applicationId`). Origins are in the NORMALISED form once validated. */
export interface ApplicationConfig {
  readonly name: string;
  readonly origin: string;
  readonly allowedOrigins: readonly string[];
  readonly environment: ApplicationEnvironment;
  readonly registryId: string;
}
/** A stored application. */
export interface ApplicationRecord extends ApplicationConfig {
  readonly id: string;
  readonly enabled: boolean;
  readonly createdAt: string;
  readonly updatedAt: string;
}
/** What the maintainer routes return (the contract's `ApplicationView`). */
export interface ApplicationView {
  readonly id: string;
  readonly name: string;
  readonly origin: string;
  readonly allowedOrigins: readonly string[];
  readonly environment: ApplicationEnvironment;
  readonly registryId: string;
  readonly enabled: boolean;
  readonly updatedAt: string;
}
export function toApplicationView(record: ApplicationRecord): ApplicationView {
  return Object.freeze({
    id: record.id, name: record.name, origin: record.origin, allowedOrigins: Object.freeze([...record.allowedOrigins]), environment: record.environment,
    registryId: record.registryId, enabled: record.enabled, updatedAt: record.updatedAt,
  });
}

// --- the capability input schemas (shape and size only; the rules live in the validator below) ------------------------------------------------------------------
const boundedString = (max: number) => z.string().min(1).max(max);
/** The enrollment fields. The environment is a bounded string here (Feature 001 wants a `maxLength` on every string); the validator names the allowed values. */
export const applicationConfigSchema = z.strictObject({
  name: boundedString(MAX_NAME_CHARS),
  origin: boundedString(MAX_ORIGIN_CHARS),
  allowedOrigins: z.array(boundedString(MAX_ORIGIN_CHARS)).min(1).max(MAX_ALLOWED_ORIGINS),
  environment: boundedString(16),
  registryId: boundedString(MAX_REGISTRY_ID_CHARS),
});
/** `saveStudioApplication` input: the generated id plus the configuration. */
export const saveApplicationInputSchema = z.strictObject({
  applicationId: z.string().max(16).regex(APPLICATION_ID),
  ...applicationConfigSchema.shape,
});
/** `setStudioApplicationEnabled` input. */
export const enabledInputSchema = z.strictObject({ applicationId: z.string().max(16).regex(APPLICATION_ID), enabled: z.boolean() });
export type SaveApplicationInput = z.infer<typeof saveApplicationInputSchema>;
export type EnabledInput = z.infer<typeof enabledInputSchema>;

// --- origin normalisation -----------------------------------------------------------------------------------------------------------------------------------
export type OriginProblem = "malformed" | "protocol" | "credentials" | "host" | "path" | "address" | "insecure" | "length" | "hostlength";
/** The longest part of a stored origin after `scheme://` (the host and an optional port): migration 072's CHECK on `allowed_origins` allows 190 characters, so the validator must never accept more. */
export const MAX_ORIGIN_HOST_PART_CHARS = 190;
/** A DNS name after normalisation (lower-case, IDN as punycode): labels of letters, digits and inner hyphens separated by single dots. `*`, `,`, `;`, `%`, `..` and a leading hyphen are not host-name characters. */
const DNS_NAME = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/;
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(["localhost", "127.0.0.1", "[::1]"]);
const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;
/** Control characters, line and paragraph separators and bidirectional overrides. */
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;

export const isLoopbackHost = (hostname: string): boolean => LOOPBACK_HOSTS.has(hostname);

/**
 * The normalised origin (`scheme://host[:port]`) of `raw`, or the problem class. A single trailing slash is accepted and dropped; any other path, a query or a fragment
 * is refused, so an application can never be pinned to a page. The scheme must be http or https, credentials are refused, the host must be a DNS name of letters, digits, hyphens and dots (an IPv4 or IPv6 literal
 * only if it is loopback), the part after `scheme://` is at most 190 characters (the database bound) and plain http is refused for every host that is not loopback.
 */
export function normalizeOrigin(raw: unknown): { readonly ok: true; readonly origin: string; readonly hostname: string } | { readonly ok: false; readonly problem: OriginProblem } {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_ORIGIN_CHARS) return { ok: false, problem: "length" };
  if (CONTROL.test(raw) || /\s/.test(raw)) return { ok: false, problem: "malformed" };
  let url: URL;
  try { url = new URL(raw); } catch { return { ok: false, problem: "malformed" }; }
  if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, problem: "protocol" };
  // A credential-looking authority is refused whether or not the URL parser keeps the pieces (`http://@host` parses with empty ones).
  const authority = raw.slice(raw.indexOf("//") + 2).split(/[/?#]/, 1)[0] ?? "";
  if (url.username !== "" || url.password !== "" || authority.includes("@")) return { ok: false, problem: "credentials" };
  if (url.hostname === "" || url.hostname.endsWith(".")) return { ok: false, problem: "host" };
  if (/[?#]/.test(raw) || url.search !== "" || url.hash !== "" || url.pathname !== "/") return { ok: false, problem: "path" };
  const hostname = url.hostname;
  if (IPV4.test(hostname) || hostname.startsWith("[")) {
    if (!isLoopbackHost(hostname)) return { ok: false, problem: "address" };
  } else {
    // A name only: the CLI allow-list is built from these host names (comma-separated, `*.` is a wildcard there), so a character that means something to it is refused here.
    if (!DNS_NAME.test(hostname)) return { ok: false, problem: "host" };
    if (url.protocol === "http:" && !isLoopbackHost(hostname)) return { ok: false, problem: "insecure" };
  }
  if (url.origin.length - url.protocol.length - 2 > MAX_ORIGIN_HOST_PART_CHARS) return { ok: false, problem: "hostlength" };
  return { ok: true, origin: url.origin, hostname };
}

const ORIGIN_PHRASES: Readonly<Record<OriginProblem, string>> = Object.freeze({
  malformed: "is not a valid origin",
  protocol: "must use http or https",
  credentials: "must not contain a user name or password",
  host: "needs a host name of letters, digits, hyphens and dots",
  path: "must be an origin only: no path, query or fragment",
  address: "may not be an IP address except 127.0.0.1 and [::1]",
  insecure: "must use https unless the host is localhost, 127.0.0.1 or [::1]",
  length: "must be between 1 and 200 characters",
  hostlength: "host and port may be at most 190 characters",
});

/** At most 20 issues of at most 200 characters (the same cap the authoring routes use). */
export function capApplicationIssues(issues: readonly string[]): readonly string[] {
  return Object.freeze(issues.slice(0, MAX_APPLICATION_ISSUES).map((issue) => String(issue).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/g, " ").slice(0, MAX_APPLICATION_ISSUE_CHARS)));
}

export type ApplicationValidation =
  | { readonly ok: true; readonly config: ApplicationConfig }
  | { readonly ok: false; readonly issues: readonly string[] };

const CONFIG_KEYS: readonly string[] = ["name", "origin", "allowedOrigins", "environment", "registryId"];

/**
 * The enrollment validator. `knownRegistryIds` is the host-trusted catalog's keys. The result is the NORMALISED configuration (a fresh frozen object holding the known
 * fields only) or a capped list of fixed-phrase issues that never repeat anything the maintainer typed.
 */
export function validateApplicationConfig(input: unknown, knownRegistryIds: readonly string[]): ApplicationValidation {
  const issues: string[] = [];
  const refuse = (): ApplicationValidation => Object.freeze({ ok: false, issues: capApplicationIssues(issues) });
  if (input === null || typeof input !== "object" || Array.isArray(input)) { issues.push("application: must be an object"); return refuse(); }
  let bag: Record<string, unknown>;
  try {
    const keys = Object.keys(input);
    if (keys.some((key) => !CONFIG_KEYS.includes(key))) issues.push("application: unknown field");
    bag = Object.fromEntries(CONFIG_KEYS.map((key) => [key, (input as Record<string, unknown>)[key]]));
  } catch { issues.push("application: could not be read"); return refuse(); }

  // name: plain text, 1 to 80 characters after trimming.
  let name = "";
  if (typeof bag.name !== "string") issues.push("name: required text");
  else {
    name = bag.name.trim();
    if (name.length < 1 || name.length > MAX_NAME_CHARS) issues.push("name: must be between 1 and 80 characters");
    else if (CONTROL.test(name) || /[<>]/.test(name)) issues.push("name: must be plain text");
  }

  // environment: closed set (V1A is development and test only; production is a documented later stage).
  let environment: ApplicationEnvironment = "development";
  if (typeof bag.environment !== "string" || !(ENVIRONMENTS as readonly string[]).includes(bag.environment)) issues.push("environment: must be development or test");
  else environment = bag.environment as ApplicationEnvironment;

  // registryId: must be a key of the host-trusted catalog.
  let registryId = "";
  if (typeof bag.registryId !== "string" || !REGISTRY_ID.test(bag.registryId) || !knownRegistryIds.includes(bag.registryId)) issues.push("registryId: must be one of the available registries");
  else registryId = bag.registryId;

  // origin
  let origin = "";
  const primary = normalizeOrigin(bag.origin);
  if (!primary.ok) issues.push(`origin: ${ORIGIN_PHRASES[primary.problem]}`);
  else origin = primary.origin;

  // allowedOrigins: 1..5 normalised origins, no duplicates, `origin` among them.
  const allowed: string[] = [];
  if (!Array.isArray(bag.allowedOrigins)) issues.push("allowedOrigins: must be a list of origins");
  else if (bag.allowedOrigins.length < 1 || bag.allowedOrigins.length > MAX_ALLOWED_ORIGINS) issues.push("allowedOrigins: must list between 1 and 5 origins");
  else {
    const seen = new Set<string>();
    let duplicate = false;
    for (let index = 0; index < bag.allowedOrigins.length; index += 1) {
      const normalized = normalizeOrigin((bag.allowedOrigins as unknown[])[index]); // a hole in a sparse array reads as undefined: refused as malformed
      if (!normalized.ok) { issues.push(`allowedOrigins.${index}: ${ORIGIN_PHRASES[normalized.problem]}`); continue; }
      if (seen.has(normalized.origin)) { duplicate = true; continue; }
      seen.add(normalized.origin);
      allowed.push(normalized.origin);
    }
    if (duplicate) issues.push("allowedOrigins: must not repeat an origin");
    if (primary.ok && issues.length === 0 && !seen.has(primary.origin)) issues.push("allowedOrigins: must include the application origin");
  }
  if (issues.length > 0) return refuse();
  return Object.freeze({ ok: true, config: Object.freeze({ name, origin, allowedOrigins: Object.freeze(allowed), environment, registryId }) });
}
