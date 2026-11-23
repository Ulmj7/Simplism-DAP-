/** Studio V1A without a database: the two application capabilities against the Feature 001 registry rules, their executors with a focused fake store, and the extension shape. The Gateway proof is tests/integration/studio-applications.test.ts. */
import { describe, expect, it } from "vitest";
import { buildRegistry, inspectInputSchema } from "@dap/security";
import { DEMO_DEFINITIONS } from "../capabilities.js";
import { composeReferenceHost } from "../compose.js";
import { createAuthoringExtension, MAINTAIN_PERMISSION, MEDIUM_JUSTIFICATION } from "../authoring/capabilities.js";
import type { WalkthroughStore } from "../authoring/store.js";
import {
  APPLICATION_ACTION_IDS, APPLICATION_RESOURCE_TYPE, ENABLE_APPLICATION_ACTION_ID, ENABLE_APPLICATION_EXECUTOR_ID, SAVE_APPLICATION_ACTION_ID, SAVE_APPLICATION_EXECUTOR_ID,
  createApplicationExtension, saveStudioApplication, setStudioApplicationEnabled,
} from "./application-capabilities.js";
import { FakeApplicationStore } from "./fake-application-store.js";
import { createRegistryCatalog } from "./registries.js";

const APP = "app-0123456789ab";
const TENANT = "1111aaaa-2222-4333-8444-5555bbbb5555";
const config = { name: "Reference application", origin: "http://localhost:5184", allowedOrigins: ["http://localhost:5184"], environment: "development", registryId: "reference" };
const NO_STORE: WalkthroughStore = { recordEvent: async () => true, summary: async () => [], list: async () => [], get: async () => null, saveDraft: async () => "created", setStatus: async () => "changed", listPublished: async () => [] };
const deps = () => ({ store: new FakeApplicationStore(), catalog: createRegistryCatalog() });

describe("the two capabilities", () => {
  it("are MEDIUM, state-changing, maintainer-only (exactly perm.walkthrough.maintain), any page, with the written justification instead of a confirmation", () => {
    for (const capability of [saveStudioApplication, setStudioApplicationEnabled]) {
      expect(capability).toMatchObject({ risk: "MEDIUM", changesState: true, requiredPermission: "perm.walkthrough.maintain", allowedPages: "any", version: 1 });
      expect(capability.confirmation).toEqual({ kind: "not-required", justification: MEDIUM_JUSTIFICATION });
    }
    expect(saveStudioApplication.id).toBe("saveStudioApplication");
    expect(setStudioApplicationEnabled.id).toBe("setStudioApplicationEnabled");
    expect(APPLICATION_ACTION_IDS).toEqual(["saveStudioApplication", "setStudioApplicationEnabled", "rotateStudioRuntimeKey"]);
    expect(SAVE_APPLICATION_ACTION_ID).toBe("saveStudioApplication");
    expect(ENABLE_APPLICATION_ACTION_ID).toBe("setStudioApplicationEnabled");
  });
  it("audit ONLY /applicationId (plus the boolean /enabled on the second): never a name, an origin, origins or a registry id", () => {
    expect(saveStudioApplication.audit.params).toEqual([{ path: "/applicationId", mode: "plain" }]);
    expect(setStudioApplicationEnabled.audit.params).toEqual([{ path: "/applicationId", mode: "plain" }, { path: "/enabled", mode: "plain" }]);
    for (const capability of [saveStudioApplication, setStudioApplicationEnabled]) for (const param of capability.audit.params) expect(param.path).not.toMatch(/name|origin|registry|environment/i);
  });
  it("declare a studioApplication resource built from the parameters' id only (rule R9)", () => {
    expect(APPLICATION_RESOURCE_TYPE).toBe("studioApplication");
    expect(saveStudioApplication.resource?.({ applicationId: APP, ...config } as never)).toEqual({ type: "studioApplication", id: APP });
    expect(setStudioApplicationEnabled.resource?.({ applicationId: APP, enabled: true })).toEqual({ type: "studioApplication", id: APP });
  });
  it("use distinct executors, one per capability", () => {
    expect([saveStudioApplication.executorId, setStudioApplicationEnabled.executorId]).toEqual([SAVE_APPLICATION_EXECUTOR_ID, ENABLE_APPLICATION_EXECUTOR_ID]);
    expect(SAVE_APPLICATION_EXECUTOR_ID).not.toBe(ENABLE_APPLICATION_EXECUTOR_ID);
  });
  it("satisfy the Feature 001 registry rules next to the demo and authoring capabilities, and the inputs inspect clean: strict, bounded, no reserved parameter name", () => {
    const authoring = createAuthoringExtension({ store: NO_STORE, applications: new FakeApplicationStore(), catalog: createRegistryCatalog() });
    expect(() => buildRegistry([...DEMO_DEFINITIONS, ...authoring.extension.definitions, saveStudioApplication, setStudioApplicationEnabled])).not.toThrow();
    for (const capability of [saveStudioApplication, setStudioApplicationEnabled]) expect(inspectInputSchema(capability.inputSchema).issues, capability.id).toEqual([]);
  });
});

