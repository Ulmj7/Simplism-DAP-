/**
 * @dap/security: validation/strict-json.ts
 *
 * T061 / FR-014. Strict intake of untrusted proposal data.
 *
 * Own strict RFC 8259 parser — NOT JSON.parse, which silently keeps only the
 * last duplicate key and accepts nothing special but cannot report duplicates.
 * Never throws for any INPUT and never echoes input content in its result; it
 * throws a RangeError only for invalid OPTIONS (a programmer error: a cap that
 * is NaN or not a positive safe integer would otherwise silently disable the cap).
 *
 * Rejects: payloads over maxPayloadBytes UTF-8 bytes, nesting over maxJsonDepth,
 * duplicate keys, `__proto__` / `constructor` / `prototype` keys, non-finite
 * numbers, numbers of magnitude beyond 2^53-1 (every such double is an
 * integer that may silently name a different id or amount than the text did,
 * and the two branches below must agree on what a number is), and lone surrogates (they are not
 * Unicode text and break UTF-8 encoders and jsonb stores). Negative zero is
 * normalized to 0. Property accessors ARE honoured, once each: ATK-PARAMS-12
 * requires the validated copy, not a second read, to be what executes.
 *
 * An already-parsed (non-string) input is deep-copied exactly once into plain
 * data before any check, so getters and proxies are read exactly once and cannot
 * change their answers mid-validation. The copy is charged against the SAME byte
 * cap, measured as the compact JSON the value would serialize to, so a value is
 * accepted exactly when its compact text would be. Only data survives: symbol
 * keys, non-enumerable properties, array extras and holes are rejected, never
 * silently dropped. Shared references are copied as separate subtrees; only a
 * real cycle is rejected, and the byte cap bounds any expansion.
 */
import type { JsonValue } from "@dap/contracts";

/** Why strict intake rejected its input. Closed set; no input content. */
export type StrictJsonCode =
  | "too_large"
  | "too_deep"
  | "duplicate_key"
  | "forbidden_key"
  | "not_finite"
  | "unsafe_number"
  | "not_plain"
  | "syntax";

/** A number that is not a usable value. Reported only after the whole document has been judged structurally. */
export type NumberFault = "not_finite" | "unsafe_number";

/**
 * Success carries a deeply frozen plain JSON value; failure carries only the
 * code. There is no error string, so nothing from the input can leak out.
 */
export type StrictJsonResult =
  | { ok: true; readonly value: JsonValue }
  | { ok: false; readonly code: StrictJsonCode };

export interface StrictJsonOptions {
  /** UTF-8 byte cap for string input. Default 16384. */
  readonly maxPayloadBytes?: number;
  /** Maximum nesting depth (containers count). Default 8. */
  readonly maxJsonDepth?: number;
}

const FORBIDDEN_KEYS: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
]);

const WHITESPACE: ReadonlySet<number> = new Set([0x20, 0x09, 0x0a, 0x0d]);

function isDigit(code: number): boolean {
  return code >= 0x30 && code <= 0x39;
}

/** UTF-8 bytes of `text`. Lone surrogates count 3 bytes, as an encoder emits U+FFFD. Callers bound `text.length` first. */
function utf8ByteLength(text: string): number {
  let bytes = 0;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 0x80) {
      bytes += 1;
    } else if (code < 0x800) {
      bytes += 2;
    } else if (
      (code >= 0xd800 && code <= 0xdbff) &&
      i + 1 < text.length &&
      text.charCodeAt(i + 1) >= 0xdc00 &&
      text.charCodeAt(i + 1) <= 0xdfff
    ) {
      bytes += 4;
      i += 1;
    } else {
      bytes += 3;
    }
  }
  return bytes;
}

function limitOption(value: unknown, fallback: number, name: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`Invalid ${name}`);
  }
  return value;
}

const isHighSurrogate = (code: number): boolean => code >= 0xd800 && code <= 0xdbff;
const isLowSurrogate = (code: number): boolean => code >= 0xdc00 && code <= 0xdfff;

function freeze(value: JsonValue): JsonValue {
  if (Array.isArray(value)) {
    for (const element of value) freeze(element);
    Object.freeze(value);
    return value;
  }
  if (typeof value === "object" && value !== null) {
    for (const element of Object.values(value)) freeze(element);
    Object.freeze(value);
    return value;
  }
  return value;
}

class Parser {
  private pos = 0;
  /** The first number fault. Parsing goes on (with 0 as a placeholder) so a structural fault anywhere outranks it. */
  numberFault: NumberFault | undefined;

