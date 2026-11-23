import { describe, expect, it } from "vitest";
import { DEFAULT_GATEWAY_CONFIG, DEFAULT_LIMIT_CONFIG, validateGatewayConfig, validateLimitConfig } from "./limit-config.js";

const expected = {
  limits: {
    proposalsPerTurn: 25, executionsPerTurn: 8, maxChainDepth: 4, turnBudgetMs: 30_000,
    perUserPerMinute: { limit: 60, windowSeconds: 60 },
    perTenantPerMinute: { limit: 600, windowSeconds: 60 },
    perUserPerCapabilityPerMinute: { limit: 20, windowSeconds: 60 },
    highRiskPerUserPerHour: { limit: 10, windowSeconds: 3600 },
    denialThrottle: { denials: 5, windowSeconds: 60, blockSeconds: 300 },
  },
  replayRetentionSeconds: 86_400, confirmationDefaultTtlSeconds: 300,
  maxPayloadBytes: 16_384, maxJsonDepth: 8, hookTimeoutMs: 2000,
};
function paths(value: object, prefix: string[] = []): string[][] {
  return Object.entries(value).flatMap(([key, entry]) => entry && typeof entry === "object" ? paths(entry, [...prefix, key]) : [[...prefix, key]]);
}
function changed(path: readonly string[], value: unknown, remove = false): unknown {
  const copy = JSON.parse(JSON.stringify(expected)) as Record<string, unknown>;
  let parent = copy;
  for (const key of path.slice(0, -1)) parent = parent[key] as Record<string, unknown>;
  const last = path.at(-1)!;
  if (remove) delete parent[last]; else parent[last] = value;
  return copy;
}
function assertFrozen(value: object): void {
  expect(Object.isFrozen(value)).toBe(true);
  for (const entry of Object.values(value)) if (entry && typeof entry === "object") assertFrozen(entry);
}
describe("T115 strict limit configuration", () => {
  it("every default matches research D12 and T115 intake/replay/confirmation defaults", () => {
    expect(DEFAULT_GATEWAY_CONFIG).toEqual(expected);
    expect(DEFAULT_LIMIT_CONFIG).toEqual(expected.limits);
    expect(validateGatewayConfig(expected)).toEqual(expected);
    expect(validateLimitConfig(expected.limits)).toEqual(expected.limits);
  });
  it("defaults and parsed configurations are deeply frozen detached snapshots", () => {
    assertFrozen(DEFAULT_GATEWAY_CONFIG);
    const input = structuredClone(expected);
    const config = validateGatewayConfig(input);
    assertFrozen(config);
    input.limits.perUserPerMinute.limit = 100;
    expect(config.limits.perUserPerMinute.limit).toBe(60);
    expect(Reflect.set(config.limits.perUserPerMinute, "limit", 100)).toBe(false);
    expect(Object.isFrozen(input)).toBe(false);
  });
  it.each(paths(expected).map((path) => [path.join("."), path] as const))("rejects missing and invalid numeric leaf %s", (_label, path) => {
    expect(() => validateGatewayConfig(changed(path, undefined, true))).toThrow();
    for (const value of [undefined, null, 0, -1, NaN, Infinity, -Infinity, 1.5, "1", true, {}, [], Number.MAX_SAFE_INTEGER]) {
      expect(() => validateGatewayConfig(changed(path, value))).toThrow();
    }
  });
  it("rejects absent/wrong-shaped roots, rule objects and all extra keys", () => {
    for (const value of [undefined, null, {}, [], "default"]) {
      expect(() => validateGatewayConfig(value)).toThrow();
      expect(() => validateLimitConfig(value)).toThrow();
    }
    for (const path of [["limits"], ["limits", "perUserPerMinute"], ["limits", "denialThrottle"]]) {
      expect(() => validateGatewayConfig(changed(path, undefined, true))).toThrow();
      expect(() => validateGatewayConfig(changed(path, []))).toThrow();
    }
    for (const path of [["unknown"], ["limits", "unknown"], ["limits", "perUserPerMinute", "unknown"], ["limits", "denialThrottle", "unknown"]]) {
      expect(() => validateGatewayConfig(changed(path, 1))).toThrow();
    }
    expect(() => validateLimitConfig({ ...expected.limits, unknown: 1 })).toThrow();
  });
  it("accepts documented upper bounds and rejects each upper bound plus one", () => {
    const bounds: [string[], number][] = [
      [["limits", "proposalsPerTurn"], 1_000_000], [["limits", "executionsPerTurn"], 1_000_000],
      [["limits", "maxChainDepth"], 64], [["limits", "turnBudgetMs"], 300_000],
      [["limits", "perUserPerMinute", "windowSeconds"], 31_536_000],
      [["limits", "denialThrottle", "blockSeconds"], 31_536_000],
      [["replayRetentionSeconds"], 31_536_000], [["confirmationDefaultTtlSeconds"], 900],
      [["maxPayloadBytes"], 1_048_576], [["maxJsonDepth"], 64], [["hookTimeoutMs"], 60_000],
    ];
    for (const [path, maximum] of bounds) {
      expect(() => validateGatewayConfig(changed(path, maximum))).not.toThrow();
      expect(() => validateGatewayConfig(changed(path, maximum + 1))).toThrow();
      expect(() => validateGatewayConfig(changed(path, 1))).not.toThrow();
    }
  });
});

