/**
 * The strict schema for what a model may say. Exactly four kinds; every object is strict, so any other property, of any name, makes the whole decision
 * invalid. Nothing is trimmed, coerced, defaulted or repaired, and the parser returns neither the offending value nor a schema error.
 */
import { z } from "zod";
import { MAX_ANSWER_CHARS, MAX_MESSAGE_CHARS, MAX_SOURCES } from "./limits.js";
import { snapshotPlainData } from "./snapshot.js";
import { SOURCE_ID, WALKTHROUGH_ID, isId, isPlainText } from "./text.js";
import type { GuidanceDecision } from "./types.js";

const plain = (max: number) => z.string().refine((v) => isPlainText(v, max));
const decisionSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("start_walkthrough"), walkthroughId: z.string().refine((v) => isId(v, WALKTHROUGH_ID)) }),
  z.strictObject({ kind: z.literal("answer"), answer: plain(MAX_ANSWER_CHARS), sources: z.array(z.string().refine((v) => isId(v, SOURCE_ID))).max(MAX_SOURCES) }),
  z.strictObject({ kind: z.literal("clarify"), message: plain(MAX_MESSAGE_CHARS) }),
  z.strictObject({ kind: z.literal("unsupported"), message: plain(MAX_MESSAGE_CHARS) }),
]);

const deepFreeze = <T>(value: T): T => {
  if (value !== null && typeof value === "object") { for (const child of Object.values(value)) deepFreeze(child); Object.freeze(value); }
  return value;
};

/** A validated, frozen decision, or `null`. Never throws. */
export function parseGuidanceDecision(raw: unknown): GuidanceDecision | null {
  try {
    const snapshot = snapshotPlainData(raw);
    if (!snapshot.ok) return null;
    const parsed = decisionSchema.safeParse(snapshot.value);
    return parsed.success ? deepFreeze(parsed.data as GuidanceDecision) : null;
  } catch { return null; }
}
