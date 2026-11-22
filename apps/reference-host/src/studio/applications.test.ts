import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  ENVIRONMENTS, MAX_ORIGIN_HOST_PART_CHARS, MAX_APPLICATION_ISSUES, MAX_APPLICATION_ISSUE_CHARS, applicationConfigSchema, capApplicationIssues, generateApplicationId, isApplicationId, normalizeOrigin,
  saveApplicationInputSchema, toApplicationView, validateApplicationConfig,
} from "./applications.js";
import type { ApplicationRecord } from "./applications.js";

const KNOWN = ["reference", "fixture"];
const valid = (patch: Record<string, unknown> = {}) => ({
  name: "Reference application", origin: "http://localhost:5184", allowedOrigins: ["http://localhost:5184"], environment: "development", registryId: "reference", ...patch,
});
const issuesOf = (input: unknown, known: readonly string[] = KNOWN): readonly string[] => {
  const result = validateApplicationConfig(input, known);
  if (result.ok) throw new Error("expected a refusal");
  return result.issues;
};

describe("a valid enrollment", () => {
  it("accepts the reference application on loopback and returns the normalised configuration", () => {
    const result = validateApplicationConfig(valid(), KNOWN);
    expect(result).toEqual({ ok: true, config: { name: "Reference application", origin: "http://localhost:5184", allowedOrigins: ["http://localhost:5184"], environment: "development", registryId: "reference" } });
  });
  it("accepts an https production-like host, several allowed origins and the test environment", () => {
    const result = validateApplicationConfig(valid({
      name: "  Billing  ", origin: "https://app.example.com", allowedOrigins: ["https://app.example.com", "https://auth.example.com:8443", "http://127.0.0.1:5185"], environment: "test", registryId: "fixture",
    }), KNOWN);
    expect(result).toEqual({ ok: true, config: { name: "Billing", origin: "https://app.example.com", allowedOrigins: ["https://app.example.com", "https://auth.example.com:8443", "http://127.0.0.1:5185"], environment: "test", registryId: "fixture" } });
  });
  it("returns a frozen, fresh object holding the known fields only", () => {
    const input = valid();
    const result = validateApplicationConfig(input, KNOWN);
    if (!result.ok) throw new Error("expected acceptance");
    expect(Object.isFrozen(result.config)).toBe(true);
    expect(Object.isFrozen(result.config.allowedOrigins)).toBe(true);
    expect(result.config).not.toBe(input);
    expect(result.config.allowedOrigins).not.toBe(input.allowedOrigins);
  });
  it("offers only development and test in this stage", () => {
    expect(ENVIRONMENTS).toEqual(["development", "test"]);
  });
});

describe("origin normalisation", () => {
  it.each([
    ["HTTP://LocalHost:5184", "http://localhost:5184"],
    ["http://localhost:80", "http://localhost"],
    ["https://Example.COM:443", "https://example.com"],
    ["https://example.com/", "https://example.com"],
    ["http://127.0.0.1:5185/", "http://127.0.0.1:5185"],
    ["http://[::1]:5184", "http://[::1]:5184"],
    ["http://[0:0:0:0:0:0:0:1]:5184", "http://[::1]:5184"],
    ["https://bücher.example", "https://xn--bcher-kva.example"],
    ["https://BÜCHER.example:8443/", "https://xn--bcher-kva.example:8443"],
    ["http://127.1", "http://127.0.0.1"],
  ])("%s -> %s", (raw, expected) => {
    const result = normalizeOrigin(raw);
    expect(result.ok && result.origin).toBe(expected);
  });
  it("stores the normalised form of every origin, so a duplicate in another spelling is still a duplicate", () => {
    expect(issuesOf(valid({ allowedOrigins: ["http://localhost:5184", "HTTP://LOCALHOST:5184/"] }))).toEqual(["allowedOrigins: must not repeat an origin"]);
    expect(issuesOf(valid({ origin: "https://example.com", allowedOrigins: ["https://example.com", "https://example.com:443"] }))).toEqual(["allowedOrigins: must not repeat an origin"]);
  });
});

