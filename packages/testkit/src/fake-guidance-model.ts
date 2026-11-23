/**
 * A minimal deterministic double for the Feature 003 `GuidanceModel` port (test infrastructure; production code never imports the testkit).
 * It is not a model simulator: the behaviour is whatever the test hands it. It records every request it receives, as a deeply frozen copy.
 */
import type { GuidanceModel, GuidanceModelRequest } from "@dap/ai";

/** Returns the answer for call number `callIndex` (0-based). It may return a value or a promise, throw synchronously, or return a promise that never settles. */
export type FakeGuidanceBehaviour = (request: GuidanceModelRequest, callIndex: number) => unknown;

export interface FakeGuidanceModel extends GuidanceModel {
  /** Each request received, in order, as a frozen copy. */
  readonly requests: readonly GuidanceModelRequest[];
  /** How many times `generate` was called. */
  readonly calls: number;
}

const deepFreeze = <T>(value: T): T => {
  if (value !== null && typeof value === "object") { for (const child of Object.values(value)) deepFreeze(child); Object.freeze(value); }
  return value;
};

export function createFakeGuidanceModel(behaviour: FakeGuidanceBehaviour): FakeGuidanceModel {
  const requests: GuidanceModelRequest[] = [];
  return {
    get requests() { return [...requests]; },
    get calls() { return requests.length; },
    generate(request: GuidanceModelRequest): Promise<unknown> {
      const callIndex = requests.length;
      requests.push(deepFreeze(JSON.parse(JSON.stringify(request)) as GuidanceModelRequest));
      return Promise.resolve(behaviour(request, callIndex)); // a synchronous throw from the behaviour propagates, as a provider's could
    },
  };
}

/** Always answers with `value`. */
export const fakeReturns = (value: unknown): FakeGuidanceBehaviour => () => value;
/** Always rejects with `error` (any value: an Error, a string, an object). */
export const fakeRejects = (error: unknown): FakeGuidanceBehaviour => () => Promise.reject(error);
/** Always throws `error` synchronously, before any promise exists. */
export const fakeThrows = (error: unknown): FakeGuidanceBehaviour => () => { throw error; };
/** Never answers. */
export const fakeHangs = (): FakeGuidanceBehaviour => () => new Promise<never>(() => undefined);
