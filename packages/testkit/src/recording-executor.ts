/**
 * @dap/testkit: recording-executor.ts (T028)
 *
 * RecordingExecutor: an executor built with `defineExecutor` (so its `execute` is guarded:
 * minted context + single-use grant, all five binding fields) that records every call that
 * actually reaches the body. Every denial scenario asserts the log stays empty.
 *
 * The class implements the contract `RecordingExecutor` view (calls/grantsSeen as counts,
 * receivedParams as the params array) AND exposes the fuller views the test suite wants:
 * `callLog` (the frozen call snapshots) and `grants` (the grant objects seen by the body).
 * All accessors return COPIES, so a test cannot corrupt the recorded log.
 */
import type {
  ActionExecutor,
  ExecutionCall,
  ExecutionResult,
  ExecutionGrant,
  RecordingExecutor as RecordingExecutorContract,
} from "@dap/contracts";
import { defineExecutor } from "@dap/contracts";
import { snapshotData } from "./snapshot.js";

export interface RecordingExecutorOptions<TValue> {
  /** Stable executor id, distinct from the actionId. */
  readonly id: string;
  /** The result returned for each guarded call; change between calls with setNextResult(). */
  readonly result: ExecutionResult<TValue>;
}

export class RecordingExecutor<TParams = unknown, TValue = unknown>
  implements RecordingExecutorContract
{
  private readonly log: ExecutionCall<TParams>[] = [];
  private nextResult: ExecutionResult<TValue>;
  private failure: string | undefined;
  private observer: ((call: ExecutionCall<TParams>) => Promise<void> | void) | undefined;

  /** The defineExecutor-guarded executor. This is the ONLY way the body can run. */
  readonly executor: ActionExecutor<TParams, TValue>;

  constructor(options: RecordingExecutorOptions<TValue>) {
    this.nextResult = snapshotData(options.result);
    const log = this.log;
    this.executor = defineExecutor<TParams, TValue>({
      id: options.id,
      run: async (call) => {
        // The guard already verified the grant and handed us a FROZEN snapshot.
        const index = log.length;
        log.push(Object.freeze({ ...call, params: Object.freeze({ kind: "unreadable-arguments" }) as ExecutionCall<TParams>["params"], resource: null }));
        let data: Pick<ExecutionCall<TParams>, "params" | "resource">;
        try { data = snapshotData({ params: call.params, resource: call.resource }); }
        catch { throw new TypeError("RecordingExecutor received unreadable arguments"); }
        // Replace our immutable entry only after capture succeeds; entry evidence is never lost.
        log[index] = Object.freeze({ ...call, ...data });
        // What the world looks like at the moment the body runs (for example whether the allow-event is already committed): the callback sees the guarded call.
        if (this.observer !== undefined) await this.observer(log[index]!);
        // A trusted dependency failing inside the body, with a message the scenario chose (it must never reach the planner or the trail).
        if (this.failure !== undefined) throw new Error(this.failure);
        return this.nextResult;
      },
    });
  }

  /** Change the result returned by the next (and following) guarded calls. */
  setNextResult(result: ExecutionResult<TValue>): void {
    this.nextResult = snapshotData(result);
  }

  /** Run `observer` inside the body, after the call is recorded and before the result is returned (`undefined`: stop observing). */
  onRun(observer: ((call: ExecutionCall<TParams>) => Promise<void> | void) | undefined): void {
    this.observer = observer;
  }

  /** Make the body throw an error with this message after it has been recorded (`undefined`: stop throwing). */
  failWith(message: string | undefined): void {
    this.failure = message;
  }

  /** Number of times the executor body actually ran. */
  get calls(): number {
    return this.log.length;
  }

  /** Number of grants handed to the body (one per executed call). */
  get grantsSeen(): number {
    return this.log.length;
  }

  /** The call snapshots the body received, as a copy (elements are frozen by the guard). */
  get callLog(): readonly ExecutionCall<TParams>[] {
    return [...this.log];
  }

  /** The grant objects seen by the body, as a copy. */
  get grants(): readonly ExecutionGrant[] {
    return this.log.map((call) => call.grant);
  }

  /** The parameters exactly as received by the body, as a copy. */
  get receivedParams(): readonly unknown[] {
    return this.log.map((call) => call.params);
  }
}
