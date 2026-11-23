import { parseBundle } from "../embed/protocol.js";
import type { ManagedBundle } from "../embed/protocol.js";
import { MAX_DESCRIPTION as MAX_TEXT, MAX_LABEL as MAX_TITLE } from "@dap/walkthrough";
import type { WalkthroughDef } from "@dap/walkthrough";
import { readReply } from "../help/client.js";
import type { FetchLike } from "../help/client.js";
import { parseApplication, parseApplicationList, parseApplicationRegistry } from "./applications.js";
import type { ApplicationInput, ApplicationList, ApplicationRegistry, ApplicationView } from "./applications.js";
import { checkBody, parseCheckList, parseCheckView } from "./checks.js";
import type { CheckInput, CheckView } from "./checks.js";
import { parseTargetDetail, parseTargetList, parseTargetView } from "./targets.js";
import type { TargetDetail, TargetList, TargetView } from "./targets.js";
import { LIMITS, applicationIdOf, normalizedOrigin, targetIdOf } from "./wire.js";

export type DemoRole = "user" | "maintainer";
export type GuideStatus = "draft" | "published";
export interface GuideSummary { id: string; title: string; description: string }
export interface AuthoredSummary extends GuideSummary { status: GuideStatus; stepCount: number; updatedAt: string; applicationId: string | null }
export interface GuideList { authored: readonly AuthoredSummary[]; builtIn: readonly GuideSummary[] }
import { parseStudioError, parseStudioReply, studioPath } from "./studio-client.js";
import type { StudioCommand, StudioReply } from "./studio-client.js";

/** `applicationId` is null only for a legacy draft written before applications existed; it is assigned on its first save. */
export interface GuideRecord { id: string; status: GuideStatus; applicationId: string | null; definition: WalkthroughDef }
export type ApplicationFailureCode = "APPLICATION_NOT_FOUND" | "APPLICATION_DISABLED" | "APPLICATION_MISMATCH" | "TARGET_NOT_FOUND" | "REGISTRY_NOT_MANAGED";
/** `browser-error` carries the host's closed `{error: CODE}`; only a 422 INVALID_TARGET adds `issues` (at most 20 fixed phrases of at most 200 characters). */
export type AdminResult<T> = { kind: "ok"; value: T } | { kind: "denied" | "failed" | "oversize" | "published" | "limit" | "not-found" } | { kind: "invalid"; issues: readonly string[] }
  | { kind: "browser-error"; code: string; issues?: readonly string[] } | { kind: "application"; code: ApplicationFailureCode };
/** Metadata of a published guide of a Studio-managed application (its definition is delivered by the bundle route, a later step). */
export interface ExternalGuide { id: string; title: string; description: string; application: { id: string; name: string; origin: string } }

export interface UsageCounts {
  started: number;
  completed: number;
  cancelled: number;
  completionRate: number | null;
}
export interface UsageSummary {
  totals: UsageCounts;
  guides: readonly (UsageCounts & { id: string; title: string })[];
}

export interface AdminClient {
  studio?(command: StudioCommand): Promise<AdminResult<StudioReply>>;
  analytics(): Promise<AdminResult<UsageSummary>>;
  publishedCatalog(): Promise<AdminResult<{ walkthroughs: readonly WalkthroughDef[]; external: readonly ExternalGuide[] }>>;
  published(): Promise<AdminResult<readonly WalkthroughDef[]>>;
  list(): Promise<AdminResult<GuideList>>;
  get(id: string): Promise<AdminResult<GuideRecord>>;
  create(applicationId: string, definition: WalkthroughDef): Promise<AdminResult<GuideRecord>>;
  update(id: string, applicationId: string, definition: WalkthroughDef): Promise<AdminResult<GuideRecord>>;
  setStatus(id: string, status: GuideStatus): Promise<AdminResult<GuideRecord>>;
  applications(): Promise<AdminResult<ApplicationList>>;
  application(id: string): Promise<AdminResult<ApplicationView>>;
  createApplication(input: ApplicationInput): Promise<AdminResult<ApplicationView>>;
  updateApplication(id: string, input: ApplicationInput): Promise<AdminResult<ApplicationView>>;
  setApplicationEnabled(id: string, enabled: boolean): Promise<AdminResult<ApplicationView>>;
  applicationRegistry(id: string): Promise<AdminResult<ApplicationRegistry>>;
  targets(applicationId: string): Promise<AdminResult<TargetList>>;
  setTargetStatus(applicationId: string, targetId: string, status: "active" | "disabled"): Promise<AdminResult<TargetView>>;
  /** `GET …/targets/:targetId`: the target with its usage and its change history. */
  targetDetail(applicationId: string, targetId: string): Promise<AdminResult<TargetDetail>>;
  /** The client may only report `broken` or `unverified`; `healthy` is set by the host (a page check or a repair). */
  setTargetHealth(applicationId: string, targetId: string, state: "broken" | "unverified"): Promise<AdminResult<TargetView>>;
  checks(applicationId: string): Promise<AdminResult<readonly CheckView[]>>;
  /** Create-or-get: the same check (same kind, target, route, attribute and expected value) is the same name. */
  createCheck(applicationId: string, input: CheckInput): Promise<AdminResult<CheckView>>;
  setCheckStatus(applicationId: string, name: string, status: "active" | "disabled"): Promise<AdminResult<CheckView>>;
  publishedBundle(id: string): Promise<AdminResult<ManagedBundle>>;
  externalGuides(): Promise<AdminResult<readonly ExternalGuide[]>>;
}

