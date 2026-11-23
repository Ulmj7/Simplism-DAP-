import { createWalkthroughCatalog } from "@dap/walkthrough";
import { expect, it } from "vitest";
import { POSTCONDITION_NAMES } from "../postconditions.js";
import { createDemoRegistry } from "../semantic-ui.js";
import { definitionToDraft, draftToDefinition, validateDraft } from "./draft.js";
import type { EditorDraft } from "./draft.js";

const registry = createDemoRegistry();
const draft: EditorDraft = {
  title: "Check the demo", description: "Find two demo controls.", completion: "Done.",
  steps: [
    { target: "nav.settings", wait: "click", text: "Open settings.", verify: "route.settings" },
    { target: "settings.securityPanel", wait: "ack", text: "Read this panel." },
    { target: "settings.advancedToggle", wait: "click", text: "Open advanced settings." },
  ],
};

it("compiles one navigation per route change, validates a temporary id and round-trips regardless of JSON key order", () => {
  const candidate = draftToDefinition(draft, registry);
  expect(candidate.steps.map(step => step.id)).toEqual(["n1", "s1", "n2", "s2", "s3", "done"]);
  expect(validateDraft(draft, registry)).toEqual({ ok: true, definition: candidate });
  const json = { ...candidate, steps: candidate.steps.map(step => Object.fromEntries(Object.entries(step).reverse())) };
  expect(definitionToDraft(json as unknown as typeof candidate, registry)).toEqual(draft);
});

it("refuses recover, branching, extra kinds and guides outside the editor's step count", () => {
  const candidate = draftToDefinition(draft, registry);
  const modified = (delta: object) => ({ ...candidate, steps: candidate.steps.map(step => step.id === "s1" ? { ...step, ...delta } : step) });
  expect(definitionToDraft(modified({ recover: "n2" }), registry)).toBeNull();
  expect(definitionToDraft(modified({ next: "s3" }), registry)).toBeNull();
  expect(definitionToDraft({ ...candidate, steps: [...candidate.steps, candidate.steps[0]!] }, registry)).toBeNull();
  expect(definitionToDraft(draftToDefinition({ ...draft, steps: Array(9).fill(draft.steps[0]) }, registry), registry)).toBeNull();
});

it("uses the catalog to reject admin routes and targets, unsupported waits and unsafe text", () => {
  const candidate = draftToDefinition(draft, registry);
  const admin = { ...candidate, steps: candidate.steps.map(step => step.id === "n1" ? { ...step, route: "editor" } : step) };
  expect(() => createWalkthroughCatalog(registry, POSTCONDITION_NAMES, [admin])).toThrow(/unknown route/);
  const attempted = { ...draft, title: "<script>Canary", steps: [
    { ...draft.steps[0]!, target: "admin.editor" }, { ...draft.steps[1]!, wait: "click" as const },
  ] };
  const result = validateDraft(attempted, registry);
  expect(result).toEqual({ ok: false, problems: [
    { field: "title", message: "Enter a title in plain text." },
    { step: 0, field: "target", message: "Select an available target." },
    { step: 1, field: "wait", message: "This interaction is not available for this target." },
  ] });
});
