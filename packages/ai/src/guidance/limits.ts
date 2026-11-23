/**
 * Feature 003 limits. Every input to and output from the model is bounded by these numbers; the label and description bounds are Feature 002's.
 * Plain numbers in a frozen object: nothing here can be changed at run time.
 */
export const MAX_QUERY_CHARS = 500;
export const MAX_CONTEXT_ELEMENTS = 60;
export const MAX_SUMMARIES = 20;
export const MAX_SOURCES = 4;
export const MAX_SOURCE_CHARS = 800;
export const MAX_ANSWER_CHARS = 1200;
export const MAX_MESSAGE_CHARS = 300;
export const MAX_MODEL_CALLS = 1;
export const MODEL_DEADLINE_MS = 8000;
export const MAX_LABEL_CHARS = 80;
export const MAX_DESCRIPTION_CHARS = 240;
/** Bounds this package adds for ids, titles and the route (Feature 002 has patterns but no length for these). */
export const MAX_ID_CHARS = 128;
export const MAX_TITLE_CHARS = 80;
export const MAX_ROUTE_CHARS = 64;

export const GUIDANCE_LIMITS = Object.freeze({
  queryChars: MAX_QUERY_CHARS, contextElements: MAX_CONTEXT_ELEMENTS, summaries: MAX_SUMMARIES, sources: MAX_SOURCES, sourceChars: MAX_SOURCE_CHARS,
  answerChars: MAX_ANSWER_CHARS, messageChars: MAX_MESSAGE_CHARS, modelCalls: MAX_MODEL_CALLS, modelDeadlineMs: MODEL_DEADLINE_MS,
  labelChars: MAX_LABEL_CHARS, descriptionChars: MAX_DESCRIPTION_CHARS,
});

// --- knowledge retrieval (Slice 2) ---
export const MAX_KNOWLEDGE_DOCS = 200;
export const MAX_DOC_CHARS = 20_000;
export const MAX_DOC_TAGS = 8;
export const MAX_TOPIC_CHARS = 64;
/** The most characters of prompt text (system plus user) that go to a model. */
export const MAX_PROMPT_CHARS = 16_000;
