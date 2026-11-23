import { describe, it, expect } from "vitest";
import { z } from "zod";
import type { RiskLevel, TenantId } from "@dap/contracts";
import {
  NO_EXECUTOR,
  ALL_TEST_CAPABILITIES,
  INVALID_PARAM_SAMPLES,
  VALID_PARAMS,
  testCriticalDelete,
  testForbiddenShell,
  testHighPublish,
  testMediumDraft,
  testMediumOptOut,
} from "./index.js";
import type { TestHighPublishParams } from "./index.js";

const ID_RE = /^[a-z][A-Za-z0-9]{2,63}$/;

const RESERVED_PARAM_NAMES = new Set([
  "userId", "tenantId", "sessionId", "role", "roles",
  "permission", "permissions", "isAdmin", "confirmed", "confirmation",
  "confirmationId", "approved", "authorization", "token",
]);

const ALL = ALL_TEST_CAPABILITIES;

function schemaNode(def: (typeof ALL)[number]) {
  return z.toJSONSchema(def.inputSchema, { io: "input" }) as Record<string, unknown>;
}

/** Collect JSON-schema problems: unclosed objects, unbounded strings/arrays, reserved names. */
function schemaIssues(node: Record<string, unknown>, path: string, issues: string[]): void {
  if (typeof node !== "object" || node === null) return;
  if (node.type === "object") {
    if (node.additionalProperties !== false) {
      issues.push(`${path}: object not closed (additionalProperties !== false)`);
    }
    const props = node.properties;
    if (typeof props === "object" && props !== null) {
      for (const [key, child] of Object.entries(props)) {
        if (RESERVED_PARAM_NAMES.has(key)) issues.push(`${path}/${key}: reserved parameter name`);
        schemaIssues(child as Record<string, unknown>, `${path}/${key}`, issues);
      }
    }
  } else if (node.type === "string") {
    if (typeof node.maxLength !== "number") issues.push(`${path}: string without maxLength`);
  } else if (node.type === "array") {
    if (typeof node.maxItems !== "number") issues.push(`${path}: array without maxItems`);
    if (typeof node.items === "object" && node.items !== null) {
      schemaIssues(node.items as unknown as Record<string, unknown>, `${path}[]`, issues);
    }
  }
}

