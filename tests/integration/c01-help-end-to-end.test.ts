// @vitest-environment jsdom
/**
 * C01 cross-app proof: the REAL reference-web app (mountApp, its Help widget, GuideApi and walkthrough overlay) talks to the REAL reference-host browser
 * transport (createGuidanceTransport, through Fastify `inject`, no network) backed by the REAL guidance host with the host's fake demo model.
 *
 * PostgreSQL-free on purpose: the Policy Gateway is replaced by `fakeGatewaySubmit` below, a clearly labelled FAKE stand-in that records the id on the
 * host's approval recorder (what the real executor does) and reports `walkthrough`. The REAL Gateway path (AiSession.submit -> Policy Gateway -> executor
 * -> recording starter) is proven separately by tests/integration/c01-guidance-transport.test.ts, which needs the PostgreSQL of deploy/compose.yaml.
 *
 * Nothing on the browser side is mocked: GuideApi, the runtime and the overlay are the app's own; only `fetch` is an adapter onto `transport.inject`.
 */
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createGuidanceClient, mountApp } from "../../apps/reference-web/src/main.js";
import type { FetchLike, GuidanceClient, MountedApp } from "../../apps/reference-web/src/main.js";
import { HELP_LIMITS } from "../../apps/reference-web/src/help/client.js";
import { MAX_ANSWER_CHARS, MAX_ID_CHARS, MAX_MESSAGE_CHARS, MAX_QUERY_CHARS, MAX_SOURCES, MAX_TITLE_CHARS } from "../../packages/ai/src/guidance/limits.js";
import { copy } from "../../apps/reference-web/src/copy.js";
import type { AiSession } from "../../apps/reference-host/src/compose.js";
import { createGuidanceHost } from "../../apps/reference-host/src/guidance/compose-guidance.js";
import { demoCatalogView } from "../../apps/reference-host/src/guidance/walkthrough-summaries.js";
import { createApprovalRecorder, createGatewayStart } from "../../apps/reference-host/src/http/approved-start.js";
import { createProposalStore } from "../../apps/reference-host/src/http/proposal-store.js";
import { createGuidanceTransport } from "../../apps/reference-host/src/http/transport.js";

type GatewaySubmit = NonNullable<Parameters<typeof createGatewayStart>[0]["submit"]>;
interface Exchange { readonly url: string; readonly request: string; readonly status: number; readonly response: string }

// The host's own knowledge files. Passed explicitly because the host's default (`new URL("../../knowledge/", import.meta.url)`) builds a jsdom URL under
// this jsdom environment, which node:url's fileURLToPath rejects ("The URL must be of scheme file"); the directory is the same one the host defaults to.
const KNOWLEDGE_DIR = join(dirname(fileURLToPath(import.meta.url)), "../../apps/reference-host/knowledge/");

const PROFILE_NAME = "How do I change my profile name?";
const TWO_FACTOR = "What is two-factor authentication?";
const SETTINGS = "Help me with settings.";

const cleanups: (() => Promise<unknown> | void)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
  document.body.replaceChildren();
});

/** Builds the host side (PG-free) and the browser side, joined by a fetch adapter onto the real transport. */
function setup({ gateway = "allow", tamper }: { gateway?: "allow" | "refuse"; tamper?: (body: Record<string, unknown>) => Record<string, unknown> } = {}) {
  const recorder = createApprovalRecorder();
  const starterCalls: string[] = [];
  const gatewaySubmits: string[] = [];
  const starter = { start(id: string) { starterCalls.push(id); return recorder.starter.start(id); } };
  const guidance = createGuidanceHost({ env: { DAP_GUIDANCE_MODEL: "fake" }, starter, knowledgeDir: KNOWLEDGE_DIR });

  // FAKE Gateway stand-in (see the header): "allow" records the id on the recorder exactly as the real executor would; "refuse" records nothing.
  const fakeGatewaySubmit: GatewaySubmit = async (_session, walkthroughId) => {
    gatewaySubmits.push(walkthroughId);
    if (gateway === "refuse") return { kind: "unsupported", message: "refused by the fake gateway", reason: "not_permitted" };
    starter.start(walkthroughId);
    return { kind: "walkthrough", walkthroughId };
  };
  const unusedSession: AiSession = { submit: () => Promise.reject(new Error("the fake gateway never uses the session")) };
  const startPort = createGatewayStart({ openSession: async () => unusedSession, recorder, submit: fakeGatewaySubmit });

  let counter = 0;
  const transport = createGuidanceTransport({
    ask: guidance.askGuidance,
    catalog: demoCatalogView,
    resolveSession: async () => ({ key: "browser-session", start: startPort }),
    proposals: createProposalStore({ now: () => 1_700_000_000_000, newId: () => `proposal_${String(++counter).padStart(12, "0")}` }),
  });
  cleanups.push(() => transport.close());

  const exchanges: Exchange[] = [];
  const post = async (url: string, payload: string) => {
    const res = await transport.inject({ method: "POST", url, headers: { "content-type": "application/json" }, payload });
    exchanges.push({ url, request: payload, status: res.statusCode, response: res.body });
    return res;
  };
  const fetchAdapter: FetchLike = async (url, init) => {
    let payload = typeof init.body === "string" ? init.body : "";
    if (tamper !== undefined) payload = JSON.stringify(tamper(JSON.parse(payload) as Record<string, unknown>));
    const res = await post(url, payload);
    return new Response(res.body, { status: res.statusCode, headers: { "content-type": "application/json" } });
  };
  const client = createGuidanceClient({ fetch: fetchAdapter });
  return { client, exchanges, post, starterCalls, gatewaySubmits };
}

