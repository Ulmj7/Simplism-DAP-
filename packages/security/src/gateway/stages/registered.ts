import type { ActionRegistry, AnyActionDefinition, AuditParamRule } from "@dap/contracts";

/** The only definition fields the stages after resolve use, each copied ONCE at the moment of proof. */
export type ProvenDefinition = Pick<AnyActionDefinition, "id" | "version" | "inputSchema" | "resource" | "requiredPermission" | "allowedPages" | "risk"> & {
  /** What the capability lets the audit trail record, copied once. Anything unreadable is dropped: nothing unlisted is ever recorded. */
  readonly auditParams: readonly AuditParamRule[];
  /** Which executor runs it; read once, and checked by the stage that uses it. */
  readonly executorId: unknown;
  readonly changesState: unknown;
  /** The confirmation policy as two plain reads (`kind`, `justification`), copied once, or undefined when it is not an object. The risk stage interprets it. */
  readonly confirmation: Readonly<{ kind: unknown; justification: unknown }> | undefined;
};

/** The capability's confirmation policy copied once; a throwing or non-object policy yields undefined (the risk stage then fails closed). */
function confirmationPolicy(definition: object): ProvenDefinition["confirmation"] {
  try {
    // A policy that is not an object makes Reflect.get throw: that is the undefined below.
    const policy = Reflect.get(definition, "confirmation") as object;
    return Object.freeze({ kind: Reflect.get(policy, "kind"), justification: Reflect.get(policy, "justification") });
  } catch { return undefined; }
}

/** The capability's audit allowlist as frozen plain rules; a malformed list or rule is dropped (fail closed: less is recorded, never more). */
function auditRules(definition: object): readonly AuditParamRule[] {
  try {
    const audit: unknown = Reflect.get(definition, "audit");
    const list: unknown = audit !== null && typeof audit === "object" ? Reflect.get(audit, "params") : undefined;
    if (!Array.isArray(list)) return Object.freeze([]);
    const rules: AuditParamRule[] = [];
    for (let index = 0; index < Math.min(list.length, 256); index++) {
      const rule: unknown = list[index];
      if (rule === null || typeof rule !== "object") continue;
      const path: unknown = Reflect.get(rule, "path");
      const mode: unknown = Reflect.get(rule, "mode");
      if (typeof path === "string" && (mode === "plain" || mode === "masked")) rules.push(Object.freeze({ path, mode }));
    }
    return Object.freeze(rules);
  } catch { return Object.freeze([]); }
}

/**
 * The registered definition for the action resolve authorized, proven to be that very action: same id, same version, same
 * definition hash. A registry that has since forgotten it, or answers with anything else, yields undefined (a dependency
 * failure for the caller), never a different definition.
 *
 * Every field is read exactly once, before any await, and the caller receives a frozen snapshot of those reads, never the
 * live object: a getter that answers differently the second time can neither pass the proof with one id and then be
 * validated, digested or authorized under another, nor swap the permission or pages between two stages.
 */
export function provenDefinition(get: ActionRegistry["get"], resolved: Readonly<Record<string, unknown>>): ProvenDefinition | undefined {
  const entry = get(resolved.id as string);
  if (!entry || typeof entry !== "object") return undefined;
  const definition: unknown = Reflect.get(entry, "definition");
  const definitionHash: unknown = Reflect.get(entry, "definitionHash");
  if (!definition || typeof definition !== "object") return undefined;
  const id: unknown = Reflect.get(definition, "id");
  const version: unknown = Reflect.get(definition, "version");
  if (id !== resolved.id || version !== resolved.version || definitionHash !== resolved.definitionHash) return undefined;
  return Object.freeze({
    id, version,
    risk: Reflect.get(definition, "risk"),
    inputSchema: Reflect.get(definition, "inputSchema"),
    resource: Reflect.get(definition, "resource"),
    requiredPermission: Reflect.get(definition, "requiredPermission"),
    allowedPages: Reflect.get(definition, "allowedPages"),
    auditParams: auditRules(definition),
    executorId: Reflect.get(definition, "executorId"),
    changesState: Reflect.get(definition, "changesState"),
    confirmation: confirmationPolicy(definition),
  }) as ProvenDefinition;
}
