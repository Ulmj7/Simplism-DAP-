import { OUTCOMES, REASON_CODES } from "@dap/contracts";
import type { FeedbackIssue, PlannerFeedback, PolicyDecision } from "@dap/contracts";
import { ISSUE_CODES } from "./decision.js";

const codes: ReadonlySet<string> = new Set(ISSUE_CODES);
const internalReasons: ReadonlySet<string> = new Set(REASON_CODES);
const retry: ReadonlySet<string> = new Set(["denial_throttle", "dependency_failure", "audit_unavailable", "state_unavailable", "internal_error"]);
const unavailable = Object.freeze({ outcome: "DENIED", category: "try_later" } as const);

function projectIssues(input: unknown): readonly FeedbackIssue[] | undefined {
  if (!Array.isArray(input)) return undefined;
  const length: unknown = Reflect.get(input, "length");
  if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0) return undefined;
  const projected: FeedbackIssue[] = [];
  const snapshots = new WeakMap<object, FeedbackIssue>();
  for (let index = 0; index < Math.min(length, 64); index++) {
    const item: unknown = Reflect.get(input, String(index));
    if (item === null || typeof item !== "object") { projected.push(Object.freeze({ path: "", code: "invalid" })); continue; }
    const previous = snapshots.get(item);
    if (previous) { projected.push(previous); continue; }
    const path: unknown = Reflect.get(item, "path");
    const rawCode: unknown = Reflect.get(item, "code");
    const code: FeedbackIssue["code"] = typeof rawCode === "string" && codes.has(rawCode) ? rawCode as FeedbackIssue["code"] : "invalid";
    // Unknown keys are model-authored values; only known structural paths may be reflected.
    const safePath = code !== "unknown_key" && typeof path === "string" && path.length <= 128 &&
      /^(?:\/(?:[a-zA-Z_][a-zA-Z0-9_]*|[0-9]{1,6}))*$/.test(path) &&
      !path.split("/").some((part) => internalReasons.has(part) || /^[a-f0-9]{32,}$/i.test(part) || /^AKIA[A-Z0-9]{16}/.test(part)) ? path : "";
    const issue = Object.freeze({ path: safePath, code });
    snapshots.set(item, issue);
    projected.push(issue);
  }
  return projected.length > 0 ? Object.freeze(projected) : undefined;
}

/** D14: construct a new allowlisted payload; never spread the internal decision. */
export function toPlannerFeedback(decision: PolicyDecision, executionStatus: "success" | "failure" = "success"): PlannerFeedback {
  try {
    const outcome = decision.outcome;
    if (!OUTCOMES.some((known) => known === outcome)) return unavailable;
    if (outcome === "ALLOWED") return Object.freeze({ outcome, category: executionStatus === "success" ? "ok" : "try_later" });
    if (outcome === "REQUIRES_CONFIRMATION") return Object.freeze({ outcome, category: "needs_user_confirmation" });
    if (outcome === "INVALID_PARAMETERS") {
      const issues = projectIssues(decision.issues);
      return Object.freeze({ outcome, category: "invalid_input", ...(issues ? { issues } : {}) });
    }
    const reason = decision.reason;
    const category = typeof reason !== "string" || retry.has(reason) || reason.startsWith("rate_limited_") ? "try_later" : "not_available";
    return Object.freeze({ outcome, category });
  } catch { return unavailable; }
}
