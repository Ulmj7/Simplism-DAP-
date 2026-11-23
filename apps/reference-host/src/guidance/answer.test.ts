/** Slice 2 demo, Scenario B, with the real shipped knowledge, the real loader and retriever, and the real answer path (an inline stand-in for the model). */
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { createGuidanceService, createRetriever, renderGuidancePrompt } from "@dap/ai";
import type { GuidanceModel, GuidanceModelRequest } from "@dap/ai";
import { scrubText } from "@dap/security";
import { loadKnowledge } from "./knowledge-loader.js";

const knowledge = loadKnowledge({ dir: fileURLToPath(new URL("../../knowledge", import.meta.url)), scrub: scrubText });
const retriever = createRetriever(knowledge.chunks);
const context = { route: "settings", elements: [{ id: "settings.twoFactorSetup", role: "button", label: "Two-factor setup", description: "Starts two-factor authentication setup", privacy: "public", available: false }] };
const timers = { set: () => () => undefined };
const sanitizeQuery = (raw: unknown): string | null => (typeof raw === "string" ? raw : null);
/** Scenario B uses the real knowledge and retriever with no walkthrough catalog: only the answer path is in play (the walkthrough path is tested in guidance-scenarios.test.ts). */
const answerQuestion = (args: { model: GuidanceModel; timers: { set: () => () => void }; retriever: typeof retriever; query: string; semanticContext: unknown }) =>
  createGuidanceService({ model: args.model, catalog: { list: () => [] }, retriever: args.retriever, timers: args.timers, sanitizeQuery }).askGuidance({ query: args.query, semanticContext: args.semanticContext });
const recording = (behaviour: (request: GuidanceModelRequest) => unknown) => {
  const requests: GuidanceModelRequest[] = [];
  const model: GuidanceModel = { generate: (request) => { requests.push(request); return Promise.resolve(behaviour(request)); } };
  return { model, requests };
};

describe("Scenario B: What is two-factor authentication?", () => {
  it("retrieves the two-factor article, asks the model once, and returns a grounded answer with sources from the supplied chunks, starting nothing", async () => {
    const m = recording((request) => ({ kind: "answer", answer: "It adds a second step when you sign in, so a stolen password alone is not enough.", sources: [request.input.sources[0]!.id] }));
    const result = await answerQuestion({ model: m.model, timers, retriever, query: "What is two-factor authentication?", semanticContext: context });
    expect(result).toEqual({ kind: "answer", answer: "It adds a second step when you sign in, so a stolen password alone is not enough.", sources: [{ id: "two-factor-authentication", title: "Two-factor authentication" }] });
    expect(m.requests).toHaveLength(1);
    expect(m.requests[0]!.input.sources[0]!.id).toBe("two-factor-authentication.1");
    expect(m.requests[0]!.input.walkthroughSummaries).toEqual([]); // nothing to start in this slice
    expect(result.kind).not.toBe("walkthrough");
  });
  it("the rendered prompt shows the retrieved article only as SOURCES data", async () => {
    const m = recording(() => ({ kind: "clarify", message: "x" }));
    await answerQuestion({ model: m.model, timers, retriever, query: "What is two-factor authentication?", semanticContext: context });
    const rendered = renderGuidancePrompt(m.requests[0]!);
    expect(rendered.ok).toBe(true);
    if (!rendered.ok) return;
    expect(rendered.prompt.user).toMatch(/SOURCES\nBEGIN (DATA-FENCE-\d+)\nsource: two-factor-authentication\.1 \| Two-factor authentication \| /);
    expect(rendered.prompt.system).not.toContain("second proof of identity");
  });
  it("a question the articles do not cover makes no model call and is ungrounded", async () => {
    const m = recording(() => ({ kind: "answer", answer: "Sunny.", sources: ["two-factor-authentication.1"] }));
    for (const query of ["What is the weather in Paris?", "How do I delete my account?"]) {
      expect(await answerQuestion({ model: m.model, timers, retriever, query, semanticContext: context })).toMatchObject({ kind: "unsupported", reason: "ungrounded" });
    }
    expect(m.requests).toHaveLength(0);
  });
  it("every shipped question gets only chunks from the approved articles", async () => {
    const m = recording(() => ({ kind: "clarify", message: "x" }));
    for (const query of ["How do I change my name?", "Can the assistant see my password?", "Where is the security panel?"]) await answerQuestion({ model: m.model, timers, retriever, query, semanticContext: context });
    const ids = new Set(knowledge.chunks.map((c) => c.id));
    for (const request of m.requests) for (const source of request.input.sources) expect(ids.has(source.id)).toBe(true);
    expect(m.requests).toHaveLength(3);
  });
});
