/** Studio V1B without a database: the two target capabilities against the Feature 001 registry rules and the extension shape. The Gateway and executor proof is tests/integration/studio-registry.test.ts. */
import { describe, expect, it } from "vitest";
import { buildRegistry, inspectInputSchema } from "@dap/security";
import { DEMO_DEFINITIONS } from "../capabilities.js";
import { composeReferenceHost } from "../compose.js";
import { createAuthoringExtension, MAINTAIN_PERMISSION, MEDIUM_JUSTIFICATION } from "../authoring/capabilities.js";
import type { WalkthroughStore } from "../authoring/store.js";
import { createApplicationExtension } from "./application-capabilities.js";
import { FakeApplicationStore } from "./fake-application-store.js";
import { FakeTargetStore } from "./fake-target-store.js";
import { createRegistryCatalog } from "./registries.js";
import {
  REGISTER_TARGET_ACTION_ID, REGISTER_TARGET_EXECUTOR_ID, TARGET_ACTION_IDS, TARGET_STATUS_ACTION_ID, TARGET_STATUS_EXECUTOR_ID, createTargetExtension, registerStudioTarget, setStudioTargetStatus,
} from "./target-capabilities.js";

const APP = "app-0123456789ab";
const TENANT = "1111aaaa-2222-4333-8444-5555bbbb5555";
const NO_STORE: WalkthroughStore = { recordEvent: async () => true, summary: async () => [], list: async () => [], get: async () => null, saveDraft: async () => "created", setStatus: async () => "changed", listPublished: async () => [] };
const targets = () => new FakeTargetStore(new FakeApplicationStore());
const input = { applicationId: APP, targetId: "orders.submit", route: "orders", page: "/#/orders", elementRole: "button", label: "Submit", description: "Submits the order", operations: ["highlight", "click"], privacy: "public" };

describe("the two capabilities", () => {
  it("are MEDIUM, state-changing, maintainer-only (exactly perm.walkthrough.maintain), any page, with the written justification instead of a confirmation", () => {
    for (const capability of [registerStudioTarget, setStudioTargetStatus]) {
      expect(capability).toMatchObject({ risk: "MEDIUM", changesState: true, requiredPermission: "perm.walkthrough.maintain", allowedPages: "any", version: 1 });
      expect(capability.confirmation).toEqual({ kind: "not-required", justification: MEDIUM_JUSTIFICATION });
    }
    expect(registerStudioTarget.id).toBe("registerStudioTarget");
    expect(setStudioTargetStatus.id).toBe("setStudioTargetStatus");
    expect(TARGET_ACTION_IDS).toEqual(["registerStudioTarget", "setStudioTargetStatus"]);
    expect([REGISTER_TARGET_ACTION_ID, TARGET_STATUS_ACTION_ID]).toEqual(["registerStudioTarget", "setStudioTargetStatus"]);
  });
  it("audit ids and flags only: /applicationId and /targetId (and the closed /status); never a label, description, page, route or operations", () => {
    expect(registerStudioTarget.audit.params).toEqual([{ path: "/applicationId", mode: "plain" }, { path: "/targetId", mode: "plain" }]);
    expect(setStudioTargetStatus.audit.params).toEqual([{ path: "/applicationId", mode: "plain" }, { path: "/targetId", mode: "plain" }, { path: "/status", mode: "plain" }]);
    for (const capability of [registerStudioTarget, setStudioTargetStatus]) for (const param of capability.audit.params) expect(param.path).not.toMatch(/label|description|page|route|operations|role|privacy/i);
  });
  it("declare the application's studioApplication resource (rule R9), built from the application id only", () => {
    expect(registerStudioTarget.resource?.(input as never)).toEqual({ type: "studioApplication", id: APP });
    expect(setStudioTargetStatus.resource?.({ applicationId: APP, targetId: "a.b", status: "disabled" })).toEqual({ type: "studioApplication", id: APP });
  });
  it("use distinct executors, one per capability", () => {
    expect([registerStudioTarget.executorId, setStudioTargetStatus.executorId]).toEqual([REGISTER_TARGET_EXECUTOR_ID, TARGET_STATUS_EXECUTOR_ID]);
    expect(REGISTER_TARGET_EXECUTOR_ID).not.toBe(TARGET_STATUS_EXECUTOR_ID);
  });
  it("satisfy the Feature 001 registry rules next to every other capability family: strict, bounded, and NO reserved parameter name (role is reserved, so the field is elementRole)", () => {
    const authoring = createAuthoringExtension({ store: NO_STORE, applications: new FakeApplicationStore(), catalog: createRegistryCatalog() });
    const applications = createApplicationExtension({ store: new FakeApplicationStore(), catalog: createRegistryCatalog() });
    expect(() => buildRegistry([...DEMO_DEFINITIONS, ...authoring.extension.definitions, ...applications.extension.definitions, registerStudioTarget, setStudioTargetStatus])).not.toThrow();
    for (const capability of [registerStudioTarget, setStudioTargetStatus]) expect(inspectInputSchema(capability.inputSchema).issues, capability.id).toEqual([]);
    expect(Object.keys((registerStudioTarget.inputSchema as unknown as { shape: Record<string, unknown> }).shape)).not.toContain("role");
  });
});

