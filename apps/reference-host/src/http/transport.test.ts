/**
 * C01 browser transport, no PostgreSQL and no network: the REAL Feature 003 guidance host with its fake model (`DAP_GUIDANCE_MODEL=fake`, real knowledge,
 * real retriever, real catalog), a fake host session, an injected clock and id generator, driven through Fastify's `inject`.
 * The PostgreSQL-backed path through the real Gateway is tests/integration/c01-guidance-transport.test.ts.
 */
import { describe, expect, it, vi } from "vitest";
import type { GuidanceResult } from "@dap/ai";
import { createGuidanceHost } from "../guidance/compose-guidance.js";
import type { GuidanceFetch } from "../guidance/anthropic-model.js";
import { demoCatalogView } from "../guidance/walkthrough-summaries.js";
import type { StartOutcome } from "./approved-start.js";
import { PROPOSAL_TTL_MS, createProposalStore } from "./proposal-store.js";
import { BODY_LIMIT_BYTES, TRANSPORT_MESSAGES, createGuidanceTransport, parseHttpPort } from "./transport.js";
import type { GuidanceTransportDeps, RequestHeaders } from "./transport.js";

const SECRET = "sk-ant-test-SECRET-0123456789";
const context = { route: "profile", elements: [{ id: "profile.displayName", role: "textbox", label: "Display name", description: "Your public name", privacy: "public", available: true }] };
const PROFILE = "How do I change my profile name?";

function setup(over: Partial<GuidanceTransportDeps> & { readonly env?: Record<string, string>; readonly fetchImpl?: GuidanceFetch; readonly startOutcome?: (id: string) => Promise<StartOutcome> } = {}) {
  const starterCalls: string[] = [];
  const guidance = createGuidanceHost({ env: over.env ?? { DAP_GUIDANCE_MODEL: "fake" }, starter: { start: (id) => { starterCalls.push(id); return { ok: true }; } }, ...(over.fetchImpl ? { fetchImpl: over.fetchImpl } : {}) });
  const clock = { now: 1_000_000 };
  let counter = 0;
  const start = vi.fn(over.startOutcome ?? (async (id: string): Promise<StartOutcome> => ({ ok: true, walkthroughId: id })));
  const ask = vi.fn(over.ask ?? guidance.askGuidance);
  const sessions = new Map([["a", { key: "session-a", start }], ["b", { key: "session-b", start }]]);
  const resolveSession = over.resolveSession ?? (async (headers: RequestHeaders) => sessions.get(String(headers["x-test-session"] ?? "a")) ?? null);
  const proposals = over.proposals ?? createProposalStore({ now: () => clock.now, newId: () => `proposal-${String(++counter).padStart(8, "0")}-opaque` });
  const app = createGuidanceTransport({ ask, catalog: over.catalog ?? demoCatalogView, resolveSession, proposals });
  const responses: string[] = [];
  const post = async (url: string, payload: unknown, headers: Record<string, string> = {}) => {
    const res = await app.inject({ method: "POST", url, headers: { "content-type": "application/json", ...headers }, payload: typeof payload === "string" ? payload : JSON.stringify(payload) });
    responses.push(res.body);
    return { status: res.statusCode, body: JSON.parse(res.body) as Record<string, unknown>, headers: res.headers, raw: res.body };
  };
  return { app, ask, start, starterCalls, clock, post, responses, proposals };
}
const askBody = (query: unknown, semanticContext: unknown = context) => ({ query, semanticContext });

/** Nothing internal: no error class or stack, schema/provider text, the secret, a closed reason code, permission id, capability id or risk. */
function expectNoLeak(raw: string) {
  for (const word of [SECRET, "SECRET", "Error", "stack", "    at ", "issues", "Zod", "reason", "perm.", "startWalkthrough", "ex.guidance", "risk", "LOW", "FORBIDDEN", "DENIED", "statusCode", "anthropic", "prompt"]) expect(raw, word).not.toContain(word);
}

