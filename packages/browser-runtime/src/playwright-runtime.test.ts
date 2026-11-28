import { describe, expect, it, vi } from "vitest";
import { observeBrowser } from "./browser-observation.js";
import type { ChromiumSession } from "./chromium-session.js";
import { createPlaywrightRuntime } from "./playwright-runtime.js";
import type { BrowserRuntimeOptions } from "./playwright-runtime.js";

const origin = "http://127.0.0.1:5173";
const options: BrowserRuntimeOptions = { origins: [origin], labels: "all", routes: "any" };

function fixture(custom: Partial<BrowserRuntimeOptions> = {}) {
  const state = { url: origin + "/", version: 0, closed: false, value: "private-canary" };
  const send = vi.fn(async (command: string) => {
    if (command === "Page.getFrameTree") {
      const url = new URL(state.url);
      return { frameTree: { frame: { id: "root", url: url.origin + url.pathname + url.search, urlFragment: url.hash || undefined } } };
    }
    if (command === "Accessibility.getFullAXTree") return { nodes: [
      { backendDOMNodeId: 1, role: { value: "button" }, name: { value: "Save" }, value: state.value },
      { backendDOMNodeId: 2, role: { value: "button" }, name: { value: "Disabled" }, properties: [{ name: "disabled", value: { value: true } }] },
    ] };
    if (command === "DOM.resolveNode") return { object: { objectId: "button" } };
    if (command === "Runtime.callFunctionOn") return { result: { value: {
      marker: "profile.save", available: true,
      facts: { tagName: "button", inputType: null, autocomplete: null, dataAiPrivate: false, dataAiIgnore: false, dataAiRedact: false },
    } } };
    return {};
  });
  const page = {
    on: vi.fn(),
    isClosed: () => state.closed,
    evaluate: async () => ({ truncated: false, view: { width: 1280, height: 720, x: 0, y: 0 },
      nodes: Array.from({ length: 501 }, (_, index) => ({ id: index + 1, parentId: null, kind: "element", tag: "div" })) }),
  } as unknown as ChromiumSession["page"];
  const open = vi.fn(async () => ({
    page,
    observation: observeBrowser(page, () => state.url, () => state.version, () => true),
    context: { newCDPSession: async () => ({ send }) },
    checkedUrl: () => state.url,
    revision: () => state.version,
    navigate: async (url: string) => { state.url = url; state.version++; },
    close: async () => { state.closed = true; },
  }) as unknown as ChromiumSession);
  return { runtime: createPlaywrightRuntime({ ...options, ...custom }, open), state, send, open };
}

describe("Studio Playwright runtime", () => {
  it("validates origins without launching Chromium", () => {
    for (const origins of [[], [origin + "/"], ["http://*.example.org"], [origin, origin], ["file:///tmp"]]) {
      expect(() => createPlaywrightRuntime({ ...options, origins })).toThrow(TypeError);
    }
  });

  it.each([origin + "/?token=canary", origin + "/#token=canary", "http://127.0.0.1:5174/", "http://localhost:5173/"])(
    "blocks an unauthorized start URL: %s", async url => {
      const { runtime, open } = fixture();
      await expect(runtime.start({ url })).rejects.toMatchObject({ code: "DOMAIN_BLOCKED" });
      expect(open).not.toHaveBeenCalled();
    },
  );

  it("filters the accessibility snapshot and resolves marked, current nodes", async () => {
    const { runtime, state, send } = fixture();
    await expect(runtime.snapshot()).rejects.toMatchObject({ code: "BROWSER_NOT_STARTED" });
    await runtime.start({ url: origin + "/" });
    const snapshot = await runtime.snapshot();
    expect(snapshot.elements).toEqual([{ ref: "@e1", name: "Save", role: "button" }]);
    expect(JSON.stringify(snapshot)).not.toContain(state.value);
    expect(await runtime.inspectSemanticId("@e1", snapshot)).toBe("profile.save");
    await runtime.highlight("@e1", snapshot);
    expect(send).toHaveBeenCalledWith("Overlay.highlightNode", expect.objectContaining({ backendNodeId: 1 }));
    state.value = "updated private value";
    await expect(runtime.inspectSemanticIds(snapshot)).rejects.toMatchObject({ code: "REF_NOT_FOUND" });
    await runtime.close();
    expect(state.closed).toBe(true);
    await expect(runtime.snapshot()).rejects.toMatchObject({ code: "SESSION_CLOSED" });
  });

  it("exposes only approved legacy labels and refuses a forbidden read", async () => {
    const { runtime, state } = fixture({ labels: [{ role: "link", name: "Save" }], routes: ["/"] });
    await runtime.start({ url: origin + "/" });
    expect((await runtime.snapshot()).elements).toEqual([]);
    state.url = origin + "/another";
    await expect(runtime.inspectDom?.()).rejects.toMatchObject({ code: "DOMAIN_BLOCKED" });
  });

  it("paginates the DOM in order and rejects a cursor after same-URL reload", async () => {
    const { runtime, state } = fixture();
    await runtime.start({ url: origin + "/" });
    const first = await runtime.inspectDom!();
    expect(first.nodes).toHaveLength(500);
    expect(first.nextCursor).toBeTruthy();
    const last = await runtime.inspectDom!(first.nextCursor!);
    expect(last).toMatchObject({ nodes: [{ id: 501 }], nextCursor: null });
    const repeated = await runtime.inspectDom!();
    state.version++;
    await expect(runtime.inspectDom!(repeated.nextCursor!)).rejects.toMatchObject({ code: "REF_NOT_FOUND" });
  });
});
