/** The pure cores of the editor (S9): step operations, summaries, validity, verification vocabulary and the preview's wording. */
import { createSemanticRegistry } from "@dap/walkthrough";
import type { SemanticElementDef } from "@dap/walkthrough";
import { describe, expect, it } from "vitest";
import type { CheckView } from "./checks.js";
import { draftToDefinition, emptyStep, MAX_EDITOR_STEPS } from "./draft.js";
import type { EditorDraft } from "./draft.js";
import { deleteStep, duplicateStep, hasRecoveryReference, moveStep, saveStateText, stepSummary, stepValidity, validityText } from "./editor-model.js";
import { diagnose, diagnosticSentences, progressOf } from "./preview-model.js";
import { checkInputOf, conditionSupport, describeCheck, fieldsOf } from "./verification.js";

const el = (id: string, role: SemanticElementDef["role"], operations: SemanticElementDef["operations"], route = "orders"): SemanticElementDef => ({ id, route, role, label: id, description: id, operations, privacy: "public" });
const registry = createSemanticRegistry({ routes: ["orders", "profile"], elements: [
  el("orders.submit", "button", ["highlight", "click"]), el("orders.note", "textbox", ["highlight", "input", "focus"]), el("orders.status", "text", ["highlight"]), el("profile.save", "button", ["highlight", "click"], "profile"),
] });
const draftOf = (...steps: EditorDraft["steps"]): EditorDraft => ({ title: "T", description: "D", completion: "Done.", steps });
const step = (target: string, wait: "click" | "input" | "ack" | "", text: string, verify?: string) => ({ target, wait, text, ...(verify === undefined ? {} : { verify }) });

describe("step operations", () => {
  const three = () => draftOf(step("orders.submit", "click", "One", "route.orders"), step("orders.note", "input", "Two"), step("profile.save", "click", "Three"));
  it("duplicate copies instruction, target, interaction and verification, inserts right after and selects the copy", () => {
    const draft = three();
    expect(duplicateStep(draft, 0)).toBe(1);
    expect(draft.steps.map(({ target, wait, text, verify }) => step(target, wait, text, verify))).toEqual([step("orders.submit", "click", "One", "route.orders"), step("orders.submit", "click", "One", "route.orders"), step("orders.note", "input", "Two"), step("profile.save", "click", "Three")]);
    expect(draft.steps.map(item => item.id)).toEqual(["s1", "s4", "s2", "s3"]);
    expect(draft.steps[0]).not.toBe(draft.steps[1]);
    draft.steps[1]!.text = "changed";
    expect(draft.steps[0]!.text).toBe("One");
  });
  it("duplicate of a step without verification has none, of the last step appends, and is refused at the maximum", () => {
    const draft = three();
    expect(duplicateStep(draft, 2)).toBe(3);
    expect(draft.steps[3]).toEqual({ ...step("profile.save", "click", "Three"), id: "s4" });
    expect("verify" in draft.steps[3]!).toBe(false);
    while (draft.steps.length < MAX_EDITOR_STEPS) draft.steps.push(emptyStep());
    const before = JSON.stringify(draft);
    expect(duplicateStep(draft, 0)).toBeNull();
    expect(JSON.stringify(draft)).toBe(before);
    expect(duplicateStep(draft, 99)).toBeNull();
    expect(duplicateStep(draftOf(), 0)).toBeNull();
  });
  it("delete removes the step, selects the neighbour, never removes the last step", () => {
    const draft = three();
    expect(deleteStep(draft, 1)).toBe(1);
    expect(draft.steps.map(item => item.text)).toEqual(["One", "Three"]);
    expect(deleteStep(draft, 1)).toBe(0);
    expect(draft.steps.map(item => item.text)).toEqual(["One"]);
    expect(deleteStep(draft, 0)).toBeNull();
    expect(draft.steps).toHaveLength(1);
    expect(deleteStep(three(), 7)).toBeNull();
  });
  it("move swaps with the neighbour and refuses at either end", () => {
    const draft = three();
    expect(moveStep(draft, 1, -1)).toBe(0);
    expect(draft.steps.map(item => item.text)).toEqual(["Two", "One", "Three"]);
    expect(moveStep(draft, 0, -1)).toBeNull();
    expect(moveStep(draft, 2, 1)).toBeNull();
    expect(moveStep(draft, 0, 1)).toBe(1);
    expect(draft.steps.map(item => item.text)).toEqual(["One", "Two", "Three"]);
    expect(moveStep(draftOf(), 0, 1)).toBeNull();
  });
  it("whatever the operation, the compiled order is the list order", () => {
    const draft = three();
    duplicateStep(draft, 1); deleteStep(draft, 0); moveStep(draft, 2, -1);
    const definition = draftToDefinition(draft, registry);
    const ids = new Set(definition.steps.map(item => item.id));
    for (const item of definition.steps) if (item.kind !== "complete") { expect(ids.has(item.next)).toBe(true); expect(item.recover).toBeUndefined(); }
    expect(definition.steps.filter(item => item.kind === "guide").map(item => (item.kind === "guide" ? item.text : ""))).toEqual(draft.steps.map(item => item.text));
  });
  it("keeps recovery destinations stable on duplicate and move, and disconnects both incoming links on removal", () => {
    const draft = three();
    draft.steps[0]!.recover = "n3";
    draft.steps[1]!.recover = "s3";
    expect(duplicateStep(draft, 0)).toBe(1);
    expect(moveStep(draft, 3, -1)).toBe(2);
    expect(hasRecoveryReference(draft, 2)).toBe(true);
    const definition = draftToDefinition(draft, registry);
    expect(definition.steps.find(item => item.id === "s4")).toMatchObject({ next: "n3", recover: "n3" });
    expect(definition.steps.find(item => item.id === "s2")).toMatchObject({ next: "done", recover: "s3" });
    expect(deleteStep(draft, 2)).toBe(2);
    expect(draftToDefinition(draft, registry).steps).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "s4", next: "s2" }),
    ]));
    expect(draft.steps.every(item => item.recover === undefined)).toBe(true);
  });

});

