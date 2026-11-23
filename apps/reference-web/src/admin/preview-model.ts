import type { WalkthroughDef } from "@dap/walkthrough";
import type { RunFailure, RunStatus } from "../embed/protocol.js";

/**
 * The preview's wording (S8/S9): the run's step position, what it waits for, and a fixed sentence plus a suggested action for every failure code. Names, routes and ids only: nothing the page held and
 * no stack trace ever reaches this text.
 */
export type PreviewMode = "edit" | "preview" | "results";
export interface PreviewProgress { readonly step: number; readonly count: number; readonly waitingFor: string; readonly target: string; readonly verification: string }

/** `stepIndex + 1` of `stepCount` (the run reports a 0-based index into the compiled definition). */
export function progressOf(status: RunStatus, definition: WalkthroughDef, labelOf: (targetId: string) => string, verifyWords: (name: string) => string): PreviewProgress | null {
  if (status.status === "refused" || status.stepIndex === undefined || status.stepCount === undefined) return null;
  const step = definition.steps[status.stepIndex];
  if (!step) return null;
  const count = status.stepCount;
  if (step.kind === "navigate") return { step: status.stepIndex + 1, count, waitingFor: `Waiting for: navigation to ${step.route}`, target: "—", verification: "—" };
  if (step.kind === "complete") return { step: status.stepIndex + 1, count, waitingFor: "Finished", target: "—", verification: "—" };
  const wait = step.wait === "click" ? "click" : step.wait === "input" ? "input" : "your acknowledgement";
  return { step: status.stepIndex + 1, count, waitingFor: `Waiting for: ${wait}`, target: labelOf(step.target), verification: step.verify === undefined ? "None" : verifyWords(step.verify) };
}

export interface Diagnostic {
  readonly title: string;
  readonly detail: string;
  /** What the maintainer can do about it. `rerecord` opens the Targets repair flow of that target. */
  readonly action?: { readonly kind: "rerecord"; readonly targetId: string; readonly label: string };
}
export const diagnosticSentences = Object.freeze({
  target_unavailable: "The element could not be found on the page, so Studio could not point to it. It may have been changed or removed.",
  verification_failed: "Studio could not confirm that this step worked.",
  route_mismatch: "The application is on another page than this step expects.",
  timeout: "The step did not finish in time.",
  cancelled: "The preview was stopped.",
  invalid: "The preview could not run this workflow. Check its steps and try again.",
});
export function diagnose(failure: RunFailure, verifyWords: (name: string) => string): Diagnostic {
  switch (failure.code) {
    case "target_unavailable":
      return { title: failure.targetId === undefined ? "Target not found" : `Target not found: ${failure.targetId}`, detail: diagnosticSentences.target_unavailable,
        ...(failure.targetId === undefined ? {} : { action: { kind: "rerecord" as const, targetId: failure.targetId, label: "Re-record target" } }) };
    case "route_mismatch":
      return { title: `Wrong page: expected ${failure.expectedRoute ?? "another page"}, currently ${failure.currentRoute ?? "unknown"}`, detail: diagnosticSentences.route_mismatch };
    case "verification_failed":
      return { title: failure.check === undefined ? "Verification failed" : `Verification failed: ${verifyWords(failure.check)}`, detail: diagnosticSentences.verification_failed };
    case "timeout": return { title: "Timed out", detail: diagnosticSentences.timeout };
    case "cancelled": return { title: "Preview stopped", detail: diagnosticSentences.cancelled };
    default: return { title: "Preview could not run", detail: diagnosticSentences.invalid };
  }
}
