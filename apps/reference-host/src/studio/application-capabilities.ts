/**
 * The two Studio application capabilities (Studio V1A, D2): the ONLY way an application is enrolled, changed, enabled or disabled. They are ordinary Feature 001
 * capabilities, registered exactly like the Feature 004 authoring extension: a request goes through the Gateway (strict schema, permission, risk, rate/replay, durable
 * audit) and only then does a trusted executor run.
 *
 *   saveStudioApplication        { applicationId, name, origin, allowedOrigins, environment, registryId }   create an application or update its configuration
 *   setStudioApplicationEnabled  { applicationId, enabled }                                                  enable or disable (there is no delete)
 *
 * Both are MEDIUM, `changesState`, permission EXACTLY `perm.walkthrough.maintain`, `allowedPages: "any"`, a `studioApplication` resource (rule R9) and a written
 * justification in place of a confirmation (HIGH is impossible until the confirmation service exists). Audit records `/applicationId` (and `/enabled`, a boolean, on the
 * second capability) as plain values and NOTHING else: never a name, an origin or a registry id. Each capability stays OFF unless `DAP_ENABLED_ACTIONS` lists it
 * (default deny).
 *
 * Trust: the executors take tenant and actor ONLY from `call.security` (the Gateway's trusted context), never from the parameters; the input schema is strict, so a
 * `tenantId`, `permissions` or `actorId` field is refused before an executor exists. They RE-VALIDATE with the pure enrollment validator before writing (the route
 * validated already, the Gateway only proves the SHAPE). Every result is a short fixed code; no thrown text, SQL or issue list leaves.
 */
import { defineAction, defineExecutor } from "@dap/contracts";
import type { ActionDefinition, ActionExecutor, ActionId, ExecutorId, PermissionId, ResourceRef } from "@dap/contracts";
import type { HostExtension } from "../compose.js";
import { MAINTAIN_PERMISSION, MEDIUM_JUSTIFICATION } from "../authoring/capabilities.js";
import { enabledInputSchema, isApplicationId, saveApplicationInputSchema, validateApplicationConfig } from "./applications.js";
import type { EnabledInput, SaveApplicationInput } from "./applications.js";
import type { ApplicationStore } from "./application-store.js";
import type { RegistryCatalog } from "./registries.js";

export const SAVE_APPLICATION_ACTION_ID = "saveStudioApplication";
export const ENABLE_APPLICATION_ACTION_ID = "setStudioApplicationEnabled";
export const SAVE_APPLICATION_EXECUTOR_ID = "ex.studio-save-application";
export const ENABLE_APPLICATION_EXECUTOR_ID = "ex.studio-set-application-enabled";
export const APPLICATION_RESOURCE_TYPE = "studioApplication";
export const APPLICATION_ACTION_IDS: readonly string[] = Object.freeze([SAVE_APPLICATION_ACTION_ID, ENABLE_APPLICATION_ACTION_ID]);

const resource = (params: { readonly applicationId: string }): ResourceRef | null => ({ type: APPLICATION_RESOURCE_TYPE, id: params.applicationId });

export const saveStudioApplication: ActionDefinition<SaveApplicationInput> = defineAction({
  id: SAVE_APPLICATION_ACTION_ID as ActionId,
  version: 1,
  description: "Enrols a Studio application for the caller's tenant, or updates its configuration: its name, origin, allowed origins, environment and registry. Maintainer only; the configuration is validated first.",
  inputSchema: saveApplicationInputSchema,
  risk: "MEDIUM",
  requiredPermission: MAINTAIN_PERMISSION as PermissionId,
  allowedPages: "any",
  confirmation: { kind: "not-required", justification: MEDIUM_JUSTIFICATION },
  changesState: true,
  audit: { params: [{ path: "/applicationId", mode: "plain" }] },
  resource,
  executorId: SAVE_APPLICATION_EXECUTOR_ID as ExecutorId,
});

export const setStudioApplicationEnabled: ActionDefinition<EnabledInput> = defineAction({
  id: ENABLE_APPLICATION_ACTION_ID as ActionId,
  version: 1,
  description: "Enables or disables an enrolled Studio application. A disabled application cannot be used to author or publish; published guides keep running. Maintainer only.",
  inputSchema: enabledInputSchema,
  risk: "MEDIUM",
  requiredPermission: MAINTAIN_PERMISSION as PermissionId,
  allowedPages: "any",
  confirmation: { kind: "not-required", justification: MEDIUM_JUSTIFICATION },
  changesState: true,
  audit: { params: [{ path: "/applicationId", mode: "plain" }, { path: "/enabled", mode: "plain" }] },
  resource,
  executorId: ENABLE_APPLICATION_EXECUTOR_ID as ExecutorId,
});

