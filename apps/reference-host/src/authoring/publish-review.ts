import { MAX_TEXT, MAX_TITLE } from "@dap/walkthrough/authoring";
import type { ApplicationRecord } from "../studio/applications.js";
import type { CheckView } from "../studio/registry-checks.js";
import type { TargetView } from "../studio/registry-targets.js";
import type { ResolvedRegistry } from "../studio/registry-resolver.js";
import { MAX_STEPS } from "./schema.js";
import type { StoredWalkthrough } from "./store.js";
import { validateAuthoredDefinition } from "./validate.js";

const messages = {
  APPLICATION_DISABLED: "Enable this application before publishing.",
  APPLICATION_MISMATCH: "This walkthrough's application could not be resolved.",
  REGISTRY_INCOMPATIBLE: "This walkthrough does not validate against the current registry.",
  TARGET_DISABLED: "Enable or replace this target before publishing.",
  TARGET_MISSING: "Choose a target from this application's registry.",
  INVALID_INTERACTION: "Choose an interaction supported by this target.",
  INVALID_VERIFICATION: "Choose an available verification check.",
  MISSING_METADATA: "Enter a title and description before publishing.",
  MISSING_VERIFICATION: "This guide step has no verification.",
  TARGET_UNVERIFIED: "Check this target in the browser before publishing.",
  TARGET_BROKEN: "This target was marked broken. Check or repair it before publishing.",
  SUPERSEDES_LIVE_VERSION: "Publishing will replace the current live version.",
} as const;
type ReviewIssue = { code: keyof typeof messages; message: string; stepIndex?: number; targetId?: string };
const issue = (code: ReviewIssue["code"], stepIndex?: number, targetId?: string): ReviewIssue => ({
  code, message: messages[code], ...(stepIndex === undefined ? {} : { stepIndex }), ...(targetId === undefined ? {} : { targetId }),
});
const isPlainText = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.trim().length > 0 && value.length <= max && !/[<>&"'`]/u.test(value);
const bag = (value: unknown): Record<string, unknown> => typeof value === "object" && value !== null ? value as Record<string, unknown> : {};

export function publishReview(head: StoredWalkthrough, application: ApplicationRecord | null, resolved: ResolvedRegistry | undefined,
  targets: readonly TargetView[], checks: readonly CheckView[]) {
  const blockers: ReviewIssue[] = [];
  const warnings: ReviewIssue[] = [];
  const definition = bag(head.definition);
  const title = isPlainText(definition.title, MAX_TITLE) ? definition.title as string : "";
  if (head.applicationId !== (application?.id ?? null)) blockers.push(issue("APPLICATION_MISMATCH"));
  if (application?.enabled === false) blockers.push(issue("APPLICATION_DISABLED"));
  if (title === "" || !isPlainText(definition.description, MAX_TEXT)) blockers.push(issue("MISSING_METADATA"));

  const steps: unknown[] = Array.isArray(definition.steps) ? definition.steps.slice(0, MAX_STEPS) : [];
  const observed = new Set<string>();
  const counts = { healthy: 0, unverified: 0, broken: 0, disabled: 0 };
  const verification = { steps: 0, withVerify: 0 };
  const registry = resolved?.registry;
  const noteTarget = (id: string, stepIndex: number) => {
    const target = targets.find((candidate) => candidate.id === id);
    if (observed.has(id) || target === undefined) return;
    observed.add(id);
    if (target.status === "disabled") { counts.disabled += 1; return; }
    counts[target.health] += 1;
    if (target.health === "broken") warnings.push(issue("TARGET_BROKEN", stepIndex, target.id));
    if (target.health === "unverified") warnings.push(issue("TARGET_UNVERIFIED", stepIndex, target.id));
  };
  for (const [index, raw] of steps.entries()) {
    const step = bag(raw);
    if (step.kind !== "guide") continue;
    verification.steps += 1;
    const target = registry?.elements.find((item) => item.id === step.target);
    const known = targets.find((item) => item.id === step.target);
    if (known !== undefined) noteTarget(known.id, index);
    if (registry !== undefined) {
      if (known?.status === "disabled") blockers.push(issue("TARGET_DISABLED", index, known.id));
      else if (target === undefined) blockers.push(issue("TARGET_MISSING", index));
      else if (!target.operations.includes("highlight") || (step.wait !== "ack" && step.wait !== "click" && step.wait !== "input")
        || (step.wait === "click" && !target.operations.includes("click")) || (step.wait === "input" && !target.operations.includes("input"))) {
        blockers.push(issue("INVALID_INTERACTION", index, target.id));
      }
    }
    if (step.verify === undefined) warnings.push(issue("MISSING_VERIFICATION", index));
    else {
      verification.withVerify += 1;
      const checkTarget = checks.find((check) => check.name === step.verify)?.targetId;
      if (checkTarget) noteTarget(checkTarget, index);
      if (registry !== undefined && (typeof step.verify !== "string" || !registry.postconditionNames.includes(step.verify))) blockers.push(issue("INVALID_VERIFICATION", index));
    }
  }
  if (resolved === undefined || !validateAuthoredDefinition(head.id, head.definition, resolved.registry).ok) blockers.push(issue("REGISTRY_INCOMPATIBLE"));
  if (head.liveVersion != null && head.status === "draft") warnings.push(issue("SUPERSEDES_LIVE_VERSION"));
  return {
    revision: head.revision ?? 1, ok: blockers.length === 0, blockers, warnings,
    summary: {
      application: { id: application?.id ?? null, name: application?.name ?? "Reference application" },
      title, steps: steps.length, targets: counts, verification,
      currentVersion: head.liveVersion ?? null, nextVersion: (head.latestVersion ?? 0) + 1,
    },
  };
}