describe("step summary", () => {
  it("reads `2. Change display name — INPUT · profile.displayName ✓ check`", () => {
    const draft = draftOf(step("orders.submit", "click", "Open"), step("orders.note", "input", "Change display name", "route.orders"));
    expect(stepSummary(draft, 1)).toBe("2. Change display name — INPUT · orders.note ✓ check");
    expect(stepSummary(draft, 0)).toBe("1. Open — CLICK · orders.submit");
  });
  it("names a missing instruction, target and interaction, and shortens a long instruction", () => {
    expect(stepSummary(draftOf(emptyStep()), 0)).toBe("1. (no instruction) — ACK · no target");
    expect(stepSummary(draftOf(step("", "", "x")), 0)).toBe("1. x — NO INTERACTION · no target");
    expect(stepSummary(draftOf(step("a.b", "ack", "y".repeat(60))), 0)).toBe(`1. ${"y".repeat(39)}… — ACK · a.b`);
    expect(stepSummary(draftOf(), 3)).toBe("");
  });
});

describe("step validity matrix", () => {
  const ctx = (over: { health?: Map<string, "unverified" | "healthy" | "broken">; postconditions?: string[] } = {}) => ({ registry, postconditions: over.postconditions ?? ["route.orders", "route.profile"], ...(over.health ? { health: over.health } : {}) });
  const level = (s: ReturnType<typeof step>, over = {}) => stepValidity(draftOf(s), 0, ctx(over));
  it("valid: a known target, an allowed interaction, an instruction and a verification", () => {
    expect(level(step("orders.submit", "click", "Press it", "route.orders"))).toEqual({ level: "valid", invalid: [], warnings: [] });
    expect(validityText(level(step("orders.submit", "click", "Press it", "route.orders")))).toBe("✓ Valid");
  });
  it.each([
    ["no target", step("", "ack", "x"), "Select a target."], ["an unknown or disabled target", step("orders.gone", "ack", "x"), "The target is not available: it is disabled, removed or unknown."],
    ["no interaction", step("orders.submit", "", "x"), "Select an interaction."], ["an interaction the target does not allow", step("orders.submit", "input", "x"), "This interaction is not available for this target."],
    ["a blank instruction", step("orders.submit", "click", "   ", "route.orders"), "Enter an instruction in plain text."], ["markup in the instruction", step("orders.submit", "click", "<b>x</b>", "route.orders"), "Enter an instruction in plain text."],
    ["a verification the registry does not know", step("orders.submit", "click", "x", "check.v0000000000"), "The verification is not available: select another one."],
  ])("invalid: %s", (_label, s, reason) => {
    const result = level(s);
    expect(result.level).toBe("invalid");
    expect(result.invalid).toContain(reason);
    expect(validityText(result)).toMatch(/^✕ Invalid: /u);
  });
  it("a text target allows highlight only: acknowledging is fine, clicking is not", () => {
    expect(level(step("orders.status", "ack", "Look here")).level).toBe("valid");
    expect(level(step("orders.status", "click", "x")).invalid).toContain("This interaction is not available for this target.");
  });
  it("warning: no verification after a click or an input, nothing for a plain acknowledgement", () => {
    const result = level(step("orders.submit", "click", "Press it"));
    expect(result.level).toBe("warning");
    expect(result.warnings).toEqual(["No verification: Studio cannot confirm that this step worked."]);
    expect(validityText(result)).toBe("! Warning: No verification: Studio cannot confirm that this step worked.");
    expect(level(step("orders.submit", "ack", "Look")).level).toBe("valid");
  });
  it("warning from target health: broken and unverified; healthy and unknown are silent", () => {
    const s = step("orders.submit", "click", "x", "route.orders");
    expect(level(s, { health: new Map([["orders.submit", "broken"]]) }).warnings).toEqual(["The target is marked broken: re-record it in Targets."]);
    expect(level(s, { health: new Map([["orders.submit", "unverified"]]) }).warnings).toEqual(["The target has not been checked on its page yet."]);
    expect(level(s, { health: new Map([["orders.submit", "healthy"]]) }).level).toBe("valid");
    expect(level(s).level).toBe("valid");
  });
  it("an invalid step is reported invalid even when it also has warnings, and a missing step is invalid", () => {
    expect(level(step("orders.gone", "click", "x")).level).toBe("invalid");
    expect(stepValidity(draftOf(), 4, ctx()).level).toBe("invalid");
  });
  it("save state words", () => { expect(saveStateText).toEqual({ saved: "Saved", saving: "Saving…", unsaved: "Unsaved changes", failed: "Save failed" }); });
});

