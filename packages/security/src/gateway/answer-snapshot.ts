/** Capture host data before validation: each field is read once; cycles and exotic data deny. */
export function snapshotAnswer(input: unknown): unknown {
  const copies = new WeakMap<object, object>();
  const active = new WeakSet<object>();
  function copy(value: unknown): unknown {
    if (value === null || typeof value === "string" || typeof value === "boolean" || value === undefined) return value;
    if (typeof value === "number" && Number.isFinite(value)) return value;
    if (typeof value !== "object") throw new TypeError("Invalid host data");
    if (active.has(value)) throw new TypeError("Cyclic host data");
    const previous = copies.get(value);
    if (previous) return previous;
    const array = Array.isArray(value);
    const prototype: unknown = Object.getPrototypeOf(value);
    if (array ? prototype !== Array.prototype : prototype !== Object.prototype && prototype !== null) throw new TypeError("Invalid host data prototype");
    const result: object = array ? [] : Object.create(null) as object;
    copies.set(value, result);
    active.add(value);
    for (const key of Reflect.ownKeys(value)) {
      if (typeof key !== "string" || ["__proto__", "constructor", "prototype"].includes(key)) throw new TypeError("Invalid host data key");
      if (Object.getOwnPropertyDescriptor(value, key)?.enumerable !== true && !(array && key === "length")) throw new TypeError("Hidden host data");
      Object.defineProperty(result, key, { value: copy(Reflect.get(value, key)), enumerable: key !== "length", configurable: key !== "length", writable: true });
    }
    active.delete(value);
    return Object.freeze(result);
  }
  return copy(input);
}
