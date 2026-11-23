/**
 * The two Studio target capabilities (Studio V1B, D8): the ONLY way a target of a Studio-managed registry is created or enabled/disabled. Ordinary Feature 001 capabilities, registered exactly like
 * the application ones: a request goes through the Gateway (strict schema, permission, risk, rate/replay, durable audit) and only then does a trusted executor run.
 *
 *   registerStudioTarget    { applicationId, targetId, route, page, elementRole, label, description, operations, privacy }   create one target (and its route, when the page has none)
 *   setStudioTargetStatus   { applicationId, targetId, status: active|disabled }                                            disable (always) or re-enable a target; there is no delete and no edit
 *
 * Both are MEDIUM, `changesState`, permission EXACTLY `perm.walkthrough.maintain`, `allowedPages: "any"`, a `studioApplication` resource (rule R9, the application the target belongs to) and a
 * written justification in place of a confirmation. Audit records `/applicationId` and `/targetId` (plain ids) and, on the second, the closed `/status` value: never a label, a description, a
 * page or a route. Each stays OFF unless `DAP_ENABLED_ACTIONS` lists it (default deny). `elementRole` is the registry role: the name `role` is a reserved Gateway parameter name.
 *
 * THE EXECUTOR IS THE PERSISTENCE AUTHORITY: it takes tenant and actor only from `call.security`, re-validates EVERYTHING structural (the application exists in the caller's tenant, is enabled and
 * Studio-managed; the id, role, operations, privacy, texts, route and page grammars; the page/route pairing; the caps; a duplicate id) with `validateTargetRegistration` and the store, and answers
 * a short fixed code. What it does NOT decide is whether a live element may become a target (a fresh ref, the page's own marker, the privacy facts of the live element): the browser session, the only
 * caller, proves that before it asks. There is no HTTP route that accepts a raw target.
 */
import { AsyncLocalStorage } from "node:async_hooks";
import { defineAction, defineExecutor } from "@dap/contracts";
import type { ActionDefinition, ActionExecutor, ActionId, ExecutionCall, ExecutorId, PermissionId, ResourceRef } from "@dap/contracts";
import type { HostExtension } from "../compose.js";
import { MAINTAIN_PERMISSION, MEDIUM_JUSTIFICATION } from "../authoring/capabilities.js";
import { APPLICATION_RESOURCE_TYPE } from "./application-capabilities.js";
import { isApplicationId } from "./applications.js";
import { registerTargetInputSchema, targetStatusInputSchema, validateTargetRegistration } from "./registry-targets.js";
import type { RegisterTargetInput, TargetStatusInput } from "./registry-targets.js";
import type { RegisterOutcome, TargetStore } from "./target-store.js";

export const REGISTER_TARGET_ACTION_ID = "registerStudioTarget";
export const TARGET_STATUS_ACTION_ID = "setStudioTargetStatus";
export const REGISTER_TARGET_EXECUTOR_ID = "ex.studio-register-target";
export const TARGET_STATUS_EXECUTOR_ID = "ex.studio-set-target-status";
export const TARGET_ACTION_IDS: readonly string[] = Object.freeze([REGISTER_TARGET_ACTION_ID, TARGET_STATUS_ACTION_ID]);

const resource = (params: { readonly applicationId: string }): ResourceRef | null => ({ type: APPLICATION_RESOURCE_TYPE, id: params.applicationId });

export const registerStudioTarget: ActionDefinition<RegisterTargetInput> = defineAction({
  id: REGISTER_TARGET_ACTION_ID as ActionId,
  version: 1,
  description: "Registers one trusted target (a control of the application's page) in a Studio-managed application's registry. Maintainer only; every value is validated first and a registered target can never be edited or deleted.",
  inputSchema: registerTargetInputSchema,
  risk: "MEDIUM",
  requiredPermission: MAINTAIN_PERMISSION as PermissionId,
  allowedPages: "any",
  confirmation: { kind: "not-required", justification: MEDIUM_JUSTIFICATION },
  changesState: true,
  audit: { params: [{ path: "/applicationId", mode: "plain" }, { path: "/targetId", mode: "plain" }] },
  resource,
  executorId: REGISTER_TARGET_EXECUTOR_ID as ExecutorId,
});

export const setStudioTargetStatus: ActionDefinition<TargetStatusInput> = defineAction({
  id: TARGET_STATUS_ACTION_ID as ActionId,
  version: 1,
  description: "Disables or re-enables a registered target of a Studio-managed application. A disabled target is no longer part of the registry guides are validated against. Maintainer only.",
  inputSchema: targetStatusInputSchema,
  risk: "MEDIUM",
  requiredPermission: MAINTAIN_PERMISSION as PermissionId,
  allowedPages: "any",
  confirmation: { kind: "not-required", justification: MEDIUM_JUSTIFICATION },
  changesState: true,
  audit: { params: [{ path: "/applicationId", mode: "plain" }, { path: "/targetId", mode: "plain" }, { path: "/status", mode: "plain" }] },
  resource,
  executorId: TARGET_STATUS_EXECUTOR_ID as ExecutorId,
});

