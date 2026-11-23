/** T131: the demo ports answer from the trusted context and the host's own table, never from what a proposal says. */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { AuthorizationContext, Clock, IsoInstant, PermissionId, PlannerRunMeta } from "@dap/contracts";
import { createSecurityContextFactory } from "@dap/security";
import { createDevAuthentication, parseDevSessions } from "./dev-auth/index.js";
import { createPageContextProvider, createPermissionChecker, createResourceAuthorizer } from "./host-ports.js";

const TENANT = randomUUID();
const FUTURE = new Date(Date.now() + 3_600_000).toISOString();
const clock: Clock = { now: () => new Date().toISOString() as IsoInstant };
const sessions = parseDevSessions(JSON.stringify([
  { token: `tok-${randomUUID()}`, userId: "alice", tenantId: TENANT, sessionId: "s-alice", validUntil: FUTURE, permissions: ["perm.demo.save-note"] },
  { token: `tok-${randomUUID()}`, userId: "bob", tenantId: TENANT, sessionId: "s-bob", validUntil: FUTURE },
]));
const contextOf = async (index: number): Promise<AuthorizationContext> => {
  const context = await createSecurityContextFactory({ authentication: createDevAuthentication(sessions, clock), clock }).establish(sessions[index]!.token);
  if (context === null) throw new Error("no context");
  return context;
};
const SAVE = "perm.demo.save-note" as PermissionId;

describe("the permission checker", () => {
  it("answers only for the permissions the session's own table entry lists", async () => {
    const checker = createPermissionChecker(sessions);
    const [alice, bob] = [await contextOf(0), await contextOf(1)];
    expect(await checker.has(alice, SAVE)).toBe(true);
    expect(await checker.has(alice, "perm.demo.publish-note" as PermissionId)).toBe(false);
    expect(await checker.has(bob, SAVE)).toBe(false);
    expect(await checker.has(alice, "__proto__" as PermissionId)).toBe(false);
  });
});

describe("the resource authorizer", () => {
  it("resolves a note only inside the caller's own tenant, taken from the context, and only for a session holding the permission", async () => {
    const resources = createResourceAuthorizer(sessions);
    const [alice, bob] = [await contextOf(0), await contextOf(1)];
    expect(await resources.resolve(alice, { type: "note", id: "note-1" }, SAVE)).toEqual({ ref: { type: "note", id: "note-1" }, tenantId: TENANT, displayName: "Note note-1" });
    expect(await resources.resolve(bob, { type: "note", id: "note-1" }, SAVE), "no permission, no resource").toBeNull();
    expect(await resources.resolve(alice, { type: "document", id: "note-1" }, SAVE), "another resource type").toBeNull();
  });
});

