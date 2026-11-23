import { describe, expect, it } from "vitest";
import { buildRegistry } from "@dap/security";
import { DEMO_DEFINITIONS } from "../capabilities.js";
import { START_WALKTHROUGH_EXECUTOR_ID, createGuidanceExtension, startWalkthrough } from "./capability.js";
import { demoCatalogView } from "./walkthrough-summaries.js";

const parse = (value: unknown) => startWalkthrough.inputSchema.safeParse(value);

describe("startWalkthrough: the definition", () => {
  it("is LOW risk, changes no state, needs perm.guidance.start, any page, no confirmation, and audits only /walkthroughId (plain)", () => {
    expect(startWalkthrough).toMatchObject({
      id: "startWalkthrough", version: 1, risk: "LOW", changesState: false, requiredPermission: "perm.guidance.start", allowedPages: "any",
      confirmation: { kind: "not-required" }, audit: { params: [{ path: "/walkthroughId", mode: "plain" }] }, executorId: START_WALKTHROUGH_EXECUTOR_ID,
    });
    expect(startWalkthrough.executorId).toBe("ex.guidance-start-walkthrough");
  });
  it("has no resource and no consequence description (it never touches an application resource)", () => {
    expect(startWalkthrough.resource).toBeUndefined();
    expect(startWalkthrough.describeConsequence).toBeUndefined();
  });
  it("passes the Feature 001 registry rules next to the demo capabilities (LOW, not state-changing, own permission and executor)", () => {
    expect(() => buildRegistry([...DEMO_DEFINITIONS, startWalkthrough])).not.toThrow();
  });
});

describe("startWalkthrough: the strict parameters", () => {
  it.each(["profileUpdate", "findSecuritySettings", "a", "a-b_c9", "A".repeat(64)])("accepts the well-formed id %j", (id) => {
    expect(parse({ walkthroughId: id }).success).toBe(true);
  });
  it.each(["selector", "steps", "script", "confirmed", "risk", "permissions", "route", "action", "url", "userId", "tenantId", "page"])("refuses the extra key %s", (key) => {
    expect(parse({ walkthroughId: "profileUpdate", [key]: key === "steps" || key === "permissions" ? [] : "x" }).success).toBe(false);
  });
  it.each([
    ["missing", {}], ["empty", { walkthroughId: "" }], ["a number", { walkthroughId: 5 }], ["null", { walkthroughId: null }], ["an array", { walkthroughId: ["profileUpdate"] }], ["an object", { walkthroughId: { id: "x" } }],
    ["65 characters", { walkthroughId: "a".repeat(65) }], ["a huge string", { walkthroughId: "a".repeat(100_000) }], ["a leading space", { walkthroughId: " profileUpdate" }], ["a trailing newline", { walkthroughId: "profileUpdate\n" }],
    ["a leading digit", { walkthroughId: "1profile" }], ["a slash", { walkthroughId: "a/b" }], ["a dot", { walkthroughId: "a.b" }], ["a NUL", { walkthroughId: "a\u0000b" }],
    ["__proto__", { walkthroughId: "__proto__" }], ["constructor", { walkthroughId: "constructor" }], ["prototype", { walkthroughId: "prototype" }], ["toString", { walkthroughId: "toString" }],
    ["not an object", "profileUpdate"], ["null params", null], ["an array", [{ walkthroughId: "profileUpdate" }]],
  ])("refuses %s", (_name, value) => { expect(parse(value).success).toBe(false); });
});

describe("createGuidanceExtension: exactly { definitions, executors }", () => {
  it("adds the one definition and the one executor, frozen, and nothing else", () => {
    const { extension, trusted } = createGuidanceExtension({ catalog: demoCatalogView, starter: { start: () => ({ ok: true }) } });
    expect(Object.keys(extension).sort()).toEqual(["definitions", "executors"]);
    expect(extension.definitions).toEqual([startWalkthrough]);
    expect(extension.executors.map((e) => e.id)).toEqual(["ex.guidance-start-walkthrough"]);
    expect(Object.isFrozen(extension)).toBe(true);
    expect(Object.isFrozen(extension.definitions)).toBe(true);
    expect(trusted.receivedParams()).toEqual([]);
  });
});
