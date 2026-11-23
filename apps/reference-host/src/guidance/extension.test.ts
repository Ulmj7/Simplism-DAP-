/** The extension seam of composeReferenceHost and the extension-aware loadConfig. No database: everything here is decided before a connection exists. */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import { defineAction, defineExecutor } from "@dap/contracts";
import type { ActionDefinition, ActionId, ExecutorId, PermissionId } from "@dap/contracts";
import { z } from "zod";
import { ExtensionError, composeReferenceHost } from "../compose.js";
import type { HostExtension } from "../compose.js";
import { DEMO_ACTION_IDS } from "../capabilities.js";
import { ConfigError, loadConfig } from "../config.js";
import type { Environment } from "../config.js";
import { createGuidanceExtension } from "./capability.js";
import { demoCatalogView } from "./walkthrough-summaries.js";

const TENANT = randomUUID();
const session = { token: `tok-${randomUUID()}`, userId: "alice", tenantId: TENANT, sessionId: "session-alice", validUntil: new Date(Date.now() + 3_600_000).toISOString(), permissions: ["perm.demo.lookup"] };
const env = (overrides: Record<string, string | undefined> = {}): Environment => ({
  DAP_ALLOW_DEV_AUTH: "1", DAP_DATABASE_URL: "postgresql://dap_app:pw@127.0.0.1:1/never_connected", DAP_ENABLED_ACTIONS: "demoLookup,demoSaveNote", DEV_SESSIONS: JSON.stringify([session]), ...overrides,
});
const guidance = (): HostExtension => createGuidanceExtension({ catalog: demoCatalogView, starter: { start: () => ({ ok: true }) } }).extension;
const rejection = async (run: () => unknown): Promise<Error> => { try { await run(); } catch (error) { return error as Error; } throw new Error("expected a rejection"); };

const definition = (id: string, executorId: string): ActionDefinition<{ readonly x: string }> => defineAction({
  id: id as ActionId, version: 1, description: "A test capability.", inputSchema: z.strictObject({ x: z.string().max(8) }), risk: "SAFE", requiredPermission: "perm.test.x" as PermissionId,
  allowedPages: "any", confirmation: { kind: "not-required" }, changesState: false, audit: { params: [{ path: "/x", mode: "plain" }] }, executorId: executorId as ExecutorId,
});
const executor = (id: string) => defineExecutor<{ readonly x: string }>({ id, run: async () => ({ status: "success" }) });
const ext = (id: string, executorId = `ex.${id}`): HostExtension => ({ definitions: [definition(id, executorId)], executors: [executor(executorId)] });

describe("loadConfig: the known capability ids", () => {
  it("without extensions the known list is exactly the demo list: startWalkthrough is unknown", () => {
    expect(DEMO_ACTION_IDS).toEqual(["demoLookup", "demoSaveNote", "demoPublishNote"]);
    expect(() => loadConfig(env({ DAP_ENABLED_ACTIONS: "demoLookup,startWalkthrough" }))).toThrow(ConfigError);
    expect(() => loadConfig(env({ DAP_ENABLED_ACTIONS: "startWalkthrough" }))).toThrow(/unknown or empty capability id/);
    expect(() => loadConfig(env({ DAP_ENABLED_ACTIONS: "demoLookup,startWalkthrough" }), [])).toThrow(ConfigError);
    expect(loadConfig(env({ DAP_ENABLED_ACTIONS: "demoLookup,demoSaveNote,demoPublishNote" })).enabledActions).toEqual(["demoLookup", "demoSaveNote", "demoPublishNote"]);
  });
  it("with the extension's id known, DAP_ENABLED_ACTIONS=demoLookup,startWalkthrough is accepted", () => {
    expect(loadConfig(env({ DAP_ENABLED_ACTIONS: "demoLookup,startWalkthrough" }), ["startWalkthrough"]).enabledActions).toEqual(["demoLookup", "startWalkthrough"]);
  });
  it("DEFAULT DENY stays: a known extension id is NOT enabled unless DAP_ENABLED_ACTIONS lists it, and the variable is still required", () => {
    expect(loadConfig(env({ DAP_ENABLED_ACTIONS: "demoLookup" }), ["startWalkthrough"]).enabledActions).toEqual(["demoLookup"]);
    expect(() => loadConfig(env({ DAP_ENABLED_ACTIONS: undefined }), ["startWalkthrough"])).toThrow(/DAP_ENABLED_ACTIONS is required/);
    expect(() => loadConfig(env({ DAP_ENABLED_ACTIONS: "  " }), ["startWalkthrough"])).toThrow(ConfigError);
  });
  it("unknown, empty and repeated ids are still refused with extensions", () => {
    for (const value of ["demoLookup,nope", "demoLookup,", "startWalkthrough,startWalkthrough"]) expect(() => loadConfig(env({ DAP_ENABLED_ACTIONS: value }), ["startWalkthrough"]), value).toThrow(ConfigError);
  });
});

describe("composeReferenceHost without extensions is exactly the Feature 001 host", () => {
  it("accepts the demo list, refuses startWalkthrough as unknown, and treats options, {} and { extensions: [] } the same", async () => {
    for (const options of [undefined, {}, { extensions: [] }]) {
      const composed = await composeReferenceHost(env(), options);
      await composed.host.close();
      expect((await rejection(() => composeReferenceHost(env({ DAP_ENABLED_ACTIONS: "demoLookup,startWalkthrough" }), options))).message).toMatch(/unknown or empty capability id/);
    }
  });
  it("the trusted handle of a host without extensions knows only the demo executors", async () => {
    const { host, trusted } = await composeReferenceHost(env());
    await host.close();
    expect(trusted.executorCalls()).toBe(0);
    expect(Object.keys(trusted).sort()).toEqual(["effects", "executorCalls", "receivedCalls"]);
  });
});