  constructor(
    private readonly text: string,
    private readonly maxDepth: number,
  ) {}

  parseDocument(): StrictJsonResult {
    const result = this.parseValue(0);
    if (!result.ok) return result;
    this.skipWs();
    if (this.pos < this.text.length) return { ok: false, code: "syntax" };
    return { ok: true, value: result.value };
  }

  private skipWs(): void {
    const { text } = this;
    while (this.pos < text.length && WHITESPACE.has(text.charCodeAt(this.pos))) {
      this.pos += 1;
    }
  }

  private parseValue(depth: number): StrictJsonResult {
    this.skipWs();
    const text = this.text;
    if (this.pos >= text.length) return { ok: false, code: "syntax" };
    switch (text[this.pos]) {
      case "{":
        return this.parseObject(depth);
      case "[":
        return this.parseArray(depth);
      case '"':
        return this.parseString();
      case "t":
        return this.parseLiteral("true", true);
      case "f":
        return this.parseLiteral("false", false);
      case "n":
        return this.parseLiteral("null", null);
      default: {
        if (text[this.pos] === "-" || isDigit(text.charCodeAt(this.pos))) {
          return this.parseNumber();
        }
        return { ok: false, code: "syntax" };
      }
    }
  }

  private parseLiteral(literal: string, value: JsonValue): StrictJsonResult {
    if (this.text.startsWith(literal, this.pos)) {
      this.pos += literal.length;
      return { ok: true, value };
    }
    return { ok: false, code: "syntax" };
  }

  private parseObject(depth: number): StrictJsonResult {
    const depthIn = depth + 1;
    if (depthIn > this.maxDepth) return { ok: false, code: "too_deep" };
    this.pos += 1; // consume "{"
    const object: Record<string, JsonValue> = {};
    const seen = new Set<string>();
    this.skipWs();
    if (this.text[this.pos] === "}") {
      this.pos += 1;
      return { ok: true, value: object };
    }
    for (;;) {
      this.skipWs();
      if (this.text[this.pos] !== '"') return { ok: false, code: "syntax" };
      const keyResult = this.parseString();
      if (!keyResult.ok) return keyResult;
      const key = keyResult.value as string;
      if (FORBIDDEN_KEYS.has(key)) return { ok: false, code: "forbidden_key" };
      if (seen.has(key)) return { ok: false, code: "duplicate_key" };
      seen.add(key);
      this.skipWs();
      if (this.text[this.pos] !== ":") return { ok: false, code: "syntax" };
      this.pos += 1;
      const valueResult = this.parseValue(depthIn);
      if (!valueResult.ok) return valueResult;
      object[key] = valueResult.value;
      this.skipWs();
      const next = this.text[this.pos];
      if (next === ",") {
        this.pos += 1;
        continue;
      }
      if (next === "}") {
        this.pos += 1;
        return { ok: true, value: object };
      }
      return { ok: false, code: "syntax" };
    }
  }

  private parseArray(depth: number): StrictJsonResult {
    const depthIn = depth + 1;
    if (depthIn > this.maxDepth) return { ok: false, code: "too_deep" };
    this.pos += 1; // consume "["
    const array: JsonValue[] = [];
    this.skipWs();
    if (this.text[this.pos] === "]") {
      this.pos += 1;
      return { ok: true, value: array };
    }
    for (;;) {
      const valueResult = this.parseValue(depthIn);
      if (!valueResult.ok) return valueResult;
      array.push(valueResult.value);
      this.skipWs();
      const next = this.text[this.pos];
      if (next === ",") {
        this.pos += 1;
        continue;
      }
      if (next === "]") {
        this.pos += 1;
        return { ok: true, value: array };
      }
      return { ok: false, code: "syntax" };
    }
  }

  /** Four hex digits at `at` as a UTF-16 code unit, or undefined. No regex: nothing here can backtrack. */
  private hex4(at: number): number | undefined {
    let unit = 0;
    for (let i = 0; i < 4; i += 1) {
      const code = this.text.charCodeAt(at + i);
      let digit: number;
      if (code >= 0x30 && code <= 0x39) digit = code - 0x30;
      else if (code >= 0x61 && code <= 0x66) digit = code - 0x57;
      else if (code >= 0x41 && code <= 0x46) digit = code - 0x37;
      else return undefined;
      unit = unit * 16 + digit;
    }
    return unit;
  }

