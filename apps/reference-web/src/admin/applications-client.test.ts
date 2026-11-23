import { describe, expect, it, vi } from "vitest";
import type { FetchLike } from "../help/client.js";
import { WALKTHROUGHS } from "../walkthroughs/index.js";
import { parseApplication } from "./applications.js";
import { createAdminClient } from "./client.js";

const appId = "app-0123456789ab";
const application = {
  id: appId, name: "Orders application", origin: "http://127.0.0.1:5185", allowedOrigins: ["http://127.0.0.1:5185", "http://localhost:5185"],
  environment: "test", registryId: "fixture-b", source: "built-in", enabled: true, updatedAt: "2026-11-23T10:00:00.000Z", routing: "hash", runtimeAccess: false, runtimeKey: null, counts: { targets: 0, drafts: 0, published: 0 },
};
const body = { name: application.name, origin: application.origin, allowedOrigins: application.allowedOrigins, environment: "test" as const, registryId: "fixture-b" };
const list = { applications: [application], registries: [{ id: "reference", label: "Reference application", source: "built-in" }, { id: "fixture-b", label: "Fixture application B", source: "built-in" }] };
const element = { id: "orders.submit", route: "orders", role: "button", label: "Submit order", description: "Submits the order", operations: ["highlight", "click"], privacy: "public" };
const registry = { routes: ["home", "orders"], elements: [element], postconditionNames: ["order.submitted"], previewable: false, source: "built-in", pages: {}, previewMode: "in-app" };
const bad = (name: string, value: unknown) => ({ name, value });
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
const wtId = "wt-000000000001";
const def = { ...WALKTHROUGHS[0]!, id: wtId };

function setup(role: "maintainer" | "user" = "maintainer") {
  const fetch = vi.fn<FetchLike>();
  return { fetch, client: createAdminClient({ fetch, role }) };
}

