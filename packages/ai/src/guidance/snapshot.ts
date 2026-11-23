/**
 * A bounded plain-data snapshot of an UNTRUSTED value, taken before any schema sees it (internal; not exported from the package).
 *
 * Only own, enumerable DATA properties are read, each exactly once, through its property descriptor, so a getter is never called (it is refused),
 * and there is no second read for the value to change under us. A Proxy is read the same way: a trap that throws, or that disagrees with itself,
 * ends in a refusal, and one that behaves is indistinguishable from the plain data it presents. Refused: accessors, symbol keys, non-enumerable
 * properties, class instances and other non-plain prototypes, functions, bigint, undefined, non-finite numbers, sparse or extended arrays, prototype
 * keys, cycles, and anything deeper or larger than the bounds below. Never throws, and never returns or logs the offending value.
 */
const MAX_DEPTH = 6;
const MAX_NODES = 4000;
const MAX_KEYS = 64;
const MAX_ITEMS = 128;
const DEFAULT_MAX_STRING = 5000;
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

export type Snapshot = { readonly ok: true; readonly value: unknown } | { readonly ok: false };
const REFUSED: Snapshot = Object.freeze({ ok: false });

/** `maxString` raises the per-string bound for callers that legitimately take long text (knowledge documents); every other bound is fixed. */
export function snapshotPlainData(raw: unknown, options: { readonly maxString?: number } = {}): Snapshot {
  const MAX_STRING = options.maxString ?? DEFAULT_MAX_STRING;
  let nodes = 0;
  const ancestors = new Set<object>();
  const take = (value: unknown, depth: number): { readonly v: unknown } | null => {
    if (++nodes > MAX_NODES || depth > MAX_DEPTH) return null;
    switch (typeof value) {
      case "string": return value.length <= MAX_STRING ? { v: value } : null;
      case "boolean": return { v: value };
      case "number": return Number.isFinite(value) ? { v: value } : null;
      case "object": break;
      default: return null; // undefined, bigint, symbol, function
    }
    if (value === null) return { v: null };
    if (ancestors.has(value)) return null; // a cycle
    ancestors.add(value);
    try {
      if (Array.isArray(value)) {
        const keys = Reflect.ownKeys(value);
        const lengthDescriptor = Object.getOwnPropertyDescriptor(value, "length");
        const length = lengthDescriptor !== undefined && "value" in lengthDescriptor ? lengthDescriptor.value as unknown : undefined;
        if (typeof length !== "number" || !Number.isInteger(length) || length < 0 || length > MAX_ITEMS || keys.length !== length + 1) return null;
        const out: unknown[] = [];
        for (let index = 0; index < length; index++) {
          const descriptor = Object.getOwnPropertyDescriptor(value, String(index));
          if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) return null;
          const item = take(descriptor.value, depth + 1);
          if (item === null) return null;
          out.push(item.v);
        }
        return { v: out };
      }
      const proto = Object.getPrototypeOf(value) as unknown;
      if (proto !== Object.prototype && proto !== null) return null;
      const keys = Reflect.ownKeys(value);
      if (keys.length > MAX_KEYS) return null;
      const out: Record<string, unknown> = {};
      for (const key of keys) {
        if (typeof key !== "string" || FORBIDDEN_KEYS.has(key)) return null;
        const descriptor = Object.getOwnPropertyDescriptor(value, key);
        if (descriptor === undefined || !("value" in descriptor) || descriptor.enumerable !== true) return null;
        const item = take(descriptor.value, depth + 1);
        if (item === null) return null;
        out[key] = item.v;
      }
      return { v: out };
    } finally { ancestors.delete(value); }
  };
  try {
    const taken = take(raw, 0);
    return taken === null ? REFUSED : { ok: true, value: taken.v };
  } catch { return REFUSED; }
}
