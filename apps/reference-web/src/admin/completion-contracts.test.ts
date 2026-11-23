/** Studio completion S2/S3/S4 wire contracts: every reply is parsed against an exact, bounded, closed shape (both edges of every bound). */
import { describe, expect, it, vi } from "vitest";
import type { FetchLike } from "../help/client.js";
import { createAdminClient } from "./client.js";
import { checkBody, parseCheckList, parseCheckView } from "./checks.js";
import { parseStudioError, parseStudioReply } from "./studio-client.js";
import { parseRepairFields, parseTargetDetail, parseTargetList, parseTargetView, parseUsage } from "./targets.js";

const app = "app-0123456789ab";
const stamp = "2026-11-23T10:00:00.000Z";
const view = () => ({
  id: "profile.save", marker: "profile.save", route: "profile", page: "/#/profile", role: "button", label: "Save", description: "Saves the profile", operations: ["highlight", "click"],
  privacy: "public", status: "active", health: "healthy", healthCheckedAt: stamp, revision: 3, references: { drafts: 1, published: 2 }, updatedAt: stamp,
});
const usage = { drafts: [{ id: "wt-0123456789ab", title: "Draft one" }], published: [{ id: "wt-0123456789ac", title: "Live one", version: 2 }] };
const fields = { marker: "profile.submit", role: "link", operations: ["highlight", "click"], label: "Save", description: "Saves the profile" };
const impact = { ...usage, compatible: true, problems: [] };
const detail = () => ({ ...view(), usage, changes: [{ revision: 2, changedAt: stamp, changedBy: "maintainer-1", before: { marker: "profile.save" }, after: { marker: "profile.submit", role: "link" } }] });
const refused = (parse: (value: unknown) => unknown, value: unknown) => expect(parse(value)).toBeNull();

describe("TargetView (S3)", () => {
  it("accepts the frozen shape and copies it", () => {
    const parsed = parseTargetView(view());
    expect(parsed).toEqual(view());
    expect(parsed?.operations).not.toBe(view().operations);
  });
  it.each([
    ["a missing marker", (v: Record<string, unknown>) => { delete v.marker; }], ["an invalid marker", (v: Record<string, unknown>) => { v.marker = "not a marker"; }], ["an 81 character marker", (v: Record<string, unknown>) => { v.marker = `a.${"b".repeat(79)}`; }],
    ["an unknown health", (v: Record<string, unknown>) => { v.health = "great"; }], ["a missing health", (v: Record<string, unknown>) => { delete v.health; }],
    ["a bad healthCheckedAt", (v: Record<string, unknown>) => { v.healthCheckedAt = "yesterday"; }], ["a missing healthCheckedAt", (v: Record<string, unknown>) => { delete v.healthCheckedAt; }],
    ["revision 0", (v: Record<string, unknown>) => { v.revision = 0; }], ["a fractional revision", (v: Record<string, unknown>) => { v.revision = 1.5; }], ["revision 1000001", (v: Record<string, unknown>) => { v.revision = 1_000_001; }],
    ["an extra key", (v: Record<string, unknown>) => { v.extra = 1; }], ["a ref", (v: Record<string, unknown>) => { v.ref = "@e1"; }],
  ])("refuses %s", (_label, change) => { const v = view() as Record<string, unknown>; change(v); refused(parseTargetView, v); });
  it.each(["unverified", "healthy", "broken"])("accepts health %s, with and without a check time", health => {
    expect(parseTargetView({ ...view(), health, healthCheckedAt: null })?.health).toBe(health);
    expect(parseTargetView({ ...view(), health })?.health).toBe(health);
  });
  it("accepts revision 1 and 1000000", () => { expect(parseTargetView({ ...view(), revision: 1 })).not.toBeNull(); expect(parseTargetView({ ...view(), revision: 1_000_000 })).not.toBeNull(); });
  it("the list requires the new shape for every target", () => {
    const list = { targets: [view()], routes: [{ route: "profile", page: "/#/profile" }], limits: { maxTargets: 200, maxRoutes: 20 } };
    expect(parseTargetList(list)).toMatchObject({ targets: [{ marker: "profile.save", health: "healthy", revision: 3 }] });
    const { marker: _marker, ...old } = view();
    void _marker;
    refused(parseTargetList, { ...list, targets: [old] });
  });
});

