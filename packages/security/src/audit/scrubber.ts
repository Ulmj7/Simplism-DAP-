/**
 * @dap/security: audit/scrubber.ts
 *
 * T085 / FR-041. The last defence before anything is written to the audit trail: secret-shaped text is redacted and
 * the value is bounded in size and depth. Applied to EVERY recorded value, whatever produced it (a projected parameter,
 * an attempted action name, a resource id), so a secret that slipped past an allowlist still never reaches the log.
 *
 * Patterns: JWT-like tokens (three base64url segments whose header is JSON: `eyJ…`, or decoding to an object with `alg` or `typ`), `sk-` style API keys,
 * `AKIA` access key ids, and runs of 32 or more hex characters. Text that only matches once invisible characters are removed
 * (a zero-width space inside a key) is redacted whole: a disguised secret is still a secret.
 *
 * Never throws: anything it cannot read as plain JSON data (getters that throw, proxies, cycles, bigints, functions,
 * symbols, non-finite numbers) becomes the marker `[unserializable]`.
 */
import type { JsonValue } from "@dap/contracts";

export const REDACTED = "[redacted]";
export const TRUNCATED = "[truncated]";
export const UNSERIALIZABLE = "[unserializable]";

/** Bounds on what one recorded value may be. Small on purpose: an audit row is a summary, not a copy of the request. */
export const SCRUB_LIMITS = Object.freeze({ maxDepth: 6, maxString: 1024, maxEntries: 64, maxNodes: 1024 });

// Consume a whole candidate run once: retrying a greedy `eyJ...` pattern at each prefix can be quadratic.
const RE_JWT_LIKE = /(?<![A-Za-z0-9_-])(?=([A-Za-z0-9_-]{4,})\.([A-Za-z0-9_-]{4,})\.([A-Za-z0-9_-]{4,})(?![A-Za-z0-9_-]))/g;
const RE_SK_KEY = /sk-[A-Za-z0-9_-]{16,}/g;
const RE_AKIA_KEY = /AKIA[A-Z0-9]{16}/g;
const RE_HEX_RUN = /[0-9a-fA-F]{32,}/g;
// Zero-width and soft-hyphen characters, byte-order mark, and bidi/word-joiner controls: invisible, so a secret can hide in them.
const RE_INVISIBLE = /\p{Default_Ignorable_Code_Point}/gu;
const RE_BASE64 = /(?<![A-Za-z0-9+/_-])[A-Za-z0-9+/_-]{16,}={0,2}(?![A-Za-z0-9+/_=-])/g;

function isJwtHeader(segment: string): boolean {
  try {
    // Anything that is not an object (a number, null, a string) makes Reflect.get throw: not a JWT header.
    const header = JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as object;
    return typeof Reflect.get(header, "alg") === "string" || Reflect.get(header, "typ") === "JWT";
  } catch { return false; }
}

function redactJwt(text: string): string {
  const spans: { start: number; end: number }[] = [];
  // Inspect overlapping triples: a harmless `word.` prefix must not consume the real JWT header.
  for (const match of text.matchAll(RE_JWT_LIKE)) {
    const header = match[1]!;
    const jsonPrefix = header.indexOf("eyJ");
    let offset: number | undefined = jsonPrefix >= 0 && header.length - jsonPrefix >= 7 ? jsonPrefix : undefined;
    // Check bounded suffixes too: a valid header can be glued to an ordinary word.
    // Long opaque triples are conservatively redacted, keeping this scan bounded.
    if (offset === undefined && header.length > 256) offset = 0;
    if (offset === undefined) {
      for (let index = 0; index < header.length; index++) if (isJwtHeader(header.slice(index))) { offset = index; break; }
    }
    if (offset === undefined) continue;
    const start = match.index + offset;
    const end = match.index + header.length + match[2]!.length + match[3]!.length + 2;
    const previous = spans.at(-1);
    if (previous && start <= previous.end) previous.end = Math.max(previous.end, end);
    else spans.push({ start, end });
  }
  let cursor = 0;
  let out = "";
  for (const { start, end } of spans) { out += text.slice(cursor, start) + REDACTED; cursor = end; }
  return out + text.slice(cursor);
}
function redactSecrets(text: string): string {
  return redactJwt(text).replace(RE_SK_KEY, REDACTED).replace(RE_AKIA_KEY, REDACTED).replace(RE_HEX_RUN, REDACTED);
}

