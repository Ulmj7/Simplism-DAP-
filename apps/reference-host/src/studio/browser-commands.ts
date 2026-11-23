/**
 * The request grammar of `POST /api/studio/browser` (Studio V1A, D6): pure, strict and bounded. Every body is an own-keys record with EXACTLY the keys of its action (connect and
 * disconnect have one optional key, so each accepts exactly two key sets), every value is a short string of a fixed shape, and nothing else is read: the application's origin, the
 * registry, the labels and the routes are NEVER taken from a request, they come from the enrolled record in the caller's tenant. A body that does not parse is `null`.
 */
import { exactBody } from "../http/transport.js";
import { isAuthoredId } from "../authoring/ids.js";
import { APPLICATION_ID } from "./applications.js";

export const STUDIO_ACTIONS = ["connect", "refresh", "highlight", "capture", "disconnect"] as const;
export type StudioAction = (typeof STUDIO_ACTIONS)[number];

/** An element reference of the pinned browser CLI: `@e` + 1..9 digits, no leading zero. Session-only evidence, never persisted. */
export const REF_PATTERN = /^@e[1-9]\d{0,8}$/u;
/** The session id the host mints (a UUID by default); bounded so a huge string is refused before any comparison. */
export const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/u;

export type StudioCommand =
  | { readonly action: "connect"; readonly applicationId: string; readonly walkthroughId?: string }
  | { readonly action: "refresh"; readonly sessionId: string; readonly applicationId: string }
  | { readonly action: "highlight" | "capture"; readonly sessionId: string; readonly applicationId: string; readonly ref: string }
  | { readonly action: "disconnect"; readonly sessionId: string; readonly applicationId?: string };

const text = (value: unknown, pattern: RegExp, max: number): value is string => typeof value === "string" && value.length <= max && pattern.test(value);
const applicationId = (value: unknown): value is string => text(value, APPLICATION_ID, 16);
const sessionId = (value: unknown): value is string => text(value, SESSION_ID_PATTERN, 64);
const refOf = (value: unknown): value is string => text(value, REF_PATTERN, 11);

/** `null` for anything that is not exactly one of the five commands with exactly its keys and well-formed values. */
export function parseStudioCommand(body: unknown): StudioCommand | null {
  if (body === null || typeof body !== "object" || Array.isArray(body)) return null;
  const action = (body as { action?: unknown }).action;
  switch (action) {
    case "connect": {
      const withWalkthrough = exactBody(body, ["action", "applicationId", "walkthroughId"]);
      if (withWalkthrough !== null) {
        const { applicationId: app, walkthroughId } = withWalkthrough;
        return applicationId(app) && typeof walkthroughId === "string" && walkthroughId.length <= 15 && isAuthoredId(walkthroughId) ? { action, applicationId: app, walkthroughId } : null;
      }
      const plain = exactBody(body, ["action", "applicationId"]);
      return plain !== null && applicationId(plain.applicationId) ? { action, applicationId: plain.applicationId } : null;
    }
    case "refresh": {
      const parsed = exactBody(body, ["action", "sessionId", "applicationId"]);
      return parsed !== null && sessionId(parsed.sessionId) && applicationId(parsed.applicationId) ? { action, sessionId: parsed.sessionId, applicationId: parsed.applicationId } : null;
    }
    case "highlight": case "capture": {
      const parsed = exactBody(body, ["action", "sessionId", "applicationId", "ref"]);
      return parsed !== null && sessionId(parsed.sessionId) && applicationId(parsed.applicationId) && refOf(parsed.ref)
        ? { action, sessionId: parsed.sessionId, applicationId: parsed.applicationId, ref: parsed.ref } : null;
    }
    case "disconnect": {
      const withApplication = exactBody(body, ["action", "sessionId", "applicationId"]);
      if (withApplication !== null) return sessionId(withApplication.sessionId) && applicationId(withApplication.applicationId) ? { action, sessionId: withApplication.sessionId, applicationId: withApplication.applicationId } : null;
      const plain = exactBody(body, ["action", "sessionId"]);
      return plain !== null && sessionId(plain.sessionId) ? { action, sessionId: plain.sessionId } : null;
    }
    default: return null;
  }
}
