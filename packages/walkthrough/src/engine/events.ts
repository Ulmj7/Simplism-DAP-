/**
 * Semantic events: the only thing the runtime accepts from the outside. They are presentation-neutral plain data, and they never carry a value:
 * an `input` event says only whether the field is non-empty.
 */
import type { SemanticRegistry } from "../semantic/types.js";

export type SemanticEvent =
  | { readonly type: "click"; readonly id: string }
  | { readonly type: "input"; readonly id: string; readonly nonEmpty: boolean }
  | { readonly type: "routeChanged"; readonly route: string }
  | { readonly type: "targetAvailable"; readonly id: string }
  | { readonly type: "targetGone"; readonly id: string }
  /** The user acknowledged the current guidance ("Got it"). Carries nothing. */
  | { readonly type: "ack" };

const SHAPES: Readonly<Record<string, readonly string[]>> = {
  click: ["type", "id"],
  input: ["type", "id", "nonEmpty"],
  routeChanged: ["type", "route"],
  targetAvailable: ["type", "id"],
  targetGone: ["type", "id"],
  ack: ["type"],
};

/**
 * A strictly validated copy of `raw`, or `null`. Unknown shapes, unregistered ids or routes, extra or hidden properties (prototype-pollution keys,
 * symbols, accessors), non-boolean `nonEmpty` and anything unreadable give `null`. It never throws and never copies a field it does not know.
 */
export function parseSemanticEvent(raw: unknown, registry: SemanticRegistry): SemanticEvent | null {
  try {
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) return null;
    const proto = Object.getPrototypeOf(raw) as unknown;
    if (proto !== Object.prototype && proto !== null) return null;
    const keys = Reflect.ownKeys(raw);
    const data: Record<string, unknown> = {};
    for (const key of keys) {
      if (typeof key !== "string") return null;
      const descriptor = Object.getOwnPropertyDescriptor(raw, key);
      if (descriptor === undefined || !("value" in descriptor)) return null;
      data[key] = descriptor.value;
    }
    const type = data.type;
    if (typeof type !== "string" || !Object.hasOwn(SHAPES, type)) return null;
    const allowed = SHAPES[type]!;
    if (keys.length !== allowed.length || !keys.every((key) => allowed.includes(key as string))) return null;
    switch (type) {
      case "ack": return Object.freeze({ type });
      case "routeChanged": return typeof data.route === "string" && registry.routes.includes(data.route) ? Object.freeze({ type, route: data.route }) : null;
      case "input": return typeof data.id === "string" && registry.has(data.id) && typeof data.nonEmpty === "boolean" ? Object.freeze({ type, id: data.id, nonEmpty: data.nonEmpty }) : null;
      default: return typeof data.id === "string" && registry.has(data.id) ? Object.freeze({ type: type as "click" | "targetAvailable" | "targetGone", id: data.id }) : null;
    }
  } catch { return null; }
}