describe("every rejection class", () => {
  it.each([
    ["javascript:", "javascript:alert(1)", "must use http or https"],
    ["data:", "data:text/html,<p>x</p>", "must use http or https"],
    ["file:", "file:///etc/passwd", "must use http or https"],
    ["ftp:", "ftp://example.com", "must use http or https"],
    ["ws:", "ws://localhost:5184", "must use http or https"],
    ["blob:", "blob:http://localhost/abc", "must use http or https"],
  ])("refuses the %s protocol", (_name, origin, phrase) => {
    expect(issuesOf(valid({ origin, allowedOrigins: [origin] }))).toEqual([`origin: ${phrase}`, `allowedOrigins.0: ${phrase}`]);
  });
  it.each([
    ["a user name", "https://user@example.com"],
    ["a user name and password", "https://user:secret@example.com"],
    ["an empty user name", "https://@example.com"],
    ["a password only", "https://:secret@example.com"],
  ])("refuses credentials: %s", (_name, origin) => {
    expect(issuesOf(valid({ origin, allowedOrigins: [origin] }))[0]).toBe("origin: must not contain a user name or password");
  });
  it.each([
    ["a missing host", "https://"],
    ["a trailing-dot host", "https://example.com."],
  ])("refuses %s", (_name, origin) => {
    const issues = issuesOf(valid({ origin, allowedOrigins: [origin] }));
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0]).toMatch(/^origin: /);
  });
  it.each([
    ["a path", "https://example.com/app"],
    ["a query", "https://example.com?x=1"],
    ["a query after a slash", "https://example.com/?x=1"],
    ["a fragment", "https://example.com#top"],
    ["an empty fragment", "https://example.com/#"],
    ["an empty query", "https://example.com/?"],
    ["a hash route", "http://localhost:5184/#/profile"],
  ])("refuses an origin with %s", (_name, origin) => {
    expect(issuesOf(valid({ origin, allowedOrigins: [origin] }))[0]).toBe("origin: must be an origin only: no path, query or fragment");
  });
  it.each(["not a url", "://", "http//example.com", "https://exa mple.com", "https://example.com\n", "\u0000https://example.com"])("refuses a malformed origin %j", (origin) => {
    expect(issuesOf(valid({ origin, allowedOrigins: [origin] }))[0]).toMatch(/^origin: /);
  });
  it("refuses an origin that is too long and a non-string origin", () => {
    expect(issuesOf(valid({ origin: `https://${"a".repeat(250)}.example`, allowedOrigins: ["https://a.example"] }))[0]).toBe("origin: must be between 1 and 200 characters");
    expect(issuesOf(valid({ origin: 5 }))[0]).toBe("origin: must be between 1 and 200 characters");
  });
  it.each([
    ["a public IPv4 address", "https://93.184.216.34"],
    ["a private IPv4 address", "http://192.168.1.10:5184"],
    ["0.0.0.0", "http://0.0.0.0:5184"],
    ["another loopback address", "http://127.0.0.2:5184"],
    ["an IPv4 address in hex form", "http://0x5db8d822"],
    ["a decimal IPv4 address", "http://2130706434"],
    ["a public IPv6 address", "https://[2001:db8::1]"],
    ["an IPv4-mapped IPv6 address", "http://[::ffff:127.0.0.1]:5184"],
    ["an unspecified IPv6 address", "http://[::]:5184"],
  ])("refuses %s", (_name, origin) => {
    expect(issuesOf(valid({ origin, allowedOrigins: [origin] }))[0]).toBe("origin: may not be an IP address except 127.0.0.1 and [::1]");
  });
  it.each(["http://example.com", "http://app.example.com:8080", "http://localhost.example.com", "http://notlocalhost"])("refuses plain http for a non-loopback host: %s", (origin) => {
    expect(issuesOf(valid({ origin, allowedOrigins: [origin] }))[0]).toBe("origin: must use https unless the host is localhost, 127.0.0.1 or [::1]");
  });
  it("applies the same origin rules to every allowed origin and names its position, not its text", () => {
    const issues = issuesOf(valid({ allowedOrigins: ["http://localhost:5184", "http://evil.example", "javascript:alert(1)", "https://a.example/path"] }));
    expect(issues).toEqual([
      "allowedOrigins.1: must use https unless the host is localhost, 127.0.0.1 or [::1]",
      "allowedOrigins.2: must use http or https",
      "allowedOrigins.3: must be an origin only: no path, query or fragment",
    ]);
  });
  it("requires the application origin to be one of the allowed origins", () => {
    expect(issuesOf(valid({ allowedOrigins: ["http://localhost:5185"] }))).toEqual(["allowedOrigins: must include the application origin"]);
    // The comparison is on the NORMALISED form.
    expect(validateApplicationConfig(valid({ origin: "HTTP://LOCALHOST:5184/", allowedOrigins: ["http://localhost:5184"] }), KNOWN).ok).toBe(true);
  });
  it("refuses more than five origins, an empty list, a non-list and holes in a sparse list", () => {
    const six = Array.from({ length: 6 }, (_v, index) => `https://a${index}.example`);
    expect(issuesOf(valid({ origin: six[0], allowedOrigins: six }))).toEqual(["allowedOrigins: must list between 1 and 5 origins"]);
    expect(issuesOf(valid({ allowedOrigins: [] }))).toEqual(["allowedOrigins: must list between 1 and 5 origins"]);
    expect(issuesOf(valid({ allowedOrigins: "http://localhost:5184" }))).toEqual(["allowedOrigins: must be a list of origins"]);
    expect(issuesOf(valid({ allowedOrigins: ["http://localhost:5184", , "https://b.example"] }))).toEqual(["allowedOrigins.1: must be between 1 and 200 characters"]);
  });
  it("accepts exactly five origins", () => {
    const five = Array.from({ length: 5 }, (_v, index) => `https://a${index}.example`);
    expect(validateApplicationConfig(valid({ origin: five[0], allowedOrigins: five }), KNOWN).ok).toBe(true);
  });
  it("refuses an unknown or malformed environment, including the stage that is not enabled yet", () => {
    for (const environment of ["production", "staging", "", "Development", 3, null, undefined]) {
      expect(issuesOf(valid({ environment }))).toEqual(["environment: must be development or test"]);
    }
  });
  it("refuses an unknown or malformed registry id", () => {
    for (const registryId of ["missing", "Reference", "", "../reference", 4, null, undefined, "reference ", "a".repeat(40)]) {
      expect(issuesOf(valid({ registryId }))).toEqual(["registryId: must be one of the available registries"]);
    }
    expect(issuesOf(valid({ registryId: "fixture" }), ["reference"])).toEqual(["registryId: must be one of the available registries"]);
  });
  it("refuses a name that is empty, too long, not text or not plain text", () => {
    expect(issuesOf(valid({ name: "   " }))).toEqual(["name: must be between 1 and 80 characters"]);
    expect(issuesOf(valid({ name: "x".repeat(81) }))).toEqual(["name: must be between 1 and 80 characters"]);
    expect(issuesOf(valid({ name: 7 }))).toEqual(["name: required text"]);
    for (const name of ["a<b", "<script>", "line\nbreak", "tab\there", "bidi\u202eover", "nul\u0000"]) expect(issuesOf(valid({ name }))).toEqual(["name: must be plain text"]);
    expect(validateApplicationConfig(valid({ name: "x".repeat(80) }), KNOWN).ok).toBe(true);
  });
  it("refuses a non-object, an array, null and an unknown field", () => {
    for (const input of [null, undefined, 5, "text", [], [valid()]]) expect(issuesOf(input)).toEqual(["application: must be an object"]);
    expect(issuesOf({ ...valid(), tenantId: "11111111-1111-4111-8111-111111111111" })).toEqual(["application: unknown field"]);
    expect(issuesOf({ ...valid(), enabled: true })).toEqual(["application: unknown field"]);
  });
  it("collects several problems at once", () => {
    expect(issuesOf({ name: "", origin: "ftp://x", allowedOrigins: [], environment: "x", registryId: "nope" })).toEqual([
      "name: must be between 1 and 80 characters", "environment: must be development or test", "registryId: must be one of the available registries",
      "origin: must use http or https", "allowedOrigins: must list between 1 and 5 origins",
    ]);
  });
});

