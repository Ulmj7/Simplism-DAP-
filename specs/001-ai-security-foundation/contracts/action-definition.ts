/**
 * @dap/contracts: action-definition.ts
 *
 * ActionDefinition, ActionRegistry, RiskLevel usage. Definitions are developer-authored,
 * strictly typed, and immutable at runtime. The model can never add or change one.
 *
 * Types only. The runtime pieces (buildRegistry, RegistrationError, the reserved name lists,
 * and the defineAction identity helper) belong to @dap/security (T041-T044) or the
 * contracts execution runtime, not this module.
 *
 * Spec: FR-001..FR-010, FR-018, FR-029 | Constitution: IV, VII, VIII, XVI
 */
import type { ZodType } from "zod";
import type {
  ActionId,
  DeepReadonly,
  ExecutorId,
  PageId,
  PermissionId,
  ResolvedResource,
  ResourceRef,
  RiskLevel,
  Sha256Hex,
} from "./core";

/** One audited parameter. Parameters NOT listed here are never written to the audit trail. */
export interface AuditParamRule {
  /** JSON-pointer style path into the validated, normalized parameters, e.g. "/projectId". */
  readonly path: string;
  readonly mode: "plain" | "masked";
}

export type ConfirmationPolicy =
  | { readonly kind: "required" }
  /** `justification` is mandatory when risk is MEDIUM (registration rule R5). */
  | { readonly kind: "not-required"; readonly justification?: string };

/** What the user sees before confirming. Built only from trusted data (FR-029). */
export interface ConsequenceSummary {
  readonly title: string;
  readonly effects: readonly string[];
  readonly irreversible: boolean;
}

export interface ConsequenceInput<TParams> {
  readonly params: DeepReadonly<TParams>;
  /** Resolved by the host's ResourceAuthorizer; display name is trusted. */
  readonly resource: ResolvedResource | null;
}

export interface ActionDefinition<TParams = unknown> {
  /** Unique. Must match ^[a-z][A-Za-z0-9]{2,63}$ and must not be a reserved-forbidden name. */
  readonly id: ActionId;
  /** Integer >= 1. Bump on ANY change; a snapshot test fails CI otherwise. */
  readonly version: number;
  readonly description: string;

  /**
   * Strict runtime schema. Registration (R3) requires, after conversion to JSON Schema
   * with { io: "input", unrepresentable: "throw" }: every object closed
   * (additionalProperties: false), every string and array bounded, and no reserved
   * parameter names at any depth. Plain z.object() is REJECTED because it strips instead
   * of rejecting unknown keys (research D2).
   */
  readonly inputSchema: ZodType<TParams>;

  readonly risk: RiskLevel;
  readonly requiredPermission: PermissionId;
  /** Narrowing signal only; never a grant (spec Assumptions). */
  readonly allowedPages: readonly PageId[] | "any";
  readonly confirmation: ConfirmationPolicy;
  readonly changesState: boolean;
  readonly audit: { readonly params: readonly AuditParamRule[] };

  /** Extracts the target resource from VALIDATED parameters. Required if changesState or targeting a resource. */
  readonly resource?: (params: DeepReadonly<TParams>) => ResourceRef | null;
  /** Required when confirmation is required (R8). */
  readonly describeConsequence?: (input: ConsequenceInput<TParams>) => ConsequenceSummary;
  /** May only SHORTEN the global default (R11). */
  readonly confirmationTtlSeconds?: number;

  /** Reference only. The executor function itself is bound at the composition root (execution.ts). */
  readonly executorId: ExecutorId;
}

// Heterogeneous collections need an erased parameter type; each definition stays fully typed
// where it is authored through defineAction().
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type AnyActionDefinition = ActionDefinition<any>;

export interface RegisteredAction {
  readonly definition: AnyActionDefinition;
  /** SHA-256 over canonical JSON of the security-relevant fields (data-model.md). */
  readonly definitionHash: Sha256Hex;
}

/**
 * Read-only. There is intentionally NO register(), remove(), or replace() method:
 * the registry is built once at startup (FR-003).
 */
export interface ActionRegistry {
  /** Exact match on a Map. Never an object-property lookup. */
  get(id: string): RegisteredAction | undefined;
  list(): readonly RegisteredAction[];
  /** Classification only (audit as policy violation). Matching is lenient; it can never grant anything. */
  isReservedForbidden(name: string): boolean;
  /** Hash over all definition hashes. Used in drift tests. */
  readonly fingerprint: Sha256Hex;
}

export type RegistrationRule =
  | "R1" | "R2" | "R3" | "R4" | "R5" | "R6"
  | "R7" | "R8" | "R9" | "R10" | "R11" | "R12";

export interface RegistrationIssue {
  readonly actionId: string;
  readonly rule: RegistrationRule;
  readonly detail: string;
}
