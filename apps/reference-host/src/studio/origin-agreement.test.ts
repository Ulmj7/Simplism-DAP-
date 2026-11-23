/**
 * The two origin normalisations must agree (Studio V1A, D1 + D5): whatever the enrollment validator ACCEPTS, `createAgentBrowserAdapter` must accept as an `origins` entry (it demands
 * the exact normalised form), so that no enrolled application can make connect fail with a configuration TypeError. Creating the adapter starts no process (no binary is needed).
 */
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { createAgentBrowserAdapter } from "@dap/browser-runtime";
import { normalizeOrigin, validateApplicationConfig } from "./applications.js";

const adapterAccepts = (origins: readonly string[]): boolean => {
  try { createAgentBrowserAdapter({ labels: [], routes: ["/"], origins }); return true; } catch (error) { if (error instanceof TypeError) return false; throw error; }
};
const config = (origin: string, allowed: readonly string[] = [origin]) => ({ name: "App", origin, allowedOrigins: [...allowed], environment: "development", registryId: "reference" });

describe("the enrollment validator and the adapter agree on origins", () => {
  it.each([
    "http://localhost:5184", "HTTP://LOCALHOST:5184/", "http://localhost", "http://localhost:80", "https://example.com", "https://example.com:443", "https://Example.COM/", "https://app.example.com:8443",
    "http://127.0.0.1:5173", "http://127.1", "http://[::1]:5184", "http://[0:0:0:0:0:0:0:1]", "https://bücher.example", "https://BÜCHER.example:8443/", "https://xn--bcher-kva.example", "https://a.b.c.d.example",
    "http://localhost:65535", "http://localhost:1", "https://example.com:0443",
  ])("accepts %s on both sides, or refuses it in the validator", (raw) => {
    const result = validateApplicationConfig(config(raw), ["reference"]);
    if (result.ok) {
      expect(adapterAccepts(result.config.allowedOrigins), raw).toBe(true);
      expect(adapterAccepts([result.config.origin])).toBe(true);
      expect(result.config.origin).toBe(new URL(raw).origin);
    }
  });
  it("accepts a five-origin list the validator accepts, and the same hostnames the CLI allow-list will get", () => {
    const five = ["https://a.example", "https://b.example:8443", "http://localhost:5185", "http://127.0.0.1:5186", "http://[::1]:5187"];
    const result = validateApplicationConfig(config(five[0]!, five), ["reference"]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(adapterAccepts(result.config.allowedOrigins)).toBe(true);
  });
  it("origins the validator refuses are not required to be accepted by the adapter (it is the stricter, later check), but no accepted one is refused", () => {
    for (const raw of ["javascript:alert(1)", "https://u:p@example.com", "https://example.com/x", "ftp://example.com", "http://example.com", "http://10.0.0.1"]) {
      expect(normalizeOrigin(raw).ok, raw).toBe(false);
    }
  });
  it.each(["https://*.example.com", "https://a,b.example.com", "https://a.com,evil.com", "https://exa%2Ample.com", "https://a;b.example.com", "https://a..example.com", "https://a_b.example.com"])(
    "%s is refused by the validator, so the adapter's own refusal of it is never reached by an enrolled application", (raw) => {
      expect(normalizeOrigin(raw).ok).toBe(false);
      expect(adapterAccepts([raw])).toBe(false);
    });
  it("a longest-bound origin (190 characters after the scheme) accepted by the validator is accepted by the adapter", () => {
    const origin = `https://${"a".repeat(63)}.${"b".repeat(63)}.${"c".repeat(62)}`;
    const result = validateApplicationConfig(config(origin), ["reference"]);
    expect(result.ok).toBe(true);
    if (result.ok) expect(adapterAccepts(result.config.allowedOrigins)).toBe(true);
  });
  it("property: every origin the validator accepts is accepted by the adapter, whatever the case, port spelling, trailing slash or IDN form", () => {
    const hostname = fc.oneof(
      fc.constantFrom("localhost", "LOCALHOST", "127.0.0.1", "[::1]", "[0:0:0:0:0:0:0:1]", "bücher.example", "BÜCHER.EXAMPLE", "xn--bcher-kva.example", "例え.jp", "münchen.de", "EXAMPLE.com", "a.example", "sub.domain.example.org"),
      fc.stringMatching(/^[a-z][a-z0-9-]{0,10}[a-z0-9]\.(com|org|example|dev)$/),
      fc.constantFrom("*.example.com", "a,b.example.com", "a;b.example.com", "a_b.example.com", "a..example.com", "-a.example.com", "exa%2Ample.com", "a b.example.com", "a.example.com:80", "EX*AMPLE.com"),
    );
    const port = fc.option(fc.integer({ min: 0, max: 70_000 }).map((n) => `:${n}`), { nil: "" });
    const origin = fc.tuple(fc.constantFrom("http", "https", "HTTP", "HTTPS", "Http"), hostname, port, fc.constantFrom("", "/")).map(([scheme, host, p, slash]) => `${scheme}://${host}${p}${slash}`);
    fc.assert(fc.property(origin, (raw) => {
      const result = validateApplicationConfig(config(raw), ["reference"]);
      if (!result.ok) return true;
      return adapterAccepts(result.config.allowedOrigins);
    }), { numRuns: 600 });
  });
  it("property: the validator's normalised form is a fixed point (normalising it again changes nothing) and equals URL.origin", () => {
    fc.assert(fc.property(fc.constantFrom("http://LocalHost:80/", "https://Example.com:443/", "http://[0:0:0:0:0:0:0:1]:5184", "https://BÜCHER.example/"), (raw) => {
      const first = normalizeOrigin(raw);
      if (!first.ok) return true;
      const second = normalizeOrigin(first.origin);
      return second.ok && second.origin === first.origin && first.origin === new URL(raw).origin;
    }));
  });
});