describe("POST /api/guidance", () => {
  it("answer: a grounded answer with source ids and titles only", async () => {
    const t = setup();
    const res = await t.post("/api/guidance", askBody("What is two-factor authentication?"));
    expect(res.status).toBe(200);
    expect(res.body.kind).toBe("answer");
    expect(Object.keys(res.body).sort()).toEqual(["answer", "kind", "sources"]);
    const sources = res.body.sources as Record<string, unknown>[];
    expect(sources.length).toBeGreaterThan(0);
    for (const source of sources) expect(Object.keys(source).sort()).toEqual(["id", "title"]);
    expect(t.start).not.toHaveBeenCalled();
    expect(t.starterCalls).toEqual([]);
  });

  it("walkthrough: an opaque proposal and the trusted title, never a walkthrough id or steps; nothing is started", async () => {
    const t = setup();
    const res = await t.post("/api/guidance", askBody(PROFILE));
    expect(res.status).toBe(200);
    expect(Object.keys(res.body).sort()).toEqual(["kind", "message", "proposalId", "title"]);
    expect(res.body).toMatchObject({ kind: "walkthrough", title: "Update your profile name", message: TRANSPORT_MESSAGES.proposal });
    expect(res.raw).not.toContain("profileUpdate");
    expect(res.raw).not.toContain("walkthroughId");
    expect(res.raw).not.toContain("steps");
    expect(t.start).not.toHaveBeenCalled();
    expect(t.starterCalls).toEqual([]);
    expect(t.proposals.size()).toBe(1);
  });

  it("clarify: a clarification and no proposal", async () => {
    const t = setup();
    const res = await t.post("/api/guidance", askBody("Help me with settings."));
    expect(res.status).toBe(200);
    expect(res.body.kind).toBe("clarify");
    expect(Object.keys(res.body).sort()).toEqual(["kind", "message"]);
    expect(t.proposals.size()).toBe(0);
    expect(t.start).not.toHaveBeenCalled();
  });

  it("unsupported: the fixed message and no reason code", async () => {
    const t = setup();
    const res = await t.post("/api/guidance", askBody("Write me a poem about the sea."));
    expect(res.status).toBe(200);
    expect(res.body.kind).toBe("unsupported");
    expect(Object.keys(res.body).sort()).toEqual(["kind", "message"]);
  });

  it.each([
    ["not JSON", "{not json"],
    ["an empty body", ""],
    ["an array", "[]"],
    ["null", "null"],
    ["a string", JSON.stringify("hello")],
    ["a missing semanticContext", JSON.stringify({ query: "hi" })],
    ["a missing query", JSON.stringify({ semanticContext: context })],
    ["an extra field", JSON.stringify({ ...askBody("hi"), walkthroughId: "profileUpdate" })],
    ["a definition smuggled in", JSON.stringify({ ...askBody("hi"), steps: [{ selector: "#x" }], confirmed: true })],
    ["a non-string query", JSON.stringify(askBody(42))],
    ["a prototype-poisoning key", '{"query":"hi","semanticContext":{"route":"profile","elements":[]},"__proto__":{"x":1}}'],
  ])("malformed body (%s): 400 with a fixed message; the model is not asked", async (_name, payload) => {
    const t = setup();
    const res = await t.post("/api/guidance", payload);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ kind: "unsupported", message: TRANSPORT_MESSAGES.malformed });
    expect(t.ask).not.toHaveBeenCalled();
    expectNoLeak(res.raw);
  });

  it("only application/json is accepted, and only POST on the two routes", async () => {
    const t = setup();
    const text = await t.app.inject({ method: "POST", url: "/api/guidance", headers: { "content-type": "text/plain" }, payload: JSON.stringify(askBody("hi")) });
    expect(text.statusCode).toBe(415);
    expect(JSON.parse(text.body)).toEqual({ kind: "unsupported", message: TRANSPORT_MESSAGES.malformed });
    const get = await t.app.inject({ method: "GET", url: "/api/guidance" });
    expect(get.statusCode).toBe(404);
    expect(JSON.parse(get.body)).toEqual({ kind: "unsupported", message: TRANSPORT_MESSAGES.notFound });
    const other = await t.app.inject({ method: "POST", url: "/api/anything", headers: { "content-type": "application/json" }, payload: "{}" });
    expect(other.statusCode).toBe(404);
    expect(t.ask).not.toHaveBeenCalled();
  });

  it("oversized query (more than 500 characters): 400 before the model is asked; 500 characters is accepted", async () => {
    const t = setup();
    const res = await t.post("/api/guidance", askBody("a".repeat(501)));
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ kind: "unsupported", message: "Please ask a shorter question in plain text." });
    expect(t.ask).not.toHaveBeenCalled();
    const ok = await t.post("/api/guidance", askBody(`${"a ".repeat(249)}ab`));
    expect(ok.status).toBe(200);
    expect(t.ask).toHaveBeenCalledTimes(1);
  });

  it("oversized body: 413 with a fixed message", async () => {
    const t = setup();
    const res = await t.post("/api/guidance", JSON.stringify({ ...askBody("hi"), pad: "x".repeat(BODY_LIMIT_BYTES) }));
    expect(res.status).toBe(413);
    expect(res.body).toEqual({ kind: "unsupported", message: TRANSPORT_MESSAGES.tooLarge });
    expect(t.ask).not.toHaveBeenCalled();
  });

  it("a full valid 60-element context fits the body limit", async () => {
    const t = setup();
    const elements = Array.from({ length: 60 }, (_, i) => ({ id: `profile.field${i}`, role: "button", label: "L".repeat(80), description: "D".repeat(240), privacy: "public", available: true }));
    const res = await t.post("/api/guidance", askBody(PROFILE, { route: "profile", elements }));
    expect(res.status).toBe(200);
  });

  it.each([
    ["an element with a value", { route: "profile", elements: [{ ...context.elements[0], value: "Alice" }] }],
    ["an element with HTML", { route: "profile", elements: [{ ...context.elements[0], label: "<img src=x onerror=alert(1)>" }] }],
    ["a selector field", { route: "profile", elements: [], selector: "#name" }],
    ["a bad route", { route: "../admin", elements: [] }],
    ["an unknown role", { route: "profile", elements: [{ ...context.elements[0], role: "script" }] }],
    ["too many elements", { route: "profile", elements: Array.from({ length: 61 }, (_, i) => ({ ...context.elements[0], id: `profile.f${i}` })) }],
    ["not an object", "profile"],
  ])("context validation (%s): 400 with the fixed context message; the model is not asked", async (_name, semanticContext) => {
    const t = setup();
    const res = await t.post("/api/guidance", askBody(PROFILE, semanticContext));
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ kind: "unsupported", message: "Guidance is not available for this page right now." });
    expect(t.ask).not.toHaveBeenCalled();
  });

  it("the empty route with no elements (an unregistered page) is a valid context", async () => {
    const t = setup();
    expect((await t.post("/api/guidance", askBody(PROFILE, { route: "", elements: [] }))).status).toBe(200);
  });

  it("provider failure (the anthropic adapter, its HTTP client rejecting with the key in the error) -> 503 unavailable, nothing leaks", async () => {
    const fetchImpl = (async () => { throw new Error(`connect failed for key ${SECRET}\n    at secret.js:1`); }) as unknown as GuidanceFetch;
    const t = setup({ env: { DAP_GUIDANCE_MODEL: "anthropic", ANTHROPIC_API_KEY: SECRET }, fetchImpl });
    const res = await t.post("/api/guidance", askBody(PROFILE));
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ kind: "unavailable", message: TRANSPORT_MESSAGES.unavailable });
    expectNoLeak(res.raw);
  });

  it("provider returns an error body carrying the key and a prompt -> 503 unavailable, nothing leaks", async () => {
    const fetchImpl = (async () => new Response(JSON.stringify({ type: "error", error: { message: `bad key ${SECRET}`, prompt: "SYSTEM PROMPT" } }), { status: 500, headers: { "content-type": "application/json" } })) as unknown as GuidanceFetch;
    const t = setup({ env: { DAP_GUIDANCE_MODEL: "anthropic", ANTHROPIC_API_KEY: SECRET }, fetchImpl });
    const res = await t.post("/api/guidance", askBody(PROFILE));
    expect(res.status).toBe(503);
    expect(res.body.kind).toBe("unavailable");
    expectNoLeak(res.raw);
  });

  it("a guidance port that throws, or returns an unknown shape -> 503 unavailable, nothing leaks", async () => {
    const thrower = setup({ ask: async () => { const error = new Error(`db password ${SECRET}`); error.stack = `ZodError: ${SECRET}\n    at x`; throw error; } });
    const res = await thrower.post("/api/guidance", askBody("hi"));
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ kind: "unavailable", message: TRANSPORT_MESSAGES.unavailable });
    expectNoLeak(res.raw);
    const odd = setup({ ask: async () => ({ kind: "steps", steps: [{ selector: "#x" }], debug: SECRET }) as unknown as GuidanceResult });
    const oddRes = await odd.post("/api/guidance", askBody("hi"));
    expect(oddRes.status).toBe(503);
    expectNoLeak(oddRes.raw);
  });

  it("result fields beyond the contract are never forwarded (an over-full answer is copied field by field)", async () => {
    const t = setup({ ask: async () => ({ kind: "answer", answer: "Text", sources: [{ id: "doc.a#1", title: "A", text: SECRET }], reason: "x", prompt: SECRET }) as unknown as GuidanceResult });
    const res = await t.post("/api/guidance", askBody("hi"));
    expect(res.body).toEqual({ kind: "answer", answer: "Text", sources: [{ id: "doc.a#1", title: "A" }] });
  });

  it("a proposal for an id the trusted catalog does not list gets no proposal id", async () => {
    const t = setup({ ask: async () => ({ kind: "walkthrough", walkthroughId: "deleteAccount" }) });
    const res = await t.post("/api/guidance", askBody("hi"));
    expect(res.body).toEqual({ kind: "unsupported", message: "I could not find a guide for that." });
    expect(t.proposals.size()).toBe(0);
  });

  it("no host session -> 401 with a fixed message; the model is not asked", async () => {
    const t = setup({ resolveSession: async () => null });
    const res = await t.post("/api/guidance", askBody(PROFILE));
    expect(res.status).toBe(401);
    expect(res.body).toEqual({ kind: "unsupported", message: TRANSPORT_MESSAGES.noSession });
    expect(t.ask).not.toHaveBeenCalled();
  });

  it("DNS rebinding: a Host that is not loopback is refused before anything runs; loopback names on any port pass", async () => {
    const t = setup();
    for (const host of ["evil.example", "evil.example:8787", "127.0.0.1.evil.example", "localhost.evil.example:5173"]) {
      const res = await t.post("/api/guidance", askBody(PROFILE), { host });
      expect(res.status, host).toBe(403);
      expect(res.body).toEqual({ kind: "unsupported", message: TRANSPORT_MESSAGES.forbiddenHost });
    }
    expect((await t.post("/api/guidance/start", { proposalId: "proposal-00000001-opaque" }, { host: "evil.example" })).status).toBe(403);
    expect(t.ask).not.toHaveBeenCalled();
    for (const host of ["localhost:5173", "127.0.0.1:8787", "[::1]:8787", "localhost"]) expect((await t.post("/api/guidance", askBody(PROFILE), { host })).status, host).toBe(200);
  });

  it("sends no CORS headers, and marks replies JSON, no-store and nosniff", async () => {
    const t = setup();
    const res = await t.post("/api/guidance", askBody(PROFILE), { origin: "https://evil.example" });
    expect(res.headers["access-control-allow-origin"]).toBeUndefined();
    expect(res.headers["access-control-allow-credentials"]).toBeUndefined();
    expect(res.headers["content-type"]).toMatch(/^application\/json/);
    expect(res.headers["cache-control"]).toBe("no-store");
    expect(res.headers["x-content-type-options"]).toBe("nosniff");
    const preflight = await t.app.inject({ method: "OPTIONS", url: "/api/guidance", headers: { origin: "https://evil.example", "access-control-request-method": "POST" } });
    expect(preflight.statusCode).toBe(404);
    expect(preflight.headers["access-control-allow-origin"]).toBeUndefined();
  });
});