  private parseString(): StrictJsonResult {
    const text = this.text;
    this.pos += 1; // consume opening quote
    let out = "";
    for (;;) {
      if (this.pos >= text.length) return { ok: false, code: "syntax" };
      const char = text.charAt(this.pos);
      const code = char.charCodeAt(0);
      if (char === '"') {
        this.pos += 1;
        return { ok: true, value: out };
      }
      if (char === "\\") {
        this.pos += 1;
        if (this.pos >= text.length) return { ok: false, code: "syntax" };
        const escape = text[this.pos];
        switch (escape) {
          case '"':
            out += '"';
            this.pos += 1;
            break;
          case "\\":
            out += "\\";
            this.pos += 1;
            break;
          case "/":
            out += "/";
            this.pos += 1;
            break;
          case "b":
            out += "\b";
            this.pos += 1;
            break;
          case "f":
            out += "\f";
            this.pos += 1;
            break;
          case "n":
            out += "\n";
            this.pos += 1;
            break;
          case "r":
            out += "\r";
            this.pos += 1;
            break;
          case "t":
            out += "\t";
            this.pos += 1;
            break;
          case "u": {
            const unit = this.hex4(this.pos + 1);
            if (unit === undefined) return { ok: false, code: "syntax" };
            if (isLowSurrogate(unit)) return { ok: false, code: "syntax" };
            if (isHighSurrogate(unit)) {
              // A high surrogate must be completed by an escaped low surrogate; anything else is a lone surrogate.
              const next = text.startsWith("\\u", this.pos + 5) ? this.hex4(this.pos + 7) : undefined;
              if (next === undefined || !isLowSurrogate(next)) return { ok: false, code: "syntax" };
              out += String.fromCharCode(unit, next);
              this.pos += 11;
              break;
            }
            out += String.fromCharCode(unit);
            this.pos += 5;
            break;
          }
          default:
            return { ok: false, code: "syntax" };
        }
      } else {
        if (code < 0x20) return { ok: false, code: "syntax" };
        if (isLowSurrogate(code)) return { ok: false, code: "syntax" };
        if (isHighSurrogate(code)) {
          const next = text.charCodeAt(this.pos + 1);
          if (!isLowSurrogate(next)) return { ok: false, code: "syntax" };
          out += char + text.charAt(this.pos + 1);
          this.pos += 2;
          continue;
        }
        out += char;
        this.pos += 1;
      }
    }
  }

  private parseNumber(): StrictJsonResult {
    const text = this.text;
    const start = this.pos;
    if (text[this.pos] === "-") this.pos += 1;
    if (this.pos >= text.length || !isDigit(text.charCodeAt(this.pos))) {
      return { ok: false, code: "syntax" };
    }
    let nonZero = false;
    if (text[this.pos] === "0") {
      const next = text[this.pos + 1];
      if (next !== undefined && isDigit(next.charCodeAt(0))) {
        return { ok: false, code: "syntax" };
      }
      this.pos += 1;
    } else {
      nonZero = true;
      this.pos += 1;
      while (this.pos < text.length && isDigit(text.charCodeAt(this.pos))) {
        this.pos += 1;
      }
    }
    if (text[this.pos] === ".") {
      this.pos += 1;
      if (this.pos >= text.length || !isDigit(text.charCodeAt(this.pos))) {
        return { ok: false, code: "syntax" };
      }
      while (this.pos < text.length && isDigit(text.charCodeAt(this.pos))) {
        if (text.charCodeAt(this.pos) !== 0x30) nonZero = true;
        this.pos += 1;
      }
    }
    if (text[this.pos] === "e" || text[this.pos] === "E") {
      this.pos += 1;
      if (text[this.pos] === "+" || text[this.pos] === "-") this.pos += 1;
      if (this.pos >= text.length || !isDigit(text.charCodeAt(this.pos))) {
        return { ok: false, code: "syntax" };
      }
      while (this.pos < text.length && isDigit(text.charCodeAt(this.pos))) {
        this.pos += 1;
      }
    }
    const value = Number(text.slice(start, this.pos));
    // A fault is remembered, not returned: the document is still checked for everything that decides the outcome first.
    if (!Number.isFinite(value)) { this.numberFault ??= "not_finite"; return { ok: true, value: 0 }; }
    // Beyond 2^53-1 a double may name another id; a nonzero literal that underflows to 0 names a different amount.
    if (Math.abs(value) > Number.MAX_SAFE_INTEGER || (value === 0 && nonZero)) { this.numberFault ??= "unsafe_number"; return { ok: true, value: 0 }; }
    // -0 is a distinct double that JSON text cannot distinguish from 0 once canonicalized; return plain 0.
    return { ok: true, value: value === 0 ? 0 : value };
  }
}

