import { describe, expect, it } from "vitest";
import type { ActionId, ExecutorId, RegistrationIssue } from "@dap/contracts";
import { z } from "zod";
import { buildRegistry } from "./build-registry.js";
import { bindExecutors } from "./bind-executors.js";
import { RegistrationError } from "./registration-error.js";
import { definition, executor, malformed } from "./fixtures.test-support.js";

describe("actionable startup failure report", () => {
  it("collects every independent issue across and within definitions", () => {
    let caught: unknown;
    try {
      buildRegistry([
        malformed({ id: "badAction", version: 0, risk: "HIGH", changesState: true, inputSchema: z.strictObject({ name: z.string(), userId: z.string().max(8) }) }),
        definition({ id: "secondAction" as ActionId, risk: "LOW", changesState: true }),
        definition({ id: "thirdAction" as ActionId, confirmation: { kind: "required" } }),
      ]);
    } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(RegistrationError);
    const error = caught as RegistrationError;
    expect(error.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ actionId: "badAction", rule: "R1" }),
      expect.objectContaining({ actionId: "badAction", rule: "R3", detail: expect.stringContaining("maxLength") }),
      expect.objectContaining({ actionId: "badAction", rule: "R3", detail: expect.stringContaining("userId") }),
      expect.objectContaining({ actionId: "badAction", rule: "R4" }),
      expect.objectContaining({ actionId: "badAction", rule: "R9" }),
      expect.objectContaining({ actionId: "secondAction", rule: "R6" }),
      expect.objectContaining({ actionId: "secondAction", rule: "R9" }),
      expect.objectContaining({ actionId: "thirdAction", rule: "R8" }),
    ]));
    for (const issue of error.issues) {
      expect(typeof issue.actionId).toBe("string");
      expect(issue.detail.length).toBeGreaterThan(0);
      expect(error.message).toContain(issue.actionId);
      expect(error.message).toContain(issue.rule);
      expect(error.message).toContain(issue.detail);
    }
  });

  it("duplicate ids abort startup alongside other issues", () => {
    let caught: unknown;
    try { buildRegistry([definition(), { ...definition(), version: 0 }]); } catch (error) { caught = error; }
    expect((caught as RegistrationError).issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ actionId: "viewProject", rule: "R2" }),
      expect.objectContaining({ actionId: "viewProject", rule: "R1" }),
    ]));
  });

  it("reports nested identity names and conversion errors without leaking thrown content", () => {
    let caught: unknown;
    const inputSchema = z.strictObject({ child: z.strictObject({ TENANT_ID: z.string().max(8) }) });
    try { buildRegistry([definition({ inputSchema }), definition({ id: "badSchema" as ActionId, inputSchema: z.strictObject({ date: z.date() }) })]); } catch (error) { caught = error; }
    expect((caught as RegistrationError).issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ actionId: "viewProject", rule: "R3", detail: expect.stringContaining("TENANT_ID") }),
      expect.objectContaining({ actionId: "badSchema", rule: "R3" }),
    ]));
  });

  it("turns throwing definition getters into reported issues and continues the batch", () => {
    const input = { ...definition() };
    Object.defineProperty(input, "description", { get() { throw new Error("CANARY_SECRET"); } });
    let caught: unknown;
    try { buildRegistry([input, malformed({ id: "secondAction", risk: "HIGH" })]); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(RegistrationError);
    expect((caught as RegistrationError).issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ actionId: "viewProject", rule: "R1" }),
      expect.objectContaining({ actionId: "secondAction", rule: "R4" }),
    ]));
    expect((caught as RegistrationError).message).not.toContain("CANARY_SECRET");
  });

  it("freezes a detached snapshot of the issue report", () => {
    const issue: RegistrationIssue = { actionId: "viewProject", rule: "R1", detail: "Invalid version" };
    const issues = [issue];
    const error = new RegistrationError(issues);
    Reflect.set(issue, "detail", "mutated");
    issues.length = 0;
    expect(error.issues).toEqual([{ actionId: "viewProject", rule: "R1", detail: "Invalid version" }]);
    expect(Object.isFrozen(error.issues)).toBe(true);
    expect(Object.isFrozen(error.issues[0])).toBe(true);
  });

  it("collects all executor binding issues across the registry", () => {
    const registry = buildRegistry([
      definition(),
      definition({ id: "forbiddenAction" as ActionId, risk: "FORBIDDEN", executorId: "forbiddenExecutor" as ExecutorId }),
    ]);
    let caught: unknown;
    try { bindExecutors(registry, [executor("unused"), executor("forbiddenExecutor"), executor("unused")]); } catch (error) { caught = error; }
    expect(caught).toBeInstanceOf(RegistrationError);
    expect((caught as RegistrationError).issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ actionId: "viewProject", rule: "R10", detail: "no executor is bound" }),
      expect.objectContaining({ actionId: "forbiddenAction", rule: "R7" }),
      expect.objectContaining({ actionId: "unused", rule: "R10", detail: "executor is unused" }),
      expect.objectContaining({ actionId: "unused", rule: "R10", detail: "duplicate executor id" }),
    ]));
  });
});
