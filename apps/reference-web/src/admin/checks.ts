import { CHECK_ATTRIBUTES, CHECK_KINDS, CHECK_NAME, expectedOf, MAX_ATTRIBUTE_EXPECTED, MAX_EXPECTED } from "../embed/checks.js";
import type { CheckAttribute, CheckKind } from "../embed/checks.js";
import { LIMITS, count, exact, record, routeKey, targetIdOf } from "./wire.js";

/**
 * Studio completion S4: the verification checks of a Studio-managed registry, as the host lists them (`GET …/checks`, create-or-get `POST …/checks`, `POST …/checks/:name/status`).
 * A check is a kind, an ACTIVE target of the application (or a route), and at most one short expected value: no selector, no script. Every field a kind does not use is `null`.
 */
export interface CheckView {
  readonly name: string;
  readonly kind: CheckKind;
  readonly targetId: string | null;
  readonly route: string | null;
  readonly attribute: CheckAttribute | null;
  readonly expected: string | null;
  readonly status: "active" | "disabled";
  readonly references: { readonly drafts: number; readonly published: number };
}
/** The body of a create-or-get: only the fields of the chosen kind. */
export interface CheckInput { readonly kind: CheckKind; readonly targetId?: string; readonly route?: string; readonly attribute?: CheckAttribute; readonly expected?: string }

const KEYS = ["name", "kind", "targetId", "route", "attribute", "expected", "status", "references"];

export function parseCheckView(value: unknown, name?: string): CheckView | null {
  if (!record(value) || !exact(value, KEYS) || typeof value.name !== "string" || !CHECK_NAME.test(value.name) || (name !== undefined && value.name !== name)
    || !(CHECK_KINDS as readonly unknown[]).includes(value.kind) || (value.status !== "active" && value.status !== "disabled")
    || !record(value.references) || !exact(value.references, ["drafts", "published"]) || !count(value.references.drafts, LIMITS.references) || !count(value.references.published, LIMITS.references)) return null;
  const kind = value.kind as CheckKind;
  const { targetId, route, attribute, expected } = value;
  // Exactly the fields of the kind are present; every other one is null.
  const wanted = {
    "route.equals": { targetId: false, route: true, attribute: false, expected: false },
    "element.visible": { targetId: true, route: false, attribute: false, expected: false },
    "element.hidden": { targetId: true, route: false, attribute: false, expected: false },
    "element.text.equals": { targetId: true, route: false, attribute: false, expected: true },
    "element.value.equals": { targetId: true, route: false, attribute: false, expected: true },
    "element.attribute.equals": { targetId: true, route: false, attribute: true, expected: true },
  }[kind];
  if ((wanted.targetId ? !targetIdOf(targetId) : targetId !== null) || (wanted.route ? !routeKey(route) : route !== null)
    || (wanted.attribute ? !(CHECK_ATTRIBUTES as readonly unknown[]).includes(attribute) : attribute !== null)
    || (wanted.expected ? !expectedOf(expected, kind === "element.attribute.equals" ? MAX_ATTRIBUTE_EXPECTED : MAX_EXPECTED) : expected !== null)) return null;
  return { name: value.name, kind, targetId: targetId as string | null, route: route as string | null, attribute: attribute as CheckAttribute | null, expected: expected as string | null,
    status: value.status, references: { drafts: value.references.drafts, published: value.references.published } };
}

export function parseCheckList(value: unknown): readonly CheckView[] | null {
  if (!record(value) || !exact(value, ["checks"]) || !Array.isArray(value.checks) || value.checks.length > LIMITS.checks) return null;
  const checks: CheckView[] = [];
  for (const item of value.checks as unknown[]) {
    const parsed = parseCheckView(item);
    if (!parsed || checks.some(other => other.name === parsed.name)) return null;
    checks.push(parsed);
  }
  return checks;
}

/** The body the host receives: only the fields of the kind, in a fixed order. `null` when the input does not fit the kind. */
export function checkBody(input: CheckInput): Record<string, unknown> | null {
  const { kind, targetId, route, attribute, expected } = input;
  if (!(CHECK_KINDS as readonly unknown[]).includes(kind)) return null;
  if (kind === "route.equals") return routeKey(route) ? { kind, route } : null;
  if (!targetIdOf(targetId)) return null;
  if (kind === "element.visible" || kind === "element.hidden") return { kind, targetId };
  if (!expectedOf(expected, kind === "element.attribute.equals" ? MAX_ATTRIBUTE_EXPECTED : MAX_EXPECTED)) return null;
  if (kind === "element.attribute.equals") return (CHECK_ATTRIBUTES as readonly unknown[]).includes(attribute) ? { kind, targetId, attribute, expected } : null;
  return { kind, targetId, expected };
}
