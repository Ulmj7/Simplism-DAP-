const record = (value: unknown): Record<string, unknown> | undefined =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;

/** Only schema-declared properties and array indices may become diagnostic paths. Refinements can invent paths. */
export function declaredIssuePath(schema: unknown, path: readonly PropertyKey[], input: unknown): boolean {
  const visited = new WeakMap<object, Set<number>>();
  function localRef(ref: string): unknown {
    if (ref === "#") return schema;
    if (!ref.startsWith("#/")) return undefined;
    let node = schema;
    for (const token of ref.slice(2).split("/")) {
      const key = token.replaceAll("~1", "/").replaceAll("~0", "~");
      const parent = record(node);
      if (!parent || !Object.hasOwn(parent, key)) return undefined;
      node = parent[key];
    }
    return node;
  }
  function walk(value: unknown, index: number, data: unknown): boolean {
    if (index === path.length) return true;
    const node = record(value);
    if (!node) return false;
    let seen = visited.get(node);
    if (!seen) { seen = new Set(); visited.set(node, seen); }
    if (seen.has(index)) return false;
    seen.add(index);
    if (typeof node.$ref === "string" && walk(localRef(node.$ref), index, data)) return true;
    for (const key of ["anyOf", "oneOf", "allOf"]) {
      const branches = node[key];
      if (Array.isArray(branches) && branches.some((branch) => walk(branch, index, data))) return true;
    }
    const segment = path[index];
    if (typeof segment !== "string" && typeof segment !== "number") return false;
    const child = data !== null && typeof data === "object" && Object.hasOwn(data, segment) ? Reflect.get(data, segment) : undefined;
    const properties = record(node.properties);
    if (properties && Object.hasOwn(properties, segment) && walk(properties[segment], index + 1, child)) return true;
    const arrayIndex = Number.isSafeInteger(segment) ? segment as number : -1;
    if (arrayIndex < 0) return false;
    // A refinement must not encode a numeric parameter as an invented array index.
    if (!Array.isArray(data) || arrayIndex >= data.length) return false;
    if (Array.isArray(node.prefixItems) && arrayIndex < node.prefixItems.length) return walk(node.prefixItems[arrayIndex], index + 1, child);
    return node.items !== undefined && walk(node.items, index + 1, child);
  }
  return walk(schema, 0, input);
}
