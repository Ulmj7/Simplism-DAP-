export type ElementRef = `@e${number}`;

export interface BrowserElement {
  readonly ref: ElementRef;
  readonly role: string;
  readonly name: string;
}

export interface BrowserSnapshot {
  readonly url: string;
  readonly elements: readonly BrowserElement[];
  readonly observation?: string;
}

export interface BrowserSessionOptions {
  readonly url: string;
  readonly headed?: boolean;
}

export interface WaitForChangeOptions {
  readonly timeoutMs?: number;
}

export type BrowserChange =
  | { readonly status: "changed"; readonly snapshot: BrowserSnapshot }
  | { readonly status: "timeout" };

/**
 * Facts about one live element that the privacy model needs (the same inputs as the walkthrough package's `ElementFacts`, minus what only the page can answer). Plain data, never a value:
 * the ancestors' `data-ai-ignore` cannot be read from outside the page, so `dataAiIgnore` covers the element itself only (the runtime's own privacy model still enforces the ancestors).
 */
export interface ElementFacts {
  /** Always null with the pinned CLI: no command reads the tag name. A `textbox` or `searchbox` with an `inputType` is an input. */
  readonly tagName: string | null;
  /** The `type` attribute, trimmed and lower-case (at most 40 characters), or null when absent or empty. */
  readonly inputType: string | null;
  /** The `autocomplete` attribute, trimmed and lower-case (at most 200 characters), or null when absent or empty. */
  readonly autocomplete: string | null;
  /** The element carries the attribute (any value, including none). */
  readonly dataAiPrivate: boolean;
  readonly dataAiIgnore: boolean;
  readonly dataAiRedact: boolean;
}

export interface BrowserRuntime {
  start(options: BrowserSessionOptions): Promise<void>;
  snapshot(): Promise<BrowserSnapshot>;
  inspectSemanticId(ref: ElementRef, from: BrowserSnapshot): Promise<string | null>;
  /**
   * One fresh observation, then one `data-ai-id` read per candidate of `from` (at most 64, in
   * snapshot order). A candidate that cannot be read maps to null; drift of the page since `from`
   * rejects the whole call with REF_NOT_FOUND. Candidates past the bound are absent from the map.
   */
  inspectSemanticIds(from: BrowserSnapshot): Promise<ReadonlyMap<ElementRef, string | null>>;
  /**
   * One fresh observation, then constant attribute reads per ref (at most 64 refs, each one of `from`'s elements; anything else, or more than 64, is REF_NOT_FOUND before any
   * command). Drift of the page since `from` rejects the whole call with REF_NOT_FOUND; an element that cannot be read, or whose `type` or `autocomplete` is longer than the bound
   * (it cannot be represented, so it is not trusted), maps to null. The URL is re-checked after every read like `inspectSemanticIds`.
   */
  inspectElementFacts(refs: readonly ElementRef[], from: BrowserSnapshot): Promise<ReadonlyMap<ElementRef, ElementFacts | null>>;
  highlight(ref: ElementRef, from: BrowserSnapshot): Promise<void>;
  clearHighlight(): Promise<void>;
  getUrl(): Promise<string>;
  waitForChange(options?: WaitForChangeOptions): Promise<BrowserChange>;
  close(): Promise<void>;
}
