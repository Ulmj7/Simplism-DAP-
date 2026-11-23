/**
 * @dap/contracts: define-action.ts — the typed authoring helper for actions (T022).
 *
 * `defineAction` is a type-level identity: it takes a developer-authored ActionDefinition and
 * returns it unchanged, preserving its parameter generic so the definition "stays fully typed
 * where it is authored" (FR-009). It has no runtime behavior. The read-only ActionRegistry
 * (built once at startup, in @dap/security) is what wraps registered definitions into
 * `RegisteredAction` values with their definition hash.
 *
 * The model can never call this at runtime to add or change actions; it is a compile-time
 * authoring surface only (Constitution: IV, VII, VIII, XVI).
 */
import type { ActionDefinition } from "./action-definition.js";

/**
 * Author a fully-typed action definition. `TParams` is inferred from the `inputSchema`, so the
 * returned definition retains its parameter typing (rather than being erased to `unknown`).
 */
export function defineAction<TParams = unknown>(
  definition: ActionDefinition<TParams>,
): ActionDefinition<TParams> {
  return definition;
}
