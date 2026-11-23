import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

it("keeps embed controls focusable and card widths bounded to the application viewport", () => {
  const embed = readFileSync("apps/reference-web/src/embed/embed.css", "utf8");
  const overlay = readFileSync("apps/reference-web/src/styles/overlay.css", "utf8");
  expect(embed).toMatch(/\.dap-guide-card, \.dap-result \{ box-sizing: border-box; overflow-wrap: anywhere;/u);
  expect(embed).toMatch(/button:focus-visible[^}]*outline: var\(--focus\)/u);
  expect(overlay).toMatch(/\.dap-guide-card \{[^}]*max-width: calc\(var\(--full\) - var\(--space-4\)\)/u);
  expect(overlay).toMatch(/\.dap-result \{[^}]*max-width: calc\(var\(--full\) - var\(--space-8\)\)/u);
});