/** Detection only: preserve ordinary encoded text, but inspect common encodings and split secret chunks. */
function visibleForSecrets(text: string): string {
  let visible = text;
  for (let pass = 0; pass < 3; pass++) {
    const decoded = visible
      .replace(/(?:%[0-9a-f]{2})+/gi, (encoded) => { try { return decodeURIComponent(encoded); } catch { return encoded; } })
      .replace(/&#(x[0-9a-f]+|[0-9]+);/gi, (encoded, number: string) => {
        const code = Number.parseInt(number.startsWith("x") || number.startsWith("X") ? number.slice(1) : number, /^[xX]/.test(number) ? 16 : 10);
        return code <= 0x10ffff ? String.fromCodePoint(code) : encoded;
      })
      .replace(/\\u\{([0-9a-f]{1,6})\}|\\u([0-9a-f]{4})|\\x([0-9a-f]{2})/gi, (encoded, point: string | undefined, unit: string | undefined, byte: string | undefined) => {
        const code = Number.parseInt(point ?? unit ?? byte!, 16);
        return code <= 0x10ffff ? String.fromCodePoint(code) : encoded;
      })
      .normalize("NFKC").replace(RE_INVISIBLE, "").replace(/\s+/gu, "");
    if (decoded === visible) break;
    visible = decoded;
  }
  return visible;
}

function encodedSecret(text: string): boolean {
  for (const match of text.matchAll(RE_BASE64)) {
    const decoded = visibleForSecrets(Buffer.from(match[0], "base64").toString("utf8"));
    if (redactSecrets(decoded) !== decoded) return true;
  }
  return false;
}

/** Redacts secret-shaped text and bounds the length. Text that is secret-shaped only once invisible characters are removed is redacted whole. */
export function scrubText(text: string): string {
  try {
    const clean = redactSecrets(text);
    const visible = visibleForSecrets(clean);
    // Disguise (invisible or look-alike characters) around anything secret-shaped: the whole value goes, not just the part that still matches.
    if ((visible !== clean && redactSecrets(visible) !== visible) || encodedSecret(visible)) return REDACTED;
    // Detect before the cap: otherwise a token crossing the cut leaves a readable secret prefix.
    return text.length > SCRUB_LIMITS.maxString ? `${clean.slice(0, SCRUB_LIMITS.maxString)}${TRUNCATED}` : clean;
  } catch { return UNSERIALIZABLE; }
}

/** A recorded value: plain, frozen JSON, redacted and bounded. Never throws. */
export function scrubJson(value: unknown): JsonValue {
  const budget = { nodes: 0 };
  const active = new Set<object>();
  const fragments: string[] = [];
  const walk = (node: unknown, depth: number): JsonValue => {
    if (++budget.nodes > SCRUB_LIMITS.maxNodes) return TRUNCATED;
    if (node === null || typeof node === "boolean") return node;
    if (typeof node === "string") { const clean = scrubText(node); fragments.push(clean); return clean; }
    if (typeof node === "number") return Number.isFinite(node) ? node : UNSERIALIZABLE;
    if (typeof node !== "object") return UNSERIALIZABLE;
    if (depth >= SCRUB_LIMITS.maxDepth) return TRUNCATED;
    if (active.has(node)) return UNSERIALIZABLE;
    active.add(node);
    try {
      if (Array.isArray(node)) {
        const length: unknown = Reflect.get(node, "length");
        if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0) return UNSERIALIZABLE;
        const items: JsonValue[] = [];
        for (let index = 0; index < Math.min(length, SCRUB_LIMITS.maxEntries); index++) items.push(walk(Reflect.get(node, String(index)), depth + 1));
        if (length > SCRUB_LIMITS.maxEntries) items.push(TRUNCATED);
        return Object.freeze(items);
      }
      const keys = Object.keys(node);
      const out: { [key: string]: JsonValue } = Object.create(null) as { [key: string]: JsonValue };
      let kept = 0;
      for (const key of keys) {
        if (kept >= SCRUB_LIMITS.maxEntries) { out[TRUNCATED] = TRUNCATED; break; }
        const safeKey = scrubText(key);
        if (Object.hasOwn(out, safeKey)) continue;
        out[safeKey] = walk(Reflect.get(node, key), depth + 1);
        kept++;
      }
      return Object.freeze(out);
    } catch { return UNSERIALIZABLE; } finally { active.delete(node); }
  };
  const clean = walk(value, 0);
  if (clean !== null && typeof clean === "object" && fragments.length > 1) {
    // A secret split over fields/elements is still recoverable. Collapse its bounded summary.
    for (const separator of ["", "."]) {
      const joined = visibleForSecrets(fragments.join(separator));
      if (redactSecrets(joined) !== joined || encodedSecret(joined)) return Object.freeze(Array.isArray(clean) ? [REDACTED] : { [REDACTED]: REDACTED });
    }
  }
  return clean;
}
