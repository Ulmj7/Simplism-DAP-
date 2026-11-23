/**
 * Studio V1B adapter modes: `labels: "all"`, `routes: "any"` and `inspectElementFacts`, against the same kind of fake CLI the V1A tests use. Explicit arrays behave exactly as before
 * (that is the existing agent-browser-adapter.test.ts, unchanged); these tests pin what is new and, above all, that neither mode weakens the origin policy.
 */
import { describe, expect, it, vi } from "vitest";
import { createAgentBrowserAdapter } from "./agent-browser-adapter.js";
import type { AgentBrowserAdapterOptions } from "./agent-browser-adapter.js";
import { BrowserRuntimeError } from "./errors.js";
import { MAX_ALL_ELEMENTS, normalizeSnapshot } from "./snapshot.js";
import type { ElementRef } from "./types.js";

const origin = "http://127.0.0.1:5187";
const reply = (data: unknown) => JSON.stringify({ success: true, data, error: null });
const failure = () => JSON.stringify({ success: false, data: null, error: "gone secret-canary" });

interface Item { key: string; role: string; name?: string; flags?: string; value?: string }
/** A `snapshot -i` reply: the lines give the document order, the refs object gives roles and names only. */
function page(items: readonly Item[], url = origin + "/#/orders") {
  const refs: Record<string, { role: string; name?: string }> = {};
  for (const item of items) refs[item.key] = item.name === undefined ? { role: item.role } : { role: item.role, name: item.name };
  const lines = items.map(item => `- ${item.role}${item.name === undefined ? "" : ` "${item.name}"`} [${item.flags ? item.flags + ", " : ""}ref=${item.key}]${item.value === undefined ? "" : `: ${item.value}`}`);
  return { origin: url, refs, snapshot: lines.join("\n") || "- text \"x\" [ref=e999]" };
}
const operable: Item[] = [
  { key: "e7", role: "link", name: "Orders" },
  { key: "e2", role: "textbox", name: "Order note", value: "value-canary-not-for-the-model" },
  { key: "e10", role: "button", name: "Submit order" },
];

type Options = Partial<AgentBrowserAdapterOptions>;
function harness(options: Options = {}, initial = page(operable)) {
  const state = {
    page: initial,
    attributes: {} as Record<string, Record<string, string | null | undefined>>,
    read: (ref: string, name: string): string => reply({ origin: state.page.origin, value: state.attributes[ref]?.[name] ?? null }),
  };
  const run = vi.fn<(args: readonly string[], timeout: number) => Promise<string>>(async args => {
    if (args.includes("snapshot")) return reply(state.page);
    if (args.includes("count")) return reply({ count: 0, selector: "x" });
    if (args.includes("attr")) return state.read(args.at(-2) as string, args.at(-1) as string);
    if (args.includes("get")) return reply({ url: state.page.origin });
    return reply({});
  });
  const runtime = createAgentBrowserAdapter({ labels: "all", routes: "any", origins: [origin], ...options }, run);
  const attrCalls = () => run.mock.calls.filter(([args]) => args.includes("attr")).map(([args]) => args.slice(args.indexOf("attr") + 1));
  return { runtime, run, state, attrCalls };
}
const started = async (options: Options = {}, initial = page(operable)) => {
  const h = harness(options, initial);
  await h.runtime.start({ url: origin + "/" });
  const snapshot = await h.runtime.snapshot();
  h.run.mockClear();
  return { ...h, snapshot };
};

