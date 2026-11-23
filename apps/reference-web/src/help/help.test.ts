/**
 * C01: the AI Help widget in the real reference app (jsdom). The host is a fake `fetch` (no network). What is REAL: `mountApp`, the walkthrough
 * runtime, GuideApi, the overlay, the status dialog. A guide is started only by the user clicking Start guide after the fake host approved it, and the
 * overlay is observed through the DOM it produced (never faked).
 */
/// <reference types="node" />
import { afterEach, describe, expect, it, vi } from "vitest";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";
import { mountApp } from "../main.js";
import type { MountedApp } from "../main.js";
import { copy } from "../copy.js";
import { createGuidanceClient, parseGuidance, parseStart } from "./client.js";
import type { FetchLike, GuidanceClient } from "./client.js";
import { createHelp } from "./widget.js";

interface Call { readonly url: string; readonly init: RequestInit }
type Reply = { readonly status?: number; readonly body: unknown } | { readonly raw: string; readonly status?: number } | "reject" | "hang";

const apps: MountedApp[] = [];
afterEach(() => {
  apps.splice(0).forEach(app => app.destroy());
  document.body.replaceChildren();
  Reflect.deleteProperty(window, "matchMedia");
  vi.useRealTimers();
});
const turn = () => vi.advanceTimersByTimeAsync(5);

/** A fake host: replies are consumed in order; every request is recorded. */
function fakeHost(...replies: Reply[]) {
  const calls: Call[] = [];
  const fetch: FetchLike = (url, init) => {
    calls.push({ url, init });
    const reply = replies.shift() ?? "reject";
    if (reply === "reject") return Promise.reject(new TypeError("ECONNRESET at 10.0.0.7: Anthropic 529 overloaded_error"));
    if (reply === "hang") return new Promise<Response>(() => {});
    const status = reply.status ?? 200;
    return Promise.resolve(new Response("raw" in reply ? reply.raw : JSON.stringify(reply.body), { status, headers: { "content-type": "application/json" } }));
  };
  return { calls, fetch, bodies: () => calls.map(c => JSON.parse(String(c.init.body)) as Record<string, unknown>) };
}

function mount(route: "dashboard" | "profile" | "settings", guidance?: GuidanceClient) {
  vi.useFakeTimers();
  window.history.replaceState(null, "", `#/${route}`);
  const root = document.createElement("div");
  document.body.append(root);
  const app = mountApp(root, { trustedEventsOnly: false, ...(guidance === undefined ? {} : { guidance }) });
  apps.push(app);
  return { app, root };
}
const mountWith = (route: "dashboard" | "profile" | "settings", ...replies: Reply[]) => {
  const host = fakeHost(...replies);
  return { ...mount(route, createGuidanceClient({ fetch: host.fetch })), host };
};

const panel = () => document.querySelector<HTMLElement>("#dap-help-panel")!;
const launcherButton = () => document.querySelector<HTMLButtonElement>(".help-launcher")!;
const input = () => document.querySelector<HTMLInputElement>("#dap-help-query")!;
const askButton = () => panel().querySelector<HTMLButtonElement>('.help-form button[type="submit"]')!;
const result = () => panel().querySelector<HTMLElement>(".help-result")!;
const buttonByText = (scope: ParentNode, text: string) => Array.from(scope.querySelectorAll<HTMLButtonElement>("button")).find(b => b.textContent === text);
async function ask(app: MountedApp, query: string) {
  if (app.help.state() === "closed") launcherButton().click();
  input().value = query;
  askButton().click();
  await turn();
}
const overlayParts = () => document.querySelectorAll("[data-ai-overlay]");
const dialog = () => document.querySelector<HTMLDialogElement>("dialog.dap-result");
const escape = (target: EventTarget = document) => target.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));

const PROPOSAL = { kind: "walkthrough", proposalId: "p_8f3c1d2e9a7b4c6d", title: "Update your profile name", message: "This guide shows the name field and the Save button." };
const APPROVED = { kind: "start", walkthroughId: "profileUpdate" };
const TWO_FACTOR = { kind: "answer", answer: "Two-factor authentication adds a second check, such as a code from an app, when you sign in.", sources: [{ id: "doc.twoFactor", title: "Two-factor authentication" }] };
const XSS = ["<img src=x onerror=alert(1)>", "<script>alert(1)</script>"] as const;

