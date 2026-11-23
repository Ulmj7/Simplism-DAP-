/**
 * T311: the public parser for the semantic context that arrives from the browser (untrusted). It is a thin wrapper over the strict context schema of the
 * guidance request (`request.ts`), which mirrors Feature 002's `runtime.context()` shape: `{ route, elements: [{ id, role, label, description, privacy,
 * available }] }`, at most 60 elements, plain text, and no other key at any level. There is exactly one schema; this file adds no second one.
 *
 * The result is a deeply frozen copy of the validated input, or `null`. Nothing is added, trimmed or repaired, the offending value and the schema error
 * are never returned, and it never throws. The untrusted value is first copied into a bounded plain-data snapshot (own enumerable data properties, read
 * once), so a getter, a Proxy that disagrees with itself, a cycle or an oversize value is refused.
 */
import { contextSchema } from "./request.js";
import { snapshotPlainData } from "./snapshot.js";
import type { SemanticContextInput } from "./types.js";

const deepFreeze = <T>(value: T): T => {
  if (value !== null && typeof value === "object") { for (const child of Object.values(value)) deepFreeze(child); Object.freeze(value); }
  return value;
};

export function parseSemanticContextInput(raw: unknown): SemanticContextInput | null {
  try {
    const snapshot = snapshotPlainData(raw);
    if (!snapshot.ok) return null;
    const parsed = contextSchema.safeParse(snapshot.value);
    return parsed.success ? deepFreeze(parsed.data as SemanticContextInput) : null;
  } catch { return null; }
}
