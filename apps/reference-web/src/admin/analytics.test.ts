import { afterEach, expect, it, vi } from "vitest";
import { boot } from "../browser.js";
import { copy } from "../copy.js";
import { createAdminClient } from "./client.js";

const c = copy.admin;
const summary = { totals: { started: 2, completed: 1, cancelled: 1, completionRate: 50 }, guides: [
  { id: "profileUpdate", title: "Update your profile name", started: 2, completed: 1, cancelled: 1, completionRate: 50 },
] };
const empty = { totals: { started: 0, completed: 0, cancelled: 0, completionRate: null }, guides: [] };
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status });
let handle: Awaited<ReturnType<typeof boot>> | undefined;
afterEach(() => { handle?.destroy(); document.body.replaceChildren(); vi.useRealTimers(); });
const turn = () => vi.advanceTimersByTimeAsync(10);
async function setup(analytics: () => Response | Promise<Response>) {
  vi.useFakeTimers();
  window.history.replaceState(null, "", "#/analytics");
  const root = document.createElement("div"); document.body.append(root);
  handle = await boot(root, { fetch: async path => path === "/api/admin/analytics" ? analytics() : json({ walkthroughs: [] }) });
  return root;
}

it("announces loading, then shows zero starts, no rate and empty copy", async () => {
  let reply!: (response: Response) => void;
  const root = await setup(() => new Promise(resolve => { reply = resolve; }));
  expect(root.querySelector("[role=status]")?.textContent).toBe(c.loading);
  reply(json(empty)); await turn();
  expect(root.textContent).toContain(c.usage.empty);
  expect([...root.querySelectorAll(".usage-metrics p")].map(p => p.textContent)).toEqual(["0", "0", "0", "—"]);
  expect(root.querySelector("table")).toBeNull();
});

it("shows the reported values, explanatory note and a table with actual scoped headers", async () => {
  const root = await setup(() => json(summary)); await turn();
  expect(root.textContent).toContain(c.usage.note);
  expect([...root.querySelectorAll(".usage-metrics p")].map(p => p.textContent)).toEqual(["2", "1", "1", "50%"]);
  expect(root.querySelector("table caption")?.textContent).toBe(c.usage.caption);
  expect(root.querySelectorAll("thead th[scope=col]")).toHaveLength(5);
  expect(root.querySelector("tbody th[scope=row]")?.textContent).toBe(summary.guides[0]!.title);
  expect([...root.querySelectorAll("tbody td")].map(p => p.textContent)).toEqual(["2", "1", "1", "50%"]);
});

it("retries safe failures and displays a separate denied state without metrics", async () => {
  const fetch = vi.fn(() => json({ message: "Private host details" }, 403));
  fetch.mockReturnValueOnce(json({ message: "Private host details" }, 503));
  const root = await setup(fetch); await turn();
  expect(root.textContent).toContain(c.usage.failed);
  const retry = [...root.querySelectorAll("button")].find(b => b.textContent === c.usage.retry)!;
  retry.click(); await turn();
  expect(root.textContent).toContain(c.denied);
  expect(root.textContent).not.toContain("Private host details");
  expect(root.querySelector(".usage-metrics")).toBeNull();
});

it("rejects extra fields and invalid metrics from the API", async () => {
  const client = (answer: unknown) => createAdminClient({ fetch: async () => json(answer) });
  expect(await client({ ...summary, password: "canary" }).analytics()).toEqual({ kind: "failed" });
  expect(await client({ ...summary, totals: { ...summary.totals, cancelled: 3 } }).analytics()).toEqual({ kind: "failed" });
  expect(await client({ ...summary, guides: [] }).analytics()).toEqual({ kind: "failed" });
  expect(await client({ ...summary, guides: [...summary.guides, ...summary.guides] }).analytics()).toEqual({ kind: "failed" });
  expect(await client({ ...empty, totals: { ...empty.totals, completionRate: 0 } }).analytics()).toEqual({ kind: "failed" });
});
