import { describe, expect, it } from "vitest";
import type {
  ActionId,
  AuthenticatedPrincipal,
  ExecutionCall,
  ExecutionGrant,
  ExecutionResult,
  RequestId,
  TenantId,
  UserId,
} from "@dap/contracts";
import { ExecutionGuardError } from "@dap/contracts";
import { mintAuthorizationContext, mintExecutionGrant } from "@dap/contracts/mint";
import { sha256Canonical } from "@dap/security";
import { RecordingExecutor } from "./recording-executor.js";

// T028: RecordingExecutor — a defineExecutor-guarded executor that records every call that
// actually reaches the body. Denial scenarios assert the log stays empty.

interface Params {
  amount: number;
}

const TENANT = "11111111-1111-4111-8111-111111111111" as TenantId;
const USER = "user-alice" as UserId;
const REQUEST_ID = "req-1" as RequestId;
const ACTION_ID = "act-test" as ActionId;

const SUCCESS: ExecutionResult<string> = { status: "success", value: "did-it" };
const FAILURE: ExecutionResult<string> = { status: "failure", code: "boom" };

function principal(): AuthenticatedPrincipal {
  return {
    userId: USER,
    tenantId: TENANT,
    sessionId: "sess-1",
    authenticatedAt: "2026-01-01T00:00:00.000Z",
    validUntil: "2026-01-01T00:10:00.000Z",
  };
}

function mintedCall(params: Params): ExecutionCall<Params> {
  const security = mintAuthorizationContext(principal());
  const paramsDigest = sha256Canonical(params);
  const grant = mintExecutionGrant({
    requestId: REQUEST_ID,
    actionId: ACTION_ID,
    paramsDigest,
    tenantId: TENANT,
    userId: USER,
  });
  return { grant, security, params, resource: null, requestId: REQUEST_ID, actionId: ACTION_ID, paramsDigest };
}

function freshExecutor(result: ExecutionResult<string> = SUCCESS): RecordingExecutor<Params, string> {
  return new RecordingExecutor<Params, string>({ id: "exec-test", result });
}

describe("RecordingExecutor", () => {
  it("records nothing before first use", () => {
    const rec = freshExecutor();
    expect(rec.calls).toBe(0);
    expect(rec.grantsSeen).toBe(0);
    expect(rec.callLog).toEqual([]);
    expect(rec.grants).toEqual([]);
    expect(rec.receivedParams).toEqual([]);
  });

  it("records exactly one call after one guarded successful execution", async () => {
    const rec = freshExecutor();
    const result = await rec.executor.execute(mintedCall({ amount: 5 }));

    expect(result).toEqual(SUCCESS);
    expect(rec.calls).toBe(1);
    expect(rec.grantsSeen).toBe(1);
    expect(rec.callLog).toHaveLength(1);
    expect(rec.grants).toHaveLength(1);
    expect(rec.receivedParams).toHaveLength(1);
    expect(rec.receivedParams[0]).toEqual({ amount: 5 });
    expect(rec.callLog[0]?.params).toEqual({ amount: 5 });
  });

  it("rejects a call carrying a forged (plain literal) grant and the log stays empty", async () => {
    const rec = freshExecutor();
    const call = mintedCall({ amount: 5 });
    // A plain data literal with the same fields: NOT minted, must be rejected.
    const forged: ExecutionCall<Params> = {
      ...call,
      grant: {
        requestId: REQUEST_ID,
        actionId: ACTION_ID,
        paramsDigest: call.paramsDigest,
      } as unknown as ExecutionGrant,
    };

    await expect(rec.executor.execute(forged)).rejects.toBeInstanceOf(ExecutionGuardError);
    expect(rec.calls).toBe(0);
    expect(rec.grantsSeen).toBe(0);
    expect(rec.receivedParams).toEqual([]);
  });

  it("a failed grant check does not consume the grant: the correct call still works", async () => {
    const rec = freshExecutor();
    const call = mintedCall({ amount: 5 });
    const forged: ExecutionCall<Params> = { ...call, grant: null as unknown as ExecutionGrant };

    await expect(rec.executor.execute(forged)).rejects.toBeInstanceOf(ExecutionGuardError);
    expect(rec.calls).toBe(0);

    await expect(rec.executor.execute(call)).resolves.toEqual(SUCCESS);
    expect(rec.calls).toBe(1);
  });

  it("re-uses of an already-consumed grant are rejected and the log is unchanged", async () => {
    const rec = freshExecutor();
    const call = mintedCall({ amount: 5 });
    await expect(rec.executor.execute(call)).resolves.toEqual(SUCCESS);
    expect(rec.calls).toBe(1);

    await expect(rec.executor.execute(call)).rejects.toBeInstanceOf(ExecutionGuardError);
    expect(rec.calls).toBe(1);
    expect(rec.receivedParams).toHaveLength(1);
  });

  it("the result can be changed between calls", async () => {
    const rec = freshExecutor(SUCCESS);
    await expect(rec.executor.execute(mintedCall({ amount: 1 }))).resolves.toEqual(SUCCESS);

    rec.setNextResult(FAILURE);
    await expect(rec.executor.execute(mintedCall({ amount: 2 }))).resolves.toEqual(FAILURE);

    expect(rec.calls).toBe(2);
    expect(rec.receivedParams).toEqual([{ amount: 1 }, { amount: 2 }]);
  });

  it("accessors return copies that cannot corrupt the log", async () => {
    const rec = freshExecutor();
    const call = mintedCall({ amount: 7 });
    await rec.executor.execute(call);

    const paramsView = rec.receivedParams;
    const logView = rec.callLog;
    const grantsView = rec.grants;
    // The views are plain arrays the caller can mutate freely...
    (paramsView as unknown[]).push("corrupt");
    (logView as ExecutionCall<Params>[]).push({} as unknown as ExecutionCall<Params>);
    (grantsView as unknown[]).push("corrupt");

    // ...and the recorded log is unchanged.
    expect(rec.calls).toBe(1);
    expect(rec.grantsSeen).toBe(1);
    expect(rec.receivedParams).toHaveLength(1);
    expect(rec.callLog).toHaveLength(1);
    expect(rec.grants).toHaveLength(1);
  });
});
