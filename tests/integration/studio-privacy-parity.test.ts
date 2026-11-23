/**
 * The host re-implements the walkthrough package's `effectivePrivacy` over the browser adapter's facts (it may not import the package, see tests/architecture/authoring-boundary.test.ts). This test is the
 * only place both exist at once: it runs an exhaustive grid of facts through both and requires the same verdict, so the copy cannot drift.
 */
import type { ElementFacts } from "@dap/browser-runtime";
import { effectivePrivacy } from "@dap/walkthrough";
import { describe, expect, it } from "vitest";
import { effectivePrivacyOfFacts } from "../../apps/reference-host/src/studio/element-privacy.js";

const INPUT_TYPES: (string | null)[] = [null, "text", "password", "  Password ", "hidden", "HIDDEN", "email", "checkbox"];
const AUTOCOMPLETES: (string | null)[] = [null, "off", "email", "cc-number", "section-a cc-csc", "current-password", "new-password", "one-time-code", "  ONE-TIME-CODE  ", "username"];

describe("host privacy verdict matches the walkthrough package's effectivePrivacy", () => {
  it("agrees on the whole grid of facts (the adapter never reads the tag, so an element with an input type is an input)", () => {
    let compared = 0;
    for (const inputType of INPUT_TYPES) for (const autocomplete of AUTOCOMPLETES) for (let flags = 0; flags < 8; flags += 1) {
      const facts: ElementFacts = { tagName: null, inputType, autocomplete, dataAiIgnore: (flags & 1) !== 0, dataAiPrivate: (flags & 2) !== 0, dataAiRedact: (flags & 4) !== 0 };
      const walkthrough = effectivePrivacy({
        ignoredByAncestorOrSelf: facts.dataAiIgnore, private: facts.dataAiPrivate, redact: facts.dataAiRedact, tagName: inputType === null ? "div" : "input", inputType, autocomplete,
      });
      expect(effectivePrivacyOfFacts(facts), JSON.stringify(facts)).toBe(walkthrough);
      compared += 1;
    }
    expect(compared).toBe(INPUT_TYPES.length * AUTOCOMPLETES.length * 8);
  });
});
