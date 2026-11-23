/**
 * The health check of the registered targets of the CURRENT page (Studio COMPLETION, S3): pure, so every state and reason is unit-tested without a browser. For every ACTIVE target of the
 * page's route the live inspected set (the first 64 controls) must hold its MARKER exactly once, with the mapped role of the target, public by its facts and by its name:
 *
 *   healthy      one control, the right role, public
 *   broken       not_found (no control carries the marker), ambiguous (several do), role_changed (the control's role no longer maps to the target's), private (its facts or its name now fail the gate)
 *   unverified   cannot tell: the page shows more controls than are inspected and the marker was not among them, or the facts of the control could not be read. Nothing is persisted for it.
 *
 * A reply names registered targets only (their DAP ids), never a control that is hidden, and is capped at 100 results.
 */
import type { BrowserSnapshot, ElementFacts, ElementRef } from "@dap/browser-runtime";
import { effectivePrivacyOfFacts, secretNameHit } from "./element-privacy.js";
import { MAX_INSPECTED, pageOfUrl, routeOfPage } from "./managed-inspector.js";
import type { ManagedRegistryView } from "./managed-inspector.js";
import { snapshotRoleToTargetRole } from "./registry-targets.js";

export const HEALTH_REASONS = ["not_found", "role_changed", "private", "ambiguous"] as const;
export type HealthReason = (typeof HEALTH_REASONS)[number];
export interface HealthResult { readonly targetId: string; readonly state: "healthy" | "broken" | "unverified"; readonly reason?: HealthReason }
export interface HealthReport { readonly page: string | null; readonly route: string | null; readonly results: readonly HealthResult[] }
export const MAX_HEALTH_RESULTS = 100;

export interface HealthInput {
  readonly routing?: "hash" | "history";
  readonly snapshot: BrowserSnapshot;
  readonly ids: ReadonlyMap<ElementRef, string | null>;
  readonly facts: ReadonlyMap<ElementRef, ElementFacts | null>;
  readonly registry: ManagedRegistryView;
}

export function evaluateHealth(input: HealthInput): HealthReport {
  const page = pageOfUrl(input.snapshot.url, input.routing ?? "hash");
  const route = routeOfPage(page, input.registry.routes);
  if (route === null) return Object.freeze({ page, route, results: Object.freeze([]) });
  const inspected = input.snapshot.elements.slice(0, MAX_INSPECTED);
  const truncated = input.snapshot.elements.length > MAX_INSPECTED;
  const results: HealthResult[] = [];
  for (const target of input.registry.targets) {
    if (target.status !== "active" || target.route !== route) continue;
    const matches = inspected.filter((element) => input.ids.get(element.ref) === target.marker);
    let result: HealthResult;
    if (matches.length > 1) result = { targetId: target.id, state: "broken", reason: "ambiguous" };
    else if (matches.length === 0) result = truncated ? { targetId: target.id, state: "unverified" } : { targetId: target.id, state: "broken", reason: "not_found" };
    else {
      const element = matches[0]!;
      const facts = input.facts.get(element.ref);
      if (snapshotRoleToTargetRole(element.role) !== target.role) result = { targetId: target.id, state: "broken", reason: "role_changed" };
      else if (facts === undefined || facts === null) result = { targetId: target.id, state: "unverified" };
      else if (effectivePrivacyOfFacts(facts) !== "public" || secretNameHit(element.name)) result = { targetId: target.id, state: "broken", reason: "private" };
      else result = { targetId: target.id, state: "healthy" };
    }
    results.push(Object.freeze(result));
    if (results.length >= MAX_HEALTH_RESULTS) break;
  }
  return Object.freeze({ page, route, results: Object.freeze(results) });
}
