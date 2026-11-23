/** Detached immutable data snapshot; shared references, cycles and own prototype keys are safe. */
export function snapshotData<T>(input: T): T {
  const copies = new WeakMap<object, object>();
  function copy(value: unknown): unknown {
    if (typeof value === "function") throw new TypeError("Test records require data, not functions");
    if (value === null || typeof value !== "object") return value;
    const existing = copies.get(value);
    if (existing) return existing;
    const prototype: unknown = Object.getPrototypeOf(value);
    if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Test records require plain data");
    }
    const result: object = Array.isArray(value) ? [] : Object.create(prototype as object | null) as object;
    copies.set(value, result);
    for (const key of Reflect.ownKeys(value)) {
      const captured: unknown = Reflect.get(value, key);
      Object.defineProperty(result, key, { value: copy(captured), enumerable: key !== "length", writable: true, configurable: key !== "length" });
    }
    return Object.freeze(result);
  }
  return copy(input) as T;
}

/** Own and inherited port members, including non-enumerable class methods and symbols. */
export function portMembers(port: object): Map<PropertyKey, unknown> {
  const members = new Map<PropertyKey, unknown>();
  const visited = new WeakSet<object>();
  let prototype: object | null = port;
  while (prototype && prototype !== Object.prototype) {
    if (visited.has(prototype)) throw new TypeError("Port prototype cycle");
    visited.add(prototype);
    for (const key of Reflect.ownKeys(prototype)) {
      if (key !== "constructor" && !members.has(key)) members.set(key, Reflect.get(port, key));
    }
    prototype = Object.getPrototypeOf(prototype) as object | null;
  }
  return members;
}