describe('labels: "all"', () => {
  it("exposes the role and name of every operable control in DOCUMENT order, never a value", () => {
    const data = page(operable);
    // The refs object lists e2 before e10 and e7; the snapshot text (the document) lists e7, e2, e10.
    expect(Object.keys(data.refs)).toEqual(["e7", "e2", "e10"]);
    expect(normalizeSnapshot({ ...data, refs: { e2: data.refs.e2, e10: data.refs.e10, e7: data.refs.e7 } }, "all")).toEqual([
      { ref: "@e7", role: "link", name: "Orders" }, { ref: "@e2", role: "textbox", name: "Order note" }, { ref: "@e10", role: "button", name: "Submit order" },
    ]);
    expect(JSON.stringify(normalizeSnapshot(data, "all"))).not.toContain("canary");
  });

  it("drops what is not an operable, enabled control with a usable name", () => {
    const longest = "n".repeat(120);
    const items: Item[] = [
      { key: "e1", role: "navigation", name: "Main" }, { key: "e2", role: "option", name: "Choice" }, { key: "e3", role: "img", name: "Logo" },
      { key: "e4", role: "button" }, { key: "e5", role: "button", name: "   " }, { key: "e6", role: "button", name: "n".repeat(121) },
      { key: "e7", role: "button", name: "line\nbreak" }, { key: "e8", role: "button", name: "bidi\u202eoverride" }, { key: "e9", role: "button", name: "nul\u0000" },
      { key: "e10", role: "button", name: "Disabled", flags: "disabled" }, { key: "e11", role: "textbox", name: "Read only", flags: "readonly" },
      { key: "e12", role: "button", name: longest }, { key: "e13", role: "checkbox", name: "Gift wrap", flags: "checked=false" }, { key: "e14", role: "combobox", name: "Shipping" },
      { key: "e15", role: "searchbox", name: "Find" }, { key: "e16", role: "r".repeat(41), name: "Odd role" },
    ];
    expect(normalizeSnapshot(page(items), "all").map(element => element.ref)).toEqual(["@e12", "@e13", "@e14", "@e15"]);
  });

  it("also exposes named headings in document order (their name is their text, at most 120 characters), never in explicit-label mode; status and alert have no ref and come from the adapter's XPath reads", () => {
    const items: Item[] = [
      { key: "e1", role: "heading", name: "Orders", flags: "level=1" }, { key: "e2", role: "link", name: "Orders" }, { key: "e3", role: "status", name: "Saved" }, { key: "e4", role: "alert", name: "Could not save" },
      { key: "e5", role: "heading", name: "h".repeat(121) }, { key: "e6", role: "heading" }, { key: "e7", role: "heading", name: "   " }, { key: "e8", role: "heading", name: "bidi\u202eoverride" },
      { key: "e9", role: "heading", name: "h".repeat(120) }, { key: "e10", role: "paragraph", name: "Plain text" }, { key: "e11", role: "StaticText", name: "Saved" }, { key: "e12", role: "heading", name: "No newline\nallowed" },
    ];
    // Even if a CLI ever gave a status or an alert a ref, normalizeSnapshot does not list it: the adapter's own reads are the one source (no duplicates).
    expect(normalizeSnapshot(page(items), "all")).toEqual([{ ref: "@e1", role: "heading", name: "Orders" }, { ref: "@e2", role: "link", name: "Orders" }, { ref: "@e9", role: "heading", name: "h".repeat(120) }]);
    expect(normalizeSnapshot(page(items), [{ role: "link", name: "Orders" }])).toEqual([{ ref: "@e2", role: "link", name: "Orders" }]);
    expect(normalizeSnapshot(page(items), [{ role: "heading", name: "Orders" }, { role: "status", name: "Saved" }])).toEqual([{ ref: "@e1", role: "heading", name: "Orders" }, { ref: "@e3", role: "status", name: "Saved" }]);
  });

  it("shares the 512 cap between controls and text elements", () => {
    const mixed = Array.from({ length: MAX_ALL_ELEMENTS + 10 }, (_, index) => ({ key: `e${index + 1}`, role: index % 2 === 0 ? "heading" : "button", name: `Item ${index + 1}` }));
    expect(normalizeSnapshot(page(mixed), "all")).toHaveLength(MAX_ALL_ELEMENTS);
  });

  it("keeps at most 512 elements and still refuses unusable output", () => {
    const many = Array.from({ length: MAX_ALL_ELEMENTS + 40 }, (_, index) => ({ key: `e${index + 1}`, role: "button", name: `Button ${index + 1}` }));
    const elements = normalizeSnapshot(page(many), "all");
    expect(elements).toHaveLength(MAX_ALL_ELEMENTS);
    expect(elements[0]!.ref).toBe("@e1");
    for (const data of [{}, { ...page(operable), snapshot: "not a snapshot" }, { ...page(operable), refs: { "e-1": {} } }, { ...page(operable), refs: { e1: { role: "button", name: 7 } } }]) {
      expect(() => normalizeSnapshot(data as never, "all")).toThrow(BrowserRuntimeError);
    }
  });

  it("changes the observation digest when the page changes, without ever carrying the change", async () => {
    const { runtime, state, snapshot } = await started();
    state.page = page([{ ...operable[0]! }, { ...operable[1]!, value: "another value" }, operable[2]!]);
    await expect(runtime.inspectSemanticIds(snapshot)).rejects.toMatchObject({ code: "REF_NOT_FOUND" });
  });

  it("works with explicit routes, and explicit labels work with any routes", async () => {
    const withRoutes = harness({ routes: ["/", "/#/orders"] });
    await withRoutes.runtime.start({ url: origin + "/" });
    expect((await withRoutes.runtime.snapshot()).elements).toHaveLength(3);
    const labelled = harness({ labels: [{ role: "link", name: "Orders" }], routes: "any" });
    await labelled.runtime.start({ url: origin + "/deep/page#/x" });
    expect((await labelled.runtime.snapshot()).elements).toEqual([{ ref: "@e7", role: "link", name: "Orders" }]);
  });
});