type Bag = Record<string, unknown>;
const object = (value: unknown): value is Bag => value !== null && typeof value === "object" && !Array.isArray(value);
const only = (value: Bag, keys: readonly string[]) => Object.keys(value).every(key => keys.includes(key));
const text = (value: unknown, max: number): value is string => typeof value === "string" && value.length > 0 && value.length <= max;
const status = (value: unknown): value is GuideStatus => value === "draft" || value === "published";
const authoredId = (value: unknown): value is string => typeof value === "string" && /^wt-[a-f0-9]{12}$/.test(value);
const applicationId = applicationIdOf;
const summary = (value: Bag) => text(value.id, 64) && text(value.title, MAX_TITLE) && text(value.description, MAX_TEXT);
const builtIn = (value: unknown): value is GuideSummary => object(value) && summary(value) && only(value, ["id", "title", "description"]);
const authored = (value: unknown): value is AuthoredSummary => object(value) && summary(value) && authoredId(value.id)
  && only(value, ["id", "title", "description", "status", "stepCount", "updatedAt", "applicationId"]) && status(value.status)
  && (value.applicationId === null || applicationId(value.applicationId))
  && typeof value.stepCount === "number" && Number.isInteger(value.stepCount) && value.stepCount >= 1 && value.stepCount <= 24
  && text(value.updatedAt, 32) && Number.isFinite(Date.parse(value.updatedAt));
const list = (value: unknown): GuideList | null => object(value) && only(value, ["authored", "builtIn"]) && Array.isArray(value.authored) && value.authored.every(authored)
  && Array.isArray(value.builtIn) && value.builtIn.every(builtIn) ? { authored: value.authored, builtIn: value.builtIn } : null;

// Guard the wire shape. Semantic validity is decided by the walkthrough catalog.
function step(value: unknown): boolean {
  if (!object(value) || !text(value.id, 64)) return false;
  if (value.kind === "complete") return only(value, ["id", "kind", "text"]) && text(value.text, MAX_TEXT);
  if (!text(value.next, 64) || (value.recover !== undefined && !text(value.recover, 64))
    || (value.maxAttempts !== undefined && !Number.isInteger(value.maxAttempts))) return false;
  const common = ["id", "kind", "text", "next", "recover", "maxAttempts"];
  if (value.kind === "navigate") return only(value, [...common, "route"]) && text(value.route, 64) && (value.text === undefined || text(value.text, MAX_TEXT));
  return value.kind === "guide" && only(value, [...common, "target", "wait", "verify", "targetWaitMs"])
    && text(value.target, 128) && text(value.text, MAX_TEXT) && (value.wait === "click" || value.wait === "input" || value.wait === "ack")
    && (value.verify === undefined || text(value.verify, 64)) && (value.targetWaitMs === undefined || Number.isInteger(value.targetWaitMs));
}
const definition = (value: unknown): value is WalkthroughDef => object(value) && only(value, ["id", "title", "description", "start", "steps"])
  && summary(value) && authoredId(value.id) && text(value.start, 64) && Array.isArray(value.steps) && value.steps.length > 0 && value.steps.length <= 24 && value.steps.every(step);
