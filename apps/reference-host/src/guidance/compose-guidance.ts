import { fileURLToPath } from "node:url";
import { createGuidanceService, createRetriever } from "@dap/ai";
import type { GuidanceModel, GuidanceTimers } from "@dap/ai";
import { scrubText } from "@dap/security";
import type { Environment } from "../config.js";
import type { AiSession } from "../compose.js";
import type { GuidanceFetch } from "./anthropic-model.js";
import { createAnthropicGuidanceModel, GuidanceConfigError, hostTimers } from "./anthropic-model.js";
import { createGuidanceExtension } from "./capability.js";
import type { WalkthroughStarter } from "./capability.js";
import { demoModel } from "./demo-model.js";
import { loadKnowledge } from "./knowledge-loader.js";
import { demoCatalogView } from "./walkthrough-summaries.js";
import { submitWalkthroughStart } from "./start-bridge.js";
export function createGuidanceHost({ env, starter, knowledgeDir = fileURLToPath(new URL("../../knowledge/", import.meta.url)), fetchImpl, timers = hostTimers }: {
  env: Environment; starter: WalkthroughStarter; knowledgeDir?: string; fetchImpl?: GuidanceFetch; timers?: GuidanceTimers;
}) {
  let model: GuidanceModel;
  const choice = env.DAP_GUIDANCE_MODEL ?? "fake";
  if (choice === "fake") model = demoModel;
  else if (choice === "anthropic") model = createAnthropicGuidanceModel({ apiKey: env.ANTHROPIC_API_KEY, ...(env.DAP_GUIDANCE_MODEL_ID === undefined ? {} : { modelId: env.DAP_GUIDANCE_MODEL_ID }), ...(fetchImpl === undefined ? {} : { fetchImpl }), timers });
  else throw new GuidanceConfigError("DAP_GUIDANCE_MODEL must be fake or anthropic");
  const knowledge = loadKnowledge({ dir: knowledgeDir, scrub: scrubText });
  const service = createGuidanceService({ model, catalog: demoCatalogView, retriever: createRetriever(knowledge.chunks), timers, sanitizeQuery: raw => typeof raw === "string" && raw.trim() ? scrubText(raw) : null });
  const { extension, trusted } = createGuidanceExtension({ catalog: demoCatalogView, starter });
  return { extension, trusted,
    /** The proposal step alone (C01's browser transport): validates and decides, but submits nothing to the Gateway and starts nothing. */
    askGuidance: (input: { query: unknown; semanticContext: unknown }) => service.askGuidance(input),
    async askAndStart(session: AiSession, input: { query: unknown; semanticContext: unknown }) {
    const result = await service.askGuidance(input);
    return result.kind === "walkthrough" ? submitWalkthroughStart(session, result.walkthroughId) : result;
  } };
}
