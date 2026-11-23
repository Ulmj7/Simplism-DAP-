/**
 * @dap/testkit: attacks/targets.ts. The shared home of the target interfaces the attack scenarios drive.
 *
 * A plain `ScenarioTarget` (scenario-runner.ts) only lets a scenario submit scripted proposals and read what was recorded. Some attacks must also
 * change the world: make the host's permission hook answer something odd, move the clock past the session, plant a resource of another tenant.
 * Those hooks are declared here, once, so that `world.withGateway()` (T070) has a single list of what it must implement and a scenario never reaches
 * into the world by any other path. Every method must act on the REAL host fakes and the real chain: a target that answers on its own, or that
 * decides, would make the scenario's oracle vacuous.
 */
import type { ScenarioTarget } from "../scenario-runner.js";

/**
 * What the privilege-escalation scenarios (privilege-escalation.ts, ATK-PRIV-06, 07, 08) need beyond a plain target.
 * `world.withGateway()` (T070) must implement every member against the host fakes behind the Gateway.
 */
export interface PrivilegeTarget extends ScenarioTarget {
  /** A proposal for the capability under test with valid parameters. */
  validProposal(): unknown;
  /** Make the host's permission hook answer exactly `answer` (any value, not only a boolean) to every question the Gateway asks. */
  setPermissionAnswer(answer: unknown): void;
  /** Make the host's page provider report `page` as the current page (`null`: no page). The Gateway must treat this only as a narrowing signal. */
  setReportedPage(page: string | null): void;
  /** Move the host clock past the end of the calling session, so that the next proposal arrives on an expired session. */
  expireSession(): void;
}

/** Which kind of resource a cross-tenant proposal points at. */
export type ResourceKind = "other-tenant" | "nonexistent" | "same-tenant-unauthorized";

/**
 * What the cross-tenant scenarios (cross-tenant.ts, ATK-XTENANT-01..04) need beyond a plain target.
 * `world.withGateway()` (T070) must implement every member against the host fakes behind the Gateway; the planted display names must be
 * real strings in the other tenant's data so that a leak into this tenant's output is detectable.
 */
export interface TenantAttackTarget extends ScenarioTarget {
  /** A proposal for the capability under test aimed at a resource of the given kind. */
  resourceProposal(kind: ResourceKind): unknown;
  /** Make the host's resource check answer `answer` (null, or a resolved resource) for every question the Gateway asks. */
  setResourceAnswer(answer: unknown): void;
  /** What the host's resource check returns for a resource of ANOTHER tenant when it is asked: a resolved resource of that tenant. */
  foreignResource(): unknown;
  /** Display names planted in the other tenant's resources: they must never appear in this tenant's output. */
  readonly foreignDisplayNames: readonly string[];
}
