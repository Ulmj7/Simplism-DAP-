import { describe, expect, it } from "vitest";
import { callGuidanceModel, parseGuidanceModelRequest } from "@dap/ai";
import type { GuidanceModelRequest } from "@dap/ai";
import { createFakeGuidanceModel, fakeHangs, fakeRejects, fakeReturns, fakeThrows } from "./fake-guidance-model.js";

const request = (): GuidanceModelRequest => ({
  input: {
    query: "How do I change my name?",
    semanticContext: { route: "profile", elements: [{ id: "profile.nameInput", role: "textbox", label: "Name", description: "Your display name", privacy: "public", available: true }] },
    walkthroughSummaries: [{ id: "profileUpdate", title: "Update your profile", description: "Change your name and save" }],
    sources: [],
  },
  maxOutputChars: 1200,
});
const timers = { set: () => () => undefined };

describe("the fake guidance model", () => {
  it("answers with what it is told, counts calls, and records each request as a deeply frozen copy", async () => {
    const model = createFakeGuidanceModel(fakeReturns({ kind: "clarify", message: "Which page?" }));
    const original = request();
    expect(await model.generate(original)).toEqual({ kind: "clarify", message: "Which page?" });
    await model.generate(original);
    expect(model.calls).toBe(2);
    expect(model.requests).toHaveLength(2);
    expect(model.requests[0]).toEqual(original);
    expect(model.requests[0]).not.toBe(original);
    expect(Object.isFrozen(model.requests[0])).toBe(true);
    expect(Object.isFrozen(model.requests[0]!.input.semanticContext.elements[0])).toBe(true);
    expect(original.input.query).toBe("How do I change my name?");
  });
  it("the behaviour sees the request and the zero-based call index", async () => {
    const seen: number[] = [];
    const model = createFakeGuidanceModel((_request, index) => { seen.push(index); return index; });
    await model.generate(request());
    await model.generate(request());
    expect(seen).toEqual([0, 1]);
  });
  it("can reject (with any value), throw synchronously, and never settle", async () => {
    await expect(createFakeGuidanceModel(fakeRejects("a string")).generate(request())).rejects.toBe("a string");
    await expect(createFakeGuidanceModel(fakeRejects(new Error("boom"))).generate(request())).rejects.toThrow("boom");
    const thrower = createFakeGuidanceModel(fakeThrows(new Error("sync")));
    expect(() => thrower.generate(request())).toThrow("sync");
    expect(thrower.calls).toBe(1); // the call is counted even though it threw
    let settled = false;
    void createFakeGuidanceModel(fakeHangs()).generate(request()).then(() => { settled = true; }, () => { settled = true; });
    await new Promise((r) => setTimeout(r, 5));
    expect(settled).toBe(false);
  });
  it("it records only requests that are safe structured requests: whatever the guard let through parses again", async () => {
    const model = createFakeGuidanceModel(fakeReturns({ kind: "start_walkthrough", walkthroughId: "profileUpdate" }));
    const outcome = await callGuidanceModel({ model, request: request(), timers });
    expect(outcome).toEqual({ ok: true, decision: { kind: "start_walkthrough", walkthroughId: "profileUpdate" } });
    for (const recorded of model.requests) expect(parseGuidanceModelRequest(recorded).ok).toBe(true);
    // a request carrying authority is refused before the fake ever sees it
    const refused = await callGuidanceModel({ model, request: { ...request(), authorizationContext: { userId: "u" } }, timers });
    expect(refused).toEqual({ ok: false, reason: "context_invalid" });
    expect(model.calls).toBe(1);
  });
  it("Slice 1 demo: the fake model gives a valid decision, or a safe failure", async () => {
    const good = await callGuidanceModel({ model: createFakeGuidanceModel(fakeReturns({ kind: "start_walkthrough", walkthroughId: "profileUpdate" })), request: request(), timers });
    expect(good).toMatchObject({ ok: true });
    const bad = await callGuidanceModel({ model: createFakeGuidanceModel(fakeReturns({ kind: "execute", action: "deleteEverything" })), request: request(), timers });
    expect(bad).toEqual({ ok: false, reason: "invalid_model_output" });
    const down = await callGuidanceModel({ model: createFakeGuidanceModel(fakeRejects(new Error("sk-SECRET"))), request: request(), timers });
    expect(down).toEqual({ ok: false, reason: "model_unavailable" });
    expect(JSON.stringify(down)).not.toContain("SECRET");
  });
});
