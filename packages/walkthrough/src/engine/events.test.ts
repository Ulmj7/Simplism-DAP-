import { describe, expect, it } from "vitest";
import { makeRegistry } from "./test-support.js";
import { parseSemanticEvent } from "./events.js";

const registry = makeRegistry();
const parse = (raw: unknown) => parseSemanticEvent(raw, registry);

describe("parseSemanticEvent accepts exactly the known shapes", () => {
  it.each([
    [{ type: "click", id: "profile.saveButton" }],
    [{ type: "input", id: "profile.nameInput", nonEmpty: true }],
    [{ type: "input", id: "profile.nameInput", nonEmpty: false }],
    [{ type: "routeChanged", route: "settings" }],
    [{ type: "targetAvailable", id: "settings.twoFactorSetup" }],
    [{ type: "targetGone", id: "settings.twoFactorSetup" }],
    [{ type: "ack" }],
  ])("%j", (raw) => {
    expect(parse(raw)).toEqual(raw);
    expect(Object.isFrozen(parse(raw))).toBe(true);
    expect(parse(raw)).not.toBe(raw);
  });
  it("copies only the known fields: a returned event carries no value", () => {
    const event = parse({ type: "input", id: "profile.nameInput", nonEmpty: true });
    expect(Object.keys(event!).sort()).toEqual(["id", "nonEmpty", "type"]);
  });
});

describe("everything else is null, and nothing throws", () => {
  it.each([
    ["a value in an input event", { type: "input", id: "profile.nameInput", nonEmpty: true, value: "Ada" }],
    ["a non-boolean nonEmpty", { type: "input", id: "profile.nameInput", nonEmpty: "yes" }],
    ["a missing nonEmpty", { type: "input", id: "profile.nameInput" }],
    ["a truthy number nonEmpty", { type: "input", id: "profile.nameInput", nonEmpty: 1 }],
    ["an unregistered id", { type: "click", id: "profile.ghost" }],
    ["a non-string id", { type: "click", id: 5 }],
    ["an unregistered route", { type: "routeChanged", route: "billing" }],
    ["an unknown type", { type: "hover", id: "profile.saveButton" }],
    ["a missing type", { id: "profile.saveButton" }],
    ["an extra property", { type: "click", id: "profile.saveButton", extra: 1 }],
    ["an ack with a property", { type: "ack", id: "profile.saveButton" }],
    ["an array", [{ type: "ack" }]],
    ["null", null],
    ["a string", "click"],
    ["a number", 5],
    ["undefined", undefined],
    ["a function", () => ({ type: "ack" })],
    ["a class instance", new (class Evt { type = "ack"; })()],
    ["an own __proto__ key", JSON.parse('{"type":"click","id":"profile.saveButton","__proto__":{"admin":true}}')],
    ["a constructor key", { type: "click", id: "profile.saveButton", constructor: 1 }],
    ["a symbol key", { type: "ack", [Symbol("s")]: 1 }],
    ["an inherited type", Object.create({ type: "ack" })],
    ["a getter", { get type() { return "ack"; } }],
    ["a throwing getter", { type: "click", get id(): string { throw new Error("boom"); } }],
    ["a throwing proxy", new Proxy({}, { ownKeys() { throw new Error("boom"); } })],
    ["a prototype-name type", { type: "__proto__" }],
    ["a type that is a prototype method name", { type: "toString" }],
  ])("%s", (_name, raw) => {
    expect(() => parse(raw)).not.toThrow();
    expect(parse(raw)).toBeNull();
  });
  it("an object with a null prototype is fine", () => {
    expect(parse(Object.assign(Object.create(null), { type: "ack" }))).toEqual({ type: "ack" });
  });
});

it("captures data descriptors once without invoking changing get traps", () => {
  let reads = 0;
  const raw = new Proxy({ type: "click", id: "profile.saveButton" }, {
    get() { throw new Error("ordinary reads are forbidden"); },
    getOwnPropertyDescriptor(target, key) {
      const descriptor = Object.getOwnPropertyDescriptor(target, key)!;
      if (key === "id") return { ...descriptor, value: ++reads === 1 ? "profile.saveButton" : "profile.ghost" };
      return descriptor;
    },
  });
  expect(parse(raw)).toEqual({ type: "click", id: "profile.saveButton" });
  expect(reads).toBe(1);
  expect(parse(Object.freeze({ type: "ack" }))).toEqual({ type: "ack" });
  expect(parse({ type: "click", id: "x".repeat(100_000) })).toBeNull();
  expect(parse({ type: "ack", prototype: "SECRET" })).toBeNull();
});
