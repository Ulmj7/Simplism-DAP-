import { describe, expect, it } from "vitest";
import type { ActionRegistry } from "@dap/contracts";
import { provenDefinition } from "./registered.js";

const HASH = "a".repeat(64);
const resolved = { id: "openProject", version: 2, definitionHash: HASH };
const registryOf = (definition: object): ActionRegistry["get"] => () => ({ definition: { id: "openProject", version: 2, ...definition }, definitionHash: HASH }) as never;

describe("what the proof keeps for the audit and execute stages", () => {
  it("copies the capability's audit allowlist as frozen rules, and the executor id", () => {
    const live = { audit: { params: [{ path: "/a", mode: "plain" }, { path: "/b", mode: "masked" }] }, executorId: "exec" };
    const proven = provenDefinition(registryOf(live), resolved)!;
    expect(proven.auditParams).toEqual([{ path: "/a", mode: "plain" }, { path: "/b", mode: "masked" }]);
    expect(Object.isFrozen(proven.auditParams)).toBe(true);
    expect(Object.isFrozen(proven.auditParams[0])).toBe(true);
    expect(proven.executorId).toBe("exec");
    live.audit.params[0]!.mode = "masked";
    expect(proven.auditParams[0]!.mode).toBe("plain"); // a later change to the live definition changes nothing
  });

  it("reads the allowlist once, however the host answers afterwards", () => {
    let reads = 0;
    const definition = { get audit() { reads += 1; return reads === 1 ? { params: [{ path: "/a", mode: "plain" }] } : { params: [{ path: "/secret", mode: "plain" }] }; } };
    const proven = provenDefinition(registryOf(definition), resolved)!;
    expect(proven.auditParams).toEqual([{ path: "/a", mode: "plain" }]);
    expect(reads).toBe(1);
  });

  it.each([["no audit", {}], ["a null audit", { audit: null }], ["audit that is a string", { audit: "x" }], ["params that are not a list", { audit: { params: "x" } }]])(
    "records nothing for %s", (_name, definition) => {
      expect(provenDefinition(registryOf(definition), resolved)!.auditParams).toEqual([]);
    });

  it("records nothing when the audit getter throws", () => {
    const definition = { id: "openProject", version: 2, get audit(): never { throw new Error("CANARY"); } };
    expect(provenDefinition((() => ({ definition, definitionHash: HASH })) as never, resolved)!.auditParams).toEqual([]);
  });

  it("drops each malformed rule and keeps the good ones", () => {
    const params = [null, 5, "x", {}, { path: 5, mode: "plain" }, { path: "/a", mode: "loud" }, { path: "/a" }, { path: "/ok", mode: "plain" }, { path: "/m", mode: "masked" }];
    expect(provenDefinition(registryOf({ audit: { params } }), resolved)!.auditParams).toEqual([{ path: "/ok", mode: "plain" }, { path: "/m", mode: "masked" }]);
  });

  it("looks at no more than 256 rules", () => {
    const params = Array.from({ length: 300 }, (_, i) => ({ path: `/p${i}`, mode: "plain" }));
    expect(provenDefinition(registryOf({ audit: { params } }), resolved)!.auditParams).toHaveLength(256);
  });
});
