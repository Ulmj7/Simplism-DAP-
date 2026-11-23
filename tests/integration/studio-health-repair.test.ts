/**
 * Studio COMPLETION S3 on PostgreSQL through the REAL Gateway, executors and stores: `setStudioTargetHealth` and `repairStudioTarget` (default deny, permission, strict schema, audit with ids
 * only), the repair's compatibility check against the one Feature 002 validator inside the write transaction, the change history, markers in the bundle, cross-tenant isolation and the
 * text/heading roles. The browser session commands that call these capabilities are covered in studio-managed.test.ts and the unit tests.
 */
import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { Pool } from "pg";
import type { ReferenceHost } from "../../apps/reference-host/src/index.js";
import { withRepairReceipt } from "../../apps/reference-host/src/studio/target-capabilities.js";
import { openStatePools } from "../../packages/security/src/state/conformance/state-pg-fixtures.js";
import { managedConfig, managedDef, referenceConfig, registration, startHost } from "./studio-registry.support.js";

let owner: Pool; let probe: Pool;
const closers: (() => Promise<unknown>)[] = [];
const hosts: ReferenceHost[] = [];
beforeAll(async () => { ({ app: probe, owner } = await openStatePools(Pool)); });
afterAll(async () => { await Promise.all([probe?.end(), owner?.end()]); });
afterEach(async () => { await Promise.all([...closers.splice(0).map((close) => close()), ...hosts.splice(0).map((host) => host.close())]); });
const start = (options: Parameters<typeof startHost>[3] = {}) => startHost(closers, hosts, owner, options);
const OK = { outcome: "ALLOWED", category: "ok" };
const REFUSED = { outcome: "ALLOWED", category: "try_later" };
const repairParams = (appId: string, over: Record<string, unknown> = {}) => ({ applicationId: appId, targetId: "orders.submitButton", marker: "orders.submitNew", elementRole: "button", operations: ["highlight", "click"], label: "Submit now", description: "Submits the order now", ...over });

describe("setStudioTargetHealth through the real Gateway", () => {
  it("records unverified, healthy and broken with the PROPOSED/ALLOWED/EXECUTED trail at MEDIUM and only ids and the closed health value in the audit view", async () => {
    const t = await start();
    const appId = await t.createApplication();
    await t.registerOk(appId);
    expect(await t.submit("setStudioTargetHealth", { applicationId: appId, targetId: "orders.submitButton", health: "broken" })).toEqual(OK);
    expect((await t.targets.get(t.tenant, appId, "orders.submitButton"))).toMatchObject({ health: "broken", healthCheckedAt: expect.any(String), revision: 1, marker: "orders.submitButton" });
    expect(await t.submit("setStudioTargetHealth", { applicationId: appId, targetId: "orders.submitButton", health: "healthy" })).toEqual(OK);
    const trail = (await t.rows()).filter((row) => row.action_id === "setStudioTargetHealth");
    expect(trail.map((row) => row.event_type)).toEqual(["AI_ACTION_PROPOSED", "AI_ACTION_ALLOWED", "AI_ACTION_EXECUTED", "AI_ACTION_PROPOSED", "AI_ACTION_ALLOWED", "AI_ACTION_EXECUTED"]);
    expect(trail[1]).toMatchObject({ risk: "MEDIUM", resource_type: "studioApplication", resource_id: appId, params_view: { "/applicationId": appId, "/targetId": "orders.submitButton", "/health": "broken" } });
  });
  it("is default-deny (OFF unless listed) and needs the maintain permission", async () => {
    const off = await start({ enabled: "demoLookup,saveWalkthroughDraft,setWalkthroughStatus,saveStudioApplication,setStudioApplicationEnabled,registerStudioTarget" });
    const offApp = await off.createApplication();
    await off.registerOk(offApp);
    expect((await off.submit("setStudioTargetHealth", { applicationId: offApp, targetId: "orders.submitButton", health: "broken" })).outcome).not.toBe("ALLOWED");
    expect((await off.targets.get(off.tenant, offApp, "orders.submitButton"))?.health).toBe("unverified");
    const t = await start();
    const appId = await t.createApplication();
    await t.registerOk(appId);
    expect((await t.submit("setStudioTargetHealth", { applicationId: appId, targetId: "orders.submitButton", health: "broken" }, t.userToken)).outcome).toBe("UNAUTHORIZED");
    expect((await t.targets.get(t.tenant, appId, "orders.submitButton"))?.health).toBe("unverified");
  });
  it("refuses spoofed fields and a bad health value with INVALID_PARAMETERS", async () => {
    const t = await start();
    const appId = await t.createApplication();
    await t.registerOk(appId);
    const base = { applicationId: appId, targetId: "orders.submitButton" };
    for (const bad of [{ health: "fine" }, { health: "" }, { health: "x".repeat(11) }, { health: "broken", tenantId: randomUUID() }, { health: "broken", role: "x" }]) {
      expect((await t.submit("setStudioTargetHealth", { ...base, ...bad })).outcome, JSON.stringify(bad)).toBe("INVALID_PARAMETERS");
    }
    expect((await t.targets.get(t.tenant, appId, "orders.submitButton"))?.health).toBe("unverified");
  });
  it("refuses an unknown target, a built-in application and another tenant's application (try_later, nothing changes)", async () => {
    const t = await start();
    const appId = await t.createApplication();
    await t.registerOk(appId);
    const base = { applicationId: appId, targetId: "orders.submitButton" };
    expect(await t.submit("setStudioTargetHealth", { ...base, targetId: "orders.missing", health: "broken" })).toEqual(REFUSED);
    const builtIn = await t.createApplication(referenceConfig());
    expect(await t.submit("setStudioTargetHealth", { applicationId: builtIn, targetId: "profile.saveButton", health: "broken" })).toEqual(REFUSED);
    const other = await start();
    expect(await other.submit("setStudioTargetHealth", { ...base, health: "broken" })).toEqual(REFUSED);
    expect((await t.targets.get(t.tenant, appId, "orders.submitButton"))?.health).toBe("unverified");
  });
});

