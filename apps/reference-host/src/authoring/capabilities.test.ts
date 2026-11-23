/** T405 without a database: the capability definitions against the Feature 001 registry rules, the extension shape and the resource authorizer branch. The Gateway proof is tests/integration/authoring-gateway.test.ts. */
import { describe, expect, it } from "vitest";
import { buildRegistry, inspectInputSchema } from "@dap/security";
import { DEMO_DEFINITIONS } from "../capabilities.js";
import { composeReferenceHost } from "../compose.js";
import { createGuidanceExtension } from "../guidance/capability.js";
import { demoCatalogView } from "../guidance/walkthrough-summaries.js";
import {
  AUTHORING_ACTION_IDS, MAINTAIN_PERMISSION, MEDIUM_JUSTIFICATION, SAVE_EXECUTOR_ID, STATUS_EXECUTOR_ID, createAuthoringExtension, saveWalkthroughDraft, setWalkthroughStatus,
} from "./capabilities.js";
import type { WalkthroughStore } from "./store.js";
import { FakeApplicationStore } from "../studio/fake-application-store.js";
import { createRegistryCatalog } from "../studio/registries.js";

const NO_STORE: WalkthroughStore = { recordEvent: async () => true, summary: async () => [], list: async () => [], get: async () => null, saveDraft: async () => "created", setStatus: async () => "changed", listPublished: async () => [] };
const ID = "wt-0123456789ab";
const APP = "app-0123456789ab";
const deps = () => ({ store: NO_STORE, applications: new FakeApplicationStore(), catalog: createRegistryCatalog() });
const definition = { id: ID, title: "T", description: "D", start: "s1", steps: [{ id: "s1", kind: "guide", target: "profile.saveButton", text: "x", wait: "click", next: "done" }, { id: "done", kind: "complete", text: "x" }] };

describe("the two capabilities", () => {
  it("are MEDIUM, state-changing, maintainer-only (exactly perm.walkthrough.maintain), any page, with a written justification instead of a confirmation", () => {
    for (const capability of [saveWalkthroughDraft, setWalkthroughStatus]) {
      expect(capability).toMatchObject({ risk: "MEDIUM", changesState: true, requiredPermission: "perm.walkthrough.maintain", allowedPages: "any", version: 1 });
      expect(capability.confirmation).toEqual({ kind: "not-required", justification: MEDIUM_JUSTIFICATION });
    }
    expect(MAINTAIN_PERMISSION).toBe("perm.walkthrough.maintain");
    expect(saveWalkthroughDraft.id).toBe("saveWalkthroughDraft");
    expect(setWalkthroughStatus.id).toBe("setWalkthroughStatus");
    expect(AUTHORING_ACTION_IDS).toEqual(["saveWalkthroughDraft", "setWalkthroughStatus", "reviseWalkthrough", "restoreWalkthroughVersion"]);
  });
  it("the justification says who may call it, that it is validated, invisible while a draft, reversible and display-only, and why not HIGH", () => {
    for (const phrase of ["maintainer", "validated", "draft", "unpublishing", "guidance", "confirmation service"]) expect(MEDIUM_JUSTIFICATION).toContain(phrase);
    expect(MEDIUM_JUSTIFICATION.length).toBeLessThanOrEqual(1000);
  });
  it("audit parameters: /walkthroughId (plain) on both, /status (plain) on the status capability ONLY, and never the definition", () => {
    expect(saveWalkthroughDraft.audit.params).toEqual([{ path: "/walkthroughId", mode: "plain" }]);
    expect(setWalkthroughStatus.audit.params).toEqual([{ path: "/walkthroughId", mode: "plain" }, { path: "/status", mode: "plain" }]);
    for (const capability of [saveWalkthroughDraft, setWalkthroughStatus]) for (const param of capability.audit.params) expect(param.path).not.toMatch(/definition|title|steps|text/);
  });
  it("declare a walkthrough resource built from the parameters' id only (rule R9)", () => {
    expect(saveWalkthroughDraft.resource?.({ walkthroughId: ID, applicationId: APP, definition } as never)).toEqual({ type: "walkthrough", id: ID });
    expect(setWalkthroughStatus.resource?.({ walkthroughId: ID, status: "draft" } as never)).toEqual({ type: "walkthrough", id: ID });
  });
  it("use distinct executors, one per capability", () => {
    expect([saveWalkthroughDraft.executorId, setWalkthroughStatus.executorId]).toEqual([SAVE_EXECUTOR_ID, STATUS_EXECUTOR_ID]);
    expect(SAVE_EXECUTOR_ID).not.toBe(STATUS_EXECUTOR_ID);
  });
  it("satisfy the Feature 001 registry rules next to the demo capabilities (R4-R9), and the input schemas inspect clean: strict, bounded, no reserved parameter name", () => {
    expect(() => buildRegistry([...DEMO_DEFINITIONS, saveWalkthroughDraft, setWalkthroughStatus])).not.toThrow();
    for (const capability of [saveWalkthroughDraft, setWalkthroughStatus]) expect(inspectInputSchema(capability.inputSchema).issues, capability.id).toEqual([]);
  });
});

