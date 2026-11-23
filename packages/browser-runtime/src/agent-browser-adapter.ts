import { createHash, randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { browserCommand, localCli } from "./cli.js";
import type { RunCli } from "./cli.js";
import { BrowserRuntimeError } from "./errors.js";
import type { BrowserRuntimeErrorCode } from "./errors.js";
import { MAX_ALL_ELEMENTS, normalizeSnapshot, usableName } from "./snapshot.js";
import type { ApprovedLabel } from "./snapshot.js";
import type { BrowserElement, BrowserRuntime, BrowserSnapshot, ElementFacts, ElementRef } from "./types.js";

const executable = fileURLToPath(new URL("../../../vendor/agent-browser/cli/target/release/agent-browser", import.meta.url));
const config = fileURLToPath(new URL("../agent-browser.json", import.meta.url));
const commandTimeout = 5_000;
const maxOrigins = 5;
// Upper bound for one batch inspection (one CLI attribute read per candidate).
const maxInspected = 64;
// The constant attribute reads that make up the facts of one element (no caller text ever reaches a command).
const factAttributes = ["type", "autocomplete", "data-ai-private", "data-ai-ignore", "data-ai-redact"] as const;
const maxInputType = 40;
const maxAutocomplete = 200;
// "any" routes: a hash-routed page shape (`/path` plus an optional `#/route`), no query, no percent escapes, no `=`/`&`: a fragment such as `#access_token=…` is never a page.
const anyPage = /^\/[A-Za-z0-9._~/-]*(?:#\/?[A-Za-z0-9._~/-]*)?$/u;
const maxPageChars = 200;
// History routing (`routing: "history"`): the page is the PATHNAME only. Query and fragment of the observed URL are ignored (never returned, never stored, never a reason to refuse), the pathname is
// a static path of letters, digits and `._~/-` without an empty segment, and a trailing slash (except the root) is removed.
const historyPath = /^\/[A-Za-z0-9._~/-]*$/u;

// STATUS AND ALERT REGIONS (labels "all" only). The pinned CLI gives these roles no ref in any snapshot form (verified in Chromium: `snapshot`, `-i`, `-c`, `-s` all list them without one), so the adapter reads
// the ones that carry a data-ai-id marker with CONSTANT XPath queries and a DAP-chosen integer index (never caller text): `get count`, then per element `get attr … data-ai-id`, `is visible` and `get text`.
// Each gets a synthetic ref (`@e9000000NN`, far above any real ref) that maps to its selector for exactly the observation it was returned with: a later page change invalidates it like any other ref.
// Unmarked regions are never read, the text leaves only as a bounded name, and the host still decides what it forwards.
const textRefBase = 900_000_000;
const maxTextElements = 32;
const textKinds = [
  { role: "status", xpath: '//*[@data-ai-id][@role="status" or (self::output and not(@role))]' },
  { role: "alert", xpath: '//*[@data-ai-id][@role="alert"]' },
] as const;

interface TrustedObservation {
  readonly route: string;
  readonly selector: string;
  readonly states: Readonly<Record<string, string>>;
}

export interface AgentBrowserAdapterOptions {
  // Exposure policy: the only role + accessible-name pairs that may leave the adapter. "all" (Studio-managed applications, whose targets are not known in advance) exposes
  // the role and bounded accessible name of every operable control instead, never a value or any text; the caller decides which of them go any further.
  readonly labels: readonly ApprovedLabel[] | "all";
  // Navigation policy: static `pathname + hash` strings the session may be on. "any" accepts any hash-routed page (`/` or `/path`, optional `#/route`, at most 200
  // characters, no query and no characters outside letters, digits and `._~/-`) on an allowed ORIGIN: the exact scheme, host and port stay enforced on every URL.
  readonly routes: readonly string[] | "any";
  // How an application with `routes: "any"` addresses its pages. "hash" (default) is the hash-routed shape above. "history" uses the pathname alone: query and fragment are ignored and never
  // exposed, the pathname must match `^/[A-Za-z0-9._~/-]*$` (at most 200 characters, no `//`), a trailing slash is removed except for "/", and the returned `snapshot.url` is
  // `origin + normalised pathname`. The exact origin stays enforced. "history" needs `routes: "any"`.
  readonly routing?: "hash" | "history";
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
  if (options.labels !== "all" && !Array.isArray(options.labels)) throw new TypeError("labels must be a list of labels or \"all\"");
  if (options.routes !== "any" && !Array.isArray(options.routes)) throw new TypeError("routes must be a list of routes or \"any\"");
  if (options.routing !== undefined && options.routing !== "hash" && options.routing !== "history") throw new TypeError("routing must be \"hash\" or \"history\"");
  if (options.routing === "history" && options.routes !== "any") throw new TypeError("history routing needs routes \"any\"");
  const history = options.routing === "history";
  const labels = options.labels === "all" ? "all" : options.labels.map(label => ({ ...label }));
  const routes = options.routes === "any" ? "any" : new Set(options.routes);
  const { origins, hostnames } = normalizeOrigins(options.origins);
  const trusted = options.observation;
  const states = new Map(Object.entries(trusted?.states ?? {}));
  const session = `dap-${randomUUID()}`;
  const flags = ["--config", config, "--session", session, "--json", "--allowed-domains", hostnames.join(","), "--no-webmcp"];
  let status: "new" | "started" | "closed" = "new";
  let busy = false;
  // The origin the session was opened on; a trusted observation is only read there.
  let home = "";
  let latest: { snapshot: BrowserSnapshot; revision: string; selectors: ReadonlyMap<ElementRef, { selector: string; marker: string }> } | undefined;
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
    if (history) {
      const path = url.pathname.length > 1 && url.pathname.endsWith("/") ? url.pathname.slice(0, -1) : url.pathname;
      if (!origins.has(url.origin) || path.length > maxPageChars || !historyPath.test(path) || url.pathname.includes("//")) throw new BrowserRuntimeError("DOMAIN_BLOCKED");
      return url.origin + path;
    }
    const route = url.pathname + url.hash;
    const page = routes === "any" ? route.length <= maxPageChars && anyPage.test(route) : routes.has(route);
    if (!origins.has(url.origin) || !page || url.search) throw new BrowserRuntimeError("DOMAIN_BLOCKED");
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
    const controls = normalizeSnapshot(data, labels);
    const selectors = new Map<ElementRef, { selector: string; marker: string }>();
    const elements = labels === "all" ? [...controls, ...await textElements(url, selectors, controls.length, budget)] : controls;
    let observation: string | undefined;
    if (trusted && url === home + trusted.route) {
      const reply = await command(["get", "text", trusted.selector], "SNAPSHOT_FAILED", budget());
      if (approvedUrl(reply.origin) !== url || typeof reply.text !== "string") throw new BrowserRuntimeError("INVALID_BROWSER_OUTPUT");
      observation = states.get(reply.text.trim());
    }
    // Raw browser output stays local and is discarded. The digest is only for
    // equality, so typing can trigger a rescan without publishing form values.
    const revision = createHash("sha256").update(JSON.stringify([url, data.snapshot, elements, [...selectors], observation])).digest("hex");
    return { snapshot: Object.freeze({ url, elements: Object.freeze(elements), ...(observation === undefined ? {} : { observation }) }), revision, selectors };
  }

  // The marker-carrying status and alert regions of the page, in document order per kind (status first), with their synthetic refs.
  async function textElements(url: string, selectors: Map<ElementRef, { selector: string; marker: string }>, taken: number, budget: () => number): Promise<BrowserElement[]> {
    const found: BrowserElement[] = [];
    for (const { role, xpath } of textKinds) {
      const counted = await command(["get", "count", `xpath=${xpath}`], "SNAPSHOT_FAILED", budget());
      if (typeof counted.count !== "number" || !Number.isInteger(counted.count) || counted.count < 0 || counted.count > 100_000) throw new BrowserRuntimeError("INVALID_BROWSER_OUTPUT");
      for (let index = 1; index <= Math.min(counted.count, maxTextElements) && found.length < maxTextElements && taken + found.length < MAX_ALL_ELEMENTS; index += 1) {
        const selector = `xpath=(${xpath})[${index}]`;
        const read = async (args: readonly string[]): Promise<Record<string, unknown> | undefined> => {
          try {
            const reply = await command(args, "REF_NOT_FOUND", budget());
            if (approvedUrl(reply.origin) !== url) throw new BrowserRuntimeError("SNAPSHOT_FAILED");
            return reply;
          }
          catch (error) {
            // One region that vanished (or answered unusably) is only unknown; a timeout means the browser is unusable.
            if (!(error instanceof BrowserRuntimeError) || (error.code !== "REF_NOT_FOUND" && error.code !== "INVALID_BROWSER_OUTPUT")) throw error;
            return undefined;
          }
        };
        const marker = await read(["get", "attr", selector, "data-ai-id"]);
        if (marker === undefined) continue;
        const id = semanticId(marker.value);
        if (id === null) continue;
        const visible = await read(["is", "visible", selector]);
        if (visible?.visible !== true) continue;
        const reply = await read(["get", "text", selector]);
        const name = typeof reply?.text === "string" ? usableName(reply.text) : null;
        if (name === null) continue;
        const ref = `@e${textRefBase + found.length}` as ElementRef;
        selectors.set(ref, { selector, marker: id });
        found.push(Object.freeze({ ref, role, name }));
      }
    }
    return found;
  }

  // The command target of a ref of one observation: the CLI ref itself, or the selector of a status or alert region.
  const targetOf = (ref: ElementRef, from: { readonly selectors: ReadonlyMap<ElementRef, { selector: string; marker: string }> }): string => from.selectors.get(ref)?.selector ?? ref;

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

  // The facts of one element from five constant attribute reads. null = not readable (gone, unusable reply, or a value too long to represent): never trusted.
  async function readFacts(ref: string, url: string): Promise<ElementFacts | null> {
    const values: (string | null)[] = [];
    for (const attribute of factAttributes) {
      let reply: Record<string, unknown>;
      try { reply = await command(["get", "attr", ref, attribute], "REF_NOT_FOUND"); }
      catch (error) {
        if (!(error instanceof BrowserRuntimeError) || (error.code !== "REF_NOT_FOUND" && error.code !== "INVALID_BROWSER_OUTPUT")) throw error;
        return null;
      }
      // Policy violations throw. Navigation during the batch is drift for every element.
      if (approvedUrl(reply.origin) !== url) throw new BrowserRuntimeError("REF_NOT_FOUND");
      if (reply.value !== null && typeof reply.value !== "string") return null;
      values.push(reply.value);
    }
    const [type, autocomplete, priv, ignore, redact] = values as [string | null, string | null, string | null, string | null, string | null];
    if ((type?.length ?? 0) > maxInputType || (autocomplete?.length ?? 0) > maxAutocomplete) return null;
    const normal = (value: string | null) => (value === null || value.trim() === "" ? null : value.trim().toLowerCase());
    return Object.freeze({
      tagName: null, inputType: normal(type), autocomplete: normal(autocomplete), dataAiPrivate: priv !== null, dataAiIgnore: ignore !== null, dataAiRedact: redact !== null,
    });
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
      const attribute = await command(["get", "attr", targetOf(ref, current), "data-ai-id"], "REF_NOT_FOUND");
      if (approvedUrl(attribute.origin) !== current.snapshot.url) throw new BrowserRuntimeError("REF_NOT_FOUND");
      return semanticId(attribute.value);
    }),
    inspectSemanticIds: from => exclusive(async () => {
      const current = await currentSnapshot(from);
      const found = new Map<ElementRef, string | null>();
      // Candidates past the bound are not inspected and are absent from the result.
      for (const { ref } of from.elements.slice(0, maxInspected)) {
        let attribute: Record<string, unknown> | undefined;
        try { attribute = await command(["get", "attr", targetOf(ref, current), "data-ai-id"], "REF_NOT_FOUND"); }
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
    inspectElementFacts: (refs, from) => exclusive(async () => {
      started();
      // Pure checks first: a malformed, unknown or surplus ref is refused before any command runs.
      if (!Array.isArray(refs) || refs.length > maxInspected) throw new BrowserRuntimeError("REF_NOT_FOUND");
      const known = new Set<unknown>(from.elements.map(element => element.ref));
      for (const ref of refs as readonly unknown[]) if (typeof ref !== "string" || !/^@e[1-9]\d{0,8}$/u.test(ref) || !known.has(ref)) throw new BrowserRuntimeError("REF_NOT_FOUND");
      const current = await currentSnapshot(from);
      const found = new Map<ElementRef, ElementFacts | null>();
      for (const ref of new Set(refs)) found.set(ref, await readFacts(targetOf(ref, current), current.snapshot.url));
      return found;
    }),
    highlight: (ref, from) => exclusive(async () => {
      const current = await currentTarget(ref, from);
      const target = targetOf(ref, current);
      // A status or alert region is read-only text: it must be visible; enabled does not apply to it.
      for (const property of target === ref ? ["visible", "enabled"] : ["visible"]) {
        const reply = await command(["is", property, target], "HIGHLIGHT_FAILED");
        if (approvedUrl(reply.origin) !== current.snapshot.url || reply[property] !== true) {
          throw new BrowserRuntimeError("REF_NOT_FOUND");
        }
      }
      const highlighted = await command(["highlight", target], "HIGHLIGHT_FAILED");
      if (highlighted.highlighted !== target) throw new BrowserRuntimeError("INVALID_BROWSER_OUTPUT");
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
