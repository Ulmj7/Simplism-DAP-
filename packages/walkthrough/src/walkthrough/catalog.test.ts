import { describe, expect, it } from "vitest";
import { ALL, POSTCONDITION_NAMES, makeRegistry, walkthroughA } from "../engine/test-support.js";
import { createSemanticRegistry } from "../semantic/registry.js";
import { createWalkthroughCatalog, WalkthroughCatalogError } from "./catalog.js";
import type { WalkthroughDef } from "./definition.js";

const registry = makeRegistry();
const build = (...defs: unknown[]) => createWalkthroughCatalog(registry, [...POSTCONDITION_NAMES], defs as WalkthroughDef[]);
const issues = (...defs: unknown[]): string => { try { build(...defs); } catch (error) { return (error as WalkthroughCatalogError).issues.join(" | "); } return ""; };
/** The sample walkthrough with one step replaced (or added) and optional definition overrides. */
const tweak = (stepId: string, patch: Record<string, unknown> | null, extra: Record<string, unknown> = {}) => ({
  ...walkthroughA, ...extra,
  steps: walkthroughA.steps.flatMap((s) => (s.id !== stepId ? [s] : patch === null ? [] : [{ ...s, ...patch }])),
});
const minimal = (steps: unknown[], start = "x1") => ({ id: "mini", title: "Mini", description: "Mini walkthrough", start, steps });
const done = { id: "xdone", kind: "complete", text: "Done." };

describe("a valid catalog", () => {
  it("accepts the sample walkthroughs, lists only id, title and description, and gets frozen definitions", () => {
    const catalog = build(...ALL);
    expect(catalog.list().map((s) => s.id)).toEqual(ALL.map((d) => d.id));
    for (const summary of catalog.list()) expect(Object.keys(summary).sort()).toEqual(["description", "id", "title"]);
    const def = catalog.get("profileUpdate")!;
    expect(def.start).toBe("a1");
    expect(def.steps).toHaveLength(5);
    expect(Object.isFrozen(def)).toBe(true);
    expect(Object.isFrozen(def.steps)).toBe(true);
    expect(Object.isFrozen(def.steps[0])).toBe(true);
    expect(Object.isFrozen(catalog)).toBe(true);
    expect(Object.isFrozen(catalog.list())).toBe(true);
  });
  it("has no way to add, remove or change a walkthrough", () => {
    expect(Object.keys(build(...ALL)).sort()).toEqual(["get", "list"]);
  });
  it("get() of an unknown id, or of anything that is not a string, is undefined and never throws", () => {
    const catalog = build(...ALL);
    for (const id of ["nope", "", "__proto__", "constructor", "toString", undefined, null, 4, {}, Symbol("x")]) expect(catalog.get(id)).toBeUndefined();
  });
  it("is a copy: changing the caller's objects afterwards does not reach the catalog", () => {
    const source = JSON.parse(JSON.stringify(walkthroughA)) as { title: string; steps: { text?: string }[] };
    const catalog = build(source);
    source.title = "Changed";
    source.steps[1]!.text = "Changed";
    expect(catalog.get("profileUpdate")!.title).toBe("Update your profile");
    expect((catalog.get("profileUpdate")!.steps[1] as { text: string }).text).toBe("Type your name.");
  });
  it("accepts the boundaries: maxAttempts 1 and 10, targetWaitMs 0 and 10000", () => {
    expect(issues(tweak("a2", { maxAttempts: 1, targetWaitMs: 0 }), tweak("a3", { maxAttempts: 10, targetWaitMs: 10000 }, { id: "other" }))).toBe("");
  });
});

