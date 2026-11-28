export type ElementRef = `@e${number}`;

export interface ApprovedLabel {
  readonly role: string;
  readonly name: string;
}

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

export interface UiTarget {
  readonly page: string;
  readonly section: readonly string[];
  readonly role: string;
  readonly name: string;
  readonly marker: string | null;
}

export interface UiSnapshot {
  readonly page: string;
  readonly targets: readonly UiTarget[];
  readonly truncated: boolean;
}

export interface DomView {
  revision: number;
  width: number;
  height: number;
  x: number;
  y: number;
}

export interface BrowserBounds { x: number; y: number; width: number; height: number }

export interface DomNode {
  id: number;
  parentId: number | null;
  kind: "element" | "text" | "shadow-root";
  tag?: string;
  role?: string;
  visible?: boolean;
  text?: string;
  aria?: Readonly<Record<string, string>>;
  unavailable?: "private" | "frame";
  selector?: string;
  name?: string;
  targetDigest?: string;
  ambiguous?: boolean;
  bounds?: BrowserBounds;
}

export interface DomPage {
  readonly url: string;
  readonly nodes: readonly DomNode[];
  readonly view?: DomView;
  readonly nextCursor: string | null;
  readonly truncated: boolean;
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
 * Facts about one live element that the privacy model needs. Values entered by users are never read here.
 */
export interface ElementFacts {
  readonly tagName: string | null;
  /** The `type` attribute, trimmed and lower-case (at most 40 characters), or null when absent or empty. */
  readonly inputType: string | null;
  /** The `autocomplete` attribute, trimmed and lower-case (at most 200 characters), or null when absent or empty. */
  readonly autocomplete: string | null;
  /** The element or an ancestor carries the attribute. */
  readonly dataAiPrivate: boolean;
  readonly dataAiIgnore: boolean;
  readonly dataAiRedact: boolean;
}

export interface BrowserEvent {
  id: number;
  at: number;
  channel: "activity" | "console" | "network";
  source: "Studio" | "Agent" | "Хэрэглэгч" | "Browser";
  action: string;
  detail?: string | undefined;
  target?: string | undefined;
  outcome?: "running" | "success" | "failed";
  durationMs?: number;
  status?: number | undefined;
  related?: number | undefined;
}

export interface BrowserObservation {
  track(action: string, target?: string, source?: BrowserEvent["source"]): (ok: boolean) => void;
  highlight(bounds: BrowserBounds, view: Omit<DomView, "revision">, revision: number): void;
  summary(after: number): { highlight?: { bounds: BrowserBounds; view: DomView } | undefined; url?: string | undefined; revision: number; events: BrowserEvent[]; lastEvent: number };
  dom(cursor?: string): Promise<DomPage>;
  viewport(): Promise<{ image: Buffer; view: string }>;
  storage(): Promise<{ cookies: string[]; localStorage: string[]; sessionStorage: string[] }>;
}

export interface BrowserRuntime {
  start(options: BrowserSessionOptions): Promise<void>;
  snapshot(): Promise<BrowserSnapshot>;
  inspectUi?(): Promise<UiSnapshot>;
  inspectDom?(cursor?: string): Promise<DomPage>;
  observation?(): BrowserObservation;
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
