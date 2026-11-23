/**
 * Walkthrough definitions: the whole "language" is three step kinds. A definition is pure data; checks are named postconditions the host supplies.
 * There are no conditions, loops, variables or expressions, and no input path for a model.
 */
export type StepId = string;
export type PostconditionName = string;
export type WaitKind = "click" | "input" | "ack";

export const DEFAULT_MAX_ATTEMPTS = 3;
export const DEFAULT_TARGET_WAIT_MS = 1000;
export const MAX_ATTEMPTS_LIMIT = 10;
export const MAX_TARGET_WAIT_MS = 10_000;
export const MAX_TITLE = 80;
export const MAX_TEXT = 240;

export interface GuideStep {
  readonly id: StepId;
  readonly kind: "guide";
  /** A registered semantic id. */
  readonly target: string;
  readonly text: string;
  readonly wait: WaitKind;
  /** Name of a host postcondition checked after the wait is satisfied. */
  readonly verify?: PostconditionName;
  readonly next: StepId;
  /** Where to go when the target never appears or the postcondition fails. Never itself, never a `complete` step. */
  readonly recover?: StepId;
  /** How long to wait for the target to become available, 0..10000 ms (default 1000). */
  readonly targetWaitMs?: number;
  /** How often this step may be entered, 1..10 (default 3). */
  readonly maxAttempts?: number;
}
/**
 * Without `text` the runtime navigates itself (through the router port). With `text` the user is asked to navigate (presented with `expects: "route"`)
 * and the step completes on the matching `routeChanged` event. Either way the route is verified afterwards.
 */
export interface NavigateStep {
  readonly id: StepId;
  readonly kind: "navigate";
  readonly route: string;
  readonly text?: string;
  readonly next: StepId;
  readonly recover?: StepId;
  readonly maxAttempts?: number;
}
export interface CompleteStep {
  readonly id: StepId;
  readonly kind: "complete";
  readonly text: string;
}
export type Step = GuideStep | NavigateStep | CompleteStep;

export interface WalkthroughDef {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly start: StepId;
  readonly steps: readonly Step[];
}

/** Identity helper: type-checks a definition where it is written. */
export const defineWalkthrough = <T extends WalkthroughDef>(definition: T): T => definition;
