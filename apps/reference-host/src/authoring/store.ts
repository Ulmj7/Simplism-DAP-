/**
 * The walkthrough store port (Feature 004, T404). Small on purpose: exactly the operations authoring needs, no generic repository.
 *
 * Trust: `scope` ({ tenantId, actor }) always comes from the trusted context of the caller (the Gateway's `call.security` for writes, the host-resolved principal for
 * reads), never from a request body or a parameter. The store re-checks the SHAPE of what it is given but does not validate walkthrough semantics: the executor
 * validates with the one Feature 002 validator before it calls `saveDraft`, and passes the same validator to `setStatus`, which runs it INSIDE the transaction on the
 * row it has locked, so a definition cannot change between "validated" and "published".
 */
import type { WalkthroughDef } from "@dap/walkthrough/authoring";
import type { WalkthroughStatus } from "./schema.js";

export const MAX_PUBLISHED_PER_TENANT = 50;
export const MAX_LISTED = 200;
export const MAX_DEFINITION_BYTES = 32 * 1024;

export interface Scope {
  /** From the trusted context. */
  readonly tenantId: string;
  /** The safe actor id from the trusted context (`call.security.userId`). */
  readonly actor: string;
}
export interface StoredSummary {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly status: WalkthroughStatus;
  readonly stepCount: number;
  readonly updatedAt: string;
  /** The application this guide belongs to; `null` for a guide written before Studio, which the host treats as the built-in `reference` application. */
  readonly applicationId: string | null;
}
export interface StoredWalkthrough {
  readonly id: string;
  readonly status: WalkthroughStatus;
  /** The application this guide belongs to (`null` = legacy, resolved as `reference`). Assigned once, never changed. */
  readonly applicationId: string | null;
  /** The stored JSON, NOT yet trusted: every reader re-validates it against the current registry data. */
  readonly definition: unknown;
  readonly updatedAt: string;
}

export type SaveOutcome = "created" | "updated" | "not_a_draft" | "id_refused" | "too_large" | "application_mismatch";
export type StatusOutcome = "changed" | "unchanged" | "not_found" | "invalid_definition" | "limit_reached" | "id_refused";

export const USAGE_EVENTS = ["started", "completed", "cancelled"] as const;
export interface UsageEvent {
  readonly walkthroughId: string;
  readonly runId: string;
  readonly event: (typeof USAGE_EVENTS)[number];
}
export interface StoredUsage {
  readonly id: string;
  readonly title: string | null;
  readonly started: number;
  readonly completed: number;
  readonly cancelled: number;
}

export interface WalkthroughStore {
  /** Returns false if the authored guide is no longer published. Replays and unmatched terminals return true without adding a row. */
  recordEvent(tenantId: string, event: UsageEvent): Promise<boolean>;
  summary(tenantId: string): Promise<readonly StoredUsage[]>;
  /** The tenant's authored guides (drafts and published), newest update first, at most 200. */
  list(tenantId: string): Promise<readonly StoredSummary[]>;
  get(tenantId: string, id: string): Promise<StoredWalkthrough | null>;
  /**
   * Inserts a new draft bound to `applicationId`, or updates an existing one ONLY while its status is `draft`. A published guide is never overwritten. The application is
   * assigned ONCE: a legacy row without one takes it on its first save, a row that already has one keeps it, and a save naming a different application changes nothing
   * and answers `application_mismatch`.
   */
  saveDraft(scope: Scope, id: string, definition: WalkthroughDef, applicationId: string): Promise<SaveOutcome>;
  /**
   * Publish: locks the row, runs `isValid` on the STORED definition and the row's application id as read UNDER THE LOCK (re-validation against the application's current
   * registry data), enforces the cap of 50 published per tenant, then sets the status. Unpublish (`draft`) restores editability and never calls `isValid`. Never creates a row.
   */
  setStatus(scope: Scope, id: string, status: WalkthroughStatus, isValid: (storedDefinition: unknown, applicationId: string | null) => boolean): Promise<StatusOutcome>;
  /** The tenant's published guides, oldest first, at most 50. The definitions are untrusted JSON: re-validate each. */
  listPublished(tenantId: string): Promise<readonly StoredWalkthrough[]>;
}
