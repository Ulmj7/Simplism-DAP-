/** The shipped help articles through the real loader and retriever: this is where the relevance threshold is tuned and pinned. */
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { MIN_RELEVANCE, createRetriever } from "@dap/ai";
import { scrubText } from "@dap/security";
import { loadKnowledge } from "./knowledge-loader.js";

const loaded = loadKnowledge({ dir: fileURLToPath(new URL("../../knowledge", import.meta.url)), scrub: scrubText });
const retriever = createRetriever(loaded.chunks);

describe("questions the shipped articles answer rank the right article first, above the threshold with room to spare", () => {
  it.each([
    ["What is two-factor authentication?", "two-factor-authentication.1"],
    ["How do I change my name?", "profile-name-update.1"],
    ["Where is the security panel?", "security-panel.1"],
    ["How do I open the advanced settings?", "advanced-settings.1"],
    ["Can the assistant see my password?", "private-fields.1"],
    ["What can the help assistant do?", "help-assistant.1"],
  ])("%s", (question, first) => {
    const found = retriever.search(question);
    expect(found[0]?.id).toBe(first);
    expect(found[0]!.score).toBeGreaterThanOrEqual(MIN_RELEVANCE * 1.25);
    expect(found.length).toBeLessThanOrEqual(4);
  });
});

describe("questions the articles do not answer find nothing", () => {
  it.each([
    "What is the weather in Paris?", "What is the capital of France?", "How do I delete my account?", "How do I change the weather settings?", "How do I pay my invoice?",
    "tell me a joke", "hello", "settings", "What is the meaning of life?", "How do I reset my password?", "",
  ])("%s -> []", (question) => {
    expect(retriever.search(question)).toEqual([]);
  });
});
