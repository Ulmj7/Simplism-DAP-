import { describe, expect, it, vi } from "vitest";
import { createAgentBrowserAdapter } from "./agent-browser-adapter.js";
import { BrowserRuntimeError } from "./errors.js";
import { normalizeSnapshot } from "./snapshot.js";

const url = "http://127.0.0.1:5173/";
// Hostnames de-duplicate to the former "localhost,127.0.0.1" CLI allow-list, so the existing assertions are unchanged.
const origins = ["http://localhost:5173", "http://127.0.0.1:5173"];
const labels = [{ role: "link", name: "Profile" }, { role: "textbox", name: "Display name" }];
// Excerpt from agent-browser 0.43.0's captured Profile JSON plus privacy/disabled fixtures.
const profile = {
  origin: url + "#/profile",
  refs: {
    e6: { role: "link", name: "Profile" },
    e26: { role: "textbox", name: "Display name" },
    e27: { role: "textbox", name: "Email" },
    e28: { role: "textbox", name: "Display name" },
    e29: { role: "textbox", name: "token-canary-not-for-the-model" },
    e31: { role: "link", name: "Profile" },
  },
  snapshot: [
    '  - link "Profile" [ref=e6]',
    '- textbox "Display name" [ref=e26]: value-canary-not-for-the-model',
    '- textbox "Email" [ref=e27]: email-canary@example.test',
    '- textbox "Display name" [disabled, ref=e28]',
    '- textbox "token-canary-not-for-the-model" [ref=e29]',
  ].join("\n"),
};

const reply = (data: unknown) => JSON.stringify({ success: true, data, error: null });

function fixture() {
  const state = { snapshot: profile };
  const run = vi.fn(async (args: readonly string[]) => {
    if (args.includes("snapshot")) return reply(state.snapshot);
    if (args.includes("highlight")) return reply({ highlighted: args.at(-1) });
    if (args.includes("get")) return reply({ url: state.snapshot.origin });
    return reply({ visible: true, enabled: true, origin: state.snapshot.origin });
  });
  const runtime = createAgentBrowserAdapter({ labels, routes: ["/", "/#/profile"], origins }, run);
  return { runtime, run, state };
}

describe("snapshot normalization", () => {
  it("returns approved visible elements without form values, private labels, disabled controls or ref-only metadata", () => {
    expect(normalizeSnapshot(profile, labels)).toEqual([
      { ref: "@e6", role: "link", name: "Profile" },
      { ref: "@e26", role: "textbox", name: "Display name" },
    ]);
  });

  it.each([{}, { ...profile, snapshot: "not a snapshot" }, { ...profile, refs: { "e-1": {} } }])("refuses unusable output", data => {
    expect(() => normalizeSnapshot(data, labels)).toThrow(BrowserRuntimeError);
  });
});

