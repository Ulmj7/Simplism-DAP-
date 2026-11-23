/**
 * The `startWalkthrough` capability (T315): how an approved guidance proposal becomes an action. It is an ordinary Feature 001 capability: the model never
 * reaches this code; a proposal goes through the Gateway (strict schema, permission, risk, rate/replay, durable audit) and only then does the trusted
 * executor run.
 *
 *   risk LOW, changesState false   starting a guide only displays guidance (it may navigate inside the app); it changes no application data, and it never
 *                                  inherits or grants authority for any mutation. (SAFE would be wrong: one capability cannot be SAFE for some guides and LOW for others.)
 *   permission perm.guidance.start granted per session by the host; no default session gets it
 *   allowedPages "any"             no confirmation (not-required), audit parameter /walkthroughId (plain)
 *
 * The executor RE-VALIDATES the id against the host's catalog view (fail closed: an id that is not in the list, or a catalog that cannot be read, means the
 * starter is never called), then calls the injected `WalkthroughStarter.start(id)` exactly once. The starter is a small STRUCTURAL interface that matches
 * Feature 002's `startWalkthrough(id): StartResult`, so the real runtime adapts with a one-line wrapper; this file imports nothing from @dap/walkthrough.
 * Every failure is a short code; no starter reason, thrown text or catalog content leaves the executor.
 */
import { z } from "zod";
import { defineAction, defineExecutor } from "@dap/contracts";
import type { ActionDefinition, ActionExecutor, ActionId, ExecutorId, PermissionId } from "@dap/contracts";
import { WALKTHROUGH_ID, parseCatalogSummaries, validateProposedWalkthrough } from "@dap/ai";
import type { WalkthroughCatalogView } from "@dap/ai";
import type { HostExtension } from "../compose.js";

/** What the trusted executor calls. Matches Feature 002's `StartResult`: `{ ok: true }` or `{ ok: false, reason }`. */
export interface WalkthroughStarter {
  start(id: string): { readonly ok: true } | { readonly ok: false; readonly reason: string };
}

export const START_WALKTHROUGH_ACTION_ID = "startWalkthrough";
export const START_WALKTHROUGH_PERMISSION = "perm.guidance.start";
export const START_WALKTHROUGH_EXECUTOR_ID = "ex.guidance-start-walkthrough";

/** The id grammar is the AI package's `WALKTHROUGH_ID` (= Feature 002's); the names that are never ids are refused on top. */
const RESERVED = new Set(["__proto__", "constructor", "prototype", "toString", "hasOwnProperty", "valueOf"]);

export const startWalkthrough: ActionDefinition<{ readonly walkthroughId: string }> = defineAction({
  id: START_WALKTHROUGH_ACTION_ID as ActionId,
  version: 1,
  description: "Starts an existing, catalogued guided walkthrough by its id. It only shows guidance to the user: it changes no application data.",
  inputSchema: z.strictObject({ walkthroughId: z.string().min(1).max(64).regex(WALKTHROUGH_ID).refine((id) => !RESERVED.has(id)) }),
  risk: "LOW",
  requiredPermission: START_WALKTHROUGH_PERMISSION as PermissionId,
  allowedPages: "any",
  confirmation: { kind: "not-required" },
  changesState: false,
  audit: { params: [{ path: "/walkthroughId", mode: "plain" }] },
  executorId: START_WALKTHROUGH_EXECUTOR_ID as ExecutorId,
});

/** The failure codes of the executor (short, fixed). */
export type StartFailureCode = "unknown_walkthrough" | "catalog_unavailable" | "start_refused";

/** What the executor body received, as the host's own record (never reachable from an AI session). */
export interface GuidanceTrustedHandle {
  /** The validated parameters of every call that reached the executor body, in order. */
  receivedParams(): readonly unknown[];
}

export function createStartWalkthroughExecutor(deps: { readonly catalog: WalkthroughCatalogView; readonly starter: WalkthroughStarter }): { readonly executor: ActionExecutor; readonly trusted: GuidanceTrustedHandle } {
  const { catalog, starter } = deps;
  const received: unknown[] = [];
  const MAX_RECORDED = 100; // a host-side test record, bounded: the newest calls are kept
  const executor = defineExecutor<{ readonly walkthroughId: string }>({
    id: START_WALKTHROUGH_EXECUTOR_ID,
    run: async (call) => {
      const id = call.params.walkthroughId;
      received.push(structuredClone(call.params));
      if (received.length > MAX_RECORDED) received.shift();
      // Re-validate against the host's own catalog: the Gateway's schema only proves the id is well formed, not that a walkthrough of that id exists.
      let known: boolean;
      try {
        // The SAME strict check of the catalog port as the guidance service applies (plain array, strict summaries, unique ids): a malformed catalog proves nothing.
        const list = parseCatalogSummaries(catalog.list());
        if (list === null) return { status: "failure", code: "catalog_unavailable" satisfies StartFailureCode };
        known = validateProposedWalkthrough(list, id) !== null;
      } catch { return { status: "failure", code: "catalog_unavailable" satisfies StartFailureCode }; }
      if (!known) return { status: "failure", code: "unknown_walkthrough" satisfies StartFailureCode };
      try {
        const result: unknown = starter.start(id);
        if (result !== null && typeof result === "object") {
          // The starter is synchronous: observe an accidentally returned native Promise, but never accept it as a start.
          try { Promise.prototype.then.call(result, () => undefined, () => undefined); }
          catch {
            const proto: unknown = Object.getPrototypeOf(result);
            if ((proto === Object.prototype || proto === null) && !("then" in result) && (result as { ok?: unknown }).ok === true) return { status: "success" };
          }
        }
      } catch { /* a throwing starter is a failed start */ }
      return { status: "failure", code: "start_refused" satisfies StartFailureCode };
    },
  });
  return { executor, trusted: Object.freeze({ receivedParams: () => Object.freeze([...received]) }) };
}

/** The host extension that adds `startWalkthrough` and its executor. The capability is still OFF unless `DAP_ENABLED_ACTIONS` lists it (default deny). */
export function createGuidanceExtension(deps: { readonly catalog: WalkthroughCatalogView; readonly starter: WalkthroughStarter }): { readonly extension: HostExtension; readonly trusted: GuidanceTrustedHandle } {
  const { executor, trusted } = createStartWalkthroughExecutor(deps);
  return { extension: Object.freeze({ definitions: Object.freeze([startWalkthrough]), executors: Object.freeze([executor]) }), trusted };
}