const record = (value: unknown, id?: string, wanted?: GuideStatus): GuideRecord | null => object(value) && only(value, ["id", "status", "applicationId", "definition"])
  && status(value.status) && (wanted === undefined || value.status === wanted) && (value.applicationId === null || applicationId(value.applicationId)) && definition(value.definition)
  && value.id === value.definition.id && (id === undefined || id === value.id)
  ? { id: value.definition.id, status: value.status, applicationId: value.applicationId, definition: value.definition } : null;
const externalGuide = (value: unknown): value is ExternalGuide => object(value) && only(value, ["id", "title", "description", "application"]) && Object.keys(value).length === 4
  && authoredId(value.id) && text(value.title, MAX_TITLE) && text(value.description, MAX_TEXT) && object(value.application)
  && only(value.application, ["id", "name", "origin"]) && Object.keys(value.application).length === 3
  && applicationId(value.application.id) && text(value.application.name, LIMITS.applicationName) && normalizedOrigin(value.application.origin);
// `external` (metadata of the guides of Studio-managed applications) is validated when present; the definitions of built-in guides are unchanged.
const publishedBody = (value: unknown): Bag | null => object(value) && only(value, ["walkthroughs", "external"]) && Array.isArray(value.walkthroughs) && value.walkthroughs.length <= 50
  && (value.external === undefined || (Array.isArray(value.external) && value.external.length <= 50 && value.external.every(externalGuide))) ? value : null;
const published = (value: unknown): readonly WalkthroughDef[] | null => {
  const body = publishedBody(value);
  return body === null ? null : (body.walkthroughs as unknown[]).filter(definition);
};
const external = (value: unknown): readonly ExternalGuide[] | null => {
  const body = publishedBody(value);
  return body === null ? null : ((body.external ?? []) as ExternalGuide[]);
};

const count = (value: unknown): value is number => typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
const countKeys = ["started", "completed", "cancelled", "completionRate"];
function usageCounts(value: Bag): value is Bag & UsageCounts {
  return count(value.started) && count(value.completed) && count(value.cancelled) && value.completed + value.cancelled <= value.started
    && (value.started === 0 ? value.completionRate === null : count(value.completionRate) && value.completionRate <= 100);
}
const usageGuide = (value: unknown): value is UsageSummary["guides"][number] => object(value)
  && only(value, ["id", "title", ...countKeys]) && text(value.id, 64) && /^[A-Za-z][A-Za-z0-9_-]{0,63}$/.test(value.id)
  && text(value.title, MAX_TITLE) && usageCounts(value) && value.started > 0;
function analytics(value: unknown): UsageSummary | null {
  if (!object(value) || !only(value, ["totals", "guides"]) || !object(value.totals) || !only(value.totals, countKeys) || !usageCounts(value.totals)
    || !Array.isArray(value.guides) || !value.guides.every(usageGuide)) return null;
  const { guides, totals } = value;
  if (new Set(guides.map(guide => guide.id)).size !== guides.length) return null;
  for (const key of ["started", "completed", "cancelled"] as const) {
    if (guides.reduce((sum, guide) => sum + guide[key], 0) !== totals[key]) return null;
  }
  return { totals, guides };
}

