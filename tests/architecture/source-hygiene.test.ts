/**
 * Source hygiene. A literal invisible character in source (a zero-width space, a bidirectional override, a line or
 * paragraph separator, a no-break space, a byte-order mark) is invisible in review and can hide what code does (Trojan
 * Source). Tests that need such a character write it as an escape (\u200b), which is visible and diffable.
 *
 * ESLint's no-irregular-whitespace was not enabled here (the config extends only the typescript-eslint presets), skips
 * strings, comments, templates and regexes by default, and does not list bidi controls at all; this scan has none of those gaps.
 */
import { describe, expect, it } from "vitest";
import * as fs from "node:fs";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ROOTS = ["packages", "apps", "tests", "db", "deploy"];
const EXTENSIONS = /\.(?:[cm]?[jt]sx?|sql|json|ya?ml)$/;
const SKIPPED = new Set(["node_modules", "dist", "coverage", ".git"]);
// Format characters, separators, private-use and surrogate halves, every space but U+0020, every control but tab/LF/CR.
const FORBIDDEN = /[\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Cs}]|(?! )\p{Zs}|(?![\t\n\r])\p{Cc}/u;

function* sourceFiles(directory: string): Generator<string> {
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (SKIPPED.has(entry.name)) continue;
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) yield* sourceFiles(full);
    else if (EXTENSIONS.test(entry.name)) yield full;
  }
}
const files = [
  ...ROOTS.filter((root) => fs.existsSync(path.join(ROOT, root))).flatMap((root) => [...sourceFiles(path.join(ROOT, root))]),
  ...fs.readdirSync(ROOT).filter((name) => /\.(?:[cm]?js|ts|json)$/.test(name)).map((name) => path.join(ROOT, name)),
];

describe("source files contain no literal invisible characters", () => {
  it("scans a meaningful number of files", () => {
    expect(files.length).toBeGreaterThan(100);
  });
  it("finds none (write \\uXXXX escapes instead)", () => {
    const found: string[] = [];
    for (const file of files) {
      fs.readFileSync(file, "utf8").split(/\r?\n/).forEach((line, index) => {
        const match = FORBIDDEN.exec(line);
        if (match) found.push(`${path.relative(ROOT, file)}:${index + 1} U+${(match[0].codePointAt(0) as number).toString(16).toUpperCase().padStart(4, "0")}`);
      });
    }
    expect(found).toEqual([]);
  });
  it("the pattern catches every kind it exists for, and spares ordinary text", () => {
    for (const bad of ["\u200b", "\u200d", "\u202e", "\u2028", "\u2029", "\ufeff", "\u00a0", "\u3000", "\u0085", "\u0000", "\u007f", "\ue000", "\ud800", "\u00ad"]) {
      expect(FORBIDDEN.test(`a${bad}b`), `U+${bad.codePointAt(0)!.toString(16)}`).toBe(true);
    }
    for (const fine of ["plain ascii", "tab\tand\r\nnewline", "é ü 界 😀 ☃", "a b"]) expect(FORBIDDEN.test(fine), fine).toBe(false);
  });
});
