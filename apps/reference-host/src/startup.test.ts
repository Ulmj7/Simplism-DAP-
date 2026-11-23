/**
 * T131 / T132: startup validation and the development authentication stub. No database: everything here must be refused (or answered)
 * before a connection exists. Production mode rejecting dev auth is proven by the "NODE_ENV=production" tests.
 */
import { randomUUID } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Clock, IsoInstant } from "@dap/contracts";
import { composeReferenceHost } from "./compose.js";
import { ConfigError, loadConfig } from "./config.js";
import type { Environment } from "./config.js";
import { DevAuthError, assertDevAuthAllowed, createDevAuthentication, parseDevSessions } from "./dev-auth/index.js";

const TENANT = randomUUID();
const TOKEN = `tok-${randomUUID()}`;
const PASSWORD = `pw-${randomUUID()}`;
const FUTURE = new Date(Date.now() + 3_600_000).toISOString();
const PAST = new Date(Date.now() - 3_600_000).toISOString();
const session = (extra: Record<string, unknown> = {}) => ({ token: TOKEN, userId: "alice", tenantId: TENANT, sessionId: "session-alice", validUntil: FUTURE, permissions: ["perm.demo.lookup"], ...extra });
const env = (overrides: Record<string, string | undefined> = {}): Environment => ({
  DAP_ALLOW_DEV_AUTH: "1",
  DAP_DATABASE_URL: `postgresql://dap_app:${PASSWORD}@127.0.0.1:1/never_connected`,
  DAP_ENABLED_ACTIONS: "demoLookup,demoSaveNote",
  DEV_SESSIONS: JSON.stringify([session()]),
  ...overrides,
});
const rejection = async (run: () => unknown): Promise<Error> => {
  try { await run(); } catch (error) { return error as Error; }
  throw new Error("expected a rejection");
};

describe("T132: production mode rejects development authentication", () => {
  it("NODE_ENV=production with DAP_ALLOW_DEV_AUTH=1 throws at startup (the whole composition, not just a helper)", async () => {
    const production = env({ NODE_ENV: "production" });
    expect(() => assertDevAuthAllowed(production)).toThrow(DevAuthError);
    expect(() => loadConfig(production)).toThrow(/NODE_ENV=production/);
    expect((await rejection(() => composeReferenceHost(production))).message).toMatch(/NODE_ENV=production/);
  });
  it("is refused whatever the opt-in says, and a development NODE_ENV does not matter", () => {
    for (const optIn of ["1", "true", "yes", "0", ""]) expect(() => loadConfig(env({ NODE_ENV: "production", DAP_ALLOW_DEV_AUTH: optIn })), optIn).toThrow(DevAuthError);
    expect(() => loadConfig(env({ NODE_ENV: "development" }))).not.toThrow();
    expect(() => loadConfig(env({ NODE_ENV: undefined }))).not.toThrow();
  });
});

describe("T132: development authentication needs the explicit opt-in", () => {
  it.each([undefined, "", "0", "true", "yes", " 1", "1 ", "01"])("DAP_ALLOW_DEV_AUTH=%j throws at startup", async (optIn) => {
    expect(() => loadConfig(env({ DAP_ALLOW_DEV_AUTH: optIn }))).toThrow(/DAP_ALLOW_DEV_AUTH=1/);
    expect((await rejection(() => composeReferenceHost(env({ DAP_ALLOW_DEV_AUTH: optIn })))).name).toBe("DevAuthError");
  });
});