describe("adapter", () => {
  it("requires an active session and supports explicit close", async () => {
    const { runtime } = fixture();
    await expect(runtime.snapshot()).rejects.toMatchObject({ code: "BROWSER_NOT_STARTED" });
    await runtime.start({ url });
    await runtime.close();
    await expect(runtime.snapshot()).rejects.toMatchObject({ code: "SESSION_CLOSED" });
  });

  it.each(["https://example.invalid/", "http://127.0.0.1@example.invalid/", "ftp://localhost/", url + "?token=canary"])("rejects disallowed start URL %s without a CLI call", async value => {
    const { runtime, run } = fixture();
    await expect(runtime.start({ url: value })).rejects.toMatchObject({ code: "DOMAIN_BLOCKED" });
    expect(run).not.toHaveBeenCalled();
  });

  it("rejects navigation outside the approved app origin even on loopback", async () => {
    const { runtime, state } = fixture();
    await runtime.start({ url });
    state.snapshot = { ...profile, origin: "http://127.0.0.1:5174/" };
    await expect(runtime.snapshot()).rejects.toMatchObject({ code: "DOMAIN_BLOCKED" });
  });

  it("guides only a fresh present ref and passes the loopback restriction to all commands", async () => {
    const { runtime, run, state } = fixture();
    await runtime.start({ url });
    let snapshot = await runtime.snapshot();
    await expect(runtime.highlight("@e99", snapshot)).rejects.toMatchObject({ code: "REF_NOT_FOUND" });
    snapshot = await runtime.snapshot();
    state.snapshot = { ...profile, snapshot: profile.snapshot.replace("value-canary-not-for-the-model", "another value") };
    await expect(runtime.highlight("@e26", snapshot)).rejects.toMatchObject({ code: "REF_NOT_FOUND" });
    snapshot = await runtime.snapshot();
    await runtime.highlight("@e26", snapshot);
    expect(run).toHaveBeenCalledWith(expect.arrayContaining(["highlight", "@e26"]), 5_000);
    expect(run.mock.calls.every(([args]) => args.includes("localhost,127.0.0.1"))).toBe(true);
  });

  it("refuses a previous snapshot even when the browser reuses the ref", async () => {
    const { runtime, run } = fixture();
    await runtime.start({ url });
    const old = await runtime.snapshot();
    const current = await runtime.snapshot();
    await expect(runtime.highlight("@e6", old)).rejects.toMatchObject({ code: "REF_NOT_FOUND" });
    expect(run.mock.calls.some(([args]) => args.includes("highlight"))).toBe(false);
    await runtime.highlight("@e6", current);
  });

  it("observes value changes without returning either value", async () => {
    const { runtime, state } = fixture();
    await runtime.start({ url });
    const snapshot = await runtime.snapshot();
    state.snapshot = { ...profile, snapshot: profile.snapshot.replace("value-canary-not-for-the-model", "another value") };
    await expect(runtime.waitForChange()).resolves.toEqual({ status: "changed", snapshot });
    await expect(runtime.waitForChange({ timeoutMs: 0 })).resolves.toEqual({ status: "timeout" });
  });

  it("maps subprocess errors and timeout without reflecting raw output", async () => {
    const { runtime, run } = fixture();
    await runtime.start({ url });
    run.mockRejectedValueOnce(new Error("nonzero secret-canary"));
    await expect(runtime.snapshot()).rejects.toMatchObject({
      code: "SNAPSHOT_FAILED", message: "The browser snapshot could not be captured.",
    });
    run.mockRejectedValueOnce(new BrowserRuntimeError("BROWSER_TIMEOUT"));
    await expect(runtime.snapshot()).rejects.toMatchObject({ code: "BROWSER_TIMEOUT" });
    run.mockResolvedValueOnce("{");
    await expect(runtime.snapshot()).rejects.toMatchObject({ code: "INVALID_BROWSER_OUTPUT" });
  });
});

const flagValue = (args: readonly string[], flag: string) => args[args.indexOf(flag) + 1];
const routes = ["/", "/#/profile"];
const attributes: Record<string, string> = { "@e6": "nav.profile", "@e26": "profile.nameInput" };

// A fake CLI that also answers `get attr`, with every reply naming the page it came from.
function browser(allowed: readonly string[] = ["http://127.0.0.1:5173"], page: { origin: string; refs: Record<string, unknown>; snapshot: string } = profile) {
  const state = {
    page,
    attribute: (ref: string): string => reply({ origin: state.page.origin, value: attributes[ref] ?? null }),
  };
  const run = vi.fn(async (args: readonly string[]) => {
    if (args.includes("snapshot")) return reply(state.page);
    if (args.includes("attr")) return state.attribute(args.at(-2) as string);
    if (args.includes("get")) return reply({ url: state.page.origin });
    if (args.includes("highlight")) return reply({ highlighted: args.at(-1) });
    if (args.includes("is")) return reply({ visible: true, enabled: true, origin: state.page.origin });
    return reply({});
  });
  const runtime = createAgentBrowserAdapter({ labels, routes, origins: allowed }, run);
  return { runtime, run, state };
}
const at = (origin: string) => ({ ...profile, origin: origin + "#/profile" });