describe("POST /api/guidance/start", () => {
  const propose = async (t: ReturnType<typeof setup>, session = "a") => {
    const res = await t.post("/api/guidance", askBody(PROFILE), { "x-test-session": session });
    expect(res.body.kind).toBe("walkthrough");
    return res.body.proposalId as string;
  };

  it("approve: the proposal goes to the host session's Gateway start once, and the reply carries the id the executor APPROVED", async () => {
    const t = setup({ startOutcome: async () => ({ ok: true, walkthroughId: "profileUpdate" }) });
    const proposalId = await propose(t);
    const res = await t.post("/api/guidance/start", { proposalId });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ kind: "start", walkthroughId: "profileUpdate" });
    expect(t.start).toHaveBeenCalledTimes(1);
    expect(t.start).toHaveBeenCalledWith("profileUpdate");
  });

  it("the reply's id is the approved one reported by the start port, not the proposal's", async () => {
    const t = setup({ startOutcome: async () => ({ ok: true, walkthroughId: "findSecuritySettings" }) });
    const res = await t.post("/api/guidance/start", { proposalId: await propose(t) });
    expect(res.body).toEqual({ kind: "start", walkthroughId: "findSecuritySettings" });
  });

  it("policy refuse: a safe unsupported reply with no permission, risk or stage detail", async () => {
    const t = setup({ startOutcome: async () => ({ ok: false }) });
    const res = await t.post("/api/guidance/start", { proposalId: await propose(t) });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ kind: "unsupported", message: TRANSPORT_MESSAGES.startRefused });
    expectNoLeak(res.raw);
  });

  it("a throwing start port is a refusal, and its text never leaks", async () => {
    const t = setup({ startOutcome: async () => { throw new Error(`FORBIDDEN_POLICY perm.guidance.start ${SECRET}`); } });
    const res = await t.post("/api/guidance/start", { proposalId: await propose(t) });
    expect(res.body).toEqual({ kind: "unsupported", message: TRANSPORT_MESSAGES.startRefused });
    expectNoLeak(res.raw);
  });

  it("replayed: a proposal id works once; the second use starts nothing", async () => {
    const t = setup();
    const proposalId = await propose(t);
    expect((await t.post("/api/guidance/start", { proposalId })).body.kind).toBe("start");
    const again = await t.post("/api/guidance/start", { proposalId });
    expect(again.body).toEqual({ kind: "unsupported", message: TRANSPORT_MESSAGES.proposalGone });
    expect(t.start).toHaveBeenCalledTimes(1);
  });

  it("a refused proposal is used up too", async () => {
    const t = setup({ startOutcome: async () => ({ ok: false }) });
    const proposalId = await propose(t);
    await t.post("/api/guidance/start", { proposalId });
    expect((await t.post("/api/guidance/start", { proposalId })).body).toEqual({ kind: "unsupported", message: TRANSPORT_MESSAGES.proposalGone });
    expect(t.start).toHaveBeenCalledTimes(1);
  });

  it("expired: past the TTL the proposal is gone and nothing starts; just before it, it still works", async () => {
    const t = setup();
    const late = await propose(t);
    t.clock.now += PROPOSAL_TTL_MS;
    expect((await t.post("/api/guidance/start", { proposalId: late })).body).toEqual({ kind: "unsupported", message: TRANSPORT_MESSAGES.proposalGone });
    expect(t.start).not.toHaveBeenCalled();
    const fresh = await propose(t);
    t.clock.now += PROPOSAL_TTL_MS - 1;
    expect((await t.post("/api/guidance/start", { proposalId: fresh })).body.kind).toBe("start");
  });

  it("unknown: a well-formed id that was never minted starts nothing", async () => {
    const t = setup();
    const res = await t.post("/api/guidance/start", { proposalId: "proposal-99999999-opaque" });
    expect(res.body).toEqual({ kind: "unsupported", message: TRANSPORT_MESSAGES.proposalGone });
    expect(t.start).not.toHaveBeenCalled();
  });

  it("not usable across sessions: another session's redemption fails and burns it", async () => {
    const t = setup();
    const proposalId = await propose(t, "a");
    expect((await t.post("/api/guidance/start", { proposalId }, { "x-test-session": "b" })).body).toEqual({ kind: "unsupported", message: TRANSPORT_MESSAGES.proposalGone });
    expect((await t.post("/api/guidance/start", { proposalId }, { "x-test-session": "a" })).body).toEqual({ kind: "unsupported", message: TRANSPORT_MESSAGES.proposalGone });
    expect(t.start).not.toHaveBeenCalled();
  });

  it.each([
    ["a walkthrough id instead of a proposal", { walkthroughId: "profileUpdate" }],
    ["an extra field", { proposalId: "proposal-00000001-opaque", walkthroughId: "profileUpdate" }],
    ["a short id", { proposalId: "abc" }],
    ["an id with odd characters", { proposalId: "proposal-0000/../0001" }],
    ["a non-string id", { proposalId: 7 }],
    ["an array", []],
  ])("malformed start body (%s): 400 and nothing is redeemed or started", async (_name, payload) => {
    const t = setup();
    await propose(t);
    const res = await t.post("/api/guidance/start", payload);
    expect(res.status).toBe(400);
    expect(res.body).toEqual({ kind: "unsupported", message: TRANSPORT_MESSAGES.malformed });
    expect(t.start).not.toHaveBeenCalled();
    expect(t.proposals.size()).toBe(1);
  });

  it("the browser cannot start a walkthrough by naming it: only a minted proposal reaches the Gateway", async () => {
    const t = setup();
    for (const payload of [{ proposalId: "profileUpdate-profileUpdate" }, { proposalId: "findTwoFactorSettings00" }]) await t.post("/api/guidance/start", payload);
    expect(t.start).not.toHaveBeenCalled();
  });

  it("every reply across the whole flow is free of internals", async () => {
    const t = setup();
    await t.post("/api/guidance", askBody("What is two-factor authentication?"));
    await t.post("/api/guidance", askBody("Help me with settings."));
    await t.post("/api/guidance/start", { proposalId: await propose(t) });
    await t.post("/api/guidance", "{bad");
    for (const raw of t.responses) expectNoLeak(raw);
  });
});

