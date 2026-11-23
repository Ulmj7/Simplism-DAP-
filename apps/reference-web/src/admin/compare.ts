import type { Step, WalkthroughDef } from "@dap/walkthrough";

export interface FieldChange { readonly field: string; readonly before: string; readonly after: string }
export interface StepChange {
  readonly id: string;
  readonly kind: "added" | "removed" | "updated";
  readonly before?: number;
  readonly after?: number;
  readonly moved: boolean;
  readonly fields: readonly FieldChange[];
}

const fieldsOf = (step: Step) => ({
  Kind: step.kind,
  Instruction: step.text,
  Route: step.kind === "navigate" ? step.route : undefined,
  Target: step.kind === "guide" ? step.target : undefined,
  Interaction: step.kind === "guide" ? step.wait : undefined,
  Verification: step.kind === "guide" ? step.verify : undefined,
  "Next step": step.kind === "complete" ? undefined : step.next,
  Recovery: step.kind === "complete" ? undefined : step.recover,
  "Attempt limit": step.kind === "complete" ? undefined : step.maxAttempts,
  "Target wait (ms)": step.kind === "guide" ? step.targetWaitMs : undefined,
});

function changes(before: Record<string, string | number | undefined>, after: typeof before): FieldChange[] {
  return Object.keys(before).flatMap(field => before[field] === after[field]
    ? [] : [{ field, before: String(before[field] ?? "—"), after: String(after[field] ?? "—") }]);
}

/** Compare authored identities. Additions/removals don't count as moving the surviving steps. */
export function compareWorkflows(before: WalkthroughDef, after: WalkthroughDef): { metadata: FieldChange[]; steps: StepChange[] } {
  const old = new Map(before.steps.map((step, index) => [step.id, { step, index }]));
  const next = new Map(after.steps.map((step, index) => [step.id, { step, index }]));
  const oldOrder = [...old.keys()].filter(id => next.has(id));
  const newOrder = [...next.keys()].filter(id => old.has(id));
  const steps: StepChange[] = [];
  for (const [id, { step, index }] of next) {
    const previous = old.get(id);
    if (!previous) { steps.push({ id, kind: "added", after: index + 1, moved: false, fields: [] }); continue; }
    const moved = oldOrder.indexOf(id) !== newOrder.indexOf(id);
    const fields = changes(fieldsOf(previous.step), fieldsOf(step));
    if (moved || fields.length > 0) steps.push({ id, kind: "updated", before: previous.index + 1, after: index + 1, moved, fields });
  }
  for (const [id, { index }] of old) if (!next.has(id)) steps.push({ id, kind: "removed", before: index + 1, moved: false, fields: [] });
  return {
    metadata: changes({ Title: before.title, Description: before.description, Start: before.start }, { Title: after.title, Description: after.description, Start: after.start }),
    steps,
  };
}
