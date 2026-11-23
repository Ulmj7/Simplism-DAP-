import { describe, expect, it } from "vitest";
import type { Pool } from "pg";
import type { TenantScope } from "@dap/contracts";
import { PostgresRateLimiter } from "./rate-limiter.js";
import { PostgresReplayGuard } from "./replay.js";
import { captureStateInput } from "./state-runtime.js";

const TENANT = "00000000-0000-4000-8000-0000000000aa";
const scope = { tenantId: TENANT } as TenantScope;
/** A pool that fails the test if anything tries to reach the database. */
const forbiddenPool = { connect: () => { throw new Error("database touched"); }, query: () => { throw new Error("database touched"); } } as unknown as Pool;
const badKeys = ["", "nul\u0000key", "x".repeat(1025), "界".repeat(342), `${"k".repeat(1023)}é`, "\ud800", "x\udc00", "a\ud800b", "\ud83d", undefined, 1, null];
const badTenants = [`{${TENANT}}`, TENANT.replaceAll("-", ""), ` ${TENANT}`, `${TENANT} `, `${TENANT}\n`, `urn:uuid:${TENANT}`, TENANT.slice(0, 35), `${TENANT}0`, "", undefined, null, 5];

describe("PostgreSQL state input validation runs before any database round trip", () => {
  it.each(badKeys)("rejects key %j", async (key) => {
    expect(() => captureStateInput(scope, key as string)).toThrow(TypeError);
    await expect(new PostgresReplayGuard(forbiddenPool).claim(scope, key as string, 60)).rejects.toThrow("Invalid security state key");
    const limiter = new PostgresRateLimiter(forbiddenPool);
    await expect(limiter.hit(scope, key as string, { limit: 1, windowSeconds: 60 })).rejects.toThrow("Invalid security state key");
    await expect(limiter.block(scope, key as string, 10)).rejects.toThrow("Invalid security state key");
    await expect(limiter.isBlocked(scope, key as string)).rejects.toThrow("Invalid security state key");
  });
  it.each(badTenants)("rejects tenant %j", async (tenantId) => {
    const bad = { tenantId } as unknown as TenantScope;
    expect(() => captureStateInput(bad, "key")).toThrow(TypeError);
    await expect(new PostgresReplayGuard(forbiddenPool).claim(bad, "key", 60)).rejects.toThrow("Security state requires a UUID tenant");
    const limiter = new PostgresRateLimiter(forbiddenPool);
    await expect(limiter.hit(bad, "key", { limit: 1, windowSeconds: 60 })).rejects.toThrow("Security state requires a UUID tenant");
    await expect(limiter.block(bad, "key", 10)).rejects.toThrow("Security state requires a UUID tenant");
    await expect(limiter.isBlocked(bad, "key")).rejects.toThrow("Security state requires a UUID tenant");
  });
  it("canonicalizes the only valid spelling and accepts well-formed astral text and exact byte limits", () => {
    expect(captureStateInput({ tenantId: TENANT.toUpperCase() } as TenantScope, "😀")).toEqual({ tenantId: TENANT, key: "😀" });
    expect(captureStateInput(scope, "k".repeat(1024)).key).toHaveLength(1024);
    expect(captureStateInput(scope, "界".repeat(341)).key).toHaveLength(341);
  });
  it.each([0, -1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, "60", undefined, 31_536_001])("rejects retention/limit/duration %j before a round trip", async (value) => {
    await expect(new PostgresReplayGuard(forbiddenPool).claim(scope, "key", value as number)).rejects.toThrow("Invalid security state integer");
    const limiter = new PostgresRateLimiter(forbiddenPool);
    await expect(limiter.block(scope, "key", value as number)).rejects.toThrow("Invalid security state integer");
    await expect(limiter.hit(scope, "key", { limit: value as number, windowSeconds: 60 })).rejects.toThrow("Invalid security state integer");
    await expect(limiter.hit(scope, "key", { limit: 1, windowSeconds: value as number })).rejects.toThrow("Invalid security state integer");
  });
});
