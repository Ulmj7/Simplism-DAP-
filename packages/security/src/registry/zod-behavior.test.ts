import { describe, expect, it } from "vitest";
import { z } from "zod";

describe("Zod 4 behavior relied on by registry validation (research D2)", () => {
  it("rejects unknown keys in strict objects, while plain objects strip them", () => {
    const input = { name: "allowed", extra: "unregistered" };

    expect(() => z.strictObject({ name: z.string() }).parse(input)).toThrow();
    expect(z.object({ name: z.string() }).parse(input)).toEqual({ name: "allowed" });
  });

  it("distinguishes strict and plain objects only in input-mode JSON Schema", () => {
    const plain = z.object({ name: z.string() });
    const strict = z.strictObject({ name: z.string() });

    expect(z.toJSONSchema(plain)).toHaveProperty("additionalProperties", false);
    expect(z.toJSONSchema(plain, { io: "input" })).not.toHaveProperty("additionalProperties");
    expect(z.toJSONSchema(strict, { io: "input" })).toHaveProperty("additionalProperties", false);
  });

  it("leaves a nested plain object's additionalProperties absent in input mode", () => {
    const schema = z.toJSONSchema(
      z.strictObject({ child: z.object({ name: z.string() }) }),
      { io: "input", unrepresentable: "throw" },
    );

    expect(schema).toHaveProperty("additionalProperties", false);
    expect(schema.properties?.child).toHaveProperty("type", "object");
    expect(schema.properties?.child).not.toHaveProperty("additionalProperties");
  });

  it("exports string, array, and number bounds as JSON Schema keywords", () => {
    const options = { io: "input", unrepresentable: "throw" } as const;

    expect(z.toJSONSchema(z.string().max(64), options)).toHaveProperty("maxLength", 64);
    expect(z.toJSONSchema(z.array(z.string().max(64)).max(8), options))
      .toHaveProperty("maxItems", 8);
    expect(z.toJSONSchema(z.number().min(1).max(10), options))
      .toMatchObject({ minimum: 1, maximum: 10 });
    expect(z.toJSONSchema(z.string(), options)).not.toHaveProperty("maxLength");
  });

  it("throws on an unrepresentable date", () => {
    expect(() => z.toJSONSchema(z.date(), { io: "input", unrepresentable: "throw" }))
      .toThrow();
  });

  it("can represent a transform's input in input mode", () => {
    const schema = z.toJSONSchema(z.string().max(64).transform((value) => value.trim()), {
      io: "input", unrepresentable: "throw",
    });

    expect(schema).toMatchObject({ type: "string", maxLength: 64 });
  });
});

describe("JSON.parse behavior requiring strict intake before Zod (research D2/D3)", () => {
  it("silently retains the last duplicate key", () => {
    expect(JSON.parse('{"name":"first","name":"second"}')).toEqual({ name: "second" });
  });

  it("creates an own __proto__ property without changing the object's prototype", () => {
    const input: unknown = JSON.parse('{"__proto__":{"polluted":true}}');

    expect(Object.hasOwn(input as object, "__proto__")).toBe(true);
    expect(Object.getPrototypeOf(input)).toBe(Object.prototype);
    expect(() => z.strictObject({}).parse(input)).toThrow();
    expect({}).not.toHaveProperty("polluted");
  });
});
