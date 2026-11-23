/**
 * @dap/testkit: leak-scanner.ts (T029)
 *
 * LeakScanner walks JSON-like values (strings, arrays, plain objects) and reports what a
 * planner-visible value must NEVER contain. Findings are `{kind, path}` ONLY — the leaked
 * value itself is never included in a finding.
 *
 * Kinds:
 *  - canary: any registered canary substring (canary-secret registry).
 *  - stack-trace: V8-style frames (`at Foo (file.js:1:2)`) or an `Error:` line followed by an
 *    `at ` frame.
 *  - secret-shaped: JWT-like base64url triples with a JSON token header,
 *    `sk-` + 16+ alnum, `AKIA` + 16 uppercase alnum, or 32+ consecutive hex chars.
 *  - reason-code: any delimited internal value from the contract REASON_CODES.
 *  - confirmation-id: UUID-shaped strings (confirmation ids are never handed to the planner).
 *
 * Traversal is iterative and cycle-safe; unreadable output yields a scan-error finding.
 * A single string yields at most ONE finding per kind (multiple pattern hits of the same
 * kind collapse), keeping results deterministic and deduplicated.
 */
import { REASON_CODES } from "@dap/contracts";

export type LeakKind =
  | "canary"
  | "stack-trace"
  | "secret-shaped"
  | "reason-code"
  | "confirmation-id"
  | "scan-error";

export interface LeakFinding {
  readonly kind: LeakKind;
  /** JSON path: "$" for the root, "$.0" for array items, "$.a.b" for object keys. */
  readonly path: string;
}

export interface LeakScannerOptions {
  /** Canaries registered at construction. Add more with registerCanary(). */
  readonly canaries?: readonly string[];
}

const RE_STACK_FRAME = /(?:^|\n)\s*at\s+(?:.*?\()?[^()\n]+:\d+:\d+\)?(?:\n|$)/;
const RE_ERROR_THEN_AT = /\bError\b[^\n]*\n\s*at\s/;
const RE_JWT_LIKE = /(?:^|[^A-Za-z0-9_-])([A-Za-z0-9_-]{4,})\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}(?=$|[^A-Za-z0-9_-])/g;
const RE_SK_KEY = /sk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{16,}/;
const RE_AKIA_KEY = /AKIA[A-Z0-9]{16}/;
const RE_HEX_RUN = /[0-9a-fA-F]{32,}/;
const RE_UUID = /(?<![0-9a-z])[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}(?![0-9a-z])/i;
const REASON_CODE_SET: ReadonlySet<string> = new Set(REASON_CODES);
const RE_REASON = new RegExp(`\\b(?:${REASON_CODES.filter((code) => code.includes("_")).join("|")})\\b`);

function hasJwt(value: string): boolean {
  for (const match of value.matchAll(RE_JWT_LIKE)) {
    try {
      const header: unknown = JSON.parse(Buffer.from(match[1]!, "base64url").toString("utf8"));
      if (header !== null && typeof header === "object" &&
        (typeof Reflect.get(header, "alg") === "string" || Reflect.get(header, "typ") === "JWT")) return true;
    } catch { /* Ordinary dotted words are not token headers. */ }
  }
  return false;
}

export class LeakScanner {
  private readonly canaries: string[] = [];

  constructor(options: LeakScannerOptions = {}) {
    for (const canary of options.canaries ?? []) {
      this.registerCanary(canary);
    }
  }

  /** Register a canary secret; any occurrence of this substring in a scanned string is a finding. */
  registerCanary(canary: string): void {
    if (canary.length > 0 && !this.canaries.includes(canary)) {
      this.canaries.push(canary);
    }
  }

  /** Scan keys and values iteratively: deep output cannot silently evade the scanner. */
  scan(value: unknown): readonly LeakFinding[] {
    const findings: LeakFinding[] = [];
    const pending = [{ value, path: "$" }];
    const seen = new WeakSet<object>();
    while (pending.length > 0) {
      const { value: item, path } = pending.pop()!;
      if (typeof item === "string") { this.recordStringFindings(item, path, findings); continue; }
      if (typeof item !== "object" || item === null || seen.has(item)) continue;
      seen.add(item);
      try {
        const keys = Reflect.ownKeys(item);
        keys.forEach((key, index) => {
          const keyFindings: LeakFinding[] = [];
          const label = typeof key === "string" ? key : String(key);
          this.recordStringFindings(label, "", keyFindings);
          const childPath = keyFindings.length > 0 || typeof key === "symbol"
            ? `${path}[key:${index}]` : `${path}.${label}`;
          for (const finding of keyFindings) findings.push({ kind: finding.kind, path: childPath });
          try { pending.push({ value: Reflect.get(item, key), path: childPath }); }
          catch { findings.push({ kind: "scan-error", path: childPath }); }
        });
      } catch { findings.push({ kind: "scan-error", path }); }
    }
    const unique = new Map(findings.map((finding) => [JSON.stringify([finding.kind, finding.path]), Object.freeze(finding)]));
    return Object.freeze([...unique.values()]);
  }

  private recordStringFindings(value: string, path: string, findings: LeakFinding[]): void {
    if (this.canaries.some((canary) => value.includes(canary))) {
      findings.push({ kind: "canary", path });
    }
    if (RE_STACK_FRAME.test(value) || RE_ERROR_THEN_AT.test(value)) {
      findings.push({ kind: "stack-trace", path });
    }
    if (
      hasJwt(value) ||
      RE_SK_KEY.test(value) ||
      RE_AKIA_KEY.test(value) ||
      RE_HEX_RUN.test(value)
    ) {
      findings.push({ kind: "secret-shaped", path });
    }
    if (REASON_CODE_SET.has(value) || RE_REASON.test(value)) {
      findings.push({ kind: "reason-code", path });
    }
    if (RE_UUID.test(value)) {
      findings.push({ kind: "confirmation-id", path });
    }
  }
}
