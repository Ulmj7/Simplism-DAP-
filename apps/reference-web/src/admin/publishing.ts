import { applicationIdOf, bounded, count, exact, LIMITS, record, targetIdOf } from "./wire.js";

export interface ReviewIssue {
  readonly code: string;
  readonly message: string;
  readonly stepIndex?: number;
  readonly targetId?: string;
}
export interface PublishReview {
  readonly ok: boolean;
  readonly revision: number;
  readonly blockers: readonly ReviewIssue[];
  readonly warnings: readonly ReviewIssue[];
  readonly summary: {
    readonly application: { readonly id: string | null; readonly name: string };
    readonly title: string;
    readonly steps: number;
    readonly targets: { readonly healthy: number; readonly unverified: number; readonly broken: number; readonly disabled: number };
    readonly verification: { readonly steps: number; readonly withVerify: number };
    readonly currentVersion: number | null;
    readonly nextVersion: number;
  };
}
export interface GuideVersion {
  readonly version: number;
  readonly publishedAt: string;
  readonly publishedBy: string;
  readonly stepCount: number;
  readonly live: boolean;
}

const MAX_STEPS = 24;
const MAX_VERSIONS = 1_000;
const MAX_REVIEW_ISSUES = 100;
const issue = (value: unknown): value is ReviewIssue => record(value) && exact(value, ["code", "message",
  ...(Object.hasOwn(value, "stepIndex") ? ["stepIndex"] : []), ...(Object.hasOwn(value, "targetId") ? ["targetId"] : [])])
  && bounded(value.code, 64) && /^[A-Za-z][A-Za-z0-9_-]*$/u.test(value.code)
  && bounded(value.message, LIMITS.issueChars)
  && (!Object.hasOwn(value, "stepIndex") || count(value.stepIndex, MAX_STEPS - 1))
  && (!Object.hasOwn(value, "targetId") || targetIdOf(value.targetId));
const issueList = (value: unknown): value is readonly ReviewIssue[] => Array.isArray(value) && value.length <= MAX_REVIEW_ISSUES && value.every(issue);

export const versionNumber = (value: unknown): value is number => count(value, LIMITS.revision) && value >= 1;
export const liveVersion = (value: unknown): value is number | null => value === null || versionNumber(value);
export const latestVersion = (value: unknown): value is number => count(value, LIMITS.revision);

export function parsePublishReview(value: unknown): PublishReview | null {
  if (!record(value) || !exact(value, ["ok", "revision", "blockers", "warnings", "summary"]) || typeof value.ok !== "boolean" || !versionNumber(value.revision)
    || !issueList(value.blockers) || !issueList(value.warnings) || value.ok !== (value.blockers.length === 0)) return null;
  const { summary } = value;
  if (!record(summary) || !exact(summary, ["application", "title", "steps", "targets", "verification", "currentVersion", "nextVersion"])) return null;
  const { application, title, steps, targets, verification, currentVersion, nextVersion } = summary;
  if (!record(application) || !exact(application, ["id", "name"]) || !(application.id === null || applicationIdOf(application.id)) || !bounded(application.name, LIMITS.applicationName)
    || typeof title !== "string" || title.length > LIMITS.label || (value.ok && title.trim() === "") || !count(steps, MAX_STEPS) || (value.ok && steps === 0)
    || !record(targets) || !exact(targets, ["healthy", "unverified", "broken", "disabled"])
    || !count(targets.healthy, LIMITS.targets) || !count(targets.unverified, LIMITS.targets)
    || !count(targets.broken, LIMITS.targets) || !count(targets.disabled, LIMITS.targets)
    || !record(verification) || !exact(verification, ["steps", "withVerify"]) || !count(verification.steps, steps) || !count(verification.withVerify, verification.steps)
    || !liveVersion(currentVersion) || !versionNumber(nextVersion) || (currentVersion !== null && currentVersion >= nextVersion)
    || [...value.blockers, ...value.warnings].some(item => item.stepIndex !== undefined && item.stepIndex >= steps)) return null;
  return {
    ok: value.ok, revision: value.revision, blockers: value.blockers, warnings: value.warnings,
    summary: {
      application: { id: application.id, name: application.name }, title, steps,
      targets: { healthy: targets.healthy, unverified: targets.unverified, broken: targets.broken, disabled: targets.disabled },
      verification: { steps: verification.steps, withVerify: verification.withVerify }, currentVersion, nextVersion,
    },
  };
}

export function parseVersion(value: unknown): GuideVersion | null {
  if (!record(value) || !exact(value, ["version", "publishedAt", "publishedBy", "stepCount", "live"])
    || !versionNumber(value.version) || !bounded(value.publishedAt, LIMITS.updatedAt) || !Number.isFinite(Date.parse(value.publishedAt))
    || !bounded(value.publishedBy, LIMITS.actor) || !count(value.stepCount, MAX_STEPS) || value.stepCount === 0 || typeof value.live !== "boolean") return null;
  return { version: value.version, publishedAt: value.publishedAt, publishedBy: value.publishedBy, stepCount: value.stepCount, live: value.live };
}

export function parseVersions(value: unknown): readonly GuideVersion[] | null {
  if (!record(value) || !exact(value, ["versions"]) || !Array.isArray(value.versions) || value.versions.length > MAX_VERSIONS) return null;
  const versions: GuideVersion[] = [];
  for (const item of value.versions) {
    const parsed = parseVersion(item);
    if (parsed === null) return null;
    versions.push(parsed);
  }
  if (new Set(versions.map(item => item.version)).size !== versions.length || versions.filter(item => item.live).length > 1) return null;
  return versions.sort((a, b) => b.version - a.version);
}
