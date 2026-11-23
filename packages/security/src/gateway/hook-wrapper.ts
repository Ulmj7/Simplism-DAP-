import { z } from "zod";
import type { AuthenticatedPrincipal, IsoInstant, PageId, ResolvedResource } from "@dap/contracts";
import { snapshotAnswer } from "./answer-snapshot.js";
import { assertTimeout, nativeTimer, underDeadline, type HookTimer } from "./deadline.js";

export type HookResult<T> = Readonly<{ ok: true; value: T }> | Readonly<{ ok: false; reason: "denied" | "dependency_failure" }>;
export type { HookTimer } from "./deadline.js";
export interface HookOptions { readonly hookTimeoutMs?: number; readonly timer?: HookTimer }
interface HookAnswers {
  boolean: true;
  authentication: AuthenticatedPrincipal;
  resource: ResolvedResource;
  page: PageId;
  /** A host clock reading: a timezone-qualified ISO instant. */
  instant: IsoInstant;
  void: undefined;
  /** A policy store narrows access: true denies; only the literal false passes this hook. */
  tenantPolicy: false;
}
export type HookKind = keyof HookAnswers;

const text = z.string().min(1);
const schemas = {
  boolean: z.literal(true),
  authentication: z.strictObject({ userId: text, tenantId: z.uuid(), sessionId: text, authenticatedAt: z.iso.datetime({ offset: true }), validUntil: z.iso.datetime({ offset: true }) }),
  resource: z.strictObject({ ref: z.strictObject({ type: text, id: text }), tenantId: z.uuid(), displayName: text }),
  page: text,
  instant: z.iso.datetime({ offset: true }),
  void: z.undefined(),
  tenantPolicy: z.literal(false),
};
const failure = Object.freeze({ ok: false, reason: "dependency_failure" } as const);
const denied = Object.freeze({ ok: false, reason: "denied" } as const);

/** Protocol boundary for a bound host method; tenant equality and principal expiry are caller checks. */
export function wrapHook<K extends HookKind, A extends readonly unknown[]>(
  invoke: (...args: A) => unknown,
  kind: K,
  { hookTimeoutMs = 2000, timer = nativeTimer }: HookOptions = {},
): (...args: A) => Promise<HookResult<HookAnswers[K]>> {
  assertTimeout(hookTimeoutMs, "hook");
  const verdict = (answer: unknown, within: () => boolean): HookResult<HookAnswers[K]> => {
    const captured = snapshotAnswer(answer);
    if (!within()) return failure;
    const negative = (kind === "boolean" && captured === false) || (kind === "tenantPolicy" && captured === true) ||
      (["authentication", "resource", "page"].includes(kind) && captured === null);
    if (negative) return denied;
    if (!Object.hasOwn(schemas, kind) || !schemas[kind].safeParse(captured).success) return failure;
    return Object.freeze({ ok: true, value: captured as HookAnswers[K] });
  };
  return (...args: A) => underDeadline<HookResult<HookAnswers[K]>>(
    () => {
      const raw = invoke(...args);
      // Promise<void> resolves to undefined; a bare undefined means the host omitted its operation.
      if (kind === "void" && raw === undefined) throw new TypeError("Missing host operation");
      return raw;
    },
    verdict, () => failure, hookTimeoutMs, timer,
  );
}
