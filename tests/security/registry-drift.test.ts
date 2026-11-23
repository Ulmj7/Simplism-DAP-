import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import type { AnyActionDefinition, JsonValue } from "@dap/contracts";
import { buildRegistry, inspectInputSchema } from "@dap/security";
import { ALL_TEST_CAPABILITIES, testMediumOptOut, testSafeEcho } from "@dap/testkit";

interface Row { id: string; version: number; definitionHash: string; inputSchemaJson: JsonValue }
const definitions = [...ALL_TEST_CAPABILITIES, testMediumOptOut];
const baseline = JSON.parse(readFileSync(new URL("./registry-drift.baseline.json", import.meta.url), "utf8")) as Row[];

function rows(inputs: readonly AnyActionDefinition[]): Row[] {
  return buildRegistry(inputs).list().map(({ definition, definitionHash }) => {
    const inspected = inspectInputSchema(definition.inputSchema);
    expect(inspected.issues).toEqual([]);
    expect(inspected.inputSchemaJson).toBeDefined();
    return { id: definition.id, version: definition.version, definitionHash, inputSchemaJson: inspected.inputSchemaJson! };
  }).sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

function assertVersioned(current: Row[], previous: Row[]): void {
  expect(current.map((row) => row.id)).toEqual(previous.map((row) => row.id));
  current.forEach((row, index) => {
    const old = previous[index]!;
    if (row.version < old.version) throw new Error(`${row.id}: version cannot decrease`);
    if (row.version === old.version && (row.definitionHash !== old.definitionHash ||
      JSON.stringify(row.inputSchemaJson) !== JSON.stringify(old.inputSchemaJson))) {
      throw new Error(`${row.id}: definition drift requires a version bump`);
    }
  });
}

function assertPinned(current: Row[], previous: Row[]): void {
  assertVersioned(current, previous);
  if (JSON.stringify(current) !== JSON.stringify(previous)) throw new Error("Review and refresh the drift baseline for the new versions");
}

describe("versioned registry drift baseline (ATK-ARCH-08)", () => {
  it("pins every default capability plus the MEDIUM opt-out", () => {
    expect(definitions).toHaveLength(7);
    assertPinned(rows(definitions), baseline);
  });

  it("detects a schema change without a version bump and accepts the explicit bump", () => {
    const before = rows([testSafeEcho]);
    const changed = { ...testSafeEcho, inputSchema: z.strictObject({ message: z.string().min(1).max(201) }) };
    expect(() => assertVersioned(rows([changed]), before)).toThrow("version bump");
    expect(() => assertVersioned(rows([{ ...changed, version: testSafeEcho.version + 1 }]), before)).not.toThrow();
    expect(() => assertVersioned(rows([{ ...testSafeEcho, version: testSafeEcho.version + 1 }]), rows([{ ...testSafeEcho, version: testSafeEcho.version + 2 }]))).toThrow("decrease");
  });

  it("requires refreshing the baseline after a version bump so later same-version drift cannot hide", () => {
    const before = rows([testSafeEcho]);
    const bumped = rows([{ ...testSafeEcho, version: testSafeEcho.version + 1 }]);
    expect(() => assertPinned(bumped, before)).toThrow("refresh");
    expect(() => assertPinned(bumped, bumped)).not.toThrow();
    const later = rows([{ ...testSafeEcho, version: testSafeEcho.version + 1, inputSchema: z.strictObject({ message: z.string().min(1).max(201) }) }]);
    expect(() => assertPinned(later, bumped)).toThrow("version bump");
  });
});
