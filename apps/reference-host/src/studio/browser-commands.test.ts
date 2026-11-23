import { describe, expect, it } from "vitest";
import { REF_PATTERN, SESSION_ID_PATTERN, STUDIO_ACTIONS, parseStudioCommand } from "./browser-commands.js";

const APP = "app-0123456789ab";
const WT = "wt-0123456789ab";

describe("parseStudioCommand: exact keys per action", () => {
  it("accepts every command with exactly its keys", () => {
    expect(parseStudioCommand({ action: "connect", applicationId: APP })).toEqual({ action: "connect", applicationId: APP });
    expect(parseStudioCommand({ action: "connect", applicationId: APP, walkthroughId: WT })).toEqual({ action: "connect", applicationId: APP, walkthroughId: WT });
    expect(parseStudioCommand({ action: "refresh", sessionId: "s-1", applicationId: APP })).toEqual({ action: "refresh", sessionId: "s-1", applicationId: APP });
    expect(parseStudioCommand({ action: "highlight", sessionId: "s", applicationId: APP, ref: "@e12" })).toEqual({ action: "highlight", sessionId: "s", applicationId: APP, ref: "@e12" });
    expect(parseStudioCommand({ action: "capture", sessionId: "s", applicationId: APP, ref: "@e999999999" })).toEqual({ action: "capture", sessionId: "s", applicationId: APP, ref: "@e999999999" });
    expect(parseStudioCommand({ action: "disconnect", sessionId: "s" })).toEqual({ action: "disconnect", sessionId: "s" });
    expect(parseStudioCommand({ action: "disconnect", sessionId: "s", applicationId: APP })).toEqual({ action: "disconnect", sessionId: "s", applicationId: APP });
  });
  it("covers all nine actions and no other", () => {
    expect([...STUDIO_ACTIONS]).toEqual(["connect", "resume", "refresh", "highlight", "capture", "register", "check", "repair", "disconnect"]);
    for (const action of ["navigate", "click", "type", "eval", "screenshot", "CONNECT", ""]) expect(parseStudioCommand({ action })).toBeNull();
  });
  it.each([
    ["an extra key on connect", { action: "connect", applicationId: APP, origin: "http://x" }],
    ["a registry or label from the request", { action: "connect", applicationId: APP, registryId: "reference", labels: [] }],
    ["connect without an application", { action: "connect" }],
    ["a walkthrough id that is a built-in id", { action: "connect", applicationId: APP, walkthroughId: "profileUpdate" }],
    ["a preview walkthrough id", { action: "connect", applicationId: APP, walkthroughId: "wt-preview" }],
    ["an upper-case application id", { action: "connect", applicationId: "app-0123456789AB" }],
    ["a walkthrough-shaped application id", { action: "connect", applicationId: WT }],
    ["a ref without the at-sign", { action: "capture", sessionId: "s", applicationId: APP, ref: "e1" }],
    ["a ref with a leading zero", { action: "capture", sessionId: "s", applicationId: APP, ref: "@e01" }],
    ["a ref with ten digits", { action: "capture", sessionId: "s", applicationId: APP, ref: "@e1234567890" }],
    ["a selector in place of a ref", { action: "highlight", sessionId: "s", applicationId: APP, ref: "#save" }],
    ["highlight without a ref", { action: "highlight", sessionId: "s", applicationId: APP }],
    ["capture without an application", { action: "capture", sessionId: "s", ref: "@e1" }],
    ["refresh with a ref", { action: "refresh", sessionId: "s", applicationId: APP, ref: "@e1" }],
    ["refresh without an application", { action: "refresh", sessionId: "s" }],
    ["disconnect with a malformed application", { action: "disconnect", sessionId: "s", applicationId: "x" }],
    ["disconnect with an extra key", { action: "disconnect", sessionId: "s", force: true }],
    ["a session id with a space", { action: "refresh", sessionId: "a b", applicationId: APP }],
    ["a session id that is too long", { action: "refresh", sessionId: "a".repeat(65), applicationId: APP }],
    ["a non-string session id", { action: "refresh", sessionId: 7, applicationId: APP }],
  ])("refuses %s", (_name, body) => { expect(parseStudioCommand(body)).toBeNull(); });
  it.each([null, undefined, 5, "connect", [], [{ action: "connect" }], true])("refuses a body that is not an object: %j", (body) => { expect(parseStudioCommand(body)).toBeNull(); });
  it("refuses prototype-style and inherited keys (own keys only)", () => {
    const inherited = Object.create({ action: "connect", applicationId: APP }) as object;
    expect(parseStudioCommand(inherited)).toBeNull();
    expect(parseStudioCommand(JSON.parse('{"action":"connect","applicationId":"app-0123456789ab","__proto__":{"x":1}}'))).toBeNull();
  });
  it("the patterns are anchored and bounded", () => {
    expect(REF_PATTERN.test("@e1\n")).toBe(false);
    expect(REF_PATTERN.test("x@e1")).toBe(false);
    expect(SESSION_ID_PATTERN.test("\u0000")).toBe(false);
    expect(SESSION_ID_PATTERN.test("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
  });
});

describe("check and repair commands (Studio COMPLETION)", () => {
  const base = { sessionId: "session-1", applicationId: APP };
  const repair = { action: "repair", ...base, targetId: "orders.submitButton", ref: "@e3", operations: ["highlight", "click"], label: "L", description: "D", confirm: false };
  it("check has exactly action, sessionId and applicationId", () => {
    expect(parseStudioCommand({ action: "check", ...base })).toEqual({ action: "check", ...base });
    for (const bad of [{ action: "check", sessionId: "session-1" }, { action: "check", ...base, ref: "@e1" }, { action: "check", ...base, confirm: true }, { action: "check", sessionId: "", applicationId: APP }, { action: "check", ...base, applicationId: "nope" }]) expect(parseStudioCommand(bad)).toBeNull();
  });
  it("repair has exactly its keys, a real boolean confirm and bounded values", () => {
    expect(parseStudioCommand(repair)).toEqual({ ...repair, operations: ["highlight", "click"] });
    expect(parseStudioCommand({ ...repair, confirm: true })).toMatchObject({ confirm: true });
    const missing: Record<string, unknown> = { ...repair }; delete missing.confirm;
    for (const bad of [missing, { ...repair, confirm: "true" }, { ...repair, confirm: 0 }, { ...repair, marker: "a.b" }, { ...repair, role: "link" }, { ...repair, route: "x" }, { ...repair, privacy: "public" }, { ...repair, ref: "e3" }, { ...repair, ref: "@e0" },
      { ...repair, targetId: "x".repeat(201) }, { ...repair, label: "x".repeat(1001) }, { ...repair, description: "x".repeat(2001) }, { ...repair, operations: Array(17).fill("highlight") }, { ...repair, operations: ["x".repeat(41)] }, { ...repair, operations: "highlight" }, { ...repair, targetId: 5 }]) {
      expect(parseStudioCommand(bad), JSON.stringify(bad).slice(0, 60)).toBeNull();
    }
  });
});
