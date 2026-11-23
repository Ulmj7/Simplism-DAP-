/** The semantic registry's data types (plan 4.1). The app owns the mapping from these ids to real elements (`data-ai-id`). */
export const ROLES = ["button", "link", "textbox", "checkbox", "select", "panel", "nav", "heading", "text"] as const;
export type SemanticRole = (typeof ROLES)[number];
export const OPERATIONS = ["highlight", "click", "input", "focus"] as const;
export type SemanticOperation = (typeof OPERATIONS)[number];
export const PRIVACY_LEVELS = ["public", "private", "redact"] as const;
export type SemanticPrivacy = (typeof PRIVACY_LEVELS)[number];

export interface SemanticElementDef {
  /** `^[a-z][A-Za-z0-9]*(\.[A-Za-z0-9]+)+$`, e.g. `profile.nameInput`. */
  readonly id: string;
  readonly route: string;
  readonly role: SemanticRole;
  /** Plain text, at most 80 characters, none of `< > & " ' \``. */
  readonly label: string;
  /** Plain text, at most 240 characters, same character rule. */
  readonly description: string;
  /** Non-empty subset of `highlight | click | input | focus`. */
  readonly operations: readonly SemanticOperation[];
  readonly privacy: SemanticPrivacy;
}

export interface SemanticRegistry {
  /** `undefined` for anything that is not a registered id. Never throws. */
  get(id: unknown): SemanticElementDef | undefined;
  has(id: unknown): boolean;
  list(): readonly SemanticElementDef[];
  forRoute(route: unknown): readonly SemanticElementDef[];
  readonly routes: readonly string[];
}

export interface SemanticRegistryInput {
  readonly routes: readonly string[];
  readonly elements: readonly SemanticElementDef[];
}