describe("every rejection", () => {
  it.each([
    ["a duplicate walkthrough id", () => issues(walkthroughA, walkthroughA), "duplicate walkthrough id"],
    ["a malformed walkthrough id", () => issues(tweak("a1", {}, { id: "bad id" })), "malformed walkthrough id"],
    ["a reserved walkthrough id", () => issues(tweak("a1", {}, { id: "__proto__" })), "malformed walkthrough id"],
    ["a duplicate step id", () => issues(minimal([{ id: "x1", kind: "complete", text: "A" }, { id: "x1", kind: "complete", text: "B" }])), "duplicate step id"],
    ["a missing start step", () => issues(tweak("a1", {}, { start: "nowhere" })), "missing start step"],
    ["a nonexistent next", () => issues(tweak("a2", { next: "ghost" })), "missing next step"],
    ["a nonexistent recover", () => issues(tweak("a3", { recover: "ghost" })), "missing recover step"],
    ["a recover that points at its own step", () => issues(tweak("a3", { recover: "a3" })), "recover points at the step itself"],
    ["a recover that points at a complete step", () => issues(tweak("a3", { recover: "adone" })), "recover points at a complete step"],
    ["an unknown target", () => issues(tweak("a2", { target: "profile.ghost" })), "unknown target"],
    ["a click wait on a target that does not allow click", () => issues(tweak("a3", { target: "profile.nameInput" })), "wait click needs"],
    ["an input wait on a target that does not allow input", () => issues(tweak("a2", { target: "profile.saveButton" })), "wait input needs"],
    ["an unknown wait", () => issues(tweak("a2", { wait: "hover" })), "wait must be"],
    ["an unknown route", () => issues(tweak("a1", { route: "billing" })), "unknown route"],
    ["an unknown postcondition", () => issues(tweak("a3", { verify: "mystery" })), "unknown postcondition"],
    ["a non-string postcondition", () => issues(tweak("a3", { verify: 5 })), "unknown postcondition"],
    ["maxAttempts of 0", () => issues(tweak("a2", { maxAttempts: 0 })), "maxAttempts"],
    ["maxAttempts of 11", () => issues(tweak("a2", { maxAttempts: 11 })), "maxAttempts"],
    ["a fractional maxAttempts", () => issues(tweak("a2", { maxAttempts: 1.5 })), "maxAttempts"],
    ["targetWaitMs below 0", () => issues(tweak("a2", { targetWaitMs: -1 })), "targetWaitMs"],
    ["targetWaitMs above 10000", () => issues(tweak("a2", { targetWaitMs: 10001 })), "targetWaitMs"],
    ["markup in step text", () => issues(tweak("a2", { text: "<b>Type</b>" })), "text must be plain text"],
    ["empty step text", () => issues(tweak("adone", { text: " " })), "text must be plain text"],
    ["step text over 240", () => issues(tweak("a2", { text: "x".repeat(241) })), "text must be plain text"],
    ["a title over 80", () => issues(tweak("a1", {}, { title: "x".repeat(81) })), "title must be plain text"],
    ["a description with markup", () => issues(tweak("a1", {}, { description: "a & b" })), "description must be plain text"],
    ["an unknown step kind", () => issues(minimal([{ id: "x1", kind: "script", next: "xdone" }, done])), "unknown step kind"],
    ["an unknown field on a step (conditions, loops and expressions do not exist)", () => issues(tweak("a2", { when: "x > 1" })), "unknown field when"],
    ["an unknown field on a walkthrough", () => issues(tweak("a2", {}, { variables: {} })), "unknown field variables"],
    ["no steps", () => issues({ id: "empty", title: "T", description: "D", start: "x", steps: [] }), "steps must be a non-empty array"],
    ["a non-object definition", () => issues(5), "definition must be an object"],
  ] as const)("%s", (name, run, expected) => {
    expect(run()).toContain(expected);
  });
  it("a guide target must allow highlight", () => {
    const strict = createSemanticRegistry({ routes: ["profile"], elements: [{ id: "profile.clickOnly", route: "profile", role: "button", label: "L", description: "D", operations: ["click"], privacy: "public" }] });
    const def = { id: "h", title: "T", description: "D", start: "h1", steps: [{ id: "h1", kind: "guide", target: "profile.clickOnly", text: "T", wait: "click", next: "hd" }, { id: "hd", kind: "complete", text: "D" }] };
    expect(() => createWalkthroughCatalog(strict, [], [def as WalkthroughDef])).toThrow(/does not allow highlight/);
  });
  it("a dead end (a step that can never reach a complete step) is rejected, and so is a closed cycle", () => {
    expect(issues(minimal([
      { id: "x1", kind: "guide", target: "profile.saveButton", text: "T", wait: "click", next: "xdone", recover: "x2" },
      { id: "x2", kind: "guide", target: "profile.nameInput", text: "T", wait: "input", next: "x3" },
      { id: "x3", kind: "guide", target: "profile.nameInput", text: "T", wait: "input", next: "x2" }, // a cycle x2 <-> x3 with no exit
      done,
    ]))).toContain("no path to a complete step");
  });
  it("a start step that cannot reach a complete step at all is rejected", () => {
    expect(issues(minimal([{ id: "x1", kind: "guide", target: "profile.saveButton", text: "T", wait: "click", next: "x1" }]))).toContain("no path to a complete step");
  });
  it("a step that cannot be reached from start is rejected", () => {
    expect(issues(minimal([{ id: "x1", kind: "guide", target: "profile.saveButton", text: "T", wait: "click", next: "xdone" }, done, { id: "island", kind: "complete", text: "Never" }]))).toContain("island: unreachable from start");
  });
  it("reports every problem in one error, with typed issues", () => {
    let error: unknown;
    try { build(tweak("a2", { target: "profile.ghost", maxAttempts: 99 }), tweak("a1", {}, { id: "b" })); } catch (e) { error = e; }
    expect(error).toBeInstanceOf(WalkthroughCatalogError);
    expect((error as WalkthroughCatalogError).issues.length).toBeGreaterThanOrEqual(2);
  });
  it("rejects non-array definitions", () => {
    expect(() => createWalkthroughCatalog(registry, [], "x" as never)).toThrow(WalkthroughCatalogError);
  });
});

it("rejects a happy-path cycle even when recovery can reach completion", () => {
  const guide = (id: string, next: string, recover?: string) => ({ id, kind: "guide", target: "profile.saveButton", text: "Continue.", wait: "click", next, ...(recover === undefined ? {} : { recover }) });
  expect(issues(minimal([guide("x1", "x2", "rescue"), guide("x2", "x1"), guide("rescue", "xdone"), done]))).toContain("next chain cannot reach a complete step");
});
it("bounds catalogs and steps at 100, including their exact accepted boundaries", () => {
  const defs = Array.from({ length: 100 }, (_, i) => ({ id: `w${i}`, title: "T", description: "D", start: "xdone", steps: [done] }));
  expect(build(...defs).list()).toHaveLength(100);
  expect(() => build(...defs, { ...defs[0], id: "overflow" })).toThrow(/at most 100 walkthroughs/);
  const steps = Array.from({ length: 99 }, (_, i) => ({ id: `s${i}`, kind: "guide", target: "profile.saveButton", text: "T", wait: "click", next: i === 98 ? "xdone" : `s${i + 1}` }));
  expect(build(minimal([...steps, done], "s0")).list()).toHaveLength(1);
  expect(() => build(minimal([...steps, done, { ...done, id: "overflow" }], "s0"))).toThrow(/at most 100 steps/);
});
