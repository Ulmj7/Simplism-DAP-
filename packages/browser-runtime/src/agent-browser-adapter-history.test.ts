/**
 * Studio completion S1: `routing: "history"` (with `routes: "any"`). The page of a history-routed application is its PATHNAME: the query and fragment of the observed URL are ignored and never
 * returned, never stored and never a reason to refuse; the pathname must be a static path; the exact origin stays enforced. Hash mode (the default) is unchanged and keeps refusing queries.
 */
import { describe, expect, it, vi } from "vitest";
import { createAgentBrowserAdapter } from "./agent-browser-adapter.js";
import type { AgentBrowserAdapterOptions } from "./agent-browser-adapter.js";

const origin = "http://127.0.0.1:5188";
const reply = (data: unknown) => JSON.stringify({ success: true, data, error: null });
const refused = { code: "DOMAIN_BLOCKED", message: "The browser URL is outside the approved app origin." };
const items = [{ key: "e1", role: "link", name: "Profile" }, { key: "e2", role: "textbox", name: "Display name" }];
const page = (url: string) => ({
  origin: url,
  refs: Object.fromEntries(items.map(item => [item.key, { role: item.role, name: item.name }])),
  snapshot: items.map(item => `- ${item.role} "${item.name}" [ref=${item.key}]`).join("\n"),
});

function harness(options: Partial<AgentBrowserAdapterOptions> = {}, initial = page(origin + "/profile")) {
  const state = { page: initial };
  const run = vi.fn<(args: readonly string[], timeout: number) => Promise<string>>(async args => {
    if (args.includes("snapshot")) return reply(state.page);
    if (args.includes("count")) return reply({ count: 0, selector: "x" });
    if (args.includes("attr")) return reply({ origin: state.page.origin, value: null });
    if (args.includes("get")) return reply({ url: state.page.origin });
    return reply({});
  });
  const runtime = createAgentBrowserAdapter({ labels: "all", routes: "any", routing: "history", origins: [origin], ...options }, run);
  return { runtime, run, state };
}
/** Everything the caller can observe from one session, as one string, to search for canaries. */
const everything = (values: unknown[]) => JSON.stringify(values);

describe('routing: "history" normalises the observed URL to origin + pathname', () => {
  it.each([
    ["/", "/"], ["/profile", "/profile"], ["/profile/", "/profile"], ["/settings/advanced", "/settings/advanced"], ["/users/123", "/users/123"], ["/a/b.c-d_e~f", "/a/b.c-d_e~f"], ["/index.html", "/index.html"],
    ["/profile?variant=moved", "/profile"], ["/profile/?variant=moved", "/profile"], ["/profile#section", "/profile"], ["/profile?x=1#/hash/route", "/profile"], ["/?token=secret-canary", "/"], ["/#access_token=secret-canary", "/"],
    ["/profile?a=b&c=d#e=f", "/profile"], ["/profile?", "/profile"], ["/profile#", "/profile"], ["/profile?%00=%ff#%zz", "/profile"],
  ])("%s is the page %s on every read path", async (observed, page_) => {
    const { runtime, state } = harness();
    await runtime.start({ url: origin + observed });
    state.page = page(origin + observed);
    const snapshot = await runtime.snapshot();
    expect(snapshot.url).toBe(origin + page_);
    await expect(runtime.getUrl()).resolves.toBe(origin + page_);
    await expect(runtime.inspectSemanticIds(snapshot)).resolves.toBeInstanceOf(Map);
    await expect(runtime.inspectElementFacts(["@e2"], snapshot)).resolves.toBeInstanceOf(Map);
    await expect(runtime.highlight("@e1", snapshot).catch((error: unknown) => (error as { code: string }).code)).resolves.not.toBe("DOMAIN_BLOCKED");
  });

  it("never returns, stores or hands to the CLI the query or fragment, even for the start URL", async () => {
    const { runtime, run, state } = harness();
    await runtime.start({ url: origin + "/profile?token=secret-canary#frag-canary" });
    const opened = run.mock.calls.find(([args]) => args.includes("open"))![0];
    expect(opened.at(-1)).toBe(origin + "/profile");
    state.page = page(origin + "/profile?token=secret-canary#frag-canary");
    const snapshot = await runtime.snapshot();
    const url = await runtime.getUrl();
    const change = await runtime.waitForChange({ timeoutMs: 1 });
    expect(everything([snapshot, url, change])).not.toMatch(/secret-canary|frag-canary|token/u);
    expect(Object.keys(snapshot).sort()).toEqual(["elements", "url"]);
  });

  it("a change of query or fragment alone is not a page change; a change of pathname is", async () => {
    const { runtime, state } = harness();
    await runtime.start({ url: origin + "/profile" });
    const first = await runtime.snapshot();
    state.page = page(origin + "/profile?variant=moved#x");
    await expect(runtime.waitForChange({ timeoutMs: 400 })).resolves.toEqual({ status: "timeout" });
    state.page = page(origin + "/settings");
    await expect(runtime.waitForChange({ timeoutMs: 2000 })).resolves.toMatchObject({ status: "changed", snapshot: { url: origin + "/settings" } });
    void first;
  });
});

