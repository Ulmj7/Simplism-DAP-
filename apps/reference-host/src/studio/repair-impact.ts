/**
 * The compatibility rule of a target repair (Studio COMPLETION, S3), shared by the dry run in the browser session and by the repair transaction of the store, so the two cannot disagree:
 * EVERY stored workflow that names the target (drafts and published content) must still validate, with the ONE Feature 002 validator, against the registry AS IT IS AFTER the repair
 * (the active targets with the repaired one). Workflows keep their DAP ids: only what the registry says about the target changes. A repair of a DISABLED target changes nothing for workflows
 * (they already fail while it is disabled), so it has no problems of its own. An active value check (`element.value.equals`) on the target also forbids a role that has no value (S4).
 */
import { capIssues, validateAuthoredDefinition } from "../authoring/validate.js";
import type { DefinitionUsing, ManagedRegistry, RepairImpact, RepairVerify } from "./target-store.js";
import { managedRegistryData } from "./registry-resolver.js";
import { VALUE_CHECK_ROLES } from "./registry-checks.js";

export const MAX_REPAIR_PROBLEMS = 20;
// The maintainer wire caps the displayed lists. The compatibility check above inspects every definition.
const MAX_DISPLAYED_USAGE = 100;

export const verifyRepair: RepairVerify = (definitions, registry, target) => {
  if (target.status === "disabled") return [];
  const after = managedRegistryData(registry).registry;
  const problems: string[] = [];
  // An active value check observes a textbox, select or checkbox: a repair may not turn its target into another role.
  if (!(VALUE_CHECK_ROLES as readonly string[]).includes(target.role)) {
    for (const check of registry.checks) if (check.kind === "element.value.equals" && check.targetId === target.id) problems.push(`${check.name}: a value check needs a textbox, select or checkbox target`);
  }
  for (const definition of definitions) {
    const checked = validateAuthoredDefinition(definition.id, definition.definition, after);
    if (!checked.ok) for (const issue of checked.issues) problems.push(`${definition.id}: ${issue}`);
  }
  return capIssues(problems).slice(0, MAX_REPAIR_PROBLEMS);
};

export const impactOf = (definitions: readonly DefinitionUsing[]): RepairImpact => Object.freeze({
  drafts: Object.freeze(definitions.filter((item) => item.status === "draft").slice(0, MAX_DISPLAYED_USAGE).map((item) => Object.freeze({ id: item.id, title: item.title }))),
  published: Object.freeze(definitions.filter((item) => item.status === "published").slice(0, MAX_DISPLAYED_USAGE).map((item) => Object.freeze({ id: item.id, title: item.title, version: item.version ?? 1 }))),
});

/** The registry after a repair, for a dry run: the stored registry with the target's element replaced by the proposed fields (the active targets only, as the validator sees them). */
export function registryAfterRepair(registry: ManagedRegistry, targetId: string, fields: { readonly marker: string; readonly role: string; readonly operations: readonly string[]; readonly label: string; readonly description: string }): ManagedRegistry {
  const elements = registry.elements.map((element) => (element.id === targetId
    ? { ...element, role: fields.role, label: fields.label, description: fields.description, operations: [...fields.operations] }
    : element)) as unknown as ManagedRegistry["elements"];
  return { routes: registry.routes, elements, markers: { ...registry.markers, [targetId]: fields.marker }, checks: registry.checks };
}