describe("repairStudioTarget through the real Gateway", () => {
  async function story() {
    const t = await start();
    const appId = await t.createApplication();
    await t.registerOk(appId);
    await t.registerOk(appId, { targetId: "orders.note", elementRole: "textbox", operations: ["highlight", "input"], label: "Note", description: "The note" });
    const draft = await t.createWorkflow(appId, managedDef());
    const live = await t.createWorkflow(appId, managedDef(undefined, undefined, { title: "Live guide" }));
    expect((await t.call("POST", `/api/admin/walkthroughs/${live.id}/status`, "maintainer", { status: "published" })).status).toBe(200);
    return { t, appId, draft: draft.id, live: live.id };
  }
  it("re-binds the target: the id never changes, the marker, texts and revision do; health becomes healthy; one change row; the receipt carries the impact (draft and published)", async () => {
    const { t, appId, draft, live } = await story();
    const { result, repaired } = await withRepairReceipt({ tenantId: t.tenant, applicationId: appId, targetId: "orders.submitButton" }, () => t.submit("repairStudioTarget", repairParams(appId)));
    expect(result).toEqual(OK);
    expect(repaired?.target).toMatchObject({ id: "orders.submitButton", marker: "orders.submitNew", label: "Submit now", revision: 2, health: "healthy", references: { drafts: 1, published: 1 } });
    expect(repaired?.impact.drafts).toEqual([{ id: draft, title: "Submit an order" }]);
    expect(repaired?.impact.published).toEqual([{ id: live, title: "Live guide", version: 1 }]);
    const changes = await t.targets.changes(t.tenant, appId, "orders.submitButton", 50);
    expect(changes).toHaveLength(1);
    expect(changes[0]).toMatchObject({ revision: 2, changedBy: "maya", before: { marker: "orders.submitButton", label: "Submit order" }, after: { marker: "orders.submitNew", label: "Submit now" } });
    // the workflows still validate (the DAP id is unchanged) and the published guide is still served, with the NEW marker in its bundle
    const bundle = await t.call("GET", `/api/walkthroughs/published/${live}/bundle`, "user");
    expect(bundle.status).toBe(200);
    expect((bundle.body.registry as { elements: { id: string; marker: string }[] }).elements.map((e) => [e.id, e.marker])).toEqual([["orders.submitButton", "orders.submitNew"], ["orders.note", "orders.note"]]);
    expect((await t.call("PUT", `/api/admin/walkthroughs/${draft}`, "maintainer", { applicationId: appId, definition: managedDef() })).status).toBe(200);
  });
  it("the audit trail records the application and target ids ONLY: never a marker, label, description, role or operations", async () => {
    const { t, appId } = await story();
    expect(await t.submit("repairStudioTarget", repairParams(appId, { label: "Distinctive label", description: "Distinctive description", marker: "orders.distinctiveMarker" }))).toEqual(OK);
    const trail = (await t.rows()).filter((row) => row.action_id === "repairStudioTarget");
    expect(trail.map((row) => row.event_type)).toEqual(["AI_ACTION_PROPOSED", "AI_ACTION_ALLOWED", "AI_ACTION_EXECUTED"]);
    expect(trail[1]).toMatchObject({ risk: "MEDIUM", user_id: "maya", resource_id: appId, params_view: { "/applicationId": appId, "/targetId": "orders.submitButton" } });
    const text = JSON.stringify(await t.rows());
    for (const word of ["Distinctive", "distinctiveMarker", "elementRole", "operations"]) expect(text, word).not.toContain(word);
  });
  it("is refused, and NOTHING changes, when a draft or a published guide would stop validating: the click wait of both guides needs a target that allows click", async () => {
    const { t, appId } = await story();
    const receipt = await withRepairReceipt({ tenantId: t.tenant, applicationId: appId, targetId: "orders.submitButton" }, () =>
      t.submit("repairStudioTarget", repairParams(appId, { elementRole: "textbox", operations: ["highlight", "input"] })));
    expect(receipt.result).toEqual(REFUSED);
    expect(receipt.problems?.length).toBeGreaterThan(0);
    expect((receipt.problems ?? []).every((problem) => /^wt-[a-f0-9]{12}: /u.test(problem))).toBe(true);
    expect((receipt.problems ?? []).join(" ")).toMatch(/click/u);
    expect(await t.targets.get(t.tenant, appId, "orders.submitButton")).toMatchObject({ role: "button", marker: "orders.submitButton", revision: 1, health: "unverified" });
    expect(await t.targets.changes(t.tenant, appId, "orders.submitButton", 5)).toEqual([]);
    // the same repair is fine for a target that no workflow names
    expect(await t.submit("repairStudioTarget", repairParams(appId, { targetId: "orders.note", marker: "orders.noteNew", elementRole: "checkbox", operations: ["highlight", "click"], label: "Note box", description: "Now a box" }))).toEqual(OK);
  });
  it("is refused for a marker in use, an unchanged repair, a structurally invalid one (the validator, before the store) and an unknown target; nothing changes", async () => {
    const { t, appId } = await story();
    expect(await t.submit("repairStudioTarget", repairParams(appId, { marker: "orders.note" }))).toEqual(REFUSED);
    expect(await t.submit("repairStudioTarget", repairParams(appId, { marker: "orders.submitButton", label: "Submit order", description: "Submits the order" }))).toEqual(REFUSED);
    for (const bad of [{ marker: "dap.thing" }, { elementRole: "panel" }, { operations: ["highlight", "input"] }, { label: "<b>" }]) expect(await t.submit("repairStudioTarget", repairParams(appId, bad)), JSON.stringify(bad)).toEqual(REFUSED);
    expect(await t.submit("repairStudioTarget", repairParams(appId, { targetId: "orders.missing" }))).toEqual(REFUSED);
    expect(await t.targets.get(t.tenant, appId, "orders.submitButton")).toMatchObject({ revision: 1, marker: "orders.submitButton" });
    expect(await t.targets.changes(t.tenant, appId, "orders.submitButton", 5)).toEqual([]);
  });
  it("the strict schema refuses a route, a page, a privacy, a role, a tenant, empty text and no operations with INVALID_PARAMETERS; the permission is required", async () => {
    const { t, appId } = await story();
    for (const bad of [{ route: "orders" }, { page: "/#/x" }, { privacy: "public" }, { role: "button" }, { tenantId: randomUUID() }, { label: "" }, { operations: [] }]) {
      expect((await t.submit("repairStudioTarget", repairParams(appId, bad))).outcome, JSON.stringify(bad)).not.toBe("ALLOWED");
    }
    expect((await t.submit("repairStudioTarget", repairParams(appId), t.userToken)).outcome).toBe("UNAUTHORIZED");
    expect(await t.targets.get(t.tenant, appId, "orders.submitButton")).toMatchObject({ revision: 1 });
  });
  it("is refused for a built-in application, another tenant and a disabled application", async () => {
    const { t, appId } = await story();
    const builtIn = await t.createApplication(referenceConfig());
    expect(await t.submit("repairStudioTarget", repairParams(builtIn))).toEqual(REFUSED);
    const other = await start();
    expect(await other.submit("repairStudioTarget", repairParams(appId))).toEqual(REFUSED);
    expect((await t.call("POST", `/api/admin/applications/${appId}/status`, "maintainer", { enabled: false })).status).toBe(200);
    expect(await t.submit("repairStudioTarget", repairParams(appId))).toEqual(REFUSED);
    expect(await t.targets.get(t.tenant, appId, "orders.submitButton")).toMatchObject({ revision: 1, marker: "orders.submitButton" });
  });
  it("repairs a target and keeps it findable by its NEW marker only: the registry markers, the list view and a second repair (revision 3, two history rows)", async () => {
    const { t, appId } = await story();
    await t.submit("repairStudioTarget", repairParams(appId));
    await t.submit("repairStudioTarget", repairParams(appId, { marker: "orders.submitThird", label: "Third" }));
    const listing = await t.targets.list(t.tenant, appId);
    expect(listing.targets.find((target) => target.id === "orders.submitButton")).toMatchObject({ marker: "orders.submitThird", revision: 3, label: "Third", health: "healthy" });
    expect((await t.targets.registry(t.tenant, appId)).markers).toEqual({ "orders.submitButton": "orders.submitThird", "orders.note": "orders.note" });
    expect((await t.targets.changes(t.tenant, appId, "orders.submitButton", 50)).map((change) => change.revision)).toEqual([3, 2]);
    // the moved id can neither be registered again nor taken by another target as a marker
    expect(await t.registerTarget(appId, registration({ targetId: "orders.submitThird" }))).toEqual(REFUSED);
  });
  it("two concurrent repairs of one target both validate, one wins the row lock, and the revision ends at the number of successful repairs", async () => {
    const { t, appId } = await story();
    const results = await Promise.all([t.submit("repairStudioTarget", repairParams(appId, { marker: "orders.raceOne", label: "One" })), t.submit("repairStudioTarget", repairParams(appId, { marker: "orders.raceTwo", label: "Two" }))]);
    const ok = results.filter((result) => result.outcome === "ALLOWED" && result.category === "ok").length;
    expect(ok).toBeGreaterThanOrEqual(1);
    const target = await t.targets.get(t.tenant, appId, "orders.submitButton");
    expect(target?.revision).toBe(1 + ok);
    expect(await t.targets.changes(t.tenant, appId, "orders.submitButton", 50)).toHaveLength(ok);
  });
});

