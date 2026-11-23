/** One bounded Anthropic Messages call. Credentials never become diagnostic data. */
import { fitRequestToBudget } from "@dap/ai";
import type { GuidanceModel, GuidanceTimers } from "@dap/ai";
export type GuidanceFetch = typeof fetch;
export const ANTHROPIC_ENDPOINT = "https://api.anthropic.com/v1/messages";
export type ProviderCode = "network" | "timeout" | "http_status" | "bad_envelope" | "empty_response" | "fit_mismatch";
export class GuidanceConfigError extends Error {}
export class GuidanceProviderError extends Error {
  constructor(readonly code: ProviderCode) { super(`Guidance provider: ${code}`); this.name = "GuidanceProviderError"; }
}
export const hostTimers: GuidanceTimers = { set: (cb, ms) => { const h = setTimeout(cb, ms); return () => clearTimeout(h); } };
export function createAnthropicGuidanceModel({ apiKey, modelId = "claude-haiku-5-5", fetchImpl = fetch, timers = hostTimers }: {
  apiKey: unknown; modelId?: string; fetchImpl?: typeof fetch; timers?: GuidanceTimers;
}): GuidanceModel {
  if (typeof apiKey !== "string" || !/^[\x21-\x7e]{1,4096}$/.test(apiKey)) throw new GuidanceConfigError("ANTHROPIC_API_KEY must be non-empty printable text without whitespace");
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(modelId)) throw new GuidanceConfigError("DAP_GUIDANCE_MODEL_ID is invalid");
  return { async generate(request): Promise<unknown> {
    const fitted = fitRequestToBudget(request);
    if (!fitted.ok || JSON.stringify(fitted.request) !== JSON.stringify(request)) throw new GuidanceProviderError("fit_mismatch");
    const controller = new AbortController();
    let expired = false;
    let cancel = () => {};
    const operation = async () => {
      let response: Response;
      try { response = await fetchImpl(ANTHROPIC_ENDPOINT, { method: "POST", signal: controller.signal,
        headers: { "x-api-key": apiKey, "anthropic-version": "2023-06-01", "content-type": "application/json" },
        body: JSON.stringify({ model: modelId, max_tokens: 1024, temperature: 0, system: fitted.prompt.system, messages: [{ role: "user", content: fitted.prompt.user }] }),
      }); } catch { throw new GuidanceProviderError(expired ? "timeout" : "network"); }
      if (!response.ok) { controller.abort(); throw new GuidanceProviderError("http_status"); }
      let envelope: unknown;
      try {
        if (!response.body) throw new Error();
        const reader = response.body.getReader(); const parts: Uint8Array[] = []; let size = 0;
        try { for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.byteLength; if (size > 65536) { controller.abort(); void reader.cancel().catch(() => {}); throw new Error(); } parts.push(next.value); } }
        finally { reader.releaseLock(); }
        const bytes = new Uint8Array(size); let at = 0; for (const part of parts) { bytes.set(part, at); at += part.length; }
        envelope = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
      } catch { throw new GuidanceProviderError(expired ? "timeout" : "bad_envelope"); }
      const content = (envelope as { content?: unknown } | null)?.content;
      if (!Array.isArray(content)) throw new GuidanceProviderError("bad_envelope");
      const texts = content.filter((b): b is { type: string; text: string } => b !== null && typeof b === "object" && b.type === "text" && typeof b.text === "string");
      if (!texts.length) throw new GuidanceProviderError("bad_envelope");
      let text = texts.map(b => b.text).join("").trim();
      if (text.includes(apiKey)) throw new GuidanceProviderError("bad_envelope");
      if (!text) throw new GuidanceProviderError("empty_response");
      const fence = /^```(?:json)?\s*\n([\s\S]*?)\n```$/.exec(text); if (fence) text = fence[1]!;
      let decoded: unknown;
      try { decoded = JSON.parse(text) as unknown; } catch { return text; }
      if (JSON.stringify(decoded).includes(JSON.stringify(apiKey).slice(1, -1))) throw new GuidanceProviderError("bad_envelope");
      return decoded;
    };
    try {
      let armed = false;
      const deadline = new Promise<never>((_, reject) => {
        const handle: unknown = timers.set(() => { expired = true; controller.abort(); reject(new GuidanceProviderError("timeout")); }, 7000);
        if (typeof handle !== "function") { reject(new GuidanceProviderError("network")); return; }
        cancel = handle as () => void;
        armed = true;
      });
      // Establish a usable deadline before spending a provider call, including synchronous timer ports.
      if (!armed || expired) return await deadline;
      return await Promise.race([deadline, operation()]);
    } catch (error) { if (error instanceof GuidanceProviderError) throw error; throw new GuidanceProviderError(expired ? "timeout" : "network"); }
    finally { controller.abort(); try { cancel(); } catch { /* Timer cleanup never exposes a dependency error. */ } }
  } };
}
