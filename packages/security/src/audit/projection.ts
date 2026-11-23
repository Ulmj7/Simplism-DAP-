/**
 * @dap/security: audit/projection.ts
 *
 * T085 / FR-041. The parameters an audit record may carry: only what the capability's `audit.params` allowlist names
 * (default deny), `masked` entries as the fixed marker, everything else absent. The result is a flat map from the rule's path
 * to the value found there, scrubbed and bounded by `scrubJson`; text from the model stays inside its own single value
 * (a newline, an ANSI escape or a quote cannot start a new field, row or key).
 *
 * Fail-closed choices: a path that is not a well-formed JSON pointer, or that names nothing, records nothing; two rules for one
 * path with different modes record it masked; a `masked` rule beneath a `plain` one masks that part of the plain value.
 */
import type { AuditParamRule, JsonValue } from "@dap/contracts";
import { scrubJson } from "./scrubber.js";

export const MASKED = "[masked]";
const POINTER = /^(?:\/(?:[^~/]|~[01])*)*$/;

/** The segments of a JSON pointer ("" is the whole document), or undefined when it is not one. */
function segments(path: string): readonly string[] | undefined {
  if (!POINTER.test(path)) return undefined;
  return path === "" ? [] : path.slice(1).split("/").map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
}

function lookup(root: unknown, parts: readonly string[]): { readonly found: true; readonly value: unknown } | { readonly found: false } {
  let node: unknown = root;
  for (const part of parts) {
    if (node === null || typeof node !== "object") return { found: false };
    if (Array.isArray(node)) {
      if (!/^(?:0|[1-9][0-9]*)$/.test(part)) return { found: false };
      const index = Number(part);
      if (!Number.isSafeInteger(index) || index >= node.length) return { found: false };
      node = node[index];
    } else {
      if (!Object.hasOwn(node, part)) return { found: false };
      node = (node as Record<string, unknown>)[part];
    }
  }
  return { found: true, value: node };
}

/** `value` (found at `path`) with every masked path at or beneath it replaced by the marker. Copies; never mutates. */
function applyMasks(value: unknown, path: string, masked: ReadonlySet<string>): unknown {
  if (masked.has(path)) return MASKED;
  if (value === null || typeof value !== "object") return value;
  const child = (key: string) => `${path}/${key.replaceAll("~", "~0").replaceAll("/", "~1")}`;
  if (Array.isArray(value)) return value.map((item: unknown, index) => applyMasks(item, child(String(index)), masked));
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, applyMasks(item, child(key), masked)]));
}

/**
 * The audit view of validated `params` under the capability's rules. `params` is the NORMALIZED output of validation
 * (plain JSON), never raw model text. Never throws.
 */
export function projectParams(params: unknown, rules: readonly AuditParamRule[]): { readonly [path: string]: JsonValue } {
  const view: { [path: string]: JsonValue } = Object.create(null) as { [path: string]: JsonValue };
  try {
    const mode = new Map<string, "plain" | "masked">();
    for (const rule of rules) {
      const path: unknown = rule.path;
      const how: unknown = rule.mode;
      if (typeof path !== "string" || (how !== "plain" && how !== "masked") || segments(path) === undefined) continue;
      mode.set(path, how === "masked" || mode.get(path) === "masked" ? "masked" : "plain");
    }
    const masked = new Set([...mode].filter(([, how]) => how === "masked").map(([path]) => path));
    for (const path of [...mode.keys()].sort()) {
      const hit = lookup(params, segments(path) as readonly string[]);
      if (!hit.found) continue;
      const covered = [...masked].some((parent) => path.startsWith(`${parent}/`));
      view[path] = covered ? MASKED : scrubJson(applyMasks(hit.value, path, masked));
    }
  } catch { /* A view that cannot be built is an empty one: nothing unlisted is ever recorded. */ return Object.freeze(Object.create(null) as { [path: string]: JsonValue }); }
  return Object.freeze(view);
}
