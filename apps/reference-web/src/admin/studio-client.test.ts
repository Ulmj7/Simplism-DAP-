import { describe, expect, it } from "vitest";
import { parseStudioReply } from "./studio-client.js";

const trusted = { ref: "@e12", name: "Profile", role: "link", route: "dashboard", status: "trusted", targetId: "nav.profile", operations: ["highlight", "click"], privacy: "public" };
const unregistered = { ref: "@e30", name: "Newsletter", role: "button", route: "profile", status: "unregistered" };
const snapshot = (elements: unknown[] = [trusted, unregistered], extra: object = {}) => ({ url: "http://127.0.0.1:5173/#/dashboard", route: "dashboard", page: "/#/dashboard", hidden: 0, truncated: false, elements, ...extra });
const connected = { sessionId: "s1", applicationId: "app-0123456789ab", application: "Reference application", origin: "http://127.0.0.1:5173", registrySource: "built-in" };
const captured = { targetId: "nav.profile", route: "dashboard", name: "Profile", role: "link", operations: ["highlight", "click"] };

describe("connect", () => {
  it("accepts exactly the contract shape", () => {
    expect(parseStudioReply("connect", connected)).toEqual({ kind: "connected", ...connected, resumed: false });
  });
  it.each<[string, unknown]>([
    ["not an object", "x"], ["null", null], ["an array", []],
    ["a missing key", { ...connected, origin: undefined }],
    ["an unknown key", { ...connected, extra: 1 }],
    ["the old reply without applicationId and origin", { sessionId: "s1", application: "Reference application" }],
    ["an empty session id", { ...connected, sessionId: "" }],
    ["a long session id", { ...connected, sessionId: "s".repeat(65) }],
    ["a malformed application id", { ...connected, applicationId: "app-XYZ" }],
    ["a long application name", { ...connected, application: "a".repeat(81) }],
    ["an origin with a path", { ...connected, origin: "http://127.0.0.1:5173/" }],
    ["a javascript origin", { ...connected, origin: "javascript:alert(1)" }],
    ["credentials in the origin", { ...connected, origin: "http://user:pw@127.0.0.1:5173" }],
    ["an ftp origin", { ...connected, origin: "ftp://127.0.0.1" }],
  ])("rejects %s", (_name, reply) => {
    expect(parseStudioReply("connect", reply)).toBeNull();
  });
});

