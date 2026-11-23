/** The text rules shared by the request and decision schemas (mirroring Feature 002's plain-text rule, which this leaf package cannot import). */

/** Control characters, line and paragraph separators, and bidirectional overrides. Written as escapes so no invisible character sits in the source. */
const CONTROL = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/;
const MARKUP = /[<>&"'`]/;
export const RESERVED_NAMES: ReadonlySet<string> = new Set(["__proto__", "constructor", "prototype", "toString", "hasOwnProperty", "valueOf"]);

/** EXACTLY Feature 002's `ID_GRAMMAR` (packages/walkthrough/src/walkthrough/catalog.ts). The ONE Feature 003 definition: schemas, catalog parse, host capability and bridge all use it. */
export const WALKTHROUGH_ID = /^[a-zA-Z][A-Za-z0-9_-]{0,63}$/;
export const SOURCE_ID = /^[A-Za-z0-9._-]{1,64}$/;
export const ELEMENT_ID = /^[a-z][A-Za-z0-9]*(\.[A-Za-z0-9]+)+$/;
export const ROUTE = /^[a-z][A-Za-z0-9-]*$/;

export const hasControl = (value: string): boolean => CONTROL.test(value);
/** Plain text: 1..max characters, not blank, no control characters, none of `< > & " ' \``. Nothing is trimmed or repaired. */
export const isPlainText = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length >= 1 && value.length <= max && value.trim().length > 0 && !CONTROL.test(value) && !MARKUP.test(value);
/** Text that may contain quotes and markup characters (a question, or document text) but still no control characters. */
export const isBoundedText = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length >= 1 && value.length <= max && value.trim().length > 0 && !CONTROL.test(value);
export const isId = (value: unknown, pattern: RegExp): value is string => typeof value === "string" && pattern.test(value) && !RESERVED_NAMES.has(value);
/** Document text: like bounded text, but tabs and line breaks are allowed (other control characters are not). */
export const isDocumentText = (value: unknown, max: number): value is string =>
  typeof value === "string" && value.length >= 1 && value.length <= max && value.trim().length > 0 && !CONTROL.test(value.replace(/[\t\n\r]/g, ""));
