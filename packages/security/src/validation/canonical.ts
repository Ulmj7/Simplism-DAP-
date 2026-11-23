import { createHash } from "node:crypto";
import type { Sha256Hex } from "@dap/contracts";

const PROTOTYPE_KEYS = new Set(["__proto__", "constructor", "prototype"]);

/**
 * Strict JSON data, with object keys sorted by UTF-16 code units. No coercion,
 * toJSON hooks, hidden/symbol/prototype keys, sparse arrays, extra array fields,
 * non-plain prototypes, non-finite numbers, or -0. Null-prototype objects are allowed.
 * Getters/Proxies are read once per object; shared references reuse that snapshot.
 */
export function canonicalJson(input: unknown): string {
  const snapshots = new WeakMap<object, string>();
  const active = new WeakSet<object>();

  function encode(value: unknown): string {
    if (value === null) return "null";
    if (typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
    if (typeof value === "number") {
      if (!Number.isFinite(value) || Object.is(value, -0)) {
        throw new TypeError("Canonical JSON requires finite numbers other than -0.");
      }
      return JSON.stringify(value);
    }
    if (typeof value !== "object") throw new TypeError("Canonical JSON accepts only plain JSON data.");
    const cached = snapshots.get(value);
    if (cached !== undefined) return cached;
    if (active.has(value)) throw new TypeError("Canonical JSON cannot contain cycles.");

    active.add(value);
    try {
      const array = Array.isArray(value);
      const prototype: unknown = Object.getPrototypeOf(value);
      if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) {
        throw new TypeError("Canonical JSON cannot contain non-plain objects.");
      }
      const keys: string[] = [];
      for (const key of Reflect.ownKeys(value)) {
        if (typeof key !== "string" || PROTOTYPE_KEYS.has(key)) {
          throw new TypeError("Canonical JSON forbids symbol and prototype keys.");
        }
        keys.push(key);
      }

      let result: string;
      if (array) {
        const length: unknown = Reflect.get(value, "length");
        if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0 ||
          length > 0xffff_ffff || keys.length !== length + 1 || !keys.includes("length")) {
          throw new TypeError("Canonical JSON requires dense arrays without extra properties.");
        }
        const own = new Set(keys);
        const elements: string[] = [];
        for (let index = 0; index < length; index += 1) {
          const key = String(index);
          if (!own.has(key)) throw new TypeError("Canonical JSON cannot contain sparse arrays.");
          elements.push(encode(Reflect.get(value, key)));
        }
        result = `[${elements.join(",")}]`;
      } else {
        const entries: string[] = [];
        for (const key of keys.sort()) {
          if (Object.getOwnPropertyDescriptor(value, key)?.enumerable !== true) {
            throw new TypeError("Canonical JSON requires enumerable own properties.");
          }
          entries.push(`${JSON.stringify(key)}:${encode(Reflect.get(value, key))}`);
        }
        result = `{${entries.join(",")}}`;
      }
      snapshots.set(value, result);
      return result;
    } finally {
      active.delete(value);
    }
  }

  return encode(input);
}

/** Hash the captured canonical UTF-8 encoding, never JSON.stringify's lossy coercions. */
export function sha256Canonical(input: unknown): Sha256Hex {
  return createHash("sha256").update(canonicalJson(input), "utf8").digest("hex") as Sha256Hex;
}
