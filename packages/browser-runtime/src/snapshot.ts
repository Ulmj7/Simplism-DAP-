import { BrowserRuntimeError } from "./errors.js";
import type { BrowserElement, ElementRef } from "./types.js";

export interface ApprovedLabel {
  readonly role: string;
  readonly name: string;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

// Keep only explicitly approved static labels. Free-form accessibility names, hints,
// text, form values and titles can contain secrets even on a known application.
export function normalizeSnapshot(data: Record<string, unknown>, labels: readonly ApprovedLabel[]): readonly BrowserElement[] {
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
  for (const [key, value] of Object.entries(data.refs)) {
    if (!/^e[1-9]\d{0,8}$/u.test(key) || !isRecord(value) || typeof value.role !== "string"
      || (value.name !== undefined && typeof value.name !== "string")) {
      throw new BrowserRuntimeError("INVALID_BROWSER_OUTPUT");
    }
    if (rows.get(key) !== false) continue;
    const label = labels.find(({ role, name }) => role === value.role && name === value.name);
    if (label) elements.push(Object.freeze({ ref: `@${key}` as ElementRef, role: label.role, name: label.name }));
  }
  if (rows.size === 0) throw new BrowserRuntimeError("INVALID_BROWSER_OUTPUT");
  return Object.freeze(elements);
}