function mount(client: GuidanceClient, route = "dashboard"): MountedApp {
  window.history.replaceState(null, "", `#/${route}`);
  const root = document.createElement("div");
  document.body.append(root);
  const app = mountApp(root, { trustedEventsOnly: false, guidance: client });
  cleanups.push(() => app.destroy());
  return app;
}

const panel = () => document.querySelector<HTMLElement>("#dap-help-panel")!;
const launcher = () => document.querySelector<HTMLButtonElement>(".help-launcher")!;
const input = () => document.querySelector<HTMLInputElement>("#dap-help-query")!;
const result = () => document.querySelector<HTMLElement>(".help-result")!;
const overlayNodes = () => document.querySelectorAll("[data-ai-overlay]");
const startButton = () => document.querySelector<HTMLButtonElement>(".help-recommendation button");

async function ask(app: MountedApp, query: string, settled: string) {
  if (panel().hidden) launcher().click();
  input().value = query;
  document.querySelector<HTMLFormElement>(".help-form")!.requestSubmit();
  await vi.waitFor(() => expect(app.help.state()).toBe(settled));
}

function expectNothingStarted(app: MountedApp, host: { starterCalls: string[] }) {
  expect(app.runtime.getState().status).toBe("IDLE");
  expect(overlayNodes()).toHaveLength(0);
  expect(host.starterCalls).toEqual([]);
}

