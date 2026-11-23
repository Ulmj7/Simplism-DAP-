/**
 * @dap/walkthrough: the pure, DOM-free core. A leaf package: it imports no other @dap/* package and has no runtime dependency.
 *
 * Feature 003 integration point (not built here): an AI-facing facade will expose ONLY `catalog.list()` and `startWalkthrough(id)` through a trusted
 * host adapter. The model never gets `dispatch`, `context` internals, the registry, the ports or a definition's steps.
 *
 * Presentation boundary: the runtime emits presentation-neutral effects (`PresentationEffect`) to a presenter port and receives `SemanticEvent`s through
 * `dispatch`. How effects look is the UI's business and lives outside this package's core.
 */
export { createSemanticRegistry, SemanticRegistryError, ID_PATTERN, MAX_LABEL, MAX_DESCRIPTION, isPlainText } from "./semantic/registry.js";
export { ROLES, OPERATIONS, PRIVACY_LEVELS } from "./semantic/types.js";
export type { SemanticElementDef, SemanticOperation, SemanticPrivacy, SemanticRegistry, SemanticRegistryInput, SemanticRole } from "./semantic/types.js";
export { ATTR_ID, ATTR_IGNORE, ATTR_PRIVATE, ATTR_REDACT, REDACTED_MARKER, buildSemanticContext, describeValue, effectivePrivacy } from "./privacy/privacy.js";
export type { EffectivePrivacy, ElementFacts, SemanticContext, SemanticContextElement, ValueView } from "./privacy/privacy.js";

export { defineWalkthrough, DEFAULT_MAX_ATTEMPTS, DEFAULT_TARGET_WAIT_MS } from "./walkthrough/definition.js";
export type { CompleteStep, GuideStep, NavigateStep, PostconditionName, Step, StepId, WaitKind, WalkthroughDef } from "./walkthrough/definition.js";
export { createWalkthroughCatalog, WalkthroughCatalogError } from "./walkthrough/catalog.js";
export type { WalkthroughCatalog, WalkthroughSummary } from "./walkthrough/catalog.js";

export { parseSemanticEvent } from "./engine/events.js";
export type { SemanticEvent } from "./engine/events.js";
export { transition } from "./engine/machine.js";
export type { Effect, EngineState, Expects, FailureReason, Input, InternalEffect, PresentationEffect, TransitionResult } from "./engine/machine.js";
export type { Cancel, Postconditions, PresenterPort, RouterPort, TargetAvailability, TargetPort, TimerPort } from "./engine/ports.js";
export { createWalkthroughRuntime, DEFAULT_VERIFY_TIMEOUT_MS } from "./engine/runtime.js";
export type { EngineSnapshot, RuntimeOptions, StartResult, Unsubscribe, WalkthroughRuntime } from "./engine/runtime.js";