describe("no author string is echoed", () => {
  const MARKER = "SECRET-MARKER-9f3a";
  it("never repeats a typed value in any issue, whatever the field", () => {
    const attempts = [
      valid({ name: `${MARKER}<`, origin: `ftp://${MARKER}.example`, allowedOrigins: [`javascript:${MARKER}`, `https://user:${MARKER}@x.example`, `https://x.example/${MARKER}`], environment: MARKER, registryId: MARKER }),
      valid({ origin: `http://${MARKER}.example`, allowedOrigins: [`http://${MARKER}.example`] }),
      { ...valid(), [MARKER]: 1 },
      valid({ allowedOrigins: [`https://${MARKER}.example`, `https://${MARKER}.example`], origin: `https://${MARKER}.example` }),
    ];
    for (const attempt of attempts) {
      const result = validateApplicationConfig(attempt, KNOWN);
      expect(JSON.stringify(result)).not.toContain(MARKER);
    }
  });
  it("caps issues at 20 of 200 characters and removes control characters", () => {
    const many = Array.from({ length: 30 }, (_v, index) => `line${index}\n${"x".repeat(300)}`);
    const capped = capApplicationIssues(many);
    expect(capped).toHaveLength(MAX_APPLICATION_ISSUES);
    expect(capped.every((issue) => issue.length <= MAX_APPLICATION_ISSUE_CHARS && !/[\n\r]/.test(issue))).toBe(true);
  });
});

