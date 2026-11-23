import type { SemanticRegistry } from "@dap/walkthrough";
import { isPlainText, MAX_DESCRIPTION } from "@dap/walkthrough";
import type { EditorDraft, EditorStep } from "./draft.js";
import { MAX_EDITOR_STEPS } from "./draft.js";
import type { TargetHealth } from "./targets.js";

/**
 * The pure core of the editor's step list (Studio completion S9): operations on the draft and the live, per-step validity. The compiled definition derives its step ids and its `next` links from the
 * order of the draft (`draftToDefinition`), so a duplicate, a deletion or a move can never leave a dangling `next` or `recover`: the links are rebuilt from the list every time.
 * Every operation returns the index that should be selected afterwards, or `null` when it does not apply (nothing is changed then).
 */
export function duplicateStep(draft: EditorDraft, index: number): number | null {
  const step = draft.steps[index];
  if (step === undefined || draft.steps.length >= MAX_EDITOR_STEPS) return null;
  // Instruction, target, interaction and verification are copied; the copy sits right after the original and is selected.
  const copy: EditorStep = { target: step.target, wait: step.wait, text: step.text, ...(step.verify === undefined ? {} : { verify: step.verify }) };
  draft.steps.splice(index + 1, 0, copy);
  return index + 1;
}
export function deleteStep(draft: EditorDraft, index: number): number | null {
  if (draft.steps[index] === undefined || draft.steps.length <= 1) return null;
  draft.steps.splice(index, 1);
  return Math.min(index, draft.steps.length - 1);
}
export function moveStep(draft: EditorDraft, index: number, delta: -1 | 1): number | null {
  const next = index + delta;
  if (draft.steps[index] === undefined || draft.steps[next] === undefined) return null;
  [draft.steps[index], draft.steps[next]] = [draft.steps[next]!, draft.steps[index]!];
  return next;
}

const waitWords = { ack: "ACK", click: "CLICK", input: "INPUT", "": "NO INTERACTION" } as const;
/** `2. Change display name — INPUT · profile.displayName ✓ check` */
export function stepSummary(draft: EditorDraft, index: number): string {
  const step = draft.steps[index];
  if (!step) return "";
  const instruction = step.text.trim() === "" ? "(no instruction)" : step.text.trim().length > 40 ? `${step.text.trim().slice(0, 39)}…` : step.text.trim();
  return `${index + 1}. ${instruction} — ${waitWords[step.wait]} · ${step.target === "" ? "no target" : step.target}${step.verify === undefined ? "" : " ✓ check"}`;
}

export type ValidityLevel = "valid" | "warning" | "invalid";
export interface StepValidity { readonly level: ValidityLevel; readonly invalid: readonly string[]; readonly warnings: readonly string[] }
export interface ValidityContext {
  readonly registry: SemanticRegistry;
  readonly postconditions: readonly string[];
  /** Health by target id (Studio-managed applications; absent = unknown). */
  readonly health?: ReadonlyMap<string, TargetHealth> | undefined;
}
export const validityWords: Readonly<Record<ValidityLevel, { readonly icon: string; readonly label: string }>> = Object.freeze({
  valid: { icon: "✓", label: "Valid" }, warning: { icon: "!", label: "Warning" }, invalid: { icon: "✕", label: "Invalid" },
});
export const validityReasons = Object.freeze({
  noTarget: "Select a target.",
  unknownTarget: "The target is not available: it is disabled, removed or unknown.",
  noWait: "Select an interaction.",
  waitNotAllowed: "This interaction is not available for this target.",
  noText: "Enter an instruction in plain text.",
  unknownCheck: "The verification is not available: select another one.",
  noCheck: "No verification: Studio cannot confirm that this step worked.",
  broken: "The target is marked broken: re-record it in Targets.",
  unverified: "The target has not been checked on its page yet.",
});

/** The live validity of ONE step against the application's current registry (and, when known, the health of its target). Never throws. */
export function stepValidity(draft: EditorDraft, index: number, context: ValidityContext): StepValidity {
  const step = draft.steps[index];
  const invalid: string[] = []; const warnings: string[] = [];
  if (!step) return { level: "invalid", invalid: [validityReasons.noTarget], warnings };
  const target = step.target === "" ? undefined : context.registry.get(step.target);
  if (step.target === "") invalid.push(validityReasons.noTarget);
  else if (!target || !target.operations.includes("highlight")) invalid.push(validityReasons.unknownTarget);
  if (step.wait === "") invalid.push(validityReasons.noWait);
  else if (target && step.wait !== "ack" && !target.operations.includes(step.wait)) invalid.push(validityReasons.waitNotAllowed);
  if (!isPlainText(step.text, MAX_DESCRIPTION)) invalid.push(validityReasons.noText);
  if (step.verify !== undefined && !context.postconditions.includes(step.verify)) invalid.push(validityReasons.unknownCheck);
  if (step.verify === undefined && step.wait !== "ack" && step.wait !== "") warnings.push(validityReasons.noCheck);
  const health = target === undefined ? undefined : context.health?.get(target.id);
  if (health === "broken") warnings.push(validityReasons.broken);
  else if (health === "unverified") warnings.push(validityReasons.unverified);
  return { level: invalid.length > 0 ? "invalid" : warnings.length > 0 ? "warning" : "valid", invalid, warnings };
}
export const validityText = (validity: StepValidity): string => {
  const { icon, label } = validityWords[validity.level];
  const reasons = validity.level === "invalid" ? validity.invalid : validity.warnings;
  return reasons.length === 0 ? `${icon} ${label}` : `${icon} ${label}: ${reasons.join(" ")}`;
};

export type SaveState = "saved" | "saving" | "unsaved" | "failed";
export const saveStateText: Readonly<Record<SaveState, string>> = Object.freeze({ saved: "Saved", saving: "Saving…", unsaved: "Unsaved changes", failed: "Save failed" });
