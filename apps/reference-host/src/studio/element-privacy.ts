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

/**
 * The documented deny-list (D6) and how a name is matched (H4). The name is NORMALISED first: Unicode NFKC (fullwidth and other compatibility forms become plain letters), lower-case, every Unicode
 * format/invisible character (zero-width, soft hyphen, word joiner, BOM, bidi marks) removed, and every space-like or control character turned into a plain space. Then two checks run:
 *
 *   (a) the whole-word pattern: a word of the list, separators between the words of a phrase may be spaces, hyphens or underscores, a plural `s` and DIGITS after it are allowed (`cvv2`, `password1`),
 *       but no letter on either side (so `Totp` and `Passport` are fine);
 *   (b) the SQUASHED check: every character that is not a letter or digit is removed. For the LONG words (password, passcode, secret, token, apikey, cardnumber, socialsecurity, onetimecode) the
 *       squashed name is searched as a substring, which also catches `mypassword`, `newPassword`, `p.a.s.s.w.o.r.d` and `p a s s w o r d`. For the SHORT words (cvv, cvc, ssn, otp) the whole squashed name
 *       must equal the word (optionally plural / digits: `s.s.n.`, `o t p`), so ordinary words that merely contain three letters are not hidden.
 *
 * A false positive only HIDES a control (fail closed): ordinary words that contain a long word (`secretary`, `tokenize`) are hidden too. Not caught: look-alike letters from other scripts
 * (a Cyrillic `a`), leet spellings (`p4ssword`), words in other languages, and secrets whose name says nothing. The heuristic complements the facts check, it does not replace it.
 */
export const SECRET_NAME_WORDS: readonly string[] = Object.freeze([
  "password", "passcode", "secret", "token", "api key", "card number", "cvv", "cvc", "ssn", "social security", "one-time code", "otp",
]);
const squashWord = (word: string): string => word.replace(/[^a-z0-9]/gu, "");
const SEPARATOR = "[\\s_-]*";
const PATTERN = new RegExp(
  `(?<!\\p{L})(?:${SECRET_NAME_WORDS.map((word) => word.split(/[\s-]+/u).join(SEPARATOR)).join("|")})s?(?!\\p{L})`, "u");
const LONG_SQUASHED: readonly string[] = Object.freeze(SECRET_NAME_WORDS.map(squashWord).filter((word) => word.length > 3));
const SHORT_WHOLE = new RegExp(`^(?:${SECRET_NAME_WORDS.map(squashWord).filter((word) => word.length <= 3).join("|")})s?[0-9]*$`, "u");

/** NFKC, lower-case, format characters removed, space-like and control characters as plain spaces. */
export const normalizeName = (name: string): string => name.normalize("NFKC").toLowerCase().replace(/\p{Cf}/gu, "").replace(/[\p{Z}\p{Cc}\s]/gu, " ");

export function secretNameHit(name: string): boolean {
  const text = normalizeName(name);
  if (PATTERN.test(text)) return true;
  const squashed = text.replace(/[^\p{L}\p{N}]/gu, "");
  return LONG_SQUASHED.some((word) => squashed.includes(word)) || SHORT_WHOLE.test(squashed);
}
