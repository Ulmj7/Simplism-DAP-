import { createHash, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { browserCommand, localCli } from "./cli.js";
import type { RunCli } from "./cli.js";
import { BrowserRuntimeError } from "./errors.js";
import type { BrowserRuntimeErrorCode } from "./errors.js";
import { normalizeSnapshot } from "./snapshot.js";
import type { ApprovedLabel } from "./snapshot.js";
import type { BrowserRuntime, BrowserSnapshot, ElementRef } from "./types.js";

const executable = fileURLToPath(new URL("../../../vendor/agent-browser/cli/target/release/agent-browser", import.meta.url));
const config = fileURLToPath(new URL("../agent-browser.json", import.meta.url));
const commandTimeout = 5_000;
const maxOrigins = 5;
// Upper bound for one batch inspection (one CLI attribute read per candidate).
const maxInspected = 64;

interface TrustedObservation {
  readonly route: string;
  readonly selector: string;
  readonly states: Readonly<Record<string, string>>;
}

export interface AgentBrowserAdapterOptions {
  // Exposure policy: the only role + accessible-name pairs that may leave the adapter.
  readonly labels: readonly ApprovedLabel[];
  // Navigation policy: static `pathname + hash` strings the session may be on.
  readonly routes: readonly string[];
  // Navigation policy: 1..5 normalized origins (`scheme://host[:port]`, http/https only, no
  // credentials, path, query or hash). The CLI allow-list is host-level (the unique hostnames of
  // these origins), so DAP itself enforces the exact scheme, host and port on every URL it reads.
  readonly origins: readonly string[];
  readonly observation?: TrustedObservation;
}

// Fixed messages only: a rejected origin is configuration data and is never echoed back.
function normalizeOrigins(value: unknown): { readonly origins: ReadonlySet<string>; readonly hostnames: readonly string[] } {
  if (!Array.isArray(value) || value.length < 1 || value.length > maxOrigins) {
    throw new TypeError("origins must list between 1 and 5 origins");
  }
  const origins = new Set<string>();
  const hostnames = new Set<string>();
  for (const item of value as unknown[]) {
    let url: URL | undefined;
    try { url = typeof item === "string" ? new URL(item) : undefined; }
    catch { url = undefined; }
    // Only a normalized origin round-trips unchanged: that rejects paths, queries, hashes, default
    // ports, upper-case hosts and trailing slashes without a second parser.
    if (!url || !["http:", "https:"].includes(url.protocol) || url.username || url.password || url.origin !== item) {
      throw new TypeError("origins must be normalized http or https origins");
    }
    // Defence in depth for the CLI allow-list, which is a comma-separated list of these hostnames in which a leading `*.` is a wildcard: a hostname that is not a plain DNS name,
    // an IPv4 address or a bracketed IPv6 literal (for example `*.example.com` or `a,b.example.com`) never reaches it. The adapter stays neutral about WHICH addresses are allowed.
    if (!/^(?:\[[0-9a-f:.]+\]|\d{1,3}(?:\.\d{1,3}){3}|[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*)$/u.test(url.hostname)) {
      throw new TypeError("origins must be normalized http or https origins");
    }
    if (origins.has(url.origin)) throw new TypeError("origins must be unique");
    origins.add(url.origin);
    hostnames.add(url.hostname);
  }
  return { origins, hostnames: [...hostnames] };
}

export function createAgentBrowserAdapter(options: AgentBrowserAdapterOptions, run: RunCli = localCli(executable)): BrowserRuntime {
  const labels = options.labels.map(label => ({ ...label }));
  const routes = new Set(options.routes);
  const { origins, hostnames } = normalizeOrigins(options.origins);
  const trusted = options.observation;
  const states = new Map(Object.entries(trusted?.states ?? {}));
  const session = `dap-${randomUUID()}`;
  const flags = ["--config", config, "--session", session, "--json", "--allowed-domains", hostnames.join(","), "--no-webmcp"];
  let status: "new" | "started" | "closed" = "new";
  let busy = false;
  // The origin the session was opened on; a trusted observation is only read there.
  let home = "";
  let latest: { snapshot: BrowserSnapshot; revision: string } | undefined;
  let highlightUntil = 0;

  const command = (args: readonly string[], failure: BrowserRuntimeErrorCode, timeout = commandTimeout) =>
    browserCommand(run, [...flags, ...args], timeout, failure);

  function allowedUrl(value: unknown): URL {
    if (typeof value !== "string") throw new BrowserRuntimeError("INVALID_BROWSER_OUTPUT");
    let url: URL;
    try { url = new URL(value); }
    catch { throw new BrowserRuntimeError("DOMAIN_BLOCKED"); }
    if (!["http:", "https:"].includes(url.protocol) || !hostnames.includes(url.hostname) || url.username || url.password) {
      throw new BrowserRuntimeError("DOMAIN_BLOCKED");
    }
    return url;
  }

  function approvedUrl(value: unknown): string {
    const url = allowedUrl(value);
    const route = url.pathname + url.hash;
    if (!origins.has(url.origin) || !routes.has(route) || url.search) throw new BrowserRuntimeError("DOMAIN_BLOCKED");
    return url.origin + route;
  }

  async function exclusive<T>(operation: () => Promise<T>): Promise<T> {
    if (busy) throw new BrowserRuntimeError("BROWSER_BUSY");
    busy = true;
    try { return await operation(); }
    finally { busy = false; }
  }

  function started(): void {
    if (status === "closed") throw new BrowserRuntimeError("SESSION_CLOSED");
    if (status === "new") throw new BrowserRuntimeError("BROWSER_NOT_STARTED");
  }

  async function observe(timeout = commandTimeout) {
    const deadline = performance.now() + timeout;
    const budget = () => Math.max(1, Math.ceil(deadline - performance.now()));
    const data = await command(["snapshot", "-i"], "SNAPSHOT_FAILED", budget());
    const url = approvedUrl(data.origin);
    const elements = normalizeSnapshot(data, labels);
    let observation: string | undefined;
    if (trusted && url === home + trusted.route) {
      const reply = await command(["get", "text", trusted.selector], "SNAPSHOT_FAILED", budget());
      if (approvedUrl(reply.origin) !== url || typeof reply.text !== "string") throw new BrowserRuntimeError("INVALID_BROWSER_OUTPUT");
      observation = states.get(reply.text.trim());
    }
    // Raw browser output stays local and is discarded. The digest is only for
    // equality, so typing can trigger a rescan without publishing form values.
    const revision = createHash("sha256").update(JSON.stringify([url, data.snapshot, elements, observation])).digest("hex");
    return { snapshot: Object.freeze({ url, elements, ...(observation === undefined ? {} : { observation }) }), revision };
  }

  // One fresh observation compared with the one `from` was taken from: refs are only valid while
  // the page is unchanged, so any drift invalidates them all.
  async function currentSnapshot(from: BrowserSnapshot) {
    started();
    const prior = latest;
    if (!prior || prior.snapshot !== from) throw new BrowserRuntimeError("REF_NOT_FOUND");
    const current = await observe();
    if (current.revision !== prior.revision) throw new BrowserRuntimeError("REF_NOT_FOUND");
    return current;
  }

  async function currentTarget(ref: ElementRef, from: BrowserSnapshot) {
    started();
    if (!/^@e[1-9]\d{0,8}$/u.test(ref) || !from.elements.some(element => element.ref === ref)) {
      throw new BrowserRuntimeError("REF_NOT_FOUND");
    }
    return currentSnapshot(from);
  }

  const semanticId = (value: unknown) =>
    typeof value === "string" && /^[A-Za-z][A-Za-z0-9.]{0,79}$/u.test(value) ? value : null;

  return {
    start: options => exclusive(async () => {
      if (status === "closed") throw new BrowserRuntimeError("SESSION_CLOSED");
      if (status === "started") throw new BrowserRuntimeError("BROWSER_BUSY");
      const startUrl = approvedUrl(options.url);
      home = new URL(startUrl).origin;
      try {
        await command([...(options.headed ? ["--headed"] : []), "open", startUrl], "NAVIGATION_FAILED", 15_000);
        approvedUrl((await command(["get", "url"], "NAVIGATION_FAILED")).url);
        status = "started";
      } catch (error) {
        status = "closed";
        await command(["close"], "CLOSE_FAILED").catch(() => undefined);
        throw error;
      }
    }),
    snapshot: () => exclusive(async () => {
      started();
      latest = undefined;
      latest = await observe();
      return latest.snapshot;
    }),
    inspectSemanticId: (ref, from) => exclusive(async () => {
      const current = await currentTarget(ref, from);
      const attribute = await command(["get", "attr", ref, "data-ai-id"], "REF_NOT_FOUND");
      if (approvedUrl(attribute.origin) !== current.snapshot.url) throw new BrowserRuntimeError("REF_NOT_FOUND");
      return semanticId(attribute.value);
    }),
    inspectSemanticIds: from => exclusive(async () => {
      const current = await currentSnapshot(from);
      const found = new Map<ElementRef, string | null>();
      // Candidates past the bound are not inspected and are absent from the result.
      for (const { ref } of from.elements.slice(0, maxInspected)) {
        let attribute: Record<string, unknown> | undefined;
        try { attribute = await command(["get", "attr", ref, "data-ai-id"], "REF_NOT_FOUND"); }
        catch (error) {
          // A timeout means the browser is unusable: abort. One unreadable element (gone, no attribute,
          // unusable reply) is only unknown, which is never a trusted target.
          if (!(error instanceof BrowserRuntimeError) || (error.code !== "REF_NOT_FOUND" && error.code !== "INVALID_BROWSER_OUTPUT")) throw error;
        }
        if (attribute !== undefined) {
          // Policy violations throw. Navigation during the batch is drift for every candidate.
          if (approvedUrl(attribute.origin) !== current.snapshot.url) throw new BrowserRuntimeError("REF_NOT_FOUND");
          found.set(ref, semanticId(attribute.value));
        } else found.set(ref, null);
      }
      return found;
    }),
    highlight: (ref, from) => exclusive(async () => {
      const current = await currentTarget(ref, from);
      for (const property of ["visible", "enabled"]) {
        const reply = await command(["is", property, ref], "HIGHLIGHT_FAILED");
        if (approvedUrl(reply.origin) !== current.snapshot.url || reply[property] !== true) {
          throw new BrowserRuntimeError("REF_NOT_FOUND");
        }
      }
      const highlighted = await command(["highlight", ref], "HIGHLIGHT_FAILED");
      if (highlighted.highlighted !== ref) throw new BrowserRuntimeError("INVALID_BROWSER_OUTPUT");
      if (approvedUrl((await command(["get", "url"], "HIGHLIGHT_FAILED")).url) !== current.snapshot.url) {
        throw new BrowserRuntimeError("REF_NOT_FOUND");
      }
      highlightUntil = performance.now() + 3_000;
    }),
    // The pinned CLI removes its own outline after three seconds and has no clear command.
    clearHighlight: () => exclusive(async () => {
      started();
      await sleep(Math.max(0, highlightUntil - performance.now()));
    }),
    getUrl: () => exclusive(async () => {
      started();
      return approvedUrl((await command(["get", "url"], "NAVIGATION_FAILED")).url);
    }),
    waitForChange: options => exclusive(async () => {
      started();
      const timeout = options?.timeoutMs ?? 30_000;
      const deadline = performance.now() + (Number.isFinite(timeout) ? Math.min(60_000, Math.max(0, timeout)) : 30_000);
      const nextObservation = () => observe(Math.min(commandTimeout, Math.max(1, deadline - performance.now())));
      try {
        if (performance.now() >= deadline) return { status: "timeout" };
        const baseline = latest ?? await nextObservation();
        while (performance.now() < deadline) {
          const current = await nextObservation();
          latest = current;
          if (current.revision !== baseline.revision) return { status: "changed", snapshot: current.snapshot };
          await sleep(Math.max(0, Math.min(300, deadline - performance.now())));
        }
      } catch (error) {
        if (!(error instanceof BrowserRuntimeError) || error.code !== "BROWSER_TIMEOUT" || performance.now() < deadline) throw error;
      }
      return { status: "timeout" };
    }),
    close: () => exclusive(async () => {
      if (status !== "started") return;
      await command(["close"], "CLOSE_FAILED");
      status = "closed";
      latest = undefined;
    }),
  };
}