/** The failure codes of the executors (short, fixed). */
export type TargetFailureCode =
  | "invalid_target" | "page_refused" | "application_not_found" | "application_disabled" | "registry_not_managed" | "target_exists" | "route_mismatch" | "registry_full"
  | "target_not_found" | "id_refused" | "store_unavailable";

/** The host's own record of what the executors received (never reachable from an AI session). */
export interface TargetTrustedHandle {
  receivedCalls(actionId: string): readonly unknown[];
  executorCalls(actionId?: string): number;
}
export interface TargetCapabilityDeps { readonly targets: TargetStore }

const MAX_RECORDED = 100;
const failure = (code: TargetFailureCode) => ({ status: "failure" as const, code });

/** What an executor body needs of a call: the validated params and the TRUSTED security context (exported so the bodies can be tested without a Gateway grant). */
export type TargetCall<P> = Pick<ExecutionCall<P>, "params" | "security">;

type RegistrationRoute = Extract<RegisterOutcome, { kind: "created" }>["route"];
interface RegistrationReceipt {
  readonly tenantId: string;
  readonly applicationId: string;
  readonly targetId: string;
  route?: RegistrationRoute;
}
// Planner feedback stays closed. Only the host request awaiting this specific write
// can read its transaction's receipt, and the context ends with that submission.
const registrationReceipt = new AsyncLocalStorage<RegistrationReceipt>();
export async function withRegistrationReceipt<T>(scope: Omit<RegistrationReceipt, "route">, submit: () => Promise<T>) {
  const receipt: RegistrationReceipt = { ...scope };
  const result = await registrationReceipt.run(receipt, submit);
  return { result, route: receipt.route };
}

export async function runRegisterTarget(targets: TargetStore, call: TargetCall<RegisterTargetInput>) {
  // Tenant and actor come from the trusted context only.
  const scope = { tenantId: call.security.tenantId as string, actor: call.security.userId as string };
  const { applicationId, ...candidate } = call.params;
  if (!isApplicationId(applicationId)) return failure("id_refused");
  const checked = validateTargetRegistration(candidate);
  if (!checked.ok) return failure("invalid_target");
  const receipt = registrationReceipt.getStore();
  try {
    const outcome = await targets.register(scope, applicationId, checked.value);
    if (outcome.kind === "created") {
      if (receipt?.tenantId === scope.tenantId && receipt.applicationId === applicationId && receipt.targetId === checked.value.targetId) receipt.route = outcome.route;
      return { status: "success" as const, affected: { type: APPLICATION_RESOURCE_TYPE, id: applicationId } };
    }
    return failure(outcome.kind);
  } catch { return failure("store_unavailable"); }
}

export async function runSetTargetStatus(targets: TargetStore, call: TargetCall<TargetStatusInput>) {
  const scope = { tenantId: call.security.tenantId as string, actor: call.security.userId as string };
  const { applicationId, targetId } = call.params;
  if (!isApplicationId(applicationId)) return failure("id_refused");
  try {
    const outcome = await targets.setStatus(scope, applicationId, targetId, call.params.status);
    if (outcome === "changed" || outcome === "unchanged") return { status: "success" as const, affected: { type: APPLICATION_RESOURCE_TYPE, id: applicationId } };
    return failure(outcome);
  } catch { return failure("store_unavailable"); }
}

export function createTargetExecutors(deps: TargetCapabilityDeps): { readonly executors: readonly ActionExecutor[]; readonly trusted: TargetTrustedHandle } {
  const { targets } = deps;
  const received = new Map<string, unknown[]>();
  let total = 0;
  const record = (actionId: string, params: unknown): void => {
    total += 1;
    const list = received.get(actionId) ?? [];
    list.push(structuredClone(params));
    if (list.length > MAX_RECORDED) list.shift();
    received.set(actionId, list);
  };

  const register = defineExecutor<RegisterTargetInput>({
    id: REGISTER_TARGET_EXECUTOR_ID,
    run: async (call) => {
      record(REGISTER_TARGET_ACTION_ID, call.params);
      return runRegisterTarget(targets, call);
    },
  });

  const status = defineExecutor<TargetStatusInput>({
    id: TARGET_STATUS_EXECUTOR_ID,
    run: async (call) => {
      record(TARGET_STATUS_ACTION_ID, call.params);
      return runSetTargetStatus(targets, call);
    },
  });

  const trusted: TargetTrustedHandle = Object.freeze({
    receivedCalls: (actionId: string) => Object.freeze([...(received.get(actionId) ?? [])]),
    executorCalls: (actionId?: string) => (actionId === undefined ? total : (received.get(actionId)?.length ?? 0)),
  });
  return { executors: Object.freeze([register, status]), trusted };
}

/** The host extension that adds both capabilities and their executors. Each is still OFF unless `DAP_ENABLED_ACTIONS` lists it (default deny). */
export function createTargetExtension(deps: TargetCapabilityDeps): { readonly extension: HostExtension; readonly trusted: TargetTrustedHandle } {
  const { executors, trusted } = createTargetExecutors(deps);
  return { extension: Object.freeze({ definitions: Object.freeze([registerStudioTarget, setStudioTargetStatus]), executors }), trusted };
}
