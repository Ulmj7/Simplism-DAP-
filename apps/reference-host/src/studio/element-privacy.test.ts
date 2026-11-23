import type { ElementFacts } from "@dap/browser-runtime";
import { describe, expect, it } from "vitest";
import { SECRET_NAME_WORDS, effectivePrivacyOfFacts, secretNameHit } from "./element-privacy.js";

const facts = (over: Partial<ElementFacts> = {}): ElementFacts => ({ tagName: null, inputType: null, autocomplete: null, dataAiPrivate: false, dataAiIgnore: false, dataAiRedact: false, ...over });

/** Fact vectors; the same ones run through the walkthrough package in tests/integration/studio-privacy-parity.test.ts. */
const PRIVACY_VECTORS: readonly (readonly [string, ElementFacts, "public" | "ignore" | "private" | "redact"])[] = [
  ["plain element", facts(), "public"],
  ["text input", facts({ inputType: "text" }), "public"],
  ["data-ai-ignore", facts({ dataAiIgnore: true }), "ignore"],
  ["data-ai-private", facts({ dataAiPrivate: true }), "private"],
  ["data-ai-redact", facts({ dataAiRedact: true }), "redact"],
  ["ignore beats private and redact", facts({ dataAiIgnore: true, dataAiPrivate: true, dataAiRedact: true }), "ignore"],
  ["private beats redact", facts({ dataAiPrivate: true, dataAiRedact: true }), "private"],
  ["password input", facts({ inputType: "password" }), "ignore"],
  ["PASSWORD with spaces", facts({ inputType: "  Password " }), "ignore"],
  ["hidden input", facts({ inputType: "hidden" }), "ignore"],
  ["autocomplete cc-number", facts({ autocomplete: "cc-number" }), "ignore"],
  ["autocomplete with a section token", facts({ autocomplete: "section-pay cc-csc" }), "ignore"],
  ["autocomplete current-password", facts({ autocomplete: "current-password" }), "ignore"],
  ["autocomplete new-password", facts({ autocomplete: "new-password" }), "ignore"],
  ["autocomplete one-time-code", facts({ autocomplete: "one-time-code" }), "ignore"],
  ["autocomplete in capitals with spaces", facts({ autocomplete: "  CC-Number  " }), "ignore"],
  ["autocomplete email is public", facts({ autocomplete: "email" }), "public"],
  ["autocomplete off is public", facts({ autocomplete: "off" }), "public"],
  ["autocomplete beats private", facts({ autocomplete: "cc-name", dataAiPrivate: true }), "ignore"],
];

describe("effectivePrivacyOfFacts", () => {
  it.each(PRIVACY_VECTORS)("%s", (_name, input, expected) => {
    expect(effectivePrivacyOfFacts(input)).toBe(expected);
  });
  it("a tag name other than input does not make a password type an input", () => {
    expect(effectivePrivacyOfFacts(facts({ tagName: "div", inputType: "password" }))).toBe("public");
    expect(effectivePrivacyOfFacts(facts({ tagName: "INPUT", inputType: "password" }))).toBe("ignore");
  });
});

describe("secretNameHit: the documented deny-list", () => {
  it.each(SECRET_NAME_WORDS.map((word) => [word]))("refuses the word %s on its own, in capitals, in a phrase and with a plural s", (word) => {
    expect(secretNameHit(word)).toBe(true);
    expect(secretNameHit(word.toUpperCase())).toBe(true);
    expect(secretNameHit(`Enter your ${word} here`)).toBe(true);
    expect(secretNameHit(`${word}s`)).toBe(true);
  });
  it.each([
    ["Pass word"], ["Card_number"], ["card-number"], ["Social   Security"], ["one time code"], ["API-key"], ["api_key"], ["Confirm password"], ["New Password (again)"], ["Login token:"],
  ])("refuses the separator variant %s", (name) => { expect(secretNameHit(name)).toBe(true); });
  it.each([
    ["Save"], ["Display name"], ["Submit order"], ["Passport number"], ["Hotspot"], ["Cvvx"], ["Ssnow"], ["Protocol"], ["Totp"], [""],
  ])("does not refuse %s (the short words match whole words only)", (name) => { expect(secretNameHit(name)).toBe(false); });
});

