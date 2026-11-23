import { isPlainText } from "../semantic/registry.js";
import type { SemanticRegistry } from "../semantic/types.js";
import { MAX_ATTEMPTS_LIMIT, MAX_TARGET_WAIT_MS, MAX_TEXT, MAX_TITLE } from "./definition.js";
import type { Step, WalkthroughDef } from "./definition.js";

export const ID_GRAMMAR = /^[a-zA-Z][A-Za-z0-9_-]{0,63}$/;
const RESERVED = new Set(["__proto__", "constructor", "prototype", "toString", "hasOwnProperty", "valueOf"]);
export const isValidId = (value: unknown): value is string => typeof value === "string" && ID_GRAMMAR.test(value) && !RESERVED.has(value);

export interface WalkthroughSummary { readonly id: string; readonly title: string; readonly description: string }
export interface WalkthroughCatalog {
  /** Id, title and description only. */
  list(): readonly WalkthroughSummary[];
  /** The frozen definition, or `undefined` for anything that is not a catalog id. */
  get(id: unknown): WalkthroughDef | undefined;
}

export class WalkthroughCatalogError extends Error {
  readonly issues: readonly string[];
  constructor(issues: readonly string[]) {
    super(`Invalid walkthrough catalog: ${issues.join("; ")}`);
    this.name = "WalkthroughCatalogError";
    this.issues = issues;
  }
}

type Bag = Readonly<Record<string, unknown>>;
const isBag = (value: unknown): value is Bag => value !== null && typeof value === "object" && !Array.isArray(value);
const KEYS = {
  guide: ["id", "kind", "target", "text", "wait", "verify", "next", "recover", "targetWaitMs", "maxAttempts"],
  navigate: ["id", "kind", "route", "text", "next", "recover", "maxAttempts"],
  complete: ["id", "kind", "text"],
} as const;
const boundedInt = (value: unknown, min: number, max: number): boolean => typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;

