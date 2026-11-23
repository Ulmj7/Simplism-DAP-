import { expect, it, vi } from "vitest";
import { createGuidanceHost } from "./compose-guidance.js";
import type { AiSession } from "../compose.js";
it("defaults offline, composes existing bridge and uses fixed demo scenarios", async () => {
 const starts: string[] = []; const g = createGuidanceHost({ env: {}, starter: { start: id => { starts.push(id); return { ok: true }; } } });
 const submit = vi.fn(async () => ({ outcome: "UNAUTHORIZED", category: "not_available" }));
 const session = { submit } as unknown as AiSession;
 expect(await g.askAndStart(session, { query: "How do I change my profile name?", semanticContext: { route: "profile", elements: [] } })).toMatchObject({ reason: "not_permitted" });
 expect(submit).toHaveBeenCalledTimes(1); expect(starts).toEqual([]);
 submit.mockClear();
 expect(await g.askAndStart(session, { query: "Help me with settings.", semanticContext: { route: "profile", elements: [] } })).toMatchObject({ kind: "clarify" }); expect(submit).not.toHaveBeenCalled();
});
it("configuration fails before any model/network call", () => {
 expect(() => createGuidanceHost({ env: { DAP_GUIDANCE_MODEL: "unknown" }, starter: { start: () => ({ ok: true }) } })).toThrow(/DAP_GUIDANCE_MODEL/);
 expect(() => createGuidanceHost({ env: { DAP_GUIDANCE_MODEL: "anthropic" }, starter: { start: () => ({ ok: true }) } })).toThrow(/ANTHROPIC_API_KEY/);
});
