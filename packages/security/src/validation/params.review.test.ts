import { describe, expect, it } from "vitest";
import { z } from "zod";
import { paramsDigest, validateParams } from "./params.js";
import { definition } from "../registry/fixtures.test-support.js";
import { buildRegistry } from "../registry/build-registry.js";
import { denyDecision } from "../gateway/decision.js";
import { toPlannerFeedback } from "../gateway/feedback.js";

const scope = { tenantId: "tenant-a", userId: "alice" };
const digest = (params: unknown, resource: unknown) => paramsDigest({ actionId: "viewProject", version: 1, params, resource: resource as never, ...scope });

describe("parameter boundary review regressions", () => {
  it("validates and hashes the same first resource snapshot", () => {
    let typeReads = 0;
    let idReads = 0;
    const resource = { get type() { return ++typeReads === 1 ? "document" : ""; }, get id() { return ++idReads === 1 ? "doc-a" : ""; } };
    expect(digest({}, resource)).toBe(digest({}, { type: "document", id: "doc-a" }));
    expect({ typeReads, idReads }).toEqual({ typeReads: 1, idReads: 1 });
  });

  it("captures aliases shared between params and resource only once", () => {
    let reads = 0;
    const shared = { type: "document", get id() { return ++reads === 1 ? "doc-a" : "doc-b"; } };
    const stable = { type: "document", id: "doc-a" };
    expect(digest({ ref: shared }, shared)).toBe(digest({ ref: stable }, stable));
    expect(reads).toBe(1);
  });

  it("invokes the same safeParse method it checked, read once with its schema receiver", () => {
    let reads = 0;
    let invocations = 0;
    const schema = { get safeParse() {
      if (++reads > 1) return () => ({ success: true, data: { message: "forged" } });
      return function (this: unknown) { invocations++; expect(this).toBe(schema); return { success: false, error: { issues: [{ code: "invalid_type", path: ["message"] }] } }; };
    } };
    expect(validateParams({ ...definition(), inputSchema: schema } as never, { message: 7 }, scope)).toMatchObject({ ok: false });
    expect(reads).toBe(1);
    expect(invocations).toBe(1);
  });

  it("does not echo model values from a registered refinement's custom issue path", () => {
    const schema = z.strictObject({ message: z.string().max(100) }).superRefine((params, ctx) => {
      ctx.addIssue({ code: "custom", path: [params.message], message: "private refinement detail" });
    });
    const registered = buildRegistry([definition({ inputSchema: schema })]).get("viewProject")!.definition;
    const result = validateParams(registered, { message: "CANARY_INPUT_VALUE" }, scope);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected a rejection");
    expect(JSON.stringify(result)).not.toContain("CANARY_INPUT_VALUE");
    const feedback = toPlannerFeedback(denyDecision({ decisionId: "d", requestId: "r" as never, stage: "validate", outcome: "INVALID_PARAMETERS", reason: "invalid_parameters", issues: result.issues }));
    expect(JSON.stringify(feedback)).not.toContain("CANARY_INPUT_VALUE");
  });

  it("also redacts invented paths for builtin issue codes and numeric values disguised as array indices", () => {
    const schema = z.strictObject({ count: z.number().min(0).max(10000), tags: z.array(z.string().max(5)).max(2) }).superRefine((params, ctx) => {
      ctx.addIssue({ code: "too_big", origin: "string", maximum: 5, inclusive: true, path: ["CANARY_BUILTIN_PATH"], message: "private" });
      ctx.addIssue({ code: "custom", path: ["tags", params.count], message: "private" });
    });
    const registered = buildRegistry([definition({ inputSchema: schema })]).get("viewProject")!.definition;
    expect(validateParams(registered, { count: 9999, tags: ["ok"] }, scope)).toEqual({ ok: false, issues: [{ path: "", code: "too_long" }, { path: "", code: "invalid" }] });
  });

  it("uses root-only diagnostics if schema path declarations cannot be inspected", () => {
    const schema = { safeParse: () => ({ success: false, error: { issues: [{ code: "custom", path: ["CANARY_HOST_PATH"] }] } }) };
    expect(validateParams({ ...definition(), inputSchema: schema } as never, {}, scope)).toEqual({ ok: false, issues: [{ path: "", code: "invalid" }] });
  });
});