describe("origin configuration", () => {
  it("takes the CLI allow-list from the unique hostnames of the origins and keeps scheme and port for DAP", async () => {
    const run = vi.fn<(args: readonly string[], timeout: number) => Promise<string>>(async () => reply({ origin: url, url }));
    const runtime = createAgentBrowserAdapter({
      labels, routes, origins: ["http://127.0.0.1:5173", "http://127.0.0.1:5174", "https://app.example.test", "https://app.example.test:8443"],
    }, run);
    await runtime.start({ url });
    expect(run.mock.calls.length).toBeGreaterThan(0);
    for (const [args] of run.mock.calls as unknown as [readonly string[]][]) {
      expect(flagValue(args, "--allowed-domains")).toBe("127.0.0.1,app.example.test");
    }
  });

  it("accepts one to five origins including https and a bracketed IPv6 loopback", async () => {
    const run = vi.fn<(args: readonly string[], timeout: number) => Promise<string>>(async () => reply({ origin: "http://[::1]:5173/", url: "http://[::1]:5173/" }));
    const runtime = createAgentBrowserAdapter({ labels, routes, origins: ["http://[::1]:5173"] }, run);
    await runtime.start({ url: "http://[::1]:5173/" });
    expect(flagValue(run.mock.calls[0]![0] as unknown as readonly string[], "--allowed-domains")).toBe("[::1]");
    const five = ["http://a.test", "https://a.test", "http://b.test:8080", "https://c.test", "http://d.test"];
    expect(() => createAgentBrowserAdapter({ labels, routes, origins: five }, run)).not.toThrow();
  });

  const secret = "secret-canary-not-for-the-model";
  it.each<[string, unknown]>([
    ["missing", undefined],
    ["not an array", "http://127.0.0.1:5173"],
    ["empty", []],
    ["six origins", ["http://a.test", "http://b.test", "http://c.test", "http://d.test", "http://e.test", "http://f.test"]],
    ["non-string entry", [5173]],
    ["null entry", [null]],
    ["empty string", [""]],
    ["no scheme", ["127.0.0.1:5173"]],
    ["scheme relative", ["//127.0.0.1:5173"]],
    ["not a url", ["not a url " + secret]],
    ["javascript:", ["javascript:alert(1)"]],
    ["data:", ["data:text/html," + secret]],
    ["file:", ["file:///etc/passwd"]],
    ["ftp:", ["ftp://127.0.0.1"]],
    ["ws:", ["ws://127.0.0.1:5173"]],
    ["credentials", [`http://user:${secret}@127.0.0.1:5173`]],
    ["username only", [`http://${secret}@127.0.0.1:5173`]],
    ["trailing slash", ["http://127.0.0.1:5173/"]],
    ["path", ["http://127.0.0.1:5173/app"]],
    ["query", ["http://127.0.0.1:5173?" + secret]],
    ["hash", ["http://127.0.0.1:5173#" + secret]],
    ["upper-case host", ["http://LOCALHOST:5173"]],
    ["default port spelled out", ["http://127.0.0.1:80"]],
    ["wildcard host", ["https://*.example.com"]],
    ["wildcard inside a label", ["https://ex*ample.com"]],
    ["comma in the host", ["https://a,b.example.com"]],
    ["comma-injected second host", ["https://a.com,evil.com"]],
    ["semicolon in the host", ["https://a;b.example.com"]],
    ["percent-encoded star", ["https://exa%2Ample.com"]],
    ["empty label", ["https://a..example.com"]],
    ["leading hyphen", ["https://-a.example.com"]],
    ["underscore", ["https://a_b.example.com"]],
    ["duplicate origin", ["http://127.0.0.1:5173", "http://127.0.0.1:5173"]],
    ["one bad among good", ["http://127.0.0.1:5173", "javascript:alert(1)"]],
  ])("refuses %s at creation with a fixed TypeError, without a CLI call or echoing the input", (_name, value) => {
    const run = vi.fn();
    let thrown: unknown;
    try { createAgentBrowserAdapter({ labels, routes, origins: value as never }, run); }
    catch (error) { thrown = error; }
    expect(thrown).toBeInstanceOf(TypeError);
    expect((thrown as Error).message).toMatch(/^origins must /u);
    expect((thrown as Error).message).not.toContain(secret);
    expect(run).not.toHaveBeenCalled();
  });

  it("copies the configuration so later caller mutation cannot widen the policy", async () => {
    const list = ["http://127.0.0.1:5173"];
    const run = vi.fn<(args: readonly string[], timeout: number) => Promise<string>>(async () => reply({ origin: "http://127.0.0.1:5174/" }));
    const runtime = createAgentBrowserAdapter({ labels, routes, origins: list }, run);
    list.push("http://127.0.0.1:5174");
    await expect(runtime.start({ url: "http://127.0.0.1:5174/" })).rejects.toMatchObject({ code: "DOMAIN_BLOCKED" });
    expect(run).not.toHaveBeenCalled();
  });
});