describe("text and heading targets (S3)", () => {
  it("accept exactly [highlight] as operations, and nothing else", () => {
    for (const role of ["text", "heading"]) {
      expect(parseTargetView({ ...view(), role, operations: ["highlight"] })?.role).toBe(role);
      for (const operations of [["highlight", "click"], ["highlight", "input"], ["highlight", "focus"], ["click"], []]) expect(parseTargetView({ ...view(), role, operations }), `${role} ${operations}`).toBeNull();
    }
    expect(parseTargetView({ ...view(), role: "status", operations: ["highlight"] })).toBeNull();
  });
  it("a repair proposal for a text target is highlight-only", () => {
    expect(parseRepairFields({ ...fields, role: "text", operations: ["highlight"] })).not.toBeNull();
  });
});

describe("application writes carry the full body (host contract)", () => {
  it("create and PUT send exactly the seven keys, routing and runtimeAccess included", async () => {
    const fetch = vi.fn<FetchLike>();
    const client = createAdminClient({ fetch, role: "maintainer" });
    const input = { name: "Shop", origin: "http://127.0.0.1:5190", allowedOrigins: ["http://127.0.0.1:5190"], environment: "test" as const, registryId: "studio-managed", routing: "history" as const, runtimeAccess: true };
    const applicationView = { id: app, ...input, enabled: true, updatedAt: stamp, source: "studio-managed", runtimeKey: `rk-${"1".repeat(32)}-${"a".repeat(32)}`, counts: { targets: 0, drafts: 0, published: 0 } };
    fetch.mockResolvedValue(new Response(JSON.stringify(applicationView), { status: 200 }));
    await client.createApplication({ ...input, extra: 1 } as never);
    await client.updateApplication(app, { ...input, id: "x", enabled: false } as never);
    for (const call of fetch.mock.calls.slice(0, 2)) expect(Object.keys(JSON.parse(String(call[1].body)))).toEqual(["name", "origin", "allowedOrigins", "environment", "registryId", "routing", "runtimeAccess"]);
    expect(fetch.mock.calls[1]![1].method).toBe("PUT");
    expect(JSON.parse(String(fetch.mock.calls[1]![1].body))).toEqual(input);
  });
});