describe('routing: "history" refuses what is not a static pathname on the enrolled origin', () => {
  const bad: readonly (readonly [string, string])[] = [
    ["a double slash at the start", "//evil"], ["a double slash inside", "/a//b"], ["a trailing double slash", "/a//"], ["only slashes", "//"], ["a percent escape", "/a%2fb"], ["an encoded query char", "/a%3fb"], ["a percent-escaped backslash", "/a%5cb"], ["a non-ASCII path", "/é"], ["a unicode lookalike of a slash", "/a∕b"], ["a fullwidth full stop", "/a．b"], ["a zero-width space", "/a\u200bb"],
    ["a bidi override", "/a\u202eb"], ["a semicolon", "/a;b"], ["an ampersand", "/a&b"], ["an equals sign", "/a=b"], ["a colon", "/a:b"], ["an at sign", "/a@b"], ["a space (escaped by the URL parser)", "/a b"],
    ["a path of 201 characters", "/" + "a".repeat(200)], ["a path of 5000 characters", "/" + "a".repeat(5000)], ["a path of 201 characters with a trailing slash", "/" + "a".repeat(200) + "/"],
  ];
  it.each(bad)("blocks %s on every read path and as a start URL (query and fragment never rescue it)", async (_name, path) => {
    const start = harness();
    await expect(start.runtime.start({ url: origin + path + "?x=1#y" })).rejects.toMatchObject(refused);
    expect(start.run).not.toHaveBeenCalled();
    const { runtime, state } = harness();
    await runtime.start({ url: origin + "/" });
    // A fresh good snapshot before each probe (a refused snapshot discards the previous one), then the browser moves to the hostile URL.
    const fresh = async () => { state.page = page(origin + "/"); const taken = await runtime.snapshot(); state.page = page(origin + path); return taken; };
    await fresh();
    await expect(runtime.snapshot()).rejects.toMatchObject(refused);
    await expect(runtime.getUrl()).rejects.toMatchObject(refused);
    await expect(runtime.inspectSemanticIds(await fresh())).rejects.toMatchObject(refused);
    await expect(runtime.inspectElementFacts(["@e1"], await fresh())).rejects.toMatchObject(refused);
    await expect(runtime.highlight("@e1", await fresh())).rejects.toMatchObject(refused);
  });

  it("keeps the longest accepted path at exactly 200 characters", async () => {
    const { runtime, state } = harness();
    await runtime.start({ url: origin + "/" });
    const path = "/" + "a".repeat(199);
    state.page = page(origin + path);
    await expect(runtime.snapshot()).resolves.toMatchObject({ url: origin + path });
    state.page = page(origin + path + "/");
    await expect(runtime.snapshot()).resolves.toMatchObject({ url: origin + path });
  });

  it("what the URL parser itself resolves (dot segments, tabs) is judged as resolved, exactly as the browser sees it", async () => {
    const { runtime, state } = harness();
    await runtime.start({ url: origin + "/" });
    for (const [observed, expected] of [["/a/../x", "/x"], ["/%2e%2e/x", "/x"], ["/a\tb", "/ab"], ["/a/./b", "/a/b"]] as const) {
      state.page = page(origin + observed);
      await expect(runtime.snapshot()).resolves.toMatchObject({ url: origin + expected });
    }
  });

  it("does not echo a refused URL, path, query or fragment in the error", async () => {
    const { runtime, state } = harness();
    await runtime.start({ url: origin + "/" });
    state.page = page(origin + "//secret-canary?q=secret-canary#secret-canary");
    const error = await runtime.snapshot().catch((thrown: unknown) => thrown as Error);
    expect(`${(error as Error).message} ${JSON.stringify(error)}`).not.toMatch(/secret-canary/u);
  });
});