describe("text and heading targets through the real Gateway and routes", () => {
  it("registers a status and a heading with {highlight}; a guide can highlight them; the registry and bundle say role text and heading", async () => {
    const t = await start();
    const appId = await t.createApplication(managedConfig());
    await t.registerOk(appId, { targetId: "orders.savedMessage", elementRole: "text", operations: ["highlight"], label: "Saved message", description: "Tells the order was saved" });
    await t.registerOk(appId, { targetId: "orders.pageTitle", elementRole: "heading", operations: ["highlight"], label: "Page title", description: "The orders heading" });
    expect(await t.registerTarget(appId, registration({ targetId: "orders.badText", elementRole: "text", operations: ["highlight", "click"] }))).toEqual(REFUSED);
    const registry = (await t.call("GET", `/api/admin/applications/${appId}/registry`, "maintainer")).body;
    expect((registry.elements as { id: string; role: string; operations: string[] }[]).map((e) => [e.id, e.role, e.operations])).toEqual([["orders.savedMessage", "text", ["highlight"]], ["orders.pageTitle", "heading", ["highlight"]]]);
    const def = { ...managedDef("orders.savedMessage", "orders"), steps: [
      { id: "n1", kind: "navigate", route: "orders", next: "s1" },
      { id: "s1", kind: "guide", target: "orders.savedMessage", text: "Look at the message.", wait: "ack", next: "s2" },
      { id: "s2", kind: "guide", target: "orders.pageTitle", text: "And the title.", wait: "ack", next: "done" }, { id: "done", kind: "complete", text: "Done." }] };
    const wf = await t.createWorkflow(appId, def);
    expect(wf.res.status).toBe(201);
    expect((await t.call("POST", `/api/admin/walkthroughs/${wf.id}/status`, "maintainer", { status: "published" })).status).toBe(200);
    const bundle = (await t.call("GET", `/api/walkthroughs/published/${wf.id}/bundle`, "user")).body.registry as { elements: { id: string; role: string }[] };
    expect(bundle.elements.map((e) => [e.id, e.role])).toEqual([["orders.savedMessage", "text"], ["orders.pageTitle", "heading"]]);
    // a click wait on a text target is refused by the one validator
    const clickDef = { ...def, steps: def.steps.map((step) => (step.id === "s1" ? { ...step, wait: "click" } : step)) };
    expect((await t.createWorkflow(appId, clickDef)).res.status).toBe(422);
  });
});