describe("schemas used as the capability input", () => {
  it("accepts a valid save input and refuses an extra key, a missing key and a bad id", () => {
    const input = { applicationId: "app-0123456789ab", ...valid() };
    expect(saveApplicationInputSchema.safeParse(input).success).toBe(true);
    expect(saveApplicationInputSchema.safeParse({ ...input, tenantId: "x" }).success).toBe(false);
    expect(saveApplicationInputSchema.safeParse({ ...input, enabled: true }).success).toBe(false);
    expect(saveApplicationInputSchema.safeParse({ ...input, applicationId: "wt-0123456789ab" }).success).toBe(false);
    expect(saveApplicationInputSchema.safeParse({ ...input, allowedOrigins: Array(6).fill("https://a.example") }).success).toBe(false);
    expect(saveApplicationInputSchema.safeParse({ ...input, name: "x".repeat(81) }).success).toBe(false);
    expect(applicationConfigSchema.safeParse(valid()).success).toBe(true);
  });
});

describe("ids and views", () => {
  it("generates app- plus 12 lowercase hex characters, and only that shape is an application id", () => {
    expect(generateApplicationId()).toMatch(/^app-[a-f0-9]{12}$/);
    expect(generateApplicationId(() => Buffer.from("0123456789ab", "hex"))).toBe("app-0123456789ab");
    for (const bad of ["app-0123456789AB", "app-0123456789a", "app-0123456789abc", "wt-0123456789ab", "", "app-", 5, null, undefined]) expect(isApplicationId(bad)).toBe(false);
  });
  it("the view exposes the contract fields only", () => {
    const record: ApplicationRecord = { id: "app-0123456789ab", name: "A", origin: "http://localhost:5184", allowedOrigins: ["http://localhost:5184"], environment: "test", registryId: "reference", enabled: false, createdAt: "2026-01-01T00:00:00.000Z", updatedAt: "2026-01-02T00:00:00.000Z" };
    expect(toApplicationView(record)).toEqual({ id: "app-0123456789ab", name: "A", origin: "http://localhost:5184", allowedOrigins: ["http://localhost:5184"], environment: "test", registryId: "reference", source: "built-in", enabled: false, updatedAt: "2026-01-02T00:00:00.000Z" });
  });
});

