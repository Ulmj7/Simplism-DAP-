import { describe, expect, it } from "vitest";
import { declaredIssuePath } from "./issue-path.js";

const leaf = { type: "string", maxLength: 5 };
const object = { type: "object", properties: { message: leaf, "a/b~c": leaf } };
const array = { type: "array", items: object };

describe("diagnostic paths come from declarations, not model text", () => {
  it("allows declared properties, including missing required fields and escaped pointer tokens", () => {
    expect(declaredIssuePath(object, ["message"], {})).toBe(true);
    expect(declaredIssuePath(object, ["a/b~c"], null)).toBe(true);
    expect(declaredIssuePath(undefined, [], {})).toBe(true);
  });

  it.each([undefined, null, [], true, { properties: null }, { properties: [] }, { properties: {} }])("rejects paths with no object declaration in %j", (schema) => {
    expect(declaredIssuePath(schema, ["CANARY"], {})).toBe(false);
  });

  it.each(["CANARY", "constructor", "toString", "__proto__", Symbol("CANARY")])("does not treat %s as a declared property", (name) => {
    expect(declaredIssuePath(object, [name], { [name]: "value" })).toBe(false);
  });

  it("refuses symbols even in defective schema metadata that claims to declare one", () => {
    const key = Symbol("CANARY");
    expect(declaredIssuePath({ properties: { [key]: leaf } }, [key], {})).toBe(false);
  });

  it("allows actual array indices, but no invented, negative, fractional or string indices", () => {
    expect(declaredIssuePath(array, [0, "message"], [{}])).toBe(true);
    for (const index of [-1, 0.5, NaN, Infinity, "0", 1, 9999]) expect(declaredIssuePath(array, [index, "message"], [{}])).toBe(false);
    expect(declaredIssuePath(array, [0, "message"], {})).toBe(false);
    expect(declaredIssuePath({ type: "array" }, [0], [{}])).toBe(false);
    expect(declaredIssuePath(array, [0, "CANARY"], [{}])).toBe(false);
  });

  it("uses the matching tuple item and supports a declared rest item", () => {
    const tuple = { type: "array", prefixItems: [object], items: { type: "object", properties: { tail: leaf } } };
    expect(declaredIssuePath(tuple, [0, "message"], [{}, {}])).toBe(true);
    expect(declaredIssuePath(tuple, [0, "tail"], [{}, {}])).toBe(false);
    expect(declaredIssuePath(tuple, [1, "tail"], [{}, {}])).toBe(true);
    expect(declaredIssuePath(tuple, [1, "message"], [{}, {}])).toBe(false);
  });

  it.each(["anyOf", "oneOf", "allOf"])("finds only declared fields within %s branches", (keyword) => {
    const schema = { [keyword]: [{ type: "number" }, object] };
    expect(declaredIssuePath(schema, ["message"], {})).toBe(true);
    expect(declaredIssuePath(schema, ["CANARY"], {})).toBe(false);
  });

  it("resolves local references, including pointer escapes and recursive schemas, without looping", () => {
    const ref = { $ref: "#/$defs/a~1b~0c", $defs: { "a/b~c": object } };
    expect(declaredIssuePath(ref, ["message"], {})).toBe(true);
    expect(declaredIssuePath({ $ref: "#" }, ["CANARY"], {})).toBe(false);
    const recursive = { type: "object", properties: { message: leaf, child: { $ref: "#" } } };
    expect(declaredIssuePath(recursive, ["child", "child", "message"], {})).toBe(true);
    expect(declaredIssuePath(recursive, ["child", "CANARY"], {})).toBe(false);
  });

  it.each(["https://attacker.invalid/schema", "#/$defs/missing", "#/constructor", "#/$defs/constructor", "#/$defs/null/key"])("does not follow unproven reference %s", ($ref) => {
    expect(declaredIssuePath({ $ref, $defs: { null: null } }, ["CANARY"], {})).toBe(false);
  });
  it("rejects an external reference even when its suffix happens to match a local definition", () => {
    expect(declaredIssuePath({ $ref: "x/$defs/object", $defs: { object } }, ["message"], {})).toBe(false);
  });
});
