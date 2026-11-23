import { expect, it, vi } from "vitest";
import { WALKTHROUGHS } from "../walkthroughs/index.js";
import { createAdminClient } from "./client.js";
import type { FetchLike } from "../help/client.js";

const id = "wt-000000000001";
const def = { ...WALKTHROUGHS[0]!, id };
const appId = "app-000000000001";
const valid = { definition: def, id, status: "draft", applicationId: appId };
const response = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

it("uses same-origin paths and the demo role header, without permissions, and refuses mismatched edits before fetch", async () => {
  const fetch = vi.fn<FetchLike>(async () => response(valid));
  const client = createAdminClient({ fetch, role: "maintainer" });
  expect(await client.update("wt-000000000002", appId, def)).toEqual({ kind: "failed" });
  expect(fetch).not.toHaveBeenCalled();
  expect(await client.create(appId, def)).toEqual({ kind: "ok", value: valid });
  const [url, init] = fetch.mock.calls[0]!;
  expect(url).toBe("/api/admin/walkthroughs");
  expect(init).toMatchObject({ method: "POST", credentials: "same-origin", redirect: "error",
    headers: { "X-Demo-Role": "maintainer", accept: "application/json", "content-type": "application/json" } });
  const { title, description, steps, start } = def;
  expect(JSON.parse(init.body as string)).toEqual({ applicationId: appId, definition: { title, description, steps, start } });
  expect(JSON.parse(init.body as string).definition).not.toHaveProperty("id");
  expect(await client.update(id, appId, def)).toEqual({ kind: "ok", value: valid });
  expect(fetch.mock.calls[1]?.[0]).toBe(`/api/admin/walkthroughs/${id}`);
});

it("refuses unknown fields and contradictory or malformed response shapes", async () => {
  const fetch = vi.fn<FetchLike>();
  const client = createAdminClient({ fetch, role: "user" });
  fetch.mockResolvedValueOnce(response({ authored: [], builtIn: [], permissions: [] }));
  expect(await client.list()).toEqual({ kind: "failed" });
  fetch.mockResolvedValueOnce(response({ ...valid, id: "wt-000000000002" }));
  expect(await client.get(id)).toEqual({ kind: "failed" });
  fetch.mockResolvedValueOnce(response({ ...valid, definition: { ...def, steps: [{ kind: "complete", id: "done", text: "Done", extra: true }] } }));
  expect(await client.get(id)).toEqual({ kind: "failed" });
  fetch.mockResolvedValueOnce(response({ walkthroughs: [def, { ...def, foreignField: 1 }] }));
  expect(await client.published()).toEqual({ kind: "ok", value: [def] });
});

it("classifies read denials, write failures, size and update conflicts without returning error copy", async () => {
  const fetch = vi.fn<FetchLike>();
  const client = createAdminClient({ fetch, role: "user" });
  fetch.mockResolvedValueOnce(response({ message: "internal" }, 401)).mockResolvedValueOnce(response({}, 403));
  expect(await client.list()).toEqual({ kind: "denied" });
  expect(await client.get(id)).toEqual({ kind: "denied" });
  fetch.mockResolvedValueOnce(response({ message: "internal" }, 403)).mockResolvedValueOnce(response({}, 413))
    .mockResolvedValueOnce(response({ kind: "invalid", message: "fixed", issues: ["definition: too large to save"] }, 422))
    .mockResolvedValueOnce(response({}, 409)).mockResolvedValueOnce(response({}, 409));
  expect(await client.create(appId, def)).toEqual({ kind: "failed" });
  expect(await client.create(appId, def)).toEqual({ kind: "oversize" });
  expect(await client.create(appId, def)).toEqual({ kind: "oversize" });
  expect(await client.update(id, appId, def)).toEqual({ kind: "published" });
  expect(await client.setStatus(id, "published")).toEqual({ kind: "failed" });
});

it("bounds the reply and aborts and settles even an unresponsive fetch", async () => {
  const big = createAdminClient({ fetch: async () => response({ authored: [], builtIn: [], padding: "x".repeat(1_000_000) }), role: "user" });
  expect(await big.list()).toEqual({ kind: "failed" });
  const fetch = vi.fn<FetchLike>(() => new Promise(() => {}));
  const slow = createAdminClient({ fetch, role: "user", timeoutMs: 5 });
  expect(await slow.list()).toEqual({ kind: "failed" });
  expect(fetch.mock.calls[0]?.[1].signal?.aborted).toBe(true);
});