describe("verification vocabulary", () => {
  const check = (over: Partial<CheckView>): CheckView => ({ name: "check.v0000000001", kind: "element.text.equals", targetId: "orders.status", route: null, attribute: null, expected: "Saved", status: "active", references: { drafts: 0, published: 0 }, ...over });
  const roleOf = (id: string) => registry.get(id)?.role;
  it("value needs a text box, select or checkbox; text needs anything else", () => {
    expect(conditionSupport("value", "button").ok).toBe(false);
    expect(conditionSupport("value", "textbox").ok).toBe(true);
    expect(conditionSupport("value", "select").ok).toBe(true);
    expect(conditionSupport("value", "checkbox").ok).toBe(true);
    expect(conditionSupport("text", "textbox").ok).toBe(false);
    expect(conditionSupport("text", "text").ok).toBe(true);
    expect(conditionSupport("visible", "textbox").ok).toBe(true);
    expect(conditionSupport("value", undefined).ok).toBe(true);
    expect(conditionSupport("value", "button").reason).toContain("text boxes");
  });
  it("builds exactly the request of each condition, and says what is missing otherwise", () => {
    expect(checkInputOf({ condition: "visible", targetId: "orders.submit" }, roleOf)).toEqual({ input: { kind: "element.visible", targetId: "orders.submit" } });
    expect(checkInputOf({ condition: "hidden", targetId: "orders.submit" }, roleOf)).toEqual({ input: { kind: "element.hidden", targetId: "orders.submit" } });
    expect(checkInputOf({ condition: "text", targetId: "orders.status", expected: "  Saved " }, roleOf)).toEqual({ input: { kind: "element.text.equals", targetId: "orders.status", expected: "Saved" } });
    expect(checkInputOf({ condition: "value", targetId: "orders.note", expected: "Ada" }, roleOf)).toEqual({ input: { kind: "element.value.equals", targetId: "orders.note", expected: "Ada" } });
    expect(checkInputOf({ condition: "attribute", targetId: "orders.submit", attribute: "aria-expanded", expected: "true" }, roleOf)).toEqual({ input: { kind: "element.attribute.equals", targetId: "orders.submit", attribute: "aria-expanded", expected: "true" } });
    expect(checkInputOf({ condition: "route", route: "profile" }, roleOf)).toEqual({ input: { kind: "route.equals", route: "profile" } });
    for (const [fields, problem] of [
      [{ condition: "none" }, "Choose a condition."], [{ condition: "builtin" }, "Choose a condition."], [{ condition: "route" }, "Choose a route."], [{ condition: "visible" }, "Choose a target."],
      [{ condition: "value", targetId: "orders.submit", expected: "x" }, "Only text boxes, selects and checkboxes have a value."], [{ condition: "text", targetId: "orders.note", expected: "x" }, "A field has a value, not a text: use “Element value equals”."],
      [{ condition: "text", targetId: "orders.status", expected: "  " }, "Enter the expected value (1 to 120 characters)."], [{ condition: "text", targetId: "orders.status", expected: "x".repeat(121) }, "Enter the expected value (1 to 120 characters)."],
      [{ condition: "attribute", targetId: "orders.submit", attribute: "aria-expanded", expected: "x".repeat(41) }, "Enter the expected value (1 to 40 characters)."], [{ condition: "attribute", targetId: "orders.submit", attribute: "onclick", expected: "x" }, "Choose an attribute."],
      [{ condition: "text", targetId: "orders.status", expected: "a\u0000b" }, "Enter the expected value (1 to 120 characters)."],
    ] as const) expect(checkInputOf(fields as never, roleOf), JSON.stringify(fields)).toEqual({ problem });
    expect(checkInputOf({ condition: "text", targetId: "orders.status", expected: "x".repeat(120) }, roleOf)).toHaveProperty("input");
    expect(checkInputOf({ condition: "attribute", targetId: "orders.submit", attribute: "disabled", expected: "x".repeat(40) }, roleOf)).toHaveProperty("input");
  });
  it("describes every check in plain words and round-trips through the editor fields", () => {
    const label = (id: string) => registry.get(id)?.label ?? id;
    const cases: [CheckView, string][] = [
      [check({ kind: "route.equals", targetId: null, route: "profile", expected: null }), "The page is “profile”"], [check({ kind: "element.visible", expected: null }), "“orders.status” becomes visible"],
      [check({ kind: "element.hidden", expected: null }), "“orders.status” becomes hidden"], [check({}), "“orders.status” text equals “Saved”"], [check({ kind: "element.value.equals", targetId: "orders.note", expected: "Ada" }), "“orders.note” value equals “Ada”"],
      [check({ kind: "element.attribute.equals", targetId: "orders.submit", attribute: "aria-expanded", expected: "true" }), "“orders.submit” attribute aria-expanded equals “true”"],
    ];
    for (const [value, words] of cases) {
      expect(describeCheck(value, label)).toBe(words);
      const back = checkInputOf(fieldsOf(value), roleOf);
      expect(back).toHaveProperty("input");
      const { input } = back as { input: { kind: string } };
      expect(input.kind).toBe(value.kind);
    }
  });
});