describe("the strict inputs", () => {
  const save = (value: unknown) => saveStudioApplication.inputSchema.safeParse(value).success;
  const enable = (value: unknown) => setStudioApplicationEnabled.inputSchema.safeParse(value).success;
  it("accept exactly { applicationId, name, origin, allowedOrigins, environment, registryId } and { applicationId, enabled }", () => {
    expect(save({ applicationId: APP, ...config })).toBe(true);
    expect(enable({ applicationId: APP, enabled: true })).toBe(true);
    expect(enable({ applicationId: APP, enabled: false })).toBe(true);
  });
  it.each(["tenantId", "permissions", "actorId", "userId", "sessionId", "role", "isAdmin", "confirmed", "risk", "createdBy", "id", "capability"])("refuse the spoofed top-level field %s", (key) => {
    expect(save({ applicationId: APP, ...config, [key]: "x" })).toBe(false);
    expect(enable({ applicationId: APP, enabled: true, [key]: "x" })).toBe(false);
  });
  it("a save cannot carry the enabled flag (it is state, set only by the second capability)", () => {
    expect(save({ applicationId: APP, ...config, enabled: true })).toBe(false);
  });
  it.each(["wt-0123456789ab", "app-0123456789AB", "app-0123456789a", "app-0123456789abc", "", " app-0123456789ab", "__proto__", "reference"])("refuse the id %j", (id) => {
    expect(save({ applicationId: id, ...config })).toBe(false);
    expect(enable({ applicationId: id, enabled: true })).toBe(false);
  });
  it("refuse missing and wrongly typed parts, oversize strings and more than five origins", () => {
    for (const bad of [{}, { applicationId: APP }, { ...config }, { applicationId: APP, ...config, name: 5 }, { applicationId: APP, ...config, allowedOrigins: "x" }, { applicationId: APP, ...config, allowedOrigins: [] },
      { applicationId: APP, ...config, allowedOrigins: Array(6).fill("https://a.example") }, { applicationId: APP, ...config, name: "x".repeat(81) }, { applicationId: APP, ...config, origin: `https://${"a".repeat(200)}.example` }, null, "x", []]) expect(save(bad)).toBe(false);
    for (const bad of [{ applicationId: APP }, { applicationId: APP, enabled: "true" }, { applicationId: APP, enabled: 1 }, { enabled: true }, null]) expect(enable(bad)).toBe(false);
  });
});

describe("the extension", () => {
  it("is exactly { definitions, executors } with both capabilities, frozen, and a trusted handle that has run nothing", () => {
    const { extension, trusted } = createApplicationExtension(deps());
    expect(Object.keys(extension).sort()).toEqual(["definitions", "executors"]);
    expect(extension.definitions.map((d) => d.id)).toEqual(["saveStudioApplication", "setStudioApplicationEnabled", "rotateStudioRuntimeKey"]);
    expect(extension.executors.map((e) => e.id)).toEqual([SAVE_APPLICATION_EXECUTOR_ID, ENABLE_APPLICATION_EXECUTOR_ID, "ex.studio-rotate-runtime-key"]);
    expect(Object.isFrozen(extension)).toBe(true);
    expect(trusted.executorCalls()).toBe(0);
    expect(trusted.receivedCalls("saveStudioApplication")).toEqual([]);
  });
  it("composes with the authoring extension, and is OFF unless DAP_ENABLED_ACTIONS lists it (default deny)", async () => {
    const env = { NODE_ENV: "test", DAP_ALLOW_DEV_AUTH: "1", DAP_DATABASE_URL: "postgresql://dap_app:pw@127.0.0.1:1/never_connected",
      DEV_SESSIONS: JSON.stringify([{ token: "tok-0123456789abcdef", userId: "alice", tenantId: TENANT, sessionId: "s-alice", validUntil: new Date(Date.now() + 3_600_000).toISOString(), permissions: [MAINTAIN_PERMISSION] }]) };
    const extensions = [createAuthoringExtension({ store: NO_STORE, applications: new FakeApplicationStore(), catalog: createRegistryCatalog() }).extension, createApplicationExtension(deps()).extension];
    for (const enabled of ["demoLookup", "demoLookup,saveStudioApplication,setStudioApplicationEnabled", "demoLookup,saveWalkthroughDraft,setWalkthroughStatus,saveStudioApplication,setStudioApplicationEnabled"]) {
      const composed = await composeReferenceHost({ ...env, DAP_ENABLED_ACTIONS: enabled }, { extensions });
      await composed.host.close();
    }
    await expect(composeReferenceHost({ ...env, DAP_ENABLED_ACTIONS: "demoLookup,saveStudioApplication" }, { extensions: [] })).rejects.toThrow(/unknown or empty capability id/);
  });
  it("a second application extension collides (the host refuses duplicate capability ids)", async () => {
    const env = { NODE_ENV: "test", DAP_ALLOW_DEV_AUTH: "1", DAP_DATABASE_URL: "postgresql://dap_app:pw@127.0.0.1:1/never_connected", DAP_ENABLED_ACTIONS: "demoLookup",
      DEV_SESSIONS: JSON.stringify([{ token: "tok-0123456789abcdef", userId: "alice", tenantId: TENANT, sessionId: "s-alice", validUntil: new Date(Date.now() + 3_600_000).toISOString() }]) };
    await expect(composeReferenceHost(env, { extensions: [createApplicationExtension(deps()).extension, createApplicationExtension(deps()).extension] })).rejects.toThrow(/collides/);
  });
});