describe("navigation policy from the configured origins", () => {
  it("lets a session observe a second configured origin and still blocks an unlisted port", async () => {
    const { runtime, state } = browser(["http://127.0.0.1:5173", "http://127.0.0.1:5174"]);
    await runtime.start({ url });
    state.page = at("http://127.0.0.1:5174/");
    await expect(runtime.snapshot()).resolves.toMatchObject({ url: "http://127.0.0.1:5174/#/profile" });
    await expect(runtime.getUrl()).resolves.toBe("http://127.0.0.1:5174/#/profile");
    state.page = at("http://127.0.0.1:5175/");
    await expect(runtime.snapshot()).rejects.toMatchObject({ code: "DOMAIN_BLOCKED" });
  });

  it("starts on any configured origin and refuses a start URL on an unlisted origin of an allowed host", async () => {
    const second = browser(["http://127.0.0.1:5173", "http://127.0.0.1:5174"], at("http://127.0.0.1:5174/"));
    await expect(second.runtime.start({ url: "http://127.0.0.1:5174/" })).resolves.toBeUndefined();
    const other = browser();
    await expect(other.runtime.start({ url: "http://127.0.0.1:5199/" })).rejects.toMatchObject({ code: "DOMAIN_BLOCKED" });
    expect(other.run).not.toHaveBeenCalled();
  });

  it.each([
    ["a different host", "http://localhost:5173/#/profile"],
    ["a different port", "http://127.0.0.1:5174/#/profile"],
    ["https for an http origin", "https://127.0.0.1:5173/#/profile"],
    ["credentials", "http://user:secret-canary@127.0.0.1:5173/#/profile"],
    ["a username only", "http://secret-canary@127.0.0.1:5173/#/profile"],
    ["a route outside the approved routes", "http://127.0.0.1:5173/#/admin"],
    ["a path outside the approved routes", "http://127.0.0.1:5173/admin#/profile"],
    ["a search string", "http://127.0.0.1:5173/?token=canary#/profile"],
    ["a search string on the root route", "http://127.0.0.1:5173/?x=1"],
    ["a userinfo host trick", "http://127.0.0.1:5173@example.invalid/#/profile"],
    ["javascript:", "javascript:alert(1)"],
    ["data:", "data:text/html,secret-canary"],
    ["file:", "file:///etc/passwd"],
    ["ftp:", "ftp://127.0.0.1/"],
    ["about:blank", "about:blank"],
    ["a browser error page", "chrome-error://chromewebdata/"],
    ["an unparsable URL", "not a url"],
  ])("blocks %s returned by the browser on every read path", async (_name, value) => {
    const { runtime, state } = browser();
    await runtime.start({ url });
    const blocked = { code: "DOMAIN_BLOCKED", message: "The browser URL is outside the approved app origin." };
    // A failed snapshot() forgets the previous one, so each ref-based path starts from a fresh good snapshot.
    const good = async () => {
      state.page = profile;
      const snapshot = await runtime.snapshot();
      state.page = { ...profile, origin: value };
      return snapshot;
    };
    state.page = { ...profile, origin: value };
    await expect(runtime.snapshot()).rejects.toMatchObject(blocked);
    await expect(runtime.getUrl()).rejects.toMatchObject(blocked);
    await good();
    await expect(runtime.waitForChange({ timeoutMs: 50 })).rejects.toMatchObject(blocked);
    await expect(runtime.highlight("@e6", await good())).rejects.toMatchObject(blocked);
    await expect(runtime.inspectSemanticId("@e6", await good())).rejects.toMatchObject(blocked);
    await expect(runtime.inspectSemanticIds(await good())).rejects.toMatchObject(blocked);
  });

  it.each(["javascript:alert(1)", "data:text/html,x", "file:///etc/passwd", "ftp://127.0.0.1/", "https://127.0.0.1:5173/"])(
    "refuses start URL %s without a CLI call", async value => {
      const { runtime, run } = browser();
      await expect(runtime.start({ url: value })).rejects.toMatchObject({ code: "DOMAIN_BLOCKED" });
      expect(run).not.toHaveBeenCalled();
    });

  it("blocks an attribute, visibility or highlight reply that names an unapproved page", async () => {
    const { runtime, state } = browser();
    await runtime.start({ url });
    const snapshot = await runtime.snapshot();
    state.attribute = () => reply({ origin: "http://127.0.0.1:5174/#/profile", value: "nav.profile" });
    await expect(runtime.inspectSemanticId("@e6", snapshot)).rejects.toMatchObject({ code: "DOMAIN_BLOCKED" });
    state.attribute = () => reply({ value: "nav.profile" });
    await expect(runtime.inspectSemanticId("@e6", snapshot)).rejects.toMatchObject({ code: "INVALID_BROWSER_OUTPUT" });
  });

  it("applies the same configured allow-list to every command", async () => {
    const { runtime, run } = browser(["http://127.0.0.1:5173", "http://localhost:5173"]);
    await runtime.start({ url });
    const snapshot = await runtime.snapshot();
    await runtime.inspectSemanticId("@e6", snapshot);
    await runtime.inspectSemanticIds(snapshot);
    await runtime.highlight("@e6", snapshot);
    await runtime.getUrl();
    await runtime.close();
    expect(run.mock.calls.length).toBeGreaterThan(8);
    expect(run.mock.calls.every(([args]) => flagValue(args, "--allowed-domains") === "127.0.0.1,localhost")).toBe(true);
  });
});