describe("options are checked at creation", () => {
  it.each([["labels", "ALL"], ["labels", "any"], ["labels", 5], ["labels", null], ["labels", undefined], ["labels", {}], ["routes", "ANY"], ["routes", "all"], ["routes", 5], ["routes", null], ["routes", undefined], ["routes", {}]] as const)(
    "refuses %s = %j with a fixed TypeError and no CLI call", (key, value) => {
      const run = vi.fn();
      let thrown: unknown;
      try { createAgentBrowserAdapter({ labels: "all", routes: "any", origins: [origin], [key]: value } as never, run); } catch (error) { thrown = error; }
      expect(thrown).toBeInstanceOf(TypeError);
      expect((thrown as Error).message).toMatch(new RegExp(`^${key} must be a list of`));
      expect(run).not.toHaveBeenCalled();
    });
});

describe('routes: "any"', () => {
  it.each(["/", "/#/orders", "/#/orders/42", "/deep/page#/x", "/a/b.c-d_e~f#/", "/index.html", "/#", "/#/", "//x"])("accepts the page %s on the enrolled origin", async path => {
    const { runtime, state } = harness();
    await runtime.start({ url: origin + path });
    state.page = page(operable, origin + path);
    await expect(runtime.snapshot()).resolves.toMatchObject({ elements: expect.any(Array) });
    await expect(runtime.getUrl()).resolves.toBe(new URL(origin + path).origin + new URL(origin + path).pathname + new URL(origin + path).hash);
  });

  it.each([
    ["a query on the root", "/?x=1"], ["a query before the hash", "/?token=canary#/orders"], ["a query inside the hash", "/#/orders?token=canary"], ["an access token fragment", "/#access_token=canary"],
    ["a key=value fragment", "/#a=b"], ["a percent escape", "/a%2fb"], ["a percent escape in the hash", "/#/a%20b"], ["a non-ASCII path", "/é"], ["a path of 201 characters", "/" + "a".repeat(200)],
    ["a hash of 201 characters", "/#/" + "a".repeat(199)], ["an ampersand", "/#/a&b"], ["a semicolon", "/a;b"], ["a second hash", "/#/a#b"],
  ])("blocks %s, on every read path and as a start URL", async (_name, path) => {
    const refused = { code: "DOMAIN_BLOCKED", message: "The browser URL is outside the approved app origin." };
    const start = harness();
    await expect(start.runtime.start({ url: origin + path })).rejects.toMatchObject(refused);
    expect(start.run).not.toHaveBeenCalled();
    const { runtime, state, snapshot } = await started();
    state.page = page(operable, origin + path);
    await expect(runtime.snapshot()).rejects.toMatchObject(refused);
    await expect(runtime.getUrl()).rejects.toMatchObject(refused);
    state.page = page(operable);
    const fresh = await runtime.snapshot();
    state.page = page(operable, origin + path);
    await expect(runtime.inspectSemanticIds(fresh)).rejects.toMatchObject(refused);
    state.page = page(operable);
    const again = await runtime.snapshot();
    state.page = page(operable, origin + path);
    await expect(runtime.inspectElementFacts(["@e7"], again)).rejects.toMatchObject(refused);
    state.page = page(operable);
    const third = await runtime.snapshot();
    state.page = page(operable, origin + path);
    await expect(runtime.highlight("@e7", third)).rejects.toMatchObject(refused);
    void snapshot;
  });
});