describe("a disabled application", () => {
  it("is still a valid configuration: enabled is state, not enrollment input", () => {
    expect(issuesOf({ ...valid(), enabled: false })).toEqual(["application: unknown field"]);
    expect(validateApplicationConfig(valid(), KNOWN).ok).toBe(true);
  });
});

describe("host names are DNS names (the CLI allow-list reads them)", () => {
  const cfg = (origin: string, allowed: readonly string[] = [origin]) => ({ name: "App", origin, allowedOrigins: [...allowed], environment: "development", registryId: "reference" });
  const HOST_PHRASE = "needs a host name of letters, digits, hyphens and dots";
  it.each(["https://*.example.com", "https://ex*ample.com", "https://exa%2Ample.com", "https://a,b.example.com", "https://a.com,evil.com", "https://exa%2Cmple.com", "https://a;b.example.com", "https://a..example.com",
    "https://-a.example.com", "https://a-.example.com", "https://a_b.example.com", "https://a b.example.com", "https://a|b.example.com", "https://a'b.example.com", "https://a!.example.com"])(
    "refuses %s with the fixed host phrase and no echo", (origin) => {
      const result = validateApplicationConfig(cfg(origin), ["reference"]);
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.issues[0]).toMatch(/^origin: (needs a host name of letters, digits, hyphens and dots|is not a valid origin)$/);
        expect(JSON.stringify(result.issues)).not.toContain("evil");
        expect(JSON.stringify(result.issues)).not.toContain("example");
      }
    });
  it("applies the same rule to every allowed origin and names its position", () => {
    const issues = validateApplicationConfig(cfg("https://good.example", ["https://good.example", "https://*.example.com", "https://x.example,evil.test"]), ["reference"]);
    expect(issues).toEqual({ ok: false, issues: [`allowedOrigins.1: ${HOST_PHRASE}`, `allowedOrigins.2: ${HOST_PHRASE}`] });
  });
  it.each(["https://example.com", "https://a-b.example.com", "https://a1.b2.example.org", "https://xn--bcher-kva.example", "https://BÜCHER.example", "https://localhost", "http://localhost:5184", "http://127.0.0.1", "http://[::1]"])(
    "still accepts %s", (origin) => { expect(validateApplicationConfig(cfg(origin), ["reference"]).ok).toBe(true); });
  it.each([
    ["http://0x7f.1", "http://127.0.0.1"], ["http://017700000001", "http://127.0.0.1"], ["http://2130706433", "http://127.0.0.1"], ["http://LOCALHOST:80/", "http://localhost"],
    ["http://[0:0:0:0:0:0:0:1]", "http://[::1]"], ["https://ｅｘａｍｐｌｅ.com", "https://example.com"], ["https://exаmple.com", "https://xn--exmple-4nf.com"],
  ])("normalisation that holds: %s is stored as %s", (raw, normal) => {
    const result = normalizeOrigin(raw);
    expect(result.ok && result.origin).toBe(normal);
  });
  it.each([
    "http://0.0.0.0", "http://0", "http://[::]", "http://127.0.0.2", "http://[::ffff:127.0.0.1]", "http://localhost.", "https://localhost.", "http://%6c%6f%63%61%6c%68%6f%73%74.", "http://127.0.0.1.nip.io",
    "http://user@localhost", "http://@localhost", "https://a.com\\@evil.com", "https://a.com#@b.com", "http://localhost\n", "http://local\thost", "javascript:alert(1)", "data:text/html,x", "file:///etc/passwd",
    "blob:https://a.com/x", "ws://localhost", "wss://a.com", `https://${"a".repeat(200)}.com`, "https://", "http://:80", "https://a.com:99999", "https://a.com:-1",
  ])("normalisation that holds: %s is refused", (raw) => { expect(normalizeOrigin(raw).ok).toBe(false); });
});

