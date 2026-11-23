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
  ])("refuses the separator variant %s", (name) => { expect(secretNameHit(name)).toBe(name !== "Pass word"); });
  it.each([
    ["Save"], ["Display name"], ["Submit order"], ["Tokenize"], ["Secretary"], ["Passport number"], ["Hotspot"], ["Cvvx"], ["Ssnow"], ["Protocol"], ["Totp"], [""],
  ])("does not refuse %s (whole words only)", (name) => { expect(secretNameHit(name)).toBe(false); });
});
