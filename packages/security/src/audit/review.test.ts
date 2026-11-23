import { describe, expect, it } from "vitest";
import type { AuditEvent } from "@dap/contracts";
import { buildAuditEvent, type AuditEventInput } from "./event-builder.js";
import { createAuditReader } from "./audit-reader.js";
import { projectParams, MASKED } from "./projection.js";
import { scrubJson, scrubText, REDACTED, SCRUB_LIMITS, UNSERIALIZABLE } from "./scrubber.js";
import { safeTelemetry, type DecisionSample } from "../gateway/telemetry.js";
import { context, run } from "../gateway/fixtures.test-support.js";

const base = (extra: Partial<AuditEventInput> = {}): AuditEventInput => ({
  type: "AI_ACTION_DENIED", id: "11111111-1111-4111-8111-111111111111", occurredAt: "2026-01-01T00:00:00Z",
  requestId: "request", decisionId: "decision", context: context(), run, outcome: "DENIED", reason: "permission_missing", ...extra,
});
const key = "sk-XXXXXXXXXXXXXXXXXXXXXXXX";

describe("audit boundary review regressions", () => {
  it("a masked ancestor wins over a separately allowlisted plain descendant", () => {
    const view = projectParams({ customer: { private: "CUSTOMER_PRIVATE_VALUE" } }, [{ path: "/customer", mode: "masked" }, { path: "/customer/private", mode: "plain" }]);
    expect(view).toEqual({ "/customer": MASKED, "/customer/private": MASKED });
    expect(projectParams({ child: "PRIVATE" }, [{ path: "", mode: "masked" }, { path: "/child", mode: "plain" }])).toEqual({ "": MASKED, "/child": MASKED });
  });

  it("captures nested action identity once before validation and publication", () => {
    let ids = 0; let versions = 0;
    const action = { kind: "registered", get id() { return ++ids === 1 ? "openProject" : "CANARY\nFORGED"; }, get version() { return ++versions === 1 ? 1 : 99; } };
    expect(buildAuditEvent(base({ action: action as never }))).toMatchObject({ actionId: "openProject", definitionVersion: 1 });
    expect({ ids, versions }).toEqual({ ids: 1, versions: 1 });
  });

  it("does not rescue an invalid first action-kind reading by reading it again", () => {
    let reads = 0;
    const action = { get kind() { return ++reads === 1 ? "invalid" : "attempted"; }, name: "openProject" };
    expect(() => buildAuditEvent(base({ action: action as never }))).toThrow("Invalid audit event: action");
  });

  it("reads a source event once and returns a detached frozen snapshot", async () => {
    let reads = 0;
    const a = context().tenantId;
    const candidate = { ...buildAuditEvent(base()), get tenantId() { return ++reads === 1 ? a : "TENANT_B"; }, paramsView: { "/value": { nested: "original" } } };
    const result = await createAuditReader({ listForTenant: () => [candidate] as AuditEvent[] }).query(context(), { limit: 1 });
    expect(result[0]?.tenantId).toBe(a);
    expect(reads).toBe(1);
    candidate.paramsView["/value"].nested = "changed";
    expect(result[0]?.paramsView).toEqual({ "/value": { nested: "original" } });
    expect(Object.isFrozen(result[0])).toBe(true);
    expect(Object.isFrozen(result[0]?.paramsView["/value"])).toBe(true);
  });

  it.each([
    ["percent encoding", `sk%2D${"X".repeat(24)}`],
    ["JSON escapes", `\\u0073\\u006b-${"X".repeat(24)}`],
    ["HTML entities", `&#115;&#107;-${"X".repeat(24)}`],
    ["hex HTML entities", `&#x73;&#x6b;-${"X".repeat(24)}`],
    ["uppercase hex HTML entities", `&#X73;&#X6B;-${"X".repeat(24)}`],
    ["base64", Buffer.from(key).toString("base64")],
    ["base64url", Buffer.from(key).toString("base64url")],
    ["split chunks", "AKIA ABCD EFGH IJKL MNOP"],
    ["directional isolate", `sk-XXXXXXXX\u2066${"X".repeat(16)}`],
    ["combining grapheme joiner", `sk-XXXXXXXX\u034f${"X".repeat(16)}`],
  ])("redacts secrets disguised by %s", (_name, value) => {
    expect(scrubText(value)).toBe(REDACTED);
  });

  it("detects a nonstandard JSON JWT header even when glued to ordinary text", () => {
    const jwt = `${Buffer.from(' {"alg":"HS256"}').toString("base64url")}.cGF5bG9hZA.c2lnbmF0dXJl`;
    expect(scrubText(`prefix${jwt}`)).toContain(REDACTED);
    expect(scrubText(`A-0-.${jwt}`)).not.toContain(jwt);
  });

  it("conservatively redacts long opaque token triples with bounded header decoding", () => {
    expect(scrubText(`${"x".repeat(257)}.bbbb.cccc`)).toBe(REDACTED);
    const boundary = `${"x".repeat(256)}.bbbb.cccc`;
    expect(scrubText(boundary)).toBe(boundary);
  });

  it("redacts a secret crossing the string cap before cutting it", () => {
    const text = "!".repeat(SCRUB_LIMITS.maxString - 10) + key;
    expect(scrubText(text)).not.toContain("sk-");
  });

  it("does not retain recoverable API-key or JWT fragments split across structured values", () => {
    expect(scrubJson({ first: "sk-", second: "X".repeat(24) })).toEqual({ [REDACTED]: REDACTED });
    expect(scrubJson(["sk-", "X".repeat(24)])).toEqual([REDACTED]);
    const header = Buffer.from('{"alg":"HS256"}').toString("base64url");
    expect(JSON.stringify(scrubJson([header, "cGF5bG9hZA", "c2lnbmF0dXJl"]))).not.toContain(header);
  });

  it("does not turn an unreadable record into an apparently valid object summary", () => {
    const broken = { first: "sk-", second: "X".repeat(24), get unreadable(): never { throw new Error("CANARY"); } };
    expect(scrubJson(broken)).toBe(UNSERIALIZABLE);
  });

  it("merges overlapping JWT redactions into a single safe summary", () => {
    const header = Buffer.from('{"alg":"HS256"}').toString("base64url");
    expect(scrubText(`${header}.${header}.${header}.c2lnbmF0dXJl`)).toBe(REDACTED);
  });

  it("leaves ordinary prose, URLs and harmless encoded data readable", () => {
    for (const text of ["ordinary text", "https://docs.example.test/page", "a\u200bb", "100% complete", "&#1114112; ordinary", "\\u{110000} ordinary", Buffer.from("ordinary content").toString("base64")]) expect(scrubText(text)).toBe(text);
  });

  it("bounds action metric labels to an explicitly captured registry vocabulary", () => {
    const labels: DecisionSample[] = [];
    const configured = new Set(["openProject"]);
    const telemetry = safeTelemetry({ decision: (sample) => { labels.push(sample); } }, configured);
    configured.add("laterAction");
    for (const action of ["openProject", "laterAction", ...Array.from({ length: 100 }, (_, index) => `forgedAction${index}`)]) telemetry.decision({ outcome: "DENIED", reason: "permission_missing", risk: null, action });
    expect(new Set(labels.map((label) => label.action))).toEqual(new Set(["openProject", "unknown"]));
  });

  it("does not emit arbitrary action labels when no registry vocabulary is configured", () => {
    const labels: DecisionSample[] = [];
    safeTelemetry({ decision: (sample) => { labels.push(sample); } }).decision({ outcome: "DENIED", reason: "permission_missing", risk: null, action: "unregisteredAction" });
    expect(labels[0]?.action).toBe("unknown");
  });

  it("captures telemetry sample fields once", () => {
    const labels: DecisionSample[] = [];
    let reads = 0;
    const telemetry = safeTelemetry({ decision: (sample) => { labels.push(sample); } }, new Set(["openProject"]));
    telemetry.decision({ outcome: "DENIED", reason: "permission_missing", risk: null, get action() { return ++reads === 1 ? "openProject" : "CANARY\n"; } });
    expect(labels[0]?.action).toBe("openProject");
    expect(reads).toBe(1);
  });

  it("captures a telemetry then method once and consumes the notification", async () => {
    let reads = 0; let consumed = 0;
    const thenable = { get then() { reads++; return (resolve: () => void) => { consumed++; resolve(); }; } };
    safeTelemetry({ auditWriteFailed: () => thenable as never }).auditWriteFailed("allowed");
    await Promise.resolve(); await Promise.resolve();
    expect(reads).toBe(1);
    expect(consumed).toBe(1);
  });

  it("also observes function-shaped thenables", () => {
    let consumed = 0;
    const returned = Object.assign(() => {}, { then(done: () => void) { consumed++; done(); } });
    safeTelemetry({ auditWriteFailed: () => returned as never }).auditWriteFailed("allowed");
    expect(consumed).toBe(1);
  });

  it("observes native rejected promises without trusting their own then getter", () => {
    let reads = 0;
    const rejected = Promise.reject(new Error("CANARY"));
    Object.defineProperty(rejected, "then", { get() { reads++; throw new Error("CANARY"); } });
    try {
      safeTelemetry({ auditWriteFailed: () => rejected as never }).auditWriteFailed("allowed");
      expect(reads).toBe(0);
    } finally {
      // Cleanup also makes the pre-fix failure deterministic, without leaving a rejected test fixture behind.
      void Reflect.apply(Promise.prototype.then, rejected, [() => undefined, () => undefined]);
    }
  });

  it("keeps resource display names out of audit rows, including hostile oversized names", () => {
    let reads = 0;
    const resource = { type: "document", id: "doc-a", get displayName() { reads++; return "CANARY\n\u001b".repeat(1000); } };
    const event = buildAuditEvent(base({ action: { kind: "registered", id: "openProject", version: 1 }, resource }));
    expect(event.resource).toEqual({ type: "document", id: "doc-a" });
    expect(reads).toBe(0);
    expect(JSON.stringify(event)).not.toContain("CANARY");
  });
});