// Neither mode may weaken the ORIGIN policy: the same hostile URLs as V1A are refused with both modes on.
describe('"all" + "any" keep the exact-origin policy', () => {
  const hostile = [
    ["another port of the allowed host", "http://127.0.0.1:5188/#/orders"], ["another host", "http://localhost:5187/#/orders"], ["https for an http origin", "https://127.0.0.1:5187/#/orders"],
    ["credentials", "http://user:secret-canary@127.0.0.1:5187/#/orders"], ["a username only", "http://secret-canary@127.0.0.1:5187/#/orders"], ["a userinfo host trick", "http://127.0.0.1:5187@example.invalid/#/orders"],
    ["javascript:", "javascript:alert(1)"], ["data:", "data:text/html,secret-canary"], ["file:", "file:///etc/passwd"], ["ftp:", "ftp://127.0.0.1/"], ["about:blank", "about:blank"],
    ["a browser error page", "chrome-error://chromewebdata/"], ["an unparsable URL", "not a url"], ["a search string", "http://127.0.0.1:5187/?x=1#/orders"], ["a trailing-dot host name", "http://localhost.:5187/#/orders"],
  ] as const;

  it.each(hostile)("refuses %s returned by the browser on every read path", async (_name, value) => {
    const blocked = { code: "DOMAIN_BLOCKED", message: "The browser URL is outside the approved app origin." };
    const { runtime, state } = await started();
    const good = async () => { state.page = page(operable); const taken = await runtime.snapshot(); state.page = { ...page(operable), origin: value }; return taken; };
    state.page = { ...page(operable), origin: value };
    await expect(runtime.snapshot()).rejects.toMatchObject(blocked);
    await expect(runtime.getUrl()).rejects.toMatchObject(blocked);
    await expect(runtime.inspectSemanticIds(await good())).rejects.toMatchObject(blocked);
    await expect(runtime.inspectElementFacts(["@e7"], await good())).rejects.toMatchObject(blocked);
    await expect(runtime.highlight("@e7", await good())).rejects.toMatchObject(blocked);
  });

  it.each(["http://127.0.0.1:5188/", "http://localhost:5187/", "https://127.0.0.1:5187/", "javascript:alert(1)", "data:text/html,x", "file:///etc/passwd", "ftp://127.0.0.1/", "http://user@127.0.0.1:5187/"])(
    "refuses the start URL %s without a CLI call", async value => {
      const { runtime, run } = harness();
      await expect(runtime.start({ url: value })).rejects.toMatchObject({ code: "DOMAIN_BLOCKED" });
      expect(run).not.toHaveBeenCalled();
    });

  it("still hands the CLI only the hostnames of the enrolled origins, whatever the modes", async () => {
    const { runtime, run } = harness({ origins: [origin, "https://app.example.test:8443"] });
    await runtime.start({ url: origin + "/" });
    await runtime.snapshot();
    expect(run.mock.calls.every(([args]) => args[args.indexOf("--allowed-domains") + 1] === "127.0.0.1,app.example.test")).toBe(true);
  });

  it("lets a second enrolled origin through and no other one", async () => {
    const { runtime, state } = harness({ origins: [origin, "http://127.0.0.1:5188"] });
    await runtime.start({ url: origin + "/" });
    state.page = page(operable, "http://127.0.0.1:5188/#/home");
    await expect(runtime.snapshot()).resolves.toMatchObject({ url: "http://127.0.0.1:5188/#/home" });
    state.page = page(operable, "http://127.0.0.1:5189/#/home");
    await expect(runtime.snapshot()).rejects.toMatchObject({ code: "DOMAIN_BLOCKED" });
  });
});