/** The failure codes of the executors (short, fixed). */
export type ApplicationFailureCode = "invalid_application" | "not_found" | "limit_reached" | "id_refused" | "store_unavailable";

/** The host's own record of what the executors received (never reachable from an AI session). */
export interface ApplicationTrustedHandle {
  /** The validated parameters of every call that reached an executor body, per action, newest last, bounded. */
  receivedCalls(actionId: string): readonly unknown[];
  /** How many times an executor body ran, per action or in total. */
  executorCalls(actionId?: string): number;
}

export interface ApplicationCapabilityDeps {
  readonly store: ApplicationStore;
  /** The host-trusted registry catalog whose keys an application may name. */
  readonly catalog: RegistryCatalog;
}

const MAX_RECORDED = 100;
const failure = (code: ApplicationFailureCode) => ({ status: "failure" as const, code });

export function createApplicationExecutors(deps: ApplicationCapabilityDeps): { readonly executors: readonly ActionExecutor[]; readonly trusted: ApplicationTrustedHandle } {
  const { store, catalog } = deps;
  const received = new Map<string, unknown[]>();
  let total = 0;
  const record = (actionId: string, params: unknown): void => {
    total += 1;
    const list = received.get(actionId) ?? [];
    list.push(structuredClone(params));
    if (list.length > MAX_RECORDED) list.shift();
    received.set(actionId, list);
  };

  const save = defineExecutor<SaveApplicationInput>({
    id: SAVE_APPLICATION_EXECUTOR_ID,
    run: async (call) => {
      record(SAVE_APPLICATION_ACTION_ID, call.params);
      // Tenant and actor come from the trusted context only.
      const scope = { tenantId: call.security.tenantId as string, actor: call.security.userId as string };
      const { applicationId, ...candidate } = call.params;
      if (!isApplicationId(applicationId)) return failure("id_refused");
      const checked = validateApplicationConfig(candidate, catalog.ids());
      if (!checked.ok) return failure("invalid_application");
      try {
        const outcome = await store.save(scope, applicationId, checked.config);
        switch (outcome) {
          case "created": case "updated": return { status: "success", affected: { type: APPLICATION_RESOURCE_TYPE, id: applicationId } };
          case "limit_reached": return failure("limit_reached");
          default: return failure("id_refused");
        }
      } catch { return failure("store_unavailable"); }
    },
  });

  const enable = defineExecutor<EnabledInput>({
    id: ENABLE_APPLICATION_EXECUTOR_ID,
    run: async (call) => {
      record(ENABLE_APPLICATION_ACTION_ID, call.params);
      const scope = { tenantId: call.security.tenantId as string, actor: call.security.userId as string };
      const { applicationId, enabled } = call.params;
      if (!isApplicationId(applicationId)) return failure("id_refused");
      try {
        const outcome = await store.setEnabled(scope, applicationId, enabled);
        if (outcome === "changed" || outcome === "unchanged") return { status: "success", affected: { type: APPLICATION_RESOURCE_TYPE, id: applicationId } };
        return failure(outcome === "not_found" ? "not_found" : "id_refused");
      } catch { return failure("store_unavailable"); }
    },
  });

  const trusted: ApplicationTrustedHandle = Object.freeze({
    receivedCalls: (actionId: string) => Object.freeze([...(received.get(actionId) ?? [])]),
    executorCalls: (actionId?: string) => (actionId === undefined ? total : (received.get(actionId)?.length ?? 0)),
  });
  return { executors: Object.freeze([save, enable]), trusted };
}

/** The host extension that adds both capabilities and their executors. Each is still OFF unless `DAP_ENABLED_ACTIONS` lists it (default deny). */
export function createApplicationExtension(deps: ApplicationCapabilityDeps): { readonly extension: HostExtension; readonly trusted: ApplicationTrustedHandle } {
  const { executors, trusted } = createApplicationExecutors(deps);
  return { extension: Object.freeze({ definitions: Object.freeze([saveStudioApplication, setStudioApplicationEnabled]), executors }), trusted };
}