/** Builds the frozen catalog, or throws a `WalkthroughCatalogError` listing every problem. Nothing can be added afterwards. */
export function createWalkthroughCatalog(registry: SemanticRegistry, postconditionNames: readonly string[], definitions: readonly WalkthroughDef[]): WalkthroughCatalog {
  const issues: string[] = [];
  const postconditions = new Set<string>(Array.isArray(postconditionNames) ? postconditionNames.filter((n): n is string => typeof n === "string") : []);
  const routes = new Set<string>(registry.routes);
  const byId = new Map<string, WalkthroughDef>();
  if (!Array.isArray(definitions)) throw new WalkthroughCatalogError(["definitions must be an array"]);

  if (definitions.length > 100) throw new WalkthroughCatalogError(["at most 100 walkthroughs are allowed"]);

  for (const raw of definitions as readonly unknown[]) {
    if (!isBag(raw)) { issues.push("definition must be an object"); continue; }
    const wid = isValidId(raw.id) ? raw.id : undefined;
    const at = wid ?? "<walkthrough>";
    const before = issues.length;
    const bad = (message: string) => issues.push(`${at}: ${message}`);
    if (wid === undefined) bad("malformed walkthrough id");
    else if (byId.has(wid)) bad("duplicate walkthrough id");
    if (!isPlainText(raw.title, MAX_TITLE)) bad(`title must be plain text of 1 to ${MAX_TITLE} characters`);
    if (!isPlainText(raw.description, MAX_TEXT)) bad(`description must be plain text of 1 to ${MAX_TEXT} characters`);
    const extra = Object.keys(raw).filter((k) => !["id", "title", "description", "start", "steps"].includes(k));
    if (extra.length > 0) bad(`unknown field ${extra.join(", ")}`);
    if (!Array.isArray(raw.steps) || raw.steps.length === 0) { bad("steps must be a non-empty array"); continue; }

    if (raw.steps.length > 100) { bad("at most 100 steps are allowed"); continue; }
    const steps = new Map<string, Bag>();
    for (const rawStep of raw.steps as readonly unknown[]) {
      if (!isBag(rawStep)) { bad("step must be an object"); continue; }
      if (!isValidId(rawStep.id)) { bad("step with a malformed id"); continue; }
      if (steps.has(rawStep.id)) { bad(`${rawStep.id}: duplicate step id`); continue; }
      steps.set(rawStep.id, rawStep);
    }
    if (!isValidId(raw.start) || !steps.has(raw.start)) bad("missing start step");

    const edges = new Map<string, string[]>();
    for (const [sid, step] of steps) {
      const sbad = (message: string) => issues.push(`${at}.${sid}: ${message}`);
      const kind = step.kind;
      if (kind !== "guide" && kind !== "navigate" && kind !== "complete") { sbad("unknown step kind"); continue; }
      const stray = Object.keys(step).filter((k) => !(KEYS[kind] as readonly string[]).includes(k));
      if (stray.length > 0) sbad(`unknown field ${stray.join(", ")}`);
      const out: string[] = [];
      if (kind === "complete") {
        if (!isPlainText(step.text, MAX_TEXT)) sbad(`text must be plain text of 1 to ${MAX_TEXT} characters`);
        edges.set(sid, out);
        continue;
      }
      if (!isValidId(step.next) || !steps.has(step.next)) sbad("missing next step"); else out.push(step.next);
      if (step.recover !== undefined) {
        if (!isValidId(step.recover) || !steps.has(step.recover)) sbad("missing recover step");
        else if (step.recover === sid) sbad("recover points at the step itself");
        else if (steps.get(step.recover)?.kind === "complete") sbad("recover points at a complete step");
        else out.push(step.recover);
      }
      if (step.maxAttempts !== undefined && !boundedInt(step.maxAttempts, 1, MAX_ATTEMPTS_LIMIT)) sbad(`maxAttempts must be an integer from 1 to ${MAX_ATTEMPTS_LIMIT}`);
      if (kind === "guide") {
        if (!isPlainText(step.text, MAX_TEXT)) sbad(`text must be plain text of 1 to ${MAX_TEXT} characters`);
        const def = typeof step.target === "string" ? registry.get(step.target) : undefined;
        if (def === undefined) sbad("unknown target");
        else {
          if (!def.operations.includes("highlight")) sbad("target does not allow highlight");
          if (step.wait === "click" && !def.operations.includes("click")) sbad("wait click needs a target that allows click");
          if (step.wait === "input" && !def.operations.includes("input")) sbad("wait input needs a target that allows input");
        }
        if (step.wait !== "click" && step.wait !== "input" && step.wait !== "ack") sbad("wait must be click, input or ack");
        if (step.verify !== undefined && (typeof step.verify !== "string" || !postconditions.has(step.verify))) sbad("unknown postcondition");
        if (step.targetWaitMs !== undefined && !boundedInt(step.targetWaitMs, 0, MAX_TARGET_WAIT_MS)) sbad(`targetWaitMs must be an integer from 0 to ${MAX_TARGET_WAIT_MS}`);
      } else {
        if (typeof step.route !== "string" || !routes.has(step.route)) sbad("unknown route");
        if (step.text !== undefined && !isPlainText(step.text, MAX_TEXT)) sbad(`text must be plain text of 1 to ${MAX_TEXT} characters`);
      }
      edges.set(sid, out);
    }

    // Reachability, on the steps that are well formed enough to have edges.
    if (isValidId(raw.start) && steps.has(raw.start) && issues.length === before) {
      const reached = new Set<string>();
      const pending = [raw.start];
      for (let next = pending.pop(); next !== undefined; next = pending.pop()) {
        if (reached.has(next)) continue;
        reached.add(next);
        pending.push(...(edges.get(next) ?? []));
      }
      for (const sid of steps.keys()) if (!reached.has(sid)) issues.push(`${at}.${sid}: unreachable from start`);
      const canFinish = new Set<string>([...steps].filter(([, s]) => s.kind === "complete").map(([sid]) => sid));
      for (let changed = true; changed;) {
        changed = false;
        for (const [sid, out] of edges) if (!canFinish.has(sid) && out.some((n) => canFinish.has(n))) { canFinish.add(sid); changed = true; }
      }
      for (const sid of reached) {
        if (!canFinish.has(sid)) issues.push(`${at}.${sid}: no path to a complete step`);
        const seen = new Set<string>();
        let current = sid;
        while (steps.get(current)?.kind !== "complete" && !seen.has(current)) {
          seen.add(current);
          current = steps.get(current)!.next as string;
        }
        if (steps.get(current)?.kind !== "complete") issues.push(`${at}.${sid}: next chain cannot reach a complete step`);
      }
    }

    if (issues.length === before && wid !== undefined) byId.set(wid, freezeDefinition(raw as unknown as WalkthroughDef));
  }
  if (issues.length > 0) throw new WalkthroughCatalogError(issues);

  const summaries = Object.freeze([...byId.values()].map((d) => Object.freeze({ id: d.id, title: d.title, description: d.description })));
  return Object.freeze({
    list: () => summaries,
    get: (id: unknown) => (typeof id === "string" ? byId.get(id) : undefined),
  });
}

/** A frozen copy holding only the known fields, so later changes to the caller's objects cannot reach the catalog. */
function freezeDefinition(source: WalkthroughDef): WalkthroughDef {
  const steps = source.steps.map((step): Step => {
    const copy: Record<string, unknown> = {};
    for (const key of Object.keys(step) as (keyof Step)[]) copy[key] = step[key];
    if (step.kind !== "complete" && copy.maxAttempts === undefined) delete copy.maxAttempts;
    return Object.freeze(copy) as unknown as Step;
  });
  return Object.freeze({ id: source.id, title: source.title, description: source.description, start: source.start, steps: Object.freeze(steps) });
}