// The origin policy is the same in both modes: the same hostile URLs as V1A/V1B.
describe('routing: "history" keeps the exact-origin policy (V1A/V1B hostile list)', () => {
  const hostile = [
    ["another port of the allowed host", "http://127.0.0.1:5187/profile"], ["another host", "http://localhost:5188/profile"], ["https for an http origin", "https://127.0.0.1:5188/profile"],
    ["credentials", "http://user:secret-canary@127.0.0.1:5188/profile"], ["a username only", "http://secret-canary@127.0.0.1:5188/profile"], ["a userinfo host trick", "http://127.0.0.1:5188@example.invalid/profile"],
    ["javascript:", "javascript:alert(1)"], ["data:", "data:text/html,secret-canary"], ["file:", "file:///etc/passwd"], ["ftp:", "ftp://127.0.0.1/"], ["about:blank", "about:blank"],
    ["a browser error page", "chrome-error://chromewebdata/"], ["an unparsable URL", "not a url"], ["a trailing-dot host name", "http://localhost.:5188/profile"], ["a query on another origin", "http://127.0.0.1:5187/?x=1"],
  ] as const;
  it.each(hostile)("refuses %s returned by the browser on every read path", async (_name, value) => {
    const { runtime, state } = harness();
    await runtime.start({ url: origin + "/" });
    const fresh = async () => { state.page = page(origin + "/"); const taken = await runtime.snapshot(); state.page = { ...page(origin + "/"), origin: value }; return taken; };
    await fresh();
    await expect(runtime.snapshot()).rejects.toMatchObject(refused);
    await expect(runtime.getUrl()).rejects.toMatchObject(refused);
    await expect(runtime.inspectSemanticIds(await fresh())).rejects.toMatchObject(refused);
    await expect(runtime.inspectElementFacts(["@e1"], await fresh())).rejects.toMatchObject(refused);
    await expect(runtime.highlight("@e1", await fresh())).rejects.toMatchObject(refused);
  });
  it.each(["http://127.0.0.1:5187/", "http://localhost:5188/", "https://127.0.0.1:5188/", "javascript:alert(1)", "data:text/html,x", "file:///etc/passwd", "ftp://127.0.0.1/", "http://user@127.0.0.1:5188/"])(
    "refuses the start URL %s without a CLI call", async value => {
      const { runtime, run } = harness();
      await expect(runtime.start({ url: value })).rejects.toMatchObject({ code: "DOMAIN_BLOCKED" });
      expect(run).not.toHaveBeenCalled();
    });
  it("lets a second enrolled origin through (normalised) and no other one", async () => {
    const { runtime, state } = harness({ origins: [origin, "http://127.0.0.1:5189"] });
    await runtime.start({ url: origin + "/" });
    state.page = page("http://127.0.0.1:5189/profile/?a=1#b");
    await expect(runtime.snapshot()).resolves.toMatchObject({ url: "http://127.0.0.1:5189/profile" });
    state.page = page("http://127.0.0.1:5190/profile");
    await expect(runtime.snapshot()).rejects.toMatchObject(refused);
  });
});

describe("hash mode and explicit route arrays are unchanged", () => {
  const hashed = (options: Partial<AgentBrowserAdapterOptions> = {}) => harness({ routing: undefined, ...options } as Partial<AgentBrowserAdapterOptions>);
  it.each([undefined, "hash"] as const)("routing %j: a query is still refused and a hash page is still the page", async routing => {
    const h = harness({ routing } as Partial<AgentBrowserAdapterOptions>);
    await h.runtime.start({ url: origin + "/#/orders" });
    h.state.page = page(origin + "/#/orders");
    await expect(h.runtime.snapshot()).resolves.toMatchObject({ url: origin + "/#/orders" });
    h.state.page = page(origin + "/?x=1#/orders");
    await expect(h.runtime.snapshot()).rejects.toMatchObject(refused);
    h.state.page = page(origin + "/profile/");
    await expect(h.runtime.snapshot()).resolves.toMatchObject({ url: origin + "/profile/" });
  });
  it("explicit route arrays behave as before", async () => {
    const run = vi.fn<(args: readonly string[], timeout: number) => Promise<string>>(async args => args.includes("snapshot") ? reply(page(origin + "/#/orders")) : args.includes("count") ? reply({ count: 0 }) : reply({ url: origin + "/#/orders" }));
    const runtime = createAgentBrowserAdapter({ labels: "all", routes: ["/#/orders"], origins: [origin] }, run);
    await runtime.start({ url: origin + "/#/orders" });
    await expect(runtime.snapshot()).resolves.toMatchObject({ url: origin + "/#/orders" });
    void hashed;
  });
  it.each([["history", ["/#/orders"]], ["history", undefined], ["wrong", "any"], ["", "any"], [null, "any"], [5, "any"]] as const)("refuses routing %j with routes %j at creation, with a fixed TypeError", (routing, routes) => {
    const run = vi.fn();
    let thrown: unknown;
    try { createAgentBrowserAdapter({ labels: "all", routes: routes as never, routing: routing as never, origins: [origin] }, run); } catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(TypeError);
    expect(run).not.toHaveBeenCalled();
  });
});