describe("target detail: usage and change history", () => {
  it("accepts the documented shape", () => { expect(parseTargetDetail(detail(), "profile.save")).toEqual(detail()); });
  it("accepts no usage and no changes", () => { expect(parseTargetDetail({ ...detail(), usage: { drafts: [], published: [] }, changes: [] })?.changes).toEqual([]); });
  it.each([
    ["another id", (d: Record<string, unknown>) => { d.id = "profile.other"; }], ["no usage", (d: Record<string, unknown>) => { delete d.usage; }], ["no changes", (d: Record<string, unknown>) => { delete d.changes; }],
    ["a usage with an extra key", (d: Record<string, unknown>) => { d.usage = { ...usage, extra: [] }; }], ["a draft with a version", (d: Record<string, unknown>) => { d.usage = { ...usage, drafts: [{ id: "wt-0123456789ab", title: "T", version: 1 }] }; }],
    ["a published item without a version", (d: Record<string, unknown>) => { d.usage = { ...usage, published: [{ id: "wt-0123456789ac", title: "T" }] }; }], ["version 0", (d: Record<string, unknown>) => { d.usage = { ...usage, published: [{ id: "wt-0123456789ac", title: "T", version: 0 }] }; }],
    ["a workflow id of another shape", (d: Record<string, unknown>) => { d.usage = { ...usage, drafts: [{ id: "x", title: "T" }] }; }], ["a title with markup", (d: Record<string, unknown>) => { d.usage = { ...usage, drafts: [{ id: "wt-0123456789ab", title: "<b>T</b>" }] }; }],
    ["101 drafts", (d: Record<string, unknown>) => { d.usage = { ...usage, drafts: Array.from({ length: 101 }, (_, i) => ({ id: `wt-${String(i).padStart(12, "0")}`, title: "T" })) }; }],
    ["101 changes", (d: Record<string, unknown>) => { d.changes = Array.from({ length: 101 }, (_, i) => ({ revision: i + 1, changedAt: stamp, changedBy: "m", before: {}, after: {} })); }],
    ["a change with an extra key", (d: Record<string, unknown>) => { d.changes = [{ ...(d.changes as object[])[0], extra: 1 }]; }], ["a change with a control character in changedBy", (d: Record<string, unknown>) => { d.changes = [{ ...(d.changes as object[])[0], changedBy: "a\u0000b" }]; }],
    ["a change by an empty name", (d: Record<string, unknown>) => { d.changes = [{ ...(d.changes as object[])[0], changedBy: "" }]; }], ["a change by a 257 character name", (d: Record<string, unknown>) => { d.changes = [{ ...(d.changes as object[])[0], changedBy: "x".repeat(257) }]; }],
    ["a change with an unknown field", (d: Record<string, unknown>) => { d.changes = [{ ...(d.changes as object[])[0], before: { privacy: "private" } }]; }], ["a change with a bad date", (d: Record<string, unknown>) => { d.changes = [{ ...(d.changes as object[])[0], changedAt: "x" }]; }],
  ])("refuses %s", (_label, change) => { const d = detail() as Record<string, unknown>; change(d); expect(parseTargetDetail(d, "profile.save")).toBeNull(); });
  it("accepts 256 character changedBy, 100 drafts and 100 changes", () => {
    const many = Array.from({ length: 100 }, (_, i) => ({ id: `wt-${String(i).padStart(12, "0")}`, title: "T" }));
    expect(parseUsage({ drafts: many, published: [] })?.drafts).toHaveLength(100);
    const changes = Array.from({ length: 100 }, (_, i) => ({ revision: i + 1, changedAt: stamp, changedBy: "x".repeat(256), before: {}, after: {} }));
    expect(parseTargetDetail({ ...detail(), changes })?.changes).toHaveLength(100);
  });
  it("repair fields: all five, or a subset in a change row", () => {
    expect(parseRepairFields(fields)).toEqual(fields);
    for (const bad of [{ ...fields, extra: 1 }, { ...fields, marker: "x" }, { ...fields, operations: [] }, { ...fields, operations: ["a", "b", "c", "d", "e"] }, { ...fields, label: "x".repeat(81) }, { ...fields, description: "x".repeat(241) }]) expect(parseRepairFields(bad)).toBeNull();
    expect(parseRepairFields({ marker: "profile.submit" }, true)).toEqual({ marker: "profile.submit" });
    expect(parseRepairFields({ marker: "x" }, true)).toBeNull();
  });
});

