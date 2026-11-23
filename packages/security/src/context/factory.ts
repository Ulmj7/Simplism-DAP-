/**
 * @dap/security: context/factory.ts
 *
 * T076 / FR-021, FR-022. `createSecurityContextFactory({ authentication, clock })` turns the host's answer about who
 * the caller is into the only thing the Gateway will accept as an identity: a context minted through
 * `@dap/contracts/mint`. Identity comes from nowhere else; the context holds NO permissions (they are checked live).
 *
 * Fail-closed: `establish` resolves to null (the hook wrapper contains every host fault, so it never throws), for an unauthenticated caller, a principal that is not
 * exactly `{ userId, tenantId, sessionId, authenticatedAt, validUntil }` of the right kinds (tenantId a lowercase
 * UUID per research D8, the instants timezone-qualified ISO 8601), a session that has expired or has not begun,
 * a host port that throws, hangs, rejects or answers the wrong shape, and a clock that cannot tell the time.
 */
import { z } from "zod";
import type { AuthenticationPort, Clock, SecurityContextFactory } from "@dap/contracts";
import { mintAuthorizationContext } from "@dap/contracts/mint";
import { wrapHook, type HookOptions } from "../gateway/hook-wrapper.js";

/**
 * What this factory adds to the hook wrapper's own principal check (`wrapHook(..., "authentication")` has already proved the
 * answer is exactly `{ userId, tenantId, sessionId, authenticatedAt, validUntil }` of non-empty text, a UUID tenant and ISO
 * instants with a zone): printable identifiers of a sane length, and a tenant in its one canonical spelling.
 * Identifiers end up in audit records and log lines, so no control, format, surrogate, private-use or unassigned characters.
 */
// Not just "no controls": format characters (bidi overrides, zero-width, joiners), lone surrogates, private-use and
// unassigned code points, and every space but the plain one are refused too, and so is a leading, trailing or
// only-space id. Otherwise `alice` and `alice\u200b` are two users who read as one in every audit record and log line.
const identifier = z.string().max(256).regex(/^[^\p{C}\p{Z}](?:[^\p{C}\p{Z}]| )*(?<! )$/u);
// Lowercase, so one tenant has one spelling (tenant equality is a string comparison); the nil UUID is a "no tenant" sentinel, not a tenant.
const canonicalTenant = z.string().refine((value) => value === value.toLowerCase() && value !== "00000000-0000-0000-0000-000000000000");
const principalExtras = z.object({ userId: identifier, tenantId: canonicalTenant, sessionId: identifier });

export function createSecurityContextFactory<TEvidence = unknown>(
  { authentication, clock }: { readonly authentication: AuthenticationPort<TEvidence>; readonly clock: Clock },
  options: HookOptions = {},
): SecurityContextFactory<TEvidence> {
  // The ports are read once, here: a host that swaps its methods later cannot change what establish() calls.
  const authenticate: unknown = authentication?.authenticate;
  const readClock: unknown = clock?.now;
  if (typeof authenticate !== "function" || typeof readClock !== "function") throw new TypeError("Missing security context dependency");
  const who = wrapHook((evidence: TEvidence) => Reflect.apply(authenticate, authentication, [evidence]), "authentication", options);
  const now = wrapHook(() => Reflect.apply(readClock, clock, []), "instant", options);
  return Object.freeze({
    establish: Object.freeze(async (evidence: TEvidence) => {
      const answer = await who(evidence);
      if (!answer.ok || !principalExtras.safeParse(answer.value).success) return null;
      const reading = await now();
      if (!reading.ok) return null;
      // Every instant here passed an ISO 8601 check with a zone, so each parses to a finite number.
      const present = Date.parse(reading.value);
      const began = Date.parse(answer.value.authenticatedAt);
      const until = Date.parse(answer.value.validUntil);
      // Not begun yet, or already over (which also rules out a session that ends before it began).
      if (began > present || until <= present) return null;
      return mintAuthorizationContext(answer.value);
    }),
  });
}
