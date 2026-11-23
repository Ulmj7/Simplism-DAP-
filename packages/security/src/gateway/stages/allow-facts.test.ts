import { describe, expect, it } from "vitest";
import { chain } from "../chain.test-support.js";
import { readAllowFacts, readAuditedFacts } from "./allow-facts.js";
import { CONFIRMATION, DIGEST, EVENT_ID, bend, goodFacts, withAudit, without } from "./stage-facts.test-support.js";
import type { Facts } from "./stage-facts.test-support.js";

const world = chain();
const good = () => goodFacts(world);
const accepted = (f: Facts): Facts => ({ ...bend(f, "risk", { confirmation: "accepted" }), confirmation: { state: "accepted", confirmationId: CONFIRMATION } });

describe("readAllowFacts", () => {
  it("reads consistent facts into one frozen bundle taken from the right slots", () => {
    const facts = readAllowFacts(good() as never);
    expect(facts).toEqual({ actionId: "openProject", version: 2, risk: "SAFE", definitionHash: world.registry.get("openProject")!.definitionHash, params: { projectId: "p1", note: "SECRET_NOTE" }, paramsDigest: DIGEST, resource: { type: "project", id: "p1", displayName: "Project One" }, confirmationId: null });
    expect(Object.isFrozen(facts)).toBe(true);
  });
  it("reads an accepted confirmation", () => {
    expect(readAllowFacts(accepted(good()) as never)).toMatchObject({ confirmationId: CONFIRMATION });
  });
  it("takes the version from resolve and the parameters from validate (not from intake)", () => {
    expect(readAllowFacts(bend(bend(good(), "resolve", { version: 9 }), "intake", { params: { other: 1 } }) as never)).toMatchObject({ version: 9, params: { projectId: "p1", note: "SECRET_NOTE" } });
  });
  it.each(["intake", "resolve", "validate", "authorize", "risk", "confirmation"])("refuses a missing, extended or non-object %s slot", (slot) => {
    expect(readAllowFacts(without(good(), slot) as never)).toBeUndefined();
    expect(readAllowFacts(bend(good(), slot, { surprise: 1 }) as never)).toBeUndefined();
    expect(readAllowFacts({ ...good(), [slot]: "x" } as never)).toBeUndefined();
  });
  it.each([
    ["intake and resolve disagree on the action", (f: Facts) => bend(f, "intake", { action: "x" })], ["resolve and the risk stage disagree on the risk", (f: Facts) => bend(f, "risk", { risk: "LOW" })],
    ["a version of 0", (f: Facts) => bend(f, "resolve", { version: 0 })], ["a fractional version", (f: Facts) => bend(f, "resolve", { version: 1.5 })],
    ["a definition hash that is not hex", (f: Facts) => bend(f, "resolve", { definitionHash: "z".repeat(64) })],
    ["a digest of 65 hex characters", (f: Facts) => bend(f, "validate", { paramsDigest: "a".repeat(65) })], ["a digest with a prefix", (f: Facts) => bend(f, "validate", { paramsDigest: `x${DIGEST}` })],
    ["a digest with a suffix", (f: Facts) => bend(f, "validate", { paramsDigest: `${DIGEST}x` })], ["a definition hash with a prefix", (f: Facts) => bend(f, "resolve", { definitionHash: `x${DIGEST}` })],
    ["a resource whose display name is empty", (f: Facts) => bend(f, "authorize", { resource: { type: "project", id: "p1", displayName: "" } })],
    ["a resource whose id is empty", (f: Facts) => ({ ...bend(f, "validate", { resource: { type: "project", id: "" } }), authorize: { resource: { type: "project", id: "", displayName: "x" } } })],
    ["a FORBIDDEN risk", (f: Facts) => ({ ...bend(f, "resolve", { risk: "FORBIDDEN" }), risk: { risk: "FORBIDDEN", confirmation: "not_required" } })], ["an unknown risk", (f: Facts) => bend(f, "risk", { risk: "TINY" })],
    ["a confirmation id that is not a UUID", (f: Facts) => ({ ...bend(f, "risk", { confirmation: "accepted" }), confirmation: { state: "accepted", confirmationId: "c-1" } })],
    ["the risk stage and the confirmation stage disagreeing", (f: Facts) => bend(f, "risk", { confirmation: "accepted" })], ["an accepted confirmation with no id", (f: Facts) => ({ ...bend(f, "risk", { confirmation: "accepted" }), confirmation: { state: "accepted", confirmationId: null } })],
    ["an id with no accepted confirmation", (f: Facts) => bend(f, "confirmation", { confirmationId: CONFIRMATION })], ["a resource validate extracted that authorize did not resolve", (f: Facts) => ({ ...f, authorize: { resource: null } })],
    ["a resource authorize resolved that validate did not extract", (f: Facts) => bend(f, "validate", { resource: null })], ["a resource with another id", (f: Facts) => bend(f, "authorize", { resource: { type: "project", id: "p2", displayName: "x" } })],
    ["a resource with another type", (f: Facts) => bend(f, "authorize", { resource: { type: "folder", id: "p1", displayName: "x" } })], ["parameters that are an array", (f: Facts) => bend(f, "validate", { params: [] })],
  ])("refuses %s", (_name, make) => {
    expect(readAllowFacts(make(good()) as never)).toBeUndefined();
  });
  it("accepts no resource at all when both stages say so", () => {
    expect(readAllowFacts({ ...bend(good(), "validate", { resource: null }), authorize: { resource: null } } as never)).toMatchObject({ resource: null });
  });
});

describe("readAuditedFacts", () => {
  it("adds the recorded event id, frozen", () => {
    const facts = readAuditedFacts(withAudit(good()) as never);
    expect(facts).toMatchObject({ eventId: EVENT_ID, actionId: "openProject" });
    expect(Object.isFrozen(facts)).toBe(true);
  });
  it("needs the audit slot, and the base facts", () => {
    expect(readAuditedFacts(good() as never)).toBeUndefined();
    expect(readAuditedFacts(without(withAudit(good()), "validate") as never)).toBeUndefined();
  });
  it.each([
    ["an event id that is not a UUID", { eventId: "e" }], ["another action", { actionId: "x" }], ["another version", { version: 3 }], ["a version of 0", { version: 0 }], ["another risk", { risk: "LOW" }],
    ["FORBIDDEN", { risk: "FORBIDDEN" }], ["another digest", { paramsDigest: "b".repeat(64) }], ["a digest with a prefix", { paramsDigest: `x${DIGEST}` }], ["a confirmation nobody accepted", { confirmationId: CONFIRMATION }],
    ["a field nobody defined", { surprise: 1 }],
  ])("refuses an audit slot with %s", (_name, patch) => {
    expect(readAuditedFacts(bend(withAudit(good()), "audit", patch) as never)).toBeUndefined();
  });
  it("refuses an audit slot whose confirmation id is not a UUID even when the stage agrees", () => {
    const facts = { ...accepted(good()), confirmation: { state: "accepted", confirmationId: "nope" } };
    expect(readAuditedFacts(bend(withAudit(facts), "audit", { confirmationId: "nope" }) as never)).toBeUndefined();
  });
  it("accepts an accepted confirmation recorded with the same id", () => {
    expect(readAuditedFacts(withAudit(accepted(good())) as never)).toMatchObject({ confirmationId: CONFIRMATION });
  });
});