describe("C01 end to end: reference-web Help -> reference-host transport (fake model, fake Gateway, no PostgreSQL)", () => {
  it("pins the browser’s restated wire limits to Feature 003", () => {
    expect(HELP_LIMITS).toMatchObject({
      queryChars: MAX_QUERY_CHARS, answerChars: MAX_ANSWER_CHARS, messageChars: MAX_MESSAGE_CHARS,
      titleChars: MAX_TITLE_CHARS, sources: MAX_SOURCES, idChars: MAX_ID_CHARS,
    });
  });

  it("'How do I change my profile name?' proposes, starts nothing, then Start guide -> /start -> the real overlay", async () => {
    const host = setup();
    const app = mount(host.client);
    await ask(app, PROFILE_NAME, "walkthroughRecommendation");

    const proposal = host.exchanges[0]!;
    expect(proposal.url).toBe("/api/guidance");
    expect(Object.keys(JSON.parse(proposal.request) as object)).toEqual(["query", "semanticContext"]);
    expect(JSON.parse(proposal.request)).toEqual({ query: PROFILE_NAME, semanticContext: app.guides.context() });
    expect(proposal.status).toBe(200);
    // The browser never holds the walkthrough id before /start: the proposal carries an opaque proposalId only.
    expect(proposal.response).not.toContain("profileUpdate");
    const proposed = JSON.parse(proposal.response) as Record<string, unknown>;
    expect(proposed).toMatchObject({ kind: "walkthrough", proposalId: expect.stringMatching(/^proposal_\d{12}$/) });
    expect(panel().textContent).toContain(copy.help.recommendation);
    expectNothingStarted(app, host);
    expect(host.gatewaySubmits).toEqual([]);

    startButton()!.click();
    await vi.waitFor(() => expect(app.runtime.getState()).toMatchObject({ walkthroughId: "profileUpdate", stepId: "name", status: "WAITING" }));
    const start = host.exchanges[1]!;
    expect(start.url).toBe("/api/guidance/start");
    expect(JSON.parse(start.request)).toEqual({ proposalId: proposed.proposalId });
    expect(JSON.parse(start.response)).toEqual({ kind: "start", walkthroughId: "profileUpdate" });
    expect(host.gatewaySubmits).toEqual(["profileUpdate"]);
    expect(host.starterCalls).toEqual(["profileUpdate"]);

    expect(window.location.hash).toBe("#/profile");
    await vi.waitFor(() => expect(document.querySelector('[data-ai-overlay="ring"]')).not.toBeNull());
    expect(document.querySelector('[data-ai-overlay="tooltip"]')?.textContent).toContain("Type your display name here.");
    expect(app.help.state()).toBe("closed");
    expect(panel().hidden).toBe(true);
    expect(host.exchanges).toHaveLength(2);
  });

  it("'What is two-factor authentication?' gets a grounded answer with source titles and starts nothing", async () => {
    const host = setup();
    const app = mount(host.client, "settings");
    await ask(app, TWO_FACTOR, "answer");

    const wire = JSON.parse(host.exchanges[0]!.response) as { kind: string; answer: string; sources: { id: string; title: string }[] };
    expect(wire.kind).toBe("answer");
    expect(wire.sources.length).toBeGreaterThan(0);
    expect(document.querySelector(".help-answer > p")?.textContent).toBe(wire.answer);
    expect(wire.answer).toContain("Two-factor authentication");
    const titles = Array.from(document.querySelectorAll(".help-sources li"), (item) => item.textContent);
    expect(titles).toEqual(wire.sources.map((source) => source.title));
    expect(startButton()).toBeNull();
    expectNothingStarted(app, host);
    expect(host.exchanges.map((exchange) => exchange.url)).toEqual(["/api/guidance"]);
  });

  it("'Help me with settings.' is ambiguous: a clarify question, the input kept, nothing started", async () => {
    const host = setup();
    const app = mount(host.client, "settings");
    await ask(app, SETTINGS, "clarify");

    const wire = JSON.parse(host.exchanges[0]!.response) as { kind: string; message: string };
    expect(wire.kind).toBe("clarify");
    expect(result().textContent).toContain(wire.message);
    expect(input().value).toBe(SETTINGS);
    expect(startButton()).toBeNull();
    expectNothingStarted(app, host);
    expect(host.exchanges.map((exchange) => exchange.url)).toEqual(["/api/guidance"]);
  });

  it("a start the (fake) Gateway refuses shows the safe message and never reaches GuideApi or the overlay", async () => {
    const host = setup({ gateway: "refuse" });
    const app = mount(host.client);
    await ask(app, PROFILE_NAME, "walkthroughRecommendation");

    startButton()!.click();
    await vi.waitFor(() => expect(app.help.state()).toBe("unsupported"));
    expect(host.gatewaySubmits).toEqual(["profileUpdate"]);
    const start = host.exchanges[1]!;
    expect(start.status).toBe(200);
    expect(JSON.parse(start.response)).toMatchObject({ kind: "unsupported" });
    expect(start.response).not.toContain("profileUpdate");
    expect(start.response).not.toContain("refused by the fake gateway");
    expect(result().textContent).toBe(copy.help.refused);
    expect(panel().hidden).toBe(false);
    expect(window.location.hash).toBe("#/dashboard");
    expectNothingStarted(app, host);
  });

  it("a proposal is single-use: replaying the same proposalId through the client is refused", async () => {
    const host = setup();
    const proposed = await host.client.ask(PROFILE_NAME, { route: "profile", elements: [] });
    if (proposed.kind !== "walkthrough") throw new Error(`expected a walkthrough proposal, got ${proposed.kind}`);

    expect(await host.client.start(proposed.proposalId)).toEqual({ kind: "start", walkthroughId: "profileUpdate" });
    expect(await host.client.start(proposed.proposalId)).toEqual({ kind: "refused" });
    expect(host.gatewaySubmits).toEqual(["profileUpdate"]);
    expect(host.starterCalls).toEqual(["profileUpdate"]);
  });

  describe("the real transport's 400s surface as the safe unsupported text and never start anything", () => {
    it("rejects a 501-character query with 400", async () => {
      const host = setup({ tamper: (body) => ({ ...body, query: "a".repeat(501) }) });
      const app = mount(host.client);
      await ask(app, PROFILE_NAME, "unsupported");

      expect(host.exchanges[0]!.status).toBe(400);
      expect(JSON.parse(host.exchanges[0]!.request)).toMatchObject({ query: "a".repeat(501) });
      expect(JSON.parse(host.exchanges[0]!.response)).toMatchObject({ kind: "unsupported" });
      expect(result().textContent).toBe(copy.help.unsupported);
      expect(startButton()).toBeNull();
      expectNothingStarted(app, host);
    });

    it("rejects a body with extra keys with 400", async () => {
      const host = setup({ tamper: (body) => ({ ...body, walkthroughId: "profileUpdate" }) });
      const app = mount(host.client);
      await ask(app, PROFILE_NAME, "unsupported");

      expect(host.exchanges[0]!.status).toBe(400);
      expect(JSON.parse(host.exchanges[0]!.response)).toMatchObject({ kind: "unsupported" });
      expect(result().textContent).toBe(copy.help.unsupported);
      expect(startButton()).toBeNull();
      expectNothingStarted(app, host);
      expect(host.gatewaySubmits).toEqual([]);
    });

    it("the widget itself never sends a query over 500 characters (maxlength 500, guarded on submit)", async () => {
      const host = setup();
      const app = mount(host.client);
      launcher().click();
      expect(input().maxLength).toBe(500);
      input().value = "a".repeat(501);
      document.querySelector<HTMLFormElement>(".help-form")!.requestSubmit();
      await Promise.resolve();
      expect(app.help.state()).toBe("idle");
      expect(host.exchanges).toEqual([]);
      const direct = await host.post("/api/guidance", JSON.stringify({ query: "a".repeat(501), semanticContext: app.guides.context() }));
      expect(direct.statusCode).toBe(400);
    });
  });
});
