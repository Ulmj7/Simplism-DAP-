/**
 * Authored walkthrough ids (Feature 004). A maintainer never types an id: the host generates `wt-` + 12 lowercase hex characters. The same shape is checked by the
 * executors and by the database (migration 070), and three further ids are refused: the reserved preview id `wt-preview` and every built-in id (the guides that live in
 * code). A collision with a built-in id is therefore impossible by shape, and is still refused explicitly so the rule survives a change of shape.
 */
import { randomBytes } from "node:crypto";
import { DEMO_WALKTHROUGH_SUMMARIES } from "../guidance/walkthrough-summaries.js";

export const AUTHORED_ID = /^wt-[a-f0-9]{12}$/;
/** The id the browser's Preview uses for the draft it remounts; never storable. */
export const PREVIEW_ID = "wt-preview";
export const BUILT_IN_IDS: ReadonlySet<string> = new Set(DEMO_WALKTHROUGH_SUMMARIES.map((summary) => summary.id));

/** `true` only for a storable authored id: the generated shape, not the preview id, not a built-in id. */
export function isAuthoredId(value: unknown): value is string {
  return typeof value === "string" && AUTHORED_ID.test(value) && value !== PREVIEW_ID && !BUILT_IN_IDS.has(value);
}

/** A fresh authored id. `random` is injectable for tests; the default is the OS random source. */
export function generateWalkthroughId(random: (size: number) => Buffer = randomBytes): string {
  const id = `wt-${random(6).toString("hex")}`;
  if (!isAuthoredId(id)) throw new Error("The id source did not produce an authored id");
  return id;
}