describe("the resource authorizer: walkthroughs (Feature 004) and the unchanged note rule", () => {
  const MAINTAIN = "perm.walkthrough.maintain" as PermissionId;
  const withMaintain = parseDevSessions(JSON.stringify([
    { token: `tok-${randomUUID()}`, userId: "maya", tenantId: TENANT, sessionId: "s-maya", validUntil: FUTURE, permissions: ["perm.walkthrough.maintain", "perm.demo.save-note"] },
    { token: `tok-${randomUUID()}`, userId: "ula", tenantId: TENANT, sessionId: "s-ula", validUntil: FUTURE, permissions: [] },
  ]));
  const ctx = async (index: number): Promise<AuthorizationContext> => {
    const context = await createSecurityContextFactory({ authentication: createDevAuthentication(withMaintain, clock), clock }).establish(withMaintain[index]!.token);
    if (context === null) throw new Error("no context");
    return context;
  };
  const ID = "wt-0123456789ab";
  it("a walkthrough resolves only inside the caller's OWN tenant (from the context) and only for a session holding the permission", async () => {
    const resources = createResourceAuthorizer(withMaintain);
    const [maya, ula] = [await ctx(0), await ctx(1)];
    expect(await resources.resolve(maya, { type: "walkthrough", id: ID }, MAINTAIN)).toEqual({ ref: { type: "walkthrough", id: ID }, tenantId: TENANT, displayName: `Walkthrough ${ID}` });
    expect(await resources.resolve(ula, { type: "walkthrough", id: ID }, MAINTAIN), "no permission, no resource").toBeNull();
    expect(await resources.resolve(maya, { type: "walkthrough", id: ID }, "perm.demo.lookup" as PermissionId), "a permission the session lacks").toBeNull();
  });
  it("a walkthrough reference that is not a well-formed authored id (a built-in id, the preview id, junk) does not resolve", async () => {
    const resources = createResourceAuthorizer(withMaintain);
    const maya = await ctx(0);
    for (const id of ["profileUpdate", "wt-preview", "wt-ABCDEF012345", "", "__proto__", "../x"]) expect(await resources.resolve(maya, { type: "walkthrough", id }, MAINTAIN), id).toBeNull();
  });
  it("a Studio application resolves by the same rule: own tenant, the permission held, a well-formed application id only (a walkthrough id is not an application id)", async () => {
    const resources = createResourceAuthorizer(withMaintain);
    const [maya, ula] = [await ctx(0), await ctx(1)];
    const APP = "app-0123456789ab";
    expect(await resources.resolve(maya, { type: "studioApplication", id: APP }, MAINTAIN)).toEqual({ ref: { type: "studioApplication", id: APP }, tenantId: TENANT, displayName: `Application ${APP}` });
    expect(await resources.resolve(ula, { type: "studioApplication", id: APP }, MAINTAIN), "no permission, no resource").toBeNull();
    expect(await resources.resolve(maya, { type: "studioApplication", id: APP }, "perm.demo.lookup" as PermissionId)).toBeNull();
    for (const id of [ID, "app-0123456789AB", "app-0123456789a", "", "__proto__", "../x"]) expect(await resources.resolve(maya, { type: "studioApplication", id }, MAINTAIN), id).toBeNull();
    expect(await resources.resolve(maya, { type: "walkthrough", id: APP }, MAINTAIN), "an application id is not an authored walkthrough id").toBeNull();
  });
  it("the NOTE rule is byte for byte what it was: same answer, same tenant source, same permission rule, other types still null", async () => {
    const resources = createResourceAuthorizer(withMaintain);
    const [maya, ula] = [await ctx(0), await ctx(1)];
    expect(await resources.resolve(maya, { type: "note", id: "note-1" }, SAVE)).toEqual({ ref: { type: "note", id: "note-1" }, tenantId: TENANT, displayName: "Note note-1" });
    expect(await resources.resolve(maya, { type: "note", id: "anything at all" }, SAVE)).toEqual({ ref: { type: "note", id: "anything at all" }, tenantId: TENANT, displayName: "Note anything at all" });
    expect(await resources.resolve(ula, { type: "note", id: "note-1" }, SAVE)).toBeNull();
    expect(await resources.resolve(maya, { type: "note", id: "note-1" }, MAINTAIN), "a note needs the permission the capability names, here one the session holds").not.toBeNull();
    expect(await resources.resolve(maya, { type: "document", id: "note-1" }, SAVE)).toBeNull();
    expect(await resources.resolve(maya, { type: "Note", id: "note-1" }, SAVE), "the type is matched exactly").toBeNull();
    expect(await resources.resolve(maya, { type: "Walkthrough", id: ID }, MAINTAIN), "the type is matched exactly").toBeNull();
  });
});

describe("the page provider", () => {
  it("reports no page: the demo has no page model, so there is nothing for a proposal to spoof", async () => {
    const run: PlannerRunMeta = { aiSessionId: "s", turnId: "t", model: "m", depth: 0, turnStartedAt: new Date().toISOString() as IsoInstant };
    expect(await createPageContextProvider().currentPage(await contextOf(0), run)).toBeNull();
  });
});
