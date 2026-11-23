/**
 * Status and alert regions (Studio completion, SC-W3): the pinned CLI gives them no ref, so labels "all" reads the marker-carrying ones with constant XPath queries (`get count`, then per region
 * `get attr … data-ai-id`, `is visible`, `get text`) and hands them out under synthetic refs that resolve to their selector for one observation. Explicit-label mode never does any of it.
 */
import { describe, expect, it, vi } from "vitest";
import { createAgentBrowserAdapter } from "./agent-browser-adapter.js";
import type { AgentBrowserAdapterOptions } from "./agent-browser-adapter.js";
import { BrowserRuntimeError } from "./errors.js";

const origin = "http://127.0.0.1:5188";
const reply = (data: unknown) => JSON.stringify({ success: true, data, error: null });
const failure = () => JSON.stringify({ success: false, data: null, error: "gone secret-canary" });
const STATUS = '//*[@data-ai-id][@role="status" or self::output]';
const ALERT = '//*[@data-ai-id][@role="alert"]';

interface Region { marker: string | null; text: string; visible?: boolean; attrs?: Record<string, string | null>; gone?: boolean }
interface World { url: string; statuses: Region[]; alerts: Region[]; controls: { key: string; role: string; name: string; marker?: string }[] }

function harness(world: World, options: Partial<AgentBrowserAdapterOptions> = {}) {
  const calls: string[][] = [];
  const regionOf = (selector: string): Region | undefined => {
    const match = /^xpath=\((.+)\)\[(\d+)\]$/u.exec(selector);
    if (!match) return undefined;
    const list = match[1] === STATUS ? world.statuses : match[1] === ALERT ? world.alerts : [];
    return list[Number(match[2]) - 1];
  };
  const run = vi.fn<(args: readonly string[], timeout: number) => Promise<string>>(async args => {
    calls.push([...args]);
    const at = (name: string) => args.indexOf(name);
    if (args.includes("snapshot")) {
      const refs = Object.fromEntries(world.controls.map(item => [item.key, { role: item.role, name: item.name }]));
      return reply({ origin: world.url, refs, snapshot: world.controls.map(item => `- ${item.role} "${item.name}" [ref=${item.key}]`).join("\n") || '- text "x" [ref=e999]' });
    }
    if (args.includes("count")) {
      const selector = args.at(-1)!;
      return reply({ count: selector === `xpath=${STATUS}` ? world.statuses.length : selector === `xpath=${ALERT}` ? world.alerts.length : 0, selector });
    }
    if (args.includes("attr")) {
      const [selector, name] = [args.at(-2)!, args.at(-1)!];
      const region = regionOf(selector);
      if (selector.startsWith("xpath=")) {
        if (!region || region.gone) return failure();
        return reply({ origin: world.url, value: name === "data-ai-id" ? region.marker : region.attrs?.[name] ?? null });
      }
      const control = world.controls.find(item => `@${item.key}` === selector);
      return reply({ origin: world.url, value: name === "data-ai-id" ? control?.marker ?? null : null });
    }
    if (args.includes("visible") || args.includes("enabled")) {
      const selector = args.at(-1)!;
      const region = regionOf(selector);
      if (selector.startsWith("xpath=")) return region && !region.gone ? reply({ origin: world.url, visible: region.visible ?? true }) : failure();
      return reply({ origin: world.url, visible: true, enabled: true });
    }
    if (args.includes("text") && args.includes("get")) {
      const region = regionOf(args.at(-1)!);
      return region && !region.gone ? reply({ origin: world.url, text: region.text }) : failure();
    }
    if (args.includes("highlight")) return reply({ highlighted: args.at(-1) });
    if (args.includes("get") && args.includes("url")) return reply({ url: world.url });
    void at;
    return reply({});
  });
  const runtime = createAgentBrowserAdapter({ labels: "all", routes: "any", routing: "history", origins: [origin], ...options }, run);
  return { runtime, run, calls, world };
}
const base = (): World => ({
  url: `${origin}/profile`,
  controls: [{ key: "e1", role: "heading", name: "Profile" }, { key: "e2", role: "textbox", name: "Display name", marker: "profile.displayName" }, { key: "e3", role: "button", name: "Save", marker: "profile.save" }],
  statuses: [{ marker: "profile.savedStatus", text: "Saved" }], alerts: [],
});
const started = async (world: World, options: Partial<AgentBrowserAdapterOptions> = {}) => {
  const h = harness(world, options);
  await h.runtime.start({ url: world.url });
  const snapshot = await h.runtime.snapshot();
  h.calls.length = 0;
  return { ...h, snapshot };
};