const ADMIN = "/api/admin/walkthroughs";
const APPLICATIONS = "/api/admin/applications";
const FAILED = { kind: "failed" } as const;
// 404 and 409 can name an application problem in a closed `{kind, code, message?}` body. The message is never used.
const APPLICATION_CODES: readonly ApplicationFailureCode[] = ["APPLICATION_NOT_FOUND", "APPLICATION_DISABLED", "APPLICATION_MISMATCH", "TARGET_NOT_FOUND", "REGISTRY_NOT_MANAGED"];
function applicationFailure(raw: string | null): ApplicationFailureCode | null {
  try {
    const body: unknown = raw === null ? null : JSON.parse(raw);
    return object(body) && only(body, ["kind", "message", "code"]) && (body.kind === "not_found" || body.kind === "conflict")
      ? APPLICATION_CODES.find(code => code === body.code) ?? null : null;
  } catch { return null; }
}
// Exactly the five configuration fields, in a fixed order, whatever the caller passed.
const applicationBody = ({ name, origin, allowedOrigins, environment, registryId }: ApplicationInput): Bag => ({ name, origin, allowedOrigins: [...allowedOrigins], environment, registryId });
export function createAdminClient(options: { fetch?: FetchLike | undefined; role?: DemoRole | undefined; timeoutMs?: number }): AdminClient {
  async function request<T>(url: string, guard: (value: unknown) => T | null, method = "GET", payload?: Bag): Promise<AdminResult<T>> {
    const fetcher = options.fetch;
    if (!fetcher) return FAILED;
    const controller = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<typeof FAILED>(resolve => { timer = setTimeout(() => { controller.abort(); resolve(FAILED); }, options.timeoutMs ?? (url === studioPath ? 25_000 : 2500)); });
    const exchange = (async (): Promise<AdminResult<T>> => {
      const response = await fetcher(url, {
        method, credentials: "same-origin", redirect: "error", cache: "no-store", signal: controller.signal,
        headers: { accept: "application/json", ...(options.role === undefined ? {} : { "X-Demo-Role": options.role }), ...(payload === undefined ? {} : { "content-type": "application/json" }) },
        ...(payload === undefined ? {} : { body: JSON.stringify(payload) }),
      });
      if (url === studioPath && !response.ok) {
        // Allow room for 20 bounded diagnostic strings including UTF-8 and JSON escaping.
        const raw = await readReply(response, controller.signal, 24_576);
        const body: unknown = raw === null ? null : JSON.parse(raw);
        const error = parseStudioError(response.status, body);
        return error === null ? FAILED : { kind: "browser-error", ...error };
      }
      if (method === "GET" && (response.status === 401 || response.status === 403)) return { kind: "denied" };
      if (method !== "GET" && response.status === 413) return { kind: "oversize" };
      if (response.status === 404 && url.startsWith("/api/walkthroughs/published/")) return { kind: "not-found" };
      if (response.status === 404 || response.status === 409) {
        const code = applicationFailure(await readReply(response, controller.signal, 512));
        if (code !== null) return { kind: "application", code };
        // Without an application code a 409 keeps its older meaning: a published record cannot be edited, or the application limit is reached.
        if (response.status === 409 && method === "PUT" && url.startsWith(`${ADMIN}/`)) return { kind: "published" };
        if (response.status === 409 && method === "POST" && url === APPLICATIONS) return { kind: "limit" };
        return FAILED;
      }
      if (!response.ok && (method === "GET" || response.status !== 422)) return FAILED;
      // 50 definitions can each approach the host's 15,000-byte proposal budget. The list shares this reply bound.
      const raw = await readReply(response, controller.signal, 1_000_000);
      if (raw === null) return FAILED;
      const body: unknown = JSON.parse(raw);
      if (!response.ok) {
        if (!object(body) || !only(body, ["kind", "message", "issues"]) || body.kind !== "invalid" || !text(body.message, 200)
          || !Array.isArray(body.issues) || body.issues.length > 20 || !body.issues.every(issue => text(issue, 200))) return FAILED;
        return body.issues.includes("definition: too large to save") ? { kind: "oversize" } : { kind: "invalid", issues: body.issues };
      }
      const value = guard(body);
      return value === null ? FAILED : { kind: "ok", value };
    })().catch(() => FAILED);
    try { return await Promise.race([exchange, expired]); } finally { clearTimeout(timer); }
  }
  return {
    studio: command => request(studioPath, value => parseStudioReply(command.action, value, command.action === "repair" ? command.confirm : undefined), "POST", { ...command }),
    analytics: () => request("/api/admin/analytics", analytics),
    publishedCatalog: () => request("/api/walkthroughs/published", value => {
      const guides = published(value); const entries = external(value);
      return guides && entries ? { walkthroughs: guides, external: entries } : null;
    }),
    published: () => request("/api/walkthroughs/published", published),
    list: () => request(ADMIN, list),
    get: id => authoredId(id) ? request(`${ADMIN}/${id}`, value => record(value, id)) : Promise.resolve(FAILED),
    // The body is exactly {applicationId, definition}; a create never carries the temporary definition id.
    create: (owner, { title, description, start, steps }) => applicationId(owner)
      ? request(ADMIN, value => record(value, undefined, "draft"), "POST", { applicationId: owner, definition: { title, description, start, steps } }) : Promise.resolve(FAILED),
    update: (id, owner, def) => authoredId(id) && id === def.id && applicationId(owner)
      ? request(`${ADMIN}/${id}`, value => record(value, id, "draft"), "PUT", { applicationId: owner, definition: def }) : Promise.resolve(FAILED),
    setStatus: (id, wanted) => authoredId(id)
      ? request(`${ADMIN}/${id}/status`, value => record(value, id, wanted), "POST", { status: wanted }) : Promise.resolve(FAILED),
    applications: () => request(APPLICATIONS, parseApplicationList),
    application: id => applicationId(id) ? request(`${APPLICATIONS}/${id}`, value => parseApplication(value, id)) : Promise.resolve(FAILED),
    createApplication: input => request(APPLICATIONS, value => parseApplication(value), "POST", applicationBody(input)),
    updateApplication: (id, input) => applicationId(id)
      ? request(`${APPLICATIONS}/${id}`, value => parseApplication(value, id), "PUT", applicationBody(input)) : Promise.resolve(FAILED),
    setApplicationEnabled: (id, enabled) => applicationId(id)
      ? request(`${APPLICATIONS}/${id}/status`, value => { const parsed = parseApplication(value, id); return parsed?.enabled === enabled ? parsed : null; }, "POST", { enabled }) : Promise.resolve(FAILED),
    applicationRegistry: id => applicationId(id) ? request(`${APPLICATIONS}/${id}/registry`, parseApplicationRegistry) : Promise.resolve(FAILED),
    targets: id => applicationId(id) ? request(`${APPLICATIONS}/${id}/targets`, parseTargetList) : Promise.resolve(FAILED),
    // Exactly {status}: a target has no other editable field and no delete.
    setTargetStatus: (id, targetId, wanted) => applicationId(id) && targetIdOf(targetId) && (wanted === "active" || wanted === "disabled")
      ? request(`${APPLICATIONS}/${id}/targets/${targetId}/status`, value => { const parsed = parseTargetView(value, targetId); return parsed?.status === wanted ? parsed : null; }, "POST", { status: wanted })
      : Promise.resolve(FAILED),
    targetDetail: (id, targetId) => applicationId(id) && targetIdOf(targetId) ? request(`${APPLICATIONS}/${id}/targets/${targetId}`, value => parseTargetDetail(value, targetId)) : Promise.resolve(FAILED),
    setTargetHealth: (id, targetId, state) => applicationId(id) && targetIdOf(targetId) && (state === "broken" || state === "unverified")
      ? request(`${APPLICATIONS}/${id}/targets/${targetId}/health`, value => { const parsed = parseTargetView(value, targetId); return parsed?.health === state ? parsed : null; }, "POST", { state }) : Promise.resolve(FAILED),
    checks: id => applicationId(id) ? request(`${APPLICATIONS}/${id}/checks`, parseCheckList) : Promise.resolve(FAILED),
    createCheck: (id, input) => {
      const body = checkBody(input);
      return applicationId(id) && body !== null ? request(`${APPLICATIONS}/${id}/checks`, value => {
        const parsed = parseCheckView(value);
        // The reply is the check that was asked for, nothing else.
        return parsed !== null && parsed.kind === input.kind && parsed.targetId === (input.targetId ?? null) && parsed.route === (input.route ?? null) && parsed.status === "active" ? parsed : null;
      }, "POST", body) : Promise.resolve(FAILED);
    },
    setCheckStatus: (id, name, wanted) => applicationId(id) && /^check\.v[0-9a-f]{10}$/u.test(name) && (wanted === "active" || wanted === "disabled")
      ? request(`${APPLICATIONS}/${id}/checks/${name}/status`, value => { const parsed = parseCheckView(value, name); return parsed?.status === wanted ? parsed : null; }, "POST", { status: wanted }) : Promise.resolve(FAILED),
    publishedBundle: id => authoredId(id) ? request(`/api/walkthroughs/published/${id}/bundle`, value => {
      const parsed = parseBundle(value);
      return parsed.ok && parsed.bundle.definition.id === id ? parsed.bundle : null;
    }) : Promise.resolve(FAILED),
    externalGuides: () => request("/api/walkthroughs/published", external),
  };
}
