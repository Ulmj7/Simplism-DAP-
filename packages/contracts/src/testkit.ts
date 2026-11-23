/**
 * @dap/contracts: testkit.ts
 *
 * Security test infrastructure (FR-045..FR-049). Implemented in `@dap/testkit`.
 * The testkit may import `security` and `ai` to test them; production code never imports it.
 *
 * Types only. The buildCoverageReport runtime belongs to @dap/testkit, not here.
 *
 * Constitution: XV, XVII
 */
import type { AuditEvent } from "./audit.js";
import type { PlannerFeedback, ProposalCall } from "./gateway.js";
import type { RiskLevel } from "./core.js";

/** Scenario families. Detail and expectations: contracts/security-test-catalogue.md. */
export type AttackCategory =
  | "unknown-action"
  | "malformed-parameters"
  | "privilege-escalation"
  | "cross-tenant"
  | "confirmation-bypass"
  | "replay"
  | "prompt-injection"
  | "secret-extraction"
  | "rate-abuse"
  | "dependency-failure"
  | "audit-failure"
  | "architecture-bypass"
  | "hidden-data"; // reserved for later features; waived here

/** Facts about a capability that decide which scenarios apply to it. */
export interface CapabilityTraits {
  readonly actionId: string;
  readonly risk: RiskLevel;
  readonly changesState: boolean;
  readonly targetsResource: boolean;
  readonly requiresConfirmation: boolean;
}

/** Scripted source of proposals. Stands in for a (possibly compromised) model. No LLM involved. */
export interface HostilePlanner {
  /** Emits proposals exactly as scripted, including malformed and malicious ones. */
  readonly script: readonly ProposalCall[];
}

/** An application stand-in that proves whether execution ever happened. */
export interface RecordingExecutor {
  /** Number of times the executor body actually ran. Every denial scenario asserts this is 0. */
  readonly calls: number;
  readonly grantsSeen: number;
  /** Parameters exactly as received by the executor, for TOCTOU assertions. */
  readonly receivedParams: readonly unknown[];
}

export interface AttackObservation {
  readonly feedback: readonly PlannerFeedback[];
  readonly executorCalls: number;
  /** Canary secrets, stack traces, policy names, or confirmation ids found in planner-visible output. */
  readonly auditEvents: readonly AuditEvent[];
  readonly leakFindings: readonly string[];
}

export interface AttackScenario {
  /** Stable id, e.g. "ATK-XTENANT-03". Referenced by waivers and coverage reports. */
  readonly id: string;
  readonly category: AttackCategory;
  readonly title: string;
  /** Whether the scenario is meaningful for this capability. */
  readonly appliesTo: (traits: CapabilityTraits) => boolean;
  /** Runs the scenario against a prepared world and reports what happened. */
  readonly run: (target: CapabilityTraits) => Promise<AttackObservation>;
  /**
   * Independent oracle: returns violations (empty means pass). Must not reuse the Gateway's own
   * logic; it recomputes the expected result from the scenario's stated facts.
   */
  readonly verify: (obs: AttackObservation) => readonly string[];
}

/** A reviewed exception for a scenario that does not apply to a capability (FR-048). */
export interface Waiver {
  readonly actionId: string;
  readonly scenarioId: string;
  readonly justification: string;
  readonly reviewedBy: string;
}

export type CoverageCell =
  | { readonly state: "covered" }
  | { readonly state: "not-applicable" }
  | { readonly state: "waived"; readonly waiver: Waiver }
  | { readonly state: "MISSING" };

export interface CoverageReport {
  readonly generatedAt: string;
  /** actionId -> scenarioId -> cell */
  readonly matrix: { readonly [actionId: string]: { readonly [scenarioId: string]: CoverageCell } };
  /** CI fails when this is non-empty. */
  readonly missing: readonly { readonly actionId: string; readonly scenarioId: string }[];
}