describe("status and alert regions with a marker", () => {
  it("are listed after the controls with a synthetic ref, their role and their text as the name", async () => {
    const { snapshot } = await started(base());
    expect(snapshot.elements).toEqual([
      { ref: "@e1", role: "heading", name: "Profile" }, { ref: "@e2", role: "textbox", name: "Display name" }, { ref: "@e3", role: "button", name: "Save" },
      { ref: "@e900000000", role: "status", name: "Saved" },
    ]);
    expect(snapshot.elements.every(element => /^@e[1-9]\d{0,8}$/u.test(element.ref))).toBe(true);
  });
  it("status regions come first, then alerts, each in document order; <output> counts as a status", async () => {
    const world = base();
    world.statuses = [{ marker: "a.first", text: "One" }, { marker: "a.second", text: "Two" }];
    world.alerts = [{ marker: "a.alert", text: "Boom" }];
    const { snapshot } = await started(world);
    expect(snapshot.elements.slice(3)).toEqual([{ ref: "@e900000000", role: "status", name: "One" }, { ref: "@e900000001", role: "status", name: "Two" }, { ref: "@e900000002", role: "alert", name: "Boom" }]);
  });
  it("only constant arguments: the two XPath expressions, a DAP integer and fixed command words (never caller text)", async () => {
    const h = harness(base());
    await h.runtime.start({ url: `${origin}/profile` });
    h.calls.length = 0;
    await h.runtime.snapshot();
    const selectors = h.calls.flatMap(call => call.filter(arg => arg.startsWith("xpath=")));
    expect(selectors.length).toBeGreaterThan(0);
    const allowed = new Set([`xpath=${STATUS}`, `xpath=${ALERT}`, `xpath=(${STATUS})[1]`]);
    for (const selector of selectors) expect(allowed.has(selector), selector).toBe(true);
    // Every other argument is a fixed word, a flag value of the session, or the DAP-built ref/selector: nothing from the page's text.
    const wordsOnly = h.calls.flat().filter(arg => !arg.startsWith("xpath=") && !arg.startsWith("--") && !/^dap-|^\/|^[a-z0-9-]*$/u.test(arg) && arg !== "127.0.0.1" && !arg.endsWith(".json"));
    expect(wordsOnly).toEqual([]);
    expect(JSON.stringify(h.calls)).not.toContain("Saved");
  });
  it.each([
    ["no marker", { marker: null, text: "Saved" }], ["an invalid marker", { marker: "not a marker", text: "Saved" }], ["a hidden region", { marker: "a.b", text: "Saved", visible: false }],
    ["an empty region", { marker: "a.b", text: "   " }], ["a 121 character text", { marker: "a.b", text: "t".repeat(121) }], ["a control character", { marker: "a.b", text: "bad\u0000text" }],
    ["a bidi override", { marker: "a.b", text: "bidi‮override" }], ["a vanished region", { marker: "a.b", text: "Saved", gone: true }],
  ])("drops %s", async (_label, region) => {
    const world = base(); world.statuses = [region as Region];
    expect((await started(world)).snapshot.elements.filter(element => element.role === "status")).toEqual([]);
  });
  it("collapses whitespace in the text and keeps a 120 character text", async () => {
    const world = base(); world.statuses = [{ marker: "a.b", text: "  Saved\n  just now  " }, { marker: "a.c", text: "t".repeat(120) }];
    expect((await started(world)).snapshot.elements.slice(3).map(element => element.name)).toEqual(["Saved just now", "t".repeat(120)]);
  });
  it("reads at most 32 regions and shares the 512 cap with the controls", async () => {
    const world = base(); world.statuses = Array.from({ length: 40 }, (_, i) => ({ marker: `a.s${i}`, text: `S${i}` }));
    expect((await started(world)).snapshot.elements.filter(element => element.role === "status")).toHaveLength(32);
    const many = base(); many.controls = Array.from({ length: 511 }, (_, i) => ({ key: `e${i + 1}`, role: "button", name: `B${i + 1}` })); many.statuses = [{ marker: "a.one", text: "One" }, { marker: "a.two", text: "Two" }];
    const { snapshot } = await started(many);
    expect(snapshot.elements).toHaveLength(512);
    expect(snapshot.elements.at(-1)).toMatchObject({ role: "status", name: "One" });
  });
  it("is never read in explicit-label mode: no count, no XPath, and no status in the result", async () => {
    const world = base();
    const { snapshot, calls, runtime } = await started(world, { labels: [{ role: "button", name: "Save" }] });
    expect(snapshot.elements).toEqual([{ ref: "@e3", role: "button", name: "Save" }]);
    await runtime.snapshot();
    expect(calls.flat().some(arg => arg.includes("xpath") || arg === "count")).toBe(false);
  });
});