describe("C01 launcher and panel", () => {
  it.each(["dashboard", "profile", "settings"] as const)("a labelled 44px-class Help launcher is on the %s page and stays across navigation", async route => {
    const { app } = mount(route);
    const launcher = launcherButton();
    expect(launcher.tagName).toBe("BUTTON");
    expect(launcher.type).toBe("button");
    expect(launcher.getAttribute("aria-label")).toBe(copy.help.title);
    expect(launcher.getAttribute("aria-expanded")).toBe("false");
    expect(launcher.textContent).toContain(copy.help.launcher);
    expect(launcher.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    expect(panel().hidden).toBe(true);
    app.router.navigate(route === "settings" ? "profile" : "settings");
    await turn();
    expect(document.querySelectorAll(".help-launcher")).toHaveLength(1);
  });

  it("opens into the panel, closes with Close, and returns focus to the launcher; the launcher also toggles", () => {
    const { app } = mount("dashboard");
    launcherButton().click();
    expect(app.help.state()).toBe("idle");
    expect(panel().hidden).toBe(false);
    expect(panel().getAttribute("aria-labelledby")).toBe("dap-help-title");
    expect(document.querySelector("#dap-help-title")?.textContent).toBe(copy.help.title);
    expect(launcherButton().getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(input());
    expect(document.querySelector('label[for="dap-help-query"]')?.textContent).toBe(copy.help.inputLabel);
    expect(input().maxLength).toBe(500);
    expect(Array.from(panel().querySelectorAll(".help-suggestion")).map(b => b.textContent)).toEqual(copy.help.suggestions);
    expect(panel().getAttribute("role")).toBeNull(); // desktop: a docked region, not a dialog
    buttonByText(panel(), copy.help.close)!.click();
    expect(app.help.state()).toBe("closed");
    expect(panel().hidden).toBe(true);
    expect(document.activeElement).toBe(launcherButton());
    launcherButton().click();
    expect(app.help.state()).toBe("idle");
    launcherButton().click();
    expect(app.help.state()).toBe("closed");
    expect(document.activeElement).toBe(launcherButton());
  });

  it("on a phone-sized viewport the sheet is announced as a non-modal dialog only while it is open", () => {
    Object.defineProperty(window, "matchMedia", { configurable: true, value: (query: string) => ({ matches: query === "(max-width: 767px)", media: query }) });
    const { app } = mount("profile");
    launcherButton().click();
    expect(panel().getAttribute("role")).toBe("dialog");
    expect(panel().getAttribute("aria-modal")).toBeNull();
    app.help.close();
    expect(panel().getAttribute("role")).toBeNull();
    expect(document.querySelector('[role="dialog"]')).toBeNull();
  });

  it("keyboard: the launcher, prompts and actions are native buttons and Enter in the field submits through the form", async () => {
    const { app, host } = mountWith("dashboard", { body: TWO_FACTOR });
    launcherButton().focus();
    launcherButton().click(); // a native <button> turns Enter/Space into click; the real-browser check covers the key presses themselves
    input().value = "What is two-factor authentication?";
    input().form!.requestSubmit(); // what implicit submission (Enter in the only text field) does
    await turn();
    expect(host.calls).toHaveLength(1);
    expect(app.help.state()).toBe("answer");
    for (const control of panel().querySelectorAll("button")) expect(control.tagName).toBe("BUTTON");
  });
});

describe("C01 request", () => {
  it("sends exactly {query, semanticContext: GuideApi.context()} and nothing from the page", async () => {
    const { app, root, host } = mountWith("profile", { body: TWO_FACTOR });
    const name = root.querySelector<HTMLInputElement>("#name")!;
    name.value = "SecretDisplayName"; name.dispatchEvent(new Event("input", { bubbles: true }));
    root.querySelector<HTMLInputElement>("#password")!.value = "PasswordNeverShared";
    root.querySelector<HTMLInputElement>("#email")!.value = "private@example.test";
    await turn();
    const expected = JSON.parse(JSON.stringify(app.guides.context())) as unknown;
    await ask(app, "  What is two-factor authentication?  ");
    expect(host.calls).toHaveLength(1);
    const [call] = host.calls;
    expect(call!.url).toBe("/api/guidance");
    expect(call!.init.method).toBe("POST");
    expect(call!.init.credentials).toBe("same-origin");
    const body = host.bodies()[0]!;
    expect(Object.keys(body).sort()).toEqual(["query", "semanticContext"]);
    expect(body.query).toBe("What is two-factor authentication?");
    expect(body.semanticContext).toEqual(expected);
    expect(JSON.stringify(body.semanticContext)).not.toContain(body.query as string);
    expect(panel().hasAttribute("data-ai-ignore")).toBe(true);
    const raw = String(call!.init.body);
    for (const leak of ["SecretDisplayName", "PasswordNeverShared", "private@example.test", copy.profile.name, "<", "data-ai"]) expect(raw).not.toContain(leak);
  });

  it("allows one request at a time; Close during loading drops the late reply", async () => {
    let release: (r: Response) => void = () => {};
    const calls: string[] = [];
    const fetch: FetchLike = url => { calls.push(url); return new Promise<Response>(r => { release = r; }); };
    const { app } = mount("dashboard", createGuidanceClient({ fetch }));
    launcherButton().click();
    input().value = "What is two-factor authentication?";
    askButton().click();
    await turn();
    expect(app.help.state()).toBe("submitting");
    expect(askButton().disabled).toBe(true);
    expect(input().readOnly).toBe(true);
    expect(Array.from(panel().querySelectorAll<HTMLButtonElement>(".help-suggestion")).every(b => b.disabled)).toBe(true);
    expect(panel().querySelector('[role="status"]')?.getAttribute("aria-live")).toBe("polite");
    expect(panel().querySelector('[role="status"]')?.textContent).toBe(copy.help.loading);
    askButton().click(); input().form!.requestSubmit(); panel().querySelector<HTMLButtonElement>(".help-suggestion")!.click();
    await turn();
    expect(calls).toHaveLength(1);
    buttonByText(panel(), copy.help.close)!.click(); // Close still works while loading
    expect(app.help.state()).toBe("closed");
    release(new Response(JSON.stringify(TWO_FACTOR), { status: 200 }));
    await turn();
    expect(app.help.state()).toBe("closed");
    launcherButton().click();
    expect(app.help.state()).toBe("idle");
    expect(result().textContent).toBe("");
  });
});

describe("C01 rendering", () => {
  it("'What is two-factor authentication?' renders the answer and source titles as text and starts nothing", async () => {
    const { app, host } = mountWith("settings", { body: TWO_FACTOR });
    launcherButton().click();
    buttonByText(panel(), "What is two-factor authentication?")!.click();
    await turn();
    expect(app.help.state()).toBe("answer");
    expect(result().querySelector(".help-answer p")?.textContent).toBe(TWO_FACTOR.answer);
    expect(result().querySelector("h3")?.textContent).toBe(copy.help.sources);
    expect(Array.from(result().querySelectorAll(".help-sources li")).map(li => li.textContent)).toEqual(["Two-factor authentication"]);
    expect(result().textContent).not.toContain("doc.twoFactor");
    expect(host.calls).toHaveLength(1);
    expect(app.runtime.getState().status).toBe("IDLE");
    expect(overlayParts()).toHaveLength(0);
  });

  it.each(XSS)("renders %s inertly in an answer, a source, a guide title, a guide message and a clarification", async payload => {
    const { app } = mountWith("dashboard",
      { body: { kind: "answer", answer: payload, sources: [{ id: "doc.x", title: payload }] } },
      { body: { kind: "walkthrough", proposalId: "p1", title: payload, message: payload } },
      { body: { kind: "clarify", message: payload } });
    const before = document.querySelectorAll("img, script").length;
    for (const expected of ["answer", "walkthroughRecommendation", "clarify"] as const) {
      await ask(app, "anything");
      expect(app.help.state()).toBe(expected);
      if (expected === "answer") {
        expect(result().querySelector(".help-answer > p")?.textContent).toBe(payload);
        expect(result().querySelector(".help-sources li")?.textContent).toBe(payload);
        expect(result().querySelector(".help-sources a")).toBeNull();
      } else if (expected === "walkthroughRecommendation") {
        expect(result().querySelector(".help-guide-title")?.textContent).toBe(payload);
        expect(result().querySelector(".help-text")?.textContent).toBe(payload);
        expect(buttonByText(result(), copy.guide.start)?.getAttribute("aria-label")).toBe(`${copy.guide.start}: ${payload}`);
      } else {
        expect(result().querySelector(".help-text")?.textContent).toBe(payload);
      }
      expect(document.querySelectorAll("img, script")).toHaveLength(before);
      expect(panel().querySelectorAll("[onerror], [onload], [src]")).toHaveLength(0);
    }
  });

  it("'Help me with settings.' asks for clarification, keeps the question and starts nothing", async () => {
    const { app, host } = mountWith("settings", { body: { kind: "clarify", message: "Which setting do you want to change: security or two-factor?" } });
    await ask(app, "Help me with settings.");
    expect(app.help.state()).toBe("clarify");
    expect(result().textContent).toBe("Which setting do you want to change: security or two-factor?");
    expect(input().value).toBe("Help me with settings.");
    expect(document.activeElement).toBe(input());
    expect(host.calls.map(c => c.url)).toEqual(["/api/guidance"]);
    expect(app.runtime.getState().status).toBe("IDLE");
  });

  it("an unsupported reply (200, 400 or 413) shows the safe wording, not the server's", async () => {
    const { app } = mountWith("dashboard",
      { body: { kind: "unsupported", message: "query_invalid: ZodError at input.query" } },
      { status: 413, body: { kind: "unsupported", message: "payload too large" } });
    for (let i = 0; i < 2; i++) {
      await ask(app, "Tell me a joke");
      expect(app.help.state()).toBe("unsupported");
      expect(result().textContent).toBe(copy.help.unsupported);
    }
  });

  const failures: [string, Reply][] = [
    ["a network failure", "reject"],
    ["a 500 with an error body", { status: 500, body: { error: "ZodError: Expected string at input.query", stack: "at askGuidance (/srv/host.js:12)" } }],
    ["a 503 unavailable", { status: 503, body: { kind: "unavailable", message: "Anthropic 529 overloaded_error" } }],
    ["malformed JSON", { raw: "{\"kind\":\"answer\",ECONNRESET" }],
    ["an unknown kind", { body: { kind: "html", html: "<b>hi</b>" } }],
    ["a proposal that carries a walkthrough id", { body: { ...PROPOSAL, walkthroughId: "profileUpdate" } }],
    ["an oversized answer", { body: { kind: "answer", answer: "x".repeat(1201), sources: [] } }],
    ["an answer as 500", { status: 500, body: TWO_FACTOR }],
  ];
  it.each(failures)("%s becomes the safe unavailable state with Try again and no leaked text", async (_name, reply) => {
    const { app, host } = mountWith("dashboard", reply, { body: TWO_FACTOR });
    await ask(app, "What is two-factor authentication?");
    expect(app.help.state()).toBe("error");
    expect(result().textContent).toBe(copy.help.unavailable + copy.help.retry);
    for (const leak of ["ECONNRESET", "Zod", "529", "stack", "html", "500", "503"]) expect(panel().textContent).not.toContain(leak);
    buttonByText(panel(), copy.help.retry)!.click();
    await turn();
    expect(host.calls).toHaveLength(2);
    expect(host.bodies()[1]!.query).toBe("What is two-factor authentication?");
    expect(app.help.state()).toBe("answer");
  });

  it("a host that never answers times out into the safe unavailable state", async () => {
    const { app, host } = mountWith("dashboard", "hang");
    await ask(app, "Where are the security settings?");
    expect(app.help.state()).toBe("submitting");
    expect(host.calls[0]?.init.signal?.aborted).toBe(false);
    await vi.advanceTimersByTimeAsync(15_000);
    expect(app.help.state()).toBe("error");
    expect(result().textContent).toBe(copy.help.unavailable + copy.help.retry);
    expect(host.calls[0]?.init.signal?.aborted).toBe(true);
    expect(askButton().disabled).toBe(false);
  });
});

describe("C01 guide handoff", () => {
  it("THE proof: 'How do I change my profile name?' -> recommendation -> Start guide -> /start approval -> the real runtime and overlay take over", async () => {
    const { app, host } = mountWith("dashboard", { body: PROPOSAL }, { body: APPROVED });
    launcherButton().click();
    buttonByText(panel(), "How do I change my profile name?")!.click();
    await turn();
    expect(app.help.state()).toBe("walkthroughRecommendation");
    const block = result().querySelector<HTMLElement>(".help-recommendation")!;
    expect(block.querySelector(".help-lead")?.textContent).toBe(copy.help.recommendation);
    expect(block.querySelector("h3")?.textContent).toBe("Update your profile name");
    expect(block.textContent).toContain(PROPOSAL.message);
    expect(app.runtime.getState().status).toBe("IDLE"); // a recommendation never starts anything by itself
    expect(overlayParts()).toHaveLength(0);
    buttonByText(block, copy.guide.start)!.click();
    await turn();
    expect(host.calls.map(c => c.url)).toEqual(["/api/guidance", "/api/guidance/start"]);
    expect(host.bodies()[1]).toEqual({ proposalId: PROPOSAL.proposalId });
    await vi.advanceTimersByTimeAsync(50);
    expect(app.help.state()).toBe("closed");
    expect(panel().hidden).toBe(true);
    expect(document.activeElement).toBe(launcherButton());
    expect(app.runtime.getState()).toMatchObject({ walkthroughId: "profileUpdate", stepId: "name", status: "WAITING" });
    expect(window.location.hash).toBe("#/profile");
    const ring = document.querySelector<HTMLElement>('[data-ai-overlay="ring"]');
    const tooltip = document.querySelector<HTMLElement>('[data-ai-overlay="tooltip"]');
    expect(ring).not.toBeNull();
    expect(tooltip).not.toBeNull();
    expect(tooltip!.textContent).toContain("Type your display name here.");
  });

  it("a /start refusal never reaches GuideApi and shows the policy wording", async () => {
    const { app, host } = mountWith("dashboard", { body: PROPOSAL }, { body: { kind: "unsupported", message: "policy_denied: guide.start risk=high" } });
    await ask(app, "How do I change my profile name?");
    buttonByText(result(), copy.guide.start)!.click();
    await turn();
    expect(host.calls).toHaveLength(2);
    expect(app.help.state()).toBe("unsupported");
    expect(result().textContent).toBe(copy.help.refused);
    expect(app.runtime.getState().status).toBe("IDLE");
    expect(overlayParts()).toHaveLength(0);
  });

  it("the widget calls the start path only with the id from a kind:'start' reply, once, and not on refusal or failure", async () => {
    vi.useFakeTimers();
    const startGuide = vi.fn(() => ({ ok: true as const }));
    for (const [second, calls] of [[{ body: APPROVED }, [["profileUpdate"]]], [{ body: { kind: "unsupported", message: "no" } }, []], ["reject", []], [{ body: { kind: "start" } }, []]] as const) {
      startGuide.mockClear();
      const host = fakeHost({ body: { ...PROPOSAL, title: "findSecuritySettings" } }, second);
      const help = createHelp({ doc: document, guides: { context: () => ({ route: "dashboard", elements: [] }) }, client: createGuidanceClient({ fetch: host.fetch }), escapeOwnedElsewhere: () => false, startGuide });
      help.open(); input().value = "q"; askButton().click(); await turn();
      const start = buttonByText(result(), copy.guide.start)!;
      start.click(); start.click(); await turn();
      expect(startGuide.mock.calls.map(c => [(c as unknown[])[0]])).toEqual(calls);
      help.destroy();
    }
  });

  it("when a guide is already running, Start guide respects the runtime's refusal and leaves the panel open with a safe message", async () => {
    const { app, root } = mountWith("dashboard", { body: PROPOSAL }, { body: APPROVED });
    root.querySelector<HTMLButtonElement>('.guide-list button[aria-label="Start guide: Find the security settings"]')!.click();
    await turn();
    expect(app.runtime.getState()).toMatchObject({ walkthroughId: "findSecuritySettings", status: "WAITING" });
    await ask(app, "How do I change my profile name?");
    buttonByText(result(), copy.guide.start)!.click();
    await turn();
    expect(app.runtime.getState()).toMatchObject({ walkthroughId: "findSecuritySettings", status: "WAITING" });
    expect(app.help.state()).toBe("unsupported");
    expect(result().textContent).toBe(copy.guide.refused);
  });

  it("a refused Help start preserves the active guide’s original focus return target", async () => {
    const { app, root } = mountWith("dashboard", { body: PROPOSAL }, { body: APPROVED });
    const original = root.querySelector<HTMLButtonElement>('.guide-list button[aria-label="Start guide: Find the security settings"]')!;
    original.click();
    await turn();
    await ask(app, "How do I change my profile name?");
    buttonByText(result(), copy.guide.start)!.click();
    await turn();
    expect(app.help.state()).toBe("unsupported");
    expect(app.runtime.getState()).toMatchObject({ status: "WAITING", walkthroughId: "findSecuritySettings" });
    escape(input());
    expect(dialog()?.open).toBe(true);
    escape(dialog()!);
    // The original launcher was on Dashboard and was replaced during navigation.
    expect(document.activeElement).toBe(root.querySelector("h1"));
  });

  it("a refused second start leaves the active guide’s queued DOM input intact", async () => {
    const { app, root } = mount("profile");
    expect(app.guides.startWalkthrough("profileUpdate")).toEqual({ ok: true });
    await turn();
    expect(app.runtime.getState()).toMatchObject({ stepId: "name", status: "WAITING" });
    const field = root.querySelector<HTMLInputElement>("#name")!;
    field.value = "Ada";
    field.dispatchEvent(new Event("input", { bubbles: true }));
    expect(app.guides.startWalkthrough("findSecuritySettings")).toEqual({ ok: false, reason: "busy" });
    await turn();
    expect(app.runtime.getState()).toMatchObject({ walkthroughId: "profileUpdate", stepId: "save", status: "WAITING" });
  });

  it("closing and reopening during a start keeps one request in flight and drops the abandoned approval", async () => {
    let finish: (response: Response) => void = () => undefined;
    const fetch = vi.fn<FetchLike>(url => url.endsWith("/start")
      ? new Promise<Response>(resolve => { finish = resolve; })
      : Promise.resolve(new Response(JSON.stringify(PROPOSAL))));
    const { app } = mount("dashboard", createGuidanceClient({ fetch }));
    await ask(app, "How do I change my profile name?");
    const start = buttonByText(result(), copy.guide.start)!;
    start.focus();
    start.click();
    expect(document.activeElement).toBe(input());
    expect(app.help.state()).toBe("submitting");
    buttonByText(panel(), copy.help.close)!.click();
    launcherButton().click();
    input().form!.requestSubmit();
    panel().querySelector<HTMLButtonElement>(".help-suggestion")!.click();
    expect(fetch).toHaveBeenCalledTimes(2);
    finish(new Response(JSON.stringify(APPROVED)));
    await turn();
    expect(app.help.state()).toBe("idle");
    expect(app.runtime.getState().status).toBe("IDLE");
    expect(overlayParts()).toHaveLength(0);
    await ask(app, "How do I change my profile name?");
    expect(app.help.state()).toBe("walkthroughRecommendation");
  });

  // jsdom has no layout, so the page reflow the docked panel causes (body padding while Help is open) is modelled: the display name field sits 200px
  // further left while `dap-help-open` is on the body. The ring must always follow the layout that is actually on screen.
  function withHelpReflow(run: () => Promise<void>): Promise<void> {
    const proto = HTMLElement.prototype.getBoundingClientRect;
    HTMLElement.prototype.getBoundingClientRect = function (this: HTMLElement) {
      if (this.id !== "name") return proto.call(this);
      const left = document.body.classList.contains("dap-help-open") ? 332 : 532;
      return { left, top: 300, width: 480, height: 44, right: left + 480, bottom: 344, x: left, y: 300, toJSON: () => ({}) } as DOMRect;
    };
    return run().finally(() => { HTMLElement.prototype.getBoundingClientRect = proto; });
  }
  const ringLeft = () => document.querySelector<HTMLElement>('[data-ai-overlay="ring"]')?.style.left;

  it("after Start guide closes the docked panel, the overlay is placed for the reflowed page, not the layout the panel had", () => withHelpReflow(async () => {
    const { app } = mountWith("dashboard", { body: PROPOSAL }, { body: APPROVED });
    await ask(app, "How do I change my profile name?");
    buttonByText(result(), copy.guide.start)!.click();
    await turn(); await vi.advanceTimersByTimeAsync(50);
    expect(app.runtime.getState()).toMatchObject({ walkthroughId: "profileUpdate", stepId: "name", status: "WAITING" });
    expect(document.body.classList.contains("dap-help-open")).toBe(false);
    expect(ringLeft()).toBe("528px");
  }));

  it("opening and closing Help while a guide runs re-places the overlay each time", () => withHelpReflow(async () => {
    const { app } = mount("profile");
    expect(app.guides.startWalkthrough("profileUpdate").ok).toBe(true);
    await turn();
    expect(ringLeft()).toBe("528px");
    launcherButton().click();
    expect(app.help.state()).toBe("idle");
    expect(ringLeft()).toBe("328px");
    buttonByText(panel(), copy.help.close)!.click();
    expect(ringLeft()).toBe("528px");
    launcherButton().click(); app.help.destroy();
    expect(ringLeft()).toBe("528px");
  }));

  it("announces 'Starting the guide' once, in the status region only", async () => {
    let approve: (value: Response) => void = () => {};
    const fetch: FetchLike = url => url.endsWith("/start") ? new Promise<Response>(resolve => { approve = resolve; }) : Promise.resolve(new Response(JSON.stringify(PROPOSAL), { status: 200 }));
    const { app } = mount("dashboard", createGuidanceClient({ fetch }));
    await ask(app, "How do I change my profile name?");
    buttonByText(result(), copy.guide.start)!.click();
    await turn();
    expect(app.help.state()).toBe("submitting");
    const announced = Array.from(panel().querySelectorAll("[aria-live]")).filter(region => region.textContent?.includes(copy.help.starting));
    expect(announced).toHaveLength(1);
    expect(announced[0]!.getAttribute("role")).toBe("status");
    approve(new Response(JSON.stringify(APPROVED), { status: 200 }));
    await turn();
    expect(app.help.state()).toBe("closed");
  });

  it("if the app's start path throws, Help shows the safe unavailable state with Try again instead of hanging in 'submitting'", async () => {
    vi.useFakeTimers();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => { unhandled.push(reason); };
    process.on("unhandledRejection", onUnhandled);
    try {
      const host = fakeHost({ body: PROPOSAL }, { body: APPROVED });
      const startGuide = vi.fn((): never => { throw new Error("internal start failure detail"); });
      const help = createHelp({ doc: document, guides: { context: () => ({ route: "dashboard", elements: [] }) }, client: createGuidanceClient({ fetch: host.fetch }), escapeOwnedElsewhere: () => false, startGuide });
      help.open(); input().value = "q"; askButton().click(); await turn();
      buttonByText(result(), copy.guide.start)!.click(); await turn();
      expect(startGuide).toHaveBeenCalledTimes(1);
      expect(help.state()).toBe("error");
      expect(result().textContent).toBe(copy.help.unavailable + copy.help.retry);
      expect(panel().textContent).not.toContain("internal start failure detail");
      expect(askButton().disabled).toBe(false);
      vi.useRealTimers();
      await new Promise(resolve => { setTimeout(resolve, 0); });
      expect(unhandled).toEqual([]);
      help.destroy();
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

describe("C01 Escape ownership", () => {
  it("with only Help open, Escape closes Help and returns focus to the launcher", () => {
    const { app } = mount("dashboard");
    launcherButton().click();
    escape();
    expect(app.help.state()).toBe("closed");
    expect(document.activeElement).toBe(launcherButton());
  });

  it("an active walkthrough keeps Escape: it cancels the run, Help stays open; the status dialog then owns Escape; only then does Help close", async () => {
    const { app, root } = mount("dashboard");
    root.querySelector<HTMLButtonElement>('.guide-list button[aria-label="Start guide: Find the security settings"]')!.click();
    await turn();
    expect(app.runtime.getState().status).toBe("WAITING");
    launcherButton().click();
    escape();
    await vi.advanceTimersByTimeAsync(2000);
    expect(app.runtime.getState().status).toBe("CANCELLED");
    expect(overlayParts()).toHaveLength(0);
    expect(app.help.state()).toBe("idle");
    expect(dialog()?.open).toBe(true);
    escape(dialog()!); // the dialog's own handler closes it
    expect(dialog()?.open ?? false).toBe(false);
    expect(app.help.state()).toBe("idle");
    escape();
    expect(app.help.state()).toBe("closed");
  });

  it("when Help binds Escape first, Escape from its input still cancels the guide first", async () => {
    const { app, root } = mount("dashboard");
    launcherButton().click();
    root.querySelector<HTMLButtonElement>('.guide-list button[aria-label="Start guide: Find the security settings"]')!.click();
    await turn();
    expect(app.runtime.getState().status).toBe("WAITING");
    input().focus();
    escape(input());
    expect(app.runtime.getState().status).toBe("CANCELLED");
    expect(app.help.state()).toBe("idle");
    expect(dialog()?.open).toBe(true);
    escape(dialog()!);
    expect(app.help.state()).toBe("idle");
    escape();
    expect(app.help.state()).toBe("closed");
  });

  it("with the status dialog open, Escape on the document does not close Help", async () => {
    const { app, root } = mount("dashboard");
    root.querySelector<HTMLButtonElement>('.guide-list button[aria-label="Start guide: Find the security settings"]')!.click();
    await turn();
    app.guides.cancel();
    await turn();
    expect(dialog()?.open).toBe(true);
    app.help.open();
    escape();
    expect(app.help.state()).toBe("idle");
  });
});

describe("C01 client guards", () => {
  it("accepts only the contract shapes", () => {
    expect(parseGuidance(TWO_FACTOR, true)).toEqual({ kind: "answer", answer: TWO_FACTOR.answer, sources: [{ title: "Two-factor authentication" }] });
    expect(parseGuidance({ kind: "walkthrough", proposalId: "p", title: "T" }, true)).toEqual({ kind: "walkthrough", proposalId: "p", title: "T", message: null });
    expect(parseGuidance({ ...TWO_FACTOR, sources: Array.from({ length: 5 }, (_, i) => ({ id: `s${i}`, title: "t" })) }, true).kind).toBe("unavailable");
    expect(parseGuidance({ ...TWO_FACTOR, sources: [{ id: "s", title: "t", text: "raw chunk" }] }, true).kind).toBe("unavailable");
    expect(parseGuidance({ kind: "walkthrough", proposalId: "", title: "T" }, true).kind).toBe("unavailable");
    expect(parseGuidance({ kind: "clarify", message: "" }, true).kind).toBe("unavailable");
    expect(parseGuidance(null, true).kind).toBe("unavailable");
    expect(parseGuidance([TWO_FACTOR], true).kind).toBe("unavailable");
    expect(parseStart(APPROVED, true)).toEqual(APPROVED);
    expect(parseStart(APPROVED, false).kind).toBe("unavailable");
    expect(parseStart({ ...APPROVED, steps: [] }, true).kind).toBe("unavailable");
    expect(parseStart({ kind: "unsupported", message: "x" }, true).kind).toBe("refused");
  });

  it("rejects incomplete refusals and a clarification on HTTP failure", () => {
    expect(parseGuidance({ kind: "unsupported" }, true).kind).toBe("unavailable");
    expect(parseStart({ kind: "unsupported", message: 7 }, true).kind).toBe("unavailable");
    expect(parseGuidance({ kind: "clarify", message: "Which guide?" }, false).kind).toBe("unavailable");
  });

  it("refuses oversized streamed replies before EOF and cancels the reader", async () => {
    vi.useFakeTimers();
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.enqueue(new TextEncoder().encode("x".repeat(16_001))); },
      cancel,
    });
    const client = createGuidanceClient({ fetch: async () => new Response(stream) });
    const settled = vi.fn();
    const pending = client.ask("q", { route: "", elements: [] }).then(settled);
    await turn();
    expect(settled).toHaveBeenCalledWith({ kind: "unavailable" });
    expect(cancel).toHaveBeenCalledOnce();
    await pending;
  });

  it("without a fetch the client is unavailable rather than throwing", async () => {
    const client = createGuidanceClient({});
    await expect(client.ask("q", { route: "", elements: [] })).resolves.toEqual({ kind: "unavailable" });
    await expect(client.start("p")).resolves.toEqual({ kind: "unavailable" });
  });
});

describe("C01 provider key isolation", () => {
  it("no provider secret name or key prefix appears in the browser sources or the built bundle", () => {
    const secret = ["ANTHROPIC", "API", "KEY"].join("_");
    const keyPrefix = ["sk", "ant", ""].join("-");
    const app = resolve("apps/reference-web");
    const files = (dir: string): string[] => readdirSync(dir).flatMap(name => { const path = join(dir, name); return statSync(path).isDirectory() ? files(path) : [path]; });
    const scanned = [...files(join(app, "src")), join(app, "index.html"), join(app, "vite.config.ts"), ...(existsSync(join(app, "dist/web")) ? files(join(app, "dist/web")) : [])];
    expect(scanned.length).toBeGreaterThan(10);
    for (const file of scanned) { const text = readFileSync(file, "utf8"); expect(text, file).not.toContain(secret); expect(text, file).not.toContain(keyPrefix); }
  });
});