describe("test-capabilities (T030)", () => {
  it("ids all match ^[a-z][A-Za-z0-9]{2,63}$ and are unique", () => {
    const ids: string[] = ALL.map((d) => d.id as string);
    for (const id of ids) {
      expect(id).toMatch(ID_RE);
    }
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("exactly one definition per risk class with the required flags", () => {
    const byId = new Map(ALL.map((d) => [d.id, d] as [string, (typeof ALL)[number]]));
    const check = (id: string, risk: RiskLevel, changesState: boolean, confirmationRequired: boolean) => {
      const def = byId.get(id);
      expect(def, id).toBeDefined();
      expect(def?.risk).toBe(risk);
      expect(def?.changesState).toBe(changesState);
      expect(def?.confirmation.kind).toBe(confirmationRequired ? "required" : "not-required");
    };
    check("testSafeEcho", "SAFE", false, false);
    check("testLowNavigate", "LOW", false, false);
    check("testMediumDraft", "MEDIUM", true, true);
    check("testHighPublish", "HIGH", true, true);
    check("testCriticalDelete", "CRITICAL", true, true);
    check("testForbiddenShell", "FORBIDDEN", false, false);
  });

  it("a separate MEDIUM opt-out has a justification while the default requires confirmation", () => {
    expect(testMediumDraft.confirmation.kind).toBe("required");
    expect(testMediumOptOut.id).not.toBe(testMediumDraft.id);
    expect(testMediumOptOut.risk).toBe("MEDIUM");
    expect(testMediumOptOut.changesState).toBe(true);
    expect(testMediumOptOut.inputSchema.safeParse(VALID_PARAMS.testMediumDraft).success).toBe(true);
    expect(testMediumOptOut.inputSchema.safeParse({}).success).toBe(false);
    const confirmation = testMediumOptOut.confirmation;
    expect(confirmation.kind).toBe("not-required");
    if (confirmation.kind === "not-required") {
      expect(typeof confirmation.justification).toBe("string");
      expect((confirmation.justification as string).length).toBeGreaterThan(0);
    } else {
      expect.unreachable();
    }
  });

  it("HIGH and CRITICAL have resource extractors and consequence describers", () => {
    expect(testHighPublish.resource).toBeTypeOf("function");
    expect(testHighPublish.describeConsequence).toBeTypeOf("function");
    expect(testCriticalDelete.resource).toBeTypeOf("function");
    expect(testCriticalDelete.describeConsequence).toBeTypeOf("function");
    expect(testMediumDraft.resource).toBeTypeOf("function");
  });

  it("resource extractors target documents from validated params", () => {
    expect(testMediumDraft.resource!({ documentId: "doc-9", draft: "d" } as const)).toEqual({
      type: "document",
      id: "doc-9",
    });
    expect(testCriticalDelete.resource!({ documentId: "doc-7" } as const)).toEqual({
      type: "document",
      id: "doc-7",
    });
  });

  it("describeConsequence is built only from the trusted resolved resource", () => {
    const trusted = {
      ref: { type: "document" as const, id: "doc-1" },
      tenantId: "11111111-1111-4111-8111-111111111111" as TenantId,
      displayName: "Q3 Budget",
    };
    // Untrusted params containing a would-be decoy name: the summary must not echo it.
    const params: TestHighPublishParams = { documentId: "doc-1", audience: ["evil-decoy"] };
    const withResource = testHighPublish.describeConsequence!({ params, resource: trusted });
    expect(withResource.title).toContain("Q3 Budget");
    expect(withResource.title).not.toContain("evil-decoy");
    expect(withResource.irreversible).toBe(false);

    const withoutResource = testCriticalDelete.describeConsequence!({
      params: { documentId: "doc-1" },
      resource: null,
    });
    expect(withoutResource.title).not.toContain("doc-1");
    expect(withoutResource.irreversible).toBe(true);
    const onlyTrusted = {
      resource: trusted,
      get params(): never { throw new Error("Consequence must not read planner parameters"); },
    };
    for (const def of [testMediumDraft, testHighPublish, testCriticalDelete]) {
      expect(def.describeConsequence!(onlyTrusted).title).toContain(trusted.displayName);
    }
  });

  it("testForbiddenShell has no executor", () => {
    expect(testForbiddenShell.executorId).toBe(NO_EXECUTOR);
    expect(typeof testForbiddenShell.resource).toBe("function");
  });

  it("every JSON schema is closed and bounded, with no reserved parameter names", () => {
    for (const def of ALL) {
      const issues: string[] = [];
      schemaIssues(schemaNode(def), def.id, issues);
      expect(issues, `${def.id}: ${issues.join("; ")}`).toEqual([]);
    }
  });

  it("valid samples parse against their schemas", () => {
    const byId = new Map(ALL.map((d) => [d.id, d] as [string, (typeof ALL)[number]]));
    for (const [id, params] of Object.entries(VALID_PARAMS)) {
      const def = byId.get(id);
      expect(def, id).toBeDefined();
      expect(def!.inputSchema.parse(params as never), id).toEqual(params);
    }
  });

  it("invalid samples (missing / extra key / too long) are rejected", () => {
    const byId = new Map(ALL.map((d) => [d.id, d] as [string, (typeof ALL)[number]]));
    expect(INVALID_PARAM_SAMPLES.length).toBeGreaterThanOrEqual(6);
    for (const sample of INVALID_PARAM_SAMPLES) {
      const def = byId.get(sample.capabilityId);
      expect(def, sample.capabilityId).toBeDefined();
      expect(() => def!.inputSchema.parse(sample.params as never), sample.capabilityId)
        .toThrow();
    }
  });
});