describe("the synthetic ref works for ids, facts and highlight within its observation", () => {
  it("inspectSemanticIds returns the marker through the selector, not through the ref", async () => {
    const { runtime, snapshot, calls } = await started(base());
    const ids = await runtime.inspectSemanticIds(snapshot);
    expect(ids.get("@e900000000" as never)).toBe("profile.savedStatus");
    expect(ids.get("@e3" as never)).toBe("profile.save");
    expect(calls.some(call => call.includes("@e900000000"))).toBe(false);
    expect(calls.some(call => call.includes(`xpath=(${STATUS})[1]`))).toBe(true);
  });
  it("inspectSemanticId and inspectElementFacts resolve it too (facts of a plain region: no type, nothing private)", async () => {
    const { runtime, snapshot } = await started(base());
    await expect(runtime.inspectSemanticId("@e900000000" as never, snapshot)).resolves.toBe("profile.savedStatus");
    const facts = await runtime.inspectElementFacts(["@e900000000" as never], snapshot);
    expect(facts.get("@e900000000" as never)).toEqual({ tagName: null, inputType: null, autocomplete: null, dataAiPrivate: false, dataAiIgnore: false, dataAiRedact: false });
  });
  it("facts report a region marked private, so the host's gate refuses it", async () => {
    const world = base(); world.statuses[0]!.attrs = { "data-ai-private": "" };
    const { runtime, snapshot } = await started(world);
    expect((await runtime.inspectElementFacts(["@e900000000" as never], snapshot)).get("@e900000000" as never)).toMatchObject({ dataAiPrivate: true });
  });
  it("highlight needs it visible (not enabled) and goes through the selector", async () => {
    const { runtime, snapshot, calls } = await started(base());
    await expect(runtime.highlight("@e900000000" as never, snapshot)).resolves.toBeUndefined();
    const sent = calls.filter(call => call.includes(`xpath=(${STATUS})[1]`));
    expect(sent.some(call => call.includes("highlight"))).toBe(true);
    expect(sent.some(call => call.includes("enabled"))).toBe(false);
  });
  it("a changed text, a vanished region or a new region is drift: the old refs are refused", async () => {
    for (const change of [(world: World) => { world.statuses[0]!.text = "Saved again"; }, (world: World) => { world.statuses[0]!.gone = true; }, (world: World) => { world.alerts.push({ marker: "a.alert", text: "Boom" }); }]) {
      const world = base();
      const { runtime, snapshot } = await started(world);
      change(world);
      await expect(runtime.inspectSemanticIds(snapshot)).rejects.toMatchObject({ code: "REF_NOT_FOUND" });
      await expect(runtime.highlight("@e900000000" as never, snapshot)).rejects.toMatchObject({ code: "REF_NOT_FOUND" });
    }
  });
  it("an invented synthetic ref is refused before any command", async () => {
    const { runtime, snapshot, calls } = await started(base());
    await expect(runtime.inspectElementFacts(["@e900000009" as never], snapshot)).rejects.toMatchObject({ code: "REF_NOT_FOUND" });
    expect(calls).toEqual([]);
  });
});

describe("the origin policy holds for every read", () => {
  it("a region read that comes back from another origin aborts the observation with a fixed error and no canary", async () => {
    const world = base();
    const h = harness(world);
    await h.runtime.start({ url: world.url });
    const original = h.run.getMockImplementation()!;
    h.run.mockImplementation(async (args, timeout) => {
      if (args.includes("attr") && args.at(-2)!.startsWith("xpath=")) return reply({ origin: "http://127.0.0.1:5199/secret-canary", value: "profile.savedStatus" });
      return original(args, timeout);
    });
    const error = await h.runtime.snapshot().catch((thrown: unknown) => thrown as Error);
    expect(error).toMatchObject({ code: "DOMAIN_BLOCKED" });
    expect(JSON.stringify(error)).not.toContain("secret-canary");
  });
  it("an unusable count reply is INVALID_BROWSER_OUTPUT", async () => {
    const world = base();
    const h = harness(world);
    await h.runtime.start({ url: world.url });
    const original = h.run.getMockImplementation()!;
    for (const bad of [{ count: "1" }, { count: -1 }, { count: 1.5 }, {}]) {
      h.run.mockImplementation(async (args, timeout) => (args.includes("count") ? reply(bad) : original(args, timeout)));
      await expect(h.runtime.snapshot()).rejects.toMatchObject({ code: "INVALID_BROWSER_OUTPUT" });
    }
  });
  it("a timeout while reading a region is not swallowed", async () => {
    const world = base();
    const h = harness(world);
    await h.runtime.start({ url: world.url });
    const original = h.run.getMockImplementation()!;
    h.run.mockImplementation(async (args, timeout) => { if (args.includes("visible") && args.at(-1)!.startsWith("xpath=")) throw new BrowserRuntimeError("BROWSER_TIMEOUT"); return original(args, timeout); });
    await expect(h.runtime.snapshot()).rejects.toMatchObject({ code: "BROWSER_TIMEOUT" });
  });
});
