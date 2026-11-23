/**
 * @dap/contracts — package barrel (T018).
 *
 * Exports every contract module EXCEPT the trusted minting runtime, which lives in the
 * `@dap/contracts/mint` subpath and is importable only by @dap/security and @dap/testkit
 * (ATK-ARCH-05). The execution-runtime's internal registry helpers (registerGrant /
 * grantRecord) are deliberately NOT re-exported here, so no external module can register,
 * clear, or reset a grant.
 */

export * from "./core.js";
export * from "./action-definition.js";
export * from "./security-context.js";
export * from "./execution.js";
export * from "./gateway.js";
export * from "./confirmation.js";
export * from "./audit.js";
export * from "./state-ports.js";
export * from "./testkit.js";
export {
  defineExecutor,
  ExecutionGuardError,
  type ExecutorSpec,
} from "./execution-runtime.js";
export { defineAction } from "./define-action.js";
