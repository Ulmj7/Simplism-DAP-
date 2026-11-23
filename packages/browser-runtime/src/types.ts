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
  highlight(ref: ElementRef, from: BrowserSnapshot): Promise<void>;
  clearHighlight(): Promise<void>;
  getUrl(): Promise<string>;
  waitForChange(options?: WaitForChangeOptions): Promise<BrowserChange>;
  close(): Promise<void>;
}
