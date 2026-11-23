import { describe, expect, it } from "vitest";
import { LeakScanner, type LeakFinding, type LeakKind } from "./leak-scanner.js";

// T029: LeakScanner walks JSON-like values and reports findings as {kind, path} ONLY —
// never the leaked value itself. Every kind gets a positive AND a negative (look-alike) case.

const CANARY = "TESTKIT_CANARY_SECRET";
const HEX32 = "0123456789abcdef0123456789abcdef"; // exactly 32 hex chars
const HEX31 = "0123456789abcdef0123456789abcde"; // 31 chars: must NOT match
const JWT = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ1c2VyIn0.c2lnbmF0dXJl";
const SK_KEY = "sk-abcdefghij1234567890"; // sk- + 20 chars
const AKIA_KEY = "AKIAIOSFODNN7EXAMPLE"; // AKIA + 16 uppercase alnum
const UUID = "123e4567-e89b-42d3-a456-426614174000";

function kindsOf(findings: readonly LeakFinding[]): LeakKind[] {
  return findings.map((f) => f.kind);
}

function expectKinds(value: unknown, expected: readonly LeakKind[] = [], scanner?: LeakScanner): void {
  const s = scanner ?? new LeakScanner({ canaries: [CANARY] });
  expect(kindsOf(s.scan(value)).sort()).toEqual([...expected].sort());
}

describe("LeakScanner — canary kind", () => {
  it("flags a registered canary substring anywhere in a nested string", () => {
    expectKinds({ a: { b: [`no ${CANARY} here`] } }, ["canary"]);
  });

  it("does not flag benign look-alikes of the canary", () => {
    expectKinds({ a: "the word canary, TESTKIT, SECRET — none registered" }, []);
  });

  it("supports registering additional canaries after construction", () => {
    const scanner = new LeakScanner();
    scanner.registerCanary("another-secret");
    expectKinds("leak another-secret now", ["canary"], scanner);
  });
});

describe("LeakScanner — stack-trace kind", () => {
  it("flags 'at Foo (file.js:1:2)' style frames", () => {
    expectKinds("    at foo (file.js:1:2)\n    at bar (baz.ts:3:4)", ["stack-trace"]);
  });

  it("flags an Error: line followed by an at-frame", () => {
    expectKinds("Error: kaboom\n    at explode (a.js:9:9)", ["stack-trace"]);
  });

  it("does not flag benign prose that merely mentions error or 'at'", () => {
    expectKinds("Error: the meeting was cancelled, at 10:30 in room 5");
    expectKinds("no stack trace here, just a note at 3pm");
  });
});

describe("LeakScanner — secret-shaped kind", () => {
  it("flags JWT-like base64url triples", () => {
    expectKinds({ token: JWT }, ["secret-shaped"]);
  });

  it("does not flag short dot-separated words", () => {
    expectKinds("foo.bar.baz", []);
    expectKinds("a.b.c.d", []);
  });

  it("flags sk- prefixed keys of 16+ chars", () => {
    expectKinds(SK_KEY, ["secret-shaped"]);
  });

  it("does not flag short sk- prefixes", () => {
    expectKinds("sk-123456789012345", []); // sk- + only 15 chars
  });

  it("flags AKIA + 16 uppercase alnum", () => {
    expectKinds(AKIA_KEY, ["secret-shaped"]);
  });

  it("does not flag lowercase akia look-alikes", () => {
    expectKinds("akiaiosfodnn7example", []);
  });

  it("flags 32+ consecutive hex characters", () => {
    expectKinds({ digest: HEX32 }, ["secret-shaped"]);
  });

  it("does not flag 31-char hex strings", () => {
    expectKinds(HEX31, []);
  });
});

describe("LeakScanner — reason-code kind", () => {
  it("flags exact REASON_CODES values", () => {
    expectKinds("permission_missing", ["reason-code"]);
    expectKinds({ reason: "replayed_request" }, ["reason-code"]);
  });

  it("does not flag near-miss reason codes", () => {
    expectKinds("permission_missing!", ["reason-code"]);
    expectKinds("unknown_reason", []);
    expectKinds("a permission_missing note", ["reason-code"]);
    expectKinds("permission_missing_suffix", []);
  });
});

describe("LeakScanner — confirmation-id kind", () => {
  it("flags UUID-shaped strings", () => {
    expectKinds({ id: UUID }, ["confirmation-id"]);
  });

  it("does not flag truncated or malformed ids", () => {
    expectKinds("123e4567-e89b-42d3-a456-42661417400", []);
    expectKinds("123e4567-e89b-42d3-a456-42661417400x", []);
  });
});

describe("LeakScanner — traversal and safety", () => {
  it("reports the path of a nested finding", () => {
    const scanner = new LeakScanner({ canaries: [CANARY] });
    const findings = scanner.scan({ a: { b: [CANARY] } });
    expect(findings).toEqual([{ kind: "canary", path: "$.a.b.0" }]);
  });

  it("reports findings without ever including the leaked value", () => {
    const scanner = new LeakScanner({ canaries: [CANARY] });
    const value = {
      jwt: JWT,
      canary: CANARY,
      list: [HEX32, UUID],
    };
    const findings = scanner.scan(value);
    const serialized = JSON.stringify(findings);
    expect(serialized).not.toContain(CANARY);
    expect(serialized).not.toContain(JWT);
    expect(serialized).not.toContain(HEX32);
    expect(serialized).not.toContain(UUID);
    expect(findings.length).toBeGreaterThanOrEqual(4);
  });

  it("returns no findings for clean values", () => {
    expectKinds({ message: "hello world", count: 3, ok: true, none: null }, []);
  });

  it("scans values deeper than depth 20", () => {
    let leaf: Record<string, unknown> = { secret: HEX32 };
    for (let i = 0; i < 25; i++) {
      leaf = { next: leaf };
    }
    expect(new LeakScanner().scan(leaf).some((finding) => finding.kind === "secret-shaped")).toBe(true);
  });

  it("terminates on cyclic structures", () => {
    const cyclic: Record<string, unknown> = { name: "loop" };
    cyclic.self = cyclic;
    const findings = new LeakScanner().scan(cyclic);
    expect(findings).toEqual([]);
  });

  it("detects a canary at the root of an array", () => {
    const scanner = new LeakScanner({ canaries: [CANARY] });
    expect(scanner.scan([CANARY])).toEqual([{ kind: "canary", path: "$.0" }]);
  });
});
