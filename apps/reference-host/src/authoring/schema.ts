/**
 * The authoring schema (Feature 004, T403): ONE strict zod object set that holds the host's authoring BOUNDS. It is used twice: by `validateDefinition` (the first
 * step of validation) and as the capability `inputSchema` of `saveWalkthroughDraft` / `setWalkthroughStatus`, so the Gateway and the executor can never disagree about
 * the shape. It satisfies the Feature 001 `inspectInputSchema` rules: every object is `additionalProperties: false`, every string has a `maxLength`, every array has
 * a `maxItems`, and no parameter has a reserved name.
 *
 * It states only SHAPE and SIZE: which keys exist (the Feature 002 language and nothing else), how long strings may be, at most 24 steps in total and between 1 and 8
 * `guide` steps. It does NOT restate the language's rules: whether a target exists, a wait is allowed, a route or postcondition is known, `next`/`recover` make sense
 * or every step is reachable is decided by the ONE Feature 002 validator (`createWalkthroughCatalog`), called by `validate.ts`. Free-form fields (`kind`, `wait`, ...) are
 * therefore plain bounded strings here, so the validator's own wording is what a maintainer sees. Nothing here can add a step kind, a branch or a field.
 */
import { z } from "zod";
import { MAX_TEXT, MAX_TITLE } from "@dap/walkthrough/authoring";
import { APPLICATION_ID } from "../studio/applications.js";
import { AUTHORED_ID } from "./ids.js";

export const MAX_STEPS = 24;
export const MAX_GUIDE_STEPS = 8;
export const MIN_GUIDE_STEPS = 1;
/** Bounded string fields. The grammar of ids, targets and names is the validator's job; these are size limits. */
const bounded = (max: number) => z.string().min(1).max(max);
const idLike = bounded(64);
/** A loose integer bound; the validator states the real range (0..10000 ms, 1..10 attempts) in its own words. */
const smallInt = z.number().int().min(0).max(1_000_000);

/**
 * One step of any kind. The union of the three kinds' field names, all optional but `id` and `kind`: the validator checks, per kind, which are required and which
 * are foreign ("unknown field"). `.strict()` here means no key outside the language can pass through.
 */
export const stepSchema = z.strictObject({
  id: idLike,
  kind: bounded(16),
  target: bounded(128).optional(),
  route: bounded(64).optional(),
  text: bounded(MAX_TEXT).optional(),
  wait: bounded(16).optional(),
  verify: bounded(64).optional(),
  next: idLike.optional(),
  recover: idLike.optional(),
  targetWaitMs: smallInt.optional(),
  maxAttempts: smallInt.optional(),
});

export const definitionSchema = z.strictObject({
  id: idLike,
  title: bounded(MAX_TITLE),
  description: bounded(MAX_TEXT),
  start: idLike,
  steps: z.array(stepSchema).min(1).max(MAX_STEPS),
}).superRefine((definition, context) => {
  const guides = definition.steps.filter((step) => step.kind === "guide").length;
  if (guides < MIN_GUIDE_STEPS || guides > MAX_GUIDE_STEPS) context.addIssue({ code: "custom", path: ["steps"], message: "guide-step-count" });
});

/** The id of an authored walkthrough as the capabilities take it: the generated shape (15 characters). Built-in and preview ids are refused by the executor and the database. */
export const walkthroughIdSchema = z.string().max(15).regex(AUTHORED_ID);
export const STATUSES = ["draft", "published"] as const;
export type WalkthroughStatus = (typeof STATUSES)[number];
/** A closed enum that also states a `maxLength` (Feature 001 requires every string in an input schema to be bounded; a plain enum would not say so). */
const statusSchema = z.string().max(9).pipe(z.enum(STATUSES));

/** The application a draft belongs to: the generated shape (`app-` + 12 hex, 16 characters). Whether it exists, is enabled and belongs to the caller's tenant is the executor's job. */
export const applicationIdSchema = z.string().max(16).regex(APPLICATION_ID);
/** `saveWalkthroughDraft` input. */
export const isRevision = (value: unknown): value is number => typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 1_000_000;
export const saveInputSchema = z.strictObject({ walkthroughId: walkthroughIdSchema, applicationId: applicationIdSchema, definition: definitionSchema, expectedRevision: smallInt });
/** `setWalkthroughStatus` input. */
export const statusInputSchema = z.strictObject({ walkthroughId: walkthroughIdSchema, status: statusSchema, expectedRevision: smallInt.min(1).optional() });

export type SaveInput = z.infer<typeof saveInputSchema>;
export type StatusInput = z.infer<typeof statusInputSchema>;

export const reviseInputSchema = z.strictObject({ walkthroughId: walkthroughIdSchema });
export const restoreInputSchema = z.strictObject({ walkthroughId: walkthroughIdSchema, version: smallInt.min(1) });
export type ReviseInput = z.infer<typeof reviseInputSchema>;
export type RestoreInput = z.infer<typeof restoreInputSchema>;