describe("check and repair replies (session commands)", () => {
  const checked = { page: "/profile", route: "profile", results: [{ targetId: "profile.save", state: "healthy" }, { targetId: "profile.displayName", state: "broken", reason: "not_found" }] };
  it("check: accepts healthy and broken results with the four reasons", () => {
    expect(parseStudioReply("check", checked)).toEqual({ kind: "checked", ...checked });
    for (const reason of ["not_found", "role_changed", "private", "ambiguous"]) expect(parseStudioReply("check", { ...checked, results: [{ targetId: "profile.save", state: "broken", reason }] })).not.toBeNull();
    expect(parseStudioReply("check", { page: null, route: null, results: [] })).toEqual({ kind: "checked", page: null, route: null, results: [] });
  });
  it.each([
    ["an unknown reason", { ...checked, results: [{ targetId: "profile.save", state: "broken", reason: "gone" }] }], ["a reason on a healthy target", { ...checked, results: [{ targetId: "profile.save", state: "healthy", reason: "not_found" }] }],
    ["an unknown state", { ...checked, results: [{ targetId: "profile.save", state: "unverified" }] }], ["a duplicate target", { ...checked, results: [checked.results[0], checked.results[0]] }],
    ["201 results", { ...checked, results: Array.from({ length: 201 }, (_, i) => ({ targetId: `a.t${i}`, state: "healthy" })) }], ["an extra key", { ...checked, extra: 1 }], ["a bad page", { ...checked, page: "/a b" }],
    ["an extra result key", { ...checked, results: [{ targetId: "profile.save", state: "healthy", name: "Save" }] }],
  ])("check: refuses %s", (_label, reply) => { expect(parseStudioReply("check", reply)).toBeNull(); });
  it("check: accepts exactly 200 results", () => { expect(parseStudioReply("check", { ...checked, results: Array.from({ length: 200 }, (_, i) => ({ targetId: `a.t${i}`, state: "healthy" })) })).not.toBeNull(); });

  const preview = { target: view(), current: { ...fields, marker: "profile.save", role: "button" }, proposed: fields, impact };
  it("repair dry run and confirmed repair", () => {
    expect(parseStudioReply("repair", preview, false)).toEqual({ kind: "repairPreview", ...preview });
    expect(parseStudioReply("repair", { target: view(), impact }, true)).toEqual({ kind: "repaired", target: view(), impact });
  });
  it("an incompatible dry run carries problems; a compatible one carries none", () => {
    const bad = { ...impact, compatible: false, problems: ["Workflow \"Draft one\" step 2 no longer has a valid interaction."] };
    expect(parseStudioReply("repair", { ...preview, impact: bad }, false)).toMatchObject({ kind: "repairPreview", impact: { compatible: false } });
    expect(parseStudioReply("repair", { ...preview, impact: { ...impact, compatible: false } }, false)).toBeNull();      // incompatible without a reason
    expect(parseStudioReply("repair", { ...preview, impact: { ...impact, problems: ["x"] } }, false)).toBeNull();       // compatible with a problem
    expect(parseStudioReply("repair", { target: view(), impact: bad }, true)).toBeNull();                              // a confirmed repair is compatible by definition
  });
  it.each([
    ["a dry run reply to a confirmed repair", preview, true], ["a confirmed reply to a dry run", { target: view(), impact }, false], ["an extra key", { ...preview, extra: 1 }, false],
    ["current with an extra key", { ...preview, current: { ...preview.current, name: "x" } }, false], ["proposed missing a field", { ...preview, proposed: { marker: "a.b" } }, false],
    ["21 problems", { ...preview, impact: { ...impact, compatible: false, problems: Array.from({ length: 21 }, () => "p") } }, false], ["a 201 character problem", { ...preview, impact: { ...impact, compatible: false, problems: ["p".repeat(201)] } }, false],
    ["101 published", { ...preview, impact: { ...impact, published: Array.from({ length: 101 }, (_, i) => ({ id: `wt-${String(i).padStart(12, "0")}`, title: "T", version: 1 })) } }, false],
  ])("repair: refuses %s", (_label, reply, confirm) => { expect(parseStudioReply("repair", reply, confirm)).toBeNull(); });
  it("a mismatched candidate has exactly ref, name, role, route, status and targetId", () => {
    const element = { ref: "@e4", name: "Save", role: "link", route: "profile", status: "mismatched", targetId: "profile.save", problem: "role" };
    const snapshot = { url: "http://127.0.0.1:5188/profile", route: "profile", page: "/profile", elements: [element], hidden: 0, truncated: false };
    expect(parseStudioReply("refresh", snapshot)).toMatchObject({ elements: [{ status: "mismatched", targetId: "profile.save" }] });
    for (const bad of [{ ...element, proposal: {} }, { ...element, operations: ["highlight"] }, { ref: "@e4", name: "Save", role: "link", route: "profile", status: "mismatched" }]) expect(parseStudioReply("refresh", { ...snapshot, elements: [bad] })).toBeNull();
  });
  it("typed errors: the repair codes, REPAIR_INCOMPATIBLE with at most 20 problems, nothing else", () => {
    for (const code of ["REPAIR_ROUTE_MISMATCH", "MARKER_IN_USE", "TARGET_NOT_FOUND", "REPAIR_UNCHANGED"]) expect(parseStudioError(409, { error: code })).toEqual({ code });
    expect(parseStudioError(409, { error: "REPAIR_INCOMPATIBLE" })).toEqual({ code: "REPAIR_INCOMPATIBLE" });
    expect(parseStudioError(409, { error: "REPAIR_INCOMPATIBLE", problems: ["a", "b"] })).toEqual({ code: "REPAIR_INCOMPATIBLE", issues: ["a", "b"] });
    for (const bad of [[409, { error: "REPAIR_INCOMPATIBLE", problems: Array.from({ length: 21 }, () => "p") }], [409, { error: "REPAIR_INCOMPATIBLE", problems: ["x".repeat(201)] }], [422, { error: "REPAIR_INCOMPATIBLE" }],
      [409, { error: "REPAIR_INCOMPATIBLE", problems: ["a"], extra: 1 }], [409, { error: "MARKER_IN_USE", problems: ["a"] }], [503, { error: "REPAIR_UNCHANGED" }], [409, { error: "REPAIR_UNCHANGED", message: "extra" }], [409, { error: "SOMETHING_ELSE" }]] as const) expect(parseStudioError(bad[0], bad[1])).toBeNull();
  });
});

