/**
 * @dap/ai: index.ts
 *
 * T069. Public surface of the AI layer.
 *
 * Deliberately MINIMAL: only the planner-facing seam. The AI layer holds a
 * `ProposalSubmitter` (from @dap/contracts) and a `PlannerPort` (this package).
 * It must NOT re-export the registry's executors, the ActionRegistry,
 * AuthorizationContext, state stores, or the confirmation service — the model
 * is an untrusted proposer and never touches those (Constitution I, II, III).
 *
 * @dap/ai depends on @dap/contracts only.
 */
export type { PlannerPort, RawToolCall } from "./planner-port.js";
export { toProposalCall } from "./tool-call.js";

// Feature 003 guidance contract (Slice 1): a structured request to the GuidanceModel port, untrusted output, strict validation, closed results.
// Nothing here can carry authority: no context, token, executor, Gateway internals or walkthrough definition.
export * from "./guidance/limits.js";
export { WALKTHROUGH_ID } from "./guidance/text.js";
export { GUIDANCE_REASONS } from "./guidance/types.js";
export type {
  Cancel, GuidanceDecision, GuidanceInput, GuidanceModel, GuidanceModelRequest, GuidanceReason, GuidanceResult, GuidanceSource, GuidanceTimers,
  SafeWalkthroughSummary, SanitizeQuery, SemanticContextElementInput, SemanticContextInput, SemanticPrivacy, SemanticRole, WalkthroughCatalogView,
} from "./guidance/types.js";
export { parseGuidanceModelRequest } from "./guidance/request.js";
export type { RequestParse } from "./guidance/request.js";
export { parseGuidanceDecision } from "./guidance/decision.js";
export { callGuidanceModel, createModelCallGuard } from "./guidance/call-model.js";
export type { ModelCallFailure, ModelCallGuard, ModelCallOutcome } from "./guidance/call-model.js";
export { unsupportedResult } from "./guidance/result.js";

// Feature 003 Slice 2: approved product knowledge (pure; files are read by the trusted host loader) and its deterministic retriever.
export { MAX_KNOWLEDGE_DOCS, MAX_DOC_CHARS, MAX_DOC_TAGS, MAX_TOPIC_CHARS, MAX_PROMPT_CHARS } from "./guidance/limits.js";
export { chunkDocument, chunkKnowledge, parseKnowledgeDoc, parseKnowledgeSet } from "./guidance/knowledge/document.js";
export type { DocParse, KnowledgeChunk, KnowledgeDoc, SetParse } from "./guidance/knowledge/document.js";
export { MIN_RELEVANCE, createRetriever } from "./guidance/knowledge/retriever.js";
export type { RetrievedChunk, Retriever } from "./guidance/knowledge/retriever.js";
export { fitRequestToBudget, renderGuidancePrompt, GUIDANCE_SYSTEM_PROMPT } from "./guidance/prompt.js";
export type { FittedRequest, RenderedPrompt } from "./guidance/prompt.js";
export { groundDecision } from "./guidance/answer.js";
export type { AnswerChunk } from "./guidance/answer.js";

// Feature 003 Slice 3: the public parser for the semantic context that arrives from the browser (strict mirror of Feature 002's context() shape).
export { parseSemanticContextInput } from "./guidance/context-input.js";
export { MIN_SELECTION_SCORE, SELECTION_MARGIN, SELECTION_TOP_N, judgeProposal, parseCatalogSummaries, rankSummaries, validateProposedWalkthrough } from "./guidance/selection.js";
export type { RankedSummary, SelectionVerdict } from "./guidance/selection.js";
export { createGuidanceService } from "./guidance/service.js";
export type { GuidanceService, GuidanceServiceDeps } from "./guidance/service.js";