describe("applications requests", () => {
  it("uses the contract paths, methods and exact bodies with the demo role and same-origin credentials", async () => {
    const { fetch, client } = setup();
    fetch.mockResolvedValueOnce(json(list)).mockResolvedValueOnce(json(application)).mockResolvedValueOnce(json(application, 201))
      .mockResolvedValueOnce(json(application)).mockResolvedValueOnce(json({ ...application, enabled: false })).mockResolvedValueOnce(json(registry));
    expect(await client.applications()).toEqual({ kind: "ok", value: list });
    expect(await client.application(appId)).toEqual({ kind: "ok", value: application });
    expect(await client.createApplication(body)).toEqual({ kind: "ok", value: application });
    expect(await client.updateApplication(appId, body)).toEqual({ kind: "ok", value: application });
    expect(await client.setApplicationEnabled(appId, false)).toEqual({ kind: "ok", value: { ...application, enabled: false } });
    const loaded = await client.applicationRegistry(appId);
    expect(loaded.kind).toBe("ok");
    expect(fetch.mock.calls.map(([url, init]) => [init.method, url])).toEqual([
      ["GET", "/api/admin/applications"], ["GET", `/api/admin/applications/${appId}`], ["POST", "/api/admin/applications"],
      ["PUT", `/api/admin/applications/${appId}`], ["POST", `/api/admin/applications/${appId}/status`], ["GET", `/api/admin/applications/${appId}/registry`],
    ]);
    for (const [, init] of fetch.mock.calls) expect(init).toMatchObject({ credentials: "same-origin", redirect: "error", headers: { "X-Demo-Role": "maintainer", accept: "application/json" } });
    expect(JSON.parse(fetch.mock.calls[2]![1].body as string)).toEqual(body);
    expect(Object.keys(JSON.parse(fetch.mock.calls[2]![1].body as string))).toEqual(["name", "origin", "allowedOrigins", "environment", "registryId"]);
    expect(JSON.parse(fetch.mock.calls[3]![1].body as string)).toEqual(body);
    expect(JSON.parse(fetch.mock.calls[4]![1].body as string)).toEqual({ enabled: false });
    expect(fetch.mock.calls[0]![1]).not.toHaveProperty("body");
  });

  it("sends only the five configuration fields whatever else the caller holds", async () => {
    const { fetch, client } = setup();
    fetch.mockResolvedValue(json(application));
    await client.updateApplication(appId, { ...body, id: "app-ffffffffffff", enabled: false, updatedAt: "x", tenantId: "other" } as typeof body);
    expect(JSON.parse(fetch.mock.calls[0]![1].body as string)).toEqual(body);
  });

  it("refuses a malformed application id before any request", async () => {
    const { fetch, client } = setup();
    for (const id of ["", "app-1", "APP-0123456789AB", "../admin", "app-0123456789ab/registry", "wt-0123456789ab"]) {
      expect(await client.application(id)).toEqual({ kind: "failed" });
      expect(await client.updateApplication(id, body)).toEqual({ kind: "failed" });
      expect(await client.setApplicationEnabled(id, true)).toEqual({ kind: "failed" });
      expect(await client.applicationRegistry(id)).toEqual({ kind: "failed" });
    }
    expect(await client.create("app-1", def)).toEqual({ kind: "failed" });
    expect(await client.update(wtId, "x", def)).toEqual({ kind: "failed" });
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("application reply parsing", () => {
  it.each([
    bad("an unknown key", { ...application, tenantId: "t" }),
    bad("a missing key", { ...application, enabled: undefined }),
    bad("a malformed id", { ...application, id: "app-XYZ" }),
    bad("a blank name", { ...application, name: "   " }),
    bad("a long name", { ...application, name: "a".repeat(81) }),
    bad("an origin with a path", { ...application, origin: "http://127.0.0.1:5185/app", allowedOrigins: ["http://127.0.0.1:5185/app"] }),
    bad("an origin with credentials", { ...application, origin: "http://u:p@127.0.0.1:5185", allowedOrigins: ["http://u:p@127.0.0.1:5185"] }),
    bad("a javascript origin", { ...application, origin: "javascript:alert(1)", allowedOrigins: ["javascript:alert(1)"] }),
    bad("allowed origins without the origin", { ...application, allowedOrigins: ["http://localhost:5185"] }),
    bad("duplicate allowed origins", { ...application, allowedOrigins: [application.origin, application.origin] }),
    bad("six allowed origins", { ...application, allowedOrigins: [application.origin, ...[1, 2, 3, 4, 5].map(n => `http://127.0.0.1:${6000 + n}`)] }),
    bad("no allowed origins", { ...application, allowedOrigins: [] }),
    bad("production", { ...application, environment: "production" }),
    bad("a malformed registry id", { ...application, registryId: "no spaces" }),
    bad("a non-boolean enabled", { ...application, enabled: "yes" }),
    bad("an invalid date", { ...application, updatedAt: "yesterday" }),
  ])("refuses a get reply with $name", async ({ value }) => {
    const { fetch, client } = setup();
    fetch.mockResolvedValueOnce(json(value));
    expect(await client.application(appId)).toEqual({ kind: "failed" });
  });

  it("refuses a reply for another application than the one asked for", async () => {
    const { fetch, client } = setup();
    fetch.mockResolvedValueOnce(json({ ...application, id: "app-ffffffffffff" }));
    expect(await client.application(appId)).toEqual({ kind: "failed" });
    fetch.mockResolvedValueOnce(json({ ...application, id: "app-ffffffffffff" }));
    expect(await client.updateApplication(appId, body)).toEqual({ kind: "failed" });
  });

  it("refuses a status reply that does not show the state that was asked for", async () => {
    const { fetch, client } = setup();
    fetch.mockResolvedValueOnce(json({ ...application, enabled: true }));
    expect(await client.setApplicationEnabled(appId, false)).toEqual({ kind: "failed" });
  });

  it.each([
    bad("an unknown key", { ...list, extra: 1 }),
    bad("a missing registries key", { applications: [] }),
    bad("duplicate applications", { ...list, applications: [application, application] }),
    bad("a registry entry with an unknown key", { ...list, registries: [{ id: "reference", label: "x", source: "built-in", secret: 1 }] }),
    bad("duplicate registries", { ...list, registries: [{ id: "a", label: "A", source: "built-in" }, { id: "a", label: "B", source: "built-in" }] }),
    bad("a malformed registry id", { ...list, registries: [{ id: "bad id", label: "A", source: "built-in" }] }),
    bad("a blank registry label", { ...list, registries: [{ id: "a", label: "", source: "built-in" }] }),
    bad("a non-array applications value", { ...list, applications: {} }),
  ])("refuses a list reply with $name", async ({ value }) => {
    const { fetch, client } = setup();
    fetch.mockResolvedValueOnce(json(value));
    expect(await client.applications()).toEqual({ kind: "failed" });
  });

  it("accepts an empty list and bounds the number of applications", async () => {
    const { fetch, client } = setup();
    fetch.mockResolvedValueOnce(json({ applications: [], registries: [] }));
    expect(await client.applications()).toEqual({ kind: "ok", value: { applications: [], registries: [] } });
    const many = Array.from({ length: 51 }, (_, index) => ({ ...application, id: `app-${index.toString(16).padStart(12, "0")}` }));
    fetch.mockResolvedValueOnce(json({ applications: many, registries: [] }));
    expect(await client.applications()).toEqual({ kind: "failed" });
  });
});

describe("application registry reply", () => {
  it("builds a semantic registry from public targets and keeps the postcondition names and the preview flag", async () => {
    const { fetch, client } = setup();
    fetch.mockResolvedValueOnce(json(registry));
    const result = await client.applicationRegistry(appId);
    expect(result.kind).toBe("ok");
    if (result.kind !== "ok") return;
    expect(result.value.registry.routes).toEqual(["home", "orders"]);
    expect(result.value.registry.get("orders.submit")).toMatchObject({ role: "button", privacy: "public" });
    expect(result.value.registry.forRoute("orders").map(item => item.id)).toEqual(["orders.submit"]);
    expect(result.value.postconditionNames).toEqual(["order.submitted"]);
    expect(result.value.previewable).toBe(false);
  });

  it.each([
    bad("a private element", { ...registry, elements: [{ ...element, privacy: "private" }] }),
    bad("a redacted element", { ...registry, elements: [{ ...element, privacy: "redact" }] }),
    bad("an unknown key", { ...registry, tenantId: "t" }),
    bad("a missing previewable flag", { routes: registry.routes, elements: registry.elements, postconditionNames: [] }),
    bad("a non-boolean previewable flag", { ...registry, previewable: "yes" }),
    bad("an element with an unknown key", { ...registry, elements: [{ ...element, selector: "#x" }] }),
    bad("an element on an unknown route", { ...registry, elements: [{ ...element, route: "nowhere" }] }),
    bad("a malformed element id", { ...registry, elements: [{ ...element, id: "Submit" }] }),
    bad("a forbidden element id", { ...registry, elements: [{ ...element, id: "constructor" }] }),
    bad("duplicate element ids", { ...registry, elements: [element, element] }),
    bad("an unknown role", { ...registry, elements: [{ ...element, role: "admin" }] }),
    bad("an unknown operation", { ...registry, elements: [{ ...element, operations: ["highlight", "delete"] }] }),
    bad("no operations", { ...registry, elements: [{ ...element, operations: [] }] }),
    bad("markup in a label", { ...registry, elements: [{ ...element, label: "<b>Submit</b>" }] }),
    bad("markup in a description", { ...registry, elements: [{ ...element, description: "Say \"hi\" & leave" }] }),
    bad("a malformed route", { ...registry, routes: ["Home page"], elements: [] }),
    bad("a duplicate route", { ...registry, routes: ["home", "home"] }),
    bad("a malformed postcondition name", { ...registry, postconditionNames: ["no spaces allowed"] }),
    bad("a duplicate postcondition name", { ...registry, postconditionNames: ["a.b", "a.b"] }),
    bad("more than 200 elements", { ...registry, elements: Array.from({ length: 201 }, (_, index) => ({ ...element, id: `orders.item${index}` })) }),
  ])("refuses a registry reply with $name", async ({ value }) => {
    const { fetch, client } = setup();
    fetch.mockResolvedValueOnce(json(value));
    expect(await client.applicationRegistry(appId)).toEqual({ kind: "failed" });
  });

  it("accepts a registry with no targets and no checks", async () => {
    const { fetch, client } = setup();
    fetch.mockResolvedValueOnce(json({ routes: [], elements: [], postconditionNames: [], previewable: false, source: "built-in", pages: {}, previewMode: "in-app" }));
    expect((await client.applicationRegistry(appId)).kind).toBe("ok");
  });
});

describe("application failures", () => {
  it("maps 404 and 409 bodies that carry an application code, and nothing else, to a typed result", async () => {
    const { fetch, client } = setup();
    fetch.mockResolvedValueOnce(json({ kind: "not_found", message: "HOST-PRIVATE", code: "APPLICATION_NOT_FOUND" }, 404));
    expect(await client.application(appId)).toEqual({ kind: "application", code: "APPLICATION_NOT_FOUND" });
    fetch.mockResolvedValueOnce(json({ kind: "conflict", message: "HOST-PRIVATE", code: "APPLICATION_DISABLED" }, 409));
    expect(await client.create(appId, def)).toEqual({ kind: "application", code: "APPLICATION_DISABLED" });
    fetch.mockResolvedValueOnce(json({ kind: "conflict", code: "APPLICATION_MISMATCH" }, 409));
    expect(await client.update(wtId, appId, def)).toEqual({ kind: "application", code: "APPLICATION_MISMATCH" });
    fetch.mockResolvedValueOnce(json({ kind: "not_found", code: "APPLICATION_NOT_FOUND" }, 404));
    expect(await client.create(appId, def)).toEqual({ kind: "application", code: "APPLICATION_NOT_FOUND" });
    expect(JSON.stringify(await client.applicationRegistry(appId))).not.toContain("HOST-PRIVATE");
  });

  it.each([
    bad("an unknown code", { kind: "conflict", code: "APPLICATION_EXPLODED" }),
    bad("a lowercase code", { kind: "conflict", code: "application_disabled" }),
    bad("a wrong kind", { kind: "invalid", code: "APPLICATION_DISABLED" }),
    bad("an extra key", { kind: "conflict", code: "APPLICATION_DISABLED", detail: "x" }),
    bad("no code", { kind: "conflict" }),
    bad("an array", []),
  ])("does not trust a 409 body with $name", async ({ value }) => {
    const { fetch, client } = setup();
    fetch.mockResolvedValueOnce(json(value, 409));
    expect(await client.create(appId, def)).toEqual({ kind: "failed" });
    fetch.mockResolvedValueOnce(json(value, 409));
    expect(await client.setStatus(wtId, "published")).toEqual({ kind: "failed" });
  });

  it("keeps the older meanings of a bare 409 and treats a bare 404 as a failure", async () => {
    const { fetch, client } = setup();
    fetch.mockResolvedValueOnce(json({}, 409));
    expect(await client.update(wtId, appId, def)).toEqual({ kind: "published" });
    fetch.mockResolvedValueOnce(json({ kind: "conflict", message: "limit" }, 409));
    expect(await client.createApplication(body)).toEqual({ kind: "limit" });
    fetch.mockResolvedValueOnce(json({}, 409));
    expect(await client.updateApplication(appId, body)).toEqual({ kind: "failed" });
    fetch.mockResolvedValueOnce(new Response("not json", { status: 404 }));
    expect(await client.application(appId)).toEqual({ kind: "failed" });
    fetch.mockResolvedValueOnce(json({}, 404));
    expect(await client.application(appId)).toEqual({ kind: "failed" });
  });

  it("treats reads as denied for 401 and 403 and any other status as a failure", async () => {
    const { fetch, client } = setup("user");
    fetch.mockResolvedValueOnce(json({ message: "x" }, 403));
    expect(await client.applications()).toEqual({ kind: "denied" });
    fetch.mockResolvedValueOnce(json({}, 401));
    expect(await client.applicationRegistry(appId)).toEqual({ kind: "denied" });
    fetch.mockResolvedValueOnce(json({}, 500));
    expect(await client.applications()).toEqual({ kind: "failed" });
  });

  it("returns 422 issues as plain strings, capped at 20 of 200 characters, and fails closed on anything beyond", async () => {
    const { fetch, client } = setup();
    const issues = ["name: must not be empty", "origin: must be https unless it is loopback"];
    fetch.mockResolvedValueOnce(json({ kind: "invalid", message: "Invalid application", issues }, 422));
    expect(await client.createApplication(body)).toEqual({ kind: "invalid", issues });
    const full = Array.from({ length: 20 }, (_, index) => `${index}:`.padEnd(200, "x"));
    fetch.mockResolvedValueOnce(json({ kind: "invalid", message: "m", issues: full }, 422));
    expect(await client.updateApplication(appId, body)).toEqual({ kind: "invalid", issues: full });
    for (const tooMany of [[...full, "one more"], ["x".repeat(201)], [""], [7], "text"]) {
      fetch.mockResolvedValueOnce(json({ kind: "invalid", message: "m", issues: tooMany }, 422));
      expect(await client.createApplication(body)).toEqual({ kind: "failed" });
    }
    fetch.mockResolvedValueOnce(json({ kind: "invalid", message: "m", issues, extra: true }, 422));
    expect(await client.createApplication(body)).toEqual({ kind: "failed" });
    fetch.mockResolvedValueOnce(json({ kind: "invalid", message: "m".repeat(201), issues }, 422));
    expect(await client.createApplication(body)).toEqual({ kind: "failed" });
  });
});

describe("walkthrough records carry their application", () => {
  const valid = { id: wtId, status: "draft", applicationId: appId, definition: def };
  it("requires the application id on a record and allows null only for a legacy draft", async () => {
    const { fetch, client } = setup();
    fetch.mockResolvedValueOnce(json(valid));
    expect(await client.get(wtId)).toEqual({ kind: "ok", value: valid });
    fetch.mockResolvedValueOnce(json({ ...valid, applicationId: null }));
    expect(await client.get(wtId)).toEqual({ kind: "ok", value: { ...valid, applicationId: null } });
    for (const applicationId of [undefined, "", "app-1", 7, "wt-000000000001"]) {
      fetch.mockResolvedValueOnce(json({ ...valid, applicationId }));
      expect(await client.get(wtId)).toEqual({ kind: "failed" });
    }
  });

  it("includes the application id (or null) in every list row and refuses a malformed one", async () => {
    const { fetch, client } = setup();
    const row = { id: wtId, title: "T", description: "D", status: "draft", stepCount: 2, updatedAt: "2026-11-20T00:00:00.000Z" };
    fetch.mockResolvedValueOnce(json({ builtIn: [], authored: [{ ...row, applicationId: appId }, { ...row, id: "wt-000000000002", applicationId: null }] }));
    const listed = await client.list();
    expect(listed.kind === "ok" && listed.value.authored.map(item => item.applicationId)).toEqual([appId, null]);
    fetch.mockResolvedValueOnce(json({ builtIn: [], authored: [row] }));
    expect(await client.list()).toEqual({ kind: "failed" });
    fetch.mockResolvedValueOnce(json({ builtIn: [], authored: [{ ...row, applicationId: "nope" }] }));
    expect(await client.list()).toEqual({ kind: "failed" });
  });

  it("sends exactly {applicationId, definition} on create and update, and a create never carries the definition id", async () => {
    const { fetch, client } = setup();
    fetch.mockResolvedValue(json({ ...valid, id: wtId }, 200));
    await client.create(appId, def);
    await client.update(wtId, appId, def);
    const [create, update] = fetch.mock.calls.map(([, init]) => JSON.parse(init.body as string) as Record<string, unknown>);
    expect(Object.keys(create!)).toEqual(["applicationId", "definition"]);
    expect(Object.keys(update!)).toEqual(["applicationId", "definition"]);
    expect(create).toMatchObject({ applicationId: appId });
    expect(create!.definition).not.toHaveProperty("id");
    expect((update!.definition as { id: string }).id).toBe(wtId);
  });
});

it("accepts the integrated host's source, pages, previewMode and external fields without a response shim", async () => {
  const { fetch, client } = setup();
  const managedApp = { ...application, registryId: "studio-managed", source: "studio-managed" };
  const managedList = { applications: [managedApp], registries: [...list.registries,
    { id: "studio-managed", label: "Studio-managed (register targets from the browser)", source: "studio-managed" }] };
  fetch.mockResolvedValueOnce(json(managedList));
  expect(await client.applications()).toEqual({ kind: "ok", value: managedList });
  fetch.mockResolvedValueOnce(json({ ...managedList, applications: [{ ...managedApp, source: "built-in" }] }));
  expect(await client.applications()).toEqual({ kind: "failed" });
  const managedRegistry = { ...registry, source: "studio-managed", pages: { "/": "home", "/#/orders": "orders" }, previewable: true,
    previewMode: "application-window", postconditionNames: ["route.home", "route.orders"] };
  fetch.mockResolvedValueOnce(json(managedRegistry));
  expect(await client.applicationRegistry(appId)).toMatchObject({ kind: "ok", value: managedRegistry });
  for (const invalid of [{ ...managedRegistry, pages: { "/": "unknown" } }, { ...managedRegistry, previewMode: "unknown" }, { ...managedRegistry, routes: ["home", "order-list"], pages: {}, elements: [] }]) {
    fetch.mockResolvedValueOnce(json(invalid));
    expect(await client.applicationRegistry(appId)).toEqual({ kind: "failed" });
  }
  const external = [{ id: wtId, title: def.title, description: def.description, application: { id: appId, name: application.name, origin: application.origin } }];
  fetch.mockResolvedValueOnce(json({ walkthroughs: [def], external }));
  expect(await client.published()).toEqual({ kind: "ok", value: [def] });
  fetch.mockResolvedValueOnce(json({ walkthroughs: [def], external }));
  expect(await client.externalGuides()).toEqual({ kind: "ok", value: external });
});

it("keeps the managed targets wire closed and sends status alone", async () => {
  const { fetch, client } = setup();
  const page = "/#/orders";
  const references = { drafts: 0, published: 1 };
  const target = { ...element, page, status: "active", references, updatedAt: application.updatedAt };
  const reply = { targets: [target], routes: [{ route: target.route, page }], limits: { maxRoutes: 20, maxTargets: 200 } };
  fetch.mockResolvedValueOnce(json(reply));
  expect(await client.targets(appId)).toEqual({ kind: "ok", value: reply });
  for (const invalid of [{ ...reply, limits: { ...reply.limits, maxTargets: 201 } }, { ...reply, routes: [] },
    { ...reply, targets: [target, target] }, { ...reply, targets: [{ ...target, ref: "@e1" }] }, { ...reply, targets: [{ ...target, references: { ...references, drafts: -1 } }] }]) {
    fetch.mockResolvedValueOnce(json(invalid));
    expect(await client.targets(appId)).toEqual({ kind: "failed" });
  }
  fetch.mockResolvedValueOnce(json({ ...target, status: "disabled" }));
  expect(await client.setTargetStatus(appId, target.id, "disabled")).toEqual({ kind: "ok", value: { ...target, status: "disabled" } });
  const [url, request] = fetch.mock.calls.at(-1)!;
  expect(url).toBe(`/api/admin/applications/${appId}/targets/orders.submit/status`);
  expect(request.method).toBe("POST");
  expect(JSON.parse(String(request.body))).toEqual({ status: "disabled" });
});

describe("the ApplicationView parser accepts the Studio completion fields (S2) and nothing looser", () => {
  const KEY = `rk-${"1".repeat(32)}-${"a".repeat(32)}`;
  const view = (patch: Record<string, unknown> = {}) => ({ ...application, ...patch });
  it("parses routing, runtimeAccess, runtimeKey and counts", () => {
    expect(parseApplication(view({ routing: "history", runtimeAccess: true, runtimeKey: KEY, counts: { targets: 3, drafts: 2, published: 1 } }))).toMatchObject({ routing: "history", runtimeAccess: true, runtimeKey: KEY, counts: { targets: 3, drafts: 2, published: 1 } });
    expect(parseApplication(view())).toMatchObject({ routing: "hash", runtimeAccess: false, runtimeKey: null, counts: { targets: 0, drafts: 0, published: 0 } });
  });
  it.each([
    ["a missing field", (v: Record<string, unknown>) => { delete v.routing; }], ["a missing counts", (v: Record<string, unknown>) => { delete v.counts; }], ["an unknown extra field", (v: Record<string, unknown>) => { v.extra = 1; }],
    ["an unknown routing", (v: Record<string, unknown>) => { v.routing = "path"; }], ["a non-boolean runtimeAccess", (v: Record<string, unknown>) => { v.runtimeAccess = "yes"; }],
    ["a key of the old shape", (v: Record<string, unknown>) => { v.runtimeKey = `rk-${"a".repeat(32)}`; }], ["an upper-case key", (v: Record<string, unknown>) => { v.runtimeKey = KEY.toUpperCase(); }],
    ["a key over 80 characters", (v: Record<string, unknown>) => { v.runtimeKey = `${KEY}${"a".repeat(20)}`; }], ["an undefined key", (v: Record<string, unknown>) => { v.runtimeKey = undefined; }],
    ["a negative count", (v: Record<string, unknown>) => { v.counts = { targets: -1, drafts: 0, published: 0 }; }], ["a fractional count", (v: Record<string, unknown>) => { v.counts = { targets: 1.5, drafts: 0, published: 0 }; }],
    ["a count over a million", (v: Record<string, unknown>) => { v.counts = { targets: 1_000_001, drafts: 0, published: 0 }; }], ["counts with an extra key", (v: Record<string, unknown>) => { v.counts = { targets: 0, drafts: 0, published: 0, x: 1 }; }],
    ["counts as an array", (v: Record<string, unknown>) => { v.counts = [0, 0, 0]; }], ["a string count", (v: Record<string, unknown>) => { v.counts = { targets: "1", drafts: 0, published: 0 }; }],
  ])("refuses %s", (_name, mutate) => {
    const value = view(); mutate(value);
    expect(parseApplication(value)).toBeNull();
  });
});
