import { createWalkthroughCatalog, WalkthroughCatalogError } from "@dap/walkthrough";
import type { SemanticRegistry, Step, WaitKind, WalkthroughDef } from "@dap/walkthrough";
import { copy } from "../copy.js";
import { POSTCONDITION_NAMES } from "../postconditions.js";

export const MAX_EDITOR_STEPS = 8;
export const PREVIEW_ID = "wt-preview";
const LOCAL_ID = "wt-local-draft";

export interface EditorStep { target: string; wait: WaitKind | ""; text: string; verify?: string }
export interface EditorDraft { title: string; description: string; steps: EditorStep[]; completion: string }
export const emptyStep = (): EditorStep => ({ target: "", wait: "ack", text: "" });
export const emptyDraft = (): EditorDraft => ({ title: "", description: "", steps: [emptyStep()], completion: "" });

export function draftToDefinition(draft: EditorDraft, registry: SemanticRegistry, id = LOCAL_ID): WalkthroughDef {
  const sequence: (Omit<Extract<Step, {kind: "navigate"}>, "next"> | Omit<Extract<Step, {kind: "guide"}>, "next">)[] = [];
  let previousRoute: string | undefined;
  draft.steps.forEach(({ target, wait, text, verify }, index) => {
    const route = registry.get(target)?.route;
    const number = index + 1;
    if (route !== undefined && route !== previousRoute) sequence.push({ kind: "navigate", id: `n${number}`, route });
    // An empty editor wait is rejected by the catalog like any other invalid form input.
    sequence.push({ kind: "guide", id: `s${number}`, target, wait: wait as WaitKind, text, ...(verify === undefined ? {} : { verify }) });
    previousRoute = route;
  });
  return {
    id, title: draft.title, description: draft.description, start: sequence[0]?.id ?? "done",
    steps: [...sequence.map((step, i) => ({ ...step, next: sequence[i + 1]?.id ?? "done" })), { id: "done", kind: "complete", text: draft.completion }],
  };
}

export function definitionToDraft(def: WalkthroughDef, registry: SemanticRegistry): EditorDraft | null {
  const end = def.steps.at(-1);
  if (end?.kind !== "complete") return null;
  const steps = def.steps.flatMap<EditorStep>(step => step.kind === "guide"
    ? [{ target: step.target, wait: step.wait, text: step.text, ...(step.verify === undefined ? {} : { verify: step.verify }) }] : []);
  if (steps.length < 1 || steps.length > MAX_EDITOR_STEPS) return null;
  const draft = { title: def.title, description: def.description, steps, completion: end.text };
  const expected = draftToDefinition(draft, registry, def.id);
  if (!sameFields(def, expected) || def.steps.length !== expected.steps.length || !def.steps.every((step, i) => sameFields(step, expected.steps[i]!))) return null;
  return draft;
}
function sameFields(actual: object, expected: object): boolean {
  const entries = Object.entries(actual);
  const reference = Object.entries(expected);
  return entries.length === reference.length && reference.every(([key, value]) => entries.some(([k, v]) => k === key && (key === "steps" || v === value)));
}

export interface DraftProblem { field: string; message: string; step?: number }
const problem = copy.admin.problem;
function describe(issue: string, draft: EditorDraft): DraftProblem {
  const [, stepNumber, detail] = /^[^.]+\.s(\d+): (.+)$/.exec(issue) ?? [];
  if (stepNumber !== undefined) {
    const step = Number(stepNumber) - 1;
    if (detail === "unknown target") return { step, field: "target", message: draft.steps[step]?.target === "" ? problem.target : problem.unknownTarget };
    if (detail === "target does not allow highlight") return { step, field: "target", message: problem.unknownTarget };
    if (detail?.startsWith("wait ")) return { step, field: "wait", message: problem.wait };
    if (detail === "unknown postcondition") return { step, field: "verify", message: problem.verify };
    if (detail?.startsWith("text must")) return { step, field: "text", message: problem.text };
  }
  if (issue.includes(".done: text must")) return { field: "completion", message: problem.completion };
  if (issue.includes(": title must")) return { field: "title", message: problem.title };
  if (issue.includes(": description must")) return { field: "description", message: problem.description };
  return { field: "", message: problem.general };
}

/** `postconditions` are the names the SELECTED application declares; the reference application's list is only the default. */
export function validateDraft(draft: EditorDraft, registry: SemanticRegistry, id?: string, postconditions: readonly string[] = POSTCONDITION_NAMES):
  { ok: true; definition: WalkthroughDef } | { ok: false; problems: readonly DraftProblem[] } {
  if (draft.steps.length < 1 || draft.steps.length > MAX_EDITOR_STEPS) return { ok: false, problems: [{ field: "", message: problem.steps }] };
  const def = draftToDefinition(draft, registry, id);
  try { return { ok: true, definition: createWalkthroughCatalog(registry, postconditions, [def]).get(def.id)! }; }
  catch (error) {
    return { ok: false, problems: error instanceof WalkthroughCatalogError ? error.issues.map(issue => describe(issue, draft)) : [{ field: "", message: problem.general }] };
  }
}