describe("the strict inputs", () => {
  const save = (value: unknown) => saveWalkthroughDraft.inputSchema.safeParse(value).success;
  const status = (value: unknown) => setWalkthroughStatus.inputSchema.safeParse(value).success;
  it("accept exactly { walkthroughId, applicationId, definition } and { walkthroughId, status }", () => {
    expect(save({ expectedRevision: 0, walkthroughId: ID, applicationId: APP, definition })).toBe(true);
    expect(status({ walkthroughId: ID, status: "draft" })).toBe(true);
    expect(status({ walkthroughId: ID, status: "published" })).toBe(true);
  });
  it.each(["tenantId", "permissions", "actorId", "userId", "sessionId", "role", "isAdmin", "confirmed", "risk", "createdBy", "id"])("refuse the spoofed top-level field %s", (key) => {
    expect(save({ expectedRevision: 0, walkthroughId: ID, applicationId: APP, definition, [key]: "x" })).toBe(false);
    expect(status({ walkthroughId: ID, status: "draft", [key]: "x" })).toBe(false);
  });
  it("refuse a spoofed field INSIDE the definition and inside a step", () => {
    expect(save({ expectedRevision: 0, walkthroughId: ID, applicationId: APP, definition: { ...definition, tenantId: "t" } })).toBe(false);
    expect(save({ expectedRevision: 0, walkthroughId: ID, applicationId: APP, definition: { ...definition, steps: [{ ...definition.steps[0], permissions: [] }] } })).toBe(false);
  });
  it.each(["profileUpdate", "findSecuritySettings", "findTwoFactorSettings", "wt-preview", "wt-ABCDEF012345", "wt-0123456789a", "wt-0123456789abc", "", " wt-0123456789ab", "__proto__"])("refuse the id %j", (id) => {
    expect(save({ expectedRevision: 0, walkthroughId: id, applicationId: APP, definition })).toBe(false);
    expect(status({ walkthroughId: id, status: "draft" })).toBe(false);
  });
  it.each(["archived", "Published", "", null, 5, ["draft"], { a: 1 }])("refuse the status %j", (value) => { expect(status({ walkthroughId: ID, status: value })).toBe(false); });
  it("refuse missing and wrongly typed parts", () => {
    for (const bad of [{}, { walkthroughId: ID }, { definition }, { walkthroughId: ID, definition }, { walkthroughId: ID, applicationId: "wt-0123456789ab", definition }, { walkthroughId: ID, applicationId: "app-0123456789AB", definition }, { walkthroughId: 5, definition }, { walkthroughId: ID, definition: "x" }, { walkthroughId: ID, definition: null }, null, "x", []]) expect(save(bad)).toBe(false);
  });
});

describe("the extension", () => {
  it("is exactly { definitions, executors } with both capabilities, frozen, and a trusted handle that has run nothing", () => {
    const { extension, trusted } = createAuthoringExtension(deps());
    expect(Object.keys(extension).sort()).toEqual(["definitions", "executors"]);
    expect(extension.definitions.map((d) => d.id)).toEqual(["saveWalkthroughDraft", "setWalkthroughStatus", "reviseWalkthrough", "restoreWalkthroughVersion"]);
    expect(extension.executors.map((e) => e.id)).toEqual([SAVE_EXECUTOR_ID, STATUS_EXECUTOR_ID, "ex.authoring-revise-walkthrough", "ex.authoring-restore-walkthrough"]);
    expect(Object.isFrozen(extension)).toBe(true);
    expect(trusted.executorCalls()).toBe(0);
    expect(trusted.receivedCalls("saveWalkthroughDraft")).toEqual([]);
  });
  it("composes with the guidance extension (no id or executor collision), and is OFF unless DAP_ENABLED_ACTIONS lists it", async () => {
    const env = { NODE_ENV: "test", DAP_ALLOW_DEV_AUTH: "1", DAP_DATABASE_URL: "postgresql://dap_app:pw@127.0.0.1:1/never_connected",
      DEV_SESSIONS: JSON.stringify([{ token: "tok-0123456789abcdef", userId: "alice", tenantId: "1111aaaa-2222-4333-8444-5555bbbb5555", sessionId: "s-alice", validUntil: new Date(Date.now() + 3_600_000).toISOString(), permissions: [MAINTAIN_PERMISSION] }]) };
    const extensions = [createGuidanceExtension({ catalog: demoCatalogView, starter: { start: () => ({ ok: true }) } }).extension, createAuthoringExtension(deps()).extension];
    for (const enabled of ["demoLookup", "demoLookup,saveWalkthroughDraft,setWalkthroughStatus", "demoLookup,startWalkthrough,saveWalkthroughDraft,setWalkthroughStatus"]) {
      const composed = await composeReferenceHost({ ...env, DAP_ENABLED_ACTIONS: enabled }, { extensions });
      await composed.host.close();
    }
    await expect(composeReferenceHost({ ...env, DAP_ENABLED_ACTIONS: "demoLookup,saveWalkthroughDraft" }, { extensions: [] })).rejects.toThrow(/unknown or empty capability id/);
  });
  it("a second authoring extension collides (the host refuses duplicate capability ids)", async () => {
    const env = { NODE_ENV: "test", DAP_ALLOW_DEV_AUTH: "1", DAP_DATABASE_URL: "postgresql://dap_app:pw@127.0.0.1:1/never_connected", DAP_ENABLED_ACTIONS: "demoLookup",
      DEV_SESSIONS: JSON.stringify([{ token: "tok-0123456789abcdef", userId: "alice", tenantId: "1111aaaa-2222-4333-8444-5555bbbb5555", sessionId: "s-alice", validUntil: new Date(Date.now() + 3_600_000).toISOString() }]) };
    await expect(composeReferenceHost(env, { extensions: [createAuthoringExtension(deps()).extension, createAuthoringExtension(deps()).extension] })).rejects.toThrow(/collides/);
  });
});