/** Internal control flow only: carries a closed code, never input content. */
class Rejection {
  constructor(readonly code: StrictJsonCode) {}
}

const isForbiddenKey = (key: string): boolean => FORBIDDEN_KEYS.has(key);

/** Deep-copies already-parsed data exactly once, enforcing every strict rule while it reads. */
class Copier {
  private used = 0;
  /** The first number fault; the copy continues with 0 so that a structural fault anywhere outranks it. */
  numberFault: NumberFault | undefined;
  /** The containers on the current path. A repeat inside this set is a cycle; a repeat elsewhere is just shared data. */
  private readonly active = new Set<object>();

  constructor(
    private readonly maxDepth: number,
    private readonly maxBytes: number,
  ) {}

  private charge(bytes: number): void {
    this.used += bytes;
    if (this.used > this.maxBytes) throw new Rejection("too_large");
  }

  /** Charges the JSON string literal for `text` (quotes and escapes included) and rejects lone surrogates. */
  private chargeString(text: string): void {
    this.charge(2);
    for (let i = 0; i < text.length; i += 1) {
      const code = text.charCodeAt(i);
      if (code < 0x80) {
        const escaped = code === 0x22 || code === 0x5c || code === 0x08 || code === 0x0c || code === 0x0a || code === 0x0d || code === 0x09;
        this.charge(escaped ? 2 : code < 0x20 ? 6 : 1);
      } else if (code < 0x800) {
        this.charge(2);
      } else if (isHighSurrogate(code)) {
        if (!isLowSurrogate(text.charCodeAt(i + 1))) throw new Rejection("not_plain");
        this.charge(4);
        i += 1;
      } else if (isLowSurrogate(code)) {
        throw new Rejection("not_plain");
      } else {
        this.charge(3);
      }
    }
  }

  copy(value: unknown, depth: number): JsonValue {
    if (value === null) { this.charge(4); return null; }
    switch (typeof value) {
      case "boolean": this.charge(value ? 4 : 5); return value;
      case "string": this.chargeString(value); return value;
      case "number": {
        const fault: NumberFault | undefined = !Number.isFinite(value) ? "not_finite" : Math.abs(value) > Number.MAX_SAFE_INTEGER ? "unsafe_number" : undefined;
        // Charged as the text it would serialize to (NaN and the infinities serialize to null), so a fault cannot hide an oversized payload.
        if (fault) { this.numberFault ??= fault; this.charge(Number.isFinite(value) ? String(value).length : 4); return 0; }
        const normalized = value === 0 ? 0 : value;
        this.charge(String(normalized).length);
        return normalized;
      }
      case "object": return Array.isArray(value) ? this.copyArray(value, depth + 1) : this.copyObject(value, depth + 1);
      default: throw new Rejection("not_plain");
    }
  }

  private enter(container: object, depth: number): void {
    if (depth > this.maxDepth) throw new Rejection("too_deep");
    if (this.active.has(container)) throw new Rejection("not_plain");
    this.active.add(container);
  }

  private copyObject(source: object, depth: number): JsonValue {
    this.enter(source, depth);
    const prototype: unknown = Object.getPrototypeOf(source);
    if (prototype !== Object.prototype && prototype !== null) throw new Rejection("not_plain");
    const out: Record<string, JsonValue> = {};
    this.charge(2);
    let first = true;
    for (const key of Reflect.ownKeys(source)) {
      if (typeof key !== "string") throw new Rejection("not_plain");
      if (isForbiddenKey(key)) throw new Rejection("forbidden_key");
      // Only enumerable own data is data: a hidden property is evidence of something other than JSON.
      if (Object.getOwnPropertyDescriptor(source, key)?.enumerable !== true) throw new Rejection("not_plain");
      if (!first) this.charge(1);
      first = false;
      this.chargeString(key);
      this.charge(1);
      out[key] = this.copy(Reflect.get(source, key), depth);
    }
    this.active.delete(source);
    return out;
  }

  private copyArray(source: unknown[], depth: number): JsonValue {
    this.enter(source, depth);
    if (Object.getPrototypeOf(source) !== Array.prototype) throw new Rejection("not_plain");
    const length: unknown = Reflect.get(source, "length");
    if (typeof length !== "number" || !Number.isSafeInteger(length) || length < 0) throw new Rejection("not_plain");
    const out: JsonValue[] = [];
    this.charge(2);
    // Index by index, charging as we go: a huge or endless array stops at the byte cap, and a hole stops at once.
    for (let index = 0; index < length; index += 1) {
      const key = String(index);
      if (Object.getOwnPropertyDescriptor(source, key)?.enumerable !== true) throw new Rejection("not_plain");
      if (index > 0) this.charge(1);
      out.push(this.copy(Reflect.get(source, key), depth));
    }
    // Anything besides the indices and `length` (named, symbol, or extra) is not array data.
    const keys = Reflect.ownKeys(source);
    if (keys.length !== length + 1 || !keys.includes("length")) throw new Rejection("not_plain");
    this.active.delete(source);
    return out;
  }
}

