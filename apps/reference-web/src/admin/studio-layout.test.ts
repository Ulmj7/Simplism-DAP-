/// <reference types="node" />
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { expect, it } from "vitest";

const css = readFileSync(join(resolve("apps/reference-web/src"), "styles/app.css"), "utf8");
const rule = (selector: string) => {
  const found = new RegExp(`(?:^|\\n)\\s*${selector.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\{([^}]*)\\}`, "u").exec(css);
  return found?.[1]?.trim();
};

it("lays the editor out as three tracks (steps, workspace, properties) that can shrink below their content", () => {
  const columns = /grid-template-columns:\s*([^;]+);/u.exec(rule(".editor-panes-studio") ?? "")?.[1] ?? "";
  expect(columns.match(/minmax\(var\(--zero\), \d+fr\)/gu)).toHaveLength(3);
  expect(columns).not.toMatch(/\d+px/u);
});

it("stacks to one column below 900px, so the order is steps, workspace, properties with no horizontal scrolling", () => {
  const block = /@media \(max-width: 899px\) \{([^@]*?)\n\}/u.exec(css)?.[1] ?? "";
  expect(block).toContain(".editor-panes-studio");
  expect(block).toMatch(/grid-template-columns:\s*minmax\(var\(--zero\), 1fr\);/u);
  // The collapse comes after the base rule, so it wins at every narrow width (including the older 800px rule).
  expect(css.indexOf("@media (max-width: 899px)")).toBeGreaterThan(css.indexOf(".editor-panes-studio {"));
});

it("keeps wide text inside its box: the status list, candidates and application origins wrap instead of scrolling", () => {
  expect(rule(".studio-status")).toMatch(/grid-template-columns:\s*max-content minmax\(var\(--zero\), 1fr\)/u);
  expect(rule(".studio-status dd")).toContain("overflow-wrap: anywhere");
  expect(rule(".studio-candidate")).toContain("min-width: var(--zero)");
  expect(rule(".admin-lines")).toMatch(/white-space:\s*pre-line/u);
  expect(rule(".admin-page")).toContain("overflow-wrap: anywhere");
});

it("uses only the existing tokens: no raw colours, motion or fixed pixel widths for the studio rules", () => {
  const studio = css.slice(css.indexOf(".editor-application .card"));
  expect(studio).not.toMatch(/#[0-9a-f]{3,8}\b|rgb\(|hsl\(/iu);
  expect(studio).not.toMatch(/transition:|animation:|gradient\(/u);
  expect(studio.replace(/@media \(max-width: 899px\)/u, "")).not.toMatch(/\bwidth:\s*\d+px|min-width:\s*\d+px/u);
});
