import { createWalkthroughCatalog, WalkthroughCatalogError } from "@dap/walkthrough";
import type { SemanticRegistry, Step, WaitKind, WalkthroughDef } from "@dap/walkthrough";
import { copy } from "../copy.js";
import { POSTCONDITION_NAMES } from "../postconditions.js";

export const MAX_EDITOR_STEPS = 8;
export const PREVIEW_ID = "wt-preview";
const LOCAL_ID = "wt-local-draft";

export interface EditorStep { id?: string; recover?: string; navigateRecover?: string; target: string; wait: WaitKind | ""; text: string; verify?: string }
export interface EditorDraft { title: string; description: string; steps: EditorStep[]; completion: string }
export const emptyStep = (): EditorStep => ({ target: "", wait: "ack", text: "" });
export const emptyDraft = (): EditorDraft => ({ title: "", description: "", steps: [emptyStep()], completion: "" });

export function draftToDefinition(draft: EditorDraft, registry: SemanticRegistry, id = LOCAL_ID): WalkthroughDef {
  return compileDraft(draft, target => registry.get(target)?.route, id);
}

function compileDraft(draft: EditorDraft, routeFor: (target: string, index: number) => string | undefined, id: string): WalkthroughDef {
  const sequence: (Omit<Extract<Step, {kind: "navigate"}>, "next"> | Omit<Extract<Step, {kind: "guide"}>, "next">)[] = [];
  const routes = draft.steps.map((step, index) => routeFor(step.target, index));
  const recoveryLinks = new Set(draft.steps.flatMap(step => [step.recover, step.navigateRecover]));
  const navIds = new Map(draft.steps.flatMap((step, index) => {
    const route = routes[index];
    const id = step.id ?? `s${index + 1}`;
    const navId = `n${id.slice(1)}`;
    if (route === undefined || (index > 0 && route === routes[index - 1] && !step.navigateRecover && !recoveryLinks.has(navId))) return [];
    return [[id, navId]] as const;
  }));
  draft.steps.forEach(({ id: savedId, target, wait, text, verify, recover, navigateRecover }, index) => {
    const route = routes[index];
    const stepId = savedId ?? `s${index + 1}`;
    const navId = navIds.get(stepId);
    if (route !== undefined && navId !== undefined) sequence.push({ kind: "navigate", id: navId, route, ...(navigateRecover === undefined ? {} : { recover: navigateRecover }) });
    // An empty editor wait is rejected by the catalog like any other invalid form input.
    sequence.push({ kind: "guide", id: stepId, target, wait: wait as WaitKind, text, ...(recover === undefined ? {} : { recover }), ...(verify === undefined ? {} : { verify }) });
  });
  return {
    id, title: draft.title, description: draft.description, start: sequence[0]?.id ?? "done",
    steps: [...sequence.map((step, i) => ({ ...step, next: sequence[i + 1]?.id ?? "done" })), { id: "done", kind: "complete", text: draft.completion }],
  };
}

export function definitionToDraft(def: WalkthroughDef, registry: SemanticRegistry): EditorDraft | null {
  const end = def.steps.at(-1);
  if (end?.kind !== "complete") return null;
  const ids = new Set(def.steps.map(step => step.id));
  if (ids.size !== def.steps.length || def.steps.some(step => step.kind !== "complete" && step.recover !== undefined
    && (step.recover === step.id || step.recover === end.id || !ids.has(step.recover)))) return null;
  const steps = def.steps.flatMap<EditorStep>((step, index) => {
    if (step.kind !== "guide") return [];
    const before = def.steps[index - 1];
    const navigateRecover = before?.kind === "navigate" ? before.recover : undefined;
    return [{
      id: step.id, target: step.target, wait: step.wait, text: step.text,
      ...(step.verify === undefined ? {} : { verify: step.verify }),
      ...(step.recover === undefined ? {} : { recover: step.recover }),
      ...(navigateRecover === undefined ? {} : { navigateRecover }),
    }];
  });
  if (steps.some(step => !/^s[1-9]\d*$/u.test(step.id ?? ""))) return null;
  if (steps.length < 1 || steps.length > MAX_EDITOR_STEPS) return null;
  if (steps.every((step, index) => step.id === `s${index + 1}` && step.recover === undefined && step.navigateRecover === undefined)) {
    for (const step of steps) delete step.id;
  }
  const draft = { title: def.title, description: def.description, steps, completion: end.text };
  // Disabled targets remain in saved steps. Infer their authored route only for the lossless
  // shape check, so the editor can show validation errors against the current active registry.
  let lastRoute: string | undefined;
  const authoredRoutes: (string | undefined)[] = [];
  for (const step of def.steps) {
    if (step.kind === "navigate") lastRoute = step.route;
    if (step.kind === "guide") authoredRoutes.push(lastRoute);
  }
  const expected = compileDraft(draft, (target, index) => {
    const route = authoredRoutes[index];
    return registry.get(target)?.route ?? (route && registry.routes.includes(route) ? route : undefined);
  }, def.id);
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
  const [, stepNumber, detail] = /^[^.]+\.(s[1-9]\d*): (.+)$/.exec(issue) ?? [];
  if (stepNumber !== undefined) {
    const step = draft.steps.findIndex((item, index) => (item.id ?? `s${index + 1}`) === stepNumber);
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
