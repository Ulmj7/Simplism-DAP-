import type { WalkthroughRuntime } from "@dap/walkthrough";
import type { FetchLike } from "./help/client.js";

export interface UsageEvent {
  walkthroughId: string;
  runId: string;
  event: "started" | "completed" | "cancelled";
}
export type UsageClient = (event: UsageEvent) => void;

export function createUsageClient(fetch?: FetchLike): UsageClient {
  const starts = new Map<string, Promise<void>>();
  async function post({ walkthroughId, runId, event }: UsageEvent) {
    if (!fetch) return;
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const expired = new Promise<void>(resolve => { timer = setTimeout(() => { abort.abort(); resolve(); }, 2500); });
    const request = (async () => {
      try {
        await fetch("/api/walkthrough-events", {
          method: "POST", credentials: "same-origin", redirect: "error", signal: abort.signal,
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ walkthroughId, runId, event }),
        });
      } catch { /* Best-effort usage must not interfere with the guide. */ }
    })();
    try { await Promise.race([request, expired]); } finally { clearTimeout(timer); }
  }
  return event => {
    if (event.event === "started") {
      const pending = post(event);
      starts.set(event.runId, pending);
      void pending.then(() => starts.delete(event.runId));
      return;
    }
    // Let the host finish admitting the start before submitting its terminal.
    const pending = starts.get(event.runId);
    if (pending) void pending.then(() => post(event)); else void post(event);
  };
}

export function reportUsage(runtime: Pick<WalkthroughRuntime, "subscribe" | "catalog">, report: UsageClient, newId: () => string) {
  let run: { walkthroughId: string; runId: string } | undefined;
  return runtime.subscribe(({ walkthroughId, status }) => {
    const active = status === "RESOLVING" || status === "PRESENTING" || status === "WAITING" || status === "VERIFYING";
    if (active) {
      if (!run && walkthroughId && walkthroughId !== "wt-preview" && runtime.catalog.get(walkthroughId)) {
        run = { walkthroughId, runId: newId() };
        report({ ...run, event: "started" });
      }
    } else if (run) {
      const ended = run;
      run = undefined;
      if (walkthroughId === ended.walkthroughId && (status === "COMPLETED" || status === "CANCELLED")) {
        report({ ...ended, event: status === "COMPLETED" ? "completed" : "cancelled" });
      }
    }
  });
}
