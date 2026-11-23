import { execFile } from "node:child_process";
import { BrowserRuntimeError } from "./errors.js";
import type { BrowserRuntimeErrorCode } from "./errors.js";
import { isRecord } from "./snapshot.js";

export type RunCli = (args: readonly string[], timeoutMs: number) => Promise<string>;

export function localCli(executable: string): RunCli {
  // The browser needs the desktop session, but does not need provider credentials or
  // agent-browser settings inherited from the server's environment.
  const env = Object.fromEntries(["PATH", "HOME", "USER", "LOGNAME", "DISPLAY", "WAYLAND_DISPLAY", "XDG_RUNTIME_DIR", "XAUTHORITY", "LANG"]
    .flatMap(key => process.env[key] === undefined ? [] : [[key, process.env[key]]]));
  return (args, timeout) => new Promise((resolve, reject) => {
    execFile(executable, args, { env, timeout, maxBuffer: 512 * 1024, shell: false, killSignal: "SIGKILL" }, (error, stdout) => {
      if (error) reject(new BrowserRuntimeError(error.killed ? "BROWSER_TIMEOUT" : "INVALID_BROWSER_OUTPUT"));
      else resolve(stdout);
    });
  });
}

export async function browserCommand(run: RunCli, args: readonly string[], timeout: number, failure: BrowserRuntimeErrorCode): Promise<Record<string, unknown>> {
  let stdout: string;
  try { stdout = await run(args, timeout); }
  catch (error) {
    if (error instanceof BrowserRuntimeError && error.code === "BROWSER_TIMEOUT") throw error;
    throw new BrowserRuntimeError(failure);
  }
  let reply: unknown;
  try { reply = JSON.parse(stdout); }
  catch { throw new BrowserRuntimeError("INVALID_BROWSER_OUTPUT"); }
  if (!isRecord(reply) || typeof reply.success !== "boolean") throw new BrowserRuntimeError("INVALID_BROWSER_OUTPUT");
  if (!reply.success) throw new BrowserRuntimeError(failure);
  if (!isRecord(reply.data)) throw new BrowserRuntimeError("INVALID_BROWSER_OUTPUT");
  return reply.data;
}
