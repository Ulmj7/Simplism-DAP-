/**
 * `@dap/walkthrough/authoring` (Feature 004, T402): the ONE validator surface a trusted host may use to check an authored walkthrough definition.
 *
 * A definition is valid exactly when `createWalkthroughCatalog(registry, postconditionNames, [definition])` accepts it: the same code and the same rules the
 * runtime applies, never a copy. This entry point is pure and re-exports ONLY that validator, the registry factory it needs, the id check, the text and step
 * limits, and the types needed to call them. It deliberately offers NO runtime, state machine, ports, presenter, overlay, DOM or event bridge: the
 * package stays a leaf, and importing this subpath cannot start, drive or render a walkthrough.
 */
export { createSemanticRegistry, MAX_LABEL, MAX_DESCRIPTION } from "../semantic/registry.js";
export type { SemanticElementDef, SemanticOperation, SemanticPrivacy, SemanticRegistry, SemanticRegistryInput, SemanticRole } from "../semantic/types.js";
export { createWalkthroughCatalog, WalkthroughCatalogError, isValidId } from "../walkthrough/catalog.js";
export type { WalkthroughCatalog, WalkthroughSummary } from "../walkthrough/catalog.js";
export { MAX_ATTEMPTS_LIMIT, MAX_TARGET_WAIT_MS, MAX_TEXT, MAX_TITLE } from "../walkthrough/definition.js";
export type { CompleteStep, GuideStep, NavigateStep, PostconditionName, Step, StepId, WaitKind, WalkthroughDef } from "../walkthrough/definition.js";
