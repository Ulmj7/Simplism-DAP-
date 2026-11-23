import { afterEach, expect, it, vi } from "vitest";
import { mountApp } from "./main.js";
import type { MountedApp } from "./main.js";
import { createUsageClient } from "./usage.js";
import type { UsageEvent } from "./usage.js";
import { WALKTHROUGHS } from "./walkthroughs/index.js";

let app: MountedApp | undefined;
afterEach(() => { app?.destroy(); document.body.replaceChildren(); vi.useRealTimers(); });
const turn = () => vi.advanceTimersByTimeAsync(10);
function setup(custom?: Parameters<typeof mountApp>[1]) {
  vi.useFakeTimers();
  window.history.replaceState(null, "", "#/dashboard");
  const root = document.createElement("div"); document.body.append(root);
  const calls: UsageEvent[] = [];
  const fetch = vi.fn(async (url: string, options: RequestInit) => {
    expect(url).toBe("/api/walkthrough-events");
    expect(options).toMatchObject({ method: "POST", credentials: "same-origin", headers: { "content-type": "application/json" } });
    calls.push(JSON.parse(String(options.body)) as UsageEvent);
    return new Response(null, { status: 204 });
  });
  app = mountApp(root, { usage: createUsageClient(fetch), trustedEventsOnly: false, ...custom });
  return { root, app, calls, fetch };
}

it("reports real start, completion and Esc cancellation once each with separate opaque runs and minimal payloads", async () => {
  const { app: current, root, calls, fetch } = setup();
  expect(current.guides.startWalkthrough("unrecognised").ok).toBe(false);
  expect(fetch).not.toHaveBeenCalled();
  current.router.navigate("profile"); await turn();
  const name = root.querySelector<HTMLInputElement>("#name")!;
  name.value = "Private usage fixture"; name.dispatchEvent(new Event("input", { bubbles: true }));
  current.guides.startWalkthrough("findSecuritySettings"); await turn();
  document.querySelector<HTMLElement>('[data-ai-overlay="ack"]')!.click(); await turn();
  expect(current.runtime.getState().status).toBe("COMPLETED");
  document.querySelector<HTMLButtonElement>("dialog button")!.click();
  current.guides.startWalkthrough("findSecuritySettings"); await turn();
  document.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true })); await turn();
  expect(current.runtime.getState().status).toBe("CANCELLED");
  expect(calls.map(e => e.event)).toEqual(["started", "completed", "started", "cancelled"]);
  expect(calls[0]!.runId).toBe(calls[1]!.runId);
  expect(calls[2]!.runId).toBe(calls[3]!.runId);
  expect(calls[0]!.runId).not.toBe(calls[2]!.runId);
  for (const event of calls) {
    expect(Object.keys(event).sort()).toEqual(["event", "runId", "walkthroughId"]);
    expect(event.runId).toMatch(/^[\da-f-]{36}$/);
    expect(event.walkthroughId).toBe("findSecuritySettings");
  }
  expect(JSON.stringify(calls)).not.toMatch(/Private usage fixture|securityPanel/);
});

it("drops failed and abandoned terminals and allocates a fresh ID on retry", async () => {
  const missing = { id: "blockedTour", title: "Blocked", description: "Settings test.", start: "route", steps: [
    { id: "route", kind: "navigate" as const, route: "settings", next: "target" },
    { id: "target", kind: "guide" as const, text: "Read this.", target: "settings.twoFactorSetup", wait: "ack" as const, targetWaitMs: 20, next: "done" },
    { id: "done", kind: "complete" as const, text: "Done." },
  ] };
  const { app: current, calls } = setup({ walkthroughs: [...WALKTHROUGHS, missing] });
  current.guides.startWalkthrough(missing.id); await vi.advanceTimersByTimeAsync(50);
  expect(current.runtime.getState().status).toBe("FAILED");
  current.guides.startWalkthrough(missing.id); await turn();
  current.destroy(); await turn();
  expect(calls.map(event => event.event)).toEqual(["started", "started"]);
  expect(calls[0]!.runId).not.toBe(calls[1]!.runId);
});

it("does not report a preview even if a reporting client is accidentally supplied", async () => {
  const { calls } = setup({ walkthroughs: [{ ...WALKTHROUGHS[1]!, id: "wt-preview" }], autoStart: "wt-preview" });
  await turn();
  expect(document.querySelector('[data-ai-overlay="ring"]')).not.toBeNull();
  document.querySelector<HTMLElement>('[data-ai-overlay="ack"]')!.click(); await turn();
  expect(calls).toEqual([]);
});


it("delivers a fast terminal only after its in-flight start is acknowledged", async () => {
  vi.useFakeTimers();
  const payload = { walkthroughId: "profileUpdate", runId: window.crypto.randomUUID() };
  let finish!: (res: Response) => void;
  const fetch = vi.fn<(url: string, init: RequestInit) => Promise<Response>>()
    .mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }))
    .mockResolvedValueOnce(new Response(null, { status: 204 }));
  const report = createUsageClient(fetch);
  report({ ...payload, event: "started" });
  report({ ...payload, event: "completed" });
  expect(fetch).toHaveBeenCalledTimes(1);
  finish(new Response(null, { status: 204 })); await turn();
  expect(fetch).toHaveBeenCalledTimes(2);
  expect(JSON.parse(fetch.mock.calls[1]![1].body as string)).toEqual({ ...payload, event: "completed" });
});