describe("inspectElementFacts", () => {
  const facts = (overrides: Partial<Record<string, string | null>> = {}) => ({ type: null, autocomplete: null, "data-ai-private": null, "data-ai-ignore": null, "data-ai-redact": null, ...overrides });

  it("observes once, then reads exactly five constant attributes per ref and returns plain data", async () => {
    const { runtime, run, state, attrCalls, snapshot } = await started();
    state.attributes = { "@e2": facts({ type: "Text ", autocomplete: " Off " }), "@e10": facts({ type: "button", "data-ai-private": "", "data-ai-redact": "x" }), "@e7": facts() };
    const found = await runtime.inspectElementFacts(["@e2", "@e10", "@e7"], snapshot);
    expect([...found]).toEqual([
      ["@e2", { tagName: null, inputType: "text", autocomplete: "off", dataAiPrivate: false, dataAiIgnore: false, dataAiRedact: false }],
      ["@e10", { tagName: null, inputType: "button", autocomplete: null, dataAiPrivate: true, dataAiIgnore: false, dataAiRedact: true }],
      ["@e7", { tagName: null, inputType: null, autocomplete: null, dataAiPrivate: false, dataAiIgnore: false, dataAiRedact: false }],
    ]);
    expect(run.mock.calls.filter(([args]) => args.includes("snapshot"))).toHaveLength(1);
    expect(attrCalls()).toEqual(["@e2", "@e10", "@e7"].flatMap(ref => ["type", "autocomplete", "data-ai-private", "data-ai-ignore", "data-ai-redact"].map(name => [ref, name])));
    expect(run.mock.calls.every(([args]) => args.includes("--allowed-domains"))).toBe(true);
  });

  it("an attribute that is present but empty is true (that is how the marker works), an absent one is false, and the tag name is always null", async () => {
    const { runtime, state, snapshot } = await started();
    state.attributes = { "@e2": facts({ "data-ai-ignore": "", "data-ai-private": "" }) };
    const found = await runtime.inspectElementFacts(["@e2"], snapshot);
    expect(found.get("@e2")).toMatchObject({ dataAiIgnore: true, dataAiPrivate: true, dataAiRedact: false, tagName: null });
  });

  it("sends no caller text: only refs of the snapshot reach a command, and a hostile ref is refused before any command", async () => {
    const { runtime, run, snapshot } = await started();
    for (const hostile of ["@e2; rm -rf /", "@e2 ", "e2", "@e0", "@e02", "@e99", "@e1234567890", "--session", "@e2\n@e7", "", "x".repeat(5000)]) {
      await expect(runtime.inspectElementFacts([hostile as ElementRef], snapshot), hostile.slice(0, 20)).rejects.toMatchObject({ code: "REF_NOT_FOUND" });
    }
    await expect(runtime.inspectElementFacts("@e2" as never, snapshot)).rejects.toMatchObject({ code: "REF_NOT_FOUND" });
    expect(run).not.toHaveBeenCalled();
  });

  it("refuses more than 64 refs and accepts exactly 64, de-duplicating repeats", async () => {
    const many = Array.from({ length: 70 }, (_, index) => ({ key: `e${index + 1}`, role: "button", name: `Button ${index + 1}` }));
    const { runtime, run, snapshot, attrCalls } = await started({}, page(many));
    const refs = (count: number) => Array.from({ length: count }, (_, index) => `@e${index + 1}` as ElementRef);
    await expect(runtime.inspectElementFacts(refs(65), snapshot)).rejects.toMatchObject({ code: "REF_NOT_FOUND" });
    expect(run).not.toHaveBeenCalled();
    expect((await runtime.inspectElementFacts(refs(64), snapshot)).size).toBe(64);
    expect(attrCalls()).toHaveLength(64 * 5);
    run.mockClear();
    expect((await runtime.inspectElementFacts(["@e1", "@e1", "@e2"], snapshot)).size).toBe(2);
    expect(attrCalls()).toHaveLength(2 * 5);
  });

  it("drift since the snapshot rejects the whole call before any attribute read", async () => {
    const { runtime, run, state, snapshot, attrCalls } = await started();
    state.page = page([...operable.slice(0, 2), { ...operable[2]!, name: "Submit order now" }]);
    run.mockClear();
    await expect(runtime.inspectElementFacts(["@e2"], snapshot)).rejects.toMatchObject({ code: "REF_NOT_FOUND" });
    expect(attrCalls()).toEqual([]);
  });

  it("refuses a snapshot that is not the latest one, one taken before any snapshot, and a session that was never started", async () => {
    const never = harness();
    await expect(never.runtime.inspectElementFacts([], { url: origin + "/", elements: [] })).rejects.toMatchObject({ code: "BROWSER_NOT_STARTED" });
    const { runtime, run, snapshot } = await started();
    await runtime.snapshot();
    run.mockClear();
    await expect(runtime.inspectElementFacts(["@e2"], snapshot)).rejects.toMatchObject({ code: "REF_NOT_FOUND" });
    expect(run).not.toHaveBeenCalled();
    const fresh = await runtime.snapshot();
    expect((await runtime.inspectElementFacts([], fresh)).size).toBe(0);
  });

  it("maps an unreadable element to null and keeps the others", async () => {
    const { runtime, state, snapshot } = await started();
    state.attributes = { "@e2": facts({ type: "text" }), "@e10": facts() };
    const original = state.read;
    for (const broken of [
      (ref: string, name: string) => ref === "@e7" ? failure() : original(ref, name),
      (ref: string, name: string) => ref === "@e7" && name === "data-ai-redact" ? "{" : original(ref, name),
      (ref: string, name: string) => ref === "@e7" && name === "autocomplete" ? failure() : original(ref, name),
    ]) {
      state.read = broken;
      const found = await runtime.inspectElementFacts(["@e7", "@e2"], snapshot);
      expect(found.get("@e7")).toBeNull();
      expect(found.get("@e2")).toMatchObject({ inputType: "text" });
    }
  });

  it("a value that cannot be represented is not trusted: unusable types and over-long type or autocomplete make the element null", async () => {
    const { runtime, state, snapshot } = await started();
    for (const [name, value] of [["type", "t".repeat(41)], ["autocomplete", "a ".repeat(101)], ["type", 7], ["data-ai-ignore", 1], ["autocomplete", ["cc-number"]]] as const) {
      state.read = (ref, attribute) => reply({ origin: state.page.origin, value: ref === "@e2" && attribute === name ? value : null });
      expect((await runtime.inspectElementFacts(["@e2", "@e7"], snapshot)).get("@e2"), `${name}=${JSON.stringify(value)}`).toBeNull();
    }
    state.read = (_ref, attribute) => reply({ origin: state.page.origin, value: attribute === "type" ? "t".repeat(40) : attribute === "autocomplete" ? "a".repeat(200) : null });
    expect((await runtime.inspectElementFacts(["@e2"], snapshot)).get("@e2")).not.toBeNull();
  });

  it("treats navigation during the batch as drift for the whole call and an unapproved page as blocked", async () => {
    const { runtime, state, snapshot } = await started({ origins: [origin, "http://127.0.0.1:5188"] });
    state.read = (ref, attribute) => reply({ origin: ref === "@e2" ? "http://127.0.0.1:5188/#/other" : state.page.origin, value: null, attribute });
    await expect(runtime.inspectElementFacts(["@e7", "@e2"], snapshot)).rejects.toMatchObject({ code: "REF_NOT_FOUND" });
    state.read = () => reply({ origin: "http://127.0.0.1:5189/#/other", value: null });
    await expect(runtime.inspectElementFacts(["@e7"], snapshot)).rejects.toMatchObject({ code: "DOMAIN_BLOCKED" });
    state.read = () => reply({ value: null });
    await expect(runtime.inspectElementFacts(["@e7"], snapshot)).rejects.toMatchObject({ code: "INVALID_BROWSER_OUTPUT" });
  });

  it("aborts on a browser timeout instead of reporting the remaining elements as unknown", async () => {
    const { runtime, state, snapshot } = await started();
    state.read = () => { throw new BrowserRuntimeError("BROWSER_TIMEOUT"); };
    await expect(runtime.inspectElementFacts(["@e7"], snapshot)).rejects.toMatchObject({ code: "BROWSER_TIMEOUT" });
  });

  it("is exclusive like every other command, and returns no page text", async () => {
    const { runtime, run, state, snapshot } = await started();
    state.attributes = { "@e2": facts({ type: "text" }) };
    let release = () => {};
    run.mockImplementationOnce(() => new Promise<string>(resolve => { release = () => resolve(reply(state.page)); }));
    const first = runtime.inspectElementFacts(["@e2"], snapshot);
    await expect(runtime.getUrl()).rejects.toMatchObject({ code: "BROWSER_BUSY" });
    release();
    const found = await first;
    expect(JSON.stringify([...found])).not.toMatch(/canary|Order note|value/u);
  });

  it("a privacy-relevant element is reported as such, for the host to refuse", async () => {
    const items: Item[] = [{ key: "e1", role: "textbox", name: "Password field" }, { key: "e2", role: "textbox", name: "Card" }, { key: "e3", role: "button", name: "Private button" }];
    const { runtime, state, snapshot } = await started({}, page(items));
    state.attributes = { "@e1": facts({ type: "password", autocomplete: "current-password" }), "@e2": facts({ type: "text", autocomplete: "cc-number" }), "@e3": facts({ "data-ai-private": "" }) };
    const found = await runtime.inspectElementFacts(["@e1", "@e2", "@e3"], snapshot);
    expect(found.get("@e1")).toMatchObject({ inputType: "password", autocomplete: "current-password" });
    expect(found.get("@e2")).toMatchObject({ autocomplete: "cc-number" });
    expect(found.get("@e3")).toMatchObject({ dataAiPrivate: true });
  });
});