describe("the origin length bound agrees with the database CHECK (migration 072)", () => {
  const sql = readFileSync(new URL("../../../../db/migrations/072_studio_applications.sql", import.meta.url), "utf8");
  const hostBound = Number(/array_to_string\(allowed_origins, ' '\) ~ '\^https\?:\/\/\[\^\/\?#@\[:space:\]\]\{1,(\d+)\}/.exec(sql)?.[1]);
  const check = new RegExp(`^https?://[^/?#@\\s]{1,${hostBound}}( https?://[^/?#@\\s]{1,${hostBound}}){0,4}$`);
  const originCheck = /^https?:\/\/[^/?#@\s]+$/;
  /** A DNS name of exactly `n` characters (labels of at most 63). */
  const dns = (n: number): string => { const labels: string[] = []; let left = n; while (left > 0) { const take = Math.min(63, left > 64 ? 63 : left); labels.push("a".repeat(take)); left -= take + (left > take ? 1 : 0); } return labels.join("."); };
  it("the bound is read from the migration file and is the one the validator uses", () => {
    expect(hostBound).toBe(190);
    expect(MAX_ORIGIN_HOST_PART_CHARS).toBe(hostBound);
    expect(dns(190)).toHaveLength(190);
    expect(dns(191)).toHaveLength(191);
  });
  it.each([190, 189, 100])("accepts an https origin of %d characters after the scheme and the database CHECKs accept it too", (n) => {
    const result = normalizeOrigin(`https://${dns(n)}`);
    expect(result.ok).toBe(true);
    if (result.ok) { expect(check.test(result.origin)).toBe(true); expect(originCheck.test(result.origin)).toBe(true); expect(result.origin.length).toBeLessThanOrEqual(200); }
  });
  it("accepts a host part of exactly 190 characters including the port, and refuses 191 with the fixed phrase", () => {
    const withPort = (n: number) => `https://${dns(n - 6)}:65535`;
    const longest = normalizeOrigin(withPort(190));
    expect(longest.ok).toBe(true);
    if (longest.ok) { expect(longest.origin.length - "https://".length).toBe(190); expect(check.test(longest.origin)).toBe(true); }
    expect(normalizeOrigin(withPort(191))).toEqual({ ok: false, problem: "hostlength" });
    expect(normalizeOrigin(`https://${dns(191)}`)).toEqual({ ok: false, problem: "hostlength" });
    const refused = validateApplicationConfig({ name: "App", origin: `https://${dns(191)}`, allowedOrigins: [`https://${dns(191)}`], environment: "development", registryId: "reference" }, ["reference"]);
    expect(refused).toEqual({ ok: false, issues: ["origin: host and port may be at most 190 characters", "allowedOrigins.0: host and port may be at most 190 characters"] });
  });
  it("the whole list satisfies the CHECK: five longest origins joined by spaces", () => {
    const five = Array.from({ length: 5 }, (_v, i) => `https://${dns(185)}${i}`);
    const result = validateApplicationConfig({ name: "App", origin: five[0], allowedOrigins: five, environment: "development", registryId: "reference" }, ["reference"]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(check.test(result.config.allowedOrigins.join(" "))).toBe(true);
  });
  it("a punycode host is measured after conversion (the stored form), not as typed", () => {
    const typed = `https://${"é".repeat(60)}.${"é".repeat(60)}.com`;
    const result = normalizeOrigin(typed);
    if (result.ok) expect(result.origin.length - "https://".length).toBeLessThanOrEqual(190);
    else expect(result.problem).toBe("hostlength");
  });
});