describe("composeReferenceHost with extensions", () => {
  it("accepts the guidance extension and enabling its capability", async () => {
    const composed = await composeReferenceHost(env({ DAP_ENABLED_ACTIONS: "demoLookup,startWalkthrough" }), { extensions: [guidance()] });
    await composed.host.close();
  });
  it("accepts the guidance extension while leaving its capability OFF (default deny)", async () => {
    const composed = await composeReferenceHost(env({ DAP_ENABLED_ACTIONS: "demoLookup" }), { extensions: [guidance()] });
    await composed.host.close();
  });
  it("accepts two extensions with different ids", async () => {
    const composed = await composeReferenceHost(env({ DAP_ENABLED_ACTIONS: "demoLookup,extraOne,extraTwo" }), { extensions: [ext("extraOne"), ext("extraTwo")] });
    await composed.host.close();
  });
  it.each(["demoLookup", "demoSaveNote", "demoPublishNote"])("an extension capability colliding with the demo capability %s is refused at composition", async (id) => {
    const error = await rejection(() => composeReferenceHost(env(), { extensions: [ext(id, `ex.collide-${id}`)] }));
    expect(error).toBeInstanceOf(ExtensionError);
    expect(error.message).toMatch(/collides/);
  });
  it("two extensions with the same capability id are refused", async () => {
    expect(await rejection(() => composeReferenceHost(env(), { extensions: [ext("sameId", "ex.one"), ext("sameId", "ex.two")] }))).toBeInstanceOf(ExtensionError);
    expect(await rejection(() => composeReferenceHost(env(), { extensions: [guidance(), guidance()] }))).toBeInstanceOf(ExtensionError);
  });
  it("an executor id used twice is refused", async () => {
    expect(await rejection(() => composeReferenceHost(env(), { extensions: [ext("oneCap", "ex.shared"), ext("twoCap", "ex.shared")] }))).toBeInstanceOf(ExtensionError);
  });
  it("an extension that is not exactly { definitions, executors } is refused: no hooks, no extra keys, no malformed lists", async () => {
    const good = ext("goodCap");
    for (const bad of [{ ...good, hooks: {} }, { ...good, onStart: () => undefined }, { definitions: good.definitions }, { executors: good.executors }, { definitions: "x", executors: [] }, null, "x", 5, [good]]) {
      expect(await rejection(() => composeReferenceHost(env(), { extensions: [bad as never] }))).toBeInstanceOf(ExtensionError);
    }
    expect(await rejection(() => composeReferenceHost(env(), { extensions: "x" as never }))).toBeInstanceOf(ExtensionError);
  });
  it("an extension cannot re-expose a demo executor under a weaker policy: a capability naming a demo executor id (with or without shipping an executor of that id) is refused", async () => {
    for (const demoExecutor of ["ex.demo-publish-note", "ex.demo-save-note", "ex.demo-lookup"]) {
      expect(await rejection(() => composeReferenceHost(env(), { extensions: [{ definitions: [definition("sneaky", demoExecutor)], executors: [] }] })), demoExecutor).toBeInstanceOf(ExtensionError);
      expect(await rejection(() => composeReferenceHost(env(), { extensions: [{ definitions: [definition("sneaky", demoExecutor)], executors: [executor(demoExecutor)] }] })), demoExecutor).toBeInstanceOf(ExtensionError);
    }
  });
  it("a capability cannot use the executor of ANOTHER extension, and two capabilities cannot share one executor", async () => {
    const first = ext("firstCap", "ex.first");
    const borrowing: HostExtension = { definitions: [definition("borrowCap", "ex.first")], executors: [] };
    expect(await rejection(() => composeReferenceHost(env(), { extensions: [first, borrowing] }))).toBeInstanceOf(ExtensionError);
    const shared: HostExtension = { definitions: [definition("capOne", "ex.shared-one"), definition("capTwo", "ex.shared-one")], executors: [executor("ex.shared-one")] };
    expect(await rejection(() => composeReferenceHost(env(), { extensions: [shared] }))).toBeInstanceOf(ExtensionError);
  });
  it("null, primitive and malformed entries inside the lists are an ExtensionError, never a raw TypeError", async () => {
    const good = ext("goodCap");
    for (const bad of [{ definitions: [null], executors: [] }, { definitions: [5], executors: [] }, { definitions: [], executors: [null] }, { definitions: [{ id: 5 }], executors: [] }, { definitions: good.definitions, executors: [{ id: 7 }] }, { definitions: [{}], executors: [] }]) {
      expect(await rejection(() => composeReferenceHost(env(), { extensions: [bad as never] }))).toBeInstanceOf(ExtensionError);
    }
  });
  it("an extension whose capability has no executor, or whose executor has no capability, is refused (fail closed)", async () => {
    const orphanExecutor: HostExtension = { definitions: [], executors: [executor("ex.orphan")] };
    const orphanDefinition: HostExtension = { definitions: [definition("lonelyCap", "ex.lonely")], executors: [] };
    for (const extension of [orphanExecutor, orphanDefinition]) await expect(composeReferenceHost(env(), { extensions: [extension] })).rejects.toBeDefined();
  });
  it("an extension capability that is enabled in DAP_ENABLED_ACTIONS without its extension being passed is unknown", async () => {
    expect((await rejection(() => composeReferenceHost(env({ DAP_ENABLED_ACTIONS: "demoLookup,extraOne" }), { extensions: [] }))).message).toMatch(/unknown or empty/);
  });
});
