import { describe, expect, it, vi } from "vitest";
import { createGuidanceService, fitRequestToBudget } from "@dap/ai";
import type { GuidanceModelRequest } from "@dap/ai";
import { createAnthropicGuidanceModel, GuidanceProviderError } from "./anthropic-model.js";
const key = "unit-test-" + "x".repeat(24);
const request: GuidanceModelRequest = { input: { query: "question", semanticContext: { route: "profile", elements: [] }, walkthroughSummaries: [], sources: [] }, maxOutputChars: 1200 };
const response = (text: string) => Response.json({ content: [{ type: "text", text }] });
const make = (fetchImpl: typeof fetch) => createAnthropicGuidanceModel({ apiKey: key, fetchImpl });
describe("Anthropic offline adapter", () => {
  it.each([undefined, "", "a b", "a\n", "x".repeat(4097)])("refuses unusable key", apiKey => expect(() => createAnthropicGuidanceModel({ apiKey })).toThrow(/ANTHROPIC_API_KEY/));
  it("uses the fixed API and exact renderer without tools", async () => {
    const fetcher = vi.fn<typeof fetch>(async (url, init) => {
      expect(url).toBe("https://api.anthropic.com/v1/messages");
      expect(init?.headers).toMatchObject({ "x-api-key": key, "anthropic-version": "2023-06-01" });
      const body = JSON.parse(init!.body as string); expect(body).not.toHaveProperty("tools");
      const fit = fitRequestToBudget(request); expect(fit.ok).toBe(true); if (fit.ok) expect(body.system).toBe(fit.prompt.system);
      return response('```json\n{"kind":"clarify","message":"Which guide?"}\n```');
    });
    expect(await make(fetcher).generate(request)).toEqual({ kind: "clarify", message: "Which guide?" }); expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each(["network", "http_status", "bad_envelope", "empty_response", "oversize", "key-echo"])("closed and secret-free %s failure", async mode => {
    const model = make(async () => {
      if (mode === "network") throw new Error(key);
      if (mode === "http_status") return new Response(key, { status: 429 });
      if (mode === "bad_envelope") return new Response("not json");
      if (mode === "oversize") return new Response("x".repeat(65537));
      return response(mode === "key-echo" ? key : "");
    });
    try { await model.generate(request); expect.fail("must reject"); } catch (error) {
      expect(error).toBeInstanceOf(GuidanceProviderError);
      expect((error as GuidanceProviderError).code).toBe(mode === "oversize" || mode === "key-echo" ? "bad_envelope" : mode);
      for (const surface of [String(error), JSON.stringify(error), (error as Error).stack]) expect(surface).not.toContain(key);
      expect(error).not.toHaveProperty("cause");
    }
  });
  it("aborts and settles at 7000ms even if a fake fetch ignores abort", async () => {
    vi.useFakeTimers(); try {
      let signal: AbortSignal | undefined;
      const pending = make(async (_url, init) => { signal = init!.signal!; return new Promise(() => {}); }).generate(request);
      const rejected = expect(pending).rejects.toMatchObject({ code: "timeout" });
      await vi.advanceTimersByTimeAsync(7000); await rejected; expect(signal?.aborted).toBe(true);
    } finally { vi.useRealTimers(); }
  });
  it.each(["synchronous", "missing-handle", "throwing"])("a %s deadline port starts no HTTP request", async mode => {
    let released = 0;
    const fetcher = vi.fn<typeof fetch>(async () => response('{"kind":"clarify","message":"Which?"}'));
    const model = createAnthropicGuidanceModel({ apiKey: key, fetchImpl: fetcher, timers: {
      set: cb => {
        if (mode === "throwing") throw new Error(key);
        if (mode === "missing-handle") return undefined as never;
        cb();
        return () => { released++; };
      },
    } });
    await expect(model.generate(request)).rejects.toMatchObject({ code: mode === "synchronous" ? "timeout" : "network" });
    expect(fetcher).not.toHaveBeenCalled();
    expect(released).toBe(mode === "synchronous" ? 1 : 0);
  });
  it.each(['unit-test-"quoted-secret', 'unit-test-\\escaped-secret'])("refuses an echoed printable key requiring JSON escaping", async apiKey => {
    const model = createAnthropicGuidanceModel({ apiKey, fetchImpl: async () => response(JSON.stringify({ kind: "clarify", message: apiKey })) });
    await expect(model.generate(request)).rejects.toMatchObject({ code: "bad_envelope" });
  });
  it("invalid decision text stays unknown for core validation", async () => expect(await make(async () => response("not a decision")).generate(request)).toBe("not a decision"));
  it("rejects fit mismatch before HTTP", async () => {
    const fetcher = vi.fn<typeof fetch>();
    await expect(make(fetcher).generate({ ...request, input: { ...request.input, semanticContext: { route: "x", elements: Array.from({ length: 60 }, (_, i) => ({ id: `page.e${i}`, role: "button", label: "x".repeat(80), description: "y".repeat(200), privacy: "public", available: true })) } } })).rejects.toMatchObject({ code: "fit_mismatch" });
    expect(fetcher).not.toHaveBeenCalled();
  });
  it("service and real adapter agree on kept chunks and reject a dropped citation", async () => {
    const chunks = [1, 2, 3, 4].map(i => ({ id: `doc.${i}`, docId: "doc", title: "Document", text: `TEXT${i} ` + "x".repeat(780), score: 5 }));
    const context = { route: "profile", elements: Array.from({ length: 32 }, (_, i) => ({ id: `page.e${i}`, role: "button", label: "x".repeat(80), description: "y".repeat(240), privacy: "public", available: true })) };
    for (const cite of ["kept", "dropped"]) {
      let supplied: string[] = [];
      const model = make(async (_url, init) => {
        const user = JSON.parse(init!.body as string).messages[0].content as string;
        supplied = chunks.filter(c => user.includes(`source: ${c.id} |`)).map(c => c.id);
        for (const c of chunks) expect(user.includes(c.text)).toBe(supplied.includes(c.id));
        expect(supplied.length).toBeLessThan(4); expect(supplied.length).toBeGreaterThan(0);
        return response(JSON.stringify({ kind: "answer", answer: "A grounded statement.", sources: [cite === "kept" ? supplied[0] : chunks.find(c => !supplied.includes(c.id))!.id] }));
      });
      const result = await createGuidanceService({ model, catalog: { list: () => [] }, retriever: { search: () => chunks }, timers: { set: () => () => {} }, sanitizeQuery: x => x as string }).askGuidance({ query: "question", semanticContext: context });
      expect(result).toMatchObject(cite === "kept" ? { kind: "answer", sources: [{ id: "doc", title: "Document" }] } : { kind: "unsupported", reason: "ungrounded" });
    }
  });
});