/** Result of a strict parse that has not yet reported a number fault; see `parseStrictJsonDeferred`. */
export type DeferredStrictJsonResult =
  | { readonly ok: true; readonly value: JsonValue; readonly numberFault?: undefined; readonly shape?: undefined }
  | { readonly ok: true; readonly numberFault: NumberFault; readonly shape: JsonValue; readonly value?: undefined }
  | { readonly ok: false; readonly code: Exclude<StrictJsonCode, NumberFault> };

/**
 * Strict intake of one untrusted value (T061), with number faults deferred.
 *
 * A caller that must classify by STRUCTURE first (the envelope: a planner must not pick its own outcome by
 * putting a number fault ahead of a structural one) gets `{ ok: true, numberFault, shape }` when the document
 * is structurally fine but holds an unusable number. `shape` has 0 in place of every faulty number, so it can
 * be judged for structure but is never `value`: data is only ever offered when every number is usable, and
 * misusing the result as data does not type-check.
 */
export function parseStrictJsonDeferred(
  input: unknown,
  options: StrictJsonOptions = {},
): DeferredStrictJsonResult {
  const maxPayloadBytes = limitOption(options.maxPayloadBytes, 16384, "maxPayloadBytes");
  const maxDepth = limitOption(options.maxJsonDepth, 8, "maxJsonDepth");
  if (typeof input === "string") {
    try {
      // Every UTF-16 code unit is at least one UTF-8 byte, so a longer string is refused unscanned and the scan below is bounded by the cap.
      if (input.length > maxPayloadBytes || utf8ByteLength(input) > maxPayloadBytes) {
        return { ok: false, code: "too_large" };
      }
      const parser = new Parser(input, maxDepth);
      const result = parser.parseDocument();
      if (!result.ok) return result as { ok: false; code: Exclude<StrictJsonCode, NumberFault> };
      return parser.numberFault ? { ok: true, numberFault: parser.numberFault, shape: freeze(result.value) } : { ok: true, value: freeze(result.value) };
    } catch (error) {
      // Only reachable with an absurd depth cap exhausting the stack. Fail closed, never echo.
      return { ok: false, code: error instanceof RangeError ? "too_deep" : "syntax" };
    }
  }
  try {
    const copier = new Copier(maxDepth, maxPayloadBytes);
    const value = freeze(copier.copy(input, 0));
    return copier.numberFault ? { ok: true, numberFault: copier.numberFault, shape: value } : { ok: true, value };
  } catch (error) {
    // A hostile proxy, accessor or exotic value throwing from inside the copy is simply not plain data.
    const code = error instanceof Rejection ? error.code : error instanceof RangeError ? "too_deep" : "not_plain";
    return { ok: false, code: code as Exclude<StrictJsonCode, NumberFault> };
  }
}

/**
 * Strict intake of one untrusted value (T061).
 *
 * String input is parsed by the strict RFC 8259 parser below, under
 * `maxPayloadBytes` (UTF-8 bytes of the raw text, default 16384) and
 * `maxJsonDepth` (default 8) caps. Non-string input is treated as
 * already-parsed data and is deep-copied exactly once (see the module notes);
 * class instances, functions, symbols, bigints, undefined, hidden properties,
 * holes and cycles are rejected, and the copy is what gets checked and returned.
 *
 * Never throws for any input; throws RangeError for an invalid option. Success
 * returns the value deeply frozen; failure returns `{ ok: false, code }` with no
 * input content. A number fault is reported only if the document has no
 * structural fault, so the code never depends on where in the document a fault sits.
 *
 * Known limit: the keys of an already-parsed OBJECT are enumerated before the byte cap can apply (JavaScript
 * has no lazy key enumeration), so feed raw provider text, which the cap bounds before any scan.
 */
export function parseStrictJson(
  input: unknown,
  options: StrictJsonOptions = {},
): StrictJsonResult {
  const result = parseStrictJsonDeferred(input, options);
  if (!result.ok) return result;
  if (result.numberFault) return { ok: false, code: result.numberFault };
  return { ok: true, value: result.value };
}