describe("checks (S4)", () => {
  const name = (n: string) => `check.v${n.padStart(10, "0")}`;
  const rows = [
    { name: name("a1"), kind: "route.equals", targetId: null, route: "profile", attribute: null, expected: null },
    { name: name("a2"), kind: "element.visible", targetId: "profile.save", route: null, attribute: null, expected: null },
    { name: name("a3"), kind: "element.hidden", targetId: "profile.save", route: null, attribute: null, expected: null },
    { name: name("a4"), kind: "element.text.equals", targetId: "profile.savedStatus", route: null, attribute: null, expected: "Saved" },
    { name: name("a5"), kind: "element.value.equals", targetId: "profile.displayName", route: null, attribute: null, expected: "Ada" },
    { name: name("a6"), kind: "element.attribute.equals", targetId: "settings.advancedToggle", route: null, attribute: "aria-expanded", expected: "true" },
  ].map(row => ({ ...row, status: "active", references: { drafts: 0, published: 1 } }));
  it("accepts every kind with exactly its own fields", () => { for (const row of rows) expect(parseCheckView(row)).toEqual(row); expect(parseCheckList({ checks: rows })).toHaveLength(6); });
  it.each([
    ["a field the kind does not use (route on a text check)", (r: Record<string, unknown>[]) => { r[3]!.route = "profile"; }], ["a missing field of the kind", (r: Record<string, unknown>[]) => { r[3]!.expected = null; }],
    ["an unknown kind", (r: Record<string, unknown>[]) => { r[0]!.kind = "script.run"; }], ["a name without the check.v prefix", (r: Record<string, unknown>[]) => { r[0]!.name = "route.profile"; }],
    ["an attribute outside the allow-list", (r: Record<string, unknown>[]) => { r[5]!.attribute = "onclick"; }], ["an attribute expected value of 41 characters", (r: Record<string, unknown>[]) => { r[5]!.expected = "x".repeat(41); }],
    ["an expected value of 121 characters", (r: Record<string, unknown>[]) => { r[3]!.expected = "x".repeat(121); }], ["an empty expected value", (r: Record<string, unknown>[]) => { r[3]!.expected = ""; }],
    ["a control character in an expected value", (r: Record<string, unknown>[]) => { r[3]!.expected = "a\nb"; }], ["an extra key", (r: Record<string, unknown>[]) => { r[0]!.extra = 1; }],
    ["an unknown status", (r: Record<string, unknown>[]) => { r[0]!.status = "gone"; }], ["negative references", (r: Record<string, unknown>[]) => { r[0]!.references = { drafts: -1, published: 0 }; }],
    ["a duplicate name", (r: Record<string, unknown>[]) => { r[1]!.name = r[0]!.name; }],
  ])("refuses %s", (_label, change) => { const copy = rows.map(row => ({ ...row })) as Record<string, unknown>[]; change(copy); expect(parseCheckList({ checks: copy })).toBeNull(); });
  it("accepts 120 and 40 character expected values and refuses 101 checks", () => {
    expect(parseCheckView({ ...rows[3], expected: "x".repeat(120) })).not.toBeNull();
    expect(parseCheckView({ ...rows[5], expected: "x".repeat(40) })).not.toBeNull();
    const many = Array.from({ length: 101 }, (_, i) => ({ ...rows[0], name: name(i.toString(16)) }));
    expect(parseCheckList({ checks: many })).toBeNull();
    expect(parseCheckList({ checks: many.slice(0, 100) })).toHaveLength(100);
  });
  it("the request body carries only the fields of the kind", () => {
    expect(checkBody({ kind: "route.equals", route: "profile", targetId: "x.y" })).toEqual({ kind: "route.equals", route: "profile" });
    expect(checkBody({ kind: "element.visible", targetId: "profile.save", expected: "x" })).toEqual({ kind: "element.visible", targetId: "profile.save" });
    expect(checkBody({ kind: "element.text.equals", targetId: "profile.savedStatus", expected: "Saved" })).toEqual({ kind: "element.text.equals", targetId: "profile.savedStatus", expected: "Saved" });
    expect(checkBody({ kind: "element.attribute.equals", targetId: "a.b", attribute: "aria-expanded", expected: "true" })).toEqual({ kind: "element.attribute.equals", targetId: "a.b", attribute: "aria-expanded", expected: "true" });
    for (const bad of [{ kind: "route.equals" }, { kind: "element.text.equals", targetId: "a.b" }, { kind: "element.attribute.equals", targetId: "a.b", attribute: "onclick", expected: "x" }, { kind: "element.visible" }, { kind: "bogus" }, { kind: "element.text.equals", targetId: "a.b", expected: "x".repeat(121) }]) expect(checkBody(bad as never)).toBeNull();
  });
});

