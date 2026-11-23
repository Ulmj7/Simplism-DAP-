/**
 * The runtime's ports. All of them are supplied by the host (the later UI adapter and the app); the core imports no DOM and holds no element.
 * Throws and invalid availability/route/check results fail closed. Void ports are synchronous trusted adapters;
 * asynchronous checks are bounded only when the injected timer works. No same-process callback can be forcibly preempted.
 */
import type { PresentationEffect } from "./machine.js";

export type TargetAvailability = "available" | "unavailable";
export type Cancel = () => void;

export interface TargetPort {
  /** Whether the element behind a registered semantic id can be shown to the user right now. The host may also push changes with `targetAvailable` / `targetGone` events. */
  resolve(id: string): TargetAvailability;
}
export interface RouterPort {
  current(): string;
  navigate(route: string): void;
}
export interface PresenterPort {
  /** Renders a `present` effect, or removes what was rendered for a `clear` effect. Rendering is entirely the host's business. */
  apply(effect: PresentationEffect): void;
}
export interface TimerPort {
  set(callback: () => void, ms: number): Cancel;
}
/** Named trusted checks over structured application state. Success is exactly `true`. */
export type Postconditions = Readonly<Record<string, () => boolean | Promise<boolean>>>;
