/**
 * The reference host's demo capabilities (T131), and the trusted host modules that execute them. Tiny on purpose.
 *
 *   demoLookup       SAFE    a read; no state change
 *   demoSaveNote     MEDIUM  changes state (writes to the host's in-memory effects log) and opts out of confirmation with a recorded
 *                            justification. SAFE and LOW capabilities cannot change state (registry rule R6), so this is the lowest class
 *                            that can; audit-before-execute applies to every execution anyway.
 *   demoPublishNote  HIGH    needs confirmation, so the Gateway answers REQUIRES_CONFIRMATION and its executor must NEVER run
 *
 * The executors are trusted host modules built with `defineExecutor` (they run only against a Gateway-minted grant). What they received
 * is recorded in a `TrustedHandle` that only the composition root's caller gets; it is not reachable from the AI-facing session.
 */
import { z } from "zod";
import { defineAction, defineExecutor } from "@dap/contracts";
import type { ActionDefinition, ActionExecutor, ActionId, AuthorizationContext, ExecutionCall, ExecutorId, PermissionId, ResourceRef } from "@dap/contracts";

const noteId = z.string().max(45).regex(/^note-[a-z0-9-]{1,40}$/);

export const demoLookup: ActionDefinition<{ readonly topic: string }> = defineAction({
  id: "demoLookup" as ActionId,
  version: 1,
  description: "Looks up a short topic. A read: it changes nothing.",
  inputSchema: z.strictObject({ topic: z.string().min(1).max(64) }),
  risk: "SAFE",
  requiredPermission: "perm.demo.lookup" as PermissionId,
  allowedPages: "any",
  confirmation: { kind: "not-required" },
  changesState: false,
  audit: { params: [{ path: "/topic", mode: "plain" }] },
  executorId: "ex.demo-lookup" as ExecutorId,
});

export const demoSaveNote: ActionDefinition<{ readonly noteId: string; readonly text: string }> = defineAction({
  id: "demoSaveNote" as ActionId,
  version: 1,
  description: "Saves a short note for the caller in the caller's own tenant.",
  inputSchema: z.strictObject({ noteId, text: z.string().min(1).max(500) }),
  risk: "MEDIUM",
  requiredPermission: "perm.demo.save-note" as PermissionId,
  allowedPages: "any",
  confirmation: { kind: "not-required", justification: "Demo notes are private to the caller, reversible, and never published." },
  changesState: true,
  audit: { params: [{ path: "/noteId", mode: "plain" }, { path: "/text", mode: "masked" }] },
  resource: (params): ResourceRef | null => ({ type: "note", id: params.noteId }),
  executorId: "ex.demo-save-note" as ExecutorId,
});

export const demoPublishNote: ActionDefinition<{ readonly noteId: string }> = defineAction({
  id: "demoPublishNote" as ActionId,
  version: 1,
  description: "Publishes a note to everyone in the tenant.",
  inputSchema: z.strictObject({ noteId }),
  risk: "HIGH",
  requiredPermission: "perm.demo.publish-note" as PermissionId,
  allowedPages: "any",
  confirmation: { kind: "required" },
  changesState: true,
  audit: { params: [{ path: "/noteId", mode: "plain" }] },
  resource: (params): ResourceRef | null => ({ type: "note", id: params.noteId }),
  // Built ONLY from the trusted resolved resource; the proposal's parameters are never read.
  describeConsequence: ({ resource }) => ({
    title: resource ? `Publish "${resource.displayName}"` : "Publish a note",
    effects: ["The note becomes visible to everyone in the tenant."],
    irreversible: false,
  }),
  executorId: "ex.demo-publish-note" as ExecutorId,
});

export const DEMO_DEFINITIONS = [demoLookup, demoSaveNote, demoPublishNote] as const;
export const DEMO_ACTION_IDS: readonly string[] = DEMO_DEFINITIONS.map((definition) => definition.id as string);

/** What one executor body received (a snapshot taken when it ran). */
export interface ReceivedCall {
  readonly actionId: string;
  readonly requestId: string;
  readonly paramsDigest: string;
  /** The validated parameters as plain data. */
  readonly params: unknown;
  /** Whether the object the executor was handed was frozen all the way down. */
  readonly paramsDeepFrozen: boolean;
  /** The context the Gateway handed over: the requesting user's own trusted identity. */
  readonly security: AuthorizationContext;
  readonly resource: { readonly type: string; readonly id: string; readonly tenantId: string } | null;
}

/** One state change made by a state-changing executor (the host's "database"). */
export interface Effect {
  readonly kind: "note-saved" | "note-published";
  readonly tenantId: string;
  readonly userId: string;
  readonly noteId: string;
}

/** The host's own view of its executors. Handed to the composition root's caller; never to the AI layer. */
export interface TrustedHandle {
  /** Calls that reached an executor body: one action's, or all. */
  executorCalls(actionId?: string): number;
  receivedCalls(actionId: string): readonly ReceivedCall[];
  effects(): readonly Effect[];
}

function deepFrozen(value: unknown): boolean {
  if (value === null || typeof value !== "object") return true;
  return Object.isFrozen(value) && Object.values(value).every(deepFrozen);
}

export function createDemoExecutors(): { readonly executors: readonly ActionExecutor[]; readonly trusted: TrustedHandle } {
  const received = new Map<string, ReceivedCall[]>();
  const effects: Effect[] = [];
  const record = (call: ExecutionCall<unknown>): void => {
    const entry: ReceivedCall = Object.freeze({
      actionId: call.actionId as string, requestId: call.requestId as string, paramsDigest: call.paramsDigest as string,
      params: structuredClone(call.params), paramsDeepFrozen: deepFrozen(call.params), security: call.security,
      resource: call.resource === null ? null : Object.freeze({ type: call.resource.ref.type, id: call.resource.ref.id, tenantId: call.resource.tenantId as string }),
    });
    received.set(entry.actionId, [...(received.get(entry.actionId) ?? []), entry]);
  };
  const executors: ActionExecutor[] = [
    defineExecutor<{ readonly topic: string }>({
      id: "ex.demo-lookup",
      run: async (call) => { record(call); return { status: "success", value: { topic: call.params.topic, servedTo: call.security.userId } }; },
    }),
    defineExecutor<{ readonly noteId: string; readonly text: string }>({
      id: "ex.demo-save-note",
      run: async (call) => {
        record(call);
        effects.push(Object.freeze({ kind: "note-saved" as const, tenantId: call.security.tenantId, userId: call.security.userId, noteId: call.params.noteId }));
        return { status: "success", affected: { type: "note", id: call.params.noteId } };
      },
    }),
    defineExecutor<{ readonly noteId: string }>({
      id: "ex.demo-publish-note",
      run: async (call) => {
        record(call);
        effects.push(Object.freeze({ kind: "note-published" as const, tenantId: call.security.tenantId, userId: call.security.userId, noteId: call.params.noteId }));
        return { status: "success", affected: { type: "note", id: call.params.noteId } };
      },
    }),
  ];
  const trusted: TrustedHandle = Object.freeze({
    executorCalls: (actionId?: string) => (actionId === undefined ? [...received.values()].reduce((total, calls) => total + calls.length, 0) : (received.get(actionId)?.length ?? 0)),
    receivedCalls: (actionId: string) => Object.freeze([...(received.get(actionId) ?? [])]),
    effects: () => Object.freeze([...effects]),
  });
  return { executors, trusted };
}
