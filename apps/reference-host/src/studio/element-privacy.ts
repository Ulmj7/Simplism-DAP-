/**
 * The host's privacy gate for registering a target (Studio V1B, D6). Two independent checks, both server-side, neither trusting the browser UI:
 *
 *   1. `effectivePrivacyOfFacts` mirrors the walkthrough package's `effectivePrivacy` (packages/walkthrough/src/privacy/privacy.ts), which the host may not import: an element that is ignored,
 *      private or redacted by its own markup, an input of type `password` or `hidden`, or an input whose `autocomplete` names a payment card or a credential is NOT public. The adapter cannot read the
 *      tag name (always null), so an element that has an `inputType` is treated as an input. Ancestor `data-ai-ignore` cannot be read from outside the page: the runtime's own privacy model still
 *      enforces it at run time (documented limit).
 *   2. `secretNameHit` is a HEURISTIC on the accessible name: a case-insensitive whole-word match against a fixed list. It cannot prove a control is harmless; it only refuses the obvious ones.
 *
 * `parity` with the walkthrough package is asserted by a test that runs the same fact vectors through both implementations.
 */
import type { ElementFacts } from "@dap/browser-runtime";

export type HostPrivacy = "public" | "ignore" | "private" | "redact";

export function effectivePrivacyOfFacts(facts: ElementFacts): HostPrivacy {
  if (facts.dataAiIgnore) return "ignore";
  const type = typeof facts.inputType === "string" ? facts.inputType.trim().toLowerCase() : "";
  const isInput = facts.tagName === null ? type !== "" : String(facts.tagName).toLowerCase() === "input";
  if (isInput && (type === "password" || type === "hidden")) return "ignore";
  const autocomplete = typeof facts.autocomplete === "string" ? facts.autocomplete.trim().toLowerCase().split(/\s+/) : [];
  if (autocomplete.some((token) => token.startsWith("cc-") || token === "current-password" || token === "new-password" || token === "one-time-code")) return "ignore";
  if (facts.dataAiPrivate) return "private";
  if (facts.dataAiRedact) return "redact";
  return "public";
}

/** The documented deny-list (D6): whole words, case-insensitive, separators between the words of a phrase may be spaces, hyphens or underscores, a plural `s` is allowed. */
export const SECRET_NAME_WORDS: readonly string[] = Object.freeze([
  "password", "passcode", "secret", "token", "api key", "card number", "cvv", "cvc", "ssn", "social security", "one-time code", "otp",
]);
const SEPARATOR = "[\\s_-]*";
const PATTERN = new RegExp(
  `(?<![A-Za-z0-9])(?:${SECRET_NAME_WORDS.map((word) => word.split(/[\s-]+/).join(SEPARATOR)).join("|")})s?(?![A-Za-z0-9])`, "iu");

export const secretNameHit = (name: string): boolean => PATTERN.test(name);