describe("T115 configuration is plain own data, never what an object merely exposes", () => {
  const limitsOf = () => structuredClone(expected.limits);
  const gatewayOf = () => structuredClone(expected);

  it("takes no field from the prototype chain, at the root or nested", () => {
    expect(() => validateGatewayConfig(Object.create(gatewayOf()))).toThrow();
    expect(() => validateGatewayConfig({ ...gatewayOf(), limits: Object.create(limitsOf()) })).toThrow();
    expect(() => validateLimitConfig(Object.create(limitsOf()))).toThrow();
    expect(() => validateLimitConfig({ ...limitsOf(), denialThrottle: Object.create(expected.limits.denialThrottle) })).toThrow();
  });
  it("rejects class instances, exotic wrappers, symbol keys and hidden (non-enumerable) fields as extra keys", () => {
    class Holder { limits = limitsOf(); maxPayloadBytes = 16_384; maxJsonDepth = 8; replayRetentionSeconds = 86_400; confirmationDefaultTtlSeconds = 300; hookTimeoutMs = 2000; }
    expect(() => validateGatewayConfig(new Holder())).toThrow();
    expect(() => validateLimitConfig({ ...limitsOf(), proposalsPerTurn: new Number(25) })).toThrow();
    expect(() => validateLimitConfig({ ...limitsOf(), [Symbol("extra")]: 1 })).toThrow();
    const hidden = limitsOf();
    Object.defineProperty(hidden, "hidden", { value: 1, enumerable: false });
    expect(() => validateLimitConfig(hidden)).toThrow();
  });
  it("never treats a string as configuration, even valid JSON text, and rejects arrays", () => {
    expect(() => validateGatewayConfig(JSON.stringify(gatewayOf()))).toThrow();
    expect(() => validateLimitConfig(JSON.stringify(limitsOf()))).toThrow();
    expect(() => validateLimitConfig([limitsOf()])).toThrow();
  });
  it("still accepts null-prototype data, and reads an accessor exactly once", () => {
    expect(validateLimitConfig(Object.assign(Object.create(null) as object, limitsOf()))).toEqual(expected.limits);
    let reads = 0;
    const flipping = { ...gatewayOf(), get hookTimeoutMs() { return ++reads === 1 ? 2000 : -1; } };
    expect(validateGatewayConfig(flipping).hookTimeoutMs).toBe(2000);
    expect(reads).toBe(1);
  });
  it("does not leak the offending value, a proxy trap's message or a stack in its error", () => {
    const trap = new Proxy({}, { ownKeys() { throw new Error("CANARY_TRAP"); } });
    for (const input of [trap, { ...gatewayOf(), hookTimeoutMs: "CANARY_VALUE" }]) {
      try { validateGatewayConfig(input); expect.unreachable(); }
      catch (error) {
        expect(error).toBeInstanceOf(TypeError);
        expect(String((error as Error).message) + String((error as Error).cause ?? "")).not.toMatch(/CANARY/);
      }
    }
  });
  it("gives each rule its own detached frozen object even when the caller aliases one", () => {
    const shared = { limit: 1, windowSeconds: 60 };
    const config = validateLimitConfig({ ...limitsOf(), perUserPerMinute: shared, perTenantPerMinute: shared });
    expect(config.perUserPerMinute).not.toBe(config.perTenantPerMinute);
    expect(Object.isFrozen(shared)).toBe(false);
    shared.limit = 99;
    expect(config.perUserPerMinute.limit).toBe(1);
    expect(config.perTenantPerMinute.limit).toBe(1);
  });
});

describe("T115 proposalBudgetMs: the optional per-proposal deadline the runner enforces", () => {
  const withBudget = (value: unknown) => ({ ...structuredClone(expected), proposalBudgetMs: value });

  it("is accepted from 1 to 0x7fffffff milliseconds and kept in the frozen, detached snapshot", () => {
    for (const value of [1, 10_000, 0x7fff_ffff]) {
      const input = withBudget(value);
      const config = validateGatewayConfig(input);
      expect(config.proposalBudgetMs).toBe(value);
      assertFrozen(config);
      (input as { proposalBudgetMs: unknown }).proposalBudgetMs = 5;
      expect(config.proposalBudgetMs).toBe(value);
    }
  });
  it.each([0, -1, -0, NaN, Infinity, -Infinity, 1.5, 0x8000_0000, Number.MAX_SAFE_INTEGER, "10000", "", true, null, undefined, {}, [], [10_000], 10_000n])("is refused as %s", (value) => {
    expect(() => validateGatewayConfig(withBudget(value))).toThrow(TypeError);
  });
  it("stays omitted when not configured: the runner's own default (10 000 ms) applies, never a silent value here", () => {
    const config = validateGatewayConfig(structuredClone(expected));
    expect(Object.hasOwn(config, "proposalBudgetMs")).toBe(false);
    expect(Object.hasOwn(DEFAULT_GATEWAY_CONFIG, "proposalBudgetMs")).toBe(false);
  });
  it("is a gateway setting only: the limit-only configuration still rejects it as an unknown key", () => {
    expect(() => validateLimitConfig({ ...structuredClone(expected.limits), proposalBudgetMs: 10_000 })).toThrow(TypeError);
  });
});
