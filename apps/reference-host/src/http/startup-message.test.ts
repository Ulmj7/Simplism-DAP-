/** C01 dev server startup failures: a fixed, accurate line per case, never the raw error text. */
import { describe, expect, it } from "vitest";
import { ConfigError } from "../config.js";
import { DevAuthError } from "../dev-auth/index.js";
import { GuidanceConfigError } from "../guidance/anthropic-model.js";
import { STARTUP_MESSAGES, startupFailureMessage } from "./startup-message.js";

const SECRET = "postgres://admin:SECRET@db.internal:5432/dap";
const withCode = (code: string) => Object.assign(new Error(`listen ${code}: address in use ${SECRET}`), { code });

describe("startupFailureMessage", () => {
  it("port in use while listening", () => expect(startupFailureMessage(withCode("EADDRINUSE"), "listen")).toBe(STARTUP_MESSAGES.portInUse));
  it.each(["EACCES", "EADDRNOTAVAIL", "EINVAL"])("%s while listening: cannot bind", (code) => expect(startupFailureMessage(withCode(code), "listen")).toBe(STARTUP_MESSAGES.cannotBind));
  it("a listen failure without a code: cannot bind", () => expect(startupFailureMessage(null, "listen")).toBe(STARTUP_MESSAGES.cannotBind));
  it("a database or store failure while composing", () => expect(startupFailureMessage(new Error(`connect ECONNREFUSED ${SECRET}`), "compose")).toBe(STARTUP_MESSAGES.compose));
  it("the demo session failing to open", () => expect(startupFailureMessage(new Error(SECRET), "session")).toBe(STARTUP_MESSAGES.session));
  it("anything else: generic", () => expect(startupFailureMessage("boom", "config")).toBe(STARTUP_MESSAGES.generic));
  it("configuration errors keep their own fixed messages in every phase", () => {
    expect(startupFailureMessage(new ConfigError("DAP_DATABASE_URL is required"), "compose")).toBe("DAP_DATABASE_URL is required");
    expect(startupFailureMessage(new DevAuthError("DEV_SESSIONS is required"), "compose")).toBe("DEV_SESSIONS is required");
    expect(startupFailureMessage(new GuidanceConfigError("DAP_HTTP_PORT must be a port number from 1 to 65535"), "config")).toBe("DAP_HTTP_PORT must be a port number from 1 to 65535");
  });
  it("never echoes the raw error text", () => {
    for (const phase of ["config", "compose", "session", "listen"] as const) expect(startupFailureMessage(withCode("EADDRINUSE"), phase)).not.toContain("SECRET");
  });
});