describe("the extension", () => {
  it("is exactly { definitions, executors }, frozen, with a trusted handle that has run nothing", () => {
    const { extension, trusted } = createTargetExtension({ targets: targets() });
    expect(Object.keys(extension).sort()).toEqual(["definitions", "executors"]);
    expect(extension.definitions.map((d) => d.id)).toEqual(["registerStudioTarget", "setStudioTargetStatus"]);
    expect(extension.executors.map((e) => e.id)).toEqual([REGISTER_TARGET_EXECUTOR_ID, TARGET_STATUS_EXECUTOR_ID]);
    expect(Object.isFrozen(extension)).toBe(true);
    expect(trusted.executorCalls()).toBe(0);
    expect(trusted.receivedCalls("registerStudioTarget")).toEqual([]);
  });
  it("composes with the other extensions, and is OFF unless DAP_ENABLED_ACTIONS lists it (default deny)", async () => {
    const env = { NODE_ENV: "test", DAP_ALLOW_DEV_AUTH: "1", DAP_DATABASE_URL: "postgresql://dap_app:pw@127.0.0.1:1/never_connected",
      DEV_SESSIONS: JSON.stringify([{ token: "tok-0123456789abcdef", userId: "alice", tenantId: TENANT, sessionId: "s-alice", validUntil: new Date(Date.now() + 3_600_000).toISOString(), permissions: [MAINTAIN_PERMISSION] }]) };
    const extensions = [createAuthoringExtension({ store: NO_STORE, applications: new FakeApplicationStore(), catalog: createRegistryCatalog() }).extension,
      createApplicationExtension({ store: new FakeApplicationStore(), catalog: createRegistryCatalog() }).extension, createTargetExtension({ targets: targets() }).extension];
    for (const enabled of ["demoLookup", "demoLookup,registerStudioTarget,setStudioTargetStatus", "demoLookup,saveStudioApplication,registerStudioTarget"]) {
      const composed = await composeReferenceHost({ ...env, DAP_ENABLED_ACTIONS: enabled }, { extensions });
      await composed.host.close();
    }
    await expect(composeReferenceHost({ ...env, DAP_ENABLED_ACTIONS: "demoLookup,registerStudioTarget" }, { extensions: [] })).rejects.toThrow(/unknown or empty capability id/);
  });
  it("a second target extension collides", async () => {
    const env = { NODE_ENV: "test", DAP_ALLOW_DEV_AUTH: "1", DAP_DATABASE_URL: "postgresql://dap_app:pw@127.0.0.1:1/never_connected", DAP_ENABLED_ACTIONS: "demoLookup",
      DEV_SESSIONS: JSON.stringify([{ token: "tok-0123456789abcdef", userId: "alice", tenantId: TENANT, sessionId: "s-alice", validUntil: new Date(Date.now() + 3_600_000).toISOString() }]) };
    await expect(composeReferenceHost(env, { extensions: [createTargetExtension({ targets: targets() }).extension, createTargetExtension({ targets: targets() }).extension] })).rejects.toThrow(/collides/);
  });
});

describe("the strict inputs", () => {
  const register = (value: unknown) => registerStudioTarget.inputSchema.safeParse(value).success;
  const status = (value: unknown) => setStudioTargetStatus.inputSchema.safeParse(value).success;
  it.each(["tenantId", "permissions", "actorId", "userId", "role", "isAdmin", "confirmed", "risk", "createdBy", "id", "status", "ref", "snapshot"])("refuse the spoofed top-level field %s", (key) => {
    expect(register({ ...input, [key]: "x" })).toBe(false);
    expect(status({ applicationId: APP, targetId: "a.b", status: "active", [key]: "x" })).toBe(false);
  });
  it("accept the exact register shape and refuse a bad application id", () => {
    expect(register(input)).toBe(true);
    expect(register({ ...input, applicationId: "reference" })).toBe(false);
  });
});