describe("DAP_HTTP_PORT", () => {
  it("defaults to 8787 and refuses anything but a decimal port", () => {
    expect(parseHttpPort(undefined)).toBe(8787);
    expect(parseHttpPort("")).toBe(8787);
    expect(parseHttpPort("9000")).toBe(9000);
    for (const bad of ["0", "65536", "80a", " 80", "-1", "1e3", "0x50", "123456"]) expect(parseHttpPort(bad), bad).toBeNull();
  });
});

describe("Sec-Fetch-Site (cross-site browser requests are refused; same-origin, none and absent pass)", () => {
  it.each(["cross-site", "same-site", "CROSS-SITE", "bogus"])("%s: 403 on both routes, nothing runs", async (site) => {
    const t = setup();
    const ask = await t.post("/api/guidance", askBody(PROFILE), { "sec-fetch-site": site });
    expect(ask.status).toBe(403);
    expect(ask.body).toEqual({ kind: "unsupported", message: TRANSPORT_MESSAGES.forbiddenHost });
    const start = await t.post("/api/guidance/start", { proposalId: "proposal-00000001-opaque" }, { "sec-fetch-site": site });
    expect(start.status).toBe(403);
    expect(t.ask).not.toHaveBeenCalled();
    expect(t.start).not.toHaveBeenCalled();
  });

  it.each([["same-origin"], ["none"], [undefined]])("%s: allowed (the Vite proxy forwards the browser's same-origin unchanged)", async (site) => {
    const t = setup();
    const res = await t.post("/api/guidance", askBody(PROFILE), site === undefined ? {} : { "sec-fetch-site": site });
    expect(res.status).toBe(200);
    expect(res.body.kind).toBe("walkthrough");
    const started = await t.post("/api/guidance/start", { proposalId: res.body.proposalId }, site === undefined ? {} : { "sec-fetch-site": site });
    expect(started.body.kind).toBe("start");
  });
});

describe("/start when the Gateway is stalled or the start queue is full", () => {
  it("an unavailable start outcome is a 503 unavailable reply, and the proposal is used up", async () => {
    const t = setup({ startOutcome: async () => ({ ok: false, unavailable: true }) });
    const proposed = await t.post("/api/guidance", askBody(PROFILE));
    const res = await t.post("/api/guidance/start", { proposalId: proposed.body.proposalId });
    expect(res.status).toBe(503);
    expect(res.body).toEqual({ kind: "unavailable", message: TRANSPORT_MESSAGES.unavailable });
    expect((await t.post("/api/guidance/start", { proposalId: proposed.body.proposalId })).body).toEqual({ kind: "unsupported", message: TRANSPORT_MESSAGES.proposalGone });
  });
});