describe("batch semantic id inspection", () => {
  const attrCalls = (run: ReturnType<typeof browser>["run"]) =>
    run.mock.calls.filter(([args]) => args.includes("attr")).map(([args]) => args.at(-2));

  it("observes once, then reads one attribute per candidate", async () => {
    const { runtime, run } = browser();
    await runtime.start({ url });
    const snapshot = await runtime.snapshot();
    run.mockClear();
    const ids = await runtime.inspectSemanticIds(snapshot);
    expect([...ids]).toEqual([["@e6", "nav.profile"], ["@e26", "profile.nameInput"]]);
    expect(run.mock.calls.filter(([args]) => args.includes("snapshot"))).toHaveLength(1);
    expect(attrCalls(run)).toEqual(["@e6", "@e26"]);
    expect(run).toHaveBeenCalledWith(expect.arrayContaining(["get", "attr", "@e6", "data-ai-id"]), 5_000);
  });

  it("agrees with the single-element read", async () => {
    const { runtime } = browser();
    await runtime.start({ url });
    const snapshot = await runtime.snapshot();
    const ids = await runtime.inspectSemanticIds(snapshot);
    for (const { ref } of snapshot.elements) expect(ids.get(ref)).toBe(await runtime.inspectSemanticId(ref, snapshot));
  });

  it("rejects every candidate when the page changed since the snapshot, before any attribute read", async () => {
    const { runtime, run, state } = browser();
    await runtime.start({ url });
    const snapshot = await runtime.snapshot();
    state.page = { ...profile, snapshot: profile.snapshot.replace("value-canary-not-for-the-model", "another value") };
    run.mockClear();
    await expect(runtime.inspectSemanticIds(snapshot)).rejects.toMatchObject({ code: "REF_NOT_FOUND" });
    expect(attrCalls(run)).toEqual([]);
  });

  it("refuses a snapshot that is no longer the latest one, and one taken before any snapshot", async () => {
    const { runtime, run } = browser();
    await expect(runtime.inspectSemanticIds({ url, elements: [] })).rejects.toMatchObject({ code: "BROWSER_NOT_STARTED" });
    await runtime.start({ url });
    await expect(runtime.inspectSemanticIds({ url, elements: [] })).rejects.toMatchObject({ code: "REF_NOT_FOUND" });
    const old = await runtime.snapshot();
    await runtime.snapshot();
    run.mockClear();
    await expect(runtime.inspectSemanticIds(old)).rejects.toMatchObject({ code: "REF_NOT_FOUND" });
    expect(run).not.toHaveBeenCalled();
  });

  it("maps an unreadable or unusable element to null and keeps the other candidates", async () => {
    const { runtime, state } = browser();
    await runtime.start({ url });
    const snapshot = await runtime.snapshot();
    state.attribute = ref => ref === "@e6" ? JSON.stringify({ success: false, data: null, error: "gone secret-canary" })
      : reply({ origin: state.page.origin, value: "profile.nameInput" });
    expect([...await runtime.inspectSemanticIds(snapshot)]).toEqual([["@e6", null], ["@e26", "profile.nameInput"]]);
    for (const value of [null, 7, "", "1bad", "has space", "x".repeat(81), "<script>"]) {
      state.attribute = ref => reply({ origin: state.page.origin, value: ref === "@e6" ? value : "profile.nameInput" });
      expect([...await runtime.inspectSemanticIds(snapshot)]).toEqual([["@e6", null], ["@e26", "profile.nameInput"]]);
    }
    state.attribute = ref => ref === "@e6" ? "{" : reply({ origin: state.page.origin, value: "profile.nameInput" });
    expect([...await runtime.inspectSemanticIds(snapshot)]).toEqual([["@e6", null], ["@e26", "profile.nameInput"]]);
  });

  it("treats navigation during the batch as drift for the whole call and a policy violation as blocked", async () => {
    const { runtime, state } = browser(["http://127.0.0.1:5173", "http://127.0.0.1:5174"]);
    await runtime.start({ url });
    const snapshot = await runtime.snapshot();
    state.attribute = ref => ref === "@e6" ? reply({ origin: state.page.origin, value: "nav.profile" })
      : reply({ origin: "http://127.0.0.1:5174/#/profile", value: "profile.nameInput" });
    await expect(runtime.inspectSemanticIds(snapshot)).rejects.toMatchObject({ code: "REF_NOT_FOUND" });
    state.attribute = () => reply({ origin: "http://127.0.0.1:5175/#/profile", value: "nav.profile" });
    await expect(runtime.inspectSemanticIds(snapshot)).rejects.toMatchObject({ code: "DOMAIN_BLOCKED" });
  });

  it("aborts on a browser timeout instead of reporting the remaining candidates as unknown", async () => {
    const { runtime, state } = browser();
    await runtime.start({ url });
    const snapshot = await runtime.snapshot();
    state.attribute = () => { throw new BrowserRuntimeError("BROWSER_TIMEOUT"); };
    await expect(runtime.inspectSemanticIds(snapshot)).rejects.toMatchObject({ code: "BROWSER_TIMEOUT" });
  });

  it("inspects at most 64 candidates and omits the rest", async () => {
    const many = {
      origin: url + "#/profile",
      refs: Object.fromEntries(Array.from({ length: 70 }, (_, index) => [`e${index + 1}`, { role: "link", name: "Profile" }])),
      snapshot: Array.from({ length: 70 }, (_, index) => `- link "Profile" [ref=e${index + 1}]`).join("\n"),
    };
    const { runtime, run, state } = browser(["http://127.0.0.1:5173"], many);
    await runtime.start({ url });
    const snapshot = await runtime.snapshot();
    expect(snapshot.elements).toHaveLength(70);
    state.attribute = () => reply({ origin: many.origin, value: "nav.profile" });
    run.mockClear();
    const ids = await runtime.inspectSemanticIds(snapshot);
    expect(ids.size).toBe(64);
    expect(attrCalls(run)).toHaveLength(64);
    expect(ids.has("@e64")).toBe(true);
    expect(ids.has("@e65")).toBe(false);
  });

  it("is exclusive like every other command", async () => {
    const { runtime, run, state } = browser();
    await runtime.start({ url });
    const snapshot = await runtime.snapshot();
    let release = () => {};
    run.mockImplementationOnce(() => new Promise<string>(resolve => { release = () => resolve(reply(state.page)); }));
    const first = runtime.inspectSemanticIds(snapshot);
    await expect(runtime.getUrl()).rejects.toMatchObject({ code: "BROWSER_BUSY" });
    release();
    await expect(first).resolves.toBeInstanceOf(Map);
  });

  it("does not return page text or form values", async () => {
    const { runtime, state } = browser();
    await runtime.start({ url });
    const snapshot = await runtime.snapshot();
    state.attribute = () => reply({ origin: state.page.origin, value: "profile.nameInput", text: "value-canary-not-for-the-model" });
    const ids = await runtime.inspectSemanticIds(snapshot);
    expect(JSON.stringify([...ids])).not.toContain("canary");
  });
});
