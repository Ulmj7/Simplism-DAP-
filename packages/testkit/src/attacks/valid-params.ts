import { VALID_PARAMS } from "../test-capabilities/index.js";

const PARAMS: Readonly<Record<string, unknown>> = { ...VALID_PARAMS, testMediumOptOut: VALID_PARAMS.testMediumDraft };

/** A fresh copy of the capability's valid parameters (the test kit's `VALID_PARAMS`), or an empty object for one without any. */
export function validParamsFor(actionId: string): Record<string, unknown> {
  const found = PARAMS[actionId];
  return found === undefined ? {} : JSON.parse(JSON.stringify(found)) as Record<string, unknown>;
}

/** The same parameters aimed at another document id (for capabilities that target a document). */
export function validParamsForDocument(actionId: string, documentId: string): Record<string, unknown> {
  return { ...validParamsFor(actionId), documentId };
}

/** Names of the string-valued parameters a hostile text can be put into. */
export function stringParamNames(actionId: string): readonly string[] {
  return Object.entries(validParamsFor(actionId)).filter(([, value]) => typeof value === "string").map(([key]) => key);
}