describe("T132: a malformed trusted session table fails startup and creates no session", () => {
  const malformed: [string, string | undefined][] = [
    ["missing", undefined],
    ["empty", ""],
    ["blank", "   "],
    ["not JSON", "{not json"],
    ["not an array", JSON.stringify({ sessions: [session()] })],
    ["an empty array", "[]"],
    ["an entry that is not an object", JSON.stringify(["alice"])],
    ["a null entry", JSON.stringify([null])],
    ["a missing field", JSON.stringify([{ ...session(), userId: undefined }])],
    ["an unknown field", JSON.stringify([session({ role: "admin" })])],
    ["a smuggled __proto__ field", `[${JSON.stringify(session()).slice(0, -1)},"__proto__":{"isAdmin":true}}]`],
    ["a short token", JSON.stringify([session({ token: "short" })])],
    ["a token with a space", JSON.stringify([session({ token: "a token with spaces 0123456789" })])],
    ["a tenant that is not a UUID", JSON.stringify([session({ tenantId: "tenant-a" })])],
    ["an upper-case tenant UUID", JSON.stringify([session({ tenantId: TENANT.toUpperCase() })])],
    ["the nil tenant", JSON.stringify([session({ tenantId: "00000000-0000-0000-0000-000000000000" })])],
    ["an empty user id", JSON.stringify([session({ userId: "" })])],
    ["a session end without a zone", JSON.stringify([session({ validUntil: "2099-01-01T00:00:00" })])],
    ["no session end", JSON.stringify([{ ...session(), validUntil: undefined }])],
    ["a malformed permission", JSON.stringify([session({ permissions: ["admin"] })])],
    ["a repeated permission", JSON.stringify([session({ permissions: ["perm.demo.lookup", "perm.demo.lookup"] })])],
    ["a repeated token", JSON.stringify([session(), session({ sessionId: "session-other", userId: "bob" })])],
    ["a repeated session id", JSON.stringify([session(), session({ token: `tok-${randomUUID()}`, userId: "bob" })])],
  ];
  it.each(malformed)("%s", async (_name, value) => {
    expect(() => parseDevSessions(value)).toThrow(DevAuthError);
    expect(() => loadConfig(env({ DEV_SESSIONS: value }))).toThrow(DevAuthError);
    expect((await rejection(() => composeReferenceHost(env({ DEV_SESSIONS: value })))).name).toBe("DevAuthError");
  });
  it("one bad entry rejects the whole table: the good entries are not created either", () => {
    expect(() => parseDevSessions(JSON.stringify([session(), session({ token: `tok-${randomUUID()}`, sessionId: "s2", tenantId: "nope" })]))).toThrow(DevAuthError);
  });
  it("an error never carries a token, a database password or any configured value", async () => {
    const errors = [
      ...malformed.map(([, value]) => { try { parseDevSessions(value); } catch (error) { return error as Error; } return new Error("not thrown"); }),
      await rejection(() => composeReferenceHost(env({ DEV_SESSIONS: JSON.stringify([session(), session()]) }))),
      await rejection(() => composeReferenceHost(env({ DAP_DATABASE_URL: `mysql://dap_app:${PASSWORD}@127.0.0.1/x` }))),
    ];
    for (const error of errors) { expect(error.message).not.toContain(TOKEN); expect(error.message).not.toContain(PASSWORD); expect(error.message).not.toContain(TENANT); }
  });
});

describe("T131: the rest of the configuration is validated at startup", () => {
  it.each<[string, Record<string, string | undefined>]>([
    ["no database URL", { DAP_DATABASE_URL: undefined }],
    ["an empty database URL", { DAP_DATABASE_URL: "" }],
    ["a database URL that is not a URL", { DAP_DATABASE_URL: "not a url" }],
    ["a database URL of another scheme", { DAP_DATABASE_URL: `mysql://dap_app:${PASSWORD}@127.0.0.1/db` }],
    ["a database URL without a database", { DAP_DATABASE_URL: "postgresql://dap_app@127.0.0.1" }],
    ["no allowlist", { DAP_ENABLED_ACTIONS: undefined }],
    ["an empty allowlist", { DAP_ENABLED_ACTIONS: " " }],
    ["an unknown capability", { DAP_ENABLED_ACTIONS: "demoLookup,doesNotExist" }],
    ["an empty element", { DAP_ENABLED_ACTIONS: "demoLookup,,demoSaveNote" }],
    ["a repeated capability", { DAP_ENABLED_ACTIONS: "demoLookup,demoLookup" }],
    ["a gateway configuration that is not JSON", { DAP_GATEWAY_CONFIG: "{" }],
    ["an incomplete gateway configuration", { DAP_GATEWAY_CONFIG: JSON.stringify({ maxPayloadBytes: 1 }) }],
  ])("%s throws ConfigError", async (_name, overrides) => {
    expect(() => loadConfig(env(overrides))).toThrow(ConfigError);
    expect((await rejection(() => composeReferenceHost(env(overrides)))).name).toBe("ConfigError");
  });
  it("a valid environment loads, with the allowlist, the default gateway limits and the sessions from the trusted table", () => {
    const config = loadConfig(env());
    expect(config.enabledActions).toEqual(["demoLookup", "demoSaveNote"]);
    expect(config.gateway.limits.proposalsPerTurn).toBeGreaterThan(0);
    expect(config.devSessions.map((s) => [s.userId, s.tenantId, s.sessionId, s.permissions])).toEqual([["alice", TENANT, "session-alice", ["perm.demo.lookup"]]]);
    expect(Object.isFrozen(config)).toBe(true);
    expect(Object.isFrozen(config.devSessions[0])).toBe(true);
  });
});

