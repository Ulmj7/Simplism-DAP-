import { z } from "zod";
import type { JsonValue } from "@dap/contracts";
import { canonicalJson } from "../validation/canonical.js";
import { isReservedParameterName } from "./reserved-names.js";

export interface SchemaInspection {
  readonly inputSchemaJson?: JsonValue;
  readonly issues: readonly string[];
}

/** Inspect schema positions, never arbitrary metadata/default/example objects. */
export function inspectInputSchema(schema: z.ZodType): SchemaInspection {
  const issues: string[] = [];
  const visited = new WeakSet<object>();
  function inspectRuntime(value: unknown): void {
    if (value === null || typeof value !== "object" || visited.has(value)) return;
    visited.add(value);
    if (value instanceof z.core.$ZodType) {
      const def = value._zod.def;
      // JSON Schema hides catch's fallback, which accepts even unknown keys and invalid values.
      if (def.type === "catch") issues.push("inputSchema: catch fallbacks bypass strict validation");
      if (def.type === "lazy") inspectRuntime((def as z.core.$ZodLazyDef).getter());
      inspectRuntime(def);
    } else {
      for (const child of Object.values(value)) inspectRuntime(child);
    }
  }
  let inputSchemaJson: JsonValue;
  try {
    inspectRuntime(schema);
    // Zod attaches a non-enumerable ~standard helper to the root; hash only JSON Schema data.
    inputSchemaJson = JSON.parse(canonicalJson({ ...z.toJSONSchema(schema, {
      io: "input", unrepresentable: "throw",
    }) })) as JsonValue;
  } catch {
    return { issues: [...issues, "inputSchema must be representable as input-mode JSON Schema"] };
  }

  function walk(value: JsonValue | undefined, path: string): void {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return;
    const node = value as { readonly [key: string]: JsonValue };
    if (node.type === undefined && !["$ref", "allOf", "anyOf", "oneOf", "not"].some((keyword) => node[keyword] !== undefined)) {
      issues.push(`${path}: unconstrained schemas cannot guarantee strict, bounded input`);
    }
    const types = Array.isArray(node.type) ? node.type : [node.type];
    if ((types.includes("object") || node.properties !== undefined || node.patternProperties !== undefined) && node.additionalProperties !== false) {
      issues.push(`${path}: every object must have additionalProperties: false`);
    }
    if (types.includes("string") && !(typeof node.maxLength === "number" && Number.isSafeInteger(node.maxLength) && node.maxLength >= 0)) {
      issues.push(`${path}: every string must have maxLength`);
    }
    if (types.includes("array") && !(typeof node.maxItems === "number" && Number.isSafeInteger(node.maxItems) && node.maxItems >= 0)) {
      issues.push(`${path}: every array must have maxItems`);
    }
    for (const keyword of ["properties", "patternProperties", "$defs", "definitions", "dependentSchemas"]) {
      const children = node[keyword];
      if (children !== null && typeof children === "object" && !Array.isArray(children)) {
        for (const [name, child] of Object.entries(children)) {
          if (keyword === "properties" && isReservedParameterName(name)) issues.push(`${path}/${keyword}/${name}: reserved parameter name ${name}`);
          walk(child, `${path}/${keyword}/${name}`);
        }
      }
    }
    for (const keyword of ["allOf", "anyOf", "oneOf", "prefixItems"]) {
      const children = node[keyword];
      if (Array.isArray(children)) children.forEach((child, index) => walk(child, `${path}/${keyword}/${index}`));
    }
    for (const keyword of ["items", "contains", "additionalProperties", "propertyNames", "not", "if", "then", "else", "unevaluatedProperties", "unevaluatedItems"]) {
      // Zod represents never as { not: {} }; that empty negative schema accepts no input.
      if (keyword === "not" && node.not !== null && typeof node.not === "object" && Object.keys(node.not).length === 0) continue;
      walk(node[keyword], `${path}/${keyword}`);
    }
  }
  walk(inputSchemaJson, "inputSchema");
  return { inputSchemaJson, issues };
}