describe("client calls (S3/S4)", () => {
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
  const setup = () => { const fetch = vi.fn<FetchLike>(); return { fetch, client: createAdminClient({ fetch, role: "maintainer" }) }; };
  it("targetDetail, setTargetHealth, checks, createCheck and setCheckStatus use their paths and bodies and refuse a different reply", async () => {
    const { fetch, client } = setup();
    fetch.mockResolvedValueOnce(json(detail()));
    expect(await client.targetDetail(app, "profile.save")).toMatchObject({ kind: "ok" });
    expect(fetch.mock.calls.at(-1)![0]).toBe(`/api/admin/applications/${app}/targets/profile.save`);
    fetch.mockResolvedValueOnce(json({ ...detail(), id: "profile.other" }));
    expect(await client.targetDetail(app, "profile.save")).toEqual({ kind: "failed" });
    fetch.mockResolvedValueOnce(json({ ...view(), health: "broken" }));
    expect(await client.setTargetHealth(app, "profile.save", "broken")).toMatchObject({ kind: "ok" });
    expect(fetch.mock.calls.at(-1)![0]).toBe(`/api/admin/applications/${app}/targets/profile.save/health`);
    expect(JSON.parse(String(fetch.mock.calls.at(-1)![1].body))).toEqual({ state: "broken" });
    fetch.mockResolvedValueOnce(json({ ...view(), health: "healthy" }));
    expect(await client.setTargetHealth(app, "profile.save", "broken")).toEqual({ kind: "failed" });           // the reply must say what was asked
    expect(await client.setTargetHealth(app, "profile.save", "healthy" as never)).toEqual({ kind: "failed" });  // the client can never report healthy
    expect(fetch).toHaveBeenCalledTimes(4);
    const row = { name: "check.v00000000a1", kind: "route.equals", targetId: null, route: "profile", attribute: null, expected: null, status: "active", references: { drafts: 0, published: 0 } };
    fetch.mockResolvedValueOnce(json({ checks: [row] }));
    expect(await client.checks(app)).toMatchObject({ kind: "ok" });
    fetch.mockResolvedValueOnce(json(row));
    expect(await client.createCheck(app, { kind: "route.equals", route: "profile" })).toMatchObject({ kind: "ok" });
    expect(JSON.parse(String(fetch.mock.calls.at(-1)![1].body))).toEqual({ kind: "route.equals", route: "profile" });
    fetch.mockResolvedValueOnce(json({ ...row, route: "settings" }));
    expect(await client.createCheck(app, { kind: "route.equals", route: "profile" })).toEqual({ kind: "failed" });
    fetch.mockResolvedValueOnce(json({ ...row, status: "disabled" }));
    expect(await client.setCheckStatus(app, row.name, "disabled")).toMatchObject({ kind: "ok" });
    expect(fetch.mock.calls.at(-1)![0]).toBe(`/api/admin/applications/${app}/checks/check.v00000000a1/status`);
    const before = fetch.mock.calls.length;
    expect(await client.createCheck(app, { kind: "element.text.equals", targetId: "a.b" })).toEqual({ kind: "failed" });     // no request for an invalid input
    expect(await client.setCheckStatus(app, "check.x", "active")).toEqual({ kind: "failed" });
    expect(await client.targetDetail("app-x", "profile.save")).toEqual({ kind: "failed" });
    expect(fetch.mock.calls.length).toBe(before);
  });
  it("studio repair sends the dry-run/confirm flag and parses the matching reply; an incompatible confirm surfaces its problems", async () => {
    const { fetch, client } = setup();
    const command = { action: "repair" as const, sessionId: "s1", applicationId: app, targetId: "profile.save", ref: "@e4", operations: ["highlight", "click"], label: "Save", description: "Saves", confirm: false };
    fetch.mockResolvedValueOnce(json({ target: view(), current: fields, proposed: fields, impact }));
    expect(await client.studio!(command)).toMatchObject({ kind: "ok", value: { kind: "repairPreview" } });
    expect(JSON.parse(String(fetch.mock.calls.at(-1)![1].body))).toEqual(command);
    fetch.mockResolvedValueOnce(json({ target: view(), impact }));
    expect(await client.studio!({ ...command, confirm: true })).toMatchObject({ kind: "ok", value: { kind: "repaired" } });
    fetch.mockResolvedValueOnce(json({ target: view(), impact }));
    expect(await client.studio!(command)).toEqual({ kind: "failed" });                                   // a confirmed-shaped reply to a dry run is refused
    fetch.mockResolvedValueOnce(json({ error: "REPAIR_INCOMPATIBLE", problems: ["Step 2 of Draft one no longer validates."] }, 409));
    expect(await client.studio!({ ...command, confirm: true })).toEqual({ kind: "browser-error", code: "REPAIR_INCOMPATIBLE", issues: ["Step 2 of Draft one no longer validates."] });
  });
});

