import { z } from "zod";

type Captured = { readonly ok: true; readonly value: unknown } | { readonly ok: false };
const annotations = new Set(["id", "title", "description", "deprecated", "examples", "default", "readOnly", "writeOnly", "$comment"]);

/** A build-local reader: aliases and hostile accessors always see the same first read. */
export class Snapshot {
  private readonly reads = new WeakMap<object, Map<PropertyKey, Captured>>();
  private readonly copies = new WeakMap<object, object>();
  private readonly metadata = new WeakMap<object, Record<string, unknown>>();

  private schemaMetadata(schema: object, internals: object): Record<string, unknown> {
    const previous = this.metadata.get(schema);
    if (previous) return previous;
    const captured: Record<string, unknown> = {};
    this.metadata.set(schema, captured);
    const parent = this.read(internals, "parent");
    if (parent !== null && typeof parent === "object") {
      const parentInternals = this.read(parent, "_zod");
      if (parentInternals !== null && typeof parentInternals === "object") {
        Object.assign(captured, this.schemaMetadata(parent, parentInternals));
        delete captured.id;
      }
    }
    // Use the registry's identity map directly: get() re-reads live parent schema fields.
    const own = this.copy(z.globalRegistry._map.get(schema as z.core.$ZodType));
    if (own !== null && typeof own === "object") Object.assign(captured, own);
    for (const key of Object.keys(captured)) {
      if (!annotations.has(key) && !key.startsWith("x-")) throw new TypeError("Schema metadata cannot override validation keywords");
    }
    return captured;
  }

  read(source: object, key: PropertyKey): unknown {
    let fields = this.reads.get(source);
    if (!fields) { fields = new Map(); this.reads.set(source, fields); }
    let captured = fields.get(key);
    if (!captured) {
      try { captured = { ok: true, value: Reflect.get(source, key) }; } catch { captured = { ok: false }; }
      fields.set(key, captured);
    }
    if (!captured.ok) throw new TypeError("Definition property could not be read");
    return captured.value;
  }

  copy(value: unknown): unknown {
    if (value === null || typeof value !== "object") return value;
    const prior = this.copies.get(value);
    if (prior) return prior;
    if (value instanceof RegExp) {
      const result = new RegExp(value.source, value.flags);
      this.copies.set(value, result);
      return result;
    }
    const internals = this.read(value, "_zod");
    if (internals !== null && typeof internals === "object") {
      const constructor = this.read(internals, "constr");
      const initialize = typeof constructor === "function" ? this.read(constructor, "init") : undefined;
      if (typeof initialize === "function") {
        // Zod's public core constructor protocol lets cycles refer to this shell during cloning.
        const result = Object.create(Object.getPrototypeOf(value)) as object;
        this.copies.set(value, result);
        const def = this.copy(this.read(internals, "def"));
        Reflect.apply(initialize, constructor, [result, def]);
        const runtime = Reflect.get(result, "_zod") as {
          deferred?: (() => void)[] | undefined;
          check?: unknown;
          onattach?: unknown;
        };
        // Base custom checks (including superRefine) install their callback outside the def.
        if (constructor === z.core.$ZodCheck) {
          runtime.check = this.read(internals, "check");
          runtime.onattach = this.copy(this.read(internals, "onattach"));
        }
        for (const initialize of runtime.deferred ?? []) initialize();
        runtime.deferred = undefined;
        if (result instanceof z.core.$ZodType) {
          const metadata = this.schemaMetadata(value, internals);
          if (Object.keys(metadata).length > 0) z.globalRegistry.add(result, metadata);
        }
        return result;
      }
    }
    const prototype: unknown = Object.getPrototypeOf(value);
    if (!Array.isArray(value) && prototype !== Object.prototype && prototype !== null) {
      throw new TypeError("Definition metadata must be plain data");
    }
    const result: object = Array.isArray(value) ? [] : Object.create(prototype as object | null) as object;
    this.copies.set(value, result);
    for (const key of Reflect.ownKeys(value)) {
      const item = this.read(value, key);
      // A lazy schema's getter is executable metadata: capture its result once, on resolution.
      let resolved: Captured | undefined;
      const copied = key === "getter" && typeof item === "function" ? () => {
        if (!resolved) {
          try { resolved = { ok: true, value: this.copy(Reflect.apply(item, undefined, [])) }; } catch { resolved = { ok: false }; }
        }
        if (!resolved.ok) throw new TypeError("Lazy schema could not be captured");
        return resolved.value;
      } : this.copy(item);
      Object.defineProperty(result, key, { value: copied, enumerable: key !== "length", writable: true, configurable: key !== "length" });
    }
    return result;
  }
}

