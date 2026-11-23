import type { WalkthroughDef } from "@dap/walkthrough";
import { expect, it, vi } from "vitest";
import { createAdminClient } from "./client.js";
import { compareWorkflows } from "./compare.js";
import { parsePublishReview, parseVersions } from "./publishing.js";

const id = "wt-000000000001";
const app = "app-000000000001";
const path = `/api/admin/walkthroughs/${id}`;
const definition: WalkthroughDef = { id, title: "Profile tour", description: "Change a name.", start: "guide", steps: [
  { id: "guide", kind: "guide", target: "profile.name", wait: "input", text: "Change your name.", verify: "route.profile", next: "done" },
  { id: "done", kind: "complete", text: "Saved." },
] };
const summary = {
  application: { id: app, name: "Profile" }, title: definition.title, steps: 2,
  targets: { healthy: 1, unverified: 0, broken: 0, disabled: 0 },
  verification: { steps: 1, withVerify: 1 }, currentVersion: 1, nextVersion: 2,
};
const diagnostic = { code: "TARGET_BROKEN", message: "Check this target", stepIndex: 0, targetId: "profile.name" };
const review = { ok: true, blockers: [], warnings: [diagnostic], summary };
const version = { version: 1, publishedAt: "2026-11-20T00:00:00.000Z", publishedBy: "Maintainer", stepCount: 2, live: true };
const response = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });

it("accepts review warnings on a publishable workflow and blockers on a non-publishable workflow", () => {
  expect(parsePublishReview(review)).toEqual(review);
  const blocked = { ...review, ok: false, blockers: [diagnostic], summary: { ...summary, title: "", currentVersion: null, nextVersion: 1 } };
  expect(parsePublishReview(blocked)).toEqual(blocked);
});

it.each([
  { ...review, blockers: [diagnostic] },
  { ...review, ok: false },
  { ...review, warnings: [{ ...diagnostic, stepIndex: 2 }] },
  { ...review, warnings: [{ ...diagnostic, extra: "anything" }] },
  { ...review, warnings: [{ ...diagnostic, message: "x".repeat(201) }] },
  { ...review, warnings: Array(101).fill(diagnostic) },
  { ...review, summary: { ...summary, application: { ...summary.application, origin: "private" } } },
  { ...review, summary: { ...summary, nextVersion: 1 } },
  { ...review, summary: { ...summary, verification: { steps: 1, withVerify: 2 } } },
])("rejects an inconsistent or out-of-contract review", invalid => expect(parsePublishReview(invalid)).toBeNull());

it("sorts version metadata, permits no history and refuses duplicate versions or multiple live markers", () => {
  const second = { ...version, version: 2, live: false };
  expect(parseVersions({ versions: [version, second] })).toEqual([second, version]);
  expect(parseVersions({ versions: [] })).toEqual([]);
  for (const versions of [[version, version], [version, { ...second, live: true }],
    [{ ...version, publishedAt: "invalid" }], [{ ...version, version: 0 }], [{ ...version, definition }]]) {
    expect(parseVersions({ versions })).toBeNull();
  }
});

it("uses the exact version and review API, and keeps the returned revision and published version", async () => {
  const saved = { id, applicationId: app, status: "draft", definition, revision: 5, liveVersion: 1, latestVersion: 1 };
  const fetch = vi.fn().mockResolvedValueOnce(response(review)).mockResolvedValueOnce(response({ versions: [version] }))
    .mockResolvedValueOnce(response({ ...version, definition })).mockResolvedValueOnce(response(saved)).mockResolvedValueOnce(response(saved))
    .mockResolvedValueOnce(response({ ...saved, status: "published", revision: 6, liveVersion: 2, latestVersion: 2, version: 2 }));
  const client = createAdminClient({ fetch, role: "maintainer" });
  expect(await client.review(id)).toEqual({ kind: "ok", value: review });
  expect(await client.versions(id)).toEqual({ kind: "ok", value: [version] });
  expect(await client.version(id, 1)).toEqual({ kind: "ok", value: { ...version, definition } });
  expect(await client.revise(id)).toEqual({ kind: "ok", value: saved });
  expect(await client.restore(id, 1)).toEqual({ kind: "ok", value: saved });
  expect(await client.setStatus(id, "published")).toMatchObject({ kind: "ok", value: { version: 2, revision: 6 } });
  expect(fetch.mock.calls.map(([url, init]) => [url, init.method, init.body])).toEqual([
    [`${path}/review`, "POST", "{}"], [`${path}/versions`, "GET", undefined], [`${path}/versions/1`, "GET", undefined],
    [`${path}/revise`, "POST", "{}"], [`${path}/restore`, "POST", '{"version":1}'], [`${path}/status`, "POST", '{"status":"published"}'],
  ]);
});

it("rejects version details for a different workflow or wrong version and a publish reply without a version", async () => {
  const fetch = vi.fn().mockResolvedValueOnce(response({ ...version, definition: { ...definition, id: "wt-000000000002" } }))
    .mockResolvedValueOnce(response({ ...version, version: 2, definition }))
    .mockResolvedValueOnce(response({ id, status: "published", applicationId: app, definition, revision: 2, liveVersion: 1, latestVersion: 1 }));
  const client = createAdminClient({ fetch });
  expect(await client.version(id, 0)).toEqual({ kind: "failed" });
  expect(await client.restore("../foreign", 1)).toEqual({ kind: "failed" });
  expect(fetch).not.toHaveBeenCalled();
  expect(await client.version(id, 1)).toEqual({ kind: "failed" });
  expect(await client.version(id, 1)).toEqual({ kind: "failed" });
  expect(await client.setStatus(id, "published")).toEqual({ kind: "failed" });
});

it("compares metadata, target/verification changes and step order by identity", () => {
  const guide = definition.steps[0]!;
  if (guide.kind !== "guide") throw new Error("expected guide");
  const extra = { ...guide, id: "second", text: "An extra step." };
  const before = { ...definition, steps: [guide, extra, definition.steps[1]!] };
  const after = { ...definition, title: "New title", steps: [extra, { ...guide, target: "profile.submit", verify: "check.v0000000001" }, { ...extra, id: "new" }] };
  const diff = compareWorkflows(before, after);
  expect(diff.metadata).toEqual([{ field: "Title", before: "Profile tour", after: "New title" }]);
  expect(diff.steps).toEqual([
    { id: "second", kind: "updated", moved: true, before: 2, after: 1, fields: [] },
    { id: "guide", kind: "updated", moved: true, before: 1, after: 2, fields: [
      { field: "Target", before: "profile.name", after: "profile.submit" },
      { field: "Verification", before: "route.profile", after: "check.v0000000001" },
    ] },
    { id: "new", kind: "added", moved: false, after: 3, fields: [] },
    { id: "done", kind: "removed", moved: false, before: 3, fields: [] },
  ]);
  expect(compareWorkflows(before, { ...before, steps: [extra, definition.steps[1]!] }).steps.map(item => item.id)).toEqual(["guide"]);
  expect(compareWorkflows(before, structuredClone(before))).toEqual({ metadata: [], steps: [] });
});

it("lets the review summary wrap on narrow screens without fixed-width columns", async () => {
  const { readFileSync } = await import("node:fs");
  const css = readFileSync("apps/reference-web/src/styles/app.css", "utf8");
  expect(css).toMatch(/\.publish-summary \{[^}]*repeat\(auto-fit, minmax\(min\(var\(--full\), 10rem\), 1fr\)\)/u);
  expect(css).toMatch(/\.publish-review, \.workflow-versions \{[^}]*overflow-wrap: anywhere/u);
});