describe("preview wording", () => {
  const definition = { id: "wt-000000000001", title: "T", description: "D", start: "n1", steps: [
    { id: "n1", kind: "navigate" as const, route: "orders", next: "s1" }, { id: "s1", kind: "guide" as const, target: "orders.submit", text: "x", wait: "click" as const, verify: "route.orders", next: "s2" },
    { id: "s2", kind: "guide" as const, target: "orders.note", text: "x", wait: "input" as const, next: "s3" }, { id: "s3", kind: "guide" as const, target: "orders.status", text: "x", wait: "ack" as const, next: "done" },
    { id: "done", kind: "complete" as const, text: "ok" }] };
  const label = (id: string) => `L:${id}`; const words = (name: string) => `W:${name}`;
  it("shows Step n of m from stepIndex + 1 and what the step waits for", () => {
    expect(progressOf({ status: "WAITING", stepIndex: 1, stepCount: 5 }, definition, label, words)).toEqual({ step: 2, count: 5, waitingFor: "Waiting for: click", target: "L:orders.submit", verification: "W:route.orders" });
    expect(progressOf({ status: "WAITING", stepIndex: 2, stepCount: 5 }, definition, label, words)).toMatchObject({ waitingFor: "Waiting for: input", verification: "None" });
    expect(progressOf({ status: "WAITING", stepIndex: 3, stepCount: 5 }, definition, label, words)).toMatchObject({ waitingFor: "Waiting for: your acknowledgement" });
    expect(progressOf({ status: "WAITING", stepIndex: 0, stepCount: 5 }, definition, label, words)).toEqual({ step: 1, count: 5, waitingFor: "Waiting for: navigation to orders", target: "—", verification: "—" });
    expect(progressOf({ status: "COMPLETED", stepIndex: 4, stepCount: 5 }, definition, label, words)).toMatchObject({ step: 5, waitingFor: "Finished" });
  });
  it("has no progress without a position, for a refusal or for an index outside the workflow", () => {
    expect(progressOf({ status: "WAITING" }, definition, label, words)).toBeNull();
    expect(progressOf({ status: "refused", reason: "invalid_bundle" }, definition, label, words)).toBeNull();
    expect(progressOf({ status: "WAITING", stepIndex: 9, stepCount: 10 }, definition, label, words)).toBeNull();
  });
  it.each([
    [{ code: "target_unavailable", targetId: "orders.submit" }, "Target not found: orders.submit", diagnosticSentences.target_unavailable, true],
    [{ code: "target_unavailable" }, "Target not found", diagnosticSentences.target_unavailable, false],
    [{ code: "route_mismatch", expectedRoute: "orders", currentRoute: "profile" }, "Wrong page: expected orders, currently profile", diagnosticSentences.route_mismatch, false],
    [{ code: "route_mismatch" }, "Wrong page: expected another page, currently unknown", diagnosticSentences.route_mismatch, false],
    [{ code: "verification_failed", check: "check.v0000000001" }, "Verification failed: W:check.v0000000001", diagnosticSentences.verification_failed, false],
    [{ code: "verification_failed" }, "Verification failed", diagnosticSentences.verification_failed, false],
    [{ code: "timeout" }, "Timed out", diagnosticSentences.timeout, false], [{ code: "cancelled" }, "Preview stopped", diagnosticSentences.cancelled, false], [{ code: "invalid" }, "Preview could not run", diagnosticSentences.invalid, false],
  ] as const)("%j -> a fixed sentence%s", (failure, title, detail, rerecord) => {
    const found = diagnose(failure as never, words);
    expect(found.title).toBe(title);
    expect(found.detail).toBe(detail);
    expect(found.action !== undefined).toBe(rerecord);
    if (found.action) expect(found.action).toEqual({ kind: "rerecord", targetId: "orders.submit", label: "Re-record target" });
    expect(JSON.stringify(found)).not.toMatch(/stack|Error|at \w+\(/u);
  });
});