// --- H4: the name is normalised before matching (lead fuzz variants) ---------------------------------------------------------------------------------------------------
const LONG_WORDS = ["password", "passcode", "secret", "token", "api key", "card number", "social security", "one-time code"];
const SHORT_WORDS = ["cvv", "cvc", "ssn", "otp"];
const fullwidth = (text: string) => text.toUpperCase().replace(/[A-Z]/gu, (ch) => String.fromCharCode(ch.charCodeAt(0) + 0xfee0));
const capital = (word: string) => word.replace(/(^|[ -])([a-z])/gu, (_m, sep: string, ch: string) => `${sep}${ch.toUpperCase()}`);
/** Forms every word must be hidden in: plain, case, separators, invisible characters, fullwidth, digit suffix, letter-spaced and dotted. */
const universal = (word: string): string[] => [
  word, word.toUpperCase(), `${word}s`, `Enter your ${word.toUpperCase()}`, word.replace(/ /gu, "-"), word.replace(/ /gu, "_"), word.replace(/[ -]/gu, ""), `${word.toUpperCase()}:`, `(${word})`,
  `${word.slice(0, 2)}\u200b${word.slice(2)}`, `${word.slice(0, 2)}\u00ad${word.slice(2)}`, `${word.slice(0, 2)}\u2060${word.slice(2)}`, `${word.slice(0, 1)}\ufeff${word.slice(1)}`, fullwidth(word), `${word}2`, `${word}1`,
  word.split("").join("."), word.split("").join(" "), `${word}_value`, `${"a".repeat(60)} ${word}`, word.replace(/ /gu, "\u00a0"), word.replace(/ /gu, "\u3000"),
];
/** Forms only the LONG words must be hidden in: joined to a prefix or a camelCase word. */
const joined = (word: string): string[] => [`my${word}`, `new${capital(word).replace(/[ -]/gu, "")}`, `x${word}`, `${capital(word).replace(/[ -]/gu, "")}Input`, `current${capital(word).replace(/[ -]/gu, "")}`];

describe("secretNameHit: the normalised, squashed match (H4)", () => {
  it.each(LONG_WORDS.flatMap((word) => [...universal(word), ...joined(word)].map((form) => [word, form] as const)))("long word %s is hidden in %j", (_word, form) => {
    expect(secretNameHit(form)).toBe(true);
  });
  it.each(SHORT_WORDS.flatMap((word) => universal(word).map((form) => [word, form] as const)))("short word %s is hidden in %j", (_word, form) => {
    expect(secretNameHit(form)).toBe(true);
  });
  it.each(SHORT_WORDS.flatMap((word) => joined(word).map((form) => [word, form] as const)))("a short word joined to other letters (%s in %j) stays visible: the squashed form must equal the word", (_word, form) => {
    expect(secretNameHit(form)).toBe(false);
  });
  it.each(["Save", "Orders", "Submit order", "Profile", "Display name", "Settings", "Advanced", "Home", "Search", "Cancel", "Next", "Previous", "Add to cart", "Notes", "Passport number", "Hotspot", "Protocol", "Totp", "Cvvx", "Ssnow", "Costs", "Cost center", "Bottom panel"])(
    "the ordinary name %j stays visible", (name) => { expect(secretNameHit(name)).toBe(false); });
  it.each(["Tokenize", "Secretary", "Secretariat", "Tokens", "Passcodes"])("documented over-matching: %j contains a long word, so the heuristic hides it (fail closed)", (name) => {
    expect(secretNameHit(name)).toBe(true);
  });
  it("homoglyphs from other scripts and leet spellings are NOT caught (documented limit)", () => {
    expect(secretNameHit("p\u0430ssword")).toBe(false); // Cyrillic a
    expect(secretNameHit("p4ssw0rd")).toBe(false);
  });
});
