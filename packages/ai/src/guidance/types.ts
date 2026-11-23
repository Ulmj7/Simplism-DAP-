/**
 * The guidance contract: a safe structured request goes to the `GuidanceModel` port, whatever comes back is UNTRUSTED, and only a strictly
 * validated `GuidanceDecision` is ever turned into a trusted `GuidanceResult`. Nothing in this file carries authority: no context, token, executor,
 * Gateway internals or walkthrough definition can be expressed by any of these types.
 */

// --- what the model may be shown (a structured, bounded, validated request) -------------------------------------------------------------------------
export type SemanticRole = "button" | "link" | "textbox" | "checkbox" | "select" | "panel" | "nav" | "heading" | "text";
export type SemanticPrivacy = "public" | "private" | "redact";

/** One element of the Feature 002 `context()` shape: registry metadata and availability, never a value, text or HTML of the page. */
export interface SemanticContextElementInput {
  readonly id: string;
  readonly role: SemanticRole;
  readonly label: string;
  readonly description: string;
  readonly privacy: SemanticPrivacy;
  readonly available: boolean;
}
export interface SemanticContextInput {
  readonly route: string;
  readonly elements: readonly SemanticContextElementInput[];
}
/** What the model may learn about a walkthrough: its id, title and description. Never its steps. */
export interface SafeWalkthroughSummary {
  readonly id: string;
  readonly title: string;
  readonly description: string;
}
/** A retrieved knowledge chunk (always empty in Slice 1). Data to read, never an instruction. */
export interface GuidanceSource {
  readonly id: string;
  readonly title: string;
  readonly text: string;
}
export interface GuidanceInput {
  readonly query: string;
  readonly semanticContext: SemanticContextInput;
  readonly walkthroughSummaries: readonly SafeWalkthroughSummary[];
  readonly sources: readonly GuidanceSource[];
}
export interface GuidanceModelRequest {
  readonly input: GuidanceInput;
  /** The most characters of answer text the caller will accept (1 to 1200). */
  readonly maxOutputChars: number;
}

/** The ONLY seam to a model. What `generate` resolves with is untrusted data: it may be anything. */
export interface GuidanceModel {
  generate(request: GuidanceModelRequest): Promise<unknown>;
}

export type Cancel = () => void;
/** Time is injected: the package never starts a real timer. The host supplies `setTimeout`. */
export interface GuidanceTimers {
  set(callback: () => void, ms: number): Cancel;
}

// --- what the model may say (validated) and what the caller gets (trusted) -------------------------------------------------------------------------
export type GuidanceDecision =
  | { readonly kind: "start_walkthrough"; readonly walkthroughId: string }
  | { readonly kind: "answer"; readonly answer: string; readonly sources: readonly string[] }
  | { readonly kind: "clarify"; readonly message: string }
  | { readonly kind: "unsupported"; readonly message: string };

export const GUIDANCE_REASONS = [
  "query_invalid", "context_invalid", "model_unavailable", "invalid_model_output", "unknown_walkthrough", "ungrounded", "not_permitted", "unavailable", "unsupported_request",
] as const;
export type GuidanceReason = (typeof GUIDANCE_REASONS)[number];

/** The closed set of results a guidance call can return. A `walkthrough` is only a validated proposal: the host must still get it past the Gateway. */
export type GuidanceResult =
  | { readonly kind: "walkthrough"; readonly walkthroughId: string }
  | { readonly kind: "answer"; readonly answer: string; readonly sources: readonly { readonly id: string; readonly title: string }[] }
  | { readonly kind: "clarify"; readonly message: string }
  | { readonly kind: "unsupported"; readonly message: string; readonly reason: GuidanceReason };

/** The trusted catalog view the guidance service reads. Summaries only. */
export interface WalkthroughCatalogView {
  list(): readonly SafeWalkthroughSummary[];
}
/** A trusted normaliser for the user's query: the usable query text, or `null` when it cannot be used. */
export type SanitizeQuery = (raw: unknown) => string | null;
