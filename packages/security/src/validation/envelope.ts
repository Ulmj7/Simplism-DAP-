/**
 * @dap/security: validation/envelope.ts
 *
 * T062 / FR-014. Strict envelope intake: exactly `{action, params}`.
 *
 * - `action` must be a string matching `^[a-z][A-Za-z0-9]{2,63}$`.
 * - `params` must be a plain object (deep-frozen by the parser).
 * - Any missing key, extra key (`callId`, `requestId`, `userConfirmed`, ...),
 *   or malformed field yields `INVALID_ACTION` with an existing ReasonCode.
 *   The one exception is a number that is not finite (ATK-PARAMS-10) or an
 *   integer literal a double cannot hold exactly, which are parameter faults:
 *   `INVALID_PARAMETERS` with `invalid_parameters`.
 * - The failure result carries (outcome, reason) and, for audit only, an
 *   `attemptedAction`: the action name the planner wrote, escaped to printable
 *   ASCII and bounded (see `auditableName`). It is absent when the name is not a
 *   string. The offending key or value is never echoed back to the planner
 *   (feedback is built from the outcome alone). Results are frozen.
 */
import type { JsonValue, ReasonCode } from "@dap/contracts";
import { scrubText } from "../audit/scrubber.js";
import { parseStrictJsonDeferred } from "./strict-json.js";
import type { NumberFault, StrictJsonCode, StrictJsonOptions } from "./strict-json.js";

/** Exact action-id grammar (D3). 3-64 chars, starts with a lowercase letter. */
const ACTION_ID_GRAMMAR = /^[a-z][A-Za-z0-9]{2,63}$/;
export const isActionIdGrammar = (text: unknown): text is string => typeof text === "string" && ACTION_ID_GRAMMAR.test(text);

/** Longest escaped name an audit record keeps. Equals the decision's own cap, so a decision never cuts an escape in half. */
export const ATTEMPTED_ACTION_MAX = 64;

/**
 * A planner-authored name made safe to store in an audit record: printable ASCII only, every other code point
 * (controls, newlines, look-alikes, zero-width and bidi characters) and the backslash itself written as `\u{hex}`,
 * so the text is unambiguous and cannot forge a line, a field or another name. Secret-shaped text is redacted before the cut.
 * Truncated on a whole-token boundary.
 */
export function auditableName(name: string): string {
  let out = "";
  // Secret-shaped text goes first, while the whole secret is still in view: a cut would leave half of it.
  for (const symbol of scrubText(name)) {
    const code = symbol.codePointAt(0) as number;
    const token = code >= 0x20 && code <= 0x7e && code !== 0x5c ? symbol : `\\u{${code.toString(16)}}`;
    if (out.length + token.length > ATTEMPTED_ACTION_MAX) break;
    out += token;
  }
  return out;
}

/**
 * Success exposes the action id and the frozen params. Failure is a fail-closed decision outcome with an
 * existing ReasonCode only: `INVALID_ACTION`, or `INVALID_PARAMETERS` for a non-finite number.
 */
export type EnvelopeFailure = {
  readonly ok: false;
  readonly outcome: "INVALID_ACTION" | "INVALID_PARAMETERS";
  readonly reason: ReasonCode;
  /** Audit only, already escaped and bounded; never shown to the planner. Absent when no string name could be read. */
  readonly attemptedAction?: string;
};
export type EnvelopeResult =
  | {
      readonly ok: true;
      readonly action: string;
      readonly params: Readonly<Record<string, JsonValue>>;
    }
  | EnvelopeFailure;

const failure = (outcome: EnvelopeFailure["outcome"], reason: ReasonCode, attemptedAction?: string): EnvelopeFailure =>
  Object.freeze(attemptedAction === undefined || attemptedAction.length === 0 ? { ok: false, outcome, reason } : { ok: false, outcome, reason, attemptedAction });
const malformed = (attemptedAction?: string): EnvelopeFailure => failure("INVALID_ACTION", "malformed_envelope", attemptedAction);

/**
 * Every structural strict-json failure maps to an existing outcome and ReasonCode. Only the size cap has its
 * own reason; everything else is a malformed envelope. A number fault is handled in `parseEnvelope`, after
 * the envelope's own shape has been judged.
 */
const STRICT_JSON_FAILURE: Record<Exclude<StrictJsonCode, NumberFault>, () => EnvelopeFailure> = {
  too_large: () => failure("INVALID_ACTION", "payload_too_large"),
  too_deep: malformed,
  duplicate_key: malformed,
  forbidden_key: malformed,
  not_plain: malformed,
  syntax: malformed,
};

/**
 * Strict intake of one proposal envelope (T062).
 *
 * Accepts a JSON text or already-parsed value, under the configured caps
 * (`maxPayloadBytes`, `maxJsonDepth`; the defaults are the research D12 values).
 * Returns the action id and deeply frozen params, or a fail-closed failure. The
 * failure result never contains the offending key or value.
 */
export function parseEnvelope(value: unknown, options: StrictJsonOptions = {}): EnvelopeResult {
  // Structure decides first: a number fault is deferred until the envelope is known to be well formed, so a
  // planner cannot choose its own outcome by putting a number fault ahead of a structural one.
  const parsed = parseStrictJsonDeferred(value, options);
  if (!parsed.ok) return STRICT_JSON_FAILURE[parsed.code]();
  // With a deferred number fault only the shape is judged here; it is never returned as data.
  const candidate = parsed.numberFault ? parsed.shape : parsed.value;
  if (candidate === null || typeof candidate !== "object" || Array.isArray(candidate)) return malformed();
  const record = candidate as Record<string, JsonValue>;
  // For audit only: whatever string the planner put in `action`, escaped. It never changes the decision.
  const written = Object.hasOwn(record, "action") ? record.action : undefined;
  const attempted = typeof written === "string" ? auditableName(written) : undefined;
  // Exactly two keys: action and params. Anything else is invalid.
  if (Object.keys(record).length !== 2 || !Object.hasOwn(record, "action") || !Object.hasOwn(record, "params")) return malformed(attempted);
  const { action, params } = record;
  if (!isActionIdGrammar(action)) return malformed(attempted);
  if (params === null || typeof params !== "object" || Array.isArray(params)) return malformed(attempted);
  // Only now is a deferred number fault a parameter fault; `params` holds placeholders in that case and is never returned.
  if (parsed.numberFault) return failure("INVALID_PARAMETERS", "invalid_parameters", attempted);
  return Object.freeze({ ok: true, action, params: params as Readonly<Record<string, JsonValue>> });
}