describe("T132: sessions are looked up in a Map and fail closed", () => {
  const at = (iso: string): Clock => ({ now: () => iso as IsoInstant });
  const sessions = parseDevSessions(JSON.stringify([session(), session({ token: `tok-${randomUUID()}`, sessionId: "session-old", userId: "bob", validUntil: PAST })]));
  const auth = createDevAuthentication(sessions, at(new Date().toISOString()));
  it("a valid token yields exactly the principal of its session, with the identity taken from the table", async () => {
    const now = new Date().toISOString();
    expect(await createDevAuthentication(sessions, at(now)).authenticate(TOKEN)).toEqual({ userId: "alice", tenantId: TENANT, sessionId: "session-alice", authenticatedAt: now, validUntil: FUTURE });
  });
  it.each([["unknown", `tok-${randomUUID()}`], ["__proto__", "__proto__"], ["constructor", "constructor"], ["toString", "toString"], ["hasOwnProperty", "hasOwnProperty"], ["empty", ""], ["a prefix of a real token", TOKEN.slice(0, -1)], ["a real token plus a suffix", `${TOKEN}x`], ["a real token in another case", TOKEN.toUpperCase()]])("%s authenticates nobody", async (_name, token) => {
    expect(await auth.authenticate(token)).toBeNull();
  });
  it.each([["undefined", undefined], ["null", null], ["a number", 1], ["an object naming a user", { userId: "alice", tenantId: TENANT, sessionId: "session-alice" }], ["an object holding a real token", { token: TOKEN }], ["an array holding a real token", [TOKEN]]])("evidence that is %s (not the token text) authenticates nobody", async (_name, evidence) => {
    expect(await auth.authenticate(evidence)).toBeNull();
  });
  it("an expired session authenticates nobody at its end and after it, and works just before it", async () => {
    const [, old] = sessions;
    const ms = Date.parse(PAST);
    expect(await createDevAuthentication(sessions, at(new Date(ms - 1).toISOString())).authenticate(old!.token)).toMatchObject({ userId: "bob", validUntil: PAST });
    expect(await createDevAuthentication(sessions, at(PAST)).authenticate(old!.token)).toBeNull();
    expect(await createDevAuthentication(sessions, at(new Date(ms + 1).toISOString())).authenticate(old!.token)).toBeNull();
    expect(await auth.authenticate(old!.token)).toBeNull();
  });
});

// QA: deployment spelling must not turn production into a development environment.
it.each(["Production", "PRODUCTION", " production", "production\n", " ProDuction "])("refuses production spelling %j", value => {
  expect(() => loadConfig(env({ NODE_ENV: value }))).toThrow(DevAuthError);
});

it("rejects an oversized table and session-id collisions even across tenants",()=>{
 expect(()=>parseDevSessions(JSON.stringify(Array.from({length:101},(_,i)=>session({token:`token-number-${i}`.padEnd(20,"x"),sessionId:`s-${i}`}))))).toThrow(DevAuthError);
 expect(()=>parseDevSessions(JSON.stringify([session(),session({token:`tok-${randomUUID()}`,tenantId:randomUUID()})]))).toThrow(/session id/);
});