describe("refresh", () => {
  it("accepts trusted and unregistered candidates, a null route and an empty list", () => {
    const parsed = parseStudioReply("refresh", snapshot());
    expect(parsed).toEqual({ kind: "snapshot", url: "http://127.0.0.1:5173/#/dashboard", route: "dashboard", page: "/#/dashboard", hidden: 0, truncated: false, elements: [
      { ...trusted }, { ...unregistered },
    ] });
    expect(parseStudioReply("refresh", snapshot([], { route: null }) as never)).not.toBeNull();
    expect(parseStudioReply("refresh", { url: "http://127.0.0.1:5173/", route: null, page: null, hidden: 0, truncated: false, elements: [{ ...unregistered, route: null }] })).not.toBeNull();
  });
  it("accepts a long page url (250 characters) while origins keep their 200-character bound", () => {
    const base = "http://long-origin.example.test:5173/#/";
    const long = base + "a".repeat(250 - base.length);
    expect(long).toHaveLength(250);
    expect(parseStudioReply("refresh", snapshot([], { url: long }))).toMatchObject({ kind: "snapshot", url: long });
    const origin = "https://" + "a".repeat(190) + ".example.test";
    expect(origin.length).toBeGreaterThan(200);
    expect(parseStudioReply("connect", { ...connected, origin })).toBeNull();
    const ok = "https://" + "a".repeat(170) + ".example.test";
    expect(ok.length).toBeLessThanOrEqual(200);
    expect(parseStudioReply("connect", { ...connected, origin: ok })).not.toBeNull();
  });
  it("accepts a page url of exactly 300 characters (the host's cut) and no more", () => {
    const base = "http://127.0.0.1:5173/#/";
    const exactly = base + "a".repeat(300 - base.length);
    expect(exactly).toHaveLength(300);
    expect(parseStudioReply("refresh", snapshot([], { url: exactly }))).toMatchObject({ kind: "snapshot", url: exactly });
    expect(parseStudioReply("refresh", snapshot([], { url: exactly + "a" }))).toBeNull();
    expect(parseStudioReply("refresh", snapshot([], { url: "" }))).toBeNull();
  });
  it("accepts 64 candidates and refuses 65", () => {
    const many = (count: number) => Array.from({ length: count }, (_, index) => ({ ...unregistered, ref: `@e${index + 1}` }));
    expect(parseStudioReply("refresh", snapshot(many(64)))).not.toBeNull();
    expect(parseStudioReply("refresh", snapshot(many(65)))).toBeNull();
  });
  it.each<[string, unknown]>([
    ["a missing route key", { url: "http://127.0.0.1:5173/", elements: [] }],
    ["an unknown top-level key", snapshot([], { extra: true })],
    ["a non-array element list", snapshot("x" as never)],
    ["an empty url", snapshot([], { url: "" })],
    ["a javascript url", snapshot([], { url: "javascript:alert(1)" })],
    ["a url longer than 300 characters", snapshot([], { url: "http://127.0.0.1:5173/#/" + "a".repeat(300) })],
    ["a malformed route", snapshot([], { route: "Dash board" })],
    ["a long route", snapshot([], { route: "r".repeat(41) })],
    ["a non-string route", snapshot([], { route: 7 })],
    ["duplicate refs", snapshot([trusted, { ...unregistered, ref: "@e12" }])],
  ])("rejects %s", (_name, reply) => {
    expect(parseStudioReply("refresh", reply)).toBeNull();
  });
  it.each<[string, unknown]>([
    ["a non-object candidate", "x"],
    ["a ref without the @e prefix", { ...trusted, ref: "e12" }],
    ["a zero ref", { ...trusted, ref: "@e0" }],
    ["a leading-zero ref", { ...trusted, ref: "@e012" }],
    ["a ten-digit ref", { ...trusted, ref: "@e1234567890" }],
    ["a ref with trailing text", { ...trusted, ref: "@e12 " }],
    ["an empty name", { ...trusted, name: "" }],
    ["a long name", { ...trusted, name: "n".repeat(121) }],
    ["a long role", { ...trusted, role: "r".repeat(41) }],
    ["an unknown status", { ...trusted, status: "approved" }],
    ["a missing status", { ref: "@e1", name: "x", role: "link", route: null }],
    ["an unknown key", { ...trusted, selector: "#x" }],
    ["a trusted candidate without a target id", { ...trusted, targetId: undefined }],
    ["a trusted candidate with a malformed target id", { ...trusted, targetId: "Nav Profile" }],
    ["a trusted candidate with a long target id", { ...trusted, targetId: `a.${"b".repeat(80)}` }],
    ["a trusted candidate without operations", { ...trusted, operations: undefined }],
    ["a trusted candidate with no operations", { ...trusted, operations: [] }],
    ["a trusted candidate with an unknown operation", { ...trusted, operations: ["highlight", "delete"] }],
    ["a trusted candidate with repeated operations", { ...trusted, operations: ["highlight", "highlight"] }],
    ["a trusted candidate with a non-array operations", { ...trusted, operations: "highlight" }],
    ["a trusted candidate that is not public", { ...trusted, privacy: "private" }],
    ["a trusted candidate without privacy", { ...trusted, privacy: undefined }],
    ["an unregistered candidate carrying a target id", { ...unregistered, targetId: "nav.profile" }],
    ["an unregistered candidate carrying operations", { ...unregistered, operations: ["highlight"] }],
    ["an unregistered candidate carrying privacy", { ...unregistered, privacy: "public" }],
  ])("rejects %s", (_name, candidate) => {
    expect(parseStudioReply("refresh", snapshot([candidate]))).toBeNull();
  });
});

describe("highlight, capture and disconnect", () => {
  it("accepts the contract shapes", () => {
    expect(parseStudioReply("highlight", { highlighted: true, ref: "@e12" })).toEqual({ kind: "highlighted", ref: "@e12" });
    expect(parseStudioReply("capture", captured)).toEqual({ kind: "captured", target: captured });
    expect(parseStudioReply("disconnect", { closed: true })).toEqual({ kind: "closed" });
  });
  it.each<[string, unknown]>([
    ["false", { highlighted: false, ref: "@e12" }], ["a bad ref", { highlighted: true, ref: "12" }], ["a missing ref", { highlighted: true }],
    ["an unknown key", { highlighted: true, ref: "@e12", saved: true }], ["a string flag", { highlighted: "true", ref: "@e12" }],
  ])("rejects a highlight reply with %s", (_name, reply) => {
    expect(parseStudioReply("highlight", reply)).toBeNull();
  });
  it.each<[string, unknown]>([
    ["the old reply without operations", { targetId: "nav.profile", route: "dashboard", name: "Profile", role: "link" }],
    ["an unknown key", { ...captured, ref: "@e12" }],
    ["a malformed target id", { ...captured, targetId: "x" }],
    ["a null route", { ...captured, route: null }],
    ["an empty name", { ...captured, name: "" }],
    ["an empty role", { ...captured, role: "" }],
    ["unknown operations", { ...captured, operations: ["fly"] }],
    ["no operations", { ...captured, operations: [] }],
  ])("rejects a capture reply with %s", (_name, reply) => {
    expect(parseStudioReply("capture", reply)).toBeNull();
  });
  it.each<[string, unknown]>([["false", { closed: false }], ["an unknown key", { closed: true, sessionId: "s" }], ["empty", {}], ["a string", "closed"]])(
    "rejects a disconnect reply that is %s", (_name, reply) => {
      expect(parseStudioReply("disconnect", reply)).toBeNull();
    });
  it("never copies unknown properties into a parsed reply", () => {
    const parsed = parseStudioReply("refresh", snapshot());
    expect(JSON.stringify(parsed)).not.toContain("selector");
    const reply = parseStudioReply("capture", captured);
    expect(reply && "target" in reply ? Object.keys(reply.target).sort() : []).toEqual(["name", "operations", "role", "route", "targetId"]);
  });
});