/**
 * Zod mutates private parser caches, so freezing its working internals would break parsing.
 * Hand out a frozen view instead, with disposable parsers for methods/callbacks. Zod's apply,
 * error maps and raw issues expose schema instances; none may expose our captured parser.
 */
export function frozenView<T>(input: T): T {
  const views = new WeakMap<object, object>();
  const internalOwners = new WeakMap<object, object>();

  function view(value: unknown): unknown {
    if (value === null || (typeof value !== "object" && typeof value !== "function")) return value;
    const cached = views.get(value);
    if (cached) return cached;
    if (typeof value === "function") {
      const wrapped = function (this: unknown, ...args: unknown[]): unknown {
        const result: unknown = new.target ? Reflect.construct(value, args) : Reflect.apply(value, this, args);
        return result instanceof z.core.$ZodType || result instanceof z.core.$ZodCheck ? view(result) : result;
      };
      views.set(value, wrapped);
      return Object.freeze(wrapped);
    }

    const result = (Array.isArray(value) ? [] : Object.create(Object.getPrototypeOf(value))) as object;
    views.set(value, result);
    const zodInstance = value instanceof z.core.$ZodType || value instanceof z.core.$ZodCheck;
    if (zodInstance) internalOwners.set(Reflect.get(value, "_zod") as object, value);
    const internalOwner = internalOwners.get(value);
    const keys = new Set(Reflect.ownKeys(value));
    // Materialize lazy public methods and derived internals on the private working instance.
    if (zodInstance || internalOwner || value instanceof Set || value instanceof Map || value instanceof RegExp) {
      let prototype = Object.getPrototypeOf(value) as object | null;
      while (prototype && prototype !== Object.prototype) {
        for (const key of Reflect.ownKeys(prototype)) if (key !== "constructor") keys.add(key);
        prototype = Object.getPrototypeOf(prototype) as object | null;
      }
    }
    for (const key of keys) {
      const item: unknown = Reflect.get(value, key);
      let captured: unknown;
      if ((value instanceof Set && ["add", "delete", "clear"].includes(String(key))) ||
        (value instanceof Map && ["set", "delete", "clear"].includes(String(key))) ||
        (value instanceof RegExp && key === "compile")) {
        captured = Object.freeze(() => { throw new TypeError("Registered definitions are immutable"); });
      } else if (typeof item === "function") {
        if ((zodInstance || internalOwner) && key !== "constr") {
          captured = view(function (...args: unknown[]): unknown {
            const isolated = new Snapshot().copy(internalOwner ?? value) as object;
            const receiver = internalOwner ? Reflect.get(isolated, "_zod") as object : isolated;
            const method = Reflect.get(receiver, key) as (...args: unknown[]) => unknown;
            return Reflect.apply(method, receiver, args);
          });
        } else {
          captured = view(item.bind(value instanceof Set || value instanceof Map || value instanceof RegExp || key === "constr" ? value : result));
        }
      } else {
        captured = view(item);
      }
      Object.defineProperty(result, key, { value: captured, enumerable: Object.getOwnPropertyDescriptor(value, key)?.enumerable ?? false, configurable: key !== "length", writable: true });
    }
    return Object.freeze(result);
  }
  return view(input) as T;
}
