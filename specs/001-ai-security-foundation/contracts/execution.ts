/**
 * @dap/contracts: execution.ts
 *
 * ActionExecutor and the single-use ExecutionGrant that makes executors callable ONLY by
 * the Policy Gateway (FR-011, FR-017). Executors live in `@dap/actions` and the AI layer has
 * no dependency on that package (research D4, D5).
 *
 * Types only. The runtime pieces (defineExecutor wrapper, bindExecutors) live in the
 * contracts execution runtime and @dap/security, not here.
 *
 * Constitution: III, VII, VIII, IX, X
 */
import type {
  ActionId,
  DeepReadonly,
  ExecutorId,
  RequestId,
  ResolvedResource,
  ResourceRef,
  Sha256Hex,
} from "./core";
import type { AuthorizationContext } from "./security-context";

declare const __grant: unique symbol;

/**
 * Proof that the Gateway approved exactly this call. Minted only by the Gateway through the
 * restricted `mint` subpath, bound to the values below, and SINGLE-USE. Tracked in a
 * module-private registry, so a copied or fabricated literal fails verification.
 */
export interface ExecutionGrant {
  readonly [__grant]: true;
  readonly requestId: RequestId;
  readonly actionId: ActionId;
  readonly paramsDigest: Sha256Hex;
}

/** What an executor receives. Everything here is trusted or validated; nothing is model-supplied identity. */
export interface ExecutionCall<TParams> {
  readonly grant: ExecutionGrant;
  /** Derived from authentication. Executors act with THIS user's authority, never a service identity (FR-024). */
  readonly security: AuthorizationContext;
  /** Validated, normalized, deeply frozen. Never the raw proposal. */
  readonly params: DeepReadonly<TParams>;
  readonly resource: ResolvedResource | null;
  readonly requestId: RequestId;
  /** The resolved action id. Must equal the grant's bound actionId (defineExecutor verifies). */
  readonly actionId: ActionId;
  /** SHA-256 over canonical JSON of the validated params. Must equal the grant's bound paramsDigest. */
  readonly paramsDigest: Sha256Hex;
}

export type UiInstruction =
  | { readonly kind: "highlight"; readonly elementId: string }
  | { readonly kind: "tooltip"; readonly elementId: string; readonly text: string }
  | { readonly kind: "navigate"; readonly route: string };

export type ExecutionResult<TValue = unknown> =
  | {
      readonly status: "success";
      readonly value?: TValue;
      /** For the audit trail's "resource affected". */
      readonly affected?: ResourceRef;
      /** Browser is display-only (research D15): UI effects are returned as typed instructions. */
      readonly ui?: UiInstruction;
    }
  | {
      readonly status: "failure";
      /** Trusted executor failure code; the current Gateway records only success/failure, not this code. */
      readonly code: string;
    };

export interface ActionExecutor<TParams = unknown, TValue = unknown> {
  readonly id: ExecutorId;
  /**
   * Created with defineExecutor(), whose wrapper verifies the grant BEFORE running:
   * grant minted by a Gateway, not yet consumed, bound to this call's
   * (requestId, actionId, params digest, tenant, user). Otherwise it throws and runs nothing.
   */
  execute(call: ExecutionCall<TParams>): Promise<ExecutionResult<TValue>>;
}

/**
 * Executors bound to registry entries at the composition root. Passed to createPolicyGateway()
 * and nowhere else; the AI layer never receives it (research D4).
 */
export interface ExecutorTable {
  readonly executorFor: (id: ExecutorId) => ActionExecutor | undefined;
}
