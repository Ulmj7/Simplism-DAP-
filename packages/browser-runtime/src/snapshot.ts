import { BrowserRuntimeError } from "./errors.js";
import type { BrowserElement, ElementRef } from "./types.js";

export interface ApprovedLabel {
  readonly role: string;
  readonly name: string;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Bounds of an exposed element: the same as the host's inspector (a longer name or role is dropped, never truncated into a different value). */
export const MAX_NAME_CHARS = 120;
export const MAX_ROLE_CHARS = 40;
/** In "all" mode at most this many elements leave the adapter, in document order (the host shows far fewer). */
export const MAX_ALL_ELEMENTS = 512;
// The roles of controls a person can operate. `snapshot -i` also lists headings and options as context; those are never exposed in "all" mode.
const INTERACTIVE_ROLES: ReadonlySet<string> = new Set([
  "button", "link", "textbox", "searchbox", "checkbox", "radio", "switch", "combobox", "listbox", "slider", "spinbutton", "tab", "menuitem", "menuitemcheckbox", "menuitemradio", "treeitem",
]);
/** Control characters, line and paragraph separators and bidirectional overrides: not part of any name that is shown to a maintainer. */
const UNSAFE_NAME = /[\u0000-\u001f\u007f-\u009f\u2028\u2029\u202a-\u202e\u2066-\u2069]/u;

// Keep only explicitly approved static labels. Free-form accessibility names, hints,
// text, form values and titles can contain secrets even on a known application.
// "all" (a Studio-managed application, whose targets are not known in advance) keeps the role and the bounded accessible name of every operable, enabled
// control, in document order: still never a value, a hint or any text of the page. The HOST decides which of them leave it (only those carrying a valid marker).
export function normalizeSnapshot(data: Record<string, unknown>, labels: readonly ApprovedLabel[] | "all"): readonly BrowserElement[] {
  if (typeof data.snapshot !== "string" || !isRecord(data.refs)) throw new BrowserRuntimeError("INVALID_BROWSER_OUTPUT");
  const rows = new Map<string, boolean>();
  for (const line of data.snapshot.split("\n")) {
    const match = /^\s*- .+ \[([^\]]*\bref=(e[1-9]\d*)[^\]]*)\](?:\s*:.*|\s|$)/u.exec(line);
    const key = match?.[2];
    if (!key || match[1] === undefined) continue;
    if (rows.has(key)) throw new BrowserRuntimeError("INVALID_BROWSER_OUTPUT");
    rows.set(key, /(?:^|,\s*)(?:disabled|readonly)(?:=true)?(?=,|$)/u.test(match[1]));
  }
  const elements: BrowserElement[] = [];
  const operable = new Map<string, BrowserElement>();
  for (const [key, value] of Object.entries(data.refs)) {
    if (!/^e[1-9]\d{0,8}$/u.test(key) || !isRecord(value) || typeof value.role !== "string"
      || (value.name !== undefined && typeof value.name !== "string")) {
      throw new BrowserRuntimeError("INVALID_BROWSER_OUTPUT");
    }
    if (rows.get(key) !== false) continue;
    if (labels === "all") {
      const { role, name } = value;
      if (typeof name === "string" && INTERACTIVE_ROLES.has(role) && role.length <= MAX_ROLE_CHARS && name.trim().length > 0 && name.length <= MAX_NAME_CHARS && !UNSAFE_NAME.test(name)) {
        operable.set(key, Object.freeze({ ref: `@${key}` as ElementRef, role, name }));
      }
      continue;
    }
    const label = labels.find(({ role, name }) => role === value.role && name === value.name);
    if (label) elements.push(Object.freeze({ ref: `@${key}` as ElementRef, role: label.role, name: label.name }));
  }
  if (rows.size === 0) throw new BrowserRuntimeError("INVALID_BROWSER_OUTPUT");
  if (labels === "all") {
    // The snapshot text lists the elements in document order; the refs object does not.
    for (const key of rows.keys()) {
      const element = operable.get(key);
      if (element) elements.push(element);
      if (elements.length >= MAX_ALL_ELEMENTS) break;
    }
  }
  return Object.freeze(elements);
}