it("reads a managed registry with its checks and all 120 postconditions, keeping the built-in shape unchanged", async () => {
  const { parseApplicationRegistry } = await import("./applications.js");
  const routes = Array.from({ length: 20 }, (_, index) => `route${index}`);
  const checks = Array.from({ length: 100 }, (_, index) => ({
    name: `check.v${index.toString(16).padStart(10, "0")}`, kind: "route.equals", route: routes[index % routes.length],
    targetId: null, attribute: null, expected: null, status: "active", references: { drafts: 0, published: 0 },
  }));
  const names = [...routes.map(route => `route.${route}`), ...checks.map(item => item.name)];
  const managed = { routes, elements: [], postconditionNames: names, source: "studio-managed", previewMode: "application-window", previewable: true,
    pages: Object.fromEntries(routes.map(route => [`/#/${route}`, route])), checks };
  const parsed = parseApplicationRegistry(managed);
  expect(parsed?.checks).toEqual(checks);
  expect(parsed?.postconditionNames).toEqual(names);
  expect(parseApplicationRegistry({ ...managed, postconditionNames: [...names, "check.vfffffffffe"] })).toBeNull();
  expect(parseApplicationRegistry({ routes: ["home"], elements: [], postconditionNames: ["route.home"], source: "built-in",
    previewMode: "in-app", previewable: true, pages: { "/": "home" } })?.checks).toEqual([]);
});

it("carries history paths through snapshot, registration, target listing and registry replies", async () => {
  const { parseApplicationRegistry } = await import("./applications.js");
  const page = "/profile";
  const target = { ...view(), page };
  const route = { route: "profile", page };
  const candidate = { ref: "@e1", name: "Save", role: "button", route: null, status: "registrable",
    proposal: { targetId: target.id, role: "button", page, route: "profile", routeIsNew: true, suggestedLabel: "Save",
      allowedOperations: ["highlight", "click"], defaultOperations: ["highlight", "click"], privacy: "public" } };
  const snapshot = { url: "http://127.0.0.1:5188/profile", route: null, page, elements: [candidate], hidden: 0, truncated: false };
  expect(parseStudioReply("refresh", snapshot)).toMatchObject({ kind: "snapshot", elements: [candidate] });
  expect(parseStudioReply("register", { target, route: { ...route, created: true } })).toMatchObject({ kind: "registered", target });
  expect(parseTargetList({ targets: [target], routes: [route], limits: { maxTargets: 200, maxRoutes: 20 } })).toMatchObject({ routes: [route] });
  expect(parseApplicationRegistry({ routes: ["profile"], elements: [], postconditionNames: ["route.profile"], source: "studio-managed",
    previewMode: "application-window", previewable: true, pages: { "/profile": "profile" }, checks: [] })?.pages).toEqual({ "/profile": "profile" });
  expect(parseTargetView({ ...target, page: "/" + "p".repeat(199) })).not.toBeNull();
  for (const invalid of ["/" + "p".repeat(200), "/profile/", "/profile?tab=1", "//profile", "/profile/../settings"]) {
    expect(parseTargetView({ ...target, page: invalid })).toBeNull();
  }
});
